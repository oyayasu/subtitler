//! Path-owned documents. A copied file never inherits another file's save target.
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf}};
pub fn read(path:&Path)->Result<Value,String>{
 let actual=path.canonicalize().map_err(|_|"File not found. Use File → Open to select it again.".to_string())?;
 if !["subtitler","whisperdesk"].contains(&actual.extension().and_then(|x|x.to_str()).unwrap_or("").to_lowercase().as_str()){return Err("Choose a .subtitler project".into())}
 let data=crate::audio_package::read(&actual)?.project;
 if !["whisperdesk-project-v1","subtitler-project-v1"].contains(&data["format"].as_str().unwrap_or("")){return Err("Invalid Subtitler project".into())}
 Ok(json!({"path":actual.to_string_lossy(),"data":data}))
}
pub fn write(path:&Path,data:&str)->Result<bool,String>{
 if path.extension().and_then(|s|s.to_str())!=Some("subtitler"){return Err("Save as a .subtitler file".into())}
 if data.len()>50*1024*1024{return Err("Project exceeds 50 MB".into())}
 let value:Value=serde_json::from_str(data).map_err(|e|e.to_string())?;
 if !path.parent().map(|p|p.is_dir()).unwrap_or(false){return Err("Save folder is missing. Use File → Save As to choose its location.".into())}
 crate::audio_package::write(path,&value)

}
pub fn allocate(folder:&Path,name:&str)->Result<PathBuf,String>{
 fs::create_dir_all(folder).map_err(|e|e.to_string())?;
 let leaf:String=name.chars().take(100).map(|c|if c.is_control()||"/\\:*?\"<>|".contains(c){'_'}else{c}).collect();
 let leaf=leaf.trim().trim_end_matches(['.',' ']);let leaf=if leaf.is_empty(){"Transcript"}else{leaf};
 for n in 1..10000{let file=folder.join(if n==1{format!("{leaf}.subtitler")}else{format!("{leaf} ({n}).subtitler")});
 match fs::OpenOptions::new().write(true).create_new(true).open(&file){Ok(_)=>return Ok(file),Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,Err(e)=>return Err(e.to_string())}}
 Err("Choose another transcript name".into())
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn copies_save_only_to_the_opened_path(){let root=std::env::temp_dir().join(format!("sub-doc-{}",std::process::id()));fs::create_dir_all(&root).unwrap();let a=allocate(&root,"Test").unwrap();write(&a,"{\"id\":\"one\"}").unwrap();let b=allocate(&root,"Test").unwrap();write(&b,"{\"id\":\"two\"}").unwrap();assert_ne!(a,b);assert_eq!(crate::audio_package::read(&a).unwrap().project["id"],"one");assert!(!write(&b,"{\"id\":\"two\"}").unwrap());fs::remove_dir_all(root).unwrap();}
}
