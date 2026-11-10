"""Subtitler's optional WhisperX alignment worker; alignment and optional speaker labeling.

Called by the native worker with explicit file paths, never via a shell.
Only output timings are proposed. The frontend validates and commits them.
"""
import argparse
import importlib.metadata
import json
import math
from pathlib import Path
import sys
import unicodedata
import wave
sys.path.insert(0, str(Path(__file__).resolve().parent))
from spoken_numbers import spoken_form

LANGUAGES = {"en", "pt", "es", "ja"}
VERSION = "3.8.6"


def progress(text):
    print("SUBTITLER " + text, file=sys.stderr, flush=True)


def backend():
    installed = importlib.metadata.version("whisperx")
    if installed != VERSION:
        raise RuntimeError(f"This app expects WhisperX {VERSION}; found {installed}. Run the supplied setup command.")
    from whisperx.alignment import align, load_align_model
    import numpy as np
    import torch
    return align, load_align_model, np, torch


def clean(text):
    # One sentence for char-index mapping. Display text is never changed.
    return "".join(c for c in unicodedata.normalize("NFC", text)
                   if c==" " or unicodedata.category(c)[0] in "LMN")


def alignment_text(words, language):
    text, spans = "", []
    for word in words:
        body = clean(spoken_form(word["text"], language))
        if text and body and language != "ja":
            text += " "
        start = len(text)
        text += body
        spans.append((start, len(text)))
    return text, spans


def extract_words(text, spans, result, words, offset, duration, dictionary):
    chars = [char for seg in result.get("segments", []) for char in (seg.get("chars") or [])]
    if "".join(c.get("char", "") for c in chars) != text:
        return [{"id": w["id"], "status": "unaligned"} for w in words]
    output = []
    for w, (a, b) in zip(words, spans):
        entry = {"id": w["id"], "status": "unaligned"}
        part = [c for c in chars[a:b] if not c.get("char", "").isspace()]
        # Unknown dictionary characters (notably numerals) are not reported as
        # reliable merely because the aligner supplies an inferred timestamp.
        if part and all(c["char"].lower() in dictionary for c in part):
            valid = all(isinstance(c.get("start"), (int, float)) and
                        isinstance(c.get("end"), (int, float)) and
                        math.isfinite(c["start"]) and math.isfinite(c["end"]) and
                        c["start"] >= 0 and c["end"] > c["start"] for c in part)
            if valid:
                start, end = part[0]["start"] + offset, part[-1]["end"] + offset
                score = sum(c.get("score", 0) for c in part) / len(part)
                if start >= 0 and end <= duration + .001 and end > start and math.isfinite(score) and score >= .1:
                    entry.update(status="aligned", start=round(start, 6), end=round(end, 6), score=round(score, 4))
        output.append(entry)
    return output


def word_language(word, fallback):
    text = word["text"]
    if any("\u3040" <= c <= "\u30ff" or "\u3400" <= c <= "\u9fff" for c in text):
        return "ja"
    return fallback if fallback != "ja" else "en"


def alignment_groups(cues, language, mixed=True, fallback="en"):
    """Align neighboring captions jointly; their existing division is never changed."""
    groups = []
    for ci, cue in enumerate(cues):
        explicit = cue.get("language")
        for wi, word in enumerate(cue["words"]):
            lang = explicit if explicit in LANGUAGES else word_language(word, fallback) if language == "auto" and mixed else fallback if language == "auto" else language
            start = float(word.get("start", cue["start"]))
            end = float(word.get("end", cue["end"]))
            prior = groups[-1] if groups else None
            if (prior and prior["language"] == lang and
                    end - prior["start"] <= 20 and start - prior["end"] <= 1.2 and
                    sum(len(w["text"]) for w in prior["words"]) + len(word["text"]) < 1800):
                prior["words"].append(word)
                prior["locations"].append((ci, wi))
                prior["end"] = max(prior["end"], end)
            else:
                groups.append({"language": lang, "start": start, "end": end,
                               "words": [word], "locations": [(ci, wi)]})
    return groups


def label_speakers(result, audio, request):
    import os
    count = int(request.get("speakers", 1))
    if count == 1:
        for cue in result["cues"]:
            for word in cue["words"]:
                word["speaker"] = "Speaker 1"
        return
    if not 0 <= count <= 20:
        raise ValueError("Choose 0 to detect speakers, or a count from 1 to 20.")
    try:
        from whisperx.diarize import DiarizationPipeline
        from huggingface_hub import get_token
        token = os.environ.get("WHISPERX_HF_TOKEN") or get_token()
        if not token:
            raise RuntimeError("Accept the pyannote speaker model terms and add a Hugging Face read token in Transcription options.")
        progress("Detecting speakers (first use may download the speaker model)…")
        pipeline = DiarizationPipeline(token=token, device="cpu")
        segments = pipeline(str(audio), num_speakers=count or None)
        labels = {}
        intervals = [(float(row.start), float(row.end), str(row.speaker)) for row in segments.itertuples()]
        for cue in result["cues"]:
            for word in cue["words"]:
                if "start" not in word:
                    continue
                candidates = [(max(0., min(b, word["end"]) - max(a, word["start"])), speaker)
                              for a, b, speaker in intervals]
                overlap, speaker = max(candidates, default=(0., None))
                if overlap > 0:
                    if speaker not in labels:
                        labels[speaker] = "Speaker " + str(len(labels) + 1)
                    word["speaker"] = labels[speaker]
        result["speakers"] = list(labels.values())
    except Exception as e:
        # Speaker failure must not discard successful transcript alignment.
        message = str(e)
        token = os.environ.get("WHISPERX_HF_TOKEN")
        if token:
            message = message.replace(token, "[token]")
        result.setdefault("warnings", []).append("Speaker labeling could not finish. " + message[:500])


def run(request, audio, align, load_model, np, torch):
    language = request.get("language")
    if language not in LANGUAGES | {"auto"}:
        raise ValueError("Select automatic, English, Portuguese, Spanish or Japanese alignment.")
    cues = request.get("cues")
    if not isinstance(cues, list) or not 0 < len(cues) <= 50000:
        raise ValueError("No subtitle blocks to align.")
    torch.set_num_threads(max(1, min(16, int(request.get("threads", 6)))))
    cache = Path.home() / "Documents" / "Shared Whisper" / "Alignment Models"
    cache.mkdir(parents=True, exist_ok=True)
    result = {"format": "subtitler-alignment-v1", "engine": "WhisperX", "version": VERSION,
              "language": language, "cues": [], "warnings": []}
    for cue in cues:
        result["cues"].append({"id": cue["id"], "words": [{"id": w["id"], "status": "unaligned"} for w in cue["words"]]})
    fallback = request.get("fallbackLanguage", "en")
    if fallback not in LANGUAGES:
        fallback = "en"
    groups = alignment_groups(cues, language, request.get("mixedLanguages", True), fallback)
    # One loaded alignment model at a time keeps mixed-language recordings bounded on M1.
    current_language = None
    model, metadata = None, None
    with wave.open(str(audio), "rb") as wav:
        if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("Alignment requires the prepared mono 16 kHz PCM audio.")
        duration = wav.getnframes() / 16000
        result["duration"] = duration
        if abs(duration - float(request["duration"])) > .3:
            raise ValueError("Audio duration changed. Relink and review the recording before aligning.")
        for cue in cues:
            start, end = float(cue["start"]), float(cue["end"])
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or end > duration + .05:
                raise ValueError("A subtitle has invalid timing for this recording.")
        for i, group in enumerate(groups):
            lang = group["language"]
            try:
                if current_language != lang:
                    model, metadata = None, None
                    import gc
                    gc.collect()
                    progress(f"Loading {lang} alignment model (first use may download it)…")
                    model, metadata = load_model(language_code=lang, device="cpu", model_dir=str(cache))
                    current_language = lang
                text, spans = alignment_text(group["words"], lang)
                if group["end"] - group["start"] > 30 or len(text) > 2000:
                    raise ValueError("This passage exceeds the alignment window; kept its earlier timing.")
                if not text:
                    continue
                first = max(0, int((group["start"] - 1) * 16000))
                last = min(wav.getnframes(), int((group["end"] + 1) * 16000))
                wav.setpos(first)
                samples = np.frombuffer(wav.readframes(last - first), dtype="<i2").astype(np.float32) / 32768
                aligned = align([{"start": 0., "end": len(samples) / 16000, "text": text}],
                                model, metadata, samples, "cpu", return_char_alignments=True)
                hits = extract_words(text, spans, aligned, group["words"], first / 16000, duration, metadata["dictionary"])
                for (ci, wi), hit in zip(group["locations"], hits):
                    hit["language"] = lang
                    result["cues"][ci]["words"][wi] = hit
            except Exception as e:
                for ci, _ in group["locations"]:
                    result["cues"][ci]["issue"] = str(e)[:300]
            progress(f"Aligning words · {i+1}/{len(groups)} · {round((i+1)/len(groups)*100)}%")
    if "speakers" in request:
        label_speakers(result, audio, request)
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--probe", action="store_true")
    p.add_argument("--request")
    p.add_argument("--audio")
    p.add_argument("--output", required=True)
    args = p.parse_args()
    try:
        align, load_model, np, torch = backend()
        if args.probe:
            result = {"ready": True, "version": VERSION, "device": "cpu"}
        else:
            raw = Path(args.request)
            if raw.stat().st_size > 50 * 1024 * 1024:
                raise ValueError("Alignment request exceeds 50 MB.")
            result = run(json.loads(raw.read_text(encoding="utf-8")), args.audio, align, load_model, np, torch)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    except Exception as e:
        progress(f"{type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
