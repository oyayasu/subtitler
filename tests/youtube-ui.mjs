// Exercise the actual shipped editor while substituting deterministic YouTube responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
const source = file => fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
const dom = new JSDOM(source('index.html'),{url:'https://subtitler.test',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
const w=dom.window, el=s=>w.document.querySelector(s);
const saved=[], calls=[];
let tracks=[{code:'en',name:'English',automatic:true},{code:'en-US',name:'English (US)',automatic:false}];
let rejectCaption=false, release;
w.indexedDB=new IDBFactory(); w.structuredClone=structuredClone;
w.ResizeObserver=w.IntersectionObserver=class{observe(){} disconnect(){}};
w.CSS={escape:String};
w.HTMLMediaElement.prototype.pause=w.HTMLMediaElement.prototype.load=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.__TAURI__={core:{convertFileSrc:p=>p,invoke:async(name,args={})=>{
  if(name==='youtube_import'){
    calls.push(args.action);
    if(args.action==='inspect')return {title:'A drawing lesson',language:'en',tracks};
    if(args.action==='captions'){
      if(rejectCaption)throw Error('Track unavailable');
      if(release===null)await new Promise(resolve=>{release=resolve;});
      assert.equal(args.language,'en-US');assert.equal(args.automatic,false);
      return {events:[{tStartMs:800,dDurationMs:1600,segs:[{utf8:'Draw a circle.'}]}]};
    }
    throw Error('Unexpected audio request');
  }
  if(name==='allocate_document')return '/docs/A drawing lesson.subtitler';
  if(name==='write_document'){saved.push(JSON.parse(args.data));return {};}
  if(name==='discover_tools')return {models:[]};
  if(name==='default_transcript_directory')return '/docs';
  if(name==='cancel_transcription'){if(release)release();return;}
  if(['document_title','claim_document','set_document_empty'].includes(name))return true;
  return null;
}},event:{listen:async()=>()=>{}}};
const wait=async fn=>{
  for(let i=0;i<220;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}
  throw Error('UI did not reach expected state: '+el('#dialogs')?.textContent+' '+el('#toast')?.textContent);
};
const click=action=>el('[data-action="'+action+'"]').click();
async function lookup(){
  click('import-youtube');el('#youtube-link').value='https://youtu.be/abc_D-12345';
  el('#youtube-form').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));
  await wait(()=>el('[data-action="youtube-audio"]'));
}
try{
  w.eval(source('app.bundle.js'));await wait(()=>el('#project-name')?.value==='Untitled transcript');
  await lookup();assert.match(el('#youtube-track').selectedOptions[0].textContent,/Creator captions/);
  click('youtube-captions');await wait(()=>saved.length>0);
  assert.equal(saved.at(-1).recognition.engine,'YouTube captions');
  assert.equal(saved.at(-1).name,'A drawing lesson');assert.equal(saved.at(-1).cues[0].start,0.8);
  assert.deepEqual(calls,['inspect','captions']);
  const cueId=saved.at(-1).cues[0].id;
  await lookup();click('youtube-captions');await wait(()=>el('[data-action="confirm-subtitles"]'));
  click('close-modal');assert.equal(saved.at(-1).cues[0].id,cueId);
  await lookup();rejectCaption=true;click('youtube-captions');await wait(()=>el('[role="alert"]'));
  assert.match(el('#dialogs').textContent,/Track unavailable/);
  click('close-modal');rejectCaption=false;
  await lookup();release=null;click('youtube-captions');await wait(()=>typeof release==='function');
  el('#dialogs [data-action="cancel"]').click();await wait(()=>!el('#youtube-pending'));assert.equal(saved.at(-1).cues[0].id,cueId);
  tracks=[];await lookup();assert.match(el('#dialogs').textContent,/No caption tracks/);assert.ok(!el('[data-action="youtube-captions"]'));
  assert.ok(el('[data-action="youtube-audio"]'));assert.ok(!calls.includes('audio'));
  console.log('PASS: shipped YouTube import, default track, timestamps, replacement guard, retry, cancellation and Whisper option.');
}finally{dom.window.close();}
