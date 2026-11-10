import {sameRecording} from './recording-identity.js';
export function transcriptCandidate(audio,projects,saved=[]){
  const candidates=[...projects.map(p=>({project:p,id:p.id,source:p.source,updatedAt:p.updatedAt,cueCount:p.cues?.length||0,studioProjectId:p.studioLink?.projectId})),...saved];
  return candidates.filter(p=>sameRecording(p.source,audio)).sort((a,b)=>
    Number(b.cueCount>0)-Number(a.cueCount>0)||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))||Number(!!b.project)-Number(!!a.project)
  )[0]||null;
}
