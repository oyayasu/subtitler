//! File-open forwarding keeps document ownership in one process on both systems.
use std::{fs,path::PathBuf,time::{Duration,SystemTime,UNIX_EPOCH}};
use serde_json::json;
fn runtime()->PathBuf{
 let home=std::env::var_os("HOME").or_else(||std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
 if cfg!(target_os="macos"){home.join("Library/Application Support/local.filipe.whisperdesk/runtime")}
 else if cfg!(windows){std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or(home.join("AppData/Local")).join("local.filipe.whisperdesk/runtime")}
 else{home.join(".local/share/local.filipe.whisperdesk/runtime")}
}
pub fn start()->Result<Option<fs::File>,String>{
 let root=runtime();fs::create_dir_all(root.join("inbox")).map_err(|e|e.to_string())?;
 crate::instance_guard::acquire(&root.join("instance.lock"))
}
pub fn forward(paths:Vec<String>)->Result<(),String>{
 let root=runtime();fs::create_dir_all(root.join("inbox")).map_err(|e|e.to_string())?;
 let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
 crate::project_files::atomic(&root.join("inbox").join(format!("{}-{stamp}.json",std::process::id())),json!({"paths":paths}).to_string().as_bytes())
}
pub fn listen(app:tauri::AppHandle){std::thread::spawn(move||loop{
 if let Ok(entries)=fs::read_dir(runtime().join("inbox")){for e in entries.flatten(){let p=e.path();if p.extension().and_then(|s|s.to_str())!=Some("json"){continue}
   if let Ok(bytes)=fs::read(&p){if let Ok(v)=serde_json::from_slice::<serde_json::Value>(&bytes){let paths=v["paths"].as_array().cloned().unwrap_or_default();let handle=app.clone();let _=app.run_on_main_thread(move||{if paths.is_empty(){crate::document_windows::activate(&handle);}else{for p in paths{if let Some(p)=p.as_str(){crate::document_windows::open_or_report(&handle,Some(p.into()),None);}}}});}}
   let _=fs::remove_file(p);
 }}std::thread::sleep(Duration::from_millis(300));
});}
