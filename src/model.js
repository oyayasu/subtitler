export const uid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues)
    globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
};
export const clone = (x) =>
  globalThis.structuredClone
    ? globalThis.structuredClone(x)
    : JSON.parse(JSON.stringify(x));
const finite = (x) => typeof x === "number" && Number.isFinite(x);
export const cueText = (c) =>
  c.words.map((w, i) => (i ? w.gap : "") + w.text).join("");
export function clock(seconds, separator = ".") {
  const ms = Math.max(0, Math.round((+seconds || 0) * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
}
export function seconds(value) {
  if (finite(value)) return value;
  const m = String(value)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (m)
    return (
      +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000
    );
  const n = Number(value);
  if (String(value).trim() && finite(n)) return n;
  throw Error("Use seconds or HH:MM:SS.mmm.");
}
export function tokenize(text) {
  text = String(text).replace(/\r\n?/g, "\n");
  if (text.length > 20000)
    throw Error(
      "A subtitle is limited to 20,000 characters. Split it into smaller blocks.",
    );
  const parts =
      typeof Intl.Segmenter === "function"
        ? [
            ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(
              text,
            ),
          ]
        : [...text.matchAll(/\S+|\s+/gu)].map((m) => ({
            segment: m[0],
            index: m.index,
            isWordLike: !/^\s+$/u.test(m[0]),
          })),
    words = [];
  let pending = "";
  for (const s of parts) {
    if (s.isWordLike) {
      const prefix = !words.length ? pending.trimStart() : "";
      words.push({
        text: prefix + s.segment,
        gap: words.length ? pending : "",
        from: s.index - prefix.length,
        to: s.index + s.segment.length,
      });
      pending = "";
    } else if (/^\s+$/u.test(s.segment)) pending += s.segment;
    else if (words.length && !pending) {
      words.at(-1).text += s.segment;
      words.at(-1).to = s.index + s.segment.length;
    } else pending += s.segment;
  }
  if (pending.trim()) {
    if (words.length) {
      words.at(-1).text += pending;
      words.at(-1).to = text.length;
    } else
      words.push({
        text: pending.trim(),
        gap: "",
        from: text.indexOf(pending.trim()),
        to: text.trimEnd().length,
      });
  }
  if (words.length) words[0].gap = "";
  return words;
}
function distribute(parts, start, end, quality = "estimated") {
  const total = parts.reduce((n, w) => n + Math.max(1, w.text.length), 0);
  let used = 0;
  return parts.map((w) => {
    const from = used / total;
    used += Math.max(1, w.text.length);
    return {
      id: uid(),
      text: w.text,
      gap: w.gap,
      start: +(start + (end - start) * from).toFixed(6),
      end: +(start + ((end - start) * used) / total).toFixed(6),
      timing: quality,
      originId: null,
    };
  });
}
export function newProject(name = "Untitled transcript", source = {}) {
  return {
    format: "whisperdesk-project-v1",
    schemaVersion: 1,
    id: uid(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { name: "", path: null, previewPath: null, duration: 0, ...source },
    language: "auto",
    model: "",
    sourceWords: [],
    cues: [],
    recognition: null,
  };
}
const control = (s) => /^\s*(?:<\|.*?\|>|\[_.*?\])\s*$/u.test(s);
export function parseWhisper(raw, source = {}) {
  if (!raw || !Array.isArray(raw.transcription) || !raw.transcription.length)
    throw Error("Choose detailed whisper.cpp JSON containing a transcription.");
  let previous = 0;
  const words = [];
  for (const seg of raw.transcription) {
    if (typeof seg.text !== "string" || control(seg.text) || !seg.text.trim())
      continue;
    const start = seg.offsets
        ? Number(seg.offsets.from) / 1000
        : seconds(seg.timestamps?.from),
      end = seg.offsets
        ? Number(seg.offsets.to) / 1000
        : seconds(seg.timestamps?.to);
    if (
      !finite(start) ||
      !finite(end) ||
      start < 0 ||
      end <= start ||
      end > 172800
    )
      continue;
    const text = seg.text,
      parts = tokenize(text),
      tokens = [];
    let offset = 0;
    for (const t of seg.tokens || []) {
      if (typeof t.text !== "string" || control(t.text)) continue;
      const begin = text.indexOf(t.text, offset);
      if (begin < 0) continue;
      const a = t.offsets
          ? Number(t.offsets.from) / 1000
          : parseClock(t.timestamps?.from),
        b = t.offsets
          ? Number(t.offsets.to) / 1000
          : parseClock(t.timestamps?.to);
      tokens.push({
        from: begin,
        to: begin + t.text.length,
        start: a,
        end: b,
        confidence: Number.isFinite(t.p) ? t.p : null,
      });
      offset = begin + t.text.length;
    }
    const fallback = distribute(parts, start, end);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i],
        hits = tokens.filter(
          (t) =>
            t.to > part.from &&
            t.from < part.to &&
            finite(t.start) &&
            finite(t.end) &&
            t.end > t.start &&
            t.start >= start - 0.1 &&
            t.end <= end + 0.1,
        );
      let w = fallback[i];
      const probabilities = tokens
        .filter(
          (t) => t.to > part.from && t.from < part.to && t.confidence !== null,
        )
        .map((t) => t.confidence);
      if (probabilities.length) w.confidence = Math.min(...probabilities);
      if (hits.length) {
        const first = hits[0],
          last = hits.at(-1);
        const shared = hits.some(
          (t) => parts.filter((p) => p.to > t.from && p.from < t.to).length > 1,
        );
        if (!shared)
          w = {
            ...w,
            start: Math.max(start, first.start),
            end: Math.min(end, last.end),
            timing: "whisper",
          };
      }
      if (i === 0 && words.length)
        w.gap =
          text.match(/^\s*/u)[0] ||
          (/[\p{Script=Latin}\p{N}]$/u.test(words.at(-1).text) &&
          /^[\p{Script=Latin}\p{N}]/u.test(w.text)
            ? " "
            : "");
      w.start = Math.max(previous, w.start);
      w.end = Math.max(w.start + 0.001, w.end);
      previous = w.end;
      w.originId = w.id;
      words.push(w);
    }
  }
  if (!words.length)
    throw Error(
      "No timed speech was found. Try an explicit language or another model.",
    );
  if (words.length > 200000)
    throw Error(
      "This recording is too large for one project. Divide the audio into chapters.",
    );
  const p = newProject(
    source.name?.replace(/\.[^.]+$/, "") || "Transcript",
    source,
  );
  p.language = raw.result?.language || raw.params?.language || "auto";
  p.model = raw.params?.model || raw.model?.type || "";
  const actual=Number(source.duration);
  if(actual>0&&words.at(-1).end>actual+.35)throw Error('Recognition extends beyond the original audio. The recording duration was kept; try transcription again.');
  p.source.duration=actual>0?actual:words.at(-1).end;
  if(actual>0)for(const w of words)w.end=Math.min(actual,w.end);
  p.sourceWords = clone(words);
  p.cues = groupWords(words);
  p.recognition = {
    engine: "whisper.cpp",
    language: p.language,
    model: p.model,
    createdAt: new Date().toISOString(),
  };
  return p;
}
function parseClock(value) {
  try {
    return seconds(value);
  } catch {
    return NaN;
  }
}
export function groupWords(
  words,
  { maxChars = 76, maxSeconds = 5, gap = 0.65 } = {},
) {
  const cues = [];
  let current = [];
  for (const w of words) {
    const last = current.at(-1),
      length = current.reduce((n, w) => n + w.text.length + w.gap.length, 0);
    if (
      current.length &&
      (w.start - last.end > gap ||
        w.end - current[0].start > maxSeconds ||
        length + w.text.length > maxChars ||
        (/[.!?。！？]$/u.test(last.text) && length > 20))
    ) {
      cues.push(makeCue(current));
      current = [];
    }
    current.push(clone(w));
  }
  if (current.length) cues.push(makeCue(current));
  return cues;
}
const makeCue = (words) => ({
  id: uid(),
  start: words[0].start,
  end: words.at(-1).end,
  words,
});
export function splitCue(project, cueId, wordId) {
  const i = project.cues.findIndex((c) => c.id === cueId),
    cue = project.cues[i],
    at = cue?.words.findIndex((w) => w.id === wordId);
  if (!cue || at < 1)
    throw Error(
      "Select a word after the first word. The new subtitle starts there.",
    );
  const left = cue.words.slice(0, at),
    right = cue.words.slice(at),
    point = right[0].start;
  if (point <= cue.start || point >= cue.end)
    throw Error("Adjust this word’s timing before splitting here.");
  project.cues.splice(
    i,
    1,
    { ...cue, end: point, words: left },
    { id: uid(), start: point, end: cue.end, words: right },
  );
  return project.cues[i + 1];
}
export function mergeCues(project, ids) {
  const indexes = [...new Set(ids)]
    .map((id) => project.cues.findIndex((c) => c.id === id))
    .sort((a, b) => a - b);
  if (
    indexes.length < 2 ||
    indexes[0] < 0 ||
    indexes.some((n, i) => i && n !== indexes[i - 1] + 1)
  )
    throw Error("Select two or more adjacent subtitles to merge.");
  const selected = indexes.map((i) => project.cues[i]),
    first = selected[0],
    words = selected.flatMap((c) => clone(c.words));
  for (let i = 0; i < words.length; i++)
    if (
      i &&
      !words[i].gap &&
      /[\p{Script=Latin}\p{N}]$/u.test(words[i - 1].text) &&
      /^[\p{Script=Latin}\p{N}]/u.test(words[i].text)
    )
      words[i].gap = " ";
  const merged = { ...first, end: selected.at(-1).end, words };
  project.cues.splice(indexes[0], indexes.length, merged);
  return merged;
}
const key = (w) =>
  w.text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "");
export function editCue(project, cueId, text) {
  const cue = project.cues.find((c) => c.id === cueId);
  if (!cue) throw Error("Select a subtitle.");
  const parts = tokenize(text);
  if (!parts.length) throw Error("Use Delete subtitle to remove this block.");
  if (parts.length > 1500 || cue.words.length > 1500)
    throw Error("Split this subtitle before editing such a long passage.");
  const old = cue.words,
    n = old.length,
    m = parts.length,
    dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let a = n - 1; a >= 0; a--)
    for (let b = m - 1; b >= 0; b--)
      dp[a][b] =
        key(old[a]) === key(parts[b])
          ? 1 + dp[a + 1][b + 1]
          : Math.max(dp[a + 1][b], dp[a][b + 1]);
  const matches = new Map();
  let a = 0,
    b = 0;
  while (a < n && b < m) {
    if (key(old[a]) === key(parts[b])) {
      matches.set(b, a);
      a++;
      b++;
    } else if (dp[a + 1][b] >= dp[a][b + 1]) a++;
    else b++;
  }
  const result = parts.map((w, i) =>
    matches.has(i)
      ? { ...clone(old[matches.get(i)]), text: w.text, gap: w.gap }
      : null,
  );
  for (let from = 0; from < m; ) {
    if (result[from]) {
      from++;
      continue;
    }
    let to = from;
    while (to < m && !result[to]) to++;
    const start = from ? result[from - 1].end : cue.start,
      end = to < m ? result[to].start : cue.end;
    if (end - start < 0.001) {
      if (to < m) {
        const neighbor = result[to],
          created = distribute(parts.slice(from, to + 1), start, neighbor.end);
        for (let i = from; i <= to; i++)
          result[i] =
            i === to
              ? {
                  ...neighbor,
                  start: created[i - from].start,
                  end: created[i - from].end,
                  timing: "estimated",
                }
              : created[i - from];
        from = to + 1;
      } else if (from) {
        const neighbor = result[from - 1],
          created = distribute(
            parts.slice(from - 1, to),
            neighbor.start,
            cue.end,
          );
        for (let i = from - 1; i < to; i++)
          result[i] =
            i === from - 1
              ? {
                  ...neighbor,
                  start: created[0].start,
                  end: created[0].end,
                  timing: "estimated",
                }
              : created[i - from + 1];
        from = to;
      } else
        throw Error("Extend this subtitle to make space for the new words.");
    } else {
      const created = distribute(parts.slice(from, to), start, end);
      for (let i = from; i < to; i++) result[i] = created[i - from];
      from = to;
    }
  }
  cue.words = result;
  return cue;
}
export function retimeCue(project, id, start, end) {
  const i = project.cues.findIndex((c) => c.id === id),
    c = project.cues[i];
  if (
    !c ||
    !finite(start) ||
    !finite(end) ||
    start < 0 ||
    end - start < 0.01 ||
    end > 172800
  )
    throw Error("The end must be after the start.");
  if (i && start < project.cues[i - 1].end - 0.001)
    throw Error("The start overlaps the previous subtitle.");
  if (i < project.cues.length - 1 && end > project.cues[i + 1].start + 0.001)
    throw Error("The end overlaps the next subtitle.");
  const scale = (end - start) / (c.end - c.start);
  for (const w of c.words) {
    w.start = start + (w.start - c.start) * scale;
    w.end = start + (w.end - c.start) * scale;
    w.timing = "manual";
  }
  c.start = start;
  c.end = end;
}
export function parseSrt(text, source = {}) {
  const p = newProject(
    source.name?.replace(/\.srt$/i, "") || "Imported subtitles",
    source,
  );
  for (const block of text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/u)) {
    const lines = block.split("\n"),
      i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->").map((s) => s.trim().split(/\s/u)[0]);
    const start = seconds(a),
      end = seconds(b);
    if (start < 0 || end <= start)
      throw Error("An SRT block has invalid timing.");
    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<\/?(?:b|i|u)>/gi, "");
    if (p.cues.length >= 50000)
      throw Error("Import at most 50,000 subtitle blocks per project.");
    if (body.trim())
      p.cues.push({
        id: uid(),
        start,
        end,
        words: distribute(tokenize(body), start, end),
      });
  }
  if (!p.cues.length) throw Error("No subtitles were found in the SRT.");
  p.cues.sort((a, b) => a.start - b.start);
  p.source.duration = Math.max(...p.cues.map((c) => c.end));
  p.recognition = {
    engine: "SRT import",
    note: "Word timing estimated from subtitle blocks.",
  };
  return validateProject(p);
}
export function validateProject(raw) {
  if (
    !raw ||
    raw.format !== "whisperdesk-project-v1" ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.cues) ||
    raw.cues.length > 50000
  )
    throw Error("Invalid Subtitler project.");
  if (JSON.stringify(raw).length > 50 * 1024 * 1024)
    throw Error("Project exceeds 50 MB.");
  const p = clone(raw),
    seen = new Set();
  p.sourceWords = Array.isArray(p.sourceWords) ? p.sourceWords : [];
  p.source ||= {};
  p.id = typeof p.id === "string" ? p.id : uid();
  p.name = String(p.name || "Transcript").slice(0, 200);
  for (const c of p.cues) {
    if (
      typeof c.id !== "string" ||
      seen.has(c.id) ||
      !finite(c.start) ||
      !finite(c.end) ||
      c.start < 0 ||
      c.end <= c.start ||
      c.end > 172800 ||
      !Array.isArray(c.words) ||
      !c.words.length
    )
      throw Error("Invalid subtitle timing or identity.");
    seen.add(c.id);
    for (const w of c.words) {
      if (
        typeof w.id !== "string" ||
        seen.has(w.id) ||
        typeof w.text !== "string" ||
        !w.text ||
        w.text.length > 20000 ||
        !finite(w.start) ||
        !finite(w.end) ||
        w.start < c.start - 0.01 ||
        w.end > c.end + 0.01 ||
        w.end <= w.start
      )
        throw Error("Invalid timed word.");
      seen.add(w.id);
      w.gap = typeof w.gap === "string" ? w.gap : "";
      if (!["whisper", "manual", "estimated"].includes(w.timing))
        w.timing = "estimated";
    }
  }
  return p;
}
export class History {
  constructor(project) {
    this.project = project;
    this.undo = [];
    this.redo = [];
  }
  change(label, fn) {
    const before = clone(this.project);
    try {
      fn(this.project);
      validateProject(this.project);
    } catch (e) {
      this.project = before;
      throw e;
    }
    this.undo.push({ label, project: before });
    if (this.undo.length > 80) this.undo.shift();
    this.redo = [];
    this.project.updatedAt = new Date().toISOString();
    return this.project;
  }
  back() {
    const prev = this.undo.pop();
    if (prev) {
      this.redo.push({ label: prev.label, project: clone(this.project) });
      this.project = prev.project;
    }
    return this.project;
  }
  forward() {
    const next = this.redo.pop();
    if (next) {
      this.undo.push({ label: next.label, project: clone(this.project) });
      this.project = next.project;
    }
    return this.project;
  }
}
export function activeWord(project, time) {
  const cues = project.cues;
  let lo = 0,
    hi = cues.length - 1,
    index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (index < 0) return null;
  const cue = cues[index];
  if (time >= cue.end) return null;
  if (project.pauses?.some((p) => time >= p.start && time < p.end) && !cue.words.some(w=>(w.timing!=='estimated')&&time>=w.start&&time<w.end))
    return { cue, word: null };
  lo = 0;
  hi = cue.words.length - 1;
  index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cue.words[mid].start <= time) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const word = cue.words[index],
    next = cue.words[index + 1];
  // Bridge only tiny timestamp gaps in the display; exported timing is untouched.
  return {
    cue,
    word:
      word && time < Math.min(next?.start ?? cue.end, word.end + 0.08)
        ? word
        : null,
  };
}
export function timingExport(p) {
  return {
    format: "whisperdesk-timing-v1",
    schemaVersion: 1,
    timeUnit: "seconds",
    exportedAt: new Date().toISOString(),
    projectId: p.id,
    studioProjectId:
      p.studioLink?.projectId || p.scriptReference?.studioProjectId || null,
    chapterIds: [
      ...new Set(
        p.cues
          .flatMap((c) => c.words.map((w) => w.scriptChapterId))
          .filter(Boolean),
      ),
    ],
    pauses: clone(p.pauses || []),
    speakers: clone(p.speakerNames || {}),
    source: {
      name: p.source.name,
      fingerprint: p.source.fingerprint || null,
      duration: p.source.duration,
      size: p.source.size || null,
      modified: p.source.modified || null,
      path: p.source.path || null,
      relativePath: p.source.relativePath || null,
    },
    language: p.language,
    recognition: p.recognition,
    words: p.cues.flatMap((c) => c.words.map((w) => ({ ...w, cueId: c.id }))),
    subtitles: p.cues.map((c) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      text: cueText(c),
      wordIds: c.words.map((w) => w.id),
    })),
    originalWords: clone(p.sourceWords),
    notes:
      "Automatic word times remain approximate. WhisperX provenance is retained when used. Unresolved, edited or imported words may keep earlier or interpolated timing.",
  };
}
