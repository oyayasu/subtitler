import { uid, clone, cueText } from './model.js';

export function chapterSeconds(value) {
  if (value == null || String(value).trim() === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 172800) throw Error('Use a chapter time between 0 and 48 hours.');
    return value;
  }
  const text = String(value).trim();
  if (/^\d+(?:[.,]\d{1,3})?$/.test(text)) return chapterSeconds(Number(text.replace(',', '.')));
  const hit = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!hit || +hit[2] > 59 || +hit[3] > 59) throw Error('Use seconds, MM:SS or HH:MM:SS.mmm for chapter times.');
  return chapterSeconds(+(hit[1] || 0) * 3600 + +hit[2] * 60 + +hit[3] + +(hit[4] || '').padEnd(3, '0') / 1000);
}

export function installReferenceChapters(project, reference) {
  const previous = project.chapters || [];
  const imported = (reference?.chapters || []).filter(c => c.isHeading && c.title);
  project.chapters = [
    ...previous.filter(c => c.origin !== 'reference'),
    ...imported.map(c => {
      const old = previous.find(x => x.origin === 'reference' && x.referenceId === c.id);
      return {
        id: old?.id || uid(), title: c.title, level: c.level || 1,
        start: old?.timeMode === 'manual' ? old.start : null,
        timeMode: old?.timeMode === 'manual' ? 'manual' : 'matched',
        origin: 'reference', referenceId: c.id,
        anchorWordId: null,
        ...(old?.needsReview ? {needsReview: true} : {}),
      };
    }),
  ];
  return project.chapters;
}

// A reference match supplies indices into this exact word list. Later timing
// changes follow permanent word IDs; stale indices are never reused after edits.
export function refreshChapterTimes(project, matchedReference = null) {
  const words = project.cues.flatMap(c => c.words);
  const byId = new Map(words.map(w => [w.id, w]));
  const mapping = matchedReference ? new Map(matchedReference.mapping) : null;
  const sections = matchedReference?.chapters || [];
  const reliable = !matchedReference || matchedReference.matched >= Math.max(1,matchedReference.words.length * .65);
  for (const chapter of project.chapters || []) {
    if (chapter.timeMode !== 'matched') continue;
    let anchor = byId.get(chapter.anchorWordId);
    if (mapping && chapter.origin === 'reference') {
      const at = sections.findIndex(c => c.id === chapter.referenceId);
      anchor = null;
      if (at >= 0 && reliable) {
        const section = sections[at];
        const following = sections.slice(at + 1).find(c => c.isHeading && (c.level || 1) <= (section.level || 1));
        const end = following?.wordStart ?? matchedReference.words.length;
        for (let i = section.wordStart; i < end; i++) {
          const hit = words[mapping.get(i)];
          if (hit) { anchor = hit; break; }
        }
      }
    }
    chapter.anchorWordId = anchor?.id || null;
    chapter.start = anchor?.start ?? null;
    if (anchor) delete chapter.needsReview;
  }
  return project.chapters;
}

export function invalidateChapterTimes(project) {
  for (const chapter of project.chapters || []) {
    chapter.anchorWordId = null;
    if (chapter.timeMode === 'matched') chapter.start = null;
    else if (chapter.start != null) chapter.needsReview = true;
  }
}

export function placedChapters(project) {
  return (project.chapters || []).filter(c => Number.isFinite(c.start) && !c.needsReview)
    .slice().sort((a,b) => a.start - b.start || a.level - b.level);
}

export function transcriptBlocks(project) {
  const chapters = placedChapters(project);
  if (!chapters.length) return project.cues.map(c => ({kind:'text',text:cueText(c),start:c.start,end:c.end}));
  const blocks = [];
  let at = 0;
  const headings = time => {
    while (at < chapters.length && chapters[at].start <= time + .000001) {
      blocks.push({kind:'heading',...clone(chapters[at++])});
    }
  };
  for (const cue of project.cues) {
    let batch = [], first = 0;
    const flush = () => {
      if (!batch.length) return;
      blocks.push({kind:'text',text:cueText({words:batch}),start:first === 0 ? cue.start : batch[0].start,
        end:first + batch.length === cue.words.length ? cue.end : batch.at(-1).end});
      batch = [];
    };
    cue.words.forEach((word, index) => {
      if (at < chapters.length && chapters[at].start <= word.start + .000001) { flush(); headings(word.start); }
      if (!batch.length) first = index;
      batch.push(word);
    });
    flush();
  }
  headings(Infinity);
  return blocks;
}
