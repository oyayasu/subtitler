import {clone,cueText} from './model.js';
import {parseScript,matchScript} from './workflow.js';
// Recognition anchors locate imported subtitles in the full recording. Text and
// caption boundaries stay unchanged; unresolved passages are never silently forced.
export function retimeImported(original,recognized){
 const reference=parseScript(original.cues.map(cueText).join('\n'));
 const matched=matchScript(recognized,reference,{correct:false});
 if(matched.matched<Math.max(1,reference.words.length*.65))throw Error('Not enough subtitle text matched this recording. Previous subtitles and timings were kept.');
 const heard=recognized.cues.flatMap(c=>c.words),mapping=new Map(matched.mapping),words=original.cues.flatMap(c=>c.words),next=clone(original);
 if(words.length!==reference.words.length)throw Error('The subtitle text could not be matched safely.');
 const targets=next.cues.flatMap(c=>c.words);
 for(let i=0;i<targets.length;i++){
   const hit=heard[mapping.get(i)];
   if(hit){Object.assign(targets[i],{start:hit.start,end:hit.end,timing:hit.timing,alignmentEngine:hit.alignmentEngine});continue;}
   let a=i-1,b=i+1;while(a>=0&&!mapping.has(a))a--;while(b<targets.length&&!mapping.has(b))b++;
   const start=a>=0?heard[mapping.get(a)].end:0,end=b<targets.length?heard[mapping.get(b)].start:recognized.source.duration;
   if(end<=start)throw Error('Unmatched subtitle words have no usable timing interval. Previous timing was kept.');
   const span=(end-start)/(b-a-1);targets[i].start=start+(i-a-1)*span;targets[i].end=targets[i].start+span;targets[i].timing='estimated';
 }
 next.cues.forEach(c=>{c.start=c.words[0].start;c.end=c.words.at(-1).end;});
 next.source=recognized.source;next.recognition={...recognized.recognition,note:'Imported text and subtitle division preserved.'};
 next.sourceWords=recognized.sourceWords;next.pauses=recognized.pauses;next.timingsNeedMatch=false;
 return next;
}
