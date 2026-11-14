import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {newProject,parseSrt,validateProject,History,cueText,timingExport} from '../src/model.js';
import {chapterSeconds,installReferenceChapters,refreshChapterTimes,invalidateChapterTimes,placedChapters,transcriptBlocks} from '../src/chapters.js';
import {parseScript,matchScript} from '../src/workflow.js';
import {docxExport,textExport,srtExport} from '../src/exports.js';
vm.runInThisContext(fs.readFileSync(new URL('../src/vendor/jszip.min.js',import.meta.url),'utf8'));
const sample=()=>parseSrt('1\n00:00:01,000 --> 00:00:05,000\nA candle lit the room.\n\n2\n00:00:06,000 --> 00:00:09,000\nHer brother was already there.');
const reference=()=>parseScript({format:'subtitler-script-v1',schemaVersion:1,chapters:[
  {id:'parent',title:'Chapter 1',level:1,text:''},
  {id:'child',title:'Scene one',level:2,text:'A candle lit the room.'},
  {id:'next',title:'Chapter 2',level:1,text:'Her brother was already there.'},
  {id:'empty',title:'Empty end',level:1,text:''},
]});
const manual=(id,start,title=id,level=1)=>({id,title,start,level,timeMode:'manual',origin:'manual'});

test('chapter time input accepts practical clocks and rejects impossible or negative times',()=>{
  assert.equal(chapterSeconds('1:02'),62);assert.equal(chapterSeconds('01:02:03.25'),3723.25);
  assert.equal(chapterSeconds('12,5'),12.5);assert.equal(chapterSeconds(''),null);
  for(const t of ['-1','1:99','01:70:00','abc',172801,NaN])assert.throws(()=>chapterSeconds(t));
});
test('chapters have independent persistent IDs and participate in document Undo and timing export',()=>{
  const p=sample(),h=new History(p);h.change('add',p=>{p.chapters=[manual('first',0,'Opening')];});
  assert.equal(validateProject(JSON.parse(JSON.stringify(h.project))).chapters[0].id,'first');
  assert.equal(timingExport(h.project).chapters[0].start,0);
  h.back();assert.equal(h.project.chapters.length,0);h.forward();assert.equal(h.project.chapters[0].title,'Opening');
  assert.deepEqual(newProject().chapters,[]);
});
test('imported parent and subchapter markers use matched speech and empty sections stay unplaced',()=>{
  const p=sample(),r=reference();installReferenceChapters(p,r);matchScript(p,r,{correct:false});
  assert.deepEqual(p.chapters.map(c=>[c.title,c.start]),[['Chapter 1',1],['Scene one',1],['Chapter 2',6],['Empty end',null]]);
  assert.equal(r.words[0].text,'A');assert.ok(!r.words.some(w=>w.text==='Chapter'));
  assert.deepEqual(p.chapters.map(c=>c.level),[1,2,1,1]);
});
test('weak reference matches do not invent chapter timestamps',()=>{
  const p=sample(),r=parseScript({format:'subtitler-script-v1',schemaVersion:1,chapters:[{id:'x',title:'Unrelated',text:'Rocket engines orbit lunar planets through distant galaxies tomorrow.'}]});
  installReferenceChapters(p,r);matchScript(p,r,{correct:false});assert.equal(p.chapters[0].start,null);
});
test('matched chapters follow word timing but a removed anchor never follows its old array position',()=>{
  const p=sample(),r=reference();installReferenceChapters(p,r);matchScript(p,r,{correct:false});
  p.chapters.push(manual('manual',2));p.cues[0].words[0].start=1.2;refreshChapterTimes(p);
  assert.equal(p.chapters[0].start,1.2);assert.equal(p.chapters.at(-1).start,2);
  p.cues[0].words.shift();refreshChapterTimes(p);assert.equal(p.chapters[0].start,null);assert.equal(p.chapters[2].start,6);
});
test('reimport preserves matching chapter IDs and manual times without duplicating a family',()=>{
  const p=sample(),r=reference();p.chapters=[manual('custom',2)];installReferenceChapters(p,r);
  const id=p.chapters[1].id;p.chapters[1].timeMode='manual';p.chapters[1].start=.5;
  installReferenceChapters(p,r);assert.equal(p.chapters.length,5);assert.equal(p.chapters[1].id,id);assert.equal(p.chapters[1].start,.5);
  invalidateChapterTimes(p);assert.equal(p.chapters[0].needsReview,true);assert.equal(placedChapters(p).length,0);
  matchScript(p,r,{correct:false});assert.equal(p.chapters[2].start,1);assert.equal(p.chapters[0].needsReview,true);
});
test('chapter boundaries inside subtitles split document paragraphs without losing or repeating spoken words',async()=>{
  const p=sample(),original=srtExport(p),time=p.cues[0].words[2].start;
  p.chapters=[manual('a',0,'Opening'),manual('b',time,'A smaller section',2),manual('pending',null,'Not placed')];
  const blocks=transcriptBlocks(p);
  assert.deepEqual(blocks.filter(b=>b.kind==='heading').map(b=>b.title),['Opening','A smaller section']);
  assert.equal(blocks.filter(b=>b.kind==='text').map(b=>b.text).join(' '),p.cues.map(cueText).join(' '));
  assert.equal(srtExport(p),original);
  assert.match(textExport(p),/Opening/);assert.doesNotMatch(textExport(p),/Not placed/);
  const zip=await JSZip.loadAsync(await docxExport(p));const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/w:val="Title"/);assert.match(xml,/w:val="Heading1"/);assert.match(xml,/w:val="Heading2"/);
  const styles=await zip.file('word/styles.xml').async('string');assert.match(styles,/w:outlineLvl w:val="1"/);
});
test('invalid chapter metadata rolls back rather than corrupting the open project',()=>{
  const p=sample();p.chapters=[manual('a',0)];const h=new History(p);
  assert.throws(()=>h.change('duplicate',p=>p.chapters.push(manual('a',1))));assert.equal(h.project.chapters.length,1);
  assert.throws(()=>validateProject({...p,chapters:[manual('b',-1)]}));
  assert.throws(()=>validateProject({...p,chapters:[manual('b',0,'Title',7)]}));
});
test('text-first markers beyond a subsequently attached recording stay recoverable but are not exported',()=>{
  const p=sample();p.chapters=[manual('future',90,'Later scene')];
  assert.equal(validateProject(p).chapters.length,1);assert.equal(placedChapters(p).length,0);
  assert.doesNotMatch(textExport(p),/Later scene/);p.source.duration=100;assert.equal(placedChapters(p).length,1);
});
test('an explicitly reimported different heading does not inherit a manual timestamp by paragraph position',()=>{
  const p=sample(),r=reference();installReferenceChapters(p,r);p.chapters[0].timeMode='manual';p.chapters[0].start=3;
  r.chapters[0].title='An unrelated new chapter';installReferenceChapters(p,r);
  assert.equal(p.chapters[0].start,null);assert.equal(p.chapters[0].title,'An unrelated new chapter');
});
