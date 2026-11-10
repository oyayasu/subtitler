# Build the complete Windows 10 x64 application using the original Tauri frontend.
# Run in PowerShell on Windows 10 or 11 with Rust, Node.js and MSVC tools.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Install the Rust MSVC toolchain first: https://rustup.rs/' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20 or later first.' }
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
Write-Host 'EXE installers:'
Get-ChildItem 'src-tauri/target/release/bundle/nsis/*-setup.exe' | Select-Object FullName
