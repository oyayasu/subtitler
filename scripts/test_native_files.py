#!/usr/bin/env python3
"""Test the real transcript storage and project-folder modules without GUI dependencies."""
from pathlib import Path
import tempfile,subprocess
root=Path(__file__).resolve().parents[1]/'src-tauri/src'
with tempfile.TemporaryDirectory(prefix='subtitler-native-') as folder:
 p=Path(folder);(p/'src').mkdir();(p/'Cargo.toml').write_text('[package]\nname="subtitler-native-test"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde_json="1"\n')
 modules=['audio_identity','project_files','documents','engine']
 for name in modules:(p/'src'/f'{name}.rs').write_text((root/f'{name}.rs').read_text())
 (p/'src/lib.rs').write_text('#![allow(dead_code)]\n'+''.join(f'mod {name};\n' for name in modules));subprocess.run(['cargo','test','--lib','--manifest-path',str(p/'Cargo.toml')],check=True)
