export const referenceOf=p=>p?.useScript===false?null:p?.referenceInput||p?.availableScript;
export const spokenKey=p=>JSON.stringify((p?.cues||[]).flatMap(c=>c.words).map(w=>w.text).join(' ').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)||[]);
export const referenceKey=p=>JSON.stringify([p?.source?.fingerprint||p?.source?.path,referenceOf(p)?.words?.map(w=>w.text)||[]]);
export const canMatch=p=>!!(p?.source?.name&&referenceOf(p)?.words?.length&&p.matchedReferenceKey!==referenceKey(p));
export const needsTiming=p=>!!p?.cues?.length&&(!!p.timingAlignmentPending||!!p.timingsNeedMatch||!!p.wordTimingTextKey&&p.wordTimingTextKey!==spokenKey(p));
export function aligned(p,unresolved=0){p.wordTimingTextKey=spokenKey(p);p.timingAlignmentPending=unresolved>0;if(!unresolved){delete p.timingsNeedMatch;if(referenceOf(p))p.matchedReferenceKey=referenceKey(p);}}
