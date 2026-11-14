(() => {
  // src/window-events.js
  function listenDocument(api, event, handler) {
    const label = api.webviewWindow?.getCurrentWebviewWindow?.().label || api.window?.getCurrentWindow?.().label;
    return api.event.listen(event, handler, label ? { target: { kind: "WebviewWindow", label } } : void 0);
  }

  // src/model.js
  var uid = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues)
      globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const h = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      h.slice(12, 16),
      h.slice(16, 20),
      h.slice(20)
    ].join("-");
  };
  var clone = (x) => globalThis.structuredClone ? globalThis.structuredClone(x) : JSON.parse(JSON.stringify(x));
  var finite = (x) => typeof x === "number" && Number.isFinite(x);
  var cueText = (c) => c.words.map((w, i) => (i ? w.gap : "") + w.text).join("");
  function clock(seconds2, separator = ".") {
    const ms = Math.max(0, Math.round((+seconds2 || 0) * 1e3));
    return `${String(Math.floor(ms / 36e5)).padStart(2, "0")}:${String(Math.floor(ms / 6e4) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1e3) % 60).padStart(2, "0")}${separator}${String(ms % 1e3).padStart(3, "0")}`;
  }
  function seconds(value) {
    if (finite(value)) return value;
    const m = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (m)
      return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1e3;
    const n = Number(value);
    if (String(value).trim() && finite(n)) return n;
    throw Error("Use seconds or HH:MM:SS.mmm.");
  }
  function tokenize(text) {
    text = String(text).replace(/\r\n?/g, "\n");
    if (text.length > 2e4)
      throw Error(
        "A subtitle is limited to 20,000 characters. Split it into smaller blocks."
      );
    const parts = typeof Intl.Segmenter === "function" ? [
      ...new Intl.Segmenter(void 0, { granularity: "word" }).segment(
        text
      )
    ] : [...text.matchAll(/\S+|\s+/gu)].map((m) => ({
      segment: m[0],
      index: m.index,
      isWordLike: !/^\s+$/u.test(m[0])
    })), words = [];
    let pending = "";
    for (const s of parts) {
      if (s.isWordLike) {
        const prefix = !words.length ? pending.trimStart() : "";
        words.push({
          text: prefix + s.segment,
          gap: words.length ? pending : "",
          from: s.index - prefix.length,
          to: s.index + s.segment.length
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
          to: text.trimEnd().length
        });
    }
    if (words.length) words[0].gap = "";
    return words;
  }
  function distribute(parts, start2, end, quality = "estimated") {
    const total = parts.reduce((n, w) => n + Math.max(1, w.text.length), 0);
    let used = 0;
    return parts.map((w) => {
      const from = used / total;
      used += Math.max(1, w.text.length);
      return {
        id: uid(),
        text: w.text,
        gap: w.gap,
        start: +(start2 + (end - start2) * from).toFixed(6),
        end: +(start2 + (end - start2) * used / total).toFixed(6),
        timing: quality,
        originId: null
      };
    });
  }
  function newProject(name = "Untitled transcript", source2 = {}) {
    return {
      format: "whisperdesk-project-v1",
      schemaVersion: 1,
      id: uid(),
      name,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      source: { name: "", path: null, previewPath: null, duration: 0, ...source2 },
      language: "auto",
      model: "",
      sourceWords: [],
      cues: [],
      chapters: [],
      recognition: null
    };
  }
  var control = (s) => /^\s*(?:<\|.*?\|>|\[_.*?\])\s*$/u.test(s);
  function parseWhisper(raw, source2 = {}) {
    if (!raw || !Array.isArray(raw.transcription) || !raw.transcription.length)
      throw Error("Choose detailed whisper.cpp JSON containing a transcription.");
    let previous = 0;
    const words = [];
    for (const seg of raw.transcription) {
      if (typeof seg.text !== "string" || control(seg.text) || !seg.text.trim())
        continue;
      const start2 = seg.offsets ? Number(seg.offsets.from) / 1e3 : seconds(seg.timestamps?.from), end = seg.offsets ? Number(seg.offsets.to) / 1e3 : seconds(seg.timestamps?.to);
      if (!finite(start2) || !finite(end) || start2 < 0 || end <= start2 || end > 172800)
        continue;
      const text = seg.text, parts = tokenize(text), tokens = [];
      let offset = 0;
      for (const t of seg.tokens || []) {
        if (typeof t.text !== "string" || control(t.text)) continue;
        const begin = text.indexOf(t.text, offset);
        if (begin < 0) continue;
        const a = t.offsets ? Number(t.offsets.from) / 1e3 : parseClock(t.timestamps?.from), b = t.offsets ? Number(t.offsets.to) / 1e3 : parseClock(t.timestamps?.to);
        tokens.push({
          from: begin,
          to: begin + t.text.length,
          start: a,
          end: b,
          confidence: Number.isFinite(t.p) ? t.p : null
        });
        offset = begin + t.text.length;
      }
      const fallback = distribute(parts, start2, end);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i], hits = tokens.filter(
          (t) => t.to > part.from && t.from < part.to && finite(t.start) && finite(t.end) && t.end > t.start && t.start >= start2 - 0.1 && t.end <= end + 0.1
        );
        let w = fallback[i];
        const probabilities = tokens.filter(
          (t) => t.to > part.from && t.from < part.to && t.confidence !== null
        ).map((t) => t.confidence);
        if (probabilities.length) w.confidence = Math.min(...probabilities);
        if (hits.length) {
          const first = hits[0], last = hits.at(-1);
          const shared = hits.some(
            (t) => parts.filter((p2) => p2.to > t.from && p2.from < t.to).length > 1
          );
          if (!shared)
            w = {
              ...w,
              start: Math.max(start2, first.start),
              end: Math.min(end, last.end),
              timing: "whisper"
            };
        }
        if (i === 0 && words.length)
          w.gap = text.match(/^\s*/u)[0] || (/[\p{Script=Latin}\p{N}]$/u.test(words.at(-1).text) && /^[\p{Script=Latin}\p{N}]/u.test(w.text) ? " " : "");
        w.start = Math.max(previous, w.start);
        w.end = Math.max(w.start + 1e-3, w.end);
        previous = w.end;
        w.originId = w.id;
        words.push(w);
      }
    }
    if (!words.length)
      throw Error(
        "No timed speech was found. Try an explicit language or another model."
      );
    if (words.length > 2e5)
      throw Error(
        "This recording is too large for one project. Divide the audio into chapters."
      );
    const p = newProject(
      source2.name?.replace(/\.[^.]+$/, "") || "Transcript",
      source2
    );
    p.language = raw.result?.language || raw.params?.language || "auto";
    p.model = raw.params?.model || raw.model?.type || "";
    const actual = Number(source2.duration);
    if (actual > 0 && words.at(-1).end > actual + 0.35) throw Error("Recognition extends beyond the original audio. The recording duration was kept; try transcription again.");
    p.source.duration = actual > 0 ? actual : words.at(-1).end;
    if (actual > 0) for (const w of words) w.end = Math.min(actual, w.end);
    p.sourceWords = clone(words);
    p.cues = groupWords(words);
    p.recognition = {
      engine: "whisper.cpp",
      language: p.language,
      model: p.model,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
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
  function groupWords(words, { maxChars = 76, maxSeconds = 5, gap = 0.65 } = {}) {
    const cues = [];
    let current = [];
    for (const w of words) {
      const last = current.at(-1), length = current.reduce((n, w2) => n + w2.text.length + w2.gap.length, 0);
      if (current.length && (w.start - last.end > gap || w.end - current[0].start > maxSeconds || length + w.text.length > maxChars || /[.!?。！？]$/u.test(last.text) && length > 20)) {
        cues.push(makeCue(current));
        current = [];
      }
      current.push(clone(w));
    }
    if (current.length) cues.push(makeCue(current));
    return cues;
  }
  var makeCue = (words) => ({
    id: uid(),
    start: words[0].start,
    end: words.at(-1).end,
    words
  });
  function splitCue(project2, cueId, wordId) {
    const i = project2.cues.findIndex((c) => c.id === cueId), cue = project2.cues[i], at = cue?.words.findIndex((w) => w.id === wordId);
    if (!cue || at < 1)
      throw Error(
        "Select a word after the first word. The new subtitle starts there."
      );
    const left = cue.words.slice(0, at), right = cue.words.slice(at), point = right[0].start;
    if (point <= cue.start || point >= cue.end)
      throw Error("Adjust this word’s timing before splitting here.");
    project2.cues.splice(
      i,
      1,
      { ...cue, end: point, words: left },
      { id: uid(), start: point, end: cue.end, words: right }
    );
    return project2.cues[i + 1];
  }
  function mergeCues(project2, ids) {
    const indexes = [...new Set(ids)].map((id) => project2.cues.findIndex((c) => c.id === id)).sort((a, b) => a - b);
    if (indexes.length < 2 || indexes[0] < 0 || indexes.some((n, i) => i && n !== indexes[i - 1] + 1))
      throw Error("Select two or more adjacent subtitles to merge.");
    const selected = indexes.map((i) => project2.cues[i]), first = selected[0], words = selected.flatMap((c) => clone(c.words));
    for (let i = 0; i < words.length; i++)
      if (i && !words[i].gap && /[\p{Script=Latin}\p{N}]$/u.test(words[i - 1].text) && /^[\p{Script=Latin}\p{N}]/u.test(words[i].text))
        words[i].gap = " ";
    const merged = { ...first, end: selected.at(-1).end, words };
    project2.cues.splice(indexes[0], indexes.length, merged);
    return merged;
  }
  var key = (w) => w.text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, "");
  function editCue(project2, cueId, text) {
    const cue = project2.cues.find((c) => c.id === cueId);
    if (!cue) throw Error("Select a subtitle.");
    const parts = tokenize(text);
    if (!parts.length) throw Error("Use Delete subtitle to remove this block.");
    if (parts.length > 1500 || cue.words.length > 1500)
      throw Error("Split this subtitle before editing such a long passage.");
    const old = cue.words, n = old.length, m = parts.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let a2 = n - 1; a2 >= 0; a2--)
      for (let b2 = m - 1; b2 >= 0; b2--)
        dp[a2][b2] = key(old[a2]) === key(parts[b2]) ? 1 + dp[a2 + 1][b2 + 1] : Math.max(dp[a2 + 1][b2], dp[a2][b2 + 1]);
    const matches = /* @__PURE__ */ new Map();
    let a = 0, b = 0;
    while (a < n && b < m) {
      if (key(old[a]) === key(parts[b])) {
        matches.set(b, a);
        a++;
        b++;
      } else if (dp[a + 1][b] >= dp[a][b + 1]) a++;
      else b++;
    }
    const result = parts.map(
      (w, i) => matches.has(i) ? { ...clone(old[matches.get(i)]), text: w.text, gap: w.gap } : null
    );
    for (let from = 0; from < m; ) {
      if (result[from]) {
        from++;
        continue;
      }
      let to = from;
      while (to < m && !result[to]) to++;
      const start2 = from ? result[from - 1].end : cue.start, end = to < m ? result[to].start : cue.end;
      if (end - start2 < 1e-3) {
        if (to < m) {
          const neighbor = result[to], created = distribute(parts.slice(from, to + 1), start2, neighbor.end);
          for (let i = from; i <= to; i++)
            result[i] = i === to ? {
              ...neighbor,
              start: created[i - from].start,
              end: created[i - from].end,
              timing: "estimated"
            } : created[i - from];
          from = to + 1;
        } else if (from) {
          const neighbor = result[from - 1], created = distribute(
            parts.slice(from - 1, to),
            neighbor.start,
            cue.end
          );
          for (let i = from - 1; i < to; i++)
            result[i] = i === from - 1 ? {
              ...neighbor,
              start: created[0].start,
              end: created[0].end,
              timing: "estimated"
            } : created[i - from + 1];
          from = to;
        } else
          throw Error("Extend this subtitle to make space for the new words.");
      } else {
        const created = distribute(parts.slice(from, to), start2, end);
        for (let i = from; i < to; i++) result[i] = created[i - from];
        from = to;
      }
    }
    cue.words = result;
    return cue;
  }
  function retimeCue(project2, id, start2, end) {
    const i = project2.cues.findIndex((c2) => c2.id === id), c = project2.cues[i];
    if (!c || !finite(start2) || !finite(end) || start2 < 0 || end - start2 < 0.01 || end > 172800)
      throw Error("The end must be after the start.");
    if (i && start2 < project2.cues[i - 1].end - 1e-3)
      throw Error("The start overlaps the previous subtitle.");
    if (i < project2.cues.length - 1 && end > project2.cues[i + 1].start + 1e-3)
      throw Error("The end overlaps the next subtitle.");
    const scale = (end - start2) / (c.end - c.start);
    for (const w of c.words) {
      w.start = start2 + (w.start - c.start) * scale;
      w.end = start2 + (w.end - c.start) * scale;
      w.timing = "manual";
    }
    c.start = start2;
    c.end = end;
  }
  function parseSrt(text, source2 = {}) {
    const p = newProject(
      source2.name?.replace(/\.srt$/i, "") || "Imported subtitles",
      source2
    );
    for (const block of text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/u)) {
      const lines = block.split("\n"), i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const [a, b] = lines[i].split("-->").map((s) => s.trim().split(/\s/u)[0]);
      const start2 = seconds(a), end = seconds(b);
      if (start2 < 0 || end <= start2)
        throw Error("An SRT block has invalid timing.");
      const body = lines.slice(i + 1).join("\n").replace(/<\/?(?:b|i|u)>/gi, "");
      if (p.cues.length >= 5e4)
        throw Error("Import at most 50,000 subtitle blocks per project.");
      if (body.trim())
        p.cues.push({
          id: uid(),
          start: start2,
          end,
          words: distribute(tokenize(body), start2, end)
        });
    }
    if (!p.cues.length) throw Error("No subtitles were found in the SRT.");
    p.cues.sort((a, b) => a.start - b.start);
    p.source.duration = Math.max(...p.cues.map((c) => c.end));
    p.recognition = {
      engine: "SRT import",
      note: "Word timing estimated from subtitle blocks."
    };
    return validateProject(p);
  }
  function validateProject(raw) {
    if (!raw || raw.format !== "whisperdesk-project-v1" || raw.schemaVersion !== 1 || !Array.isArray(raw.cues) || raw.cues.length > 5e4)
      throw Error("Invalid Subtitler project.");
    if (JSON.stringify(raw).length > 50 * 1024 * 1024)
      throw Error("Project exceeds 50 MB.");
    const p = clone(raw), seen = /* @__PURE__ */ new Set();
    p.sourceWords = Array.isArray(p.sourceWords) ? p.sourceWords : [];
    p.source || (p.source = {});
    p.id = typeof p.id === "string" ? p.id : uid();
    p.name = String(p.name || "Transcript").slice(0, 200);
    if (p.chapters !== void 0 && (!Array.isArray(p.chapters) || p.chapters.length > 1e4))
      throw Error("Invalid chapter list.");
    p.chapters || (p.chapters = []);
    const chapterIds = /* @__PURE__ */ new Set();
    for (const chapter of p.chapters) {
      if (!chapter || typeof chapter.id !== "string" || !chapter.id || chapterIds.has(chapter.id) || typeof chapter.title !== "string" || !chapter.title.trim() || chapter.title.length > 200 || !Number.isInteger(chapter.level) || chapter.level < 1 || chapter.level > 6 || chapter.start !== null && (!finite(chapter.start) || chapter.start < 0 || chapter.start > 172800) || !["manual", "matched"].includes(chapter.timeMode)) throw Error("Invalid chapter name, time or identity.");
      chapterIds.add(chapter.id);
    }
    for (const c of p.cues) {
      if (typeof c.id !== "string" || seen.has(c.id) || !finite(c.start) || !finite(c.end) || c.start < 0 || c.end <= c.start || c.end > 172800 || !Array.isArray(c.words) || !c.words.length)
        throw Error("Invalid subtitle timing or identity.");
      seen.add(c.id);
      for (const w of c.words) {
        if (typeof w.id !== "string" || seen.has(w.id) || typeof w.text !== "string" || !w.text || w.text.length > 2e4 || !finite(w.start) || !finite(w.end) || w.start < c.start - 0.01 || w.end > c.end + 0.01 || w.end <= w.start)
          throw Error("Invalid timed word.");
        seen.add(w.id);
        w.gap = typeof w.gap === "string" ? w.gap : "";
        if (!["whisper", "manual", "estimated"].includes(w.timing))
          w.timing = "estimated";
      }
    }
    return p;
  }
  var History = class {
    constructor(project2) {
      this.project = project2;
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
      this.project.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
  };
  function activeWord(project2, time) {
    const cues = project2.cues;
    let lo = 0, hi = cues.length - 1, index = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (cues[mid].start <= time) {
        index = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (index < 0) return null;
    const cue = cues[index];
    if (time >= cue.end) return null;
    if (project2.pauses?.some((p) => time >= p.start && time < p.end) && !cue.words.some((w) => w.timing !== "estimated" && time >= w.start && time < w.end))
      return { cue, word: null };
    lo = 0;
    hi = cue.words.length - 1;
    index = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (cue.words[mid].start <= time) {
        index = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const word = cue.words[index], next = cue.words[index + 1];
    return {
      cue,
      word: word && time < Math.min(next?.start ?? cue.end, word.end + 0.08) ? word : null
    };
  }
  function timingExport(p) {
    return {
      format: "whisperdesk-timing-v1",
      schemaVersion: 1,
      timeUnit: "seconds",
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      projectId: p.id,
      studioProjectId: p.studioLink?.projectId || p.scriptReference?.studioProjectId || null,
      chapterIds: [
        ...new Set(
          p.cues.flatMap((c) => c.words.map((w) => w.scriptChapterId)).filter(Boolean)
        )
      ],
      pauses: clone(p.pauses || []),
      chapters: clone(p.chapters || []),
      speakers: clone(p.speakerNames || {}),
      source: {
        name: p.source.name,
        fingerprint: p.source.fingerprint || null,
        duration: p.source.duration,
        size: p.source.size || null,
        modified: p.source.modified || null,
        path: p.source.path || null,
        relativePath: p.source.relativePath || null
      },
      language: p.language,
      recognition: p.recognition,
      words: p.cues.flatMap((c) => c.words.map((w) => ({ ...w, cueId: c.id }))),
      subtitles: p.cues.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        text: cueText(c),
        wordIds: c.words.map((w) => w.id)
      })),
      originalWords: clone(p.sourceWords),
      notes: "Automatic word times remain approximate. WhisperX provenance is retained when used. Unresolved, edited or imported words may keep earlier or interpolated timing."
    };
  }

  // src/chapters.js
  function chapterSeconds(value) {
    if (value == null || String(value).trim() === "") return null;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || value > 172800) throw Error("Use a chapter time between 0 and 48 hours.");
      return value;
    }
    const text = String(value).trim();
    if (/^\d+(?:[.,]\d{1,3})?$/.test(text)) return chapterSeconds(Number(text.replace(",", ".")));
    const hit = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!hit || +hit[2] > 59 || +hit[3] > 59) throw Error("Use seconds, MM:SS or HH:MM:SS.mmm for chapter times.");
    return chapterSeconds(+(hit[1] || 0) * 3600 + +hit[2] * 60 + +hit[3] + +(hit[4] || "").padEnd(3, "0") / 1e3);
  }
  function installReferenceChapters(project2, reference) {
    const previous = project2.chapters || [];
    const imported = (reference?.chapters || []).filter((c) => c.isHeading && c.title);
    project2.chapters = [
      ...previous.filter((c) => c.origin !== "reference"),
      ...imported.map((c) => {
        const old = previous.find((x) => x.origin === "reference" && x.referenceId === c.id);
        return {
          id: old?.id || uid(),
          title: c.title,
          level: c.level || 1,
          start: old?.timeMode === "manual" ? old.start : null,
          timeMode: old?.timeMode === "manual" ? "manual" : "matched",
          origin: "reference",
          referenceId: c.id,
          anchorWordId: null,
          ...old?.needsReview ? { needsReview: true } : {}
        };
      })
    ];
    return project2.chapters;
  }
  function refreshChapterTimes(project2, matchedReference = null) {
    const words = project2.cues.flatMap((c) => c.words);
    const byId = new Map(words.map((w) => [w.id, w]));
    const mapping = matchedReference ? new Map(matchedReference.mapping) : null;
    const sections = matchedReference?.chapters || [];
    const reliable = !matchedReference || matchedReference.matched >= Math.max(1, matchedReference.words.length * 0.65);
    for (const chapter of project2.chapters || []) {
      if (chapter.timeMode !== "matched") continue;
      let anchor = byId.get(chapter.anchorWordId);
      if (mapping && chapter.origin === "reference") {
        const at = sections.findIndex((c) => c.id === chapter.referenceId);
        anchor = null;
        if (at >= 0 && reliable) {
          const section = sections[at];
          const following = sections.slice(at + 1).find((c) => c.isHeading && (c.level || 1) <= (section.level || 1));
          const end = following?.wordStart ?? matchedReference.words.length;
          for (let i = section.wordStart; i < end; i++) {
            const hit = words[mapping.get(i)];
            if (hit) {
              anchor = hit;
              break;
            }
          }
        }
      }
      chapter.anchorWordId = anchor?.id || null;
      chapter.start = anchor?.start ?? null;
      if (anchor) delete chapter.needsReview;
    }
    return project2.chapters;
  }
  function invalidateChapterTimes(project2) {
    for (const chapter of project2.chapters || []) {
      chapter.anchorWordId = null;
      if (chapter.timeMode === "matched") chapter.start = null;
      else if (chapter.start != null) chapter.needsReview = true;
    }
  }
  function placedChapters(project2) {
    return (project2.chapters || []).filter((c) => Number.isFinite(c.start) && !c.needsReview).slice().sort((a, b) => a.start - b.start || a.level - b.level);
  }
  function transcriptBlocks(project2) {
    const chapters = placedChapters(project2);
    if (!chapters.length) return project2.cues.map((c) => ({ kind: "text", text: cueText(c), start: c.start, end: c.end }));
    const blocks = [];
    let at = 0;
    const headings = (time) => {
      while (at < chapters.length && chapters[at].start <= time + 1e-6) {
        blocks.push({ kind: "heading", ...clone(chapters[at++]) });
      }
    };
    for (const cue of project2.cues) {
      let batch = [], first = 0;
      const flush = () => {
        if (!batch.length) return;
        blocks.push({
          kind: "text",
          text: cueText({ words: batch }),
          start: first === 0 ? cue.start : batch[0].start,
          end: first + batch.length === cue.words.length ? cue.end : batch.at(-1).end
        });
        batch = [];
      };
      cue.words.forEach((word, index) => {
        if (at < chapters.length && chapters[at].start <= word.start + 1e-6) {
          flush();
          headings(word.start);
        }
        if (!batch.length) first = index;
        batch.push(word);
      });
      flush();
    }
    headings(Infinity);
    return blocks;
  }

  // src/save-paths.js
  function normalizedSavePath(value) {
    let p = String(value || "").replace(/\\/g, "/");
    if (p.startsWith("//?/UNC/")) p = "//" + p.slice(8);
    else if (p.startsWith("//?/")) p = p.slice(4);
    return p.replace(/\/+$/, "");
  }
  var windows = (p) => /^[a-z]:\//i.test(p) || p.startsWith("//");
  function savePathIdentity(value) {
    const p = normalizedSavePath(value);
    return windows(p) ? p.toLowerCase() : p;
  }
  function isUnderSaveFolder(value, folder) {
    const p = savePathIdentity(value), root = savePathIdentity(folder);
    return !!root && (p === root || p.startsWith(root + "/"));
  }
  function rebaseSavePath(value, oldFolder, newFolder) {
    if (!value || !isUnderSaveFolder(value, oldFolder)) return value;
    return normalizedSavePath(newFolder) + normalizedSavePath(value).slice(normalizedSavePath(oldFolder).length);
  }

  // src/timing-state.js
  var referenceOf = (p) => p?.useScript === false ? null : p?.referenceInput || p?.availableScript;
  var spokenKey = (p) => JSON.stringify((p?.cues || []).flatMap((c) => c.words).map((w) => w.text).join(" ").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []);
  var referenceKey = (p) => JSON.stringify([p?.source?.fingerprint || p?.source?.path, referenceOf(p)?.words?.map((w) => w.text) || []]);
  var canMatch = (p) => !!(p?.source?.name && referenceOf(p)?.words?.length && p.matchedReferenceKey !== referenceKey(p));
  var needsTiming = (p) => !!p?.cues?.length && (!!p.timingAlignmentPending || !!p.timingsNeedMatch || !!p.wordTimingTextKey && p.wordTimingTextKey !== spokenKey(p));
  function aligned(p, unresolved = 0) {
    p.wordTimingTextKey = spokenKey(p);
    p.timingAlignmentPending = unresolved > 0;
    if (!unresolved) {
      delete p.timingsNeedMatch;
      if (referenceOf(p)) p.matchedReferenceKey = referenceKey(p);
    }
  }

  // src/workflow.js
  var subtitleDefaults = Object.freeze({
    minWords: 1,
    maxWords: 14,
    maxChars: 42,
    lines: 2,
    maxSeconds: 6,
    pauseSeconds: 0.6,
    autoAlign: true,
    speakers: 1,
    mixedLanguages: true
  });
  function subtitleOptions(value = {}) {
    const out = { ...subtitleDefaults, ...value };
    for (const [key2, min, max] of [
      ["minWords", 1, 100],
      ["maxWords", 1, 100],
      ["maxChars", 8, 120],
      ["lines", 1, 2],
      ["maxSeconds", 1, 30],
      ["pauseSeconds", 0.1, 10],
      ["speakers", 0, 20]
    ]) {
      const n = Number(out[key2]);
      if (!Number.isFinite(n) || n < min || n > max)
        throw Error("Invalid " + key2 + " setting.");
      out[key2] = ["maxSeconds", "pauseSeconds"].includes(key2) ? n : Math.round(n);
    }
    if (out.minWords > out.maxWords)
      throw Error("Minimum words cannot exceed maximum words.");
    out.autoAlign = !!out.autoAlign;
    out.mixedLanguages = !!out.mixedLanguages;
    return out;
  }
  function captionLines(words, options = {}) {
    const { maxChars, lines } = subtitleOptions(options), result = [];
    let line = "";
    for (const w of words) {
      if (line && w.gap?.includes("\n")) {
        result.push(line);
        line = "";
      }
      const body = String(w.text).replace(/\s+/gu, " "), gap = line ? w.gap || "" : "";
      if (line && [...line + gap + body].length > maxChars) {
        result.push(line);
        line = body;
      } else line += gap + body;
    }
    if (line) result.push(line);
    return {
      text: result.join("\n"),
      fits: result.length <= lines && result.every((s) => [...s].length <= maxChars)
    };
  }
  function resegment(project2, settings = {}) {
    const opts = subtitleOptions(settings), words = project2.cues.flatMap((c) => clone(c.words)), cues = [];
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      cues.push({
        id: uid(),
        start: batch[0].start,
        end: batch.at(-1).end,
        words: batch,
        speaker: batch[0].speaker || "Speaker 1",
        layoutWarning: !captionLines(batch, opts).fits
      });
      batch = [];
    };
    for (const w of words) {
      const last = batch.at(-1);
      const hard = last && (w.start - last.end >= opts.pauseSeconds || w.speaker !== last.speaker || w.language && last.language && w.language !== last.language);
      const capacity = batch.length && (batch.length >= opts.maxWords || w.end - batch[0].start > opts.maxSeconds || !captionLines([...batch, w], opts).fits);
      const sentence = last && batch.length >= opts.minWords && /[.!?。！？]$/u.test(last.text);
      if (hard || capacity || sentence) flush();
      batch.push(w);
    }
    flush();
    for (let i = 1; i < cues.length; i++) {
      const a = cues[i - 1], b = cues[i], all = [...a.words, ...b.words];
      if (b.words.length < opts.minWords && b.start - a.end < opts.pauseSeconds && a.speaker === b.speaker && all.length <= opts.maxWords && b.end - a.start <= opts.maxSeconds && captionLines(all, opts).fits) {
        a.words = all;
        a.end = b.end;
        cues.splice(i--, 1);
      }
    }
    project2.cues = cues;
    project2.subtitleOptions = opts;
    return cues;
  }
  var normalized = (s) => String(s).normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  var pausePattern = /[\[(]\s*((?:(?:very\s+)?(?:short|long|brief)\s+)?(?:pause|silence)|(?:pausa|sil[eê]ncio)(?:\s+(?:curt[ao]|long[ao]|breve))?)\s*[\])]/giu;
  function parseScript(raw) {
    if (typeof raw === "string") {
      try {
        const json = JSON.parse(raw);
        if (json?.format === "subtitler-script-v1") return parseScript(json);
      } catch {
      }
      return scriptChapters([{ id: null, title: "Script", text: raw, isHeading: false }]);
    }
    if (raw?.format !== "subtitler-script-v1" || raw.schemaVersion !== 1 || !Array.isArray(raw.chapters) || raw.chapters.length > 1e4)
      throw Error(
        "Choose a spoken script exported by Storyboard Studio, DOCX, or TXT."
      );
    const out = scriptChapters(raw.chapters);
    out.studioProjectId = raw.studioProjectId || raw.project?.id || null;
    out.projectName = raw.project?.name || "";
    return out;
  }
  function scriptChapters(chapters) {
    const words = [], markers = [], sectionsOut = [];
    let total = 0;
    for (const [chapterIndex, ch] of chapters.entries()) {
      const wordStart = words.length;
      const chapterId = ch.id || (ch.isHeading !== false && ch.title ? "reference-section-" + chapterIndex : null);
      if (typeof ch.text !== "string")
        throw Error("The script contains invalid chapter text.");
      total += ch.text.length;
      if (total > 2e6)
        throw Error("Import a script shorter than 2 million characters.");
      const text = ch.text, ranged = Array.isArray(ch.ranges), pauses = [...ch.pauses || []];
      for (const m of ranged ? [] : text.matchAll(pausePattern))
        if (!pauses.some((p) => p.from === m.index))
          pauses.push({
            id: uid(),
            from: m.index,
            to: m.index + m[0].length,
            label: m[1]
          });
      let masked = text;
      for (const p of pauses.slice().sort((a, b) => b.from - a.from))
        if (Number.isInteger(p.from) && p.from >= 0 && p.to > p.from && p.to <= text.length)
          masked = masked.slice(0, p.from) + " ".repeat(p.to - p.from) + masked.slice(p.to);
      const sections = ranged ? ch.ranges : [{ from: 0, text: masked }];
      for (const section of sections) {
        if (typeof section.text !== "string" || !Number.isInteger(section.from) || section.from < 0)
          throw Error("Invalid script range.");
        let offset = section.from;
        for (const part of section.text.match(/[^\n]*(?:\n|$)/gu) || []) {
          if (part.length > 2e4) throw Error("A script paragraph is too long.");
          for (const w of tokenize(part))
            words.push({
              ...w,
              from: w.from + offset,
              to: w.to + offset,
              chapterId
            });
          offset += part.length;
        }
      }
      for (const p of pauses) {
        const before = words.map((w, i) => ({ w, i })).filter((x) => x.w.chapterId === chapterId && x.w.to <= p.from).at(-1)?.i ?? null;
        const after = words.findIndex(
          (w) => w.chapterId === chapterId && w.from >= p.to
        );
        markers.push({
          id: p.id || uid(),
          label: p.label || "Pause",
          chapterId,
          before,
          after: after < 0 ? null : after
        });
      }
      sectionsOut.push({
        id: chapterId,
        title: String(ch.title || "").slice(0, 200),
        number: ch.number || "",
        text: ch.text,
        level: Number.isInteger(ch.level) ? Math.max(1, Math.min(6, ch.level)) : 1,
        isHeading: ch.isHeading !== false && !!ch.title,
        wordStart,
        wordEnd: words.length
      });
    }
    return {
      words,
      markers,
      chapters: sectionsOut
    };
  }
  async function docxScript(data) {
    if (!globalThis.JSZip) throw Error("Document reader unavailable.");
    const zip = await JSZip.loadAsync(data);
    const entry = zip.file("word/document.xml");
    if (!entry || entry._data?.uncompressedSize > 8e6)
      throw Error("Choose a DOCX with less than 8 MB of script text.");
    const xml2 = new DOMParser().parseFromString(
      await entry.async("string"),
      "application/xml"
    );
    if (xml2.querySelector("parsererror"))
      throw Error("The DOCX text could not be read.");
    const attr = (el, name) => el?.getAttributeNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", name) || el?.getAttribute("w:" + name);
    const child = (el, name) => [...el?.children || []].find((c) => c.localName === name);
    const styles = /* @__PURE__ */ new Map();
    if (zip.file("word/styles.xml")) {
      if (zip.file("word/styles.xml")._data?.uncompressedSize > 2e6) throw Error("The DOCX heading styles are too large to import safely.");
      const document2 = new DOMParser().parseFromString(await zip.file("word/styles.xml").async("string"), "application/xml");
      for (const style of document2.getElementsByTagNameNS("*", "style")) {
        const outline = attr(child(child(style, "pPr"), "outlineLvl"), "val");
        styles.set(attr(style, "styleId"), { base: attr(child(style, "basedOn"), "val"), outline: outline == null ? null : Number(outline), name: attr(child(style, "name"), "val") || "" });
      }
    }
    const headingLevel = (styleId, seen = /* @__PURE__ */ new Set()) => {
      if (!styleId || seen.has(styleId)) return null;
      seen.add(styleId);
      const style = styles.get(styleId);
      if (style?.outline != null && style.outline >= 0 && style.outline < 6) return style.outline + 1;
      const named = [styleId, style?.name || ""].map((s) => s.replace(/\s/g, "")).find((s) => /^heading[1-6]$/i.test(s));
      if (named) return +named.at(-1);
      return headingLevel(style?.base, seen);
    };
    const sections = [];
    const paragraphText = (p) => {
      let text = "";
      const walk = (element) => {
        for (const node of element.children) {
          if (node.localName === "t") text += node.textContent;
          else if (node.localName === "tab") text += "	";
          else if (["br", "cr"].includes(node.localName)) text += "\n";
          else if (!["pPr", "rPr"].includes(node.localName)) walk(node);
        }
      };
      walk(p);
      return text;
    };
    let current = { id: "docx-intro", title: "", text: "", isHeading: false };
    const paragraphs = [...xml2.getElementsByTagNameNS("*", "p")];
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i], pr = child(p, "pPr"), styleId = attr(child(pr, "pStyle"), "val");
      const direct = attr(child(pr, "outlineLvl"), "val");
      const level = direct != null ? +direct >= 0 && +direct < 6 ? +direct + 1 : null : headingLevel(styleId);
      const text = paragraphText(p);
      if (level && text.trim()) {
        if (current.text || current.isHeading) sections.push(current);
        current = { id: "docx-heading-" + i, title: text.trim(), level, isHeading: true, text: "" };
      } else if (!/^title$/i.test(styleId || "") && !/^title$/i.test(styles.get(styleId)?.name || "")) {
        current.text += (current.text ? "\n" : "") + text;
      }
    }
    if (current.text || current.isHeading) sections.push(current);
    return parseScript({ format: "subtitler-script-v1", schemaVersion: 1, chapters: sections });
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
          last + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        last = prior;
      }
    }
    return row[b.length];
  }
  function matchScript(project2, script, { correct = true } = {}) {
    const recognized = project2.cues.flatMap((c) => c.words), reference = script.words;
    if (reference.length > 3e4 || recognized.length > 3e4)
      throw Error("Match up to 30,000 words per recording.");
    const band = Math.max(
      100,
      Math.abs(reference.length - recognized.length) + 50
    );
    if (band > 1500)
      throw Error(
        "This script differs too much from the recording. Select a closer script or transcribe without it."
      );
    const keys = reference.map((w) => normalized(w.text)), heard = recognized.map((w) => normalized(w.text)), trace = [];
    let previous = new Float64Array(recognized.length + 1);
    previous.fill(Infinity);
    for (let i2 = 0; i2 <= reference.length; i2++) {
      const current = new Float64Array(recognized.length + 1);
      current.fill(Infinity);
      const start2 = Math.max(0, i2 - band), end = Math.min(recognized.length, i2 + band), ops = new Uint8Array(end - start2 + 1);
      trace.push({ start: start2, ops });
      for (let j2 = start2; j2 <= end; j2++) {
        if (!i2 && !j2) {
          current[j2] = 0;
          continue;
        }
        const a = keys[i2 - 1] || "", b = heard[j2 - 1] || "";
        const similar = a && b && Math.max(a.length, b.length) >= 4 && Math.max(a.length, b.length) <= 80 && Math.abs(a.length - b.length) <= Math.max(a.length, b.length) * 0.34 && distance(a, b) / Math.max(a.length, b.length) <= 0.34;
        const paired = i2 && j2 ? previous[j2 - 1] + (a === b ? 0 : similar ? 0.8 : 1.8) : Infinity, omitted = i2 ? previous[j2] + 1 : Infinity, added = j2 ? current[j2 - 1] + 1 : Infinity;
        if (paired <= omitted && paired <= added) {
          current[j2] = paired;
          ops[j2 - start2] = similar ? 4 : 1;
        } else if (omitted <= added) {
          current[j2] = omitted;
          ops[j2 - start2] = 2;
        } else {
          current[j2] = added;
          ops[j2 - start2] = 3;
        }
      }
      previous = current;
    }
    const mapping = /* @__PURE__ */ new Map(), changes = [];
    let i = reference.length, j = recognized.length;
    while (i || j) {
      const op = trace[i].ops[j - trace[i].start];
      if (!op) throw Error("Script matching could not finish.");
      const step = { similar: op === 4 };
      if (op === 1 || op === 4) {
        const s = reference[--i], w = recognized[--j], same = normalized(s.text) === normalized(w.text);
        if (same || step.similar) {
          mapping.set(i, j);
          w.scriptChapterId = s.chapterId;
          w.scriptWordIndex = i;
          const confident = w.confidence != null && w.confidence >= 0.6;
          if (correct && (same || step.similar && !confident && w.confidence != null) && w.text !== s.text) {
            changes.push({
              kind: "reference-correction",
              recognized: w.text,
              script: s.text,
              wordId: w.id
            });
            w.text = s.text;
            w.referenceCorrected = true;
          }
        } else
          changes.push({
            kind: "different",
            recognized: w.text,
            script: s.text,
            wordId: w.id
          });
      } else if (op === 2) {
        changes.push({ kind: "omitted", script: reference[--i].text });
      } else
        changes.push({
          kind: "added",
          recognized: recognized[--j].text,
          wordId: recognized[j].id
        });
    }
    project2.scriptReference = {
      ...clone(script),
      mapping: [...mapping],
      changes: changes.reverse(),
      matched: mapping.size,
      referenceWords: reference.length
    };
    refreshChapterTimes(project2, project2.scriptReference);
    return project2.scriptReference;
  }
  function attachPauses(project2, intervals, threshold = 0.6) {
    if (!Array.isArray(intervals)) throw Error("Invalid silence result.");
    const old = project2.pauses || [], duration = project2.source.duration;
    project2.pauses = intervals.filter(
      (p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end <= duration + 0.01 && p.end - p.start >= threshold - 1e-3
    ).map((p) => ({
      id: old.find(
        (o) => Math.abs(o.start - p.start) < 0.02 && Math.abs(o.end - p.end) < 0.02
      )?.id || uid(),
      label: "Silence",
      start: p.start,
      end: Math.min(p.end, duration),
      method: p.method || "audio-level",
      ...p.noiseDb != null ? { noiseDb: p.noiseDb } : {}
    }));
    project2.pauses.sort((a, b) => a.start - b.start);
    project2.pauses = project2.pauses.reduce((out, pause) => {
      const old2 = out.at(-1);
      if (old2 && pause.start <= old2.end + 5e-3) old2.end = Math.max(old2.end, pause.end);
      else out.push(pause);
      return out;
    }, []);
    const ref = project2.scriptReference;
    if (ref) {
      const map = new Map(ref.mapping), words = project2.cues.flatMap((c) => c.words);
      for (const marker of ref.markers) {
        const left = marker.before === null ? 0 : words[map.get(marker.before)]?.end, right = marker.after === null ? duration : words[map.get(marker.after)]?.start;
        if (left == null || right == null || right <= left) continue;
        const candidates = project2.pauses.filter(
          (p) => !p.markerId && p.start >= left - 0.12 && p.end <= right + 0.12
        ).sort((a, b) => b.end - b.start - (a.end - a.start));
        if (candidates[0])
          Object.assign(candidates[0], {
            markerId: marker.id,
            chapterId: marker.chapterId,
            label: marker.label
          });
      }
    }
    return project2.pauses;
  }
  function timingDiagnostics(project2) {
    const words = project2.cues.flatMap((c) => c.words);
    return {
      words: words.length,
      estimated: words.filter((w) => w.timing === "estimated").length,
      veryShort: words.filter((w) => w.end - w.start < 0.06).map((w) => w.id),
      unresolved: words.filter((w) => w.alignmentIssue).map((w) => w.id)
    };
  }

  // src/match-timing.js
  function retimeImported(original, recognized) {
    const reference = parseScript(original.cues.map(cueText).join("\n"));
    const matched = matchScript(recognized, reference, { correct: false });
    if (matched.matched < Math.max(1, reference.words.length * 0.65)) throw Error("Not enough subtitle text matched this recording. Previous subtitles and timings were kept.");
    const heard = recognized.cues.flatMap((c) => c.words), mapping = new Map(matched.mapping), words = original.cues.flatMap((c) => c.words), next = clone(original);
    if (words.length !== reference.words.length) throw Error("The subtitle text could not be matched safely.");
    const targets = next.cues.flatMap((c) => c.words);
    for (let i = 0; i < targets.length; i++) {
      const hit = heard[mapping.get(i)];
      if (hit) {
        Object.assign(targets[i], { start: hit.start, end: hit.end, timing: hit.timing, alignmentEngine: hit.alignmentEngine });
        continue;
      }
      let a = i - 1, b = i + 1;
      while (a >= 0 && !mapping.has(a)) a--;
      while (b < targets.length && !mapping.has(b)) b++;
      const start2 = a >= 0 ? heard[mapping.get(a)].end : 0, end = b < targets.length ? heard[mapping.get(b)].start : recognized.source.duration;
      if (end <= start2) throw Error("Unmatched subtitle words have no usable timing interval. Previous timing was kept.");
      const span = (end - start2) / (b - a - 1);
      targets[i].start = start2 + (i - a - 1) * span;
      targets[i].end = targets[i].start + span;
      targets[i].timing = "estimated";
    }
    next.cues.forEach((c) => {
      c.start = c.words[0].start;
      c.end = c.words.at(-1).end;
    });
    next.source = recognized.source;
    next.recognition = { ...recognized.recognition, note: "Imported text and subtitle division preserved." };
    next.sourceWords = recognized.sourceWords;
    next.pauses = recognized.pauses;
    next.timingsNeedMatch = false;
    return next;
  }

  // src/document-model.js
  var pathKey = savePathIdentity;
  function contentKey(project2) {
    const p = clone(project2);
    for (const key2 of ["updatedAt", "lastOpenedAt", "closed", "drafts", "privateFile", "openedFile", "filePath", "lastSyncedAt"]) delete p[key2];
    if (p.studioLink) {
      delete p.studioLink.projectFile;
    }
    if (p.source) delete p.source.embeddedPath;
    return JSON.stringify(p);
  }
  function standalone(project2, name = project2.name) {
    const p = clone(project2);
    p.id = uid();
    p.name = name;
    for (const key2 of ["studioLink", "availableScript", "scriptReference", "privateFile", "openedFile", "filePath", "previousTranscription"]) delete p[key2];
    p.closed = false;
    p.drafts = {};
    return p;
  }
  function openedDocument(raw, actualPath) {
    let p = validateProject({ ...raw, format: "whisperdesk-project-v1" });
    const recorded = p.filePath || p.studioLink?.projectFile || p.openedFile || p.privateFile;
    if (!recorded || pathKey(recorded) !== pathKey(actualPath)) p = standalone(p);
    p.filePath = actualPath;
    p.closed = false;
    delete p.privateFile;
    delete p.openedFile;
    return p;
  }
  function distinctName(name, projects2) {
    const names = new Set(projects2.map((p) => p.name));
    if (!names.has(name)) return name;
    let n = 2;
    while (names.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
  }

  // src/recognition-quality.js
  var token = (s) => String(s).toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
  function recognitionQuality(raw, reference, duration) {
    const segments = (raw.transcription || []).filter((s) => s.text?.trim()), words = segments.map((s) => s.text).join(" ").match(/[\p{L}\p{N}]+/gu) || [], refs = (reference?.words || []).map((w) => token(w.text)).filter(Boolean), found = new Set(words.map(token)), coverage = refs.length ? refs.filter((w) => found.has(w)).length / refs.length : 1, overflow = segments.some((s) => (s.offsets?.to / 1e3 || 0) > duration + 0.35), count = /* @__PURE__ */ new Map();
    for (let i = 0; i + 4 < words.length; i++) {
      const key2 = words.slice(i, i + 5).join(" ").toLowerCase();
      count.set(key2, (count.get(key2) || 0) + 1);
    }
    const repeated = [...count.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0) / Math.max(1, words.length);
    return { coverage, overflow, repeated, score: coverage - repeated * 2 - (overflow ? 2 : 0), suspicious: overflow || refs.length > 12 && coverage < 0.7 || repeated > 0.2 };
  }

  // src/recording-identity.js
  var path = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/^file:\/\/(?:localhost)?/, "");
  var source = (t) => ({ ...t.source || t, path: t.audioPath || t.source?.path || t.path });
  function sameRecording(a, b) {
    a = source(a);
    b = source(b);
    if (a.fingerprint && b.fingerprint) return a.fingerprint === b.fingerprint;
    const changed = a.size && b.size && a.size !== b.size || a.modified && b.modified && a.modified !== b.modified;
    if (changed) return false;
    if (a.path && b.path) return path(a.path) === path(b.path);
    if (a.relativePath && b.relativePath) return path(a.relativePath) === path(b.relativePath);
    return false;
  }

  // src/workspace-discovery.js
  function transcriptCandidate(audio, projects2, saved = []) {
    const candidates = [...projects2.map((p) => ({ project: p, id: p.id, source: p.source, updatedAt: p.updatedAt, cueCount: p.cues?.length || 0, studioProjectId: p.studioLink?.projectId })), ...saved];
    return candidates.filter((p) => sameRecording(p.source, audio)).sort(
      (a, b) => Number(b.cueCount > 0) - Number(a.cueCount > 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || Number(!!b.project) - Number(!!a.project)
    )[0] || null;
  }

  // src/studio-link.js
  function createStudioLink(host) {
    let timer = null, busy = false, again = false, last = "", status = "", error = false, pending = null;
    const native2 = () => !!window.__TAURI__?.core?.invoke, invoke2 = (n, a) => window.__TAURI__.core.invoke(n, a);
    function show(text, failed = false) {
      status = text;
      error = failed;
      host.status?.(text, failed);
    }
    async function refresh() {
      const p = host.project(), link = p?.studioLink;
      if (!native2() || !link?.directory) return;
      try {
        const result = await invoke2("inspect_project_folder", {
          directory: link.directory,
          expectedProjectId: link.projectId || null,
          audioRelativePath: p.source.relativePath || null
        });
        if (host.project()?.id !== p.id) return;
        link.directory = result.directory;
        link.projectId = result.projectId || null;
        link.projectName = result.projectName || "";
        host.connected?.(link);
        if (result.script) {
          const script = parseScript(result.script);
          const changed = JSON.stringify(p.availableScript) !== JSON.stringify(script);
          p.availableScript = script;
          if (changed) host.persist?.();
        }
        show(
          result.warnings?.join(" ") || "Studio Link connected",
          !!result.warnings?.length
        );
        schedule();
      } catch (e) {
        show(
          "Project folder unavailable. Relink it in Settings. " + String(e.message || e),
          true
        );
      }
    }
    async function choose() {
      if (!native2()) throw Error("Choose a project folder in the installed app.");
      const directory = await invoke2("choose_project_folder");
      if (!directory) return;
      if (host.openWorkspace) {
        const info = await invoke2("inspect_project_folder", { directory, expectedProjectId: null, audioRelativePath: null });
        last = "";
        await host.openWorkspace(info);
        return;
      }
      const p = host.project(), result = await invoke2("inspect_project_folder", {
        directory,
        expectedProjectId: p.source.name || p.cues.length ? p.studioLink?.projectId || null : null,
        audioRelativePath: p.source.relativePath || null
      });
      if (host.project()?.id !== p.id) return;
      p.studioLink = {
        ...p.studioLink,
        directory: result.directory,
        projectId: result.projectId || null,
        projectName: result.projectName || ""
      };
      host.connected?.(p.studioLink);
      if (result.script) p.availableScript = parseScript(result.script);
      last = "";
      host.persist?.();
      show(
        result.warnings?.join(" ") || "Studio Link connected",
        !!result.warnings?.length
      );
      await flush();
      host.render?.();
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(() => {
      }), 1200);
    }
    async function flush() {
      clearTimeout(timer);
      const p = host.project(), link = p?.studioLink;
      if (!native2() || !link?.directory || !p.source.name && !p.cues.length)
        return false;
      if (busy) {
        again = true;
        if (pending) await pending;
        return flush();
      }
      const snapshot = clone(p);
      delete snapshot.drafts;
      const timing = timingExport(snapshot), fingerprint = JSON.stringify([
        link.directory,
        { ...snapshot, updatedAt: "", lastOpenedAt: "", closed: false, lastSyncedAt: null },
        { ...timing, exportedAt: "" }
      ]);
      if (last === fingerprint) return true;
      busy = true;
      try {
        const result = await (pending = invoke2("save_project_files", {
          directory: link.directory,
          studioProjectId: link.projectId || null,
          projectId: p.id,
          filename: (p.name || "Transcript") + ".subtitler",
          projectData: JSON.stringify(snapshot),
          timingData: JSON.stringify(timing)
        }));
        if (host.project()?.id === p.id) {
          const metadataChanged = result.audioRelativePath && p.source.relativePath !== result.audioRelativePath || link.projectFile !== result.projectFile;
          if (result.audioRelativePath)
            p.source.relativePath = result.audioRelativePath;
          link.projectFile = result.projectFile;
          p.filePath = result.projectFile;
          last = fingerprint;
          if (metadataChanged) host.persist?.();
          show(result.warning || "Timing shared with Storyboard Studio", !!result.warning);
          host.saved?.(result.projectFile);
        }
        return true;
      } catch (e) {
        show(String(e.message || e), true);
        return false;
      } finally {
        busy = false;
        if (again) {
          again = false;
          schedule();
        }
      }
    }
    return {
      choose,
      refresh,
      schedule,
      flush,
      status: () => ({ text: status, error }),
      reset: () => {
        clearTimeout(timer);
        last = "";
        status = "";
        error = false, pending = null;
        host.status?.("", false);
      }
    };
  }

  // src/alignment.js
  function alignmentRequest(project2, language, threads = 6) {
    if (!["auto", "en", "pt", "es", "ja"].includes(language))
      throw Error("Choose the recording’s language for alignment.");
    if (!project2?.cues?.length) throw Error("Transcribe the recording first.");
    return {
      language,
      fallbackLanguage: project2.language,
      threads,
      duration: project2.source.duration,
      audioFingerprint: project2.source.fingerprint || null,
      cues: project2.cues.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        language: c.language || null,
        words: c.words.map((w) => ({
          id: w.id,
          text: w.text,
          start: w.start,
          end: w.end
        }))
      }))
    };
  }
  function applyAlignment(project2, reply, { replaceManual = false } = {}) {
    if (reply?.format !== "subtitler-alignment-v1" || !Array.isArray(reply.cues) || reply.cues.length !== project2.cues.length)
      throw Error(
        "WhisperX returned an incomplete result. Existing timings are preserved."
      );
    const next = clone(project2.cues), seen = /* @__PURE__ */ new Set();
    let aligned2 = 0, protectedWords = 0, unresolved = 0;
    const issues = [];
    for (let i = 0; i < next.length; i++) {
      const cue = next[i], row = reply.cues[i];
      if (row?.id !== cue.id || !Array.isArray(row.words) || row.words.length !== cue.words.length)
        throw Error("Alignment no longer matches the transcript. Run it again.");
      for (let j = 0; j < cue.words.length; j++) {
        const w = cue.words[j], hit = row.words[j];
        if (hit?.id !== w.id || seen.has(hit.id))
          throw Error("Alignment word identities do not match.");
        seen.add(hit.id);
        if (w.timing === "manual" && !replaceManual) {
          protectedWords++;
          continue;
        }
        if (hit.status !== "aligned") {
          unresolved++;
          w.alignmentIssue = "WhisperX could not align this word";
          continue;
        }
        if (!Number.isFinite(hit.start) || !Number.isFinite(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > (Number.isFinite(reply.duration) ? reply.duration : project2.source.duration) + 1e-3)
          throw Error("WhisperX returned invalid word timing.");
        w.start = hit.start;
        w.end = hit.end;
        w.timing = "whisper";
        w.alignmentEngine = "whisperx";
        w.alignmentScore = hit.score ?? null;
        if (hit.language) w.language = hit.language;
        if (hit.speaker) w.speaker = hit.speaker;
        delete w.alignmentIssue;
      }
      if (row.issue) issues.push({ cueId: cue.id, message: row.issue });
    }
    const rejected = /* @__PURE__ */ new Set();
    const updated = (i) => !rejected.has(i) && reply.cues[i].words.some(
      (hit, j) => hit.status === "aligned" && (replaceManual || project2.cues[i].words[j].timing !== "manual")
    );
    const bounds = (i) => updated(i) ? [next[i].words[0].start, next[i].words.at(-1).end] : [project2.cues[i].start, project2.cues[i].end];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < next.length; i++) {
        if (rejected.has(i)) continue;
        const c = next[i], old = project2.cues[i];
        const [a, b] = bounds(i);
        const bad = c.words.some((w, j) => j && w.start < c.words[j - 1].end - 1e-3) || a >= b;
        const prev = i ? bounds(i - 1)[1] : 0, nextStart = i + 1 < next.length ? bounds(i + 1)[0] : Infinity;
        if (bad || a < prev - 1e-3 || b > nextStart + 1e-3) {
          next[i] = clone(old);
          rejected.add(i);
          issues.push({
            cueId: c.id,
            message: "Timing conflict; this subtitle kept its previous timing."
          });
          changed = true;
        }
      }
    }
    unresolved = 0;
    aligned2 = 0;
    protectedWords = 0;
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      const updated2 = reply.cues[i].words.some(
        (hit, j) => hit.status === "aligned" && (replaceManual || project2.cues[i].words[j].timing !== "manual")
      );
      if (updated2) {
        c.start = c.words[0].start;
        c.end = c.words.at(-1).end;
      }
      if (rejected.has(i)) {
        c.start = project2.cues[i].start;
        c.end = project2.cues[i].end;
      }
      c.words.forEach((w, j) => {
        if (project2.cues[i].words[j].timing === "manual" && !replaceManual)
          protectedWords++;
        else if (!rejected.has(i) && reply.cues[i].words[j].status === "aligned")
          aligned2++;
        else unresolved++;
      });
    }
    if (!aligned2)
      throw Error(
        "No word timings could be safely updated. Previous timings are preserved. Check the language and transcript, or split long subtitle blocks."
      );
    project2.cues = next;
    if (Number.isFinite(reply.duration)) project2.source.duration = reply.duration;
    project2.recognition = {
      ...project2.recognition,
      alignment: {
        engine: "WhisperX",
        version: reply.version,
        language: reply.language,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        aligned: aligned2,
        unresolved,
        protectedWords,
        issues
      }
    };
    return { aligned: aligned2, unresolved, protectedWords, issues };
  }

  // src/exports.js
  var xml = (s) => String(s ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;"
    })[c]
  );
  var declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var safeName = (s) => String(s || "Transcript").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120).trim() || "Transcript";
  function textExport(p, timestamps = false) {
    return transcriptBlocks(p).map((c) => c.kind === "heading" ? c.title : (timestamps ? `[${clock(c.start)} → ${clock(c.end)}] ` : "") + c.text).join("\n\n") + "\n";
  }
  function wrapCaption(text, limit = 42) {
    const lines = [];
    for (const para of text.split("\n")) {
      if ([...para].length <= limit) {
        lines.push(para);
        continue;
      }
      let line = "";
      for (const token2 of para.match(/\S+\s*|\s+/gu) || []) {
        if (line && [...line + token2].length > limit) {
          lines.push(line.trimEnd());
          line = "";
        }
        if ([...token2].length > limit) {
          for (const ch of token2) {
            if ([...line].length >= limit) {
              lines.push(line.trimEnd());
              line = "";
            }
            line += ch;
          }
        } else line += token2;
      }
      if (line) lines.push(line.trimEnd());
    }
    return lines.join("\n");
  }
  function srtExport(p) {
    return p.cues.map(
      (c, i) => `${i + 1}
${clock(c.start, ",")} --> ${clock(c.end, ",")}
${p.subtitleOptions ? captionLines(c.words, p.subtitleOptions).text : wrapCaption(cueText(c))}
`
    ).join("\n");
  }
  var csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  function csvExport(p) {
    return "\uFEFF" + [
      [
        "Subtitle",
        "Start",
        "End",
        "Start seconds",
        "End seconds",
        "Text",
        "Timing"
      ],
      ...p.cues.map((c, i) => [
        i + 1,
        clock(c.start),
        clock(c.end),
        c.start.toFixed(3),
        c.end.toFixed(3),
        cueText(c),
        c.words.some((w) => w.timing === "estimated") ? "Review word timing" : "Automatic / manual"
      ])
    ].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  function archive() {
    if (!globalThis.JSZip)
      throw Error("The bundled document exporter could not load.");
    return new globalThis.JSZip();
  }
  var relationships = (entries) => declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + entries.map(
    ([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  ).join("") + "</Relationships>";
  async function docxExport(p, timestamps = false) {
    const z = archive();
    z.file(
      "[Content_Types].xml",
      declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
    );
    z.file(
      "_rels/.rels",
      relationships([["rId1", "officeDocument", "word/document.xml"]])
    );
    z.file(
      "word/_rels/document.xml.rels",
      relationships([["rId1", "styles", "styles.xml"]])
    );
    const paragraph = (text, style = null) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:spacing w:after="180"/></w:pPr><w:r><w:t xml:space="preserve">${xml(text).replaceAll("\n", '</w:t><w:br/><w:t xml:space="preserve">')}</w:t></w:r></w:p>`;
    z.file(
      "word/document.xml",
      declaration + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(p.name, "Title")}${transcriptBlocks(p).map((c) => c.kind === "heading" ? paragraph(c.title, "Heading" + c.level) : paragraph((timestamps ? `[${clock(c.start)} → ${clock(c.end)}] ` : "") + c.text)).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
    );
    z.file(
      "word/styles.xml",
      declaration + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:eastAsia="Yu Mincho"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>' + Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.max(24, 36 - i * 2)}"/></w:rPr></w:style>`).join("") + "</w:styles>"
    );
    return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
  var colName = (i) => {
    let s = "";
    for (let n = i + 1; n; n = Math.floor((n - 1) / 26))
      s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  };
  function worksheet(rows, widths) {
    return declaration + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colName(widths.length - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.map((row, r) => {
      const height = r ? Math.min(
        240,
        Math.max(
          30,
          Math.ceil(String(row[5] || "").length / 70) * 16 + 12
        )
      ) : 28;
      return `<row r="${r + 1}" ht="${height}" customHeight="1">${row.map((v, c) => typeof v === "number" ? `<c r="${colName(c)}${r + 1}" s="${r ? 1 : 2}"><v>${v}</v></c>` : `<c r="${colName(c)}${r + 1}" s="${r ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join("")}</row>`;
    }).join(
      ""
    )}</sheetData><autoFilter ref="A1:${colName(widths.length - 1)}${rows.length}"/></worksheet>`;
  }
  async function xlsxExport(p) {
    const z = archive(), captions = [
      [
        "Subtitle",
        "Start",
        "End",
        "Start seconds",
        "End seconds",
        "Text",
        "Timing"
      ],
      ...p.cues.map((c, i) => [
        i + 1,
        clock(c.start),
        clock(c.end),
        +c.start.toFixed(3),
        +c.end.toFixed(3),
        cueText(c),
        c.words.some((w) => w.timing === "estimated") ? "Review word timing" : "Automatic / manual"
      ])
    ], words = [
      ["Subtitle", "Word", "Start seconds", "End seconds", "Timing", "Word ID"],
      ...p.cues.flatMap(
        (c, i) => c.words.map((w) => [
          i + 1,
          w.text,
          +w.start.toFixed(3),
          +w.end.toFixed(3),
          w.timing,
          w.id
        ])
      )
    ];
    z.file(
      "[Content_Types].xml",
      declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + [1, 2].map(
        (i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      ).join("") + "</Types>"
    );
    z.file(
      "_rels/.rels",
      relationships([["rId1", "officeDocument", "xl/workbook.xml"]])
    );
    z.file(
      "xl/workbook.xml",
      declaration + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Subtitles" sheetId="1" r:id="rId1"/><sheet name="Words" sheetId="2" r:id="rId2"/></sheets></workbook>'
    );
    z.file(
      "xl/_rels/workbook.xml.rels",
      relationships([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "worksheet", "worksheets/sheet2.xml"],
        ["rId3", "styles", "styles.xml"]
      ])
    );
    z.file(
      "xl/styles.xml",
      declaration + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF27776D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    );
    z.file(
      "xl/worksheets/sheet1.xml",
      worksheet(captions, [10, 17, 17, 17, 17, 76, 25])
    );
    z.file(
      "xl/worksheets/sheet2.xml",
      worksheet(words, [10, 35, 17, 17, 18, 40])
    );
    return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
  async function makeExport(p, format, options = {}) {
    let data, mime = "text/plain;charset=utf-8";
    if (format === "txt") data = textExport(p, options.timestamps);
    else if (format === "srt") {
      data = srtExport(p);
      mime = "application/x-subrip";
    } else if (format === "csv") {
      data = csvExport(p);
      mime = "text/csv;charset=utf-8";
    } else if (format === "docx") {
      data = await docxExport(p, options.timestamps);
      mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (format === "xlsx") {
      data = await xlsxExport(p);
      mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (format === "json") {
      data = JSON.stringify(timingExport(p), null, 2);
      mime = "application/json";
    } else if (format === "subtitler" || format === "whisperdesk") {
      const saved = { ...p };
      delete saved.drafts;
      data = JSON.stringify(saved);
      mime = "application/json";
    } else throw Error("Unknown export format");
    return { data, mime, name: safeName(p.name) + "." + format };
  }

  // src/db.js
  var opening;
  function db() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request, finished = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        opening = null;
        reject(error);
      };
      const timer = setTimeout(
        () => fail(
          Error(
            "Saved transcripts could not be opened. Close other Subtitler windows, then retry. No saved data was deleted."
          )
        ),
        5e3
      );
      try {
        request = indexedDB.open("whisper-desk-v1", 2);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("projects"))
          request.result.createObjectStore("projects", { keyPath: "id" });
        if (!request.result.objectStoreNames.contains("audio"))
          request.result.createObjectStore("audio");
        if (!request.result.objectStoreNames.contains("waveforms"))
          request.result.createObjectStore("waveforms");
      };
      request.onsuccess = () => {
        if (finished) {
          request.result.close();
          return;
        }
        finished = true;
        clearTimeout(timer);
        const connection = request.result;
        connection.onversionchange = () => {
          connection.close();
          opening = null;
        };
        resolve(connection);
      };
      request.onerror = () => fail(request.error || Error("Saved transcripts could not be opened."));
      request.onblocked = () => fail(
        Error(
          "Another Subtitler window is blocking storage. Close it and retry."
        )
      );
    });
    return opening;
  }
  async function operation(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      let done = false, tx, r;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          tx?.abort();
        } catch {
        }
        finish(
          Error(
            "The saved transcript operation timed out. Retry opening the app."
          )
        );
      }, 5e3);
      try {
        tx = d.transaction(store, mode);
        r = fn(tx.objectStore(store));
        tx.oncomplete = () => finish(null, r?.result);
        tx.onerror = () => finish(tx.error || Error("Could not access saved transcripts."));
        tx.onabort = () => finish(tx.error || Error("Autosave interrupted"));
      } catch (error) {
        finish(error);
      }
    });
  }
  var database = {
    projects: () => operation("projects", "readonly", (s) => s.getAll()),
    save: (p) => operation("projects", "readwrite", (s) => s.put(clone(p))),
    remove: async (id) => {
      await operation("projects", "readwrite", (s) => s.delete(id));
      await operation("audio", "readwrite", (s) => s.delete(id));
      await operation("waveforms", "readwrite", (s) => s.delete(id));
    },
    audio: (id) => operation("audio", "readonly", (s) => s.get(id)),
    putAudio: (id, blob) => operation("audio", "readwrite", (s) => s.put(blob, id)),
    waveform: (id) => operation("waveforms", "readonly", (s) => s.get(id)),
    putWaveform: (id, value) => operation("waveforms", "readwrite", (s) => s.put(value, id))
  };

  // src/waveform.js
  var WavPeaks = class {
    constructor(count = 2048) {
      this.count = count;
      this.header = new Uint8Array();
      this.carry = new Uint8Array();
      this.peaks = new Float32Array(count);
      this.ready = false;
      this.remaining = 0;
      this.frame = 0;
    }
    push(bytes) {
      if (!this.ready) {
        const joined = new Uint8Array(this.header.length + bytes.length);
        joined.set(this.header);
        joined.set(bytes, this.header.length);
        this.header = joined;
        if (joined.length < 12) return;
        if (String.fromCharCode(...joined.slice(0, 4)) !== "RIFF" || String.fromCharCode(...joined.slice(8, 12)) !== "WAVE")
          throw Error("The waveform needs a WAV playback copy.");
        const v = new DataView(joined.buffer);
        let offset = 12;
        while (offset + 8 <= joined.length) {
          const tag = String.fromCharCode(...joined.slice(offset, offset + 4)), size = v.getUint32(offset + 4, true), body = offset + 8;
          if (tag === "data") {
            if (!this.format || !size)
              throw Error("The WAV has no playable samples.");
            const { channels, rate, bits, type } = this.format;
            if (channels < 1 || channels > 32 || !rate || ![8, 16, 24, 32].includes(bits) || !(type === 1 || type === 3 && bits === 32))
              throw Error("Use a PCM WAV playback copy for the waveform.");
            this.frameBytes = channels * bits / 8;
            this.frames = Math.floor(size / this.frameBytes);
            if (!this.frames) throw Error("The WAV has no samples.");
            this.duration = this.frames / rate;
            this.remaining = size;
            this.ready = true;
            this.header = new Uint8Array();
            this.samples(joined.subarray(body));
            return;
          }
          if (size > 1024 * 1024 || body + size > joined.length) {
            if (joined.length > 1024 * 1024)
              throw Error("The WAV header is too large.");
            return;
          }
          if (tag === "fmt " && size >= 16)
            this.format = {
              type: v.getUint16(body, true),
              channels: v.getUint16(body + 2, true),
              rate: v.getUint32(body + 4, true),
              bits: v.getUint16(body + 14, true)
            };
          offset = body + size + size % 2;
        }
        return;
      }
      this.samples(bytes);
    }
    samples(bytes) {
      if (!this.remaining) return;
      bytes = bytes.subarray(0, Math.min(bytes.length, this.remaining));
      this.remaining -= bytes.length;
      let chunk = bytes;
      if (this.carry.length) {
        chunk = new Uint8Array(this.carry.length + bytes.length);
        chunk.set(this.carry);
        chunk.set(bytes, this.carry.length);
      }
      const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength), end = chunk.length - chunk.length % this.frameBytes, { channels, bits, type } = this.format, size = bits / 8;
      for (let i = 0; i < end; i += this.frameBytes) {
        let peak = 0;
        for (let c = 0; c < channels; c++) {
          const at = i + c * size;
          let n;
          if (type === 3) n = v.getFloat32(at, true);
          else if (bits === 8) n = (v.getUint8(at) - 128) / 128;
          else if (bits === 16) n = v.getInt16(at, true) / 32768;
          else if (bits === 24) {
            n = v.getUint8(at) | v.getUint8(at + 1) << 8 | v.getInt8(at + 2) << 16;
            n /= 8388608;
          } else n = v.getInt32(at, true) / 2147483648;
          if (Number.isFinite(n)) peak = Math.max(peak, Math.min(1, Math.abs(n)));
        }
        const bin = Math.min(
          this.count - 1,
          Math.floor(this.frame++ * this.count / this.frames)
        );
        this.peaks[bin] = Math.max(this.peaks[bin], peak);
      }
      this.carry = chunk.slice(end);
    }
    finish() {
      if (!this.ready || this.remaining || this.carry.length)
        throw Error("The WAV ended before its samples were complete.");
      return { duration: this.duration, peaks: Array.from(this.peaks) };
    }
  };
  async function wavResponse(response, signal) {
    if (!response.ok) throw Error("The audio file could not be read.");
    const parser = new WavPeaks();
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (signal?.aborted) throw Error("Cancelled");
          const part = await reader.read();
          if (part.done) break;
          parser.push(part.value);
        }
        return parser.finish();
      } catch (e) {
        await reader.cancel().catch(() => {
        });
        throw e;
      } finally {
        reader.releaseLock();
      }
    }
    parser.push(new Uint8Array(await response.arrayBuffer()));
    return parser.finish();
  }
  async function decodedPeaks(blob) {
    if (blob.size > 64 * 1024 * 1024)
      throw Error("Use a WAV playback copy for a recording this large.");
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw Error("Waveform decoding is unavailable.");
    const context2 = new AudioContext({ sampleRate: 8e3 });
    try {
      const data = await context2.decodeAudioData(await blob.arrayBuffer()), peaks = new Float32Array(2048);
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        const samples = data.getChannelData(ch);
        for (let i = 0; i < samples.length; i++) {
          const bin = Math.min(2047, Math.floor(i * 2048 / samples.length));
          peaks[bin] = Math.max(peaks[bin], Math.abs(samples[i]));
        }
      }
      return { duration: data.duration, peaks: Array.from(peaks) };
    } finally {
      context2.close().catch(() => {
      });
    }
  }
  var audioKey = (source2) => JSON.stringify([
    source2.path || "",
    source2.name || "",
    source2.size || 0,
    source2.modified || 0,
    source2.duration || 0
  ]);
  function createWaveform(host) {
    let peaks = [], duration = 0, controller = null, ticket = 0, observer = null, loadedKey = "", status = "";
    const canvas = () => document.querySelector("#waveform"), panel = () => document.querySelector("#waveform-shell");
    function draw() {
      const el = canvas();
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.round(rect.width * ratio);
      el.height = Math.round(rect.height * ratio);
      const x = el.getContext("2d");
      x.scale(ratio, ratio);
      const w = rect.width, h = rect.height, mid = h / 2, time = host.audio().currentTime || 0, end = duration || host.duration(), progress = end ? Math.min(1, time / end) : 0;
      const light = document.documentElement.dataset.theme === "light";
      x.fillStyle = light ? "#f3f7ee" : "#191f1a";
      x.fillRect(0, 0, w, h);
      const selected = host.cue();
      if (end && selected) {
        x.fillStyle = light ? "#4c7a2322" : "#b7ed7812";
        x.fillRect(
          selected.start / end * w,
          0,
          (selected.end - selected.start) / end * w,
          h
        );
      }
      x.strokeStyle = light ? "#b7c5aa" : "#364531";
      x.beginPath();
      x.moveTo(0, mid + 0.5);
      x.lineTo(w, mid + 0.5);
      x.stroke();
      if (peaks.length) {
        for (let at = 0; at < w; at += 3) {
          const from = Math.floor(at / w * peaks.length), to = Math.max(from + 1, Math.ceil((at + 3) / w * peaks.length));
          let peak = 0;
          for (let i = from; i < Math.min(to, peaks.length); i++)
            peak = Math.max(peak, peaks[i]);
          const height = Math.max(1, peak * (h - 20));
          x.fillStyle = at / w <= progress ? light ? "#356819" : "#c3f58c" : light ? "#92a77c" : "#719456";
          x.fillRect(at, mid - height / 2, 2, height);
        }
      }
      if (end) {
        const playX = Math.max(1, Math.min(w - 1, progress * w));
        x.fillStyle = light ? "#18330a" : "#e2ffc8";
        x.fillRect(Math.round(playX), 0, 2, h);
        x.beginPath();
        x.moveTo(playX - 4, 0);
        x.lineTo(playX + 5, 0);
        x.lineTo(playX + 1, 6);
        x.fill();
      }
      el.setAttribute("aria-valuemax", String(end));
      el.setAttribute("aria-valuenow", String(time));
    }
    function show(text) {
      status = text;
      const el = document.querySelector("#waveform-status");
      if (el) el.textContent = text;
    }
    async function load() {
      const project2 = host.project();
      if (!project2) return;
      const key2 = audioKey(project2.source), id = project2.id;
      if (loadedKey === id + key2) {
        draw();
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal, mine = ++ticket;
      loadedKey = id + key2;
      peaks = [];
      duration = project2.source.duration || 0;
      show("");
      draw();
      const current = () => mine === ticket && host.project()?.id === id;
      const cached = await host.cache.get(id).catch(() => null);
      if (!current()) return;
      if (cached?.key === key2 && Array.isArray(cached.peaks) && cached.peaks.length === 2048) {
        peaks = cached.peaks;
        duration = cached.duration;
        draw();
        return;
      }
      const url = host.waveUrl();
      if (!url) return;
      show("Loading waveform…");
      try {
        let result;
        if (host.isWav()) {
          result = await wavResponse(await fetch(url, { signal }), signal);
        } else {
          const response = await fetch(url, { signal });
          if (!response.ok) throw Error("Audio could not be read.");
          result = await decodedPeaks(await response.blob());
        }
        if (!current()) return;
        peaks = result.peaks;
        duration = result.duration;
        show("");
        draw();
        await host.cache.put(id, { key: key2, ...result }).catch(() => {
        });
      } catch (e) {
        if (!current() || signal.aborted) return;
        show("Waveform unavailable");
        console.warn("Waveform:", e);
      }
    }
    function mount() {
      observer?.disconnect();
      const el = canvas(), shell = panel();
      if (!el || !shell) return;
      observer = new ResizeObserver(draw);
      observer.observe(el);
      shell.style.width = "100%";
      const position = (e) => {
        const r = el.getBoundingClientRect();
        host.seek(
          Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (duration || host.duration())
        );
      };
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        el.setPointerCapture(e.pointerId);
        position(e);
      });
      el.addEventListener("pointermove", (e) => {
        if (el.hasPointerCapture(e.pointerId)) position(e);
      });
      el.addEventListener("pointerup", (e) => {
        if (el.hasPointerCapture(e.pointerId)) {
          position(e);
          el.releasePointerCapture(e.pointerId);
        }
      });
      el.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          host.seek(
            e.key === "Home" ? 0 : e.key === "End" ? duration || host.duration() : Math.max(
              0,
              Math.min(
                duration || host.duration(),
                host.audio().currentTime + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1)
              )
            )
          );
        }
      });
      draw();
      show(status);
    }
    return {
      load,
      mount,
      draw,
      invalidate: () => {
        loadedKey = "";
      },
      stop: () => {
        controller?.abort();
        ticket++;
      }
    };
  }

  // src/app.js
  var $ = (s) => document.querySelector(s);
  var esc = (s) => String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]
  );
  var native = () => !!window.__TAURI__?.core?.invoke;
  var invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  var projects = [];
  var history = null;
  var prefs = {
    language: "auto",
    model: "",
    whisper: "",
    ffmpeg: "",
    whisperxPython: "",
    threads: 6,
    theme: "dark",
    subtitleOptions: { ...subtitleDefaults }
  };
  var tools = { models: [] };
  var mediaUrl = "";
  var fallbackUrl = "";
  var objectUrl = "";
  var saveChain = Promise.resolve();
  var lastSaveError = null;
  var loadObserver = null;
  var documentPath = null;
  var lastSavedKey = /* @__PURE__ */ new Map();
  var allocatedPaths = /* @__PURE__ */ new Map();
  var loadEpoch = 0;
  try {
    prefs = {
      ...prefs,
      ...JSON.parse(localStorage.getItem("whisperDesk.preferences.v1") || "{}")
    };
  } catch {
  }
  delete prefs.follow;
  delete prefs.waveformWidth;
  prefs.subtitleOptions = subtitleOptions(prefs.subtitleOptions);
  var ui = {
    selected: [],
    wordId: null,
    anchor: null,
    query: "",
    limit: 100,
    busy: false,
    jobId: null,
    progress: "",
    percent: null,
    active: null,
    activeCue: null,
    drafts: {},
    fallbackUsed: false,
    scissors: false,
    audioMissing: false,
    audioError: "",
    previewExists: false,
    detectingTools: false,
    toolMessage: ""
  };
  var audioPath = (p) => p?.source.embeddedPath || p?.source.path;
  var project = () => history?.project;
  var selectedCue = () => project()?.cues.find((c) => c.id === ui.selected.at(-1));
  var selectedWord = () => selectedCue()?.words.find((w) => w.id === ui.wordId);
  var wave = createWaveform({
    project,
    audio: () => $("#audio"),
    duration: () => project()?.source.duration || 0,
    cue: selectedCue,
    seek,
    cache: {
      get: (id) => database.waveform(id),
      put: (id, value) => database.putWaveform(id, value)
    },
    waveUrl: () => native() && ui.previewExists ? window.__TAURI__.core.convertFileSrc(project().source.previewPath) : mediaUrl,
    isWav: () => native() && ui.previewExists || /\.wav$/i.test(project()?.source.name || "")
  });
  var toastTimer;
  function toast(text) {
    $("#toast")?.remove();
    const el = document.createElement("div");
    el.id = "toast";
    el.role = "status";
    el.textContent = text;
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 5e3);
  }
  function report(e) {
    console.error(e);
    toast(e.message || String(e));
  }
  function preferences() {
    localStorage.setItem("whisperDesk.preferences.v1", JSON.stringify(prefs));
  }
  function save() {
    const current = project();
    if (!current || !current.source.name && !current.cues.length && !current.referenceInput && !current.documentCreated) return Promise.resolve(false);
    const key2 = contentKey(current);
    if (lastSavedKey.get(current.id) === key2) return saveChain.then(() => false);
    current.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const snapshot = clone(current);
    snapshot.drafts = {};
    const index = projects.findIndex((p) => p.id === snapshot.id);
    index < 0 ? projects.unshift(snapshot) : projects[index] = snapshot;
    const requestedPath = documentPath;
    lastSaveError = null;
    saveChain = saveChain.catch(() => {
    }).then(async () => {
      if (native()) {
        const target = requestedPath || allocatedPaths.get(snapshot.id) || await invoke("allocate_document", { directory: prefs.transcriptDirectory, name: snapshot.name });
        allocatedPaths.set(snapshot.id, target);
        if (!requestedPath) {
          const chosenName = target.split(/[\\/]/).at(-1).replace(/\.subtitler$/i, "");
          if (project()?.id === snapshot.id && project().name === snapshot.name) project().name = chosenName;
          snapshot.name = chosenName;
        }
        snapshot.filePath = target;
        if (lastSavedKey.get(snapshot.id) === contentKey(snapshot) && snapshot.source?.embeddedPath) return false;
        if (!await invoke("claim_document", { path: target })) throw Error("This project is already open in another window.");
        if (snapshot.studioLink) snapshot.studioLink.projectFile = target;
        const written = await invoke("write_document", { path: target, data: JSON.stringify(snapshot, null, 2) });
        if (written?.audioPath) {
          snapshot.source.embeddedPath = written.audioPath;
          if (project()?.id === snapshot.id) project().source.embeddedPath = written.audioPath;
        }
        if (written?.audioWarning) toast(written.audioWarning);
        if (project()?.id === snapshot.id) {
          documentPath = target;
          project().filePath = target;
          if (project().studioLink) project().studioLink.projectFile = target;
        }
      }
      await database.save(snapshot);
      lastSavedKey.set(snapshot.id, contentKey(snapshot));
      if (project()?.id === snapshot.id) {
        $("#saved").hidden = true;
        renderHeader();
        studio.schedule();
      }
      return true;
    }).catch((e) => {
      lastSaveError = e;
      $("#saved").hidden = false;
      $("#saved").textContent = "Save failed";
      report(e);
      return false;
    });
    return saveChain;
  }
  async function saveCurrent() {
    const reference = $("#reference-input");
    if (reference) {
      const text = reference.value;
      history.change("Change reference text", (p) => {
        if (text.trim()) {
          p.referenceInput = parseScript(text);
          p.useScript = true;
        } else {
          delete p.referenceInput;
          p.useScript = false;
        }
      });
    }
    if (!applyDrafts()) return;
    if (!documentPath) project().documentCreated = true;
    const changed = await save();
    await studio.flush();
    if (lastSaveError) throw lastSaveError;
    toast(changed ? "Project saved." : "Everything is up to date.");
    renderHeader();
  }
  async function saveAs() {
    if (!applyDrafts() || !native()) return;
    const path2 = await invoke("choose_document_save", { name: project().name });
    if (!path2) return;
    const next = standalone(project());
    next.filePath = path2;
    next.documentCreated = true;
    if (!await invoke("claim_document", { path: path2 })) return;
    await openProject(next);
    documentPath = path2;
    await saveCurrent();
  }
  async function closeProject() {
    if (ui.closing) return;
    ui.closing = true;
    try {
      if (ui.busy) {
        ui.cancelRequested = true;
        await invoke("cancel_transcription");
        ui.progress = "Finishing audio task before closing…";
        renderHeader();
        while (ui.busy) await new Promise((r) => setTimeout(r, 100));
      }
      if (!applyDrafts()) throw Error("Check the current text edit before closing.");
      await save();
      await studio.flush();
      if (lastSaveError) throw lastSaveError;
      if (native()) await invoke("finish_document_close");
      else window.close();
    } catch (e) {
      ui.closing = false;
      if (native()) void invoke("cancel_document_close").catch(() => {
      });
      report(e);
    }
  }
  function commit(label, fn) {
    if (!history || ui.busy) return;
    try {
      history.change(label, (p) => {
        fn(p);
        refreshChapterTimes(p);
      });
      ui.selected = ui.selected.filter(
        (id) => project().cues.some((c) => c.id === id)
      );
      save();
      renderContent();
      renderHeader();
    } catch (e) {
      report(e);
    }
  }
  function referenceProject(original, reference) {
    if (original.cues.length && spokenKey(original) === spokenKey({ cues: [{ words: reference.words }] })) return clone(original);
    const p = clone(original), duration = Math.max(0.01, p.source.duration), step = duration / Math.max(1, reference.words.length);
    const words = reference.words.map((w, i) => ({ id: uid(), text: w.text, gap: w.gap ?? (i ? " " : ""), start: i * step, end: (i + 1) * step, timing: "estimated", scriptChapterId: w.chapterId, scriptFrom: w.from, scriptTo: w.to }));
    if (!words.length) throw Error("Import reference text first.");
    p.cues = [{ id: uid(), start: 0, end: duration, words }];
    return p;
  }
  function installPanelResizing() {
    const root = $(".workspace");
    let dims;
    try {
      dims = JSON.parse(localStorage.getItem("subtitler.panelSizes") || "{}");
    } catch {
      dims = {};
    }
    const apply = () => {
      root.style.setProperty("--wave-height", Math.max(32, Math.min(innerHeight * 0.42, dims.wave || 88)) + "px");
      root.style.setProperty("--inspector-width", Math.max(220, Math.min(innerWidth * 0.55, dims.inspector || 310)) + "px");
      wave.draw();
    };
    apply();
    for (const [selector, dimension, vertical] of [[".waveform-resizer", "wave", true], [".inspector-resizer", "inspector", false]]) {
      const bar = $(selector);
      bar.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        const start2 = vertical ? e.clientY : e.clientX, initial = dimension === "wave" ? $("#waveform").clientHeight : $("#inspector").clientWidth;
        const move = (ev) => {
          dims[dimension] = initial + (vertical ? ev.clientY - start2 : start2 - ev.clientX);
          apply();
        };
        const end = () => {
          bar.removeEventListener("pointermove", move);
          bar.removeEventListener("pointerup", end);
          bar.removeEventListener("pointercancel", end);
          localStorage.setItem("subtitler.panelSizes", JSON.stringify(dims));
        };
        bar.addEventListener("pointermove", move);
        bar.addEventListener("pointerup", end);
        bar.addEventListener("pointercancel", end);
      });
      bar.addEventListener("keydown", (e) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        dims[dimension] = (dims[dimension] || (vertical ? 88 : 310)) + (e.key === "ArrowDown" || e.key === "ArrowLeft" ? 10 : -10);
        apply();
        localStorage.setItem("subtitler.panelSizes", JSON.stringify(dims));
      });
    }
    window.addEventListener("resize", apply);
  }
  function applyFolderMove(result) {
    if (!result?.directory) return;
    const path2 = (p) => rebaseSavePath(p, result.old, result.directory);
    const update = (p) => {
      if (!p) return;
      for (const key2 of ["filePath", "privateFile", "openedFile"]) if (p[key2]) p[key2] = path2(p[key2]);
      if (p.studioLink?.projectFile) p.studioLink.projectFile = path2(p.studioLink.projectFile);
      for (const key2 of ["path", "previewPath"]) if (p.source?.[key2]) p.source[key2] = path2(p.source[key2]);
    };
    prefs.transcriptDirectory = result.directory;
    preferences();
    documentPath = path2(documentPath);
    update(project());
    for (const p of projects) {
      update(p);
      void database.save(p);
    }
    for (const [id, p] of allocatedPaths) allocatedPaths.set(id, path2(p));
    lastSavedKey.clear();
    studio.reset();
    renderHeader();
    refreshDocumentHeader();
    if ($("#transcript-directory")) $("#transcript-directory").textContent = result.directory;
  }
  async function moveTranscriptFolder() {
    if (!native() || ui.busy) return;
    if (!applyDrafts()) return;
    if (project().source.name || project().cues.length || project().referenceInput) {
      await save();
      if (lastSaveError) throw lastSaveError;
      await studio.flush();
    }
    const parent = await invoke("choose_transcript_directory");
    if (!parent) return;
    ui.busy = true;
    ui.progress = "Moving and verifying Subtitler files…";
    ui.percent = null;
    renderHeader();
    try {
      const result = await invoke("move_transcript_folder", { directory: prefs.transcriptDirectory, parent, createIfMissing: !projects.some((p) => isUnderSaveFolder(p.filePath, prefs.transcriptDirectory)) });
      applyFolderMove(result);
      toast(result.warning || (result.changed ? "Subtitler folder moved." : "The folder is already in this location."));
    } finally {
      ui.busy = false;
      renderHeader();
    }
  }
  function setup() {
    document.documentElement.dataset.theme = prefs.theme === "light" ? "light" : "dark";
    $("#app").innerHTML = `<main class="workspace"><header class="topbar"><details class="file-menu"><summary>File</summary><div><button data-action="new-project">New</button><button data-action="open-project">Open…</button><button data-action="recent-projects">Open Recent…</button><hr><button data-action="import-audio">Import Audio…</button><button data-action="import-reference">Import Reference text…</button><button data-action="import-subtitles">Import Subtitles…</button><button data-action="project-folder">Open Storyboard project…</button><hr><button data-action="save-project">Save</button><button data-action="save-as">Save As…</button><button data-action="reveal-transcript">Show saved project</button><button data-action="move-transcript-folder">Move Subtitler folder…</button><hr><button data-action="export">Export…</button><button data-action="close-project">Close</button></div></details><span class="brand">SUBTITLER</span><div class="project-title"><input id="project-name" aria-label="Transcript name" maxlength="200"><span id="saved" role="status" hidden></span></div><div class="top-actions"><button class="secondary" data-action="settings" aria-label="Settings">⚙</button><button class="secondary" data-action="save-project">Save project</button><button class="primary" data-action="export">Export ↗</button></div></header><div id="document-status"><button id="saved-location" data-action="reveal-transcript"></button><strong id="studio-connection" hidden></strong></div>
 <section class="player"><audio id="audio" preload="metadata"></audio><div id="audio-placeholder"><button class="secondary" data-action="import-audio">＋ Import audio</button><small>or drop an audio file here</small></div><div class="waveform-wrap" id="waveform-shell"><div class="waveform-top"><button data-action="play-pause" id="play-pause" aria-label="Play">▶</button><span id="player-time">00:00:00.000 / 00:00:00.000</span><button class="audio-name" id="audio-name" data-action="audio-location"></button><span class="waveform-spacer"></span><button class="secondary" data-action="relink" hidden>Attach audio…</button></div><div class="waveform-resize-target"><div id="chapter-markers" aria-label="Chapter markers"></div><canvas id="waveform" height="88" role="slider" tabindex="0" aria-label="Audio playhead" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas><div class="panel-resizer waveform-resizer" role="separator" tabindex="0" aria-label="Resize waveform height" aria-orientation="horizontal"></div></div><div class="waveform-bottom"><span id="waveform-status" role="status"></span><span id="audio-error" role="status"></span><label>Speed<select id="playback-rate" aria-label="Playback speed"><option value=".5">0.5×</option><option value=".75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label class="volume-control">Volume<input type="range" id="volume" min="0" max="1" step=".05" value="1" aria-label="Volume"></label></div></div>
 <div id="job-status" hidden><div class="job-message"><span id="job-message"></span><button data-action="cancel">Cancel</button></div><progress id="job-progress"></progress></div><div class="transcribe-bar"><label>Language<select id="language"><option value="auto">Auto detect</option><option value="en">English</option><option value="pt">Português</option><option value="es">Español</option><option value="ja">日本語</option></select></label><label class="model-label">Whisper model<select id="model"></select></label><button class="secondary" data-action="transcription-options">Options</button><button class="primary" data-action="transcribe">Transcribe</button><button class="secondary" data-action="improve-timing" hidden>Update word timings</button><button class="secondary" data-action="timing-report" hidden>Timing report</button></div><div id="project-sync-status" role="status" hidden></div></section>
 <section class="editor"><div class="editor-toolbar"><button class="scissors-button" data-action="scissors" title="Split before a word" aria-label="Scissors" aria-pressed="false"><img src="assets/scissors-icon.png" alt=""></button><span class="toolbar-rule"></span><button class="secondary" data-action="reference-text">Reference text</button><button class="secondary" data-action="chapters">Chapters</button><button class="secondary" data-action="clear-transcript">Clear transcript</button><input id="search" type="search" placeholder="Find…" aria-label="Find in transcript"></div><div class="editor-columns"><section class="transcript-panel"><div id="match-reference-prompt" hidden><button class="primary" data-action="match-timings">Match timings</button><small>Match your imported reference text to this recording.</small></div><div id="transcript-list" tabindex="-1"></div></section><div class="panel-resizer inspector-resizer" role="separator" tabindex="0" aria-label="Resize subtitle editor" aria-orientation="vertical"></div><aside class="inspector" id="inspector" aria-label="Subtitle editor"></aside></div></section></main>`;
    wave.mount();
    installPanelResizing();
    const audio = $("#audio");
    audio.addEventListener("timeupdate", () => updatePlayback());
    audio.addEventListener("seeked", () => updatePlayback());
    audio.addEventListener("loadedmetadata", () => {
      if (ui.seekTo !== void 0) {
        audio.currentTime = ui.seekTo;
        delete ui.seekTo;
      }
      if (project() && !project().source.duration && Number.isFinite(audio.duration)) {
        project().source.duration = audio.duration;
        save();
      }
      updatePlayback(false);
    });
    audio.addEventListener("error", async () => {
      if (native() && project()?.source.embeddedPath && mediaUrl !== window.__TAURI__.core.convertFileSrc(project().source.embeddedPath)) {
        ui.seekTo = audio.currentTime;
        await loadAudio();
        renderHeader();
        return;
      }
      if (fallbackUrl && !ui.fallbackUsed) {
        ui.fallbackUsed = true;
        audio.src = fallbackUrl;
        audio.load();
      } else if (mediaUrl) {
        ui.audioError = "Playback unavailable";
        if (native()) await checkAudio();
        renderHeader();
      }
    });
    let raf;
    const tick = () => {
      updatePlayback();
      if (!audio.paused) raf = requestAnimationFrame(tick);
    };
    audio.addEventListener("play", () => {
      if (!ui.playRequested) {
        audio.pause();
        return;
      }
      cancelAnimationFrame(raf);
      tick();
    });
    audio.addEventListener("pause", () => {
      ui.playRequested = false;
      cancelAnimationFrame(raf);
      updatePlayback();
    });
    audio.addEventListener("ended", () => {
      cancelAnimationFrame(raf);
      updatePlayback();
    });
  }
  function refreshDocumentHeader() {
    renderHeader();
  }
  function renderHeader() {
    if (native() && ui.startupComplete && project()) {
      const p2 = project(), empty = !documentPath && !p2.source?.path && !p2.cues?.length && !referenceOf(p2), recordingKey = p2.studioLink ? `${p2.studioLink.projectId || ""}:${p2.source.fingerprint || p2.source.path}` : null, binding = JSON.stringify([empty, recordingKey]);
      if (ui.lastWindowBinding !== binding) {
        ui.lastWindowBinding = binding;
        void invoke("set_document_empty", { empty, recordingKey }).catch(() => {
        });
      }
    }
    const fileMenu = document.querySelector(".file-menu");
    if (fileMenu) fileMenu.hidden = native();
    const location2 = $("#saved-location"), connection = $("#studio-connection");
    const saved = project()?.studioLink?.projectFile || documentPath;
    location2.textContent = saved ? "Saved at: " + saved : "Not saved yet";
    location2.disabled = !saved;
    connection.hidden = !project()?.studioLink;
    connection.textContent = project()?.studioLink ? "Connected to Storyboard Studio · " + (project().studioLink.projectName || "Project") : "";
    $("#audio-placeholder").hidden = !!project()?.source.name && !ui.audioMissing;
    $("#waveform-shell").hidden = !project()?.source.name || ui.audioMissing;
    $("#audio-name").textContent = project()?.source.name || "";
    const title = project()?.name || "Untitled";
    if (native() && ui.windowTitle !== title) {
      ui.windowTitle = title;
      void invoke("document_title", { title }).catch(() => {
      });
    }
    const p = project();
    const chapterButton = $('[data-action="chapters"]');
    if (chapterButton) {
      chapterButton.disabled = !p || ui.busy;
      chapterButton.textContent = "Chapters" + (p?.chapters?.length ? ` (${p.chapters.length})` : "");
    }
    const chapterMarkers = $("#chapter-markers");
    if (chapterMarkers) {
      const duration = p?.source.duration || 0;
      chapterMarkers.innerHTML = duration ? placedChapters(p).map((c) => `<button class="chapter-flag" data-action="chapter-seek" data-start="${c.start}" style="left:clamp(8px,${Math.min(100, c.start / duration * 100)}%,calc(100% - 8px))" aria-label="Go to ${esc(c.title)} at ${clock(c.start)}"><span class="flag-shape" aria-hidden="true"></span><span class="chapter-tooltip">${esc(c.title)} · ${clock(c.start)}</span></button>`).join("") : "";
    }
    if (document.activeElement !== $("#project-name"))
      $("#project-name").value = p?.name || "Untitled";
    $("#project-name").disabled = !p || ui.busy;
    $("#language").value = prefs.language;
    const models = [...tools.models];
    if (prefs.model && !models.some((m) => m.path === prefs.model))
      models.unshift({
        path: prefs.model,
        name: prefs.model.split(/[\\/]/).at(-1)
      });
    $("#model").innerHTML = models.length ? models.map(
      (m) => `<option value="${esc(m.path)}" ${m.path === prefs.model ? "selected" : ""}>${esc(m.name)}</option>`
    ).join("") : '<option value="">Choose in Settings</option>';
    for (const a of ["import-audio", "relink", "transcribe", "improve-timing", "match-timings"])
      document.querySelectorAll(`[data-action="${a}"]`).forEach(
        (el) => el.disabled = ui.busy || (a === "transcribe" || a === "improve-timing") && !p?.source.path || a === "improve-timing" && !p?.cues.length
      );
    $('[data-action="timing-report"]').hidden = !p?.recognition?.alignment && !p?.workflowWarnings?.length && !p?.diagnostics;
    $('[data-action="relink"]').hidden = !ui.audioMissing;
    $("#audio-error").textContent = ui.audioMissing ? "Audio file missing. Import it again." : p?.timingsNeedMatch ? "This recording needs timing matching." : ui.audioError;
    $("#language").disabled = ui.busy;
    $("#model").disabled = ui.busy;
    $("#job-status").hidden = !ui.busy;
    $('[data-action="cancel"]').hidden = !ui.jobId;
    $("#job-message").textContent = ui.progress;
    const progress = $("#job-progress");
    ui.percent === null ? progress.removeAttribute("value") : (progress.max = 100, progress.value = ui.percent);
    for (const a of ["export", "save-project"]) document.querySelectorAll(`[data-action="${a}"]`).forEach((el) => el.disabled = !p || a === "export" && !p.cues.length);
    document.querySelectorAll('[data-action="match-timings"]').forEach((el) => el.disabled = ui.busy || !p?.source.path || !p.cues.length && !p.referenceInput && !p.availableScript);
    $("#match-reference-prompt").hidden = !canMatch(p);
    $(".transcript-panel").classList.toggle("reference-awaiting", canMatch(p) && !p?.cues.length);
    const timingButton = $('[data-action="improve-timing"]');
    timingButton.hidden = !needsTiming(p);
    timingButton.textContent = p?.timingAlignmentPending ? "Retry word timing" : "Update word timings";
    $("#play-pause").disabled = !mediaUrl;
    $("#waveform").setAttribute("aria-disabled", String(!mediaUrl));
    $("#playback-rate").disabled = !mediaUrl;
    $("#volume").disabled = !mediaUrl;
  }
  function filtered() {
    const query = ui.query.toLocaleLowerCase();
    return (project()?.cues || []).filter(
      (c) => !query || cueText(c).toLocaleLowerCase().includes(query)
    );
  }
  var renderedPauses = /* @__PURE__ */ new Set();
  function pauseLabels(from, to) {
    return (project().pauses || []).filter((p) => {
      if (p.start <= from || p.start > to || renderedPauses.has(p.id)) return false;
      renderedPauses.add(p.id);
      return true;
    }).map((p) => `<span class="pause-row"><button data-seek-pause="${p.start}">[${esc(p.label || "Silence")}]</button><time>${clock(p.start)} → ${clock(p.end)}</time></span>`).join("");
  }
  function pauseRowsBefore(cue) {
    const index = project().cues.indexOf(cue), prev = index ? project().cues[index - 1].end : -1;
    return pauseLabels(prev, cue.start);
  }
  function inlinePauses(cue, index) {
    return pauseLabels(index ? cue.words[index - 1].start : cue.start, cue.words[index].start);
  }
  function renderContent() {
    renderedPauses = /* @__PURE__ */ new Set();
    const p = project(), list = $("#transcript-list"), scroll = list.scrollTop, cues = filtered(), showing = cues.slice(0, ui.limit);
    loadObserver?.disconnect();
    list.innerHTML = showing.length ? showing.map(
      (c) => `${pauseRowsBefore(c)}<article class="cue ${ui.selected.includes(c.id) ? "selected" : ""}" data-cue-row="${esc(c.id)}"><button class="cue-number" data-select-cue="${esc(c.id)}" aria-label="Select subtitle ${p.cues.indexOf(c) + 1}">${String(p.cues.indexOf(c) + 1).padStart(2, "0")}</button><div class="cue-body"><button class="cue-time" data-cue-time="${esc(c.id)}">${clock(c.start)} <span>→ ${clock(c.end)}</span></button>${project().subtitleOptions?.speakers !== 1 && c.words.some((w) => w.speaker) ? `<button class="speaker-label" data-speaker="${esc(c.words.find((w) => w.speaker).speaker)}">${esc(project().speakerNames?.[c.words.find((w) => w.speaker).speaker] || c.words.find((w) => w.speaker).speaker)}</button>` : ""}${c.layoutWarning ? '<small class="layout-warning">One word exceeds the character limit.</small>' : ""}<p>${c.words.map((w, i) => `${inlinePauses(c, i)}${i ? esc(w.gap) : ""}<button class="word ${w.timing === "estimated" ? "estimated" : ""} ${w.alignmentIssue ? "needs-review" : ""} ${w.id === ui.wordId ? "word-selected" : ""}" data-word="${esc(w.id)}" data-cue="${esc(c.id)}" title="${clock(w.start)}${w.timing === "estimated" ? " · approximate timing" : ""}">${esc(w.text)}</button>`).join("")}${pauseLabels(c.words.at(-1)?.start ?? c.start, c.end)}</p>${p.cues.indexOf(c) < p.cues.length - 1 ? `<div class="cue-merge"><button data-merge-after="${esc(c.id)}" aria-label="Merge subtitle ${p.cues.indexOf(c) + 1} with next">Merge ↓</button></div>` : ""}</div></article>`
    ).join("") + (cues.length > showing.length ? '<div id="load-more" aria-hidden="true"></div>' : "") : `<div class="empty-state">${ui.query ? "<p>No matches</p>" : "<p>No subtitles yet.</p>"}</div>`;
    list.classList.toggle("scissors-active", ui.scissors);
    $('[data-action="scissors"]').setAttribute(
      "aria-pressed",
      String(ui.scissors)
    );
    list.scrollTop = scroll;
    renderInspector();
    ui.active = null;
    ui.activeCue = null;
    updatePlayback(false);
    const more = $("#load-more");
    if (more) {
      loadObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            ui.limit += 100;
            renderContent();
          }
        },
        { root: list, rootMargin: "200px" }
      );
      loadObserver.observe(more);
    }
  }
  function growTextarea() {
    const el = $("#subtitle-text");
    if (!el) return;
    const scroll = $("#inspector").scrollTop;
    el.style.height = "0px";
    const style = getComputedStyle(el), line = parseFloat(style.lineHeight) || 24, pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    el.style.height = Math.max(line + pad, el.scrollHeight) + line + 2 + "px";
    $("#inspector").scrollTop = scroll;
  }
  function renderInspector() {
    const cue = selectedCue(), word = selectedWord();
    $("#inspector").innerHTML = cue ? `<header class="inspector-heading"><span>${String(project().cues.indexOf(cue) + 1).padStart(2, "0")}</span></header><textarea id="subtitle-text" rows="1" aria-label="Edit subtitle" spellcheck="true">${esc(ui.drafts[cue.id] ?? cueText(cue))}</textarea><div class="text-edit-actions"><button class="secondary" data-action="cancel-text">Cancel</button><button class="primary" data-action="apply-text" title="Enter">Apply text</button></div><div class="inspector-section"><strong>Timing</strong><div class="time-fields"><label>Start<input id="cue-start" value="${clock(cue.start)}"></label><label>End<input id="cue-end" value="${clock(cue.end)}"></label></div></div>${word ? `<div class="inspector-section"><strong>Selected word</strong><p class="selected-word">${esc(word.text)}</p><small>${word.timing === "estimated" ? "Estimated timing" : word.timing === "manual" ? "Manual timing" : word.alignmentEngine === "whisperx" ? "WhisperX timing" : "Whisper timing"}</small>${word.alignmentIssue ? `<small>${esc(word.alignmentIssue)}</small>` : ""}<div class="time-fields"><label>Start<input id="word-start" value="${clock(word.start)}"></label><label>End<input id="word-end" value="${clock(word.end)}"></label></div></div>` : ""}` : "";
    growTextarea();
    if (ui.busy)
      $("#inspector").querySelectorAll("input,textarea,button").forEach((el) => el.disabled = true);
  }
  function select(cueId, wordId = null, extend = false) {
    const changed = selectedCue()?.id !== cueId, cues = project().cues;
    if (extend && ui.anchor) {
      const a = cues.findIndex((c) => c.id === ui.anchor), b = cues.findIndex((c) => c.id === cueId);
      ui.selected = cues.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id);
    } else {
      ui.selected = [cueId];
      ui.anchor = cueId;
    }
    ui.wordId = wordId;
    renderContent();
    if (changed) $("#inspector").scrollTop = 0;
  }
  function seek(time) {
    const audio = $("#audio");
    if (!mediaUrl) return;
    try {
      if (audio.readyState < 1) ui.seekTo = time;
      else audio.currentTime = time;
    } catch {
      ui.seekTo = time;
    }
    updatePlayback();
  }
  function updatePlayback(follow = true) {
    if (!project()) return;
    const audio = $("#audio"), time = audio.currentTime || 0, active = mediaUrl && !project().timingsNeedMatch ? activeWord(project(), time) : null, word = active?.word?.id || null, cue = active?.cue?.id || null;
    $("#player-time").textContent = clock(time) + " / " + clock(
      Number.isFinite(audio.duration) ? audio.duration : project().source.duration || 0
    );
    $("#play-pause").textContent = audio.paused ? "▶" : "Ⅱ";
    $("#play-pause").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    if (word !== ui.active) {
      document.querySelectorAll(".word.playing").forEach((el) => el.classList.remove("playing"));
      if (word)
        document.querySelector(`[data-word="${CSS.escape(word)}"]`)?.classList.add("playing");
      ui.active = word;
    }
    if (cue !== ui.activeCue) {
      document.querySelectorAll(".cue.current").forEach((el) => el.classList.remove("current"));
      let row = cue ? document.querySelector(`[data-cue-row="${CSS.escape(cue)}"]`) : null;
      const editing = document.activeElement?.matches("input,textarea,select");
      if (cue && !row && follow && !ui.query && !editing) {
        const index = project().cues.findIndex((c) => c.id === cue);
        ui.limit = Math.max(ui.limit, index + 50);
        renderContent();
        row = document.querySelector(`[data-cue-row="${CSS.escape(cue)}"]`);
      }
      if (row) {
        row.classList.add("current");
        if (follow && !editing && !$("#audio").paused)
          (document.querySelector(`[data-word="${CSS.escape(word)}"]`) || row).scrollIntoView({ block: "center", behavior: "auto" });
      }
      ui.activeCue = cue;
    }
    wave.draw();
  }
  async function openProject(p) {
    $("#audio").pause();
    wave.stop();
    studio.reset();
    documentPath = p.filePath || p.studioLink?.projectFile || null;
    if (p.cues.length && !p.wordTimingTextKey) p.wordTimingTextKey = spokenKey(p);
    p.closed = false;
    p.lastOpenedAt = (/* @__PURE__ */ new Date()).toISOString();
    history = new History(p);
    ui.selected = p.cues.length ? [p.cues[0].id] : [];
    ui.anchor = ui.selected[0];
    ui.wordId = null;
    ui.limit = 100;
    ui.query = "";
    $("#search").value = "";
    ui.drafts = clone(p.drafts || {});
    localStorage.setItem("whisperDesk.current.v1", p.id);
    renderHeader();
    refreshDocumentHeader();
    renderContent();
    try {
      await loadAudio();
    } catch (e) {
      ui.audioMissing = true;
      ui.audioError = String(e.message || e);
    }
    renderHeader();
    if (projects.some((item) => item.id === p.id)) await database.save(p);
    if (p.studioLink?.directory) void studio.refresh();
  }
  async function checkAudio() {
    const p = project();
    if (!native() || !p?.source.path) return;
    try {
      const status = await startupDeadline(
        invoke("audio_status", {
          path: audioPath(p),
          previewPath: p.source.previewPath || null
        }),
        "Audio check timed out",
        3e3
      );
      if (project()?.id !== p.id) return;
      if (!status.originalExists && documentPath && !p.source.embeddedPath) {
        const opened = await invoke("open_document", { path: documentPath });
        if (project()?.id !== p.id) return;
        if (opened.audioPath) {
          p.source.embeddedPath = opened.audioPath;
          status.originalExists = true;
        }
      }
      ui.audioMissing = !status.originalExists;
      ui.previewExists = !!status.previewExists;
      if (status.originalExists && p.source.fingerprint) {
        const actual = await invoke("audio_file_info", { path: audioPath(p) });
        if (project()?.id !== p.id) return;
        if (!sameRecording(actual, p.source)) {
          p.timingsNeedMatch = true;
          ui.audioError = "Audio content changed. Import this recording again before matching.";
        }
      }
    } catch (e) {
      console.warn("Audio status unavailable", e);
    }
  }
  async function loadAudio() {
    const epoch = ++loadEpoch;
    ui.playRequested = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    mediaUrl = "";
    fallbackUrl = "";
    ui.fallbackUsed = false;
    ui.audioError = "";
    ui.audioMissing = false;
    ui.previewExists = false;
    const p = project();
    if (!p) return;
    if (native() && p.source.path) {
      await checkAudio();
      if (epoch !== loadEpoch || project()?.id !== p.id) return;
      if (!ui.audioMissing)
        mediaUrl = window.__TAURI__.core.convertFileSrc(audioPath(p));
      if (ui.previewExists) {
        fallbackUrl = window.__TAURI__.core.convertFileSrc(p.source.previewPath);
        if (!mediaUrl) {
          mediaUrl = fallbackUrl;
          ui.fallbackUsed = true;
        }
      }
    } else {
      const blob = await database.audio(p.id);
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        mediaUrl = objectUrl;
      } else ui.audioMissing = !!p.source.name || !!p.cues.length;
    }
    if (epoch !== loadEpoch || project()?.id !== p.id) return;
    const audio = $("#audio");
    audio.pause();
    audio.removeAttribute("src");
    if (mediaUrl) audio.src = mediaUrl;
    audio.load();
    wave.invalidate();
    void wave.load();
  }
  async function audioInput(input, relink = false) {
    if (ui.busy) return;
    const isPath = typeof input === "string", name = isPath ? input.split(/[\\/]/).at(-1) : input.name;
    let recordingInfo = isPath && native() ? await invoke("audio_file_info", { path: input }) : null;
    const prior = project();
    if (prior?.source.name && !sameRecording(prior.source, recordingInfo || { name, size: input.size, modified: input.lastModified }) && !ui.audioConfirmed) {
      ui.pendingAudio = input;
      modal(`<header><h2>Use this audio?</h2></header><p>Attach ${esc(name)} to the current project. Your text stays; existing timings need matching again.</p><footer><button data-action="close-modal">Cancel</button><button class="primary" data-action="confirm-audio">Use audio</button></footer>`);
      return;
    }
    ui.audioConfirmed = false;
    if (/\.(mov|mp4|mkv|webm)$/i.test(name))
      throw Error(
        "Video import and visual subtitles are noted for a future version. Open an audio file for now."
      );
    if (!/\.(wav|mp3|m4a|aac|flac|ogg|aiff?|opus|wma)$/i.test(name))
      throw Error("Choose an audio recording.");
    const old = project();
    let p = old || newProject();
    const changed = !!p.source.name && !sameRecording(p.source, recordingInfo || { name, size: input.size, modified: input.lastModified });
    if (changed && p.studioLink) {
      await save();
      await studio.flush();
      p = standalone(p, distinctName(name.replace(/\.[^.]+$/, ""), projects));
      delete p.source.embeddedPath;
      await openProject(p);
    }
    if (changed) {
      delete p.source.embeddedPath;
      delete p.matchedReferenceKey;
      p.timingsNeedMatch = true;
      delete p.source.relativePath;
      delete p.scriptReference;
      p.pauses = [];
      invalidateChapterTimes(p);
    }
    if (!p.source.name && !p.cues.length && !p.referenceInput) p.name = distinctName(name.replace(/\.[^.]+$/, ""), projects.filter((x) => !x.studioLink));
    if (!old) await openProject(p);
    const priorDuration = p.source.duration || 0, priorSize = p.source.size;
    p.source = {
      ...p.source,
      ...recordingInfo || {},
      name,
      path: isPath ? input : null,
      previewPath: null,
      duration: isPath ? p.source.duration : 0
    };
    if (!isPath) {
      await database.putAudio(p.id, input);
      p.source.size = input.size;
      p.source.modified = input.lastModified;
    }
    await loadAudio();
    renderHeader();
    save();
    if (isPath && prefs.ffmpeg) {
      ui.busy = true;
      ui.progress = "Preparing playback…";
      renderHeader();
      try {
        const source2 = await invoke("prepare_audio", {
          path: input,
          ffmpeg: prefs.ffmpeg,
          projectId: p.id
        });
        if (project()?.id === p.id) {
          p.source = { ...p.source, ...source2 };
          if (priorSize && priorDuration && Math.abs(priorDuration - source2.duration) > 0.3)
            toast(
              "The relinked audio has a different duration. Review the subtitle timings."
            );
          await loadAudio();
          save();
        }
      } catch (e) {
        toast(String(e));
      } finally {
        ui.busy = false;
        renderHeader();
      }
    }
    refreshDocumentHeader();
  }
  async function chooseAudio(relink = false) {
    ui.relink = relink;
    if (native()) {
      const path2 = await invoke("pick_file", { kind: "audio" });
      if (path2) await audioInput(path2, relink);
    } else $("#audio-file").click();
  }
  async function readInput(input) {
    const isPath = typeof input === "string", name = isPath ? input.split(/[\\/]/).at(-1) : input.name;
    if (!isPath && input.size > 50 * 1024 * 1024)
      throw Error("Transcript exceeds 50 MB.");
    if (isPath && /\.(subtitler|whisperdesk)$/i.test(name)) return openDocumentFile(input, true);
    const text = isPath ? await invoke("read_transcript", { path: input }) : await input.text();
    let p;
    if (/\.srt$/i.test(name)) {
      return adoptSubtitles(parseSrt(text, { name }), input);
    } else {
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw Error("The transcript is not valid JSON.");
      }
      if (raw.format === "subtitler-script-v1") {
        commit("Import reference text", (p2) => {
          p2.referenceInput = parseScript(raw);
          p2.useScript = true;
          adoptReferenceChapters(p2, p2.referenceInput);
        });
        toast("Reference text selected.");
        return;
      }
      if (["whisperdesk-project-v1", "subtitler-project-v1"].includes(raw.format)) {
        p = openedDocument(raw, isPath ? input : name);
        p.closed = false;
        if (!native()) {
          p.source.path = null;
          p.source.previewPath = null;
          delete p.studioLink;
        }
      } else if (raw.format === "whisperdesk-timing-v1") {
        const words = new Map((raw.words || []).map((w) => [w.id, w]));
        p = newProject(raw.source?.name || "Imported timing", raw.source);
        p.source.path = null;
        p.source.previewPath = null;
        p.language = raw.language;
        p.recognition = raw.recognition;
        p.sourceWords = raw.originalWords || [];
        p.cues = raw.subtitles.map((c) => ({
          id: c.id,
          start: c.start,
          end: c.end,
          words: c.wordIds.map((id) => {
            const w = words.get(id);
            if (!w) throw Error("Timing file refers to a missing word.");
            return w;
          })
        }));
        validateProject(p);
      } else p = parseWhisper(raw, { name: name.replace(/\.json$/i, "") });
    }
    if (!/\.(subtitler|whisperdesk)$/i.test(name)) return adoptSubtitles(p, input);
    await openProject(p);
    await save();
    toast("Opened.");
  }
  function adoptSubtitles(imported, input) {
    if (project().cues.length && !ui.importConfirmed) {
      ui.pendingSubtitles = input;
      modal(`<header><h2>Replace current subtitles?</h2></header><p>Import these subtitles into the current project. Undo restores the previous subtitles and timing.</p><footer><button data-action="close-modal">Cancel</button><button class="primary" data-action="confirm-subtitles">Import subtitles</button></footer>`);
      return;
    }
    ui.importConfirmed = false;
    commit("Import subtitles", (p) => {
      p.cues = imported.cues;
      p.sourceWords = imported.sourceWords || [];
      p.recognition = imported.recognition;
      p.referenceInput = parseScript(imported.cues.map(cueText).join("\n"));
      p.useScript = true;
      delete p.matchedReferenceKey;
      p.wordTimingTextKey = spokenKey(p);
      p.timingsNeedMatch = !!p.source.name;
      delete p.timingsCleared;
      p.pauses = [];
    });
  }
  function applyDrafts() {
    if (ui.busy) return false;
    const entries = Object.entries(ui.drafts).filter(
      ([id, text]) => project().cues.some((c) => c.id === id && cueText(c) !== text)
    );
    if (!entries.length) {
      ui.drafts = {};
      project().drafts = {};
      return true;
    }
    try {
      history.change("Edit subtitles", (p) => {
        for (const [id, text] of entries) editCue(p, id, text);
        refreshChapterTimes(p);
      });
      ui.drafts = {};
      project().drafts = {};
      save();
      renderContent();
      renderHeader();
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  }
  async function transcribe() {
    if (ui.busy) return;
    if (!native())
      return toast("Local transcription runs in the installed desktop app.");
    if (!project()?.source.path) return chooseAudio();
    if (!prefs.whisper || !prefs.ffmpeg || !prefs.model) {
      showSettings();
      return toast("Choose whisper-cli, FFmpeg, and a Whisper model.");
    }
    cancelText();
    const options = subtitleOptions(
      project().subtitleOptions || prefs.subtitleOptions
    ), original = project(), reference = original.useScript === false ? null : original.referenceInput || original.availableScript;
    ui.busy = true;
    ui.cancelRequested = false;
    ui.jobId = uid();
    ui.progress = "Starting local Whisper…";
    ui.percent = null;
    renderHeader();
    renderInspector();
    refreshDocumentHeader();
    try {
      let reply = await invoke("transcribe", {
        path: audioPath(original),
        ffmpeg: prefs.ffmpeg,
        whisper: prefs.whisper,
        model: prefs.model,
        language: prefs.language,
        threads: prefs.threads,
        jobId: ui.jobId,
        prompt: reference ? reference.words.slice(0, 60).map((w) => w.text).join(" ") : "",
        pauseSeconds: options.pauseSeconds
      });
      if (ui.cancelRequested) throw "Cancelled";
      if (project()?.id !== original.id) throw Error("The active project changed; recognition was not applied.");
      let quality = recognitionQuality(reply.transcript, reference, reply.source.duration);
      if (quality.suspicious) {
        ui.progress = "Checking recognition against the original recording…";
        renderHeader();
        const retry = await invoke("transcribe", { path: audioPath(original), ffmpeg: prefs.ffmpeg, whisper: prefs.whisper, model: prefs.model, language: prefs.language, threads: prefs.threads, jobId: ui.jobId, prompt: "", pauseSeconds: options.pauseSeconds });
        const nextQuality = recognitionQuality(retry.transcript, reference, retry.source.duration);
        if (nextQuality.score >= quality.score) {
          reply = retry;
          quality = nextQuality;
        }
      }
      if (quality.overflow) throw Error("Recognition extends beyond the recording. The previous transcript and shared timing were kept. Try an explicit language or another model.");
      if (quality.suspicious && quality.coverage < 0.7 && original.cues.length) throw Error("Recognition omitted too much reference text. Your previous transcript and timings were kept.");
      let next = parseWhisper(reply.transcript, {
        ...original.source,
        ...reply.source,
        path: original.source.path,
        embeddedPath: original.source.embeddedPath,
        previewPath: original.source.previewPath
      });
      next.subtitleOptions = options;
      next.chapters = clone(original.chapters || []);
      if (original.studioLink) next.studioLink = clone(original.studioLink);
      if (original.availableScript)
        next.availableScript = clone(original.availableScript);
      if (original.referenceInput)
        next.referenceInput = clone(original.referenceInput);
      next.id = original.id;
      next.name = original.name;
      if (original.privateFile) next.privateFile = original.privateFile;
      if (original.cues.length) next.previousTranscription = { updatedAt: original.updatedAt, cues: clone(original.cues), sourceWords: clone(original.sourceWords || []) };
      if (quality.suspicious) next.workflowWarnings = ["Recognition needs review against the recording; the script was not forced onto missing speech."];
      if (reference) {
        try {
          matchScript(next, reference);
        } catch (e) {
          next.workflowWarnings = [String(e.message || e)];
        }
      }
      if (options.speakers === 1)
        for (const c of next.cues)
          for (const w of c.words) w.speaker = "Speaker 1";
      if (ui.matchReference) next = retimeImported(referenceProject(original, ui.matchReference), next);
      if (!ui.matchReference || !ui.matchKeepsDivision) resegment(next, options);
      next.timingAlignmentPending = true;
      if (prefs.whisperxPython) {
        ui.progress = "Improving word timing…";
        ui.percent = null;
        renderHeader();
        try {
          const request = alignmentRequest(next, "auto", prefs.threads);
          request.mixedLanguages = options.mixedLanguages;
          request.speakers = options.speakers;
          const aligned2 = await invoke("align_words", {
            python: prefs.whisperxPython,
            ffmpeg: prefs.ffmpeg,
            path: audioPath(next),
            request,
            jobId: ui.jobId,
            probe: false,
            hfToken: ui.hfToken || null
          });
          if (ui.cancelRequested) throw "Cancelled";
          const summary = applyAlignment(next, aligned2);
          aligned(next, summary.unresolved);
          if (aligned2.warnings?.length)
            next.workflowWarnings = [
              ...next.workflowWarnings || [],
              ...aligned2.warnings
            ];
        } catch (e) {
          if (String(e) === "Cancelled") throw e;
          next.workflowWarnings = [
            ...next.workflowWarnings || [],
            "WhisperX could not finish; recognition timings were kept. " + String(e.message || e)
          ];
        }
      }
      if (!prefs.whisperxPython) next.workflowWarnings = [...next.workflowWarnings || [], "Word timing improvement is not set up. Recognition timings were kept. Configure WhisperX and use Retry word timing."];
      attachPauses(next, reply.pauses || [], options.pauseSeconds);
      if (reference && next.chapters.some((c) => c.timeMode === "matched")) {
        const check = clone(next);
        try {
          const matched = matchScript(check, reference, { correct: false });
          refreshChapterTimes(next, matched);
        } catch {
          refreshChapterTimes(next);
        }
      }
      next.diagnostics = timingDiagnostics(next);
      if (project()?.id !== original.id) throw Error("The active project changed; this result was not applied.");
      next.filePath = original.filePath;
      delete next.timingsNeedMatch;
      delete next.timingsCleared;
      await openProject(next);
      await save();
      toast(
        next.workflowWarnings?.length ? "Transcript ready. Open Timing report for the remaining checks." : "Transcript ready."
      );
    } catch (e) {
      if (String(e) === "Cancelled")
        toast("Transcription cancelled. Your existing transcript is preserved.");
      else
        modal(
          `<header><h2>Transcription could not finish</h2><button data-action="close-modal" aria-label="Close error">×</button></header><p>Your existing transcript is preserved.</p><details><summary>Engine details</summary><pre class="engine-error">${esc(String(e))}</pre></details><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="settings">Settings</button></footer>`
        );
    } finally {
      ui.busy = false;
      ui.jobId = null;
      renderHeader();
      renderInspector();
      refreshDocumentHeader();
      studio.schedule();
    }
  }
  function modal(html) {
    $("#dialogs").innerHTML = `<div class="modal-backdrop"><section role="dialog" aria-modal="true" class="modal">${html}</section></div>`;
    $("#dialogs").querySelector("input,button,select")?.focus();
  }
  function closeModal() {
    $("#dialogs").innerHTML = "";
    delete ui.exportProjectId;
    delete ui.chapterDrafts;
  }
  function showSettings() {
    modal(
      `<header><h2>Settings</h2><button data-action="close-modal" aria-label="Close settings">×</button></header><div class="settings-tabs" role="tablist"><button role="tab" aria-selected="true" data-settings-tab="general">General</button><button role="tab" aria-selected="false" data-settings-tab="models">Transcription Models</button></div><section data-settings-panel="general"><label class="field-label">Theme<select id="theme"><option value="dark" ${prefs.theme !== "light" ? "selected" : ""}>Dark</option><option value="light" ${prefs.theme === "light" ? "selected" : ""}>Light</option></select></label><label class="field-label">Standalone save folder<span id="transcript-directory">${esc(prefs.transcriptDirectory || "Desktop/Subtitler")}</span><button data-action="choose-transcript-directory">Change save folder…</button></label><label class="field-label">Storyboard project<span class="small" id="folder-path">${esc(project()?.studioLink?.directory || "Not connected")}</span><button class="secondary" data-action="project-folder">${project()?.studioLink?.directory ? "Relink project folder" : "Choose project folder"}</button></label><p id="folder-status" class="small">${esc(studio.status().text)}</p><button class="secondary" data-action="shortcuts">Shortcuts</button><section id="shortcuts-list" hidden><dl><dt>Space</dt><dd>Play / pause</dd><dt>Enter in subtitle text</dt><dd>Save text · Shift+Enter adds a line</dd><dt>Escape / Cancel / click outside text</dt><dd>Discard the current text edit</dd><dt>Enter / leave timing fields</dt><dd>Save timing</dd><dt>⌘/Ctrl Z · ⇧⌘/Ctrl Z</dt><dd>Undo · Redo</dd><dt>⌘/Ctrl K · ⌘/Ctrl M</dt><dd>Split · Merge</dd><dt>⌘/Ctrl S</dt><dd>Save project</dd><dt>Shift-click subtitle numbers</dt><dd>Select adjacent subtitles</dd></dl></section></section><section data-settings-panel="models" hidden><p id="tool-message" role="status">${esc(ui.toolMessage)}</p>${[
        ["whisper", "whisper-cli"],
        ["ffmpeg", "FFmpeg"],
        ["model", "Whisper model (.bin)"],
        ["whisperxPython", "WhisperX Python (optional)"]
      ].map(
        ([key2, label]) => `<label class="field-label">${label}<div class="path-input"><input id="tool-${key2}" value="${esc(prefs[key2])}"><button data-browse="${key2}">Browse</button></div></label>`
      ).join(
        ""
      )}<button class="secondary" data-action="check-whisperx">Check WhisperX</button><label class="field-label">CPU threads<input id="threads" type="number" min="1" max="16" value="${prefs.threads}"></label><button class="secondary" data-action="rediscover">Find shared tools</button></section><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="save-settings">Save settings</button></footer>`
    );
  }
  function showOptions() {
    const o = subtitleOptions(
      project()?.subtitleOptions || prefs.subtitleOptions
    ), ref = project()?.referenceInput || project()?.availableScript;
    modal(
      `<header><h2>Transcription options</h2><button data-action="close-modal" aria-label="Close options">×</button></header><div class="options-grid">${[
        ["minWords", "Minimum words", 1, 100, 1],
        ["maxWords", "Maximum words", 1, 100, 1],
        ["maxChars", "Characters per line", 8, 120, 1],
        ["maxSeconds", "Maximum seconds", 1, 30, 0.5],
        ["pauseSeconds", "Label silence longer than (seconds)", 0.1, 10, 0.1],
        ["speakers", "Speakers (0 = detect)", 0, 20, 1]
      ].map(
        ([k, label, min, max, step]) => `<label class="field-label">${label}<input id="opt-${k}" type="number" min="${min}" max="${max}" step="${step}" value="${o[k]}"></label>`
      ).join(
        ""
      )}<label class="field-label">Lines per subtitle<select id="opt-lines"><option value="1" ${o.lines === 1 ? "selected" : ""}>1</option><option value="2" ${o.lines === 2 ? "selected" : ""}>2</option></select></label></div><p class="small">Transcribe and Match timings finish with WhisperX word alignment when configured.</p><label class="check-label"><input id="opt-mixedLanguages" type="checkbox" ${o.mixedLanguages ? "checked" : ""}> Automatic English / Japanese alignment switching</label><details><summary>Speaker model access</summary><p>More than one speaker uses the free pyannote model through WhisperX. First accept its terms on Hugging Face and provide a read token, or use an existing Hugging Face login. One speaker skips detection.</p><label class="field-label">Hugging Face token (this session only)<input type="password" id="hf-token" autocomplete="off" value="${esc(ui.hfToken || "")}"></label><a href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">Speaker model terms</a></details><section class="script-reference"><strong>Reference text</strong><p>${ref ? esc(ref.projectName || ref.chapters.map((c) => c.title).join(" · ") || "Imported text") + " · " + ref.words.length + " words" : "No reference text"}</p><button class="secondary" data-action="choose-script">Import reference text</button>${project()?.availableScript ? '<button class="secondary" data-action="use-project-script">Use project text</button>' : ""}${ref ? '<button class="secondary" data-action="remove-script">Remove reference</button>' : ""}<label class="check-label"><input id="opt-useScript" type="checkbox" ${ref && project()?.useScript !== false ? "checked" : ""}> Use reference text for recognition</label></section><p class="small">Minimum words is a preference. Silence, speaker changes and maximum limits take priority. An unusually long word stays intact.</p><footer><button class="secondary" data-action="save-options">Save options</button><button class="primary" data-action="apply-layout" ${project()?.cues.length ? "" : "disabled"}>Apply division to current subtitles</button></footer>`
    );
  }
  function readOptions() {
    const out = {};
    for (const k of [
      "minWords",
      "maxWords",
      "maxChars",
      "maxSeconds",
      "pauseSeconds",
      "speakers",
      "lines"
    ])
      out[k] = Number($("#opt-" + k).value);
    out.autoAlign = true;
    for (const k of ["mixedLanguages"])
      out[k] = $("#opt-" + k).checked;
    prefs.subtitleOptions = subtitleOptions(out);
    if (project()) {
      project().subtitleOptions = clone(prefs.subtitleOptions);
      project().useScript = !!$("#opt-useScript")?.checked;
    }
    ui.hfToken = $("#hf-token")?.value.trim() || "";
    preferences();
    save();
    return out;
  }
  async function importAny(input) {
    const fileName = typeof input === "string" ? input : input.name;
    if (/\.(subtitler|whisperdesk)$/i.test(fileName)) return typeof input === "string" ? openDocumentFile(input) : readInput(input);
    const name = typeof input === "string" ? input : input.name;
    if (/\.(wav|mp3|m4a|aac|flac|ogg|aiff?|opus|wma)$/i.test(name))
      return audioInput(input);
    if (/\.(txt|docx)$/i.test(name)) return importScript(input);
    return readInput(input);
  }
  async function importScript(input) {
    const isPath = typeof input === "string", name = isPath ? input : input.name;
    let parsed;
    if (/\.docx$/i.test(name)) {
      const data = isPath ? Uint8Array.from(
        atob(await invoke("read_script_document", { path: input })),
        (c) => c.charCodeAt(0)
      ) : await input.arrayBuffer();
      parsed = await docxScript(data);
    } else
      parsed = parseScript(
        isPath ? await invoke("read_transcript", { path: input }) : await input.text()
      );
    commit("Import reference text", (p) => {
      p.referenceInput = parsed;
      p.useScript = true;
      adoptReferenceChapters(p, parsed);
    });
    toast("Reference text selected.");
    if ($("#opt-maxWords")) showOptions();
  }
  function cancelText() {
    const c = selectedCue();
    if (!c || !Object.prototype.hasOwnProperty.call(ui.drafts, c.id)) return;
    delete ui.drafts[c.id];
    project().drafts = {};
    const el = $("#subtitle-text");
    if (el) el.value = cueText(c);
    growTextarea();
  }
  function persistTiming(kind) {
    const c = selectedCue(), w = selectedWord();
    if (!c || ui.busy) return;
    try {
      if (kind === "word" && !w) return;
      const a = seconds($(kind === "word" ? "#word-start" : "#cue-start").value), b = seconds($(kind === "word" ? "#word-end" : "#cue-end").value), target = kind === "word" ? w : c;
      if (a === target.start && b === target.end) return;
      history.change(
        kind === "word" ? "Adjust word timing" : "Adjust subtitle timing",
        (p) => {
          if (kind === "word") {
            const i = c.words.indexOf(w);
            if (a < c.start || b > c.end || a >= b || i && a < c.words[i - 1].end || i < c.words.length - 1 && b > c.words[i + 1].start)
              throw Error("Keep the word between its neighbors.");
            Object.assign(w, { start: a, end: b, timing: "manual" });
            delete w.alignmentIssue;
          } else retimeCue(p, c.id, a, b);
        }
      );
      save();
      const badge = document.querySelector(
        `[data-cue-time="${CSS.escape(c.id)}"]`
      );
      if (badge)
        badge.innerHTML = clock(c.start) + " <span>→ " + clock(c.end) + "</span>";
      updatePlayback(false);
    } catch (e) {
      report(e);
      const a = kind === "word" ? w : c;
      $(kind === "word" ? "#word-start" : "#cue-start").value = clock(a.start);
      $(kind === "word" ? "#word-end" : "#cue-end").value = clock(a.end);
    }
  }
  function showAlignment() {
    if (ui.busy || !project()?.cues.length) return;
    if (!native())
      return toast("WhisperX alignment runs in the installed desktop app.");
    if (!prefs.whisperxPython || !prefs.ffmpeg) {
      showSettings();
      return toast("Set up WhisperX Python and FFmpeg in Settings first.");
    }
    if (!applyDrafts()) return;
    const lang = ["en", "pt", "es", "ja"].includes(project().language) ? project().language : prefs.language;
    modal(
      `<header><h2>Improve word timing</h2><button data-action="close-modal" aria-label="Close alignment">×</button></header><p>Align the current transcript to your recording with WhisperX. This process won’t affect your current subtitle text or division. One Undo restores the previous timings.</p><label class="field-label">Recording language<select id="align-language"><option value="auto">Automatic / mixed language</option>${[
        ["en", "English"],
        ["pt", "Português"],
        ["es", "Español"],
        ["ja", "日本語"]
      ].map(
        ([id, label]) => `<option value="${id}" ${id === lang ? "selected" : ""}>${label}</option>`
      ).join(
        ""
      )}</select></label><label class="check-label"><input type="checkbox" id="align-manual"> Replace manually adjusted timing too</label><p class="small">Correct transcript errors first for more accurate word timing.</p><footer><button class="secondary" data-action="close-modal">Cancel</button><button class="primary" data-action="run-alignment">Improve timing</button></footer>`
    );
  }
  function showAlignmentReport() {
    const p = project(), a = p?.recognition?.alignment, d = p ? timingDiagnostics(p) : null;
    if (!p) return;
    modal(
      `<header><h2>Word timing report</h2><button data-action="close-modal" aria-label="Close report">×</button></header>${a ? `<p>${a.aligned} aligned · ${a.unresolved} kept previous timing · ${a.protectedWords} manual timings protected.</p>` : ""}<p>${d.words} words · ${d.estimated} estimated · ${d.veryShort.length} shorter than 60 ms.</p>${(p.workflowWarnings || []).map((w) => `<p>${esc(w)}</p>`).join("")}${p.scriptReference ? `<p>Reference text: ${p.scriptReference.matched}/${p.scriptReference.referenceWords} matched. Additions and omissions follow the recording.</p><details><summary>Reference differences</summary>${p.scriptReference.changes.map((c) => `<p>${esc(c.kind)}: ${esc(c.recognized || c.script)}</p>`).join("")}</details>` : ""}<div class="alignment-issues">${p.cues.filter(
        (c) => c.words.some((w) => w.alignmentIssue || d.veryShort.includes(w.id))
      ).map(
        (c) => `<button data-review-cue="${esc(c.id)}">${String(p.cues.indexOf(c) + 1).padStart(2, "0")} · ${esc(cueText(c).slice(0, 100))}</button>`
      ).join("")}</div>`
    );
  }
  async function runAlignment(probe, automatic = false) {
    if (ui.busy || !native()) return;
    const python = probe ? $("#tool-whisperxPython")?.value.trim() : prefs.whisperxPython;
    if (!python)
      return toast(
        "Run the WhisperX setup command, then choose its Python in Settings."
      );
    const original = project(), request = probe ? {} : alignmentRequest(
      original,
      automatic ? original.alignmentLanguage || "auto" : $("#align-language").value,
      prefs.threads
    ), replaceManual = !automatic && !!$("#align-manual")?.checked;
    request.mixedLanguages = project()?.subtitleOptions?.mixedLanguages !== false;
    const fingerprint = JSON.stringify(original.cues);
    const sourceFingerprint = original.source.fingerprint;
    if (!probe) closeModal();
    ui.busy = true;
    ui.cancelRequested = false;
    ui.jobId = uid();
    ui.percent = null;
    ui.progress = probe ? "Checking WhisperX…" : "Preparing alignment…";
    $("#audio").pause();
    renderHeader();
    renderInspector();
    refreshDocumentHeader();
    try {
      const reply = await invoke("align_words", {
        python,
        ffmpeg: prefs.ffmpeg,
        path: audioPath(original) || "",
        request,
        jobId: ui.jobId,
        probe,
        hfToken: ui.hfToken || null
      });
      if (ui.cancelRequested) throw "Cancelled";
      if (probe) {
        toast(`WhisperX ${reply.version} is ready (CPU).`);
        return;
      }
      if (project()?.id !== original.id || JSON.stringify(project().cues) !== fingerprint || project().source.fingerprint !== sourceFingerprint)
        throw Error("The transcript changed during alignment. Run it again.");
      let summary;
      history.change("Improve word timing", (p) => {
        summary = applyAlignment(p, reply, { replaceManual });
        aligned(p, summary.unresolved);
        refreshChapterTimes(p);
        delete p.timingsNeedMatch;
        delete p.timingsCleared;
      });
      await save();
      renderContent();
      showAlignmentReport();
      return !summary.unresolved;
    } catch (e) {
      if (String(e) === "Cancelled")
        toast("Alignment cancelled. Previous timings are preserved.");
      else
        modal(
          `<header><h2>WhisperX could not finish</h2><button data-action="close-modal" aria-label="Close error">×</button></header><p>Previous timings are preserved. Check the Python environment, recording language and network connection for the first model download.</p><details><summary>Engine details</summary><pre class="engine-error">${esc(String(e))}</pre></details><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="settings">Settings</button></footer>`
        );
    } finally {
      ui.busy = false;
      ui.jobId = null;
      renderHeader();
      renderInspector();
      refreshDocumentHeader();
    }
  }
  function adoptReferenceChapters(p, reference) {
    installReferenceChapters(p, reference);
    if (p.cues.length && p.chapters.some((c) => c.timeMode === "matched")) {
      try {
        const check = clone(p);
        const matched = matchScript(check, reference, { correct: false });
        refreshChapterTimes(p, matched);
      } catch {
        refreshChapterTimes(p);
      }
    }
  }
  function captureChapterDrafts() {
    $("#chapter-list")?.querySelectorAll("[data-chapter-row]").forEach((row, index) => {
      const draft = ui.chapterDrafts[index];
      draft.title = row.querySelector("[data-chapter-title]").value;
      draft.timeText = row.querySelector("[data-chapter-time]").value;
      draft.level = Number(row.querySelector("[data-chapter-level]").value);
    });
  }
  function chapterDraftValues() {
    captureChapterDrafts();
    const duration = project().source.duration || 0;
    const result = ui.chapterDrafts.map((draft) => {
      const chapter = clone(draft), start2 = chapterSeconds(chapter.timeText);
      delete chapter.timeText;
      chapter.title = chapter.title.trim();
      if (!chapter.title) throw Error("Give every chapter a name, or remove its row.");
      if (start2 != null && duration && start2 > duration + 1e-3) throw Error(`“${chapter.title}” starts after the recording ends.`);
      if (start2 !== chapter.start || chapter.needsReview) {
        chapter.timeMode = "manual";
        chapter.anchorWordId = null;
      }
      chapter.start = start2;
      delete chapter.needsReview;
      return chapter;
    });
    validateProject({ ...project(), chapters: result });
    return result;
  }
  function showChapters(resume = false) {
    if (!resume) ui.chapterDrafts = clone(project().chapters || []).map((c) => ({ ...c, timeText: c.start == null ? "" : clock(c.start) }));
    modal(`<header><h2>Chapters</h2><button data-action="close-modal" aria-label="Close chapters">×</button></header><p>Optional chapter markers. Enter a name and start time. Your recording stays unchanged.</p><div id="chapter-list">${ui.chapterDrafts.map((c, i) => `<section class="chapter-row" data-chapter-row="${i}"><label class="field-label">Name<input data-chapter-title maxlength="200" aria-label="Chapter ${i + 1} name" value="${esc(c.title)}"></label><label class="field-label">Start time<input data-chapter-time inputmode="decimal" aria-label="Chapter ${i + 1} start time" placeholder="Not placed" value="${esc(c.timeText)}"></label><label class="field-label">Heading<select data-chapter-level aria-label="Chapter ${i + 1} heading">${Array.from({ length: 6 }, (_, n) => `<option value="${n + 1}" ${c.level === n + 1 ? "selected" : ""}>${n === 0 ? "Chapter" : n === 1 ? "Subchapter" : "Heading " + (n + 1)}</option>`).join("")}</select></label><button class="chapter-remove" data-action="chapter-remove" data-index="${i}" aria-label="Remove chapter ${i + 1}">×</button><small>${c.needsReview ? "Recording changed — review this time." : c.timeText ? c.timeMode === "matched" ? "Matched to speech" : "Manual timestamp" : "Not placed — match the reference or enter a time."}</small></section>`).join("") || '<p class="small">No chapters yet. Use ＋ to add one, or import reference text with Word headings.</p>'}</div><p id="chapter-error" role="status" aria-live="polite"></p><footer><button class="secondary" data-action="chapter-add" aria-label="Add chapter">＋</button>${referenceOf(project())?.chapters?.some((c) => c.isHeading) && project().cues.length ? '<button class="secondary" data-action="chapter-match">Match imported headings</button>' : ""}<button class="primary" data-action="save-chapters">Save chapters</button></footer>`);
  }
  function chapterError(fn) {
    try {
      fn();
    } catch (error) {
      $("#chapter-error").textContent = error.message || String(error);
    }
  }
  function matchChapterDrafts() {
    const p = clone(project());
    p.chapters = chapterDraftValues();
    const matched = matchScript(p, referenceOf(p), { correct: false });
    if (matched.matched < Math.max(1, referenceOf(p).words.length * 0.65)) throw Error("Not enough reference text matched the transcript. Match timings first or enter chapter times manually.");
    ui.chapterDrafts = p.chapters.map((c) => ({ ...c, timeText: c.start == null ? "" : clock(c.start) }));
    showChapters(true);
  }
  function showExport(target = project()) {
    if (ui.exporting) return;
    if (!target) return;
    if (target.id === project()?.id && !applyDrafts()) return;
    ui.exportProjectId = target.id;
    modal(
      `<header><h2>Export transcript</h2><button data-action="close-modal" aria-label="Close export">×</button></header><p>Export your edited subtitles. Timing JSON retains word timings and original recognition for Storyboard Studio.</p>${(target.chapters || []).some((c) => c.start == null || c.needsReview) ? '<p class="chapter-warning">Some chapters need a start time or review. Only placed chapters appear in DOCX and TXT; all chapter entries stay in your editable project.</p>' : ""}<div class="export-grid">${[
        ["docx", "Word document"],
        ["txt", "Plain text"],
        ["srt", "Subtitles"],
        ["csv", "Subtitle table"],
        ["xlsx", "Subtitles + words"],
        ["json", "Timing for Storyboard Studio"],
        ["subtitler", "Editable Subtitler project"]
      ].map(
        ([format, label]) => `<button data-export="${format}"><strong>.${format}</strong><span>${label}</span></button>`
      ).join(
        ""
      )}</div><label class="check-label"><input id="export-timestamps" type="checkbox"> Include timestamps in DOCX / TXT</label><p id="export-status" class="small" role="status" aria-live="polite"></p><p class="small">The editable .subtitler export is an independent copy, including its available audio. Other formats contain text and timing.</p>`
    );
  }
  async function download(format) {
    if (ui.exporting) return;
    const targetId = ui.exportProjectId || project()?.id;
    if (targetId === project()?.id && !applyDrafts()) return;
    const current = project()?.id === targetId ? project() : projects.find((p) => p.id === targetId);
    if (!current) throw Error("Open a transcript before exporting.");
    const target = clone(current);
    const timestamps = !!$("#export-timestamps")?.checked;
    const status = $("#export-status");
    const buttons = [...document.querySelectorAll("[data-export], #export-timestamps")];
    ui.exporting = true;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    if (status) status.textContent = "Preparing export…";
    try {
      if (format === "subtitler" && native()) {
        const path2 = await invoke("choose_document_save", { name: target.name });
        if (!path2) {
          if (status) status.textContent = "Export cancelled. Choose a format to try again.";
          return;
        }
        const copy = standalone(target);
        copy.filePath = path2;
        await invoke("write_document", { path: path2, data: JSON.stringify(copy) });
        toast("Subtitler project exported with its available audio.");
        closeModal();
        return;
      }
      const output = await makeExport(target, format, {
        timestamps
      }), blob = new Blob([output.data], { type: output.mime });
      if (native()) {
        const data = await new Promise((r, j) => {
          const f = new FileReader();
          f.onload = () => r(String(f.result).split(",")[1]);
          f.onerror = j;
          f.readAsDataURL(blob);
        });
        if (target.studioLink?.directory && format !== "subtitler") {
          await invoke("write_subtitler_export", {
            directory: target.studioLink.directory,
            studioProjectId: target.studioLink.projectId || null,
            projectId: target.id,
            filename: output.name,
            data
          });
          toast("Saved in your chosen project folder.");
        } else {
          if (!await invoke("save_export", { filename: output.name, data })) {
            if (status) status.textContent = "Export cancelled. Choose a format to try again.";
            return;
          }
          toast("Export saved.");
        }
      } else {
        const url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url;
        a.download = output.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }
      closeModal();
    } catch (error) {
      if (status) status.textContent = "Could not export: " + (error.message || String(error));
      else report(error);
    } finally {
      ui.exporting = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }
  function splitAt(cueId, wordId) {
    if (ui.busy) return;
    if (!applyDrafts()) return;
    commit("Split subtitle", (p) => {
      const next = splitCue(p, cueId, wordId);
      ui.selected = [next.id];
      ui.anchor = next.id;
      ui.wordId = next.words[0]?.id;
    });
  }
  function mergeAfter(id) {
    if (ui.busy) return;
    if (!applyDrafts()) return;
    const cues = project().cues, i = cues.findIndex((c) => c.id === id);
    if (i < 0 || !cues[i + 1]) return;
    let ids = ui.selected.length > 1 && ui.selected.includes(id) ? ui.selected : [id, cues[i + 1].id];
    commit("Merge subtitles", (p) => {
      const merged = mergeCues(p, ids);
      ui.selected = [merged.id];
      ui.anchor = merged.id;
      ui.wordId = null;
    });
  }
  function deleteCues(ids) {
    if (ui.busy) return;
    const previous = ui.drafts;
    ui.drafts = Object.fromEntries(
      Object.entries(previous).filter(([id]) => !ids.includes(id))
    );
    if (!applyDrafts()) {
      ui.drafts = previous;
      return;
    }
    const index = project().cues.findIndex((c) => ids.includes(c.id));
    commit("Delete subtitles", (p) => {
      p.cues = p.cues.filter((c) => !ids.includes(c.id));
      for (const id of ids) delete ui.drafts[id];
      const next = p.cues[Math.min(Math.max(index, 0), p.cues.length - 1)];
      ui.selected = next ? [next.id] : [];
      ui.anchor = next?.id;
      ui.wordId = null;
    });
  }
  var context = null;
  function closeContext() {
    $("#context-menu")?.remove();
    context = null;
  }
  function contextMenu(kind, id, x, y) {
    closeContext();
    if (kind !== "cue") return;
    context = { kind, id };
    const el = document.createElement("div");
    el.id = "context-menu";
    el.role = "menu";
    el.innerHTML = (kind === "cue" ? '<button role="menuitem" data-action="context-language">Alignment language…</button>' : "") + `<button role="menuitem" data-action="context-delete">Delete${kind === "cue" && ui.selected.includes(id) && ui.selected.length > 1 ? " selected subtitles" : ""}</button>`;
    document.body.append(el);
    el.style.left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + "px";
    el.querySelector("button").focus();
  }
  async function discover(explicit = false) {
    if (!native()) {
      if (explicit) toast("Tool locations are set in the desktop app.");
      return;
    }
    if (ui.detectingTools) return;
    const before = {
      whisper: prefs.whisper,
      ffmpeg: prefs.ffmpeg,
      model: prefs.model,
      whisperxPython: prefs.whisperxPython
    };
    ui.detectingTools = true;
    const message = $("#tool-message");
    if (message) message.textContent = "Finding shared tools…";
    try {
      const discovered = await startupDeadline(
        invoke("discover_tools"),
        "Auto-detection did not finish. Existing paths are unchanged.",
        5e3
      );
      tools = {
        ...discovered,
        models: Array.isArray(discovered?.models) ? discovered.models : []
      };
      for (const key2 of ["whisper", "ffmpeg", "whisperxPython"])
        if (!prefs[key2] && prefs[key2] === before[key2])
          prefs[key2] = tools[key2] || "";
      if (!prefs.model && prefs.model === before.model)
        prefs.model = tools.models.find((m) => m.path.includes("turbo"))?.path || tools.models[0]?.path || "";
      if (explicit) {
        for (const key2 of ["whisper", "ffmpeg", "model", "whisperxPython"]) {
          const el = $("#tool-" + key2);
          if (el && !el.value.trim()) {
            el.value = key2 === "model" ? tools.models.find((m) => m.path.includes("turbo"))?.path || tools.models[0]?.path || "" : tools[key2] || "";
          }
        }
      }
      ui.toolMessage = "";
      preferences();
    } catch (e) {
      console.warn("Tool discovery:", e);
      ui.toolMessage = explicit ? e.message : "Auto-detection is unavailable. Configured paths are preserved.";
    } finally {
      ui.detectingTools = false;
      const el = $("#tool-message");
      if (el) el.textContent = ui.toolMessage;
      renderHeader();
    }
  }
  async function openDocumentFile(path2, here = false) {
    if (native() && !here) return invoke("new_document_window", { path: path2, request: null });
    if (native()) {
      const opened = await invoke("open_document", { path: path2 });
      if (!await invoke("claim_document", { path: opened.path })) return;
      const next = openedDocument(opened.data, opened.path);
      if (opened.audioPath) next.source.embeddedPath = opened.audioPath;
      if (opened.audioWarning) toast(opened.audioWarning);
      if (next.id === opened.data.id) lastSavedKey.set(next.id, contentKey(opened.data));
      await openProject(next);
      const at = projects.findIndex((p) => p.id === next.id);
      at < 0 ? projects.unshift(clone(next)) : projects[at] = clone(next);
      await database.save(next);
      await save();
      return;
    }
    return readInput(path2);
  }
  function showRecent() {
    const paths = /* @__PURE__ */ new Map();
    for (const p of projects.slice().sort((a, b) => String(b.lastOpenedAt || b.updatedAt).localeCompare(String(a.lastOpenedAt || a.updatedAt)))) {
      const path2 = p.filePath || p.studioLink?.projectFile || p.privateFile || p.openedFile;
      if (path2 && !paths.has(path2)) paths.set(path2, p);
    }
    modal(`<header><h2>Open Recent</h2><button data-action="close-modal">×</button></header><div class="recent-projects">${[...paths].slice(0, 30).map(([path2, p]) => `<button data-recent-path="${esc(path2)}">${esc(p.name)}<small>${esc(path2)}</small></button>`).join("") || "No recent projects."}</div>`);
  }
  function referenceText(ref) {
    return ref?.chapters?.some((c) => typeof c.text === "string") ? ref.chapters.map((c) => c.text || "").join("\n\n") : ref?.words?.map((w) => w.text).join(" ") || "";
  }
  function referencePanel() {
    const ref = project().useScript === false ? null : project().referenceInput || project().availableScript;
    const text = referenceText(ref);
    modal(`<header><h2>Reference text</h2><button data-action="close-modal">×</button></header><textarea id="reference-input" placeholder="Paste reference text here…" aria-label="Reference text">${esc(text)}</textarea><footer><button class="secondary" data-action="import-reference">Import text…</button><button class="secondary" data-action="clear-reference">Clear</button><button class="primary" data-action="apply-reference">Save reference</button></footer>`);
  }
  async function importReference() {
    if (native()) {
      const file = await invoke("pick_file", { kind: "script" });
      if (file) {
        closeModal();
        await importScript(file);
      }
    } else $("#script-file").click();
  }
  async function matchTimings() {
    const p = project();
    if (!canMatch(p)) return;
    ui.matchReference = referenceOf(p);
    ui.matchKeepsDivision = p.cues.length && spokenKey(p) === spokenKey({ cues: [{ words: ui.matchReference.words }] });
    try {
      await transcribe();
    } finally {
      ui.matchReference = null;
      ui.matchKeepsDivision = false;
    }
  }
  async function handleStudioRequest(r, here = false) {
    if (!here && (project()?.source.name || project()?.cues.length || project()?.referenceInput)) return invoke("new_document_window", { path: null, request: r });
    const info = { ...r.workspace, projectId: r.projectId, activeRecording: r.activeRecording || r.workspace?.activeRecording };
    const ok = await openWorkspace(info, { audioPath: info.activeRecording?.path || null, match: true, explicit: true });
    if (ok) {
      prefs.lastStudioRequestId = r.requestId;
      preferences();
    }
    return ok;
  }
  var actions = {
    "new-project": () => native() ? invoke("new_document_window", { path: null, request: null }) : window.open(location.href, "_blank"),
    "open-project": async () => {
      const file = await invoke("pick_file", { kind: "project" });
      if (file) await openDocumentFile(file);
    },
    "import-audio": () => chooseAudio(true),
    "import-reference": importReference,
    "import-subtitles": async () => {
      if (native()) {
        const file = await invoke("pick_file", { kind: "subtitles" });
        if (file) await readInput(file);
      } else $("#transcript-file").click();
    },
    "reference-text": referencePanel,
    "chapters": () => showChapters(),
    "chapter-add": () => {
      captureChapterDrafts();
      const time = $("#audio").currentTime || 0;
      ui.chapterDrafts.push({ id: uid(), title: "", level: 1, start: time, timeText: clock(time), timeMode: "manual", origin: "manual" });
      showChapters(true);
      $("#chapter-list [data-chapter-row]:last-child input")?.focus();
    },
    "chapter-remove": (button) => {
      captureChapterDrafts();
      ui.chapterDrafts.splice(Number(button.dataset.index), 1);
      showChapters(true);
    },
    "chapter-match": () => chapterError(matchChapterDrafts),
    "save-chapters": () => chapterError(() => {
      const chapters = chapterDraftValues();
      commit("Edit chapters", (p) => {
        p.chapters = chapters;
      });
      closeModal();
      wave.draw();
    }),
    "chapter-seek": (button) => seek(Number(button.dataset.start)),
    "apply-reference": () => {
      const text = $("#reference-input").value;
      if (text === referenceText(referenceOf(project()))) {
        closeModal();
        return;
      }
      commit("Change reference text", (p) => {
        if (text.trim()) {
          p.referenceInput = parseScript(text);
          p.useScript = true;
        } else {
          delete p.referenceInput;
          p.useScript = false;
        }
      });
      closeModal();
    },
    "clear-reference": () => {
      commit("Clear reference text", (p) => {
        delete p.referenceInput;
        delete p.scriptReference;
        p.useScript = false;
      });
      referencePanel();
    },
    "clear-transcript": () => {
      if (!project().cues.length) return;
      modal(`<header><h2>Clear transcript?</h2></header><p>Remove subtitles and timings from this project. Undo restores them. Audio and reference text stay.</p><footer><button data-action="close-modal">Cancel</button><button class="danger" data-action="confirm-clear-transcript">Clear</button></footer>`);
    },
    "confirm-clear-transcript": () => {
      commit("Clear transcript", (p) => {
        p.cues = [];
        p.sourceWords = [];
        p.pauses = [];
        p.timingsCleared = true;
        delete p.scriptReference;
        delete p.recognition;
        delete p.diagnostics;
      });
      closeModal();
    },
    "confirm-audio": async () => {
      const input = ui.pendingAudio;
      delete ui.pendingAudio;
      closeModal();
      ui.audioConfirmed = true;
      await audioInput(input, true);
    },
    "confirm-subtitles": async () => {
      const input = ui.pendingSubtitles;
      delete ui.pendingSubtitles;
      closeModal();
      ui.importConfirmed = true;
      await readInput(input);
    },
    "choose-transcript-directory": moveTranscriptFolder,
    "move-transcript-folder": moveTranscriptFolder,
    "audio-location": () => {
      const source2 = project()?.source;
      modal(`<header><h2>Audio location</h2><button data-action="close-modal">×</button></header><p class="full-path">${esc(source2?.path || "No audio attached")}</p><footer><button data-action="import-audio">Import audio…</button><button data-action="show-audio">Show in folder</button></footer>`);
    },
    "show-audio": () => invoke("reveal_transcript_file", { path: project().source.path }),
    "save-as": saveAs,
    "close-project": closeProject,
    "match-timings": matchTimings,
    "workspace-recording": async (el) => {
      const pending = pendingWorkspace;
      if (!pending) return;
      const audio = pending.info.audioCandidates[+el.dataset.index];
      closeModal();
      pendingWorkspace = null;
      await openWorkspace(pending.info, { audioPath: audio.path, match: pending.match });
    },
    relink: () => chooseAudio(true),
    import: async () => {
      if (ui.busy) return;
      if (native()) {
        const path2 = await invoke("pick_file", { kind: "import" });
        if (path2) await importAny(path2);
      } else $("#import-file").click();
    },
    transcribe,
    "play-pause": async () => {
      const audio = $("#audio");
      if (!mediaUrl) return;
      if (ui.playRequested || !audio.paused) {
        ui.playRequested = false;
        audio.pause();
        return;
      }
      const epoch = loadEpoch;
      ui.playRequested = true;
      try {
        await audio.play();
        if (!ui.playRequested || epoch !== loadEpoch) audio.pause();
      } catch (e) {
        ui.playRequested = false;
        throw e;
      }
    },
    cancel: async () => {
      if (ui.jobId) {
        ui.cancelRequested = true;
        await invoke("cancel_transcription");
        ui.progress = "Cancelling…";
        renderHeader();
      }
    },
    settings: showSettings,
    "project-folder": async () => {
      if (project()?.source.name || project()?.cues.length || project()?.referenceInput) {
        const directory = await invoke("choose_project_folder");
        if (!directory) return;
        const info = await invoke("inspect_project_folder", { directory, expectedProjectId: null, audioRelativePath: null });
        return invoke("new_document_window", { path: null, request: { requestId: "manual-" + uid(), projectId: info.projectId, workspace: info, activeRecording: info.activeRecording } });
      }
      return studio.choose();
    },
    shortcuts: () => {
      $("#shortcuts-list").hidden = !$("#shortcuts-list").hidden;
    },
    "transcription-options": showOptions,
    "save-options": () => {
      readOptions();
      closeModal();
    },
    "apply-layout": () => {
      const options = readOptions();
      closeModal();
      commit("Change subtitle division", (p) => resegment(p, options));
    },
    "choose-script": async () => {
      readOptions();
      if (native()) {
        const path2 = await invoke("pick_file", { kind: "script" });
        if (path2) await importScript(path2);
      } else $("#script-file").click();
    },
    "use-project-script": () => {
      readOptions();
      project().referenceInput = clone(project().availableScript);
      project().useScript = true;
      adoptReferenceChapters(project(), project().referenceInput);
      save();
      showOptions();
    },
    "remove-script": () => {
      readOptions();
      delete project().referenceInput;
      project().useScript = false;
      save();
      showOptions();
    },
    "cancel-text": cancelText,
    "rename-speaker": () => {
      const name = $("#speaker-name").value.trim();
      if (!name) return;
      commit("Rename speaker", (p) => {
        p.speakerNames || (p.speakerNames = {});
        p.speakerNames[ui.renameSpeaker] = name;
      });
      closeModal();
    },
    "context-language": () => {
      ui.languageCue = context?.id;
      closeContext();
      const c = project().cues.find((c2) => c2.id === ui.languageCue);
      if (!c) return;
      modal(
        `<header><h2>Alignment language</h2><button data-action="close-modal">×</button></header><label class="field-label">This subtitle<select id="cue-language">${[
          ["auto", "Automatic"],
          ["en", "English"],
          ["pt", "Português"],
          ["es", "Español"],
          ["ja", "日本語"]
        ].map(
          ([v, t]) => `<option value="${v}" ${v === (c.language || "auto") ? "selected" : ""}>${t}</option>`
        ).join(
          ""
        )}</select></label><footer><button class="primary" data-action="save-cue-language">Save</button></footer>`
      );
    },
    "save-cue-language": () => {
      const value = $("#cue-language").value;
      commit("Set alignment language", (p) => {
        const c = p.cues.find((c2) => c2.id === ui.languageCue);
        if (c) c.language = value;
      });
      closeModal();
    },
    "close-modal": closeModal,
    "save-settings": () => {
      for (const key2 of ["whisper", "ffmpeg", "model", "whisperxPython"])
        prefs[key2] = $("#tool-" + key2).value.trim();
      prefs.theme = $("#theme").value;
      document.documentElement.dataset.theme = prefs.theme;
      wave.draw();
      prefs.threads = Math.max(1, Math.min(16, +$("#threads").value || 6));
      ui.toolMessage = "";
      preferences();
      closeModal();
      renderHeader();
    },
    rediscover: () => discover(true),
    "improve-timing": showAlignment,
    "request-import-audio": async () => {
      closeModal();
      await chooseAudio();
    },
    "run-alignment": () => runAlignment(false),
    "check-whisperx": () => runAlignment(true),
    "timing-report": showAlignmentReport,
    export: () => showExport(),
    "save-project": saveCurrent,
    "export-project": () => {
      ui.exportProjectId = project().id;
      return download("subtitler");
    },
    "recent-projects": showRecent,
    "reveal-transcript": async () => {
      const path2 = documentPath || project()?.studioLink?.projectFile;
      if (path2 && native()) await invoke("reveal_transcript_file", { path: path2 });
      else toast("Not saved yet.");
    },
    undo: () => {
      if (!history || ui.busy) return;
      const pending = Object.keys(ui.drafts).length;
      ui.drafts = {};
      if (pending) {
        project().drafts = {};
        save();
        renderContent();
        return;
      }
      history.back();
      ui.selected = ui.selected.filter(
        (id) => project().cues.some((c) => c.id === id)
      );
      if (!ui.selected.length && project().cues.length)
        ui.selected = [project().cues[0].id];
      save();
      renderContent();
      renderHeader();
    },
    redo: () => {
      if (!history || ui.busy) return;
      ui.drafts = {};
      history.forward();
      ui.selected = ui.selected.filter(
        (id) => project().cues.some((c) => c.id === id)
      );
      if (!ui.selected.length && project().cues.length)
        ui.selected = [project().cues[0].id];
      save();
      renderContent();
      renderHeader();
    },
    scissors: () => {
      ui.scissors = !ui.scissors;
      renderContent();
    },
    "apply-text": () => applyDrafts(),
    split: () => {
      if (!applyDrafts()) return;
      const c = selectedCue();
      if (!c) return;
      let word = selectedWord();
      if (!word)
        word = c.words.find((w, i) => i && w.start >= $("#audio").currentTime);
      if (!word) return toast("Choose the first word of the new subtitle.");
      splitAt(c.id, word.id);
    },
    merge: () => {
      const c = selectedCue();
      if (c) mergeAfter(ui.selected.length > 1 ? ui.selected[0] : c.id);
    },
    "context-delete": () => {
      const target = context;
      closeContext();
      if (!target) return;
      if (target.kind === "cue") {
        const ids = ui.selected.includes(target.id) ? [...ui.selected] : [target.id];
        deleteCues(ids);
      }
    }
  };
  document.addEventListener("click", async (e) => {
    try {
      const exportButton = e.target.closest("[data-export]");
      if (exportButton) {
        if (!exportButton.disabled) await download(exportButton.dataset.export);
        return;
      }
      const tab = e.target.closest("[data-settings-tab]");
      if (tab) {
        document.querySelectorAll("[data-settings-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === tab)));
        document.querySelectorAll("[data-settings-panel]").forEach(
          (p) => p.hidden = p.dataset.settingsPanel !== tab.dataset.settingsTab
        );
        return;
      }
      const action = e.target.closest("[data-action]");
      if (action) {
        await actions[action.dataset.action]?.(action);
        return;
      }
      const pause = e.target.closest("[data-seek-pause]");
      if (pause) {
        seek(Number(pause.dataset.seekPause));
        return;
      }
      const speaker = e.target.closest("[data-speaker]");
      if (speaker) {
        ui.renameSpeaker = speaker.dataset.speaker;
        modal(
          `<header><h2>Speaker name</h2><button data-action="close-modal">×</button></header><label class="field-label">Name<input id="speaker-name" value="${esc(project().speakerNames?.[ui.renameSpeaker] || ui.renameSpeaker)}"></label><footer><button class="primary" data-action="rename-speaker">Save</button></footer>`
        );
        return;
      }
      const review = e.target.closest("[data-review-cue]");
      if (review) {
        closeModal();
        select(review.dataset.reviewCue);
        document.querySelector(
          `[data-cue-row="${CSS.escape(review.dataset.reviewCue)}"]`
        )?.scrollIntoView({ block: "nearest" });
        return;
      }
      const merge = e.target.closest("[data-merge-after]");
      if (merge) {
        mergeAfter(merge.dataset.mergeAfter);
        return;
      }
      const row = e.target.closest("[data-select-cue]");
      if (row) {
        select(row.dataset.selectCue, null, e.shiftKey);
        return;
      }
      const word = e.target.closest("[data-word]");
      if (word) {
        const selection = window.getSelection();
        if (selection?.toString() && $("#transcript-list").contains(selection.anchorNode))
          return;
        if (ui.scissors) {
          splitAt(word.dataset.cue, word.dataset.word);
          return;
        }
        select(word.dataset.cue, word.dataset.word, e.shiftKey);
        seek(selectedWord()?.start || 0);
        return;
      }
      const time = e.target.closest("[data-cue-time]");
      if (time) {
        const c = project().cues.find((c2) => c2.id === time.dataset.cueTime);
        select(c.id);
        seek(c.start);
        return;
      }
    } catch (err) {
      report(err);
    }
  });
  document.addEventListener("contextmenu", (e) => {
    const cue = e.target.closest("[data-cue-row]");
    if (!cue || ui.busy) return;
    e.preventDefault();
    contextMenu(
      "cue",
      cue.dataset.cueRow,
      e.clientX,
      e.clientY
    );
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#context-menu")) closeContext();
  });
  document.addEventListener("pointerover", (e) => {
    document.querySelector(".cut-target")?.classList.remove("cut-target");
    if (ui.scissors) e.target.closest("[data-word]")?.classList.add("cut-target");
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "subtitle-text") {
      const c = selectedCue();
      if (c) {
        ui.drafts[c.id] = e.target.value;
        growTextarea();
      }
    }
    if (e.target.id === "search") {
      ui.query = e.target.value;
      ui.limit = 100;
      renderContent();
    }
    if (e.target.id === "volume") $("#audio").volume = +e.target.value;
  });
  document.addEventListener("change", (e) => {
    try {
      if (e.target.id === "theme") {
        prefs.theme = e.target.value;
        document.documentElement.dataset.theme = prefs.theme;
        preferences();
        wave.draw();
      }
      if (e.target.id === "project-name" && project()) {
        project().name = e.target.value.trim() || "Untitled";
        save();
      }
      if (e.target.id === "language") {
        prefs.language = e.target.value;
        preferences();
      }
      if (e.target.id === "model") {
        prefs.model = e.target.value;
        preferences();
      }
      if (e.target.id === "playback-rate")
        $("#audio").playbackRate = +e.target.value;
      if (e.target.id === "audio-file") {
        const f = e.target.files[0];
        e.target.value = "";
        if (f) audioInput(f, ui.relink).catch(report);
      }
      if (e.target.id === "transcript-file") {
        const f = e.target.files[0];
        e.target.value = "";
        if (f) importAny(f).catch(report);
      }
    } catch (err) {
      report(err);
    }
  });
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input,textarea,select"), mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === "s") {
      e.preventDefault();
      saveCurrent().catch(report);
      return;
    }
    if (e.key === "Escape") {
      cancelText();
      closeContext();
      closeModal();
      if (ui.scissors) {
        ui.scissors = false;
        renderContent();
      }
      return;
    }
    if (mod && k === "z" && $("#reference-input")) {
      const field = $("#reference-input"), reference = referenceOf(project()), saved = reference?.chapters?.map((c) => c.text || "").join("\n\n") || reference?.words?.map((w) => w.text).join(" ") || "";
      if (field.value === saved) {
        e.preventDefault();
        e.shiftKey ? actions.redo() : actions.undo();
        referencePanel();
      }
      return;
    }
    if ($("#dialogs").children.length) return;
    if (e.shiftKey && e.key === "F10") {
      const cue = e.target.closest("[data-cue-row]");
      if (cue) {
        e.preventDefault();
        const r = e.target.getBoundingClientRect();
        contextMenu(
          "cue",
          cue.dataset.cueRow,
          r.left,
          r.bottom
        );
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && e.target.id === "subtitle-text") {
      e.preventDefault();
      applyDrafts();
      return;
    }
    if (e.key === "Enter" && /^(cue|word)-(start|end)$/.test(e.target.id)) {
      e.preventDefault();
      persistTiming(e.target.id.startsWith("word") ? "word" : "cue");
      return;
    }
    if (mod && k === "z") {
      if (typing || ui.busy) return;
      e.preventDefault();
      e.shiftKey ? actions.redo() : actions.undo();
      return;
    }
    if (!typing && mod && k === "y") {
      e.preventDefault();
      actions.redo();
      return;
    }
    if (typing) return;
    if (e.code === "Space") {
      e.preventDefault();
      Promise.resolve(actions["play-pause"]()).catch(report);
      return;
    }
    if (mod && k === "k") {
      e.preventDefault();
      actions.split();
    }
    if (mod && k === "m") {
      e.preventDefault();
      actions.merge();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (!native() && (ui.busy || lastSaveError)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (ui.busy || native()) return;
    const f = e.dataTransfer.files[0];
    if (f)
      (/\.(srt|json|whisperdesk|subtitler|txt|docx)$/i.test(f.name) ? importAny(f) : audioInput(f)).catch(report);
  });
  function startupDeadline(promise, message, ms = 8e3) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }
  async function nativeEvents() {
    if (ui.nativeEventsReady) return;
    ui.nativeEventsReady = true;
    if (!window.__TAURI__?.event?.listen) return;
    try {
      await listenDocument(window.__TAURI__, "subtitler-open", (event) => {
        void (async () => {
          await invoke("take_document_open");
          if (event.payload.path) await openDocumentFile(event.payload.path, true);
          else if (event.payload.request) {
            const r = event.payload.request;
            if (r.uiAction) await actions[r.uiAction]?.();
            else await handleStudioRequest(r, true);
          }
        })().catch(report);
      });
      await window.__TAURI__.event.listen("subtitler-folder-moved", (event) => applyFolderMove(event.payload));
      await listenDocument(window.__TAURI__, "subtitler-close", () => void closeProject());
      await listenDocument(window.__TAURI__, "subtitler-rematch", () => {
        if (!ui.busy) {
          const action = project().cues.length ? () => runAlignment(false, true) : transcribe;
          Promise.resolve(action()).catch(report);
        }
      });
      await listenDocument(window.__TAURI__, "subtitler-menu", (event) => {
        if (ui.busy) return toast("Wait for the current task to finish.");
        const action = actions[event.payload];
        if (action) Promise.resolve(action()).catch(report);
      });
      await window.__TAURI__.event.listen("whisper-progress", (event) => {
        if (event.payload.jobId !== ui.jobId) return;
        const line = String(event.payload.message || ""), match = line.match(/progress\s*=\s*(\d+)%/i);
        if (match) ui.percent = +match[1];
        if (match) ui.progress = `Transcribing locally · ${ui.percent}%`;
        else if (line.startsWith("Preparing audio;"))
          ui.progress = "Preparing audio; silence and timing preserved…";
        else if (ui.percent === null && /whisper|ggml|model/i.test(line))
          ui.progress = "Loading Whisper model…";
        else return;
        renderHeader();
      });
      await window.__TAURI__.event.listen("alignment-progress", (event) => {
        if (event.payload.jobId !== ui.jobId) return;
        const line = String(event.payload.message || "");
        if (!line.startsWith("SUBTITLER ")) return;
        ui.progress = line.slice(10);
        const match = line.match(/(\d+)%/);
        ui.percent = match ? +match[1] : null;
        renderHeader();
      });
      await listenDocument(window.__TAURI__, "tauri://drag-drop", (event) => {
        if (ui.busy) return;
        const path2 = event.payload.paths?.[0];
        if (path2)
          (/\.(srt|json|whisperdesk|subtitler|txt|docx)$/i.test(path2) ? importAny(path2) : audioInput(path2)).catch(report);
      });
    } catch (e) {
      console.warn("Native progress events unavailable", e);
    }
  }
  var studioRequestBusy = false;
  var pendingWorkspace = null;
  async function openWorkspace(info, { audioPath: audioPath2 = null, match = false, explicit = false } = {}) {
    const workspace = { directory: info.directory, projectId: info.projectId || null, projectName: info.projectName || "" };
    const audioFiles = info.audioCandidates || [];
    let audio = null;
    const requested = audioPath2 || info.activeRecording?.path;
    if (requested) {
      try {
        audio = await invoke("audio_file_info", { path: requested });
      } catch {
        audio = null;
      }
    } else if (audioFiles.length === 1) audio = audioFiles[0];
    if (!audio) {
      toast(requested ? "The requested audio could not be opened. Locate it manually." : "Choose the recording for this project.");
      const chosen = await invoke("pick_file", { kind: "audio" });
      if (!chosen) return false;
      audio = await invoke("audio_file_info", { path: chosen });
      if (info.activeRecording?.fingerprint && !sameRecording(audio, info.activeRecording)) {
        toast("This is a different recording. Select it in Storyboard Studio before sharing timing.");
        return false;
      }
    }
    info = { ...info, activeRecording: audio };
    if (!await invoke("claim_recording", { projectId: workspace.projectId || "", fingerprint: audio.fingerprint || audio.path })) return false;
    const existing = transcriptCandidate(audio, projects.filter((p) => p.studioLink?.projectId === workspace.projectId), (info.transcripts || []).filter((t) => !t.studioProjectId || t.studioProjectId === workspace.projectId));
    let target = existing?.project;
    if (existing && !target) {
      const opened = await invoke("open_document", { path: existing.path });
      target = openedDocument(opened.data, opened.path);
      if (opened.audioPath) target.source.embeddedPath = opened.audioPath;
      target.source = { ...target.source, ...audio };
    }
    if (!target) target = newProject(audio.name.replace(/\.[^.]+$/, ""), audio);
    if ((target.filePath || target.studioLink?.projectFile || target.privateFile)?.replace(/\\/g, "/").startsWith(workspace.directory + "/Studio Link/")) {
      delete target.filePath;
      delete target.privateFile;
      if (target.studioLink) delete target.studioLink.projectFile;
    }
    target.studioLink = { ...target.studioLink, ...workspace, recordingFingerprint: audio.fingerprint || null, explicitSelection: explicit, ...target.filePath ? { projectFile: target.filePath } : {} };
    target.closed = false;
    await openProject(target);
    project().source = { ...project().source, ...audio, previewPath: null };
    await loadAudio();
    await studio.refresh();
    if (project().availableScript) {
      project().useScript = true;
      history.change("Match shared script", (p) => matchScript(p, p.availableScript, { correct: false }));
    }
    await save();
    if (match && prefs.ffmpeg) {
      const prepared = await invoke("prepare_audio", { path: audio.path, ffmpeg: prefs.ffmpeg, projectId: project().id });
      project().source = { ...project().source, ...prepared };
      await loadAudio();
    }
    const sharedRef = project().referenceInput || project().availableScript;
    const incompleteReference = sharedRef?.words?.length > 12 && project().scriptReference?.matched / sharedRef.words.length < 0.7;
    const badSavedTiming = incompleteReference || project().timingsNeedMatch || project().cues.some((c) => c.end > project().source.duration + 0.35);
    if (match) {
      if (!project().cues.length || badSavedTiming) await transcribe();
      else await runAlignment(false, true);
    }
    if (!await studio.flush()) throw Error(studio.status().text || "Could not save shared timing.");
    renderHeader();
    renderContent();
    return true;
  }
  async function receiveStudioRequest() {
    if (!native() || ui.busy || studioRequestBusy || document.hidden) return;
    studioRequestBusy = true;
    try {
      const r = await invoke("read_studio_request", { lastRequestId: prefs.lastStudioRequestId || null });
      if (!r || r.requestId === prefs.lastStudioRequestId) return;
      if (!await invoke("claim_studio_request", { id: r.requestId })) return;
      await handleStudioRequest(r);
    } catch (e) {
      report(e);
    } finally {
      studioRequestBusy = false;
    }
  }
  window.addEventListener("resize", growTextarea);
  window.addEventListener("focus", () => {
    void receiveStudioRequest();
    if (native() && project()?.studioLink?.directory) void studio.refresh();
    if (native() && project()?.source.path)
      checkAudio().then(renderHeader).catch(() => {
      });
  });
  async function start() {
    try {
      window.whisperDeskStartup?.stage("Building the interface");
      setup();
      window.whisperDeskStartup?.stage("Opening saved files");
      projects = await startupDeadline(
        database.projects(),
        "Saved files did not finish opening. Close other app windows and retry."
      );
      if (native() && !prefs.transcriptDirectory) {
        prefs.transcriptDirectory = await invoke("default_transcript_directory");
        preferences();
      }
      const p = null;
      window.whisperDeskStartup?.stage("Restoring the transcript and audio");
      await startupDeadline(
        openProject(p || newProject()),
        "The saved transcript or audio could not be restored. Copy the startup error details."
      );
      if (native()) await nativeEvents();
      const startup = native() ? await invoke("take_document_open") : null;
      window.SUBTITLER_OPEN = startup || window.SUBTITLER_OPEN;
      if (window.SUBTITLER_OPEN?.path) {
        try {
          await openDocumentFile(window.SUBTITLER_OPEN.path, true);
        } catch (e) {
          throw Error("Could not open " + window.SUBTITLER_OPEN.path + ": " + String(e.message || e));
        }
      }
      ui.startupComplete = true;
      renderHeader();
      window.whisperDeskStartup?.ready();
      if (window.SUBTITLER_OPEN?.request) {
        const request = window.SUBTITLER_OPEN.request;
        setTimeout(() => {
          if (request.uiAction) Promise.resolve(actions[request.uiAction]?.()).catch(report);
          else handleStudioRequest(request, true).catch(report);
        }, 0);
      }
      setTimeout(() => receiveStudioRequest(), 300);
      setInterval(() => receiveStudioRequest(), 3e3);
      if (native())
        requestAnimationFrame(() => {
          if (!prefs.whisper || !prefs.ffmpeg || !prefs.model)
            void discover(false);
        });
    } catch (e) {
      console.error("Subtitler startup:", e);
      if (window.whisperDeskStartup) window.whisperDeskStartup.fail(e);
      else report(e);
    }
  }
  var studio = createStudioLink({
    saved: (path2) => {
      if (path2) {
        documentPath = path2;
        if (native()) void invoke("claim_document", { path: path2 }).catch(report);
      }
      renderHeader();
    },
    openWorkspace,
    project,
    connected: (link) => {
      const workspace = {
        directory: link.directory,
        projectId: link.projectId,
        projectName: link.projectName
      };
      if (JSON.stringify(prefs.workspace) !== JSON.stringify(workspace)) {
        prefs.workspace = workspace;
        preferences();
      }
    },
    persist: () => save(),
    render: () => {
      if ($("#folder-path"))
        $("#folder-path").textContent = project()?.studioLink?.directory || "Not connected";
    },
    audioChanged: () => loadAudio(),
    status: (text, error) => {
      const el = $("#project-sync-status");
      if (el) {
        el.hidden = !text;
        el.textContent = text;
        el.classList.toggle("sync-error", error);
      }
      if ($("#folder-status")) $("#folder-status").textContent = text;
    }
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target.closest('[data-action="apply-text"]')) {
        e.preventDefault();
        return;
      }
      if (!e.target.closest("#subtitle-text")) cancelText();
    },
    true
  );
  document.addEventListener("focusout", (e) => {
    if (e.target.id === "subtitle-text" && !e.relatedTarget?.closest('[data-action="apply-text"]'))
      cancelText();
    if (/^(cue|word)-(start|end)$/.test(e.target.id) && !e.target.closest(".time-fields")?.contains(e.relatedTarget))
      persistTiming(e.target.id.startsWith("word") ? "word" : "cue");
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "import-file" || e.target.id === "script-file") {
      const f = e.target.files[0];
      e.target.value = "";
      if (f)
        (e.target.id === "script-file" ? importScript(f) : importAny(f)).catch(
          report
        );
    }
  });
  start();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-recent-path]");
    if (b) {
      closeModal();
      openDocumentFile(b.dataset.recentPath).catch(report);
    }
  });
  document.addEventListener("click", (e) => {
    for (const menu of document.querySelectorAll(".file-menu[open]")) if (!menu.contains(e.target)) menu.open = false;
  });
})();
