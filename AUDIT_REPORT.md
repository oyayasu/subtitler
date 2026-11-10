# Subtitler 0.8.1 startup and document audit

Priority: unreliable .subtitler double-click launching, temporary inability to reopen, extra blank windows and closing one window closing all. Application identifier remains local.filipe.whisperdesk. Storyboard Studio is updated separately; FolderExporter is unchanged.

## Confirmed findings

1. **Startup ownership depended on an age/PID record.** A stale or reused process record could block a fresh launch. Ownership now uses an OS-held file lock. A process crash or normal exit releases it immediately; the stale PID text is not treated as a live owner. A compiled cross-process test verifies exclusion and immediate reacquisition after force-killing the owner. Rust 1.89+ is now explicit.
2. **A secondary process could exit before macOS delivered its file-open URLs.** It now receives native open events and forwards their paths atomically to the primary process before exiting. Activation without a path focuses an existing window. Errors are surfaced rather than silently discarding the request.
3. **Default and requested startup windows competed.** Static default windows were removed. Requested documents own their dynamic windows; an untouched empty startup window is reused. File New remains a separate window. Failed window creation removes pending reservations, and a failed file open leaves a usable app/error rather than an invisible failed launch.
4. **Targeted native events still reached global frontend listeners.** In the pinned Tauri event implementation, an Any/global listener can receive targeted events. Native emit_to alone was insufficient. Close/Open/Menu/Rematch/Drop frontend listeners now register the explicit WebviewWindow target. Document closing only destroys its own window; Quit requests save/close from each. A failed save cancels the global quit state.
5. **Recording ownership could outlive a document's connection.** Window recording bindings now update when the active document changes. Switching a linked document to standalone work releases its old recording claim; a later rematch cannot be sent to that unrelated document because of an old binding.
6. **Older text-only saves could skip embedding.** An unchanged text snapshot no longer qualifies for the frontend no-op shortcut until its audio is embedded. Native packaging tries an accessible embedded cache, then the original; a stale missing cache path cannot mask a readable original. A successful repair returns an available cache path. Existing embedded bytes/checksums remain protected.
7. **Shared publication used a private lock only.** Studio Link timing publication now also acquires the common workflow lock used by Storyboard Studio/FolderExporter, before reading the identity/selection snapshot. A busy project preserves the previous valid handoff.
8. **The macOS installed association could remain stale.** The builder refreshes LaunchServices registration for the installed bundle and activates that app without deliberately spawning another copy. Existing bundle identity and file extension remain unchanged.

## Uploaded transcript

The supplied Macbook review transcript was readable and contained 23 cues and 154 source words in a valid checkpoint. It contained no embedded recording. The extra empty window did not establish corruption. Missing audio that was never embedded still requires importing/locating an available recording; the app cannot reconstruct nonexistent bytes.

Native Apple Silicon type checking, cross-process lock recovery, document/filesystem tests, scoped-event tests and browser regressions were run. Native Finder/LaunchServices timing, actual WebKit multi-window closing and OS installation must still be confirmed on the Mac. No claim is made that browser simulations prove those platform event-delivery paths. See TEST_REPORT.md and PATCH_TESTING.md.
