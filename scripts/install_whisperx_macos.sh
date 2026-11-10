#!/bin/bash
set -euo pipefail
# A separate optional environment; existing whisper-cli and GGML models stay in place.
if ! command -v brew >/dev/null; then
  echo 'Homebrew is required. Install it from https://brew.sh then run this command again.' >&2
  exit 1
fi
wx_brew="$(brew --prefix)"
if [ ! -x "$wx_brew/opt/python@3.11/bin/python3.11" ]; then brew install python@3.11; fi
wx_python="$(brew --prefix python@3.11)/bin/python3.11"
wx_env="$HOME/Documents/Shared Whisper/WhisperX"
if [ ! -x "$wx_env/bin/python" ]; then "$wx_python" -m venv "$wx_env"; fi
"$wx_env/bin/python" -m pip install --upgrade pip
"$wx_env/bin/python" -m pip install 'whisperx==3.8.6' 'transformers==4.57.6' 'nltk==3.9.2'
"$wx_env/bin/python" "$(dirname "$0")/../python/align_words.py" --probe --output "$wx_env/subtitler-ready.json"
echo
echo 'WhisperX is ready. In Subtitler: Settings → Find shared tools → Save settings.'
printf 'Python location: %s\n' "$wx_env/bin/python"
echo 'The first alignment downloads a language-specific model. Later runs reuse it.'
