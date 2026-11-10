# Build the original Subtitler for Windows 10 x64.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust MSVC toolchain is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is required.' }
python scripts/check_project.py
if ($LASTEXITCODE -ne 0) { throw 'Project validation failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
npm run build:frontend
if ($LASTEXITCODE -ne 0) { throw 'Frontend compilation failed.' }
npm install --no-save '@tauri-apps/cli@^2'
if ($LASTEXITCODE -ne 0) { throw 'Tauri CLI install failed.' }
npx tauri build --config src-tauri/tauri.windows.conf.json --bundles nsis
if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
Get-ChildItem 'src-tauri/target/release/bundle/nsis/*-setup.exe' | Select-Object FullName
