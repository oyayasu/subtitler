//! Portable audio plus append-only, checksummed project checkpoints.
use serde_json::{json, Value};
use std::{fs, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}};
const MAGIC: &[u8;8] = b"SUBAUD2\n";
const END: &[u8;8] = b"SUBJSON2";
const MAX_JSON:u64=50*1024*1024;
fn err(e:impl std::fmt::Display)->String{e.to_string()}
fn hash(bytes:&[u8])->u64{bytes.iter().fold(14695981039346656037,|h,b|(h ^ *b as u64).wrapping_mul(1099511628211))}
fn copy_hash(input:&mut impl Read,output:&mut impl Write,length:u64)->Result<u64,String>{
 let mut left=length;let mut h=14695981039346656037u64;let mut buf=[0u8;65536];
 while left>0{let n=input.read(&mut buf[..left.min(65536) as usize]).map_err(err)?;if n==0{return Err("Embedded audio is incomplete. The previous project was kept.".into());}output.write_all(&buf[..n]).map_err(err)?;for b in &buf[..n]{h=(h ^ *b as u64).wrapping_mul(1099511628211);}left-=n as u64;}Ok(h)
}
pub struct Document{pub project:Value,pub audio:Value,audio_end:u64,valid_end:u64}
pub fn read(path:&Path)->Result<Document,String>{
 let mut f=fs::File::open(path).map_err(|_|"Project not found. Use File → Open to select its current location.".to_string())?;let size=f.metadata().map_err(err)?.len();let mut header=[0u8;16];
 if f.read_exact(&mut header).is_err()||&header[..8]!=MAGIC{if size>MAX_JSON{return Err("Legacy project exceeds 50 MB".into());}f.seek(SeekFrom::Start(0)).map_err(err)?;let mut text=String::new();f.read_to_string(&mut text).map_err(err)?;let project=serde_json::from_str(&text).map_err(|e|format!("The project cannot be read: {e}"))?;return Ok(Document{project,audio:Value::Null,audio_end:0,valid_end:size});}
 let length=u64::from_le_bytes(header[8..16].try_into().unwrap());let audio_end=16u64.checked_add(length).filter(|n|*n<=size).ok_or("Embedded audio is incomplete")?;let tail_start=audio_end.max(size.saturating_sub(MAX_JSON*2+48));f.seek(SeekFrom::Start(tail_start)).map_err(err)?;let mut tail=Vec::new();f.read_to_end(&mut tail).map_err(err)?;
 for at in (16..tail.len().saturating_sub(7)).rev(){if &tail[at..at+8]!=END{continue;}let len=u64::from_le_bytes(tail[at-16..at-8].try_into().unwrap());if len>MAX_JSON||len>at as u64-16{continue;}let start=at-16-len as usize;let bytes=&tail[start..at-16];if hash(bytes)!=u64::from_le_bytes(tail[at-8..at].try_into().unwrap()){continue;}if let Ok(v)=serde_json::from_slice::<Value>(bytes){if v["format"]=="subtitler-container-v2"&&v["audio"]["length"].as_u64().unwrap_or(0)==length{return Ok(Document{project:v["project"].clone(),audio:v["audio"].clone(),audio_end,valid_end:tail_start+at as u64+8});}}}
 Err("No complete project checkpoint was found. The file was not changed.".into())
}
fn checkpoint(f:&mut fs::File,project:&Value,audio:&Value)->Result<(),String>{let bytes=serde_json::to_vec(&json!({"format":"subtitler-container-v2","project":project,"audio":audio})).map_err(err)?;if bytes.len() as u64>MAX_JSON{return Err("Project text exceeds 50 MB".into());}f.write_all(&bytes).and_then(|_|f.write_all(&(bytes.len() as u64).to_le_bytes())).and_then(|_|f.write_all(&hash(&bytes).to_le_bytes())).and_then(|_|f.write_all(END)).and_then(|_|f.sync_all()).map_err(err)}
fn stamp()->u128{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()}
pub fn replace(temp:&Path,target:&Path)->Result<(),String>{if cfg!(windows)&&target.exists(){let old=target.with_extension(format!("subtitler-old-{}",stamp()));fs::rename(target,&old).map_err(err)?;if let Err(e)=fs::rename(temp,target){let _=fs::rename(&old,target);return Err(err(e));}let _=fs::remove_file(old);}else{fs::rename(temp,target).map_err(err)?;}Ok(())}
pub fn write(path:&Path,raw:&Value)->Result<bool,String>{
 let mut project=raw.clone();if let Some(s)=project["source"].as_object_mut(){s.remove("embeddedPath");}
 let old=if path.is_file()&&fs::metadata(path).map_err(err)?.len()>0{Some(read(path)?)}else{None};let expected=project["source"]["fingerprint"].as_str();let reuse=old.as_ref().filter(|d|d.audio_end>16&&d.audio["fingerprint"].as_str()==expected&&expected.is_some());
 if let Some(d)=reuse{if d.project==project{return Ok(false);}if d.valid_end-d.audio_end<(32*1024*1024).max(serde_json::to_vec(&project).map_err(err)?.len() as u64*8){let mut f=fs::OpenOptions::new().write(true).open(path).map_err(err)?;f.set_len(d.valid_end).map_err(err)?;f.seek(SeekFrom::End(0)).map_err(err)?;checkpoint(&mut f,&project,&d.audio)?;return Ok(true);}}
 let source=[raw["source"]["embeddedPath"].as_str(),raw["source"]["path"].as_str()].into_iter().flatten().map(PathBuf::from).find(|p|p.is_file());
 let(mut input,length,name,fingerprint,verify)=if let Some(d)=reuse{let mut f=fs::File::open(path).map_err(err)?;f.seek(SeekFrom::Start(16)).map_err(err)?;(Some(f),d.audio_end-16,d.audio["name"].as_str().unwrap_or("Audio.wav").to_owned(),d.audio["fingerprint"].clone(),d.audio["hash"].as_u64())}else if let Some(p)=source{let info=crate::audio_identity::info(&p)?;if expected.is_some()&&project["source"]["fingerprint"]!=info["fingerprint"]{return Err("Audio changed. Attach the intended recording before saving its copy.".into());}(Some(fs::File::open(&p).map_err(err)?),fs::metadata(&p).map_err(err)?.len(),raw["source"]["name"].as_str().unwrap_or("Audio.wav").to_owned(),info["fingerprint"].clone(),None)}else{if old.as_ref().is_some_and(|d|d.audio_end>16){return Err("The new recording is unavailable. Existing embedded audio was kept.".into());}(None,0,String::new(),Value::Null,None)};
 if old.as_ref().is_some_and(|d|d.audio_end<=16&&d.project==project)&&length==0{return Ok(false);}
 let temp=path.with_extension(format!("subtitler-saving-{}",stamp()));let result=(||{let mut out=fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(err)?;out.write_all(MAGIC).and_then(|_|out.write_all(&length.to_le_bytes())).map_err(err)?;let digest=if let Some(ref mut input)=input{copy_hash(input,&mut out,length)?}else{hash(&[])};if verify.is_some_and(|v|v!=digest){return Err("Embedded audio failed integrity verification. Existing project was kept.".into());}let audio=if length>0{json!({"name":name,"length":length,"hash":digest,"fingerprint":fingerprint})}else{Value::Null};checkpoint(&mut out,&project,&audio)?;drop(out);replace(&temp,path)?;Ok(true)})();if result.is_err(){let _=fs::remove_file(temp);}result
}
// Some removable filesystems (including exFAT) do not implement hard links.
// Exclusive creation retains no-clobber protection on those filesystems.
fn copy_exclusive(source:&Path,destination:&Path)->Result<(),String>{
 let mut out=fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(err)?;
 let result=(||{let mut input=fs::File::open(source).map_err(err)?;std::io::copy(&mut input,&mut out).map_err(err)?;out.sync_all().map_err(err)})();
 drop(out);if result.is_err(){let _=fs::remove_file(destination);}result
}
pub fn extract(path:&Path,destination:&Path,expected:Option<&str>)->Result<PathBuf,String>{
 let d=read(path)?;if d.audio_end<=16{return Err("This project has no embedded audio. Locate the original recording instead.".into());}if expected.is_some_and(|v|Some(v)!=d.audio["fingerprint"].as_str()){return Err("This Subtitler project contains a different recording.".into());}
 let mut input=fs::File::open(path).map_err(err)?;input.seek(SeekFrom::Start(16)).map_err(err)?;
 if destination.exists(){let digest=copy_hash(&mut fs::File::open(destination).map_err(err)?,&mut std::io::sink(),fs::metadata(destination).map_err(err)?.len())?;if fs::metadata(destination).map_err(err)?.len()==d.audio_end-16&&Some(digest)==d.audio["hash"].as_u64(){return Ok(destination.to_path_buf());}return Err("A different file already uses this audio location. Choose another destination.".into());}
 let temp=destination.with_extension(format!("audio-recovering-{}",stamp()));let result=(||{let mut out=fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(err)?;let digest=copy_hash(&mut input,&mut out,d.audio_end-16)?;if Some(digest)!=d.audio["hash"].as_u64(){return Err("Embedded audio is damaged. Locate the original recording instead.".into());}out.sync_all().map_err(err)?;drop(out);if fs::hard_link(&temp,destination).is_err(){copy_exclusive(&temp,destination)?;}fs::remove_file(&temp).map_err(err)?;Ok(destination.to_path_buf())})();if result.is_err(){let _=fs::remove_file(&temp);}result
}
pub fn cached_audio(path:&Path,cache:&Path)->Result<Option<PathBuf>,String>{let d=read(path)?;if d.audio_end<=16{return Ok(None);}fs::create_dir_all(cache).map_err(err)?;let ext=Path::new(d.audio["name"].as_str().unwrap_or("audio.wav")).extension().and_then(|s|s.to_str()).filter(|s|s.len()<8&&s.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("wav");let target=cache.join(format!("{}-{}.{}",d.audio_end-16,d.audio["hash"].as_u64().unwrap_or(0),ext));extract(path,&target,d.audio["fingerprint"].as_str()).map(Some)}

#[cfg(test)]mod install_tests{use super::*;
 #[test]fn exclusive_copy_fallback_preserves_an_existing_destination(){let root=std::env::temp_dir().join(format!("sub-audio-install-{}-{}",std::process::id(),stamp()));fs::create_dir_all(&root).unwrap();let source=root.join("source");let dest=root.join("dest");fs::write(&source,b"audio").unwrap();copy_exclusive(&source,&dest).unwrap();fs::write(&source,b"changed").unwrap();assert!(copy_exclusive(&source,&dest).is_err());assert_eq!(fs::read(dest).unwrap(),b"audio");fs::remove_dir_all(root).unwrap();}
}
