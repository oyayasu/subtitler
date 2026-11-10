# Subtitler 0.8.1

This patch prioritizes `.subtitler` launch/reopen reliability, removal of duplicate blank startup windows and independent document-window closing. It also fixes older document audio embedding and serializes shared Storyboard Studio publication.

Portable documents from 0.8 remain supported: they preserve original audio bytes inside ordinary .subtitler files, including connected projects. Existing transcript/storage/tool/model preferences and application identity are retained.

- **PATCH_TESTING.md:** every patch change and how to test it.
- **WORKFLOW_MANUAL.md:** short practical rules.
- **AUDIT_REPORT.md / TEST_REPORT.md:** findings, evidence and limits.
- **PROJECT_FORMAT.md / TIMING_FORMAT.md:** document and handoff formats.

## Install on Apple Silicon macOS

Quit Subtitler, extract the source ZIP and run `bash BUILD_MACOS.sh` in this directory, or use the release's pasteable Terminal command. Rust 1.89+ and Tauri CLI are required. The builder checks the frontend and native commands with Cargo.lock, packages the app, backs up the previous installed app, refreshes its document association and installs into `/Applications/Subtitler.app`. No clickable .command launcher is used. Models and transcripts are retained.

The prebuilt frontend is included. JavaScript changes require `npm ci` and `npm run build:frontend`; the build validates its manifest. Tests: `npm test`, `python3 scripts/test_native_documents.py`, `python3 scripts/test_instance_lock.py`, `python3 tests/test_alignment_worker.py`. The browser suite is `tests/documents07-ui.mjs`.

Apple Silicon Rust type checks and automated browser/process/filesystem tests do not substitute for macOS Finder/LaunchServices, WebKit windows, audio hardware or actual speech-model testing.
