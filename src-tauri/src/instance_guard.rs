//! The operating system releases this lock even after a crash or forced quit.
use std::{fs::{File,OpenOptions},io::Write,path::Path};
pub fn acquire(path:&Path)->Result<Option<File>,String>{
 let mut file=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e|e.to_string())?;
 match file.try_lock(){
  Ok(())=>{file.set_len(0).map_err(|e|e.to_string())?;write!(file,"{}",std::process::id()).map_err(|e|e.to_string())?;Ok(Some(file))},
  Err(std::fs::TryLockError::WouldBlock)=>Ok(None),
  Err(std::fs::TryLockError::Error(e))=>Err(e.to_string())
 }
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn no_age_delay_and_no_pid_reuse(){let p=std::env::temp_dir().join(format!("sub-lock-{}",std::process::id()));std::fs::write(&p,b"invalid or stale pid").unwrap();let first=acquire(&p).unwrap().unwrap();assert!(acquire(&p).unwrap().is_none());drop(first);assert!(acquire(&p).unwrap().is_some());std::fs::remove_file(p).unwrap();}
}
