// Transcript identity is separate from the original recording's identity.
const path = s => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/^file:\/\/(?:localhost)?/,'');
const source = t => ({...(t.source || t), path:t.audioPath || t.source?.path || t.path});
export function sameRecording(a,b){
  a=source(a);b=source(b);
  if(a.fingerprint&&b.fingerprint)return a.fingerprint===b.fingerprint;
  const changed=a.size&&b.size&&a.size!==b.size || a.modified&&b.modified&&a.modified!==b.modified;
  if(changed)return false;
  if(a.path&&b.path)return path(a.path)===path(b.path);
  if(a.relativePath&&b.relativePath)return path(a.relativePath)===path(b.relativePath);
  return false; // A filename alone cannot identify a recording.
}
export function uniqueRecordings(tracks){
  const groups=[];
  for(const t of tracks){const group=groups.find(g=>sameRecording(g[0],t));group?group.push(t):groups.push([t]);}
  return groups.map(g=>g.slice().sort((a,b)=>{
    const usable=t=>(t.words?.length||t.cues?.some(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)))?1:0;
    return usable(b)-usable(a)||String(b.exportedAt||b.importedAt||'').localeCompare(String(a.exportedAt||a.importedAt||''));
  })[0]);
}
