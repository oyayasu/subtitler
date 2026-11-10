import test from 'node:test';import assert from 'node:assert/strict';
import {transcriptCandidate} from '../src/workspace-discovery.js';
test('reuse a saved transcript even when it has never been opened in this app session',()=>{
 const audio={path:'/Project/Audio.wav',fingerprint:'same'};
 const saved=[{id:'original',path:'/Project/Audio.subtitler',source:{path:'/Old/Audio.wav',fingerprint:'same'},updatedAt:'2026-11-05',cueCount:12}];
 assert.equal(transcriptCandidate(audio,[],saved).id,'original');assert.equal(transcriptCandidate({...audio,fingerprint:'different'},[],saved),null);
});
test('prefer edited speech over an empty duplicate; do not equate filenames alone',()=>{
 const audio={path:'/Project/Audio.wav'},projects=[{id:'empty',source:audio,cues:[],updatedAt:'2026-11-06'},{id:'edited',source:audio,cues:[{}],updatedAt:'2026-11-05'}];assert.equal(transcriptCandidate(audio,projects).id,'edited');assert.equal(transcriptCandidate({path:'/Other/Audio.wav'},projects),null);
});
