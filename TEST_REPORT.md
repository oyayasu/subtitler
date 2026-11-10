# Subtitler 0.8.1 validation

- 51 JavaScript core/regression tests passed, including explicit per-window event targets.
- 30 compiled production Rust document/filesystem/engine tests passed, including embedding, stale-cache fallback, original removal, interrupted checkpoints, ownership, publication guards, unchanged writes and worker cancellation.
- Separate compiled cross-process instance-lock test passed: concurrent process excluded, owner force-killed, immediate reopen/reacquisition succeeded.
- Seven Python alignment-worker tests passed without downloading speech models.
- Locked Apple Silicon Rust type-check passed with the supplied Cargo.lock; no compiler warnings remained.
- Browser document suite passed: text-first import/paste, audio/SRT, Clear/Undo, save/no-op, New-window routing, Save As isolation, linked external recording, central Match/final alignment, edit-only retiming, panel sizing, full-height layout, folder move and missing/embedded-audio opening.
- All production JavaScript and the Mac builder parse. Prebuilt Safari-compatible bundle and source hashes validated; identity/icons/version/lock consistency passed.

Reproduction: `npm test`, `python3 scripts/test_native_documents.py`, `python3 scripts/test_instance_lock.py`, `python3 tests/test_alignment_worker.py`; browser suite `tests/documents07-ui.mjs` supports PLAYWRIGHT_MODULE and TEST_BROWSER_PATH.

Limits: native Finder/LaunchServices double-click dispatch, WebKit document window close/quit behavior and rapid GUI relaunch require testing on macOS. Cross-process tests establish lock recovery, not the entire native event lifecycle. Full platform packaging/installation, Windows shell association, actual audio hardware and real speech-model jobs were not executed here. The user's existing transcript was inspected read-only and was not rewritten.
