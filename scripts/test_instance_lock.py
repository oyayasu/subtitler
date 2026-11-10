"""Exercise the production lock across processes, including an abrupt termination."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as td:
 p=Path(td);source=p/'main.rs';source.write_text('#[path='+repr(str(root/'src-tauri/src/instance_guard.rs')).replace("'",'"')+'] mod guard;\nfn main(){let args:Vec<String>=std::env::args().collect();match guard::acquire(std::path::Path::new(&args[1])).unwrap(){Some(_lock)=>{println!("locked");if args.len()>2{std::thread::sleep(std::time::Duration::from_secs(30));}},None=>println!("busy")}}')
 subprocess.run([os.environ.get('RUSTC','rustc'),str(source),'-o',str(p/'probe')],check=True)
 lock=p/'lock';lock.write_text('stale PID from a previous app')
 first=subprocess.Popen([str(p/'probe'),str(lock),'hold'],stdout=subprocess.PIPE,text=True)
 try:
  assert first.stdout.readline().strip()=='locked'
  assert subprocess.check_output([str(p/'probe'),str(lock)],text=True).strip()=='busy'
 finally:first.kill();first.wait()
 assert subprocess.check_output([str(p/'probe'),str(lock)],text=True).strip()=='locked'
 print('PASS: no stale-PID wait; concurrent launches excluded; crash releases lock immediately.')
