use crate::{binary, engine, Worker};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::{atomic::Ordering, Arc}, time::Duration};
use tauri::{AppHandle, Manager, State};

fn find_tool(resources: &Path, name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
    let bundled = resources.join("youtube-tools").join(file);
    if bundled.is_file() { return Some(bundled); }
    let installed = PathBuf::from(binary(name));
    installed.is_file().then_some(installed)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|_| "YouTube did not return the requested track or metadata. Try refreshing the list.")?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("The YouTube response is too large for this editor.".into());
    }
    serde_json::from_reader(std::io::BufReader::new(file)).map_err(|_| "YouTube returned unreadable caption data.".into())
}

fn valid_language(code: &str) -> bool {
    !code.is_empty() && code.len() <= 64 && code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn tracks(info: &Value) -> Value {
    let mut tracks = Vec::new();
    for (key, automatic) in [("subtitles", false), ("automatic_captions", true)] {
        if let Some(languages) = info[key].as_object() {
            for (code, formats) in languages {
                if !valid_language(code) || code == "live_chat" { continue; }
                if let Some(format) = formats.as_array().and_then(|rows| rows.iter().find(|r| r["ext"] == "json3")) {
                    tracks.push(json!({"code":code, "name":format["name"].as_str().unwrap_or(code), "automatic":automatic}));
                }
            }
        }
    }
    json!({"title":info["title"], "language":info["language"], "tracks":tracks})
}

#[tauri::command]
pub async fn youtube_import(app: AppHandle, worker: State<'_, Worker>, video_id: String,
    action: String, language: Option<String>, automatic: Option<bool>, ffmpeg: Option<String>) -> Result<Value, String> {
    if video_id.len() != 11 || !video_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("Paste a link to a single YouTube video.".into());
    }
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let downloader = find_tool(&resources, "yt-dlp").ok_or("The YouTube helper is missing. Reinstall Subtitler or install yt-dlp.")?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("youtube");
    if worker.busy.swap(true, Ordering::SeqCst) { return Err("Another task is running. Try again when it finishes.".into()); }
    worker.cancel.store(false, Ordering::SeqCst);
    let cancel = worker.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let tmp = tempfile::tempdir_in(&cache).map_err(|e| e.to_string())?;
        let mut args: Vec<String> = ["--ignore-config","--no-plugin-dirs","--no-playlist","--no-progress","--no-warnings",
            "--socket-timeout","18","--retries","1","--extractor-args","youtube:skip=translated_subs","-P"]
            .iter().map(|s| s.to_string()).collect();
        args.push(tmp.path().to_string_lossy().into_owned());
        if let Some(deno) = find_tool(&resources,"deno") {
            args.extend(["--js-runtimes".into(), format!("deno:{}",deno.display())]);
        }
        let code = language.as_deref().unwrap_or("");
        let extra: Vec<&str> = match action.as_str() {
            "inspect" => vec!["--skip-download","--ignore-no-formats-error","--write-info-json","-o","video.%(ext)s"],
            "captions" if valid_language(code) => vec!["--skip-download","--ignore-no-formats-error",
                if automatic == Some(true) { "--write-auto-subs" } else { "--write-subs" },
                "--sub-langs",code,"--sub-format","json3","-o","video.%(ext)s"],
            "audio" => vec!["-f","bestaudio[ext=m4a]/bestaudio","-x","--audio-format","m4a","--ffmpeg-location",
                ffmpeg.as_deref().filter(|p| Path::new(p).is_file()).ok_or("Choose FFmpeg in Settings before downloading audio.")?,"-o","audio.%(ext)s"],
            _ => return Err("Invalid YouTube import choice.".into())
        };
        args.extend(extra.into_iter().map(str::to_owned));
        args.extend(["--".into(),format!("https://www.youtube.com/watch?v={video_id}")]);
        let timeout = if action == "audio" { 1800 } else { 120 };
        engine::run_process_timeout(&downloader, &args, &cancel, Arc::new(|_| {}), false, Some(Duration::from_secs(timeout)))
            .map_err(|e| if e.contains("timed out") { "YouTube took too long to respond. Try again.".to_string() } else { e })?;
        match action.as_str() {
            "inspect" => Ok(tracks(&read_json(&tmp.path().join("video.info.json"))?)),
            "captions" => read_json(&tmp.path().join(format!("video.{code}.json3"))),
            _ => {
                let source = tmp.path().join("audio.m4a");
                if !source.is_file() { return Err("No audio track was downloaded.".into()); }
                // Keep the audio available for playback and the normal project embedding flow.
                let path = tmp.path().join(format!("YouTube-{video_id}.m4a"));
                fs::rename(source,&path).map_err(|e| e.to_string())?;
                let _audio_directory = tmp.keep();
                Ok(json!(path))
            }
        }
    }).await.map_err(|e| e.to_string());
    worker.busy.store(false, Ordering::SeqCst);
    result?
}
