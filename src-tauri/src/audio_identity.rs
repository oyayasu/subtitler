use std::{fs,io::{Read,Seek,SeekFrom},path::Path,time::UNIX_EPOCH};
use serde_json::{Value,json};
pub fn info(path:&Path)->Result<Value,String>{
    let path=path.canonicalize().map_err(|e|e.to_string())?;
    let m=fs::metadata(&path).map_err(|e|e.to_string())?;
    if !m.is_file(){return Err("Choose an audio file".into())}
    // Bounded content fingerprint: stable across moves/names, inexpensive for long recordings.
    let mut f=fs::File::open(&path).map_err(|e|e.to_string())?;
    let mut hash=14695981039346656037u64;
    let mut feed=|data:&[u8]|{for b in data{hash^=*b as u64;hash=hash.wrapping_mul(1099511628211);}};
    feed(&m.len().to_le_bytes());
    for at in [0,m.len()/2,m.len().saturating_sub(65536)]{
        f.seek(SeekFrom::Start(at)).map_err(|e|e.to_string())?;
        let mut bytes=vec![0;65536];let n=f.read(&mut bytes).map_err(|e|e.to_string())?;feed(&bytes[..n]);
    }
    Ok(json!({"path":path.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":m.len(),"modified":m.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_millis()as u64),"fingerprint":format!("audio-v1-{}-{hash:016x}",m.len())}))
}
pub fn supported(path:&Path)->bool{["wav","mp3","m4a","aac","flac","ogg","opus","aiff","aif","wma"].contains(&path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase().as_str())}
