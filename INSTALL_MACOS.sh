#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'This package is for an Apple Silicon Mac.'; exit 1; }
package_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app="$package_dir/Subtitler.app"
[[ -d "$app" ]] || { echo 'Keep this installer beside Subtitler.app in the extracted package.'; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == local.filipe.whisperdesk ]] || { echo 'This is not the expected Subtitler application.'; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == 0.8.3 ]] || { echo 'This is not Subtitler 0.8.3.'; exit 1; }
/usr/bin/codesign --verify --deep --strict "$app"
binary="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
if pgrep -x "$binary" >/dev/null || pgrep -x Subtitler >/dev/null; then echo 'Quit Subtitler first, then run this command again. Saved documents are not changed by installation.'; exit 1; fi
destination='/Applications/Subtitler.app'
backups="$HOME/Library/Application Support/Subtitler/App backups"
mkdir -p "$backups"
previous="$backups/Subtitler-before-0.8.3-$(date +%Y%m%d-%H%M%S).app"
need_admin=false
if [[ ! -w /Applications ]] || { [[ -e "$destination" ]] && [[ ! -w "$destination" ]]; }; then need_admin=true; fi
install_run(){ if "$need_admin"; then sudo "$@"; else "$@"; fi; }
if [[ -e "$destination" ]]; then install_run mv "$destination" "$previous"; fi
if ! install_run ditto "$app" "$destination"; then
  install_run rm -rf "$destination"
  if [[ -e "$previous" ]]; then install_run mv "$previous" "$destination"; fi
  echo 'Installation failed. The previous application has been restored.'
  exit 1
fi
# This personal build is ad-hoc signed and verified above, rather than notarized.
install_run xattr -dr com.apple.quarantine "$destination" 2>/dev/null || true
registration='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if [[ -x "$registration" ]]; then "$registration" -f "$destination"; fi
open "$destination"
echo 'Installed Subtitler 0.8.3. Existing transcripts, audio, settings and models were retained.'
