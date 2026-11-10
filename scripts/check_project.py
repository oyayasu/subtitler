from pathlib import Path
import json,re,hashlib
root=Path(__file__).resolve().parent.parent
config=json.loads((root/'src-tauri/tauri.conf.json').read_text())
assert config['version']=='0.8.1'
assert config['identifier']=='local.filipe.whisperdesk'
assert config['productName']=='Subtitler'
assert config['app']['withGlobalTauri']
assert config['app']['security']['assetProtocol']['enable']
assert config['build']['frontendDist']=='../src'
for f in ['src/index.html','src/app.js','src/model.js','src/exports.js','src/db.js','src/styles.css','src/waveform.js','src/alignment.js','src/workflow.js','src/studio-link.js','src/assets/scissors-white.svg','src-tauri/src/project_files.rs','python/align_words.py','scripts/install_whisperx_macos.sh','src/assets/VT323-Regular.ttf','src/assets/OFL.txt','src/assets/scissors-icon.png','src/assets/scissors-cursor.svg','src/vendor/jszip.min.js','src/vendor/JSZip-LICENSE.md','src-tauri/icons/icon.png','src-tauri/src/main.rs','src-tauri/src/lib.rs','src-tauri/src/engine.rs','src-tauri/Cargo.lock','ROADMAP.md','TIMING_FORMAT.md']:
 assert (root/f).is_file(),f
lock=(root/'src-tauri/Cargo.lock').read_text()
assert 'name = "whisper-desk"\nversion = "0.8.1"' in lock
assert not list(root.rglob('*.command'))
assert not list(root.glob('*.deb'))
for f in (root/'src').glob('*.js'):
 for target in re.findall(r"from ['\"](\./[^'\"]+)['\"]",f.read_text()):assert (f.parent/target).is_file(),(f,target)
print('PASS: app identity, version, frontend imports, media protocol, Cargo lock, icons, bundled exporters, roadmap, no .command launchers.')

manifest=json.loads((root/'src/frontend-manifest.json').read_text())
for source,expected in manifest['sources'].items():assert hashlib.sha256((root/source).read_bytes()).hexdigest()==expected,'Rebuild the frontend bundle: '+source
assert hashlib.sha256((root/'src/app.bundle.js').read_bytes()).hexdigest()==manifest['bundleSha256'],'Frontend bundle hash mismatch'
index=(root/'src/index.html').read_text()
assert 'src="app.bundle.js"' in index and 'src="bootstrap.js"' in index
assert 'type="module"' not in index
assert 'async fn discover_tools()' in (root/'src-tauri/src/lib.rs').read_text()
print('PASS: prebuilt Safari-compatible bundle matches current sources, guarded startup and asynchronous tool discovery.')
