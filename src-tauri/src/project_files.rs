//! Subtitler owns only its project/timing files. Storyboard Studio owns project.json.
use std::{fs,io::Write,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
use serde_json::{Value,json};
fn read(path:&Path)->Result<Value,String>{if ["subtitler","whisperdesk"].contains(&path.extension().and_then(|s|s.to_str()).unwrap_or("")){return Ok(crate::audio_package::read(path)?.project);}if fs::metadata(path).map_err(|e|e.to_string())?.len()>50*1024*1024{return Err("Project file exceeds 50 MB".into())}serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|format!("Unreadable {}: {e}",path.file_name().unwrap_or_default().to_string_lossy()))}
fn root(directory:&str)->Result<PathBuf,String>{let p=Path::new(directory).canonicalize().map_err(|_|"Project folder is missing. Relink it in Settings.".to_string())?;let p=if p.file_name().and_then(|s|s.to_str())==Some("Studio Link"){p.parent().ok_or("Invalid project folder")?.to_path_buf()}else{p};if !p.is_dir(){return Err("Choose the main project folder".into())}Ok(p)}
fn link(root:&Path,create:bool)->Result<PathBuf,String>{let p=root.join("Studio Link");if create{fs::create_dir_all(&p).map_err(|e|e.to_string())?;}if p.exists(){let real=p.canonicalize().map_err(|e|e.to_string())?;if !real.starts_with(root)||!real.is_dir(){return Err("Studio Link points outside the project".into())}return Ok(real)}Ok(p)}
fn relative(root:&Path,value:&str)->Result<PathBuf,String>{if value.is_empty()||value.contains('\\')||value.contains(':')||value.starts_with('/')||value.split('/').any(|s|s.is_empty()||s==".."||s=="."){return Err("Invalid project-relative path".into())}let p=root.join(value);if p.exists()&&!p.canonicalize().map_err(|e|e.to_string())?.starts_with(root){return Err("A project file points outside its folder".into())}Ok(p)}
fn identity(root:&Path,expected:Option<&str>)->Result<Option<Value>,String>{let path=link(root,false)?.join("project.json");if !path.exists(){if expected.is_some(){return Err("Studio Link/project.json is missing. Reconnect the matching project folder.".into())}return Ok(None)}let m=read(&path)?;if m["format"]!="studio-link-project-v1"||m["schemaVersion"]!=1||m["project"]["id"].as_str().filter(|s|!s.is_empty()).is_none(){return Err("This is not a valid Storyboard Studio project folder".into())}if let Some(id)=expected{if m["project"]["id"].as_str()!=Some(id){return Err("This folder belongs to another Storyboard Studio project".into())}}Ok(Some(m))}
fn leaf(value:&str)->String{let mut out=String::new();for c in value.chars(){if out.len()>115{break}out.push(if c.is_control()||"\\/:*?\"<>|".contains(c){'_'}else{c});}let out=out.trim().trim_end_matches(['.',' ']);if out.is_empty()||out=="."||out==".."{"Transcript.subtitler".into()}else{out.into()}}
fn id(value:&str)->Result<(),String>{if value.is_empty()||value.len()>80||!value.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return Err("Invalid Subtitler project identity".into())}Ok(())}
pub(crate) fn atomic(path:&Path,data:&[u8])->Result<(),String>{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();let tmp=path.with_extension(format!("subtitler-tmp-{stamp}"));let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e|e.to_string())?;let result=(||{f.write_all(data).map_err(|e|e.to_string())?;f.sync_all().map_err(|e|e.to_string())?;drop(f);if cfg!(windows)&&path.exists(){let backup=path.with_extension(format!("subtitler-backup-{stamp}"));fs::rename(path,&backup).map_err(|e|e.to_string())?;if let Err(e)=fs::rename(&tmp,path){let _=fs::rename(&backup,path);return Err(e.to_string())}let _=fs::remove_file(backup);}else{fs::rename(&tmp,path).map_err(|e|e.to_string())?}Ok(())})();if result.is_err(){let _=fs::remove_file(tmp);}result}
fn discovery(root:&Path)->Result<(Vec<Value>,Vec<Value>),String>{
 let mut audio=Vec::new();let mut transcripts=Vec::new();
 for entry in fs::read_dir(root).map_err(|e|e.to_string())?.chain(if root.join("Studio Link").is_dir(){Some(fs::read_dir(root.join("Studio Link")).map_err(|e|e.to_string())?)}else{None}.into_iter().flatten()).take(2048){
  let entry=entry.map_err(|e|e.to_string())?;if !entry.file_type().map_err(|e|e.to_string())?.is_file(){continue}let path=entry.path();
  if path.parent()==Some(root)&&crate::audio_identity::supported(&path){let mut a=crate::audio_identity::info(&path)?;a["relativePath"]=json!(entry.file_name().to_string_lossy());audio.push(a);}
  else if ["subtitler","whisperdesk"].contains(&path.extension().and_then(|s|s.to_str()).unwrap_or("")){
   if let Ok(p)=read(&path){if p["format"]!="whisperdesk-project-v1"&&p["format"]!="subtitler-project-v1"{continue}let mut source=p["source"].clone();
    let actual=source["relativePath"].as_str().and_then(|s|relative(root,s).ok()).filter(|p|p.is_file()).or_else(||source["path"].as_str().map(PathBuf::from).filter(|p|p.is_file()));
    if let Some(actual)=actual.filter(|p|crate::audio_identity::supported(p)){if let Ok(info)=crate::audio_identity::info(&actual){
     let compatible=if source["fingerprint"].is_string(){source["fingerprint"]==info["fingerprint"]}else{(!source["size"].is_number()||source["size"]==info["size"])&&(!source["modified"].is_number()||source["modified"]==info["modified"])};
     source["path"]=info["path"].clone();
     if compatible{for k in ["fingerprint","size","modified"]{source[k]=info[k].clone();}}else{if !source["fingerprint"].is_string(){source["fingerprint"]=json!("unverified-older-recording");}source["recordingChanged"]=json!(true);}
    }}
    transcripts.push(json!({"path":path.to_string_lossy(),"id":p["id"],"name":p["name"],"source":source,"updatedAt":p["updatedAt"],"cueCount":p["cues"].as_array().map(|c|c.len()).unwrap_or(0),"studioProjectId":p["studioLink"]["projectId"]}));
   }}
 }
 if let Ok(registry)=read(&root.join("Studio Link/subtitler-files.json")){if let Some(records)=registry["recordings"].as_object(){for record in records.values(){if let Some(path)=record["path"].as_str().map(PathBuf::from){let path=crate::library_folder::resolved(&path);if transcripts.iter().any(|t|t["path"].as_str()==path.to_str()){continue;}if let Ok(p)=read(&path){transcripts.push(json!({"path":path,"id":p["id"],"name":p["name"],"source":p["source"],"updatedAt":p["updatedAt"],"cueCount":p["cues"].as_array().map(|c|c.len()).unwrap_or(0),"studioProjectId":p["studioLink"]["projectId"]}));}}}}}
 audio.sort_by(|a,b|a["name"].as_str().cmp(&b["name"].as_str()));Ok((audio,transcripts))
}
pub fn inspect(directory:&str,expected:Option<&str>,audio_relative:Option<&str>)->Result<Value,String>{let root=root(directory)?;let manifest=identity(&root,expected)?;let mut warnings=Vec::new();let mut script=Value::Null;
 if let Some(ref m)=manifest{let shared=link(&root,false)?;let path=relative(&shared,m["files"]["script"].as_str().unwrap_or("spoken-script.json"))?;if path.exists(){let raw=read(&path)?;if raw["format"]!="subtitler-script-v1"||raw["studioProjectId"]!=m["project"]["id"]{return Err("The shared script belongs to another project. Refresh Storyboard Studio.".into())}script=raw;}else{warnings.push("The shared script is missing. Open Storyboard Studio to refresh it.");}if read(&shared.join("project.json"))?!=*m{return Err("Storyboard Studio is updating this folder. Retry in a moment.".into())}}
 else{warnings.push("Project folder connected. Open it in Storyboard Studio to enable shared script and timing.");}
 let audio=if let Some(rel)=audio_relative{let p=relative(&root,rel)?;if p.is_file(){Some(p.to_string_lossy().into_owned())}else{None}}else{None};
 let(mut audio_files,transcripts)=discovery(&root)?;
 // A recording explicitly selected in Storyboard Studio may live outside the
 // project root. Keep exact recording verification; don't substitute a namesake.
 if let Some(active)=manifest.as_ref().map(|m|&m["activeRecording"]){
  if let Some(path)=active["path"].as_str().map(PathBuf::from).filter(|p|p.is_file()&&crate::audio_identity::supported(p)){
   if let Ok(info)=crate::audio_identity::info(&path){if active["fingerprint"].is_string()&&active["fingerprint"]==info["fingerprint"]&&!audio_files.iter().any(|a|a["fingerprint"]==info["fingerprint"]){audio_files.push(info);}}
  }
 }
 Ok(json!({"audioCandidates":audio_files,"transcripts":transcripts,"directory":root.to_string_lossy(),"projectId":manifest.as_ref().and_then(|m|m["project"]["id"].as_str()),"projectName":manifest.as_ref().and_then(|m|m["project"]["name"].as_str()),"script":script,"audioPath":audio,"activeRecording":manifest.as_ref().map(|m|m["activeRecording"].clone()),"warnings":warnings}))}
pub fn save(directory:&str,studio_id:Option<&str>,project_id:&str,filename:&str,project_data:&str,timing_data:&str)->Result<Value,String>{
 id(project_id)?;
 if project_data.len()>50*1024*1024||timing_data.len()>50*1024*1024{return Err("Project or timing exceeds 50 MB".into())}
 let root=root(directory)?;let shared=link(&root,true)?;let _workflow=crate::project_lock::acquire(&root)?;let manifest=identity(&root,studio_id)?;
 let _lock=SaveLock::acquire(shared.join("subtitler-write.lock"))?;
 let mut project:Value=serde_json::from_str(project_data).map_err(|e|e.to_string())?;
 let mut timing:Value=serde_json::from_str(timing_data).map_err(|e|e.to_string())?;
 if project["id"].as_str()!=Some(project_id)||project["format"]!="whisperdesk-project-v1"||timing["projectId"].as_str()!=Some(project_id)||timing["format"]!="whisperdesk-timing-v1"{return Err("Project and timing identities differ".into())}
 let registry_path=shared.join("subtitler-files.json");
 let mut registry=if registry_path.exists(){read(&registry_path)?}else{json!({"format":"subtitler-files-v1","files":{},"recordings":{}})};
 if registry["format"]!="subtitler-files-v1"{return Err("The Subtitler file registry is not readable".into())}
 let mut verified=false;
 if let Some(path)=project["source"]["path"].as_str().map(PathBuf::from).filter(|p|p.is_file()).or_else(||project["source"]["embeddedPath"].as_str().map(PathBuf::from).filter(|p|p.is_file())){
   let actual=crate::audio_identity::info(&path)?;
   if project["source"]["fingerprint"].is_string()&&project["source"]["fingerprint"]!=actual["fingerprint"]{return Err("The audio content changed. Attach the intended recording and match again. Existing timing was kept.".into())}
   for k in ["fingerprint","size","modified"]{project["source"][k]=actual[k].clone();timing["source"][k]=actual[k].clone();}verified=true;
 }
 let recording=project["source"]["fingerprint"].as_str().unwrap_or(project_id).to_string();
 let external=project["filePath"].as_str().map(PathBuf::from).map(|p|crate::library_folder::resolved(&p)).filter(|p|p.is_absolute());if let Some(ref path)=external{let saved=read(path)?;if saved["id"]!=project["id"]{return Err("The saved transcript belongs to another document. Use Save As.".into());}}
 let preferred=registry["recordings"][&recording]["filename"].as_str().or_else(||registry["files"][project_id]["filename"].as_str()).map(str::to_owned);
 let mut name=preferred.unwrap_or_else(||{let n=leaf(filename);if n.to_lowercase().ends_with(".subtitler"){n}else{format!("{n}.subtitler")}});
 if name.contains('/')||name.contains('\\')||!name.ends_with(".subtitler"){return Err("Invalid saved project filename".into())}
 let stem=name.trim_end_matches(".subtitler").to_string();let mut n=2;
 if external.is_none(){loop{let output=relative(&shared,&name)?;if !output.exists(){break}let old=read(&output)?;
   if old["id"].as_str()==Some(project_id)||old["source"]["fingerprint"].as_str()==Some(recording.as_str()){break}
   name=format!("{stem} ({n}).subtitler");n+=1;if n>10000{return Err("Choose another transcript name".into())}
 }
 }
 let output=external.clone().unwrap_or(relative(&shared,&name)?);if external.is_some(){name=output.file_name().unwrap_or_default().to_string_lossy().into_owned();}
 let relative_audio=project["source"]["path"].as_str().and_then(|s|Path::new(s).strip_prefix(&root).ok()).map(|p|p.to_string_lossy().replace('\\',"/"));
 project["source"]["relativePath"]=json!(relative_audio);timing["source"]["relativePath"]=json!(relative_audio);
 project["filePath"]=json!(output.to_string_lossy());project["studioLink"]["projectFile"]=json!(output.to_string_lossy());
 // The editable document is retained even if it is an older, inactive recording.
 if external.is_none(){write_if_changed(&output,&serde_json::to_vec_pretty(&project).map_err(|e|e.to_string())?)?;}
 timing["subtitlerProjectFile"]=json!(output.to_string_lossy());
 let selected=manifest.as_ref().and_then(|m|m["activeRecording"]["fingerprint"].as_str());
 let active=selected.map(|v|v==recording).unwrap_or(true);
 let duration=project["source"]["duration"].as_f64().unwrap_or(0.);
 let usable=verified&&!project["timingsNeedMatch"].as_bool().unwrap_or(false)&&timing["words"].as_array().map(|w|!w.is_empty()&&w.iter().all(|w|w["start"].as_f64().zip(w["end"].as_f64()).map(|(a,b)|a.is_finite()&&b.is_finite()&&a>=0.&&b>a&&(duration==0.||b<=duration+0.05)).unwrap_or(false))).unwrap_or(false);
 let cleared=project["timingsCleared"].as_bool().unwrap_or(false);
 let per_recording=format!("subtitler-{recording}.timing.json");
 let stored=shared.join(".recordings");fs::create_dir_all(&stored).map_err(|e|e.to_string())?;if !stored.canonicalize().map_err(|e|e.to_string())?.starts_with(&root){return Err("Recording storage points outside the project folder".into())}
 if manifest.is_some()&&verified&&(usable||cleared){
   timing["studioProjectId"]=manifest.as_ref().unwrap()["project"]["id"].clone();timing["recordingId"]=json!(recording);
   if cleared{timing["words"]=json!([]);timing["subtitles"]=json!([]);timing["status"]=json!("cleared");}
   let bytes=serde_json::to_vec_pretty(&timing).map_err(|e|e.to_string())?;
   write_if_changed(&stored.join(&per_recording),&bytes)?;
   if active{
     write_if_changed(&shared.join("subtitler-audio.timing.json"),&bytes)?;
     // A single root handoff is visible to SS; older recordings retain their own
     // editable document and timing below .recordings.
     for entry in fs::read_dir(&shared).map_err(|e|e.to_string())?.flatten(){let old=entry.path();if old.file_name().and_then(|s|s.to_str())==Some("subtitler-audio.timing.json")||!old.file_name().unwrap_or_default().to_string_lossy().ends_with(".timing.json"){continue}
       if let Ok(v)=read(&old){if v["studioProjectId"]==timing["studioProjectId"]{let archive=shared.join(".transcript-archive");fs::create_dir_all(&archive).map_err(|e|e.to_string())?;let dest=archive.join(old.file_name().unwrap());if !dest.exists(){fs::rename(old,dest).map_err(|e|e.to_string())?;}}}
     }
   }
 }
 registry["files"][project_id]=json!({"filename":name,"path":output,"recordingId":recording});
 registry["recordings"][&recording]=json!({"filename":name,"path":output,"projectId":project_id,"timing":format!(".recordings/{per_recording}")});
 if active{registry["activeProjectId"]=json!(project_id);registry["activeRecordingId"]=json!(recording);}
 write_if_changed(&registry_path,&serde_json::to_vec_pretty(&registry).map_err(|e|e.to_string())?)?;
 Ok(json!({"projectFile":output.to_string_lossy(),"timingFile":if active&&shared.join("subtitler-audio.timing.json").exists(){Some(shared.join("subtitler-audio.timing.json").to_string_lossy().into_owned())}else{None},"audioRelativePath":relative_audio,"warning":if !active{Some("Saved this recording. Storyboard Studio is currently using a different recording.")}else if !usable&&!cleared&&manifest.is_some(){Some("No usable timing was published; previous valid timing was kept.")}else{None}}))
}
fn write_if_changed(path:&Path,bytes:&[u8])->Result<(),String>{if fs::read(path).ok().as_deref()!=Some(bytes){atomic(path,bytes)?;}Ok(())}
struct SaveLock(PathBuf);
impl SaveLock{fn acquire(path:PathBuf)->Result<Self,String>{
 if path.exists(){let old=fs::read_to_string(&path).unwrap_or_default();let pid=old.trim().parse::<u32>().ok();
   let alive=pid.map(|p|{
    #[cfg(unix)]{std::process::Command::new("kill").args(["-0",&p.to_string()]).output().map(|v|v.status.success()).unwrap_or(true)}
    #[cfg(windows)]{std::process::Command::new("tasklist").args(["/FI",&format!("PID eq {p}"),"/NH"]).output().map(|v|String::from_utf8_lossy(&v.stdout).contains(&p.to_string())).unwrap_or(true)}
    #[cfg(not(any(unix,windows)))]{let _=p;true}
   }).unwrap_or(true);
   if !alive{let _=fs::remove_file(&path);}
 }
 let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|"Another Subtitler window is saving this project. Try again when it finishes.".to_string())?;
 writeln!(file,"{}",std::process::id()).map_err(|e|e.to_string())?;Ok(Self(path))
}}
impl Drop for SaveLock{fn drop(&mut self){let _=fs::remove_file(&self.0);}}

pub fn write_export(directory:&str,studio_id:Option<&str>,project_id:&str,filename:&str,bytes:&[u8])->Result<String,String>{
 id(project_id)?;if bytes.len()>100*1024*1024{return Err("Export exceeds 100 MB".into())}let root=root(directory)?;identity(&root,studio_id)?;let shared=link(&root,true)?;
 let ext=Path::new(filename).extension().and_then(|s|s.to_str()).unwrap_or("");let name=format!("{}.{}",leaf(Path::new(filename).file_stem().and_then(|s|s.to_str()).unwrap_or("Transcript")),ext);if !["docx","txt","srt","csv","xlsx","json","subtitler"].contains(&ext){return Err("Unsupported export format".into())}
 let lock_path=shared.join("subtitler-write.lock");let _lock=fs::OpenOptions::new().write(true).create_new(true).open(&lock_path).map_err(|_|"Another Subtitler save is running. Try exporting again.".to_string())?;struct Unlock(PathBuf);impl Drop for Unlock{fn drop(&mut self){let _=fs::remove_file(&self.0);}}let _unlock=Unlock(lock_path);
 let registry_path=shared.join("subtitler-files.json");let mut registry=if registry_path.exists(){read(&registry_path)?}else{json!({"format":"subtitler-files-v1","files":{},"exports":{}})};if registry["format"]!="subtitler-files-v1"{return Err("The Subtitler file registry is not readable".into())}
 let saved=registry["exports"][project_id][ext].as_str();let output_name=saved.unwrap_or(&name).to_string();let output=relative(&root,&output_name)?;if output.exists()&&saved.is_none(){return Err(format!("{output_name} already exists and is not owned by this export. Rename the transcript to use another filename."))}
 atomic(&output,bytes)?;registry["exports"][project_id][ext]=json!(output_name);atomic(&registry_path,&serde_json::to_vec_pretty(&registry).map_err(|e|e.to_string())?)?;Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
 use super::*;
 struct Temp(PathBuf);impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
 fn temp()->Temp{let p=std::env::temp_dir().join(format!("subtitler-files-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir(&p).unwrap();Temp(p.canonicalize().unwrap())}
 fn setup(root:&Path){fs::create_dir_all(root.join("Studio Link")).unwrap();fs::write(root.join("Studio Link/project.json"),json!({"format":"studio-link-project-v1","schemaVersion":1,"project":{"id":"ss","name":"Test"},"files":{"script":"spoken-script.json"}}).to_string()).unwrap();fs::write(root.join("Studio Link/spoken-script.json"),json!({"format":"subtitler-script-v1","schemaVersion":1,"studioProjectId":"ss","chapters":[]}).to_string()).unwrap();}
 fn payload(root:&Path,pid:&str)->(String,String){(json!({"format":"whisperdesk-project-v1","id":pid,"source":{"path":root.join("audio.wav").to_string_lossy()},"name":"Test","cues":[]}).to_string(),json!({"format":"whisperdesk-timing-v1","projectId":pid,"source":{"path":root.join("audio.wav").to_string_lossy()},"words":[{"id":"w","text":"Test","start":0,"end":1}]}).to_string())}
 #[test]fn stable_names_replace_only_the_same_project(){let t=temp();setup(&t.0);fs::write(t.0.join("audio.wav"),b"audio").unwrap();let(p,q)=payload(&t.0,"a");let dir=t.0.to_str().unwrap();let first=save(dir,Some("ss"),"a","Test.subtitler",&p,&q).unwrap();let mut changed:Value=serde_json::from_str(&p).unwrap();changed["name"]=json!("Edited");let result=save(dir,Some("ss"),"a","New name.subtitler",&changed.to_string(),&q).unwrap();assert_eq!(read(&t.0.join("Studio Link/Test.subtitler")).unwrap()["name"],"Edited");assert!(!t.0.join("New name.subtitler").exists());assert_eq!(result["audioRelativePath"],"audio.wav");assert_eq!(read(Path::new(first["timingFile"].as_str().unwrap())).unwrap()["studioProjectId"],"ss");assert_eq!(fs::read(t.0.join("audio.wav")).unwrap(),b"audio");}
 #[test]fn unrelated_collision_and_foreign_project_are_preserved(){let t=temp();setup(&t.0);let(p,q)=payload(&t.0,"a");let dir=t.0.to_str().unwrap();fs::write(t.0.join("Studio Link/Test.subtitler"),json!({"id":"other","note":"keep"}).to_string()).unwrap();let old=fs::read(t.0.join("Studio Link/Test.subtitler")).unwrap();let saved=save(dir,Some("ss"),"a","Test.subtitler",&p,&q).unwrap();assert!(saved["projectFile"].as_str().unwrap().ends_with("Test (2).subtitler"));assert_eq!(fs::read(t.0.join("Studio Link/Test.subtitler")).unwrap(),old);assert!(inspect(dir,Some("another"),None).is_err());}
 #[test]fn moving_the_whole_folder_keeps_relative_audio(){let t=temp();let source=t.0.join("old");fs::create_dir(&source).unwrap();setup(&source);fs::write(source.join("audio.wav"),b"audio").unwrap();let target=t.0.join("new");fs::rename(&source,&target).unwrap();let result=inspect(target.to_str().unwrap(),Some("ss"),Some("audio.wav")).unwrap();assert_eq!(result["audioPath"],target.join("audio.wav").to_string_lossy().to_string());assert_eq!(result["script"]["studioProjectId"],"ss");}
 #[test]fn traversal_and_foreign_shared_script_are_rejected(){let t=temp();setup(&t.0);fs::write(t.0.join("Studio Link/spoken-script.json"),json!({"format":"subtitler-script-v1","studioProjectId":"other"}).to_string()).unwrap();assert!(inspect(t.0.to_str().unwrap(),Some("ss"),None).is_err());assert!(relative(&t.0,"../outside").is_err());assert!(relative(&t.0,"/absolute").is_err());assert!(relative(&t.0,"folder\\escape").is_err());}
 #[test]fn standalone_folder_does_not_publish_unbound_timing(){let t=temp();let(p,q)=payload(&t.0,"a");let dir=t.0.to_str().unwrap();assert!(!inspect(dir,None,None).unwrap()["warnings"].as_array().unwrap().is_empty());save(dir,None,"a","Test.subtitler",&p,&q).unwrap();assert!(t.0.join("Studio Link/Test.subtitler").is_file());assert!(!t.0.join("Studio Link/subtitler-a.timing.json").exists());assert!(!t.0.join("Studio Link/project.json").exists());}
 #[cfg(unix)]#[test]fn external_symlinks_are_rejected(){let t=temp();let other=temp();std::os::unix::fs::symlink(&other.0,t.0.join("Studio Link")).unwrap();assert!(inspect(t.0.to_str().unwrap(),None,None).is_err());}
 #[test]fn requested_exports_use_project_folder_and_replace_only_owned_outputs(){let t=temp();setup(&t.0);let dir=t.0.to_str().unwrap();write_export(dir,Some("ss"),"a","Test.srt",b"first").unwrap();write_export(dir,Some("ss"),"a","New name.srt",b"updated").unwrap();assert_eq!(fs::read(t.0.join("Test.srt")).unwrap(),b"updated");assert!(!t.0.join("New name.srt").exists());assert!(write_export(dir,Some("ss"),"b","Test.srt",b"foreign").is_err());assert_eq!(fs::read(t.0.join("Test.srt")).unwrap(),b"updated");let(p,q)=payload(&t.0,"a");save(dir,Some("ss"),"a","Test.subtitler",&p,&q).unwrap();write_export(dir,Some("ss"),"a","Test.srt",b"after project save").unwrap();}
}
#[cfg(test)]mod timing_guard_tests{use super::*;
#[test]fn invalid_new_timing_keeps_last_valid_handoff_and_preserves_unopened_root_files(){let root=std::env::temp_dir().join(format!("sub-guard-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(root.join("Studio Link")).unwrap();fs::write(root.join("Studio Link/project.json"),json!({"format":"studio-link-project-v1","schemaVersion":1,"project":{"id":"ss","name":"Test"}}).to_string()).unwrap();let audio=root.join("audio.wav");fs::write(&audio,b"original audio").unwrap();let project=json!({"format":"whisperdesk-project-v1","id":"a","source":{"path":audio,"duration":2},"cues":[]});let mut timing=json!({"format":"whisperdesk-timing-v1","projectId":"a","source":{"path":audio},"words":[{"id":"w","start":0,"end":1,"text":"One"}]});let first=save(root.to_str().unwrap(),Some("ss"),"a","Test.subtitler",&project.to_string(),&timing.to_string()).unwrap();let current=PathBuf::from(first["timingFile"].as_str().unwrap());let valid=fs::read(&current).unwrap();fs::copy(first["projectFile"].as_str().unwrap(),root.join("Test.subtitler")).unwrap();timing["words"][0]["end"]=json!(3);let result=save(root.to_str().unwrap(),Some("ss"),"a","Other name.subtitler",&project.to_string(),&timing.to_string()).unwrap();assert!(result["warning"].is_string());assert_eq!(fs::read(current).unwrap(),valid);assert!(root.join("Test.subtitler").exists());assert_eq!(fs::read(audio).unwrap(),b"original audio");assert_eq!(fs::read_dir(root.join("Studio Link")).unwrap().flatten().filter(|e|e.file_name().to_string_lossy().ends_with(".timing.json")).count(),1);fs::remove_dir_all(root).unwrap();}
}
#[cfg(test)]mod recording_switch_tests{use super::*;
#[test]fn recording_replacement_retains_each_document_and_one_active_handoff(){
 let root=std::env::temp_dir().join(format!("sub-switch-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(root.join("Studio Link")).unwrap();
 let one_path=root.join("one.wav");let two_path=root.join("two.wav");fs::write(&one_path,b"audio one").unwrap();fs::write(&two_path,b"audio two").unwrap();
 let one=crate::audio_identity::info(&one_path).unwrap();let two=crate::audio_identity::info(&two_path).unwrap();
 let mut manifest=json!({"format":"studio-link-project-v1","schemaVersion":1,"project":{"id":"ss","name":"Test"},"activeRecording":one});
 let m=root.join("Studio Link/project.json");fs::write(&m,manifest.to_string()).unwrap();
 let make=|id:&str,a:&Value|(json!({"format":"whisperdesk-project-v1","id":id,"source":{"path":a["path"],"duration":2,"fingerprint":a["fingerprint"]},"studioLink":{"projectId":"ss","recordingFingerprint":a["fingerprint"]},"cues":[]}).to_string(),json!({"format":"whisperdesk-timing-v1","projectId":id,"source":{"path":a["path"]},"words":[{"id":"w","start":0,"end":1}]}).to_string());
 let(p,t)=make("a",&one);let first=save(root.to_str().unwrap(),Some("ss"),"a","Test.subtitler",&p,&t).unwrap();let handoff=root.join("Studio Link/subtitler-audio.timing.json");let old=fs::read(&handoff).unwrap();
 let(p,t)=make("b",&two);let inactive=save(root.to_str().unwrap(),Some("ss"),"b","Test.subtitler",&p,&t).unwrap();assert!(inactive["warning"].is_string());assert_eq!(fs::read(&handoff).unwrap(),old);
 manifest["activeRecording"]=two.clone();fs::write(&m,manifest.to_string()).unwrap();let second=save(root.to_str().unwrap(),Some("ss"),"b","Changed.subtitler",&p,&t).unwrap();
 assert_ne!(first["projectFile"],second["projectFile"]);assert_eq!(second["projectFile"],inactive["projectFile"]);assert_eq!(read(&handoff).unwrap()["projectId"],"b");
 assert_eq!(fs::read_dir(root.join("Studio Link")).unwrap().flatten().filter(|e|e.path().extension().and_then(|s|s.to_str())==Some("subtitler")).count(),2);
 assert_eq!(fs::read(one_path).unwrap(),b"audio one");assert_eq!(fs::read(two_path).unwrap(),b"audio two");fs::remove_dir_all(root).unwrap();
}
}

#[cfg(test)]mod external_recording_tests{
 use super::*;
 #[test]fn selected_external_recording_is_discovered_without_accepting_other_audio(){
  let base=std::env::temp_dir().join(format!("sub-external-{}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));let project=base.join("Project");fs::create_dir_all(project.join("Studio Link")).unwrap();
  let external=base.join("External.wav");fs::write(&external,b"selected external recording").unwrap();fs::write(project.join("Unrelated.wav"),b"other recording").unwrap();let selected=crate::audio_identity::info(&external).unwrap();
  fs::write(project.join("Studio Link/project.json"),json!({"format":"studio-link-project-v1","schemaVersion":1,"project":{"id":"ss"},"activeRecording":selected}).to_string()).unwrap();
  let result=inspect(project.to_str().unwrap(),Some("ss"),None).unwrap();assert_eq!(result["audioCandidates"].as_array().unwrap().len(),2);assert!(result["audioCandidates"].as_array().unwrap().iter().any(|a|a["fingerprint"]==selected["fingerprint"]));
  // Changing the external bytes must never validate them against the old timing.
  fs::write(&external,b"a different version of the external recording").unwrap();let result=inspect(project.to_str().unwrap(),Some("ss"),None).unwrap();assert_eq!(result["audioCandidates"].as_array().unwrap().len(),1);fs::remove_dir_all(base).unwrap();
 }
}

#[cfg(test)]mod recovery07_tests{use super::*;
 fn setup()->PathBuf{let p=std::env::temp_dir().join(format!("sub-recovery-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(p.join("Studio Link")).unwrap();fs::write(p.join("Studio Link/project.json"),json!({"format":"studio-link-project-v1","schemaVersion":1,"project":{"id":"ss","name":"Test"}}).to_string()).unwrap();fs::write(p.join("audio.wav"),b"original bytes").unwrap();p}
 #[test]fn repeat_save_keeps_bytes_and_clear_replaces_old_shared_timings(){let root=setup();let p=json!({"format":"whisperdesk-project-v1","id":"a","source":{"path":root.join("audio.wav"),"duration":2},"cues":[]});let timing=json!({"format":"whisperdesk-timing-v1","projectId":"a","source":{},"words":[{"start":0,"end":1,"text":"One"}]});
 let first=save(root.to_str().unwrap(),Some("ss"),"a","Test.subtitler",&p.to_string(),&timing.to_string()).unwrap();let file=PathBuf::from(first["projectFile"].as_str().unwrap());let old=fs::metadata(&file).unwrap().modified().unwrap();save(root.to_str().unwrap(),Some("ss"),"a","Changed.subtitler",&p.to_string(),&timing.to_string()).unwrap();assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(),old);
 let mut cleared=p;cleared["timingsCleared"]=json!(true);save(root.to_str().unwrap(),Some("ss"),"a","Test.subtitler",&cleared.to_string(),&timing.to_string()).unwrap();let handoff=read(&root.join("Studio Link/subtitler-audio.timing.json")).unwrap();assert_eq!(handoff["words"],json!([]));assert_eq!(fs::read(root.join("audio.wav")).unwrap(),b"original bytes");fs::remove_dir_all(root).unwrap();}
 #[cfg(unix)]#[test]fn live_save_lock_is_not_removed(){let root=setup();let lock=root.join("Studio Link/subtitler-write.lock");fs::write(&lock,std::process::id().to_string()).unwrap();assert!(SaveLock::acquire(lock.clone()).is_err());assert!(lock.exists());fs::remove_dir_all(root).unwrap();}
}
