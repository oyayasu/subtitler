import assert from 'node:assert/strict';
import test from 'node:test';
import {cueText,validateProject} from '../src/model.js';
import {youtubeId,preferredTrack,youtubeProject} from '../src/youtube.js';

test('accepts individual videos and strips unrelated playlist and sharing parameters', () => {
  const id = 'abc_D-12345';
  for (const link of [`https://www.youtube.com/watch?v=${id}&list=xx`,`youtu.be/${id}?si=share`,`https://m.youtube.com/shorts/${id}`,`https://www.youtube-nocookie.com/embed/${id}`]) {
    assert.equal(youtubeId(link),id);
  }
  for (const link of ['youtube.com/playlist?list=123','https://youtube.com.evil.com/watch?v='+id,'file://youtube.com/watch?v='+id,'https://youtube.com/watch?v=-oops','https://user@youtube.com/watch?v='+id]) assert.throws(()=>youtubeId(link));
});
test('ranks creator tracks within the preferred language and never silently switches languages', () => {
  const tracks = [{code:'en',automatic:true},{code:'ja',automatic:false},{code:'en-US',automatic:false}];
  assert.equal(preferredTrack(tracks,'auto','en'),tracks[2]);
  assert.equal(preferredTrack(tracks,'ja','en'),tracks[1]);
  assert.equal(preferredTrack(tracks,'pt','en'),null);
  assert.equal(preferredTrack([tracks[0]],'en',null),tracks[0]);
});
test('preserves cue boundaries, Unicode, subtitle breaks, and caption provenance', () => {
  const events = [{tStartMs:1250,dDurationMs:1620,segs:[{utf8:'Olá, '},{utf8:'mundo!\n日本語'}]},
    {tStartMs:2000,segs:[{utf8:'\n'}]}, {tStartMs:3100,dDurationMs:400,segs:[{utf8:'Bye.'}]}];
  const p = youtubeProject({events},'abc_D-12345','Example',{code:'pt-orig',automatic:true});
  assert.deepEqual(p.cues.map(c=>[c.start,c.end]),[[1.25,2.87],[3.1,3.5]]);
  assert.equal(cueText(p.cues[0]),'Olá, mundo!\n日本語');
  assert.equal(p.language,'pt'); assert.equal(p.source.name,''); assert.equal(p.recognition.automatic,true);
  assert.ok(validateProject(p)); assert.throws(()=>youtubeProject({events:[]},'', '',{}));
});
