# Timing JSON format version 1

`format` is `whisperdesk-timing-v1`; `schemaVersion` is 1. All numeric times are seconds relative to the original untrimmed recording. They are not video timecode frames.

- `projectId`: stable local Subtitler project identity.
- `studioProjectId`: linked Storyboard Studio project ID when available; `chapterIds` contains script-matched chapter IDs.
- `pauses`: independent `{id,start,end,label,method,markerId?,chapterId?}` intervals, separate from spoken words. `audio-level` identifies FFmpeg quiet-interval detection.
- `speakers`: optional label-to-display-name mapping. Words can carry `speaker` and alignment `language`.
- `source`: filename, duration, and optional original file size/modification timestamp. Optional `fingerprint` is a bounded content identity used with original paths to distinguish recordings and reject changed-source reuse; it is not a full-file cryptographic integrity hash. Optional `path` retains the original local audio file location; `relativePath` resolves from the chosen main project folder when available. No audio bytes are embedded.
- `language` and `recognition`: detected language, engine/model information, creation time.
- `words`: current editable words, with stable `id`, `cueId`, `text`, preceding `gap`, `start`, `end`, `timing`, and optional `originId`.
- `subtitles`: stable `id`, `start`, `end`, current `text`, and ordered `wordIds`.
- `originalWords`: untouched recognition words for future matching/review, even after current subtitles have been corrected or deleted.

`timing` is `whisper` for automatic recognition/alignment word timing, `estimated` for interpolation after editing/SRT intake or missing token information, and `manual` after deliberate timing edits. Automatic timing remains approximate. WhisperX-aligned words additionally have `alignmentEngine: "whisperx"` and optional `alignmentScore`. Unresolved words can include `alignmentIssue`; their existing `timing`, start and end remain unchanged. `recognition.alignment` stores the alignment version, language, date and result counts/issues. Keeping the existing `timing` enum preserves compatibility with earlier Storyboard Studio timing importers. Text beginning each subtitle ignores that first word’s preceding whitespace; later words use `gap` verbatim.

`originId` points to a recognition word where that identity is retained. Newly inserted/replaced words have no original recognition identity. Sentence and subtitle boundaries are separate from the original audio, which is never edited by text operations.

Exported `.subtitler` backups retain the separate legacy `whisperdesk-project-v1` internal format and are not intended as the video-editor handoff. Storyboard Studio Highlighter Test 0.6.0+ imports this timing format.

Studio Link keeps one current derived timing file per actual audio identity, independent of transient transcript project IDs. A new valid publication may retire superseded timing JSON for that same recording and Studio project. Editable .subtitler projects are never removed as part of this maintenance.
