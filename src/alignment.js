import { clone } from "./model.js";
export function alignmentRequest(project, language, threads = 6) {
  if (!["auto", "en", "pt", "es", "ja"].includes(language))
    throw Error("Choose the recording’s language for alignment.");
  if (!project?.cues?.length) throw Error("Transcribe the recording first.");
  return {
    language,
    fallbackLanguage: project.language,
    threads,
    duration: project.source.duration,
    audioFingerprint: project.source.fingerprint||null,
    cues: project.cues.map((c) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      language: c.language || null,
      words: c.words.map((w) => ({
        id: w.id,
        text: w.text,
        start: w.start,
        end: w.end,
      })),
    })),
  };
}
export function applyAlignment(project, reply, { replaceManual = false } = {}) {
  if (
    reply?.format !== "subtitler-alignment-v1" ||
    !Array.isArray(reply.cues) ||
    reply.cues.length !== project.cues.length
  )
    throw Error(
      "WhisperX returned an incomplete result. Existing timings are preserved.",
    );
  const next = clone(project.cues),
    seen = new Set();
  let aligned = 0,
    protectedWords = 0,
    unresolved = 0;
  const issues = [];
  for (let i = 0; i < next.length; i++) {
    const cue = next[i],
      row = reply.cues[i];
    if (
      row?.id !== cue.id ||
      !Array.isArray(row.words) ||
      row.words.length !== cue.words.length
    )
      throw Error("Alignment no longer matches the transcript. Run it again.");
    for (let j = 0; j < cue.words.length; j++) {
      const w = cue.words[j],
        hit = row.words[j];
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
      if (
        !Number.isFinite(hit.start) ||
        !Number.isFinite(hit.end) ||
        hit.start < 0 ||
        hit.end <= hit.start ||
        hit.end > (Number.isFinite(reply.duration)?reply.duration:project.source.duration) + 0.001
      )
        throw Error("WhisperX returned invalid word timing.");
      // Existing format understands "whisper" as automatically derived timing;
      // retain the engine separately for UI/provenance and old SS compatibility.
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
  // Reject entire conflicting blocks, rather than clamping, interpolating, or
  // disturbing a manual anchor. Iterate because restoring a neighbor can
  // expose another conflict. Every rejected block returns to its prior bounds.
  const rejected = new Set();
  const updated = (i) =>
    !rejected.has(i) &&
    reply.cues[i].words.some(
      (hit, j) =>
        hit.status === "aligned" &&
        (replaceManual || project.cues[i].words[j].timing !== "manual"),
    );
  const bounds = (i) =>
    updated(i)
      ? [next[i].words[0].start, next[i].words.at(-1).end]
      : [project.cues[i].start, project.cues[i].end];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < next.length; i++) {
      if (rejected.has(i)) continue;
      const c = next[i],
        old = project.cues[i];
      const [a, b] = bounds(i);
      const bad =
        c.words.some((w, j) => j && w.start < c.words[j - 1].end - 0.001) ||
        a >= b;
      const prev = i ? bounds(i - 1)[1] : 0,
        nextStart = i + 1 < next.length ? bounds(i + 1)[0] : Infinity;
      if (bad || a < prev - 0.001 || b > nextStart + 0.001) {
        next[i] = clone(old);
        rejected.add(i);
        issues.push({
          cueId: c.id,
          message: "Timing conflict; this subtitle kept its previous timing.",
        });
        changed = true;
      }
    }
  }
  unresolved = 0;
  aligned = 0;
  protectedWords = 0;
  for (let i = 0; i < next.length; i++) {
    const c = next[i];
    const updated = reply.cues[i].words.some(
      (hit, j) =>
        hit.status === "aligned" &&
        (replaceManual || project.cues[i].words[j].timing !== "manual"),
    );
    if (updated) {
      c.start = c.words[0].start;
      c.end = c.words.at(-1).end;
    }
    if (rejected.has(i)) {
      c.start = project.cues[i].start;
      c.end = project.cues[i].end;
    }
    c.words.forEach((w, j) => {
      if (project.cues[i].words[j].timing === "manual" && !replaceManual)
        protectedWords++;
      else if (!rejected.has(i) && reply.cues[i].words[j].status === "aligned")
        aligned++;
      else unresolved++;
    });
  }
  if (!aligned)
    throw Error(
      "No word timings could be safely updated. Previous timings are preserved. Check the language and transcript, or split long subtitle blocks.",
    );
  project.cues = next;
  if(Number.isFinite(reply.duration))project.source.duration=reply.duration;
  project.recognition = {
    ...project.recognition,
    alignment: {
      engine: "WhisperX",
      version: reply.version,
      language: reply.language,
      createdAt: new Date().toISOString(),
      aligned,
      unresolved,
      protectedWords,
      issues,
    },
  };
  return { aligned, unresolved, protectedWords, issues };
}
