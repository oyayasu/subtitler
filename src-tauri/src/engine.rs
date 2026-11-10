use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
pub type Progress = Arc<dyn Fn(String) + Send + Sync>;
pub fn run_process(
    binary: &Path,
    args: &[String],
    cancel: &AtomicBool,
    progress: Progress,
    metal: bool,
) -> Result<(), String> {
    run_process_timeout(binary, args, cancel, progress, metal, None)
}
pub fn run_process_timeout(
    binary: &Path, args: &[String], cancel: &AtomicBool,
    progress: Progress, metal: bool, timeout: Option<Duration>,
) -> Result<(), String> {
    run_process_env_timeout(binary,args,cancel,progress,metal,timeout,None)
}
pub fn run_process_env_timeout(
    binary: &Path, args: &[String], cancel: &AtomicBool,
    progress: Progress, metal: bool, timeout: Option<Duration>, extra_env:Option<(&str,&str)>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if metal {
        command.env("GGML_METAL_BF16_DISABLE", "1");
    }
    if let Some((key,value))=extra_env { command.env(key,value); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run {}: {e}", binary.display()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not read transcription progress")?;
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let log2 = log.clone();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = line.chars().take(2000).collect::<String>();
            if let Ok(mut logs) = log2.lock() {
                logs.push(line.clone());
                if logs.len() > 16 {
                    logs.remove(0);
                }
            }
            progress(line);
        }
    });
    loop {
        let timed_out = timeout.map(|limit| started.elapsed() >= limit).unwrap_or(false);
        if timed_out || cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(if timed_out { "WhisperX check timed out. Retry after the Python environment finishes loading.".into() } else { "Cancelled".into() });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = reader.join();
                if status.success() {
                    return Ok(());
                }
                let details = log.lock().map(|v| v.join("\n")).unwrap_or_default();
                return Err(format!(
                    "{} exited with {status}.\n{details}",
                    binary.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(60)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(e.to_string());
            }
        }
    }
}
pub fn audio_args(source: &Path, target: &Path) -> Vec<String> {
    [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &source.to_string_lossy(),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-map_metadata",
        "-1",
        &target.to_string_lossy(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
pub fn whisper_args(
    model: &Path,
    audio: &Path,
    prefix: &Path,
    language: &str,
    threads: u32,
) -> Result<Vec<String>, String> {
    if !["auto", "en", "pt", "es", "ja"].contains(&language) {
        return Err("Choose Auto, English, Portuguese, Spanish, or Japanese".into());
    }
    Ok(vec![
        "-m".into(),
        model.to_string_lossy().into_owned(),
        "-f".into(),
        audio.to_string_lossy().into_owned(),
        "-l".into(),
        language.into(),
        "-t".into(),
        threads.clamp(1, 16).to_string(),
        "-ojf".into(),
        "-pp".into(),
        "-of".into(),
        prefix.to_string_lossy().into_owned(),
    ])
}
pub fn job_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid job identity".into());
    }
    Ok(root.join(id))
}
pub fn wav_duration(path: &Path) -> Result<f64, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 12];
    f.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("Invalid playback WAV".into());
    }
    let mut rate = 0u32;
    let mut size = 0u32;
    loop {
        let mut chunk = [0u8; 8];
        if f.read_exact(&mut chunk).is_err() {
            break;
        }
        let n = u32::from_le_bytes(chunk[4..8].try_into().unwrap());
        if &chunk[..4] == b"fmt " && n >= 16 {
            let mut fmt = [0u8; 16];
            f.read_exact(&mut fmt).map_err(|e| e.to_string())?;
            rate = u32::from_le_bytes(fmt[8..12].try_into().unwrap());
            f.seek(SeekFrom::Current((n - 16 + (n % 2)) as i64))
                .map_err(|e| e.to_string())?;
        } else if &chunk[..4] == b"data" {
            size = n;
            break;
        } else {
            f.seek(SeekFrom::Current((n + (n % 2)) as i64))
                .map_err(|e| e.to_string())?;
        }
    }
    if rate == 0 || size == 0 {
        return Err("The audio has no playable samples".into());
    }
    Ok(size as f64 / rate as f64)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_job_names() {
        assert!(job_path(Path::new("/tmp"), "../escape").is_err());
        assert!(job_path(Path::new("/tmp"), "x/y").is_err());
        assert!(job_path(Path::new("/tmp"), "123-abc").is_ok());
    }
    #[test]
    fn args_preserve_audio_and_detailed_timing() {
        let a = audio_args(Path::new("/original file.wav"), Path::new("/cache.wav"));
        assert!(!a.iter().any(|v| v.contains("silence")));
        assert!(a.windows(2).any(|a| a == ["-ar", "16000"]));
        let w = whisper_args(
            Path::new("/model.bin"),
            Path::new("/cache.wav"),
            Path::new("/out"),
            "pt",
            8,
        )
        .unwrap();
        assert!(w.contains(&"-ojf".into()));
        assert!(!w.contains(&"-tr".into()));
        assert!(whisper_args(Path::new("x"), Path::new("x"), Path::new("x"), "--bad", 8).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn process_success_failure_and_cancellation() {
        let c = AtomicBool::new(false);
        assert!(run_process(Path::new("/bin/true"), &[], &c, Arc::new(|_| {}), false).is_ok());
        assert!(run_process(Path::new("/bin/false"), &[], &c, Arc::new(|_| {}), false).is_err());
        let c = Arc::new(AtomicBool::new(false));
        let other = c.clone();
        let handle = thread::spawn(move || {
            run_process(
                Path::new("/bin/sleep"),
                &["10".into()],
                &other,
                Arc::new(|_| {}),
                false,
            )
        });
        thread::sleep(Duration::from_millis(100));
        c.store(true, Ordering::SeqCst);
        assert_eq!(handle.join().unwrap().unwrap_err(), "Cancelled");
    }
    #[cfg(unix)]
    #[test]
    fn a_probe_timeout_terminates_the_child() {
        let started = std::time::Instant::now();
        let result = run_process_timeout(Path::new("/bin/sleep"), &["5".into()],
            &AtomicBool::new(false), Arc::new(|_| {}), false, Some(Duration::from_millis(30)));
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn wav_duration_and_real_conversion_preserve_the_source() {
        let root = std::env::temp_dir().join(format!(
            "whisper-desk-audio-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("original audio.wav");
        let target = root.join("playback.wav");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&32036u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16000u32.to_le_bytes());
        bytes.extend_from_slice(&32000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&32000u32.to_le_bytes());
        bytes.resize(32044, 0);
        fs::write(&source, &bytes).unwrap();
        assert_eq!(wav_duration(&source).unwrap(), 1.0);
        if let Ok(binary) = std::env::var("FFMPEG_BINARY") {
            run_process(
                Path::new(&binary),
                &audio_args(&source, &target),
                &AtomicBool::new(false),
                Arc::new(|_| {}),
                false,
            )
            .unwrap();
            assert_eq!(wav_duration(&target).unwrap(), 1.0);
            assert_eq!(fs::read(&source).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
