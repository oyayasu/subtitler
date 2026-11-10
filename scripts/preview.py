#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
os.chdir(Path(__file__).resolve().parent.parent / 'src')
print('Subtitler preview: http://127.0.0.1:8746\nKeep this Terminal window open. Local Whisper inference requires the desktop app.')
ThreadingHTTPServer(('127.0.0.1',8746),SimpleHTTPRequestHandler).serve_forever()
