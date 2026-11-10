mod documents;
mod audio_package;
mod library_folder;
mod instance;
mod instance_guard;
mod project_lock;
mod document_windows;
mod engine;
mod project_files;
mod audio_identity;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    fs,
    process::Command,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter, Manager, State};
struct Worker {
    busy: AtomicBool,
    cancel: Arc<AtomicBool>,
}
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}
fn expand(s: &str) -> PathBuf {
    if let Some(s) = s.strip_prefix("~/") {
        home().join(s)
    } else {
        PathBuf::from(s)
    }
}
fn binary(name: &str) -> String {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home().join("Documents/Shared Whisper/engine"),
        home().join("Documents/Shared Whisper:Models/engine"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    dirs.into_iter()
        .map(|d| d.join(&name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}
fn shared_config() -> PathBuf {
    if let Some(p) = std::env::var_os("SHARED_WHISPER_CONFIG") {
        return p.into();
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Shared Whisper/config.json")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home().join("AppData/Local"))
            .join("Shared Whisper/config.json")
    } else {
        home().join(".config/shared-whisper/config.json")
    }
}
fn whisperx_python() -> String {
    let root = home().join("Documents/Shared Whisper/WhisperX");
    let path = if cfg!(windows) { root.join("Scripts/python.exe") } else { root.join("bin/python") };
    if path.is_file() { path.to_string_lossy().into_owned() } else { String::new() }
}
fn discover_tools_sync() -> Value {
    let saved = fs::read_to_string(shared_config())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let get = |key: &str, name: &str| {
        let val = saved[key].as_str().unwrap_or("");
        if expand(val).is_file() {
            expand(val).to_string_lossy().into_owned()
        } else {
            binary(name)
        }
    };
    let roots = vec![
        saved["models"].as_str().map(expand).unwrap_or_default(),
        home().join("Documents/Shared Whisper/Models"),
        home().join("Documents/Shared Whisper:Models"),
        home().join("Documents/Shared Whisper"),
    ];
    let mut models = Vec::new();
    for key in ["turbo", "large"] {
        if let Some(path) = saved[key].as_str() {
            if expand(path).is_file() {
                models.push(json!({"name":Path::new(path).file_name().unwrap_or_default().to_string_lossy(),"path":expand(path).to_string_lossy()}));
            }
        }
    }
    for root in roots {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension().and_then(|s| s.to_str()) == Some("bin")
                    && !p
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .contains("encoder")
                {
                    let path = p.to_string_lossy().into_owned();
                    if !models.iter().any(|m| m["path"] == path) {
                        models.push(json!({"name":p.file_name().unwrap_or_default().to_string_lossy(),"path":path}));
                    }
                }
            }
        }
    }
    json!({"whisper":get("whisper","whisper-cli"),"ffmpeg":get("ffmpeg","ffmpeg"),"models":models,"whisperxPython":whisperx_python()})
}
#[tauri::command]
async fn discover_tools() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(discover_tools_sync).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn audio_status(path: String, preview_path: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        json!({"originalExists":expand(&path).is_file(),"previewExists":preview_path.map(|p|expand(&p).is_file()).unwrap_or(false)})
    }).await.map_err(|e|e.to_string())
}
#[tauri::command]
fn pick_file(kind: String) -> Option<String> {
    let dialog = rfd::FileDialog::new();
    let dialog = match kind.as_str() {
        "audio" => dialog.set_title("Import original audio").add_filter(
            "Audio",
            &[
                "wav", "mp3", "m4a", "aac", "flac", "ogg", "aiff", "aif", "opus", "wma",
            ],
        ),
        "import" => dialog.set_title("Import audio or project").add_filter("Audio, project or transcript", &["wav","mp3","m4a","aac","flac","ogg","aiff","aif","opus","wma","srt","json","subtitler","whisperdesk","txt","docx"]),
        "script" => dialog.set_title("Import reference text").add_filter("Reference text", &["txt","docx","json"]),
        "project" => dialog.set_title("Open Subtitler project").add_filter("Subtitler project", &["subtitler","whisperdesk"]),
        "subtitles" => dialog.set_title("Import subtitles").add_filter("Subtitles", &["srt","json"]),
        "model" => dialog
            .set_title("Choose shared Whisper model")
            .add_filter("Whisper model", &["bin"]),
        "transcript" => dialog
            .set_title("Open transcript or project")
            .add_filter("Transcript", &["json", "srt", "subtitler", "whisperdesk", "txt"]),
        _ => dialog.set_title("Choose executable"),
    };
    dialog.pick_file().map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
fn audio_file_info(path:String)->Result<Value,String>{let p=require_file(&path,"Audio")?;if !audio_identity::supported(&p){return Err("Choose audio".into())}audio_identity::info(&p)}
#[tauri::command]
fn read_transcript(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !["json", "srt", "subtitler", "whisperdesk", "txt"]
        .contains(&p.extension().and_then(|s| s.to_str()).unwrap_or(""))
    {
        return Err("Choose a transcript or Subtitler project".into());
    }
    if ["subtitler","whisperdesk"].contains(&p.extension().and_then(|s|s.to_str()).unwrap_or("")){return serde_json::to_string(&audio_package::read(p)?.project).map_err(|e|e.to_string());}
    if fs::metadata(p).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 {
        return Err("Transcript exceeds 50 MB".into());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}
fn require_file(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = expand(path).canonicalize().map_err(|_| {
        format!("{label} is missing. Choose its location in Settings or relink the audio.")
    })?;
    if !path.is_file() {
        return Err(format!("{label} must be a file"));
    }
    Ok(path)
}
fn source_info(path: &Path, preview: &Path) -> Result<Value, String> {
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(
        json!({"path":path.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":m.len(),"modified":m.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_millis() as u64),"previewPath":preview.to_string_lossy(),"fingerprint":audio_identity::info(path)?["fingerprint"],"duration":engine::wav_duration(preview)?}),
    )
}
#[tauri::command]
async fn prepare_audio(
    app: AppHandle,
    worker: State<'_, Worker>,
    path: String,
    ffmpeg: String,
    project_id: String,
) -> Result<Value, String> {
    if worker.busy.swap(true, Ordering::SeqCst) {
        return Err("An audio task is already running".into());
    }
    worker.cancel.store(false, Ordering::SeqCst);
    let cancel = worker.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let source = require_file(&path, "Original audio")?;
        let binary = require_file(&ffmpeg, "FFmpeg")?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("audio");
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let target = engine::job_path(&cache, &project_id)?.with_extension("wav");
        engine::run_process(
            &binary,
            &engine::audio_args(&source, &target),
            &cancel,
            Arc::new(|_| {}),
            false,
        )?;
        source_info(&source, &target)
    })
    .await
    .map_err(|e| e.to_string());
    worker.busy.store(false, Ordering::SeqCst);
    result?
}
#[tauri::command]
async fn transcribe(
 app: AppHandle, worker: State<'_,Worker>, path:String,ffmpeg:String,whisper:String,model:String,
 language:String,job_id:String,threads:u32,prompt:Option<String>,pause_seconds:Option<f64>,
)->Result<Value,String>{
 if worker.busy.swap(true,Ordering::SeqCst){return Err("A transcription is already running".into())}
 worker.cancel.store(false,Ordering::SeqCst);let cancel=worker.cancel.clone();
 let result=tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
  let source=require_file(&path,"Original audio")?;let ffmpeg=require_file(&ffmpeg,"FFmpeg")?;let whisper=require_file(&whisper,"whisper-cli")?;let model=require_file(&model,"Whisper model")?;
  let cache=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("jobs");fs::create_dir_all(&cache).map_err(|e|e.to_string())?;let root=engine::job_path(&cache,&job_id)?;fs::create_dir(&root).map_err(|e|e.to_string())?;
  struct Cleanup(PathBuf);impl Drop for Cleanup{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}let _cleanup=Cleanup(root.clone());
  let wav=root.join("audio.wav");let prefix=root.join("transcript");let handle=app.clone();let event_id=job_id.clone();let emit:engine::Progress=Arc::new(move|message|{let _=handle.emit("whisper-progress",json!({"jobId":event_id,"message":message}));});
  emit("Preparing audio; silence and timing preserved…".into());engine::run_process(&ffmpeg,&engine::audio_args(&source,&wav),&cancel,emit.clone(),false)?;
  let mut args=engine::whisper_args(&model,&wav,&prefix,&language,threads)?;
  if let Some(prompt)=prompt.filter(|p|!p.trim().is_empty()){args.extend(["--prompt".into(),prompt.chars().take(2000).collect()]);}
  engine::run_process(&whisper,&args,&cancel,emit.clone(),cfg!(target_os="macos"))?;
  if cancel.load(Ordering::SeqCst){return Err("Cancelled".into())}
  let output=prefix.with_extension("json");if fs::metadata(&output).map_err(|_|"Whisper did not produce detailed JSON. Check whisper-cli.")?.len()>50*1024*1024{return Err("The result exceeds 50 MB".into())}
  let raw:Value=serde_json::from_slice(&fs::read(output).map_err(|e|e.to_string())?).map_err(|e|format!("Whisper returned invalid JSON: {e}"))?;
  let mut info=source_info(&source,&wav)?;info["previewPath"]=Value::Null;
  emit("Preparing audio; detecting pauses…".into());let pauses=detect_silence(&ffmpeg,&wav,info["duration"].as_f64().unwrap_or(0.),pause_seconds.unwrap_or(0.6),&cancel)?;
  Ok(json!({"transcript":raw,"source":info,"pauses":pauses}))
 }).await.map_err(|e|e.to_string());worker.busy.store(false,Ordering::SeqCst);result?
}
fn detect_silence(ffmpeg:&Path,audio:&Path,duration:f64,threshold:f64,cancel:&AtomicBool)->Result<Vec<Value>,String>{
 if !threshold.is_finite()||!(0.1..=10.0).contains(&threshold){return Err("Pause threshold must be 0.1–10 seconds".into())}
 let intervals=Arc::new(std::sync::Mutex::new((None::<f64>,Vec::<Value>::new())));let out=intervals.clone();let progress:engine::Progress=Arc::new(move|line|{if let Ok(mut data)=out.lock(){if let Some(t)=line.split("silence_start:").nth(1).and_then(|s|s.split_whitespace().next()).and_then(|s|s.parse::<f64>().ok()){data.0=Some(t.max(0.));}if let Some(t)=line.split("silence_end:").nth(1).and_then(|s|s.split_whitespace().next()).and_then(|s|s.parse::<f64>().ok()){if let Some(start)=data.0.take(){if t>start{data.1.push(json!({"start":start,"end":t.min(duration),"method":"audio-level","noiseDb":-35}));}}}}});
 let args=vec!["-nostdin".into(),"-hide_banner".into(),"-i".into(),audio.to_string_lossy().into_owned(),"-af".into(),format!("silencedetect=noise=-35dB:d={threshold}"),"-f".into(),"null".into(),"-".into()];engine::run_process(ffmpeg,&args,cancel,progress,false)?;
 let mut locked=intervals.lock().map_err(|_|"Pause detection failed")?;if let Some(start)=locked.0.take(){if duration-start>=threshold{locked.1.push(json!({"start":start,"end":duration,"method":"audio-level","noiseDb":-35}));}}Ok(locked.1.clone())
}
// Uses the same cancellable, exclusive worker as transcription. Python runs the aligner and optional speaker labeling; Whisper recognition stays local in whisper-cli.
#[tauri::command]
async fn align_words(
    app: AppHandle, worker: State<'_, Worker>, python: String,
    ffmpeg: String, path: String, mut request: Value, job_id: String, probe: bool, hf_token: Option<String>,
) -> Result<Value, String> {
    if worker.busy.swap(true, Ordering::SeqCst) {
        return Err("An audio task is already running".into());
    }
    worker.cancel.store(false, Ordering::SeqCst);
    let cancel = worker.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        // Preserve the venv symlink spelling: canonicalizing bin/python would
        // launch its base interpreter and lose the installed environment.
        let python = expand(&python);
        if !python.is_absolute() || !python.is_file() {
            return Err("Choose the WhisperX environment's Python in Settings. Run the supplied setup command first.".into());
        }
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("alignment");
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let root = engine::job_path(&cache, &job_id)?;
        fs::create_dir(&root).map_err(|e| e.to_string())?;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(root.clone());
        let script = root.join("align_words.py");
        fs::write(&script, include_str!("../../python/align_words.py")).map_err(|e| e.to_string())?;
        fs::write(root.join("spoken_numbers.py"), include_str!("../../python/spoken_numbers.py")).map_err(|e| e.to_string())?;
        let output = root.join("result.json");
        let handle = app.clone();
        let event_id = job_id.clone();
        let emit: engine::Progress = Arc::new(move |message| {
            let _ = handle.emit("alignment-progress", json!({"jobId":event_id,"message":message}));
        });
        let mut args = vec!["-u".into(), script.to_string_lossy().into_owned(), "--output".into(), output.to_string_lossy().into_owned()];
        if probe { args.push("--probe".into()); }
        else {
            let source = require_file(&path, "Original audio")?;
            let ffmpeg = require_file(&ffmpeg, "FFmpeg")?;
            if !["auto", "en", "pt", "es", "ja"].contains(&request["language"].as_str().unwrap_or("")) {
                return Err("Choose automatic or a supported alignment language".into());
            }
            let before=audio_identity::info(&source)?;
            if let Some(expected)=request["audioFingerprint"].as_str(){if before["fingerprint"].as_str()!=Some(expected){return Err("The audio content changed. Attach the intended recording before matching.".into())}}
            let data = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
            if data.len() > 50 * 1024 * 1024 { return Err("Align shorter chapters (request exceeds 50 MB)".into()); }
            let input = root.join("request.json");
            fs::write(&input, data).map_err(|e| e.to_string())?;
            let wav = root.join("audio.wav");
            emit("SUBTITLER Preparing audio…".into());
            engine::run_process(&ffmpeg, &engine::audio_args(&source, &wav), &cancel, emit.clone(), false)?;
            let duration=engine::wav_duration(&wav)?;
            request["duration"]=json!(duration);
            fs::write(&input,serde_json::to_vec(&request).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            args.extend(["--request".into(), input.to_string_lossy().into_owned(), "--audio".into(), wav.to_string_lossy().into_owned()]);
        }
        engine::run_process_env_timeout(&python, &args, &cancel, emit, false,
            if probe { Some(std::time::Duration::from_secs(45)) } else { None },hf_token.as_deref().filter(|t|!t.is_empty()).map(|t|("WHISPERX_HF_TOKEN",t)))?;
        if cancel.load(Ordering::SeqCst) { return Err("Cancelled".into()); }
        if fs::metadata(&output).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 {
            return Err("Alignment result exceeds 50 MB".into());
        }
        serde_json::from_slice(&fs::read(output).map_err(|e| e.to_string())?).map_err(|e| format!("Invalid alignment result: {e}"))
    }).await.map_err(|e| e.to_string());
    worker.busy.store(false, Ordering::SeqCst);
    result?
}
#[tauri::command]
fn cancel_transcription(worker: State<'_, Worker>) {
    worker.cancel.store(true, Ordering::SeqCst);
}
#[tauri::command]
fn save_export(filename: String, data: String) -> Result<bool, String> {
    let name = Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid filename")?;
    let allowed = ["docx", "txt", "srt", "csv", "xlsx", "json", "subtitler", "whisperdesk"];
    if !allowed.contains(
        &Path::new(name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    ) {
        return Err("Unsupported export type".into());
    }
    let chosen = rfd::FileDialog::new()
        .set_title("Export transcript")
        .set_file_name(name)
        .save_file();
    if let Some(path) = chosen {
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        if bytes.len() > 100 * 1024 * 1024 {
            return Err("Export exceeds 100 MB".into());
        }
        fs::write(path, bytes).map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}
#[tauri::command]
fn choose_project_folder()->Option<String>{rfd::FileDialog::new().set_title("Choose the main project folder").pick_folder().map(|p|p.to_string_lossy().into_owned())}
#[tauri::command]
async fn inspect_project_folder(directory:String,expected_project_id:Option<String>,audio_relative_path:Option<String>)->Result<Value,String>{tauri::async_runtime::spawn_blocking(move||project_files::inspect(&directory,expected_project_id.as_deref(),audio_relative_path.as_deref())).await.map_err(|e|e.to_string())?}
#[tauri::command]
async fn save_project_files(directory:String,studio_project_id:Option<String>,project_id:String,filename:String,project_data:String,timing_data:String)->Result<Value,String>{tauri::async_runtime::spawn_blocking(move||{let _guard=library_folder::IO.lock().map_err(|e|e.to_string())?;let mut data:Value=serde_json::from_str(&project_data).map_err(|e|e.to_string())?;if let Some(path)=data["filePath"].as_str(){data["filePath"]=json!(library_folder::resolved(Path::new(path)));}project_files::save(&directory,studio_project_id.as_deref(),&project_id,&filename,&data.to_string(),&timing_data)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
async fn write_subtitler_export(directory:String,studio_project_id:Option<String>,project_id:String,filename:String,data:String)->Result<String,String>{tauri::async_runtime::spawn_blocking(move||{let bytes=STANDARD.decode(data).map_err(|e|e.to_string())?;project_files::write_export(&directory,studio_project_id.as_deref(),&project_id,&filename,&bytes)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
fn read_script_document(path:String)->Result<String,String>{let p=require_file(&path,"Script")?;if p.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase()!="docx"{return Err("Choose a DOCX script".into())}if fs::metadata(&p).map_err(|e|e.to_string())?.len()>16*1024*1024{return Err("Choose a DOCX smaller than 16 MB".into())}Ok(STANDARD.encode(fs::read(p).map_err(|e|e.to_string())?))}
#[tauri::command]
async fn read_studio_request(last_request_id:Option<String>)->Result<Option<Value>,String>{tauri::async_runtime::spawn_blocking(move||{
 let path=shared_config().with_file_name("studio-request.json");if !path.is_file(){return Ok(None)}if fs::metadata(&path).map_err(|e|e.to_string())?.len()>16384{return Err("Studio request is too large".into())}
 let mut v:Value=serde_json::from_slice(&fs::read(&path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 if v["format"]!="studio-subtitler-request-v1"||v["action"]!="match-timing"||v["requestId"].as_str().filter(|x|!x.is_empty()&&x.len()<200).is_none(){return Err("Invalid Storyboard Studio request".into())}
 if v["requestId"].as_str()==last_request_id.as_deref(){return Ok(None)}
 let directory=v["directory"].as_str().ok_or("Missing project folder")?;let id=v["projectId"].as_str().ok_or("Missing project ID")?;
 let mut info=project_files::inspect(directory,Some(id),None)?;
 if let Some(selected)=v["activeRecording"]["path"].as_str(){if let Ok(actual)=audio_identity::info(Path::new(selected)){info["activeRecording"]=actual.clone();if let Some(a)=info["audioCandidates"].as_array_mut(){if !a.iter().any(|a|a["path"]==actual["path"]){a.push(actual);}}}}
 let audio=info["audioCandidates"].as_array().map(|a|a.iter().filter_map(|v|v["path"].as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();v["workspace"]=info;v["audioFiles"]=serde_json::to_value(audio).map_err(|e|e.to_string())?;Ok(Some(v))
 }).await.map_err(|e|e.to_string())?}

#[tauri::command]
fn reveal_transcript_file(path:String)->Result<(),String>{let path=Path::new(&path).canonicalize().map_err(|e|e.to_string())?;
 #[cfg(target_os="macos")]let result=Command::new("open").arg("-R").arg(&path).spawn();
 #[cfg(windows)]let result=Command::new("explorer").arg(format!("/select,{}",path.display())).spawn();
 #[cfg(not(any(target_os="macos",windows)))]let result=Command::new("xdg-open").arg(path.parent().unwrap()).spawn();result.map(|_|()).map_err(|e|e.to_string())}

#[tauri::command]
async fn open_document(app:AppHandle,path:String)->Result<Value,String>{tauri::async_runtime::spawn_blocking(move||{
 let _guard=library_folder::IO.lock().map_err(|e|e.to_string())?;let path=library_folder::resolved(Path::new(&path));let mut opened=documents::read(&path)?;let cache=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("embedded-audio");match audio_package::cached_audio(&path,&cache){Ok(p)=>opened["audioPath"]=json!(p),Err(e)=>opened["audioWarning"]=json!(e)}Ok(opened)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
fn default_transcript_directory(app:tauri::AppHandle)->String{app.path().desktop_dir().unwrap_or_else(|_|home().join("Desktop")).join("Subtitler").to_string_lossy().into_owned()}
#[tauri::command]
fn choose_transcript_directory()->Option<String>{rfd::FileDialog::new().set_title("Choose the new parent location for the Subtitler folder").pick_folder().map(|p|p.to_string_lossy().into_owned())}
#[tauri::command]
fn allocate_document(directory:String,name:String)->Result<String,String>{let _guard=library_folder::IO.lock().map_err(|e|e.to_string())?;let root=library_folder::resolved(Path::new(&directory));let p=documents::allocate(&root,&name)?;if root==home().join("Desktop/Subtitler"){set_folder_icon(&root);}Ok(p.to_string_lossy().into_owned())}
fn set_folder_icon(root:&Path){
 #[cfg(target_os="macos")]{let icon=include_bytes!("../icons/folder.png");let image=root.join(".subtitler-folder-icon.png");if !image.exists()&&fs::write(&image,icon).is_ok(){let _=Command::new("osascript").arg("-l").arg("JavaScript").arg("-e").arg("ObjC.import('AppKit');function run(a){var i=$.NSImage.alloc.initWithContentsOfFile(a[0]);$.NSWorkspace.sharedWorkspace.setIconForFileOptions(i,a[1],0);}").arg(&image).arg(root).output();}}
 #[cfg(not(target_os="macos"))]let _=root;
}
#[tauri::command]
async fn write_document(app:AppHandle,path:String,data:String)->Result<Value,String>{tauri::async_runtime::spawn_blocking(move||{
 let _guard=library_folder::IO.lock().map_err(|e|e.to_string())?;let target=library_folder::resolved(Path::new(&path));let mut value:Value=serde_json::from_str(&data).map_err(|e|e.to_string())?;value["filePath"]=json!(target);if value["studioLink"].is_object(){value["studioLink"]["projectFile"]=json!(target);}for key in ["path","previewPath"]{if let Some(p)=value["source"][key].as_str(){value["source"][key]=json!(library_folder::resolved(Path::new(p)));}}
 let changed=documents::write(&target,&value.to_string())?;let mut result=json!({"changed":changed});if !value["source"]["embeddedPath"].as_str().map(|p|Path::new(p).is_file()).unwrap_or(false){let cache=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("embedded-audio");match audio_package::cached_audio(&target,&cache){Ok(p)=>result["audioPath"]=json!(p),Err(e)=>result["audioWarning"]=json!(e)}}Ok(result)}).await.map_err(|e|e.to_string())?}
#[tauri::command]
fn choose_document_save(name:String)->Option<String>{rfd::FileDialog::new().set_title("Save Subtitler project as").set_file_name(format!("{}.subtitler",name.trim_end_matches(".subtitler"))).add_filter("Subtitler project",&["subtitler"]).save_file().map(|p|p.with_extension("subtitler").to_string_lossy().into_owned())}

#[tauri::command]
async fn move_transcript_folder(app:AppHandle,directory:String,parent:String,create_if_missing:bool)->Result<Value,String>{
 let handle=app.clone();let result=tauri::async_runtime::spawn_blocking(move||{let _guard=library_folder::IO.lock().map_err(|e|e.to_string())?;let old=library_folder::resolved(Path::new(&directory));if create_if_missing&&!old.exists()&&old.file_name().and_then(|s|s.to_str())==Some("Subtitler"){fs::create_dir_all(&old).map_err(|e|e.to_string())?;}
 let result=library_folder::move_folder(&old,Path::new(&parent))?;if let Some(dir)=result["directory"].as_str(){set_folder_icon(Path::new(dir));}let docs=handle.state::<document_windows::Documents>();let mut map=docs.0.lock().map_err(|e|e.to_string())?;for path in map.values_mut(){*path=library_folder::resolved(Path::new(path)).to_string_lossy().into_owned();}Ok::<Value,String>(result)}).await.map_err(|e|e.to_string())??;app.emit("subtitler-folder-moved",&result).map_err(|e|e.to_string())?;Ok(result)
}

struct LaunchState{primary:bool,received:AtomicBool}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _instance=match instance::start(){Ok(g)=>g,Err(e)=>{rfd::MessageDialog::new().set_title("Subtitler could not start").set_description(e).set_level(rfd::MessageLevel::Error).show();return;}};
    let primary=_instance.is_some();
    tauri::Builder::default()
        .manage(LaunchState{primary,received:AtomicBool::new(false)})
        .manage(document_windows::EmptyWindows::default())
        .manage(document_windows::Documents::default())
        .manage(document_windows::Recordings::default())
        .manage(document_windows::Requests::default())
        .manage(document_windows::InitialDocuments::default())
        .setup(|app|{
            use tauri::menu::{Menu,MenuItemKind,Submenu,MenuItemBuilder,PredefinedMenuItem};
            let menu=Menu::default(app.handle())?;
            for item in menu.items()?{if let MenuItemKind::Submenu(sub)=item{if sub.text()?=="File"{menu.remove(&sub)?;}}}
            let file=Submenu::new(app,"File",true)?;
            for(id,text)in [("new-project","New"),("open-project","Open…"),("recent-projects","Open Recent…")]{file.append(&MenuItemBuilder::with_id(id,text).build(app)?)?;}
            file.append(&PredefinedMenuItem::separator(app)?)?;
            let imports=Submenu::new(app,"Import",true)?;
            for(id,text)in [("import-audio","Audio…"),("import-reference","Reference text…"),("import-subtitles","Subtitles…")]{imports.append(&MenuItemBuilder::with_id(id,text).build(app)?)?;}
            file.append(&imports)?;file.append(&MenuItemBuilder::with_id("project-folder","Open Storyboard project…").build(app)?)?;
            file.append(&PredefinedMenuItem::separator(app)?)?;
            for(id,text)in [("save-project","Save"),("save-as","Save As…"),("reveal-transcript","Show saved project")]{file.append(&MenuItemBuilder::with_id(id,text).build(app)?)?;}
            file.append(&MenuItemBuilder::with_id("move-transcript-folder","Move Subtitler folder…").build(app)?)?;
            file.append(&PredefinedMenuItem::separator(app)?)?;
            for(id,text)in [("export","Export…"),("close-project","Close")]{file.append(&MenuItemBuilder::with_id(id,text).build(app)?)?;}
            menu.insert(&file,if cfg!(target_os="macos"){1}else{0})?;
            if cfg!(target_os="macos") {if let Some(MenuItemKind::Submenu(sub))=menu.items()?.into_iter().next(){sub.set_text("Subtitler")?;sub.insert(&MenuItemBuilder::with_id("settings","Settings…").build(app)?,1)?;sub.insert(&PredefinedMenuItem::separator(app)?,2)?;}}
            else{file.append(&PredefinedMenuItem::separator(app)?)?;file.append(&MenuItemBuilder::with_id("settings","Settings…").build(app)?)?;}
            app.set_menu(menu)?;
            let primary=app.state::<LaunchState>().primary;
            let paths=std::env::args().skip(1).filter(|p|p.to_lowercase().ends_with(".subtitler")).collect::<Vec<_>>();
            if primary{instance::listen(app.handle().clone());for path in paths{app.state::<LaunchState>().received.store(true,Ordering::SeqCst);document_windows::open_or_report(app.handle(),Some(path),None);}}
            else if !paths.is_empty(){if let Err(e)=instance::forward(paths){rfd::MessageDialog::new().set_title("Could not open project").set_description(e).show();}app.state::<LaunchState>().received.store(true,Ordering::SeqCst);}
            Ok(())
        })
        .on_menu_event(|app,event|document_windows::menu(app,event.id().as_ref()))
        .manage(Worker {
            busy: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.emit_to(window.label(),"subtitler-close",());}
            if let tauri::WindowEvent::Destroyed=event{
                if let Ok(mut docs)=window.state::<document_windows::Documents>().0.lock(){docs.remove(window.label());}
                if let Ok(mut state)=window.state::<document_windows::EmptyWindows>().0.lock(){state.remove(window.label());}
                if let Ok(mut state)=window.state::<document_windows::Recordings>().0.lock(){state.retain(|_,label|label!=window.label());}
                if let Ok(mut state)=window.state::<document_windows::InitialDocuments>().0.lock(){state.remove(window.label());}
                if document_windows::QUITTING.load(Ordering::SeqCst)&&window.app_handle().webview_windows().keys().all(|k|k==window.label()){window.app_handle().exit(0);}
            }
        })
        .invoke_handler(tauri::generate_handler![
            document_windows::cancel_document_close,document_windows::set_document_empty,document_windows::claim_recording,document_windows::claim_studio_request,document_windows::new_document_window,document_windows::claim_document,document_windows::document_title,document_windows::finish_document_close,
            move_transcript_folder,document_windows::take_document_open,open_document,allocate_document,write_document,choose_document_save,choose_transcript_directory,default_transcript_directory,
            audio_file_info,reveal_transcript_file,read_studio_request,choose_project_folder,inspect_project_folder,save_project_files,write_subtitler_export,read_script_document,
            discover_tools,
            audio_status,
            pick_file,
            read_transcript,
            prepare_audio,
            transcribe,
            align_words,
            cancel_transcription,
            save_export
        ])
        .build(tauri::generate_context!())
        .expect("Could not open Subtitler")
        .run(|app,event|{
            if let tauri::RunEvent::ExitRequested{ref api,..}=event{let windows=app.webview_windows();if !windows.is_empty(){api.prevent_exit();document_windows::QUITTING.store(true,Ordering::SeqCst);for w in windows.values(){let _=w.emit_to(w.label(),"subtitler-close",());}}}
            if matches!(event,tauri::RunEvent::Ready){let handle=app.clone();std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_millis(700));let h=handle.clone();let _=handle.run_on_main_thread(move||{let state=h.state::<LaunchState>();if state.primary{if !state.received.load(Ordering::SeqCst)&&h.webview_windows().is_empty(){document_windows::activate(&h);}}else{if !state.received.load(Ordering::SeqCst){if let Err(e)=instance::forward(Vec::new()){rfd::MessageDialog::new().set_title("Could not activate Subtitler").set_description(e).show();}}h.exit(0);}});});}
            #[cfg(target_os="macos")]
            if let tauri::RunEvent::Reopen{has_visible_windows,..}=event{if app.state::<LaunchState>().primary&&!has_visible_windows{document_windows::activate(app);}}
            #[cfg(target_os="macos")]
            if let tauri::RunEvent::Opened{urls}=event{let paths=urls.into_iter().filter_map(|url|url.to_file_path().ok()).map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>();app.state::<LaunchState>().received.store(true,Ordering::SeqCst);if app.state::<LaunchState>().primary{for path in paths{document_windows::open_or_report(app,Some(path),None);}}else{if let Err(e)=instance::forward(paths){rfd::MessageDialog::new().set_title("Could not open project").set_description(e).show();}app.exit(0);}}
            #[cfg(not(target_os="macos"))]let _=(app,event);
        });
}
