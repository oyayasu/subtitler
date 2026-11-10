#!/usr/bin/env bash
# Generate the macOS icon from Subtitler icon.png.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS icon generation requires macOS (sips + iconutil)." >&2
  exit 1
fi
source_image="src-tauri/icons/icon.png"
output="src-tauri/icons/icon.icns"
test -s "$source_image"
tempdir="$(mktemp -d)"
trap 'rm -rf "$tempdir"' EXIT
iconset="$tempdir/Subtitler.iconset"
mkdir -p "$iconset"
make_png() {
  sips -s format png --resampleHeightWidthMax "$1" "$source_image" --out "$iconset/$2" >/dev/null
  sips --padToHeightWidth "$1" "$1" --padColor 000000 "$iconset/$2" >/dev/null
}
make_png 16 icon_16x16.png
make_png 32 icon_16x16@2x.png
make_png 32 icon_32x32.png
make_png 64 icon_32x32@2x.png
make_png 128 icon_128x128.png
make_png 256 icon_128x128@2x.png
make_png 256 icon_256x256.png
make_png 512 icon_256x256@2x.png
make_png 512 icon_512x512.png
make_png 1024 icon_512x512@2x.png
iconutil -c icns "$iconset" -o "$output"
test -s "$output"
printf 'Generated macOS icon: %s\n' "$output"
