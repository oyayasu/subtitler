#!/usr/bin/env python3
"""Compatibility entry point for the complete native storage/document suite.

The document suite includes project_files, documents and engine tests as well as
all required audio-package, folder and lock modules. Keep one canonical harness.
"""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('test_native_documents.py')), run_name='__main__')
