import { clone, uid, tokenize, cueText } from "./model.js";

export const subtitleDefaults = Object.freeze({
  minWords: 1,
  maxWords: 14,
  maxChars: 42,
  lines: 2,
  maxSeconds: 6,
  pauseSeconds: 0.6,
  autoAlign: true,
  speakers: 1,
  mixedLanguages: true,
});
export function subtitleOptions(value = {}) {
  const out = { ...subtitleDefaults, ...value };
  for (const [key, min, max] of [
    ["minWords", 1, 100],
    ["maxWords", 1, 100],
    ["maxChars", 8, 120],
    ["lines", 1, 2],
    ["maxSeconds", 1, 30],
    ["pauseSeconds", 0.1, 10],
    ["speakers", 0, 20],
  ]) {
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n < min || n > max)
      throw Error("Invalid " + key + " setting.");
    out[key] = ["maxSeconds", "pauseSeconds"].includes(key) ? n : Math.round(n);
  }
  if (out.minWords > out.maxWords)
    throw Error("Minimum words cannot exceed maximum words.");
  out.autoAlign = !!out.autoAlign;
  out.mixedLanguages = !!out.mixedLanguages;
  return out;
}
export function captionLines(words, options = {}) {
  const { maxChars, lines } = subtitleOptions(options),
    result = [];
  let line = "";
  for (const w of words) {
    if (line && w.gap?.includes("\n")) {
      result.push(line);
      line = "";
    }
    const body = String(w.text).replace(/\s+/gu, " "),
      gap = line ? w.gap || "" : "";
    if (line && [...(line + gap + body)].length > maxChars) {
      result.push(line);
      line = body;
    } else line += gap + body;
  }
  if (line) result.push(line);
  return {
    text: result.join("\n"),
    fits:
      result.length <= lines && result.every((s) => [...s].length <= maxChars),
  };
}
export function resegment(project, settings = {}) {
  const opts = subtitleOptions(settings),
    words = project.cues.flatMap((c) => clone(c.words)),
    cues = [];
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    cues.push({
      id: uid(),
      start: batch[0].start,
      end: batch.at(-1).end,
      words: batch,
      speaker: batch[0].speaker || "Speaker 1",
      layoutWarning: !captionLines(batch, opts).fits,
    });
    batch = [];
  };
  for (const w of words) {
    const last = batch.at(-1);
    const hard =
      last &&
      (w.start - last.end >= opts.pauseSeconds ||
        w.speaker !== last.speaker ||
        (w.language && last.language && w.language !== last.language));
    const capacity =
      batch.length &&
      (batch.length >= opts.maxWords ||
        w.end - batch[0].start > opts.maxSeconds ||
        !captionLines([...batch, w], opts).fits);
    const sentence =
      last && batch.length >= opts.minWords && /[.!?。！？]$/u.test(last.text);
    if (hard || capacity || sentence) flush();
    batch.push(w);
  }
  flush();
  // Minimum is a preference: never join across silence/speaker changes or violate a maximum.
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1],
      b = cues[i],
      all = [...a.words, ...b.words];
    if (
      b.words.length < opts.minWords &&
      b.start - a.end < opts.pauseSeconds &&
      a.speaker === b.speaker &&
      all.length <= opts.maxWords &&
      b.end - a.start <= opts.maxSeconds &&
      captionLines(all, opts).fits
    ) {
      a.words = all;
      a.end = b.end;
      cues.splice(i--, 1);
    }
  }
  project.cues = cues;
  project.subtitleOptions = opts;
  return cues;
}
export const normalized = (s) =>
  String(s)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
const pausePattern =
  /[\[(]\s*((?:(?:very\s+)?(?:short|long|brief)\s+)?(?:pause|silence)|(?:pausa|sil[eê]ncio)(?:\s+(?:curt[ao]|long[ao]|breve))?)\s*[\])]/giu;
export function parseScript(raw) {
  if (typeof raw === "string") {
    try {
      const json = JSON.parse(raw);
      if (json?.format === "subtitler-script-v1") return parseScript(json);
    } catch {}
    return scriptChapters([{ id: null, title: "Script", text: raw }]);
  }
  if (
    raw?.format !== "subtitler-script-v1" ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.chapters) ||
    raw.chapters.length > 10000
  )
    throw Error(
      "Choose a spoken script exported by Storyboard Studio, DOCX, or TXT.",
    );
  const out = scriptChapters(raw.chapters);
  out.studioProjectId = raw.studioProjectId || raw.project?.id || null;
  out.projectName = raw.project?.name || "";
  return out;
}
function scriptChapters(chapters) {
  const words = [],
    markers = [];
  let total = 0;
  for (const ch of chapters) {
    if (typeof ch.text !== "string")
      throw Error("The script contains invalid chapter text.");
    total += ch.text.length;
    if (total > 2000000)
      throw Error("Import a script shorter than 2 million characters.");
    const text = ch.text,
      ranged = Array.isArray(ch.ranges),
      pauses = [...(ch.pauses || [])];
    for (const m of ranged ? [] : text.matchAll(pausePattern))
      if (!pauses.some((p) => p.from === m.index))
        pauses.push({
          id: uid(),
          from: m.index,
          to: m.index + m[0].length,
          label: m[1],
        });
    let masked = text;
    for (const p of pauses.slice().sort((a, b) => b.from - a.from))
      if (
        Number.isInteger(p.from) &&
        p.from >= 0 &&
        p.to > p.from &&
        p.to <= text.length
      )
        masked =
          masked.slice(0, p.from) +
          " ".repeat(p.to - p.from) +
          masked.slice(p.to);
    const sections = ranged ? ch.ranges : [{ from: 0, text: masked }];
    for (const section of sections) {
      if (
        typeof section.text !== "string" ||
        !Number.isInteger(section.from) ||
        section.from < 0
      )
        throw Error("Invalid script range.");
      let offset = section.from;
      for (const part of section.text.match(/[^\n]*(?:\n|$)/gu) || []) {
        if (part.length > 20000) throw Error("A script paragraph is too long.");
        for (const w of tokenize(part))
          words.push({
            ...w,
            from: w.from + offset,
            to: w.to + offset,
            chapterId: ch.id || null,
          });
        offset += part.length;
      }
    }
    for (const p of pauses) {
      const before =
        words
          .map((w, i) => ({ w, i }))
          .filter((x) => x.w.chapterId === (ch.id || null) && x.w.to <= p.from)
          .at(-1)?.i ?? null;
      const after = words.findIndex(
        (w) => w.chapterId === (ch.id || null) && w.from >= p.to,
      );
      markers.push({
        id: p.id || uid(),
        label: p.label || "Pause",
        chapterId: ch.id || null,
        before,
        after: after < 0 ? null : after,
      });
    }
  }
  return {
    words,
    markers,
    chapters: chapters.map((c) => ({
      id: c.id || null,
      title: c.title || "",
      number: c.number || "",
    })),
  };
}
export async function docxScript(data) {
  if (!globalThis.JSZip) throw Error("Document reader unavailable.");
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry || entry._data?.uncompressedSize > 8000000)
    throw Error("Choose a DOCX with less than 8 MB of script text.");
  const xml = new DOMParser().parseFromString(
    await entry.async("string"),
    "application/xml",
  );
  if (xml.querySelector("parsererror"))
    throw Error("The DOCX text could not be read.");
  return parseScript(
    [...xml.getElementsByTagNameNS("*", "p")]
      .map((p) =>
        [...p.getElementsByTagNameNS("*", "t")]
          .map((t) => t.textContent)
          .join(""),
      )
      .join("\n"),
  );
}
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const prior = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = prior;
    }
  }
  return row[b.length];
}
export function matchScript(project, script, { correct = true } = {}) {
  const recognized = project.cues.flatMap((c) => c.words),
    reference = script.words;
  if (reference.length > 30000 || recognized.length > 30000)
    throw Error("Match up to 30,000 words per recording.");
  // Banded edit distance handles omitted/ad-libbed words without a quadratic matrix.
  const band = Math.max(
    100,
    Math.abs(reference.length - recognized.length) + 50,
  );
  if (band > 1500)
    throw Error(
      "This script differs too much from the recording. Select a closer script or transcribe without it.",
    );
  const keys = reference.map((w) => normalized(w.text)),
    heard = recognized.map((w) => normalized(w.text)),
    trace = [];
  let previous = new Float64Array(recognized.length + 1);
  previous.fill(Infinity);
  for (let i = 0; i <= reference.length; i++) {
    const current = new Float64Array(recognized.length + 1);
    current.fill(Infinity);
    const start = Math.max(0, i - band),
      end = Math.min(recognized.length, i + band),
      ops = new Uint8Array(end - start + 1);
    trace.push({ start, ops });
    for (let j = start; j <= end; j++) {
      if (!i && !j) {
        current[j] = 0;
        continue;
      }
      const a = keys[i - 1] || "",
        b = heard[j - 1] || "";
      const similar =
        a &&
        b &&
        Math.max(a.length, b.length) >= 4 &&
        Math.max(a.length, b.length) <= 80 &&
        Math.abs(a.length - b.length) <= Math.max(a.length, b.length) * 0.34 &&
        distance(a, b) / Math.max(a.length, b.length) <= 0.34;
      const paired =
          i && j
            ? previous[j - 1] + (a === b ? 0 : similar ? 0.8 : 1.8)
            : Infinity,
        omitted = i ? previous[j] + 1 : Infinity,
        added = j ? current[j - 1] + 1 : Infinity;
      if (paired <= omitted && paired <= added) {
        current[j] = paired;
        ops[j - start] = similar ? 4 : 1;
      } else if (omitted <= added) {
        current[j] = omitted;
        ops[j - start] = 2;
      } else {
        current[j] = added;
        ops[j - start] = 3;
      }
    }
    previous = current;
  }
  const mapping = new Map(),
    changes = [];
  let i = reference.length,
    j = recognized.length;
  while (i || j) {
    const op = trace[i].ops[j - trace[i].start];
    if (!op) throw Error("Script matching could not finish.");
    const step = { similar: op === 4 };
    if (op === 1 || op === 4) {
      const s = reference[--i],
        w = recognized[--j],
        same = normalized(s.text) === normalized(w.text);
      if (same || step.similar) {
        mapping.set(i, j);
        w.scriptChapterId = s.chapterId;
        w.scriptWordIndex = i;
        const confident = w.confidence != null && w.confidence >= 0.6;
        if (
          correct &&
          (same || (step.similar && !confident && w.confidence != null)) &&
          w.text !== s.text
        ) {
          changes.push({
            kind: "reference-correction",
            recognized: w.text,
            script: s.text,
            wordId: w.id,
          });
          w.text = s.text;
          w.referenceCorrected = true;
        }
      } else
        changes.push({
          kind: "different",
          recognized: w.text,
          script: s.text,
          wordId: w.id,
        });
    } else if (op === 2) {
      changes.push({ kind: "omitted", script: reference[--i].text });
    } else
      changes.push({
        kind: "added",
        recognized: recognized[--j].text,
        wordId: recognized[j].id,
      });
  }
  project.scriptReference = {
    ...clone(script),
    mapping: [...mapping],
    changes: changes.reverse(),
    matched: mapping.size,
    referenceWords: reference.length,
  };
  return project.scriptReference;
}
export function attachPauses(project, intervals, threshold = 0.6) {
  if (!Array.isArray(intervals)) throw Error("Invalid silence result.");
  const old = project.pauses || [],
    duration = project.source.duration;
  project.pauses = intervals
    .filter(
      (p) =>
        Number.isFinite(p.start) &&
        Number.isFinite(p.end) &&
        p.start >= 0 &&
        p.end <= duration + 0.01 &&
        p.end - p.start >= threshold - 0.001,
    )
    .map((p) => ({
      id:
        old.find(
          (o) =>
            Math.abs(o.start - p.start) < 0.02 &&
            Math.abs(o.end - p.end) < 0.02,
        )?.id || uid(),
      label: "Silence",
      start: p.start,
      end: Math.min(p.end, duration),
      method: p.method || "audio-level",
      ...(p.noiseDb != null ? { noiseDb: p.noiseDb } : {}),
    }));
  project.pauses.sort((a,b)=>a.start-b.start);
  project.pauses=project.pauses.reduce((out,pause)=>{const old=out.at(-1);if(old&&pause.start<=old.end+.005)old.end=Math.max(old.end,pause.end);else out.push(pause);return out;},[]);
  const ref = project.scriptReference;
  if (ref) {
    const map = new Map(ref.mapping),
      words = project.cues.flatMap((c) => c.words);
    for (const marker of ref.markers) {
      const left =
          marker.before === null ? 0 : words[map.get(marker.before)]?.end,
        right =
          marker.after === null
            ? duration
            : words[map.get(marker.after)]?.start;
      if (left == null || right == null || right <= left) continue;
      const candidates = project.pauses
        .filter(
          (p) => !p.markerId && p.start >= left - 0.12 && p.end <= right + 0.12,
        )
        .sort((a, b) => b.end - b.start - (a.end - a.start));
      if (candidates[0])
        Object.assign(candidates[0], {
          markerId: marker.id,
          chapterId: marker.chapterId,
          label: marker.label,
        });
    }
  }
  return project.pauses;
}
export function timingDiagnostics(project) {
  const words = project.cues.flatMap((c) => c.words);
  return {
    words: words.length,
    estimated: words.filter((w) => w.timing === "estimated").length,
    veryShort: words.filter((w) => w.end - w.start < 0.06).map((w) => w.id),
    unresolved: words.filter((w) => w.alignmentIssue).map((w) => w.id),
  };
}
