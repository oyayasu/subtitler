import {savePathIdentity} from './save-paths.js';
import {clone, uid, validateProject} from './model.js';
const pathKey = savePathIdentity;
export function contentKey(project) {
  const p=clone(project);
  for(const key of ['updatedAt','lastOpenedAt','closed','drafts','privateFile','openedFile','filePath','lastSyncedAt']) delete p[key];
  if(p.studioLink) { delete p.studioLink.projectFile; }
  if(p.source)delete p.source.embeddedPath;
  return JSON.stringify(p);
}
export function standalone(project, name=project.name) {
  const p=clone(project);p.id=uid();p.name=name;
  for(const key of ['studioLink','availableScript','scriptReference','privateFile','openedFile','filePath','previousTranscription']) delete p[key];
  p.closed=false;p.drafts={};return p;
}
export function openedDocument(raw, actualPath) {
  let p=validateProject({...raw,format:'whisperdesk-project-v1'});
  const recorded=p.filePath||p.studioLink?.projectFile||p.openedFile||p.privateFile;
  if(!recorded||pathKey(recorded)!==pathKey(actualPath)) p=standalone(p);
  p.filePath=actualPath;p.closed=false;delete p.privateFile;delete p.openedFile;
  return p;
}
export function distinctName(name, projects) {
  const names=new Set(projects.map(p=>p.name));if(!names.has(name))return name;
  let n=2;while(names.has(`${name} (${n})`))n++;return `${name} (${n})`;
}
export function requestAudio(info, explicitPath) {
  if(explicitPath)return (info.audioCandidates||[]).find(a=>pathKey(a.path)===pathKey(explicitPath))||null;
  const active=info.activeRecording;
  if(active?.path)return (info.audioCandidates||[]).find(a=>pathKey(a.path)===pathKey(active.path))||null;
  return (info.audioCandidates||[]).length===1?info.audioCandidates[0]:null;
}
