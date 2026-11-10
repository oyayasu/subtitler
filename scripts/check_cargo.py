#!/usr/bin/env python3
"""Validate native code; repair only Cargo's explicit stale-lockfile error."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'src-tauri' / 'Cargo.toml'


def run(arguments):
    process = subprocess.Popen(arguments, cwd=ROOT, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    output = []
    for line in process.stdout:
        print(line, end='', flush=True)
        output.append(line)
    return process.wait(), ''.join(output)


def check(execute=run):
    base = ['cargo', 'check', '--manifest-path', str(MANIFEST)]
    code, output = execute(base + ['--locked'])
    if not code:
        return 0
    stale = ('cannot update the lock file' in output or
             'lock file needs to be updated' in output or
             'lockfile needs to be updated' in output or
             ('lock file' in output and 'needs to be updated' in output and '--locked' in output))
    if not stale:
        return code  # Never reinterpret a compiler error as a lockfile problem.
    lock = MANIFEST.with_name('Cargo.lock')
    backup = lock.with_name('Cargo.lock.before-repair')
    if lock.is_file() and not backup.exists():
        shutil.copy2(lock, backup)
    print('Refreshing Cargo.lock using cached dependencies first…', flush=True)
    code, output = execute(base + ['--offline'])
    cache_missing = any(text in output for text in (
        'no matching package named', 'attempting to make an HTTP request',
        'failed to download', 'no matching version',
    ))
    if code and cache_missing:
        print('A required dependency is not cached. Downloading it…', flush=True)
        code, output = execute(base)
    if code:
        return code
    print('Verifying the repaired lockfile with --locked…', flush=True)
    code, _ = execute(base + ['--locked'])
    return code


if __name__ == '__main__':
    sys.exit(check())
