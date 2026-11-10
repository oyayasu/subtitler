# Subtitler 0.8.1 — patch testing list

The priority of this patch is reliable document launching and independent document windows. Portable audio and Storyboard Studio integration from 0.8 remain supported.

## Opening, reopening and multiple windows

1. Quit Subtitler completely, double-click a saved `.subtitler`, and verify its saved transcript opens in one document window. An initial empty startup window must be reused instead of left beside it.
2. Close the last window, then immediately reopen a document or the app. Repeat several times. There must be no stale PID-file delay requiring several seconds of waiting.
3. Force Quit, then reopen immediately. The operating system releases the startup lock, so a stale process record must not block reopening.
4. Open the app first, leave its new document untouched, then double-click an existing file. That empty window is reused. If you have already imported audio/text or edited it, the requested file opens separately.
5. Open two different documents. Close either one. Only that document closes; the other remains usable. File → New creates an additional independent empty window.
6. Use Save, Open, Import and Match timing with each window focused. Only the intended document responds. Drag audio into one window; the other must remain unchanged.
7. Open the same exact document path again. Focus its existing window rather than creating another writer. A different copied document path remains independent as before.
8. Quit with several documents open. All windows complete saves/close independently. If a save fails, the failure remains visible and the quit state is cancelled rather than discarding that document.
9. Open an unavailable/moved document path. A readable error asks you to open it manually; the app remains accessible. Opening the app while it already runs focuses an existing window instead of adding a blank one.
10. Build/install the update, then test Finder double-click again. The macOS installer refreshes the document association for the installed bundle and preserves the existing application identifier.

## Older files and embedded audio

11. Open an older JSON `.subtitler`: saved text/edits must appear even when its audio is missing. Import/locate the recording if needed, save and reopen.
12. Save an older document whose original audio is still readable. Even with no text changes, it must complete audio embedding rather than skip the save as unchanged.
13. A stale cached embedded-audio path must not prevent embedding an accessible original recording. Save and reopen after removing/moving the former original; playback uses the embedded audio.
14. Open an existing self-contained project with its original missing. Text, timings and playback remain available. Moving the dedicated Subtitler folder still updates known document paths safely.
15. A previously text-only document cannot recover audio that was never embedded and no longer exists elsewhere. It must show the transcript and offer manual audio import rather than pretending it recovered bytes.

## Storyboard Studio compatibility

16. Use Match timing with Subtitler from Storyboard Studio, including an explicitly selected external recording. Open/reuse its connected transcript without substituting another project-root recording.
17. With two windows open, request a rematch for one linked recording. Only its owning document responds. Another standalone/linked window must not start a competing job or change audio.
18. Save/retranscribe the same connected recording. Update its existing document and current handoff rather than creating another timing file on every run. Different recordings retain their own identities.
19. Save concurrently with Storyboard Studio organizing media. Shared publication uses the common project lock and keeps the previous valid handoff if the operation cannot acquire it safely.
20. Opening unrelated audio in a standalone window must not publish it to the most recently used Storyboard Studio project. Original audio files remain untouched.

## Existing controls to retest

21. Audio-only Transcribe automatically attempts word alignment. Failure keeps recognized text and offers Retry word timing.
22. Match timings appears centrally only with imported reference text and audio, then hides on successful matching/alignment. Spoken-word edits show one global Update word timings action without retranscription.
23. Clear reference / Undo and Clear transcript / Undo remain functional. Text-only documents retain imported reference separately from timed subtitles.
24. Waveform/editor resizing, fullscreen bottom space, save-location label, File menus, Save As independent copies and Move Subtitler folder remain functional.

## Build checks and limits

25. Build with Rust 1.89 or newer. Cargo.lock is supplied and native code is checked with locked dependencies before packaging. A stale-lock error is repaired specifically; actual compiler errors stop installation.
26. Native process tests cover lock exclusivity and immediate recovery after a killed process. JavaScript tests cover per-window event targets; browser regressions cover documents/audio handoff. Full Finder LaunchServices delivery, WebKit window lifecycle and rapid native GUI relaunch still require testing on the Mac.
27. The uploaded transcript was valid, with saved cues/words, but contained no embedded audio. It was not classified as corrupt merely because an extra empty window appeared. Speech-model accuracy still depends on Whisper/WhisperX and needs a real-audio test.
