#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Run this builder on your Apple Silicon Mac.'; exit 1; }
app_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$app_source"
if [[ -f "$HOME/.cargo/env" ]]; then source "$HOME/.cargo/env"; fi
python3 scripts/check_project.py
echo 'Checking Subtitler 0.8.1 native commands…'
bash scripts/generate_macos_icon.sh
python3 scripts/check_cargo.py
cargo tauri build --config src-tauri/tauri.macos.conf.json --bundles app,dmg
built_app="$app_source/src-tauri/target/release/bundle/macos/Subtitler.app"
ditto "$app_source/src-tauri/icons/document.icns" "$built_app/Contents/Resources/document.icns"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDocumentTypes:0:CFBundleTypeIconFile string document.icns' "$built_app/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Set :CFBundleDocumentTypes:0:CFBundleTypeIconFile document.icns' "$built_app/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$built_app"
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built_app/Contents/Info.plist")"
[[ "$app_version" == 0.8.1 ]] || { echo 'The built version is unexpected. Installation stopped.'; exit 1; }
installed_app='/Applications/Subtitler.app'
backup_parent="$HOME/Library/Application Support/Subtitler/App backups"
mkdir -p "$backup_parent"
previous_app="$backup_parent/Subtitler-$(date +%Y%m%d-%H%M%S).app"
need_admin=false
if [[ ! -w /Applications ]] || { [[ -e "$installed_app" ]] && [[ ! -w "$installed_app" ]]; }; then need_admin=true; fi
install_run(){ if "$need_admin"; then sudo "$@"; else "$@"; fi; }
if [[ -e "$installed_app" ]]; then install_run mv "$installed_app" "$previous_app"; fi
if ! install_run ditto "$built_app" "$installed_app"; then
  install_run rm -rf "$installed_app"
  if [[ -e "$previous_app" ]]; then install_run mv "$previous_app" "$installed_app"; fi
  echo 'Installation failed; the previous app has been restored.'
  exit 1
fi
registration_tool="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$registration_tool" ]]; then "$registration_tool" -f "$installed_app"; fi
open "$installed_app"
printf '\nInstalled and opened Subtitler 0.8.1. Existing tools, models and transcripts are retained.\n'
