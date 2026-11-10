//! Shared with Storyboard Studio/FolderExporter while publishing Studio Link records.
use std::{fs,path::{Path,PathBuf},process::Command,time::Duration};
pub struct Guard(PathBuf);
impl Drop for Guard{fn drop(&mut self){let _=fs::remove_file(self.0.join("owner"));let _=fs::remove_dir(&self.0);}}
fn alive(pid:u32)->bool{
 #[cfg(unix)]{Command::new("kill").args(["-0",&pid.to_string()]).output().map(|r|r.status.success()).unwrap_or(true)}
 #[cfg(windows)]{Command::new("tasklist").args(["/FI",&format!("PID eq {pid}"),"/NH"]).output().map(|r|String::from_utf8_lossy(&r.stdout).contains(&pid.to_string())).unwrap_or(true)}
 #[cfg(not(any(unix,windows)))]{let _=pid;true}
}
pub fn acquire(root:&Path)->Result<Guard,String>{let path=root.join("Studio Link/.workflow.lock");for _ in 0..100{if fs::create_dir(&path).is_ok(){if let Err(e)=fs::write(path.join("owner"),std::process::id().to_string()){let _=fs::remove_dir(&path);return Err(e.to_string())}return Ok(Guard(path))}if let Some(pid)=fs::read_to_string(path.join("owner")).ok().and_then(|s|s.parse::<u32>().ok()){if !alive(pid){let _=fs::remove_file(path.join("owner"));let _=fs::remove_dir(&path);continue;}}std::thread::sleep(Duration::from_millis(20));}Err("Another app is updating this project's media. Finish that operation and try again. Existing timing was kept.".into())}
