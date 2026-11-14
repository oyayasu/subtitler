// Exercises the shipped bundle's click handlers without a native WebView.
// Run with JSDOM_MODULE and INDEXEDDB_MODULE pointing to temporary test dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {parseSrt} from '../src/model.js';
const require = createRequire(import.meta.url);
const {JSDOM, VirtualConsole} = require(process.env.JSDOM_MODULE || 'jsdom');
const {IDBFactory} = require(process.env.INDEXEDDB_MODULE || 'fake-indexeddb');
vm.runInThisContext(fs.readFileSync(new URL('../src/vendor/jszip.min.js',import.meta.url),'utf8'));
const sample = parseSrt('1\n00:00:01,000 --> 00:00:03,000\nOlá, world & friends.\n\n2\n00:00:04,000 --> 00:00:06,000\n日本語の字幕です。');
sample.name = 'Export test'; sample.filePath = '/Documents/Subtitler/Export test.subtitler';
const linked=process.env.TEST_LINKED==='1';
if(linked)sample.studioLink={directory:'/Storyboard',projectId:'ss',projectName:'Storyboard test',projectFile:sample.filePath};
const referenceZip=new JSZip();
referenceZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+[
  ['Title','Document title is not speech'],['Heading1','Opening'],[null,'Olá, world &amp; friends.'],
  ['SceneStyle','日本語の章'],[null,'日本語の字幕です。'],['Heading1','Empty chapter'],
].map(([style,text])=>`<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:''}<w:r><w:t>${text}</w:t></w:r></w:p>`).join('')+'</w:body></w:document>');
referenceZip.file('word/styles.xml','<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="SceneStyle"><w:basedOn w:val="Heading2"/></w:style></w:styles>');
const referenceBytes=await referenceZip.generateAsync({type:'base64'});
const errors=[];
const console = new VirtualConsole();
console.on('jsdomError', e=>errors.push(String(e)));
const html=fs.readFileSync(new URL('../src/index.html',import.meta.url),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
const dom = new JSDOM(html,{url:'https://subtitler.test',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console});
const w=dom.window;
try {
  w.indexedDB=new IDBFactory(); w.structuredClone=structuredClone;
  w.Uint8Array=Uint8Array; w.ArrayBuffer=ArrayBuffer;
  w.CSS={escape:s=>String(s)};
  w.ResizeObserver=class {observe(){} disconnect(){}};
  w.IntersectionObserver=class {observe(){} disconnect(){}};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLMediaElement.prototype.pause=function(){};
  w.HTMLMediaElement.prototype.load=function(){};
  const ctx=new Proxy({}, {get:(o,k)=>k==='createLinearGradient'?()=>({addColorStop(){}}):k==='measureText'?()=>({width:1}):()=>{}});
  w.HTMLCanvasElement.prototype.getContext=()=>ctx;
  const calls=[],writes=[]; let cancel=false,fail=false,delay=false,release;
  w.__TAURI__={core:{convertFileSrc:p=>p,invoke:async(name,args={})=>{
    if(name==='take_document_open')return {path:sample.filePath};
    if(name==='open_document')return {path:sample.filePath,data:structuredClone(sample),audioPath:null};
    if(name==='default_transcript_directory')return '/Documents/Subtitler';
    if(['document_title','claim_document','claim_recording','set_document_empty'].includes(name))return true;
    if(name==='discover_tools')return {models:[]};
    if(name==='read_studio_request')return null;
    if(name==='pick_file'&&args.kind==='script')return '/Reference.docx';
    if(name==='read_script_document')return referenceBytes;
    if(name==='inspect_project_folder')return {directory:'/Storyboard',projectId:'ss',projectName:'Storyboard test',warnings:[]};
    if(name==='save_project_files')return {projectFile:sample.filePath};
    if(name==='write_document'){writes.push(args);return {changed:true};}
    if(name==='choose_document_save'){calls.push({name,args});return cancel?null:'/Exports/Copy.subtitler';}
    if(name==='save_export'||name==='write_subtitler_export'){
      calls.push({name,args});
      if(delay)await new Promise(r=>{release=r;});
      if(fail)throw Error('Test destination is not writable');
      return name==='save_export'?!cancel:'/Storyboard/'+args.filename;
    }
    throw Error('Unexpected command '+name);
  }},event:{listen:async()=>()=>{}}};
  // Reuse the real bundled archive engine with Node's scheduler; jsdom does not
  // emulate the browser postMessage scheduler used by this older JSZip build.
  w.JSZip=globalThis.JSZip;
  w.eval(fs.readFileSync(process.env.TEST_APP_BUNDLE || new URL('../src/app.bundle.js',import.meta.url),'utf8'));
  const wait=async fn=>{const start=Date.now();while(!fn()){if(Date.now()-start>3000)throw Error('Timed out waiting for UI state: '+w.document.querySelector('#export-status')?.textContent+'; '+w.document.querySelector('#toast')?.textContent+'; '+w.document.querySelector('[data-action="chapters"]')?.textContent+'; '+errors.join('; '));await new Promise(r=>setTimeout(r,10));}};
  const el=s=>w.document.querySelector(s);
  await wait(()=>w.document.querySelectorAll('.cue').length===2);
  const open=()=>{el('.top-actions [data-action="export"]').click();assert.ok(el('[data-export="docx"]'));};
  if(process.env.EXPECT_UNWIRED==='1'){
    open();el('[data-export="txt"] span').click();await new Promise(r=>setTimeout(r,100));
    assert.equal(calls.length,0);assert.ok(el('[data-export="txt"]'));
    process.stdout.write('REPRODUCED: clicking the original format button never calls the native export.\n');
  }else{
    const output=new Map();
    for(const format of ['docx','txt','srt','csv','xlsx','json','subtitler']){
      open();el('#export-timestamps').checked=true;
      const before=calls.length;
      el(`[data-export="${format}"] ${format==='txt'?'span':'strong'}`).click();
      await wait(()=>calls.length>before&&!el('[data-export]'));
      const call=calls.at(-1);
      if(format==='subtitler'){
        assert.equal(call.name,'choose_document_save');
        const p=JSON.parse(writes.at(-1).data);assert.notEqual(p.id,sample.id);assert.equal(p.cues.length,2);
      }else{
        assert.equal(call.name,linked?'write_subtitler_export':'save_export');assert.equal(call.args.filename,'Export test.'+format);
        if(linked)assert.equal(call.args.studioProjectId,'ss');
        output.set(format,Buffer.from(call.args.data,'base64'));
      }
    }
    assert.match(output.get('txt').toString(),/\[00:00:01.000 → 00:00:03.000\] Olá/);
    assert.match(output.get('srt').toString(),/00:00:01,000 --> 00:00:03,000/);
    assert.match(output.get('csv').toString(),/日本語/);
    assert.equal(JSON.parse(output.get('json')).format,'whisperdesk-timing-v1');
    for(const kind of ['docx','xlsx']){
      const z=await JSZip.loadAsync(output.get(kind));assert.ok(z.file('[Content_Types].xml'));
      const xml=await z.file(kind==='docx'?'word/document.xml':'xl/worksheets/sheet1.xml').async('string');
      assert.match(xml,/Olá/);assert.match(xml,/日本語/);
    }
    open();cancel=true;
    for(const format of linked?['subtitler']:['txt','subtitler']){el(`[data-export="${format}"]`).click();await wait(()=>el('#export-status').textContent.includes('cancelled'));await wait(()=>!el('[data-export="txt"]').disabled);}
    cancel=false;fail=true;el('[data-export="txt"]').click();
    await wait(()=>el('#export-status').textContent.includes('not writable'));assert.equal(el('[data-export="txt"]').disabled,false);
    fail=false;delay=true;const count=calls.length;el('[data-export="txt"]').click();await wait(()=>release);
    el('[data-export="txt"]').click();assert.equal(calls.length,count+1);assert.equal(el('[data-export="srt"]').disabled,true);
    release();await wait(()=>!el('[data-export]'));
    delay=false;
    // Optional chapter controls, validation, imported hierarchy and real DOCX output.
    el('[data-action="chapters"]').click();el('[data-action="chapter-add"]').click();
    el('[data-chapter-title]').value='Manual interlude';el('[data-chapter-time]').value='01:99';
    el('[data-action="save-chapters"]').click();assert.match(el('#chapter-error').textContent,/Use seconds/);
    el('[data-chapter-time]').value='00:00:02';el('[data-action="save-chapters"]').click();
    assert.equal(el('[data-action="chapters"]').textContent,'Chapters (1)');
    el('[data-action="reference-text"]').click();el('[data-action="import-reference"]').click();
    await wait(()=>el('[data-action="chapters"]').textContent==='Chapters (4)');
    el('[data-action="reference-text"]').click();
    assert.match(el('#reference-input').value,/Olá/);assert.doesNotMatch(el('#reference-input').value,/Opening|Document title/);
    el('[data-action="apply-reference"]').click();
    el('[data-action="chapters"]').click();
    const rows=[...w.document.querySelectorAll('[data-chapter-row]')];
    assert.deepEqual(rows.map(r=>r.querySelector('[data-chapter-title]').value),['Manual interlude','Opening','日本語の章','Empty chapter']);
    assert.equal(rows[1].querySelector('[data-chapter-time]').value,'00:00:01.000');
    assert.equal(rows[2].querySelector('[data-chapter-level]').value,'2');
    assert.equal(rows[2].querySelector('[data-chapter-time]').value,'00:00:04.000');
    assert.equal(rows[3].querySelector('[data-chapter-time]').value,'');
    el('[data-action="close-modal"]').click();open();
    assert.ok(el('.chapter-warning'));
    const countBeforeChapterExport=calls.length;
    el('[data-export="docx"]').click();await wait(()=>calls.length>countBeforeChapterExport&&!el('[data-export]'));
    const chapterZip=await JSZip.loadAsync(Buffer.from(calls.at(-1).args.data,'base64'));
    const chapterXML=await chapterZip.file('word/document.xml').async('string');
    assert.match(chapterXML,/w:val="Heading1"/);assert.match(chapterXML,/w:val="Heading2"/);
    assert.match(chapterXML,/Opening/);assert.doesNotMatch(chapterXML,/Empty chapter/);
    if(process.env.TEST_OUTPUT){fs.mkdirSync(process.env.TEST_OUTPUT,{recursive:true});fs.writeFileSync(process.env.TEST_OUTPUT+'/chapters-export.docx',Buffer.from(calls.at(-1).args.data,'base64'));}
    el('[data-action="chapters"]').click();el('[data-action="chapter-remove"]').click();el('[data-action="save-chapters"]').click();
    assert.equal(el('[data-action="chapters"]').textContent,'Chapters (3)');
    await wait(()=>JSON.parse(writes.at(-1)?.data || '{}').chapters?.length===3);
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.deepEqual(errors,[]);
    if(process.env.TEST_OUTPUT){fs.mkdirSync(process.env.TEST_OUTPUT,{recursive:true});for(const[k,b]of output)fs.writeFileSync(process.env.TEST_OUTPUT+'/clicked-export.'+k,b);}
    process.stdout.write('PASS '+(linked?'Storyboard-linked':'standalone')+' shipped bundle DOM clicks for all seven formats, Unicode, cancellation, retry, duplicate clicks, optional chapters, time validation, DOCX heading import and chapter export.\n');
  }
}finally{w.close();}
