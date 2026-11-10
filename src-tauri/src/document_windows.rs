use std::{collections::HashMap,path::{Path,PathBuf},sync::{Mutex,atomic::{AtomicU64,Ordering}}};
use serde_json::{json,Value};
use tauri::{Emitter,Manager};
#[derive(Default)]pub struct Documents(pub Mutex<HashMap<String,String>>);
#[derive(Default)]pub struct Recordings(pub Mutex<HashMap<String,String>>);
#[tauri::command]pub fn claim_recording(app:tauri::AppHandle,window:tauri::WebviewWindow,project_id:String,fingerprint:String)->Result<bool,String>{
 let key=format!("{project_id}:{fingerprint}");let state=app.state::<Recordings>();let mut map=state.0.lock().map_err(|e|e.to_string())?;
 if let Some(label)=map.get(&key){if label!=window.label(){if let Some(w)=app.get_webview_window(label){let _=w.set_focus();let _=w.emit_to(w.label(),"subtitler-rematch",());return Ok(false)}}}
 map.retain(|_,label|label!=window.label());map.insert(key,window.label().into());Ok(true)
}
#[derive(Default)]pub struct Requests(pub Mutex<std::collections::HashSet<String>>);
#[tauri::command]pub fn claim_studio_request(app:tauri::AppHandle,id:String)->Result<bool,String>{if id.len()>200{return Err("Invalid request".into())}app.state::<Requests>().0.lock().map(|mut s|s.insert(id)).map_err(|e|e.to_string())}
pub static QUITTING:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
#[derive(Default)]pub struct EmptyWindows(pub Mutex<std::collections::HashSet<String>>);
#[tauri::command]pub fn set_document_empty(app:tauri::AppHandle,window:tauri::WebviewWindow,empty:bool,recording_key:Option<String>){if let Ok(mut state)=app.state::<EmptyWindows>().0.lock(){if empty{state.insert(window.label().into());}else{state.remove(window.label());}}if let Ok(mut recordings)=app.state::<Recordings>().0.lock(){recordings.retain(|_,label|label!=window.label());if let Some(key)=recording_key.filter(|k|k.len()<600){if !recordings.contains_key(&key){recordings.insert(key,window.label().into());}}}}
pub fn open_or_report(app:&tauri::AppHandle,path:Option<String>,request:Option<Value>){if let Err(e)=open(app,path,request){rfd::MessageDialog::new().set_title("Could not open Subtitler project").set_description(e).set_level(rfd::MessageLevel::Error).show();if app.webview_windows().is_empty(){let _=open(app,None,None);}}}
pub fn activate(app:&tauri::AppHandle){if let Some(w)=app.webview_windows().values().next(){let _=w.show();let _=w.set_focus();}else{open_or_report(app,None,None);}}
#[derive(Default)]pub struct InitialDocuments(pub Mutex<HashMap<String,Value>>);
#[tauri::command]pub fn take_document_open(app:tauri::AppHandle,window:tauri::WebviewWindow)->Option<Value>{app.state::<InitialDocuments>().0.lock().ok()?.remove(window.label())}
static NEXT:AtomicU64=AtomicU64::new(1);
pub fn open(app:&tauri::AppHandle,path:Option<String>,request:Option<Value>)->Result<String,String>{
 if let Some(ref r)=request{if let (Some(pid),Some(fp))=(r["projectId"].as_str(),r["activeRecording"]["fingerprint"].as_str()){
   if let Some(label)=app.state::<Recordings>().0.lock().map_err(|e|e.to_string())?.get(&format!("{pid}:{fp}")).cloned(){if let Some(w)=app.get_webview_window(&label){let _=w.set_focus();let _=w.emit_to(w.label(),"subtitler-rematch",());return Ok(label)}}
 }}
 let path=path.map(|p|crate::library_folder::resolved(Path::new(&p)).canonicalize().map(|p|p.to_string_lossy().into_owned()).map_err(|_|"File not found. Use File → Open to select it again.".to_string())).transpose()?;
 if let Some(ref p)=path{let docs=app.state::<Documents>();let map=docs.0.lock().map_err(|e|e.to_string())?;if let Some((label,_))=map.iter().find(|(_,v)|*v==p){if let Some(w)=app.get_webview_window(label){let _=w.set_focus();return Ok(label.clone())}}}
 if path.is_some()||request.is_some(){
 let candidate={let empty_state=app.state::<EmptyWindows>();let mut empty=empty_state.0.lock().map_err(|e|e.to_string())?;let label=empty.iter().find(|label|app.get_webview_window(label).is_some()).cloned().or_else(||app.state::<InitialDocuments>().0.lock().ok().and_then(|pending|pending.iter().find(|(label,payload)|app.get_webview_window(label).is_some()&&payload["path"].is_null()&&payload["request"].is_null()).map(|(label,_)|label.clone())));if let Some(ref label)=label{empty.remove(label);}label};
 if let Some(label)=candidate{if let Some(w)=app.get_webview_window(&label){let payload=json!({"path":path,"request":request});app.state::<InitialDocuments>().0.lock().map_err(|e|e.to_string())?.insert(label.clone(),payload.clone());if let Some(p)=path{app.state::<Documents>().0.lock().map_err(|e|e.to_string())?.insert(label.clone(),p);}w.emit_to(w.label(),"subtitler-open",payload).map_err(|e|e.to_string())?;let _=w.set_focus();return Ok(label);}}
 }
 let label=format!("document-{}",NEXT.fetch_add(1,Ordering::SeqCst));
 let payload=json!({"path":path,"request":request});
 app.state::<InitialDocuments>().0.lock().map_err(|e|e.to_string())?.insert(label.clone(),payload.clone());
 let script=format!("window.SUBTITLER_OPEN={};",payload);
 tauri::WebviewWindowBuilder::new(app,label.clone(),tauri::WebviewUrl::App(PathBuf::from("index.html"))).title("Subtitler").inner_size(1260.,860.).min_inner_size(900.,650.).initialization_script(script).build().map_err(|e|{if let Ok(mut pending)=app.state::<InitialDocuments>().0.lock(){pending.remove(&label);}e.to_string()})?;
 if let Some(p)=path{app.state::<Documents>().0.lock().map_err(|e|e.to_string())?.insert(label.clone(),p);}
 Ok(label)
}
#[tauri::command]pub async fn new_document_window(app:tauri::AppHandle,path:Option<String>,request:Option<Value>)->Result<String,String>{open(&app,path,request)}
#[tauri::command]pub fn claim_document(app:tauri::AppHandle,window:tauri::WebviewWindow,path:String)->Result<bool,String>{
 let path=crate::library_folder::resolved(Path::new(&path));let actual=if path.exists(){path.canonicalize().map_err(|e|e.to_string())?}else{path.parent().ok_or("Choose a save folder")?.canonicalize().map_err(|e|e.to_string())?.join(path.file_name().ok_or("Choose a filename")?)}.to_string_lossy().into_owned();let docs=app.state::<Documents>();let mut map=docs.0.lock().map_err(|e|e.to_string())?;
 if let Some((label,_))=map.iter().find(|(k,v)|k.as_str()!=window.label()&&**v==actual){if let Some(w)=app.get_webview_window(label){let _=w.set_focus();return Ok(false)}}
 map.insert(window.label().into(),actual);Ok(true)
}
#[tauri::command]pub fn document_title(window:tauri::WebviewWindow,title:String)->Result<(),String>{window.set_title(&format!("{} — Subtitler",title.chars().take(200).collect::<String>())).map_err(|e|e.to_string())}
#[tauri::command]pub fn cancel_document_close(){QUITTING.store(false,Ordering::SeqCst);}
#[tauri::command]pub fn finish_document_close(window:tauri::WebviewWindow)->Result<(),String>{window.destroy().map_err(|e|e.to_string())}
pub fn menu(app:&tauri::AppHandle,id:&str){
 if let Some(w)=app.webview_windows().values().find(|w|w.is_focused().unwrap_or(false)){let _=w.emit_to(w.label(),"subtitler-menu",id.to_string());}
 else if id=="new-project"{open_or_report(app,None,None);}
 else if id=="open-project"{if let Some(p)=rfd::FileDialog::new().set_title("Open Subtitler project").add_filter("Subtitler project",&["subtitler","whisperdesk"]).pick_file(){open_or_report(app,Some(p.to_string_lossy().into_owned()),None);}}
 else if ["settings","recent-projects","move-transcript-folder"].contains(&id){open_or_report(app,None,Some(json!({"uiAction":id})));}
}
