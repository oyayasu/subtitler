from pathlib import Path
import tempfile,subprocess,json
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='subtitler-native-') as td:
 p=Path(td);(p/'src').mkdir()
 (p/'Cargo.toml').write_text('[package]\nname="subtitler-native-tests"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nbase64="0.22"\n')
 source='#![allow(dead_code)]\n'
 for name in ['project_lock','instance_guard','audio_identity','audio_package','library_folder','documents','project_files','engine']:source+=f'#[path={json.dumps(str(root/"src-tauri/src"/(name+".rs")))}] mod {name};\n'
 source+=f'#[cfg(test)] #[path={json.dumps(str(root/"tests/native_document_tests.rs"))}] mod document_tests;\n'
 (p/'src/lib.rs').write_text(source)
 subprocess.run(['cargo','test','--lib','--manifest-path',str(p/'Cargo.toml')],check=True)
