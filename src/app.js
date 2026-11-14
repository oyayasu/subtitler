import {listenDocument} from './window-events.js';
import {chapterSeconds,installReferenceChapters,refreshChapterTimes,invalidateChapterTimes,placedChapters} from './chapters.js';
import {rebaseSavePath,isUnderSaveFolder} from './save-paths.js';
import {spokenKey,referenceKey,referenceOf,canMatch,needsTiming,aligned as alignedTiming} from './timing-state.js';
import {retimeImported} from './match-timing.js';
import {contentKey, openedDocument, standalone, distinctName} from './document-model.js';
import {recognitionQuality} from './recognition-quality.js';
import {transcriptCandidate} from "./workspace-discovery.js";
import {sameRecording} from "./recording-identity.js";
import {
  subtitleDefaults,
  subtitleOptions,
  resegment,
  captionLines,
  parseScript,
  docxScript,
  matchScript,
  attachPauses,
  timingDiagnostics,
} from "./workflow.js";
import { createStudioLink } from "./studio-link.js";
import { alignmentRequest, applyAlignment } from "./alignment.js";
import {
  newProject,
  parseWhisper,
  parseSrt,
  validateProject,
  History,
  clone,
  uid,
  clock,
  seconds,
  cueText,
  splitCue,
  mergeCues,
  editCue,
  retimeCue,
  activeWord,
} from "./model.js";
import { makeExport } from "./exports.js";
import { database as db } from "./db.js";
import { createWaveform } from "./waveform.js";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const native = () => !!window.__TAURI__?.core?.invoke,
  invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
let projects = [],
  history = null,
  prefs = {
    language: "auto",
    model: "",
    whisper: "",
    ffmpeg: "",
    whisperxPython: "",
    threads: 6,
    theme: "dark",
    subtitleOptions: { ...subtitleDefaults },
  },
  tools = { models: [] },
  mediaUrl = "",
  fallbackUrl = "",
  objectUrl = "",
  saveChain = Promise.resolve(),
  lastSaveError = null,
  loadObserver = null,
  documentPath = null,
  lastSavedKey = new Map(),
  allocatedPaths = new Map(),
  loadEpoch = 0;
try {
  prefs = {
    ...prefs,
    ...JSON.parse(localStorage.getItem("whisperDesk.preferences.v1") || "{}"),
  };
} catch {}
delete prefs.follow;
delete prefs.waveformWidth;
prefs.subtitleOptions = subtitleOptions(prefs.subtitleOptions);
const ui = {
  selected: [],
  wordId: null,
  anchor: null,
  query: "",
  limit: 100,
  busy: false,
  jobId: null,
  progress: "",
  percent: null,
  active: null,
  activeCue: null,
  drafts: {},
  fallbackUsed: false,
  scissors: false,
  audioMissing: false,
  audioError: "",
  previewExists: false,
  detectingTools: false,
  toolMessage: "",
};
const audioPath=p=>p?.source.embeddedPath||p?.source.path;
const project = () => history?.project,
  selectedCue = () => project()?.cues.find((c) => c.id === ui.selected.at(-1)),
  selectedWord = () => selectedCue()?.words.find((w) => w.id === ui.wordId);
const wave = createWaveform({
  project,
  audio: () => $("#audio"),
  duration: () => project()?.source.duration || 0,
  cue: selectedCue,
  seek,
  cache: {
    get: (id) => db.waveform(id),
    put: (id, value) => db.putWaveform(id, value),
  },
  waveUrl: () =>
    native() && ui.previewExists
      ? window.__TAURI__.core.convertFileSrc(project().source.previewPath)
      : mediaUrl,
  isWav: () =>
    (native() && ui.previewExists) ||
    /\.wav$/i.test(project()?.source.name || ""),
});
let toastTimer;
function toast(text) {
  $("#toast")?.remove();
  const el = document.createElement("div");
  el.id = "toast";
  el.role = "status";
  el.textContent = text;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 5000);
}
function report(e) {
  console.error(e);
  toast(e.message || String(e));
}
function preferences() {
  localStorage.setItem("whisperDesk.preferences.v1", JSON.stringify(prefs));
}
function save() {
  const current=project();
  if(!current||(!current.source.name&&!current.cues.length&&!current.referenceInput&&!current.documentCreated))return Promise.resolve(false);
  const key=contentKey(current);
  if(lastSavedKey.get(current.id)===key)return saveChain.then(()=>false);
  current.updatedAt=new Date().toISOString();
  const snapshot=clone(current);snapshot.drafts={};
  const index=projects.findIndex(p=>p.id===snapshot.id);index<0?projects.unshift(snapshot):projects[index]=snapshot;
  const requestedPath=documentPath;
  lastSaveError=null;
  saveChain=saveChain.catch(()=>{}).then(async()=>{
    if(native()){
      const target=requestedPath||allocatedPaths.get(snapshot.id)||await invoke('allocate_document',{directory:prefs.transcriptDirectory,name:snapshot.name});
      allocatedPaths.set(snapshot.id,target);
      if(!requestedPath){const chosenName=target.split(/[\\/]/).at(-1).replace(/\.subtitler$/i,'');if(project()?.id===snapshot.id&&project().name===snapshot.name)project().name=chosenName;snapshot.name=chosenName;}
      snapshot.filePath=target;
      if(lastSavedKey.get(snapshot.id)===contentKey(snapshot)&&snapshot.source?.embeddedPath)return false;
      if(!(await invoke('claim_document',{path:target})))throw Error('This project is already open in another window.');
      if(snapshot.studioLink)snapshot.studioLink.projectFile=target;
      const written=await invoke('write_document',{path:target,data:JSON.stringify(snapshot,null,2)});if(written?.audioPath){snapshot.source.embeddedPath=written.audioPath;if(project()?.id===snapshot.id)project().source.embeddedPath=written.audioPath;}if(written?.audioWarning)toast(written.audioWarning);
      if(project()?.id===snapshot.id){documentPath=target;project().filePath=target;if(project().studioLink)project().studioLink.projectFile=target;}
    }
    await db.save(snapshot);lastSavedKey.set(snapshot.id,contentKey(snapshot));
    if(project()?.id===snapshot.id){$('#saved').hidden=true;renderHeader();studio.schedule();}
    return true;
  }).catch(e=>{lastSaveError=e;$('#saved').hidden=false;$('#saved').textContent='Save failed';report(e);return false;});
  return saveChain;
}
async function saveCurrent(){
  const reference=$('#reference-input');
  if(reference){const text=reference.value;history.change('Change reference text',p=>{if(text.trim()){p.referenceInput=parseScript(text);p.useScript=true;}else{delete p.referenceInput;p.useScript=false;}});}
  if(!applyDrafts())return;
  if(!documentPath)project().documentCreated=true;
  const changed=await save();await studio.flush();if(lastSaveError)throw lastSaveError;
  toast(changed?'Project saved.':'Everything is up to date.');renderHeader();
}
async function saveAs(){
  if(!applyDrafts()||!native())return;
  const path=await invoke('choose_document_save',{name:project().name});if(!path)return;
  const next=standalone(project());next.filePath=path;next.documentCreated=true;
  if(!(await invoke('claim_document',{path})))return;
  await openProject(next);documentPath=path;await saveCurrent();
}
async function closeProject(){
  if(ui.closing)return;ui.closing=true;
  try{
    if(ui.busy){ui.cancelRequested=true;await invoke('cancel_transcription');ui.progress='Finishing audio task before closing…';renderHeader();while(ui.busy)await new Promise(r=>setTimeout(r,100));}
    if(!applyDrafts())throw Error('Check the current text edit before closing.');
    await save();await studio.flush();if(lastSaveError)throw lastSaveError;
    if(native())await invoke('finish_document_close');else window.close();
  }catch(e){ui.closing=false;if(native())void invoke("cancel_document_close").catch(()=>{});report(e);}
}
function commit(label, fn) {
  if (!history || ui.busy) return;
  try {
    history.change(label, p => { fn(p); refreshChapterTimes(p); });
    ui.selected = ui.selected.filter((id) =>
      project().cues.some((c) => c.id === id),
    );
    save();
    renderContent();
    renderHeader();
  } catch (e) {
    report(e);
  }
}
function referenceProject(original,reference){
 if(original.cues.length&&spokenKey(original)===spokenKey({cues:[{words:reference.words}]}))return clone(original);
 const p=clone(original),duration=Math.max(.01,p.source.duration),step=duration/Math.max(1,reference.words.length);
 const words=reference.words.map((w,i)=>({id:uid(),text:w.text,gap:w.gap??(i?' ':''),start:i*step,end:(i+1)*step,timing:'estimated',scriptChapterId:w.chapterId,scriptFrom:w.from,scriptTo:w.to}));if(!words.length)throw Error('Import reference text first.');p.cues=[{id:uid(),start:0,end:duration,words}];return p;
}
function installPanelResizing(){
 const root=$('.workspace');let dims;try{dims=JSON.parse(localStorage.getItem('subtitler.panelSizes')||'{}');}catch{dims={};}
 const apply=()=>{root.style.setProperty('--wave-height',Math.max(32,Math.min(innerHeight*.42,dims.wave||88))+'px');root.style.setProperty('--inspector-width',Math.max(220,Math.min(innerWidth*.55,dims.inspector||310))+'px');wave.draw();};apply();
 for(const [selector,dimension,vertical] of [['.waveform-resizer','wave',true],['.inspector-resizer','inspector',false]]){const bar=$(selector);bar.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();bar.setPointerCapture(e.pointerId);const start=vertical?e.clientY:e.clientX,initial=dimension==='wave'?$('#waveform').clientHeight:$('#inspector').clientWidth;const move=ev=>{dims[dimension]=initial+(vertical?ev.clientY-start:start-ev.clientX);apply();};const end=()=>{bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',end);bar.removeEventListener('pointercancel',end);localStorage.setItem('subtitler.panelSizes',JSON.stringify(dims));};bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',end);bar.addEventListener('pointercancel',end);});bar.addEventListener('keydown',e=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();dims[dimension]=(dims[dimension]||(vertical?88:310))+(e.key==='ArrowDown'||e.key==='ArrowLeft'?10:-10);apply();localStorage.setItem('subtitler.panelSizes',JSON.stringify(dims));});}
 window.addEventListener('resize',apply);
}
function applyFolderMove(result){
 if(!result?.directory)return;const path=p=>rebaseSavePath(p,result.old,result.directory);const update=p=>{if(!p)return;for(const key of ['filePath','privateFile','openedFile'])if(p[key])p[key]=path(p[key]);if(p.studioLink?.projectFile)p.studioLink.projectFile=path(p.studioLink.projectFile);for(const key of ['path','previewPath'])if(p.source?.[key])p.source[key]=path(p.source[key]);};
 prefs.transcriptDirectory=result.directory;preferences();documentPath=path(documentPath);update(project());for(const p of projects){update(p);void db.save(p);}for(const[id,p]of allocatedPaths)allocatedPaths.set(id,path(p));lastSavedKey.clear();studio.reset();renderHeader();refreshDocumentHeader();if($('#transcript-directory'))$('#transcript-directory').textContent=result.directory;
}
async function moveTranscriptFolder(){
 if(!native()||ui.busy)return;if(!applyDrafts())return;if(project().source.name||project().cues.length||project().referenceInput){await save();if(lastSaveError)throw lastSaveError;await studio.flush();}
 const parent=await invoke('choose_transcript_directory');if(!parent)return;ui.busy=true;ui.progress='Moving and verifying Subtitler files…';ui.percent=null;renderHeader();
 try{const result=await invoke('move_transcript_folder',{directory:prefs.transcriptDirectory,parent,createIfMissing:!projects.some(p=>isUnderSaveFolder(p.filePath,prefs.transcriptDirectory))});applyFolderMove(result);toast(result.warning||(result.changed?'Subtitler folder moved.':'The folder is already in this location.'));}finally{ui.busy=false;renderHeader();}
}

function setup() {
  document.documentElement.dataset.theme =
    prefs.theme === "light" ? "light" : "dark";
  $("#app").innerHTML =
    `<main class="workspace"><header class="topbar"><details class="file-menu"><summary>File</summary><div><button data-action="new-project">New</button><button data-action="open-project">Open…</button><button data-action="recent-projects">Open Recent…</button><hr><button data-action="import-audio">Import Audio…</button><button data-action="import-reference">Import Reference text…</button><button data-action="import-subtitles">Import Subtitles…</button><button data-action="project-folder">Open Storyboard project…</button><hr><button data-action="save-project">Save</button><button data-action="save-as">Save As…</button><button data-action="reveal-transcript">Show saved project</button><button data-action="move-transcript-folder">Move Subtitler folder…</button><hr><button data-action="export">Export…</button><button data-action="close-project">Close</button></div></details><span class="brand">SUBTITLER</span><div class="project-title"><input id="project-name" aria-label="Transcript name" maxlength="200"><span id="saved" role="status" hidden></span></div><div class="top-actions"><button class="secondary" data-action="settings" aria-label="Settings">⚙</button><button class="secondary" data-action="save-project">Save project</button><button class="primary" data-action="export">Export ↗</button></div></header><div id="document-status"><button id="saved-location" data-action="reveal-transcript"></button><strong id="studio-connection" hidden></strong></div>
 <section class="player"><audio id="audio" preload="metadata"></audio><div id="audio-placeholder"><button class="secondary" data-action="import-audio">＋ Import audio</button><small>or drop an audio file here</small></div><div class="waveform-wrap" id="waveform-shell"><div class="waveform-top"><button data-action="play-pause" id="play-pause" aria-label="Play">▶</button><span id="player-time">00:00:00.000 / 00:00:00.000</span><button class="audio-name" id="audio-name" data-action="audio-location"></button><span class="waveform-spacer"></span><button class="secondary" data-action="relink" hidden>Attach audio…</button></div><div class="waveform-resize-target"><div id="chapter-markers" aria-label="Chapter markers"></div><canvas id="waveform" height="88" role="slider" tabindex="0" aria-label="Audio playhead" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas><div class="panel-resizer waveform-resizer" role="separator" tabindex="0" aria-label="Resize waveform height" aria-orientation="horizontal"></div></div><div class="waveform-bottom"><span id="waveform-status" role="status"></span><span id="audio-error" role="status"></span><label>Speed<select id="playback-rate" aria-label="Playback speed"><option value=".5">0.5×</option><option value=".75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label class="volume-control">Volume<input type="range" id="volume" min="0" max="1" step=".05" value="1" aria-label="Volume"></label></div></div>
 <div id="job-status" hidden><div class="job-message"><span id="job-message"></span><button data-action="cancel">Cancel</button></div><progress id="job-progress"></progress></div><div class="transcribe-bar"><label>Language<select id="language"><option value="auto">Auto detect</option><option value="en">English</option><option value="pt">Português</option><option value="es">Español</option><option value="ja">日本語</option></select></label><label class="model-label">Whisper model<select id="model"></select></label><button class="secondary" data-action="transcription-options">Options</button><button class="primary" data-action="transcribe">Transcribe</button><button class="secondary" data-action="improve-timing" hidden>Update word timings</button><button class="secondary" data-action="timing-report" hidden>Timing report</button></div><div id="project-sync-status" role="status" hidden></div></section>
 <section class="editor"><div class="editor-toolbar"><button class="scissors-button" data-action="scissors" title="Split before a word" aria-label="Scissors" aria-pressed="false"><img src="assets/scissors-icon.png" alt=""></button><span class="toolbar-rule"></span><button class="secondary" data-action="reference-text">Reference text</button><button class="secondary" data-action="chapters">Chapters</button><button class="secondary" data-action="clear-transcript">Clear transcript</button><input id="search" type="search" placeholder="Find…" aria-label="Find in transcript"></div><div class="editor-columns"><section class="transcript-panel"><div id="match-reference-prompt" hidden><button class="primary" data-action="match-timings">Match timings</button><small>Match your imported reference text to this recording.</small></div><div id="transcript-list" tabindex="-1"></div></section><div class="panel-resizer inspector-resizer" role="separator" tabindex="0" aria-label="Resize subtitle editor" aria-orientation="vertical"></div><aside class="inspector" id="inspector" aria-label="Subtitle editor"></aside></div></section></main>`;
  wave.mount();
  installPanelResizing();
  const audio = $("#audio");
  audio.addEventListener("timeupdate", () => updatePlayback());
  audio.addEventListener("seeked", () => updatePlayback());
  audio.addEventListener("loadedmetadata", () => {
    if (ui.seekTo !== undefined) {
      audio.currentTime = ui.seekTo;
      delete ui.seekTo;
    }
    if (
      project() &&
      !project().source.duration &&
      Number.isFinite(audio.duration)
    ) {
      project().source.duration = audio.duration;
      save();
    }
    updatePlayback(false);
  });
  audio.addEventListener("error", async () => {
    if(native()&&project()?.source.embeddedPath&&mediaUrl!==window.__TAURI__.core.convertFileSrc(project().source.embeddedPath)){ui.seekTo=audio.currentTime;await loadAudio();renderHeader();return;}
    if (fallbackUrl && !ui.fallbackUsed) {
      ui.fallbackUsed = true;
      audio.src = fallbackUrl;
      audio.load();
    } else if (mediaUrl) {
      ui.audioError = "Playback unavailable";
      if (native()) await checkAudio();
      renderHeader();
    }
  });
  let raf;
  const tick = () => {
    updatePlayback();
    if (!audio.paused) raf = requestAnimationFrame(tick);
  };
  audio.addEventListener("play", () => {
    if(!ui.playRequested){audio.pause();return;}
    cancelAnimationFrame(raf);
    tick();
  });
  audio.addEventListener("pause", () => {
    ui.playRequested=false;
    cancelAnimationFrame(raf);
    updatePlayback();
  });
  audio.addEventListener("ended", () => {
    cancelAnimationFrame(raf);
    updatePlayback();
  });
}
function refreshDocumentHeader(){renderHeader();}
function renderHeader() {
  if(native()&&ui.startupComplete&&project()){const p=project(),empty=!documentPath&&!p.source?.path&&!p.cues?.length&&!referenceOf(p),recordingKey=p.studioLink?`${p.studioLink.projectId||''}:${p.source.fingerprint||p.source.path}`:null,binding=JSON.stringify([empty,recordingKey]);if(ui.lastWindowBinding!==binding){ui.lastWindowBinding=binding;void invoke('set_document_empty',{empty,recordingKey}).catch(()=>{});}}
  const fileMenu=document.querySelector('.file-menu');if(fileMenu)fileMenu.hidden=native();
  const location=$('#saved-location'),connection=$('#studio-connection');
  const saved=project()?.studioLink?.projectFile||documentPath;
  location.textContent=saved?'Saved at: '+saved:'Not saved yet';location.disabled=!saved;
  connection.hidden=!project()?.studioLink;connection.textContent=project()?.studioLink?'Connected to Storyboard Studio · '+(project().studioLink.projectName||'Project'):'';
  $('#audio-placeholder').hidden=!!project()?.source.name&&!ui.audioMissing;
  $('#waveform-shell').hidden=!project()?.source.name||ui.audioMissing;
  $('#audio-name').textContent=project()?.source.name||'';
  const title=project()?.name||'Untitled';if(native()&&ui.windowTitle!==title){ui.windowTitle=title;void invoke('document_title',{title}).catch(()=>{});}

  const p = project();
  const chapterButton = $('[data-action="chapters"]');
  if (chapterButton) { chapterButton.disabled = !p || ui.busy; chapterButton.textContent = 'Chapters' + (p?.chapters?.length ? ` (${p.chapters.length})` : ''); }
  const chapterMarkers = $('#chapter-markers');
  if (chapterMarkers) {
    const duration = p?.source.duration || 0;
    chapterMarkers.innerHTML = duration ? placedChapters(p).map(c => `<button class="chapter-flag" data-action="chapter-seek" data-start="${c.start}" style="left:clamp(8px,${Math.min(100,c.start / duration * 100)}%,calc(100% - 8px))" aria-label="Go to ${esc(c.title)} at ${clock(c.start)}"><span class="flag-shape" aria-hidden="true"></span><span class="chapter-tooltip">${esc(c.title)} · ${clock(c.start)}</span></button>`).join('') : '';
  }
  if (document.activeElement !== $("#project-name"))
    $("#project-name").value = p?.name || "Untitled";
  $("#project-name").disabled = !p || ui.busy;
  $("#language").value = prefs.language;
  const models = [...tools.models];
  if (prefs.model && !models.some((m) => m.path === prefs.model))
    models.unshift({
      path: prefs.model,
      name: prefs.model.split(/[\\/]/).at(-1),
    });
  $("#model").innerHTML = models.length
    ? models
        .map(
          (m) =>
            `<option value="${esc(m.path)}" ${m.path === prefs.model ? "selected" : ""}>${esc(m.name)}</option>`,
        )
        .join("")
    : '<option value="">Choose in Settings</option>';
  for (const a of ["import-audio", "relink", "transcribe", "improve-timing", "match-timings"])
    document
      .querySelectorAll(`[data-action="${a}"]`)
      .forEach(
        (el) =>
          (el.disabled =
            ui.busy ||
            ((a === "transcribe" || a === "improve-timing") &&
              !p?.source.path) ||
            (a === "improve-timing" && !p?.cues.length)),
      );
  $('[data-action="timing-report"]').hidden =
    !p?.recognition?.alignment &&
    !p?.workflowWarnings?.length &&
    !p?.diagnostics;
  $('[data-action="relink"]').hidden = !ui.audioMissing;
  $("#audio-error").textContent = ui.audioMissing ? "Audio file missing. Import it again." : p?.timingsNeedMatch ? "This recording needs timing matching." : ui.audioError;
  $("#language").disabled = ui.busy;
  $("#model").disabled = ui.busy;
  $("#job-status").hidden = !ui.busy;
  $('[data-action="cancel"]').hidden = !ui.jobId;
  $("#job-message").textContent = ui.progress;
  const progress = $("#job-progress");
  ui.percent === null
    ? progress.removeAttribute("value")
    : ((progress.max = 100), (progress.value = ui.percent));
  for(const a of ['export','save-project'])document.querySelectorAll(`[data-action="${a}"]`).forEach(el=>el.disabled=!p||(a==='export'&&!p.cues.length));
  document.querySelectorAll('[data-action="match-timings"]').forEach(el=>el.disabled=ui.busy||!p?.source.path||(!p.cues.length&&!p.referenceInput&&!p.availableScript));
  $('#match-reference-prompt').hidden=!canMatch(p);$('.transcript-panel').classList.toggle('reference-awaiting',canMatch(p)&&!p?.cues.length);
  const timingButton=$('[data-action="improve-timing"]');timingButton.hidden=!needsTiming(p);timingButton.textContent=p?.timingAlignmentPending?'Retry word timing':'Update word timings';
  $("#play-pause").disabled = !mediaUrl;
  $("#waveform").setAttribute("aria-disabled", String(!mediaUrl));
  $("#playback-rate").disabled = !mediaUrl;
  $("#volume").disabled = !mediaUrl;
}
function filtered() {
  const query = ui.query.toLocaleLowerCase();
  return (project()?.cues || []).filter(
    (c) => !query || cueText(c).toLocaleLowerCase().includes(query),
  );
}
let renderedPauses=new Set();
function pauseLabels(from,to){return(project().pauses||[]).filter(p=>{if(p.start<=from||p.start>to||renderedPauses.has(p.id))return false;renderedPauses.add(p.id);return true;}).map(p=>`<span class="pause-row"><button data-seek-pause="${p.start}">[${esc(p.label||'Silence')}]</button><time>${clock(p.start)} → ${clock(p.end)}</time></span>`).join('');}
function pauseRowsBefore(cue){const index=project().cues.indexOf(cue),prev=index?project().cues[index-1].end:-1;return pauseLabels(prev,cue.start);}
function inlinePauses(cue,index){return pauseLabels(index?cue.words[index-1].start:cue.start,cue.words[index].start);}
function renderContent() {
  renderedPauses=new Set();
  const p = project(),
    list = $("#transcript-list"),
    scroll = list.scrollTop,
    cues = filtered(),
    showing = cues.slice(0, ui.limit);
  loadObserver?.disconnect();
  list.innerHTML = showing.length
    ? showing
        .map(
          (c) =>
            `${pauseRowsBefore(c)}<article class="cue ${ui.selected.includes(c.id) ? "selected" : ""}" data-cue-row="${esc(c.id)}"><button class="cue-number" data-select-cue="${esc(c.id)}" aria-label="Select subtitle ${p.cues.indexOf(c) + 1}">${String(p.cues.indexOf(c) + 1).padStart(2, "0")}</button><div class="cue-body"><button class="cue-time" data-cue-time="${esc(c.id)}">${clock(c.start)} <span>→ ${clock(c.end)}</span></button>${project().subtitleOptions?.speakers !== 1 && c.words.some((w) => w.speaker) ? `<button class="speaker-label" data-speaker="${esc(c.words.find((w) => w.speaker).speaker)}">${esc(project().speakerNames?.[c.words.find((w) => w.speaker).speaker] || c.words.find((w) => w.speaker).speaker)}</button>` : ""}${c.layoutWarning ? '<small class="layout-warning">One word exceeds the character limit.</small>' : ""}<p>${c.words.map((w, i) => `${inlinePauses(c,i)}${i ? esc(w.gap) : ""}<button class="word ${w.timing === "estimated" ? "estimated" : ""} ${w.alignmentIssue ? "needs-review" : ""} ${w.id === ui.wordId ? "word-selected" : ""}" data-word="${esc(w.id)}" data-cue="${esc(c.id)}" title="${clock(w.start)}${w.timing === "estimated" ? " · approximate timing" : ""}">${esc(w.text)}</button>`).join("")}${pauseLabels(c.words.at(-1)?.start??c.start,c.end)}</p>${p.cues.indexOf(c) < p.cues.length - 1 ? `<div class="cue-merge"><button data-merge-after="${esc(c.id)}" aria-label="Merge subtitle ${p.cues.indexOf(c) + 1} with next">Merge ↓</button></div>` : ""}</div></article>`,
        )
        .join("") +
      (cues.length > showing.length
        ? '<div id="load-more" aria-hidden="true"></div>'
        : "")
    : `<div class="empty-state">${ui.query ? "<p>No matches</p>" : '<p>No subtitles yet.</p>'}</div>`;
  list.classList.toggle("scissors-active", ui.scissors);
  $('[data-action="scissors"]').setAttribute(
    "aria-pressed",
    String(ui.scissors),
  );
  list.scrollTop = scroll;
  renderInspector();
  ui.active = null;
  ui.activeCue = null;
  updatePlayback(false);
  const more = $("#load-more");
  if (more) {
    loadObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          ui.limit += 100;
          renderContent();
        }
      },
      { root: list, rootMargin: "200px" },
    );
    loadObserver.observe(more);
  }
}
function growTextarea() {
  const el = $("#subtitle-text");
  if (!el) return;
  const scroll = $("#inspector").scrollTop;
  el.style.height = "0px";
  const style = getComputedStyle(el),
    line = parseFloat(style.lineHeight) || 24,
    pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  el.style.height = Math.max(line + pad, el.scrollHeight) + line + 2 + "px";
  $("#inspector").scrollTop = scroll;
}
function renderInspector() {
  const cue = selectedCue(),
    word = selectedWord();
  $("#inspector").innerHTML = cue
    ? `<header class="inspector-heading"><span>${String(project().cues.indexOf(cue) + 1).padStart(2, "0")}</span></header><textarea id="subtitle-text" rows="1" aria-label="Edit subtitle" spellcheck="true">${esc(ui.drafts[cue.id] ?? cueText(cue))}</textarea><div class="text-edit-actions"><button class="secondary" data-action="cancel-text">Cancel</button><button class="primary" data-action="apply-text" title="Enter">Apply text</button></div><div class="inspector-section"><strong>Timing</strong><div class="time-fields"><label>Start<input id="cue-start" value="${clock(cue.start)}"></label><label>End<input id="cue-end" value="${clock(cue.end)}"></label></div></div>${word ? `<div class="inspector-section"><strong>Selected word</strong><p class="selected-word">${esc(word.text)}</p><small>${word.timing === "estimated" ? "Estimated timing" : word.timing === "manual" ? "Manual timing" : word.alignmentEngine === "whisperx" ? "WhisperX timing" : "Whisper timing"}</small>${word.alignmentIssue ? `<small>${esc(word.alignmentIssue)}</small>` : ""}<div class="time-fields"><label>Start<input id="word-start" value="${clock(word.start)}"></label><label>End<input id="word-end" value="${clock(word.end)}"></label></div></div>` : ""}`
    : "";
  growTextarea();
  if (ui.busy)
    $("#inspector")
      .querySelectorAll("input,textarea,button")
      .forEach((el) => (el.disabled = true));
}
function select(cueId, wordId = null, extend = false) {
  const changed = selectedCue()?.id !== cueId,
    cues = project().cues;
  if (extend && ui.anchor) {
    const a = cues.findIndex((c) => c.id === ui.anchor),
      b = cues.findIndex((c) => c.id === cueId);
    ui.selected = cues
      .slice(Math.min(a, b), Math.max(a, b) + 1)
      .map((c) => c.id);
  } else {
    ui.selected = [cueId];
    ui.anchor = cueId;
  }
  ui.wordId = wordId;
  renderContent();
  if (changed) $("#inspector").scrollTop = 0;
}
function seek(time) {
  const audio = $("#audio");
  if (!mediaUrl) return;
  try {
    if (audio.readyState < 1) ui.seekTo = time;
    else audio.currentTime = time;
  } catch {
    ui.seekTo = time;
  }
  updatePlayback();
}
function updatePlayback(follow = true) {
  if (!project()) return;
  const audio = $("#audio"),
    time = audio.currentTime || 0,
    active = mediaUrl&&!project().timingsNeedMatch ? activeWord(project(), time) : null,
    word = active?.word?.id || null,
    cue = active?.cue?.id || null;
  $("#player-time").textContent =
    clock(time) +
    " / " +
    clock(
      Number.isFinite(audio.duration)
        ? audio.duration
        : project().source.duration || 0,
    );
  $("#play-pause").textContent = audio.paused ? "▶" : "Ⅱ";
  $("#play-pause").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  if (word !== ui.active) {
    document
      .querySelectorAll(".word.playing")
      .forEach((el) => el.classList.remove("playing"));
    if (word)
      document
        .querySelector(`[data-word="${CSS.escape(word)}"]`)
        ?.classList.add("playing");
    ui.active = word;
  }
  if (cue !== ui.activeCue) {
    document
      .querySelectorAll(".cue.current")
      .forEach((el) => el.classList.remove("current"));
    let row = cue
      ? document.querySelector(`[data-cue-row="${CSS.escape(cue)}"]`)
      : null;
    const editing = document.activeElement?.matches("input,textarea,select");
    if (cue && !row && follow && !ui.query && !editing) {
      const index = project().cues.findIndex((c) => c.id === cue);
      ui.limit = Math.max(ui.limit, index + 50);
      renderContent();
      row = document.querySelector(`[data-cue-row="${CSS.escape(cue)}"]`);
    }
    if (row) {
      row.classList.add("current");
      if (follow && !editing && !$("#audio").paused)
        (document.querySelector(`[data-word="${CSS.escape(word)}"]`)||row).scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    ui.activeCue = cue;
  }
  wave.draw();
}
async function openProject(p) {
  $("#audio").pause();
  wave.stop();
  studio.reset();

  documentPath=p.filePath||p.studioLink?.projectFile||null;
  if(p.cues.length&&!p.wordTimingTextKey)p.wordTimingTextKey=spokenKey(p);
  p.closed = false;p.lastOpenedAt=new Date().toISOString();
  history = new History(p);
  ui.selected = p.cues.length ? [p.cues[0].id] : [];
  ui.anchor = ui.selected[0];
  ui.wordId = null;
  ui.limit = 100;
  ui.query = "";
  $("#search").value = "";
  ui.drafts = clone(p.drafts || {});
  localStorage.setItem("whisperDesk.current.v1", p.id);
  renderHeader();refreshDocumentHeader();renderContent();
  try{await loadAudio();}catch(e){ui.audioMissing=true;ui.audioError=String(e.message||e);}
  renderHeader();
  if (projects.some((item) => item.id === p.id)) await db.save(p);
  if (p.studioLink?.directory) void studio.refresh();
}
async function checkAudio() {
  const p = project();
  if (!native() || !p?.source.path) return;
  try {
    const status = await startupDeadline(
      invoke("audio_status", {
        path: audioPath(p),
        previewPath: p.source.previewPath || null,
      }),
      "Audio check timed out",
      3000,
    );
    if (project()?.id !== p.id) return;
    if(!status.originalExists&&documentPath&&!p.source.embeddedPath){const opened=await invoke('open_document',{path:documentPath});if(project()?.id!==p.id)return;if(opened.audioPath){p.source.embeddedPath=opened.audioPath;status.originalExists=true;}}
    ui.audioMissing = !status.originalExists;
    ui.previewExists = !!status.previewExists;
    if(status.originalExists&&p.source.fingerprint){const actual=await invoke('audio_file_info',{path:audioPath(p)});if(project()?.id!==p.id)return;if(!sameRecording(actual,p.source)){p.timingsNeedMatch=true;ui.audioError='Audio content changed. Import this recording again before matching.';}}

  } catch (e) {
    console.warn("Audio status unavailable", e);
  }
}
async function loadAudio() {
  const epoch=++loadEpoch;ui.playRequested=false;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
  mediaUrl = "";
  fallbackUrl = "";
  ui.fallbackUsed = false;
  ui.audioError = "";
  ui.audioMissing = false;
  ui.previewExists = false;
  const p = project();
  if (!p) return;
  if (native() && p.source.path) {
    await checkAudio();
    if(epoch!==loadEpoch||project()?.id!==p.id)return;
    if (!ui.audioMissing)
      mediaUrl = window.__TAURI__.core.convertFileSrc(audioPath(p));
    if (ui.previewExists) {
      fallbackUrl = window.__TAURI__.core.convertFileSrc(p.source.previewPath);
      if (!mediaUrl) {
        mediaUrl = fallbackUrl;
        ui.fallbackUsed = true;
      }
    }
  } else {
    const blob = await db.audio(p.id);
    if (blob) {
      objectUrl = URL.createObjectURL(blob);
      mediaUrl = objectUrl;
    } else ui.audioMissing = !!p.source.name || !!p.cues.length;
  }
  if(epoch!==loadEpoch||project()?.id!==p.id)return;
  const audio = $("#audio");
  audio.pause();
  audio.removeAttribute("src");
  if (mediaUrl) audio.src = mediaUrl;
  audio.load();
  wave.invalidate();
  void wave.load();
}
async function audioInput(input, relink = false) {
  if (ui.busy) return;
  const isPath = typeof input === "string",
    name = isPath ? input.split(/[\\/]/).at(-1) : input.name;
  let recordingInfo=isPath&&native()?await invoke('audio_file_info',{path:input}):null;
  const prior=project();
  if(prior?.source.name&&!sameRecording(prior.source,recordingInfo||{name,size:input.size,modified:input.lastModified})&&!ui.audioConfirmed){
    ui.pendingAudio=input;modal(`<header><h2>Use this audio?</h2></header><p>Attach ${esc(name)} to the current project. Your text stays; existing timings need matching again.</p><footer><button data-action="close-modal">Cancel</button><button class="primary" data-action="confirm-audio">Use audio</button></footer>`);return;
  }
  ui.audioConfirmed=false;
  if (/\.(mov|mp4|mkv|webm)$/i.test(name))
    throw Error(
      "Video import and visual subtitles are noted for a future version. Open an audio file for now.",
    );
  if (!/\.(wav|mp3|m4a|aac|flac|ogg|aiff?|opus|wma)$/i.test(name))
    throw Error("Choose an audio recording.");
  const old = project();
  let p=old||newProject();
  const changed=!!p.source.name&&!sameRecording(p.source,recordingInfo||{name,size:input.size,modified:input.lastModified});
  if(changed&&p.studioLink){await save();await studio.flush();p=standalone(p,distinctName(name.replace(/\.[^.]+$/,''),projects));delete p.source.embeddedPath;await openProject(p);}
  if(changed){delete p.source.embeddedPath;delete p.matchedReferenceKey;p.timingsNeedMatch=true;delete p.source.relativePath;delete p.scriptReference;p.pauses=[];invalidateChapterTimes(p);}
  if(!p.source.name&&!p.cues.length&&!p.referenceInput)p.name=distinctName(name.replace(/\.[^.]+$/,''),projects.filter(x=>!x.studioLink));
  if(!old)await openProject(p);
  const priorDuration = p.source.duration || 0,
    priorSize = p.source.size;
  p.source = {
    ...p.source,
    ...(recordingInfo||{}),
    name,
    path: isPath ? input : null,
    previewPath: null,
    duration: isPath ? p.source.duration : 0,
  };
  if (!isPath) {
    await db.putAudio(p.id, input);
    p.source.size = input.size;
    p.source.modified = input.lastModified;
  }
  await loadAudio();
  renderHeader();
  save();
  if (isPath && prefs.ffmpeg) {
    ui.busy = true;
    ui.progress = "Preparing playback…";
    renderHeader();
    try {
      const source = await invoke("prepare_audio", {
        path: input,
        ffmpeg: prefs.ffmpeg,
        projectId: p.id,
      });
      if (project()?.id === p.id) {
        p.source = { ...p.source, ...source };
        if (
          priorSize &&
          priorDuration &&
          Math.abs(priorDuration - source.duration) > 0.3
        )
          toast(
            "The relinked audio has a different duration. Review the subtitle timings.",
          );
        await loadAudio();
        save();
      }
    } catch (e) {
      toast(String(e));
    } finally {
      ui.busy = false;
      renderHeader();
    }
  }
  refreshDocumentHeader();
}
async function chooseAudio(relink = false) {
  ui.relink = relink;
  if (native()) {
    const path = await invoke("pick_file", { kind: "audio" });
    if (path) await audioInput(path, relink);
  } else $("#audio-file").click();
}
async function readInput(input) {
  const isPath = typeof input === "string",
    name = isPath ? input.split(/[\\/]/).at(-1) : input.name;
  if (!isPath && input.size > 50 * 1024 * 1024)
    throw Error("Transcript exceeds 50 MB.");
  if(isPath&&/\.(subtitler|whisperdesk)$/i.test(name))return openDocumentFile(input,true);
  const text = isPath
    ? await invoke("read_transcript", { path: input })
    : await input.text();
  let p;
  if (/\.srt$/i.test(name)) {
    return adoptSubtitles(parseSrt(text,{name}),input);

  }
  else {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error("The transcript is not valid JSON.");
    }
    if (raw.format === "subtitler-script-v1") {
      commit('Import reference text',p=>{p.referenceInput=parseScript(raw);p.useScript=true;adoptReferenceChapters(p,p.referenceInput);});
      toast("Reference text selected.");
      return;
    }
    if (
      ["whisperdesk-project-v1", "subtitler-project-v1"].includes(raw.format)
    ) {
      p = openedDocument(raw,isPath?input:name);
      p.closed = false;

      if (!native()) {
        p.source.path = null;
        p.source.previewPath = null;
        delete p.studioLink;
      }
    } else if (raw.format === "whisperdesk-timing-v1") {
      const words = new Map((raw.words || []).map((w) => [w.id, w]));
      p = newProject(raw.source?.name || "Imported timing", raw.source);
      p.source.path = null;
      p.source.previewPath = null;
      p.language = raw.language;
      p.recognition = raw.recognition;
      p.sourceWords = raw.originalWords || [];
      p.cues = raw.subtitles.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        words: c.wordIds.map((id) => {
          const w = words.get(id);
          if (!w) throw Error("Timing file refers to a missing word.");
          return w;
        }),
      }));
      validateProject(p);
    } else p = parseWhisper(raw, { name: name.replace(/\.json$/i, "") });
  }
  if(!/\.(subtitler|whisperdesk)$/i.test(name))return adoptSubtitles(p,input);
  await openProject(p);
  await save();
  toast("Opened.");
}
function adoptSubtitles(imported,input){
 if(project().cues.length&&!ui.importConfirmed){ui.pendingSubtitles=input;modal(`<header><h2>Replace current subtitles?</h2></header><p>Import these subtitles into the current project. Undo restores the previous subtitles and timing.</p><footer><button data-action="close-modal">Cancel</button><button class="primary" data-action="confirm-subtitles">Import subtitles</button></footer>`);return;}
 ui.importConfirmed=false;
 commit('Import subtitles',p=>{p.cues=imported.cues;p.sourceWords=imported.sourceWords||[];p.recognition=imported.recognition;p.referenceInput=parseScript(imported.cues.map(cueText).join('\n'));p.useScript=true;delete p.matchedReferenceKey;p.wordTimingTextKey=spokenKey(p);p.timingsNeedMatch=!!p.source.name;delete p.timingsCleared;p.pauses=[];});
}
function applyDrafts() {
  if (ui.busy) return false;
  const entries = Object.entries(ui.drafts).filter(([id, text]) =>
    project().cues.some((c) => c.id === id && cueText(c) !== text),
  );
  if (!entries.length) {
    ui.drafts = {};
    project().drafts = {};
    return true;
  }
  try {
    history.change("Edit subtitles", (p) => {
      for (const [id, text] of entries) editCue(p, id, text);
      refreshChapterTimes(p);
    });
    ui.drafts = {};
    project().drafts = {};
    save();
    renderContent();
    renderHeader();
    return true;
  } catch (e) {
    report(e);
    return false;
  }
}
async function transcribe() {
  if (ui.busy) return;
  if (!native())
    return toast("Local transcription runs in the installed desktop app.");
  if (!project()?.source.path) return chooseAudio();
  if (!prefs.whisper || !prefs.ffmpeg || !prefs.model) {
    showSettings();
    return toast("Choose whisper-cli, FFmpeg, and a Whisper model.");
  }
  cancelText();
  const options = subtitleOptions(
      project().subtitleOptions || prefs.subtitleOptions,
    ),
    original = project(),
    reference =
      original.useScript === false
        ? null
        : original.referenceInput || original.availableScript;
  ui.busy = true;
  ui.cancelRequested = false;
  ui.jobId = uid();
  ui.progress = "Starting local Whisper…";
  ui.percent = null;
  renderHeader();
  renderInspector();
  refreshDocumentHeader();
  try {
    let reply = await invoke("transcribe", {
      path: audioPath(original),
      ffmpeg: prefs.ffmpeg,
      whisper: prefs.whisper,
      model: prefs.model,
      language: prefs.language,
      threads: prefs.threads,
      jobId: ui.jobId,
      prompt:reference?reference.words.slice(0,60).map(w=>w.text).join(' '):'',
      pauseSeconds: options.pauseSeconds,
    });
    if (ui.cancelRequested) throw "Cancelled";
    if(project()?.id!==original.id)throw Error("The active project changed; recognition was not applied.");
    let quality=recognitionQuality(reply.transcript,reference,reply.source.duration);
    if(quality.suspicious){ui.progress='Checking recognition against the original recording…';renderHeader();const retry=await invoke('transcribe',{path:audioPath(original),ffmpeg:prefs.ffmpeg,whisper:prefs.whisper,model:prefs.model,language:prefs.language,threads:prefs.threads,jobId:ui.jobId,prompt:'',pauseSeconds:options.pauseSeconds});const nextQuality=recognitionQuality(retry.transcript,reference,retry.source.duration);if(nextQuality.score>=quality.score){reply=retry;quality=nextQuality;}}
    if(quality.overflow)throw Error('Recognition extends beyond the recording. The previous transcript and shared timing were kept. Try an explicit language or another model.');
    if(quality.suspicious&&quality.coverage<.7&&original.cues.length)throw Error('Recognition omitted too much reference text. Your previous transcript and timings were kept.');
    let next = parseWhisper(reply.transcript, {
      ...original.source,
      ...reply.source,
      path:original.source.path,embeddedPath:original.source.embeddedPath,
      previewPath: original.source.previewPath,
    });
    next.subtitleOptions = options;
    next.chapters = clone(original.chapters || []);
    if (original.studioLink) next.studioLink = clone(original.studioLink);
    if (original.availableScript)
      next.availableScript = clone(original.availableScript);
    if (original.referenceInput)
      next.referenceInput = clone(original.referenceInput);
    next.id=original.id;next.name=original.name;if(original.privateFile)next.privateFile=original.privateFile;
    if(original.cues.length)next.previousTranscription={updatedAt:original.updatedAt,cues:clone(original.cues),sourceWords:clone(original.sourceWords||[])};
    if(quality.suspicious)next.workflowWarnings=['Recognition needs review against the recording; the script was not forced onto missing speech.'];
    if (reference) {
      try {
        matchScript(next, reference);
      } catch (e) {
        next.workflowWarnings = [String(e.message || e)];
      }
    }
    if (options.speakers === 1)
      for (const c of next.cues)
        for (const w of c.words) w.speaker = "Speaker 1";
    if(ui.matchReference)next=retimeImported(referenceProject(original,ui.matchReference),next);
    if(!ui.matchReference||!ui.matchKeepsDivision)resegment(next, options);
    next.timingAlignmentPending=true;
    if (prefs.whisperxPython) {
      ui.progress = "Improving word timing…";
      ui.percent = null;
      renderHeader();
      try {
        const request = alignmentRequest(next, "auto", prefs.threads);
        request.mixedLanguages = options.mixedLanguages;
        request.speakers = options.speakers;
        const aligned = await invoke("align_words", {
          python: prefs.whisperxPython,
          ffmpeg: prefs.ffmpeg,
          path: audioPath(next),
          request,
          jobId: ui.jobId,
          probe: false,
          hfToken: ui.hfToken || null,
        });
        if (ui.cancelRequested) throw "Cancelled";
        const summary=applyAlignment(next, aligned);alignedTiming(next,summary.unresolved);
        if (aligned.warnings?.length)
          next.workflowWarnings = [
            ...(next.workflowWarnings || []),
            ...aligned.warnings,
          ];
      } catch (e) {
        if (String(e) === "Cancelled") throw e;
        next.workflowWarnings = [
          ...(next.workflowWarnings || []),
          "WhisperX could not finish; recognition timings were kept. " +
            String(e.message || e),
        ];
      }
    }
    if(!prefs.whisperxPython)next.workflowWarnings=[...(next.workflowWarnings||[]),'Word timing improvement is not set up. Recognition timings were kept. Configure WhisperX and use Retry word timing.'];
    attachPauses(next, reply.pauses || [], options.pauseSeconds);
    if (reference && next.chapters.some(c => c.timeMode === 'matched')) {
      const check = clone(next);
      try { const matched=matchScript(check,reference,{correct:false});refreshChapterTimes(next,matched); }
      catch { refreshChapterTimes(next); }
    }

    next.diagnostics = timingDiagnostics(next);
    if(project()?.id!==original.id)throw Error('The active project changed; this result was not applied.');
    next.filePath=original.filePath;delete next.timingsNeedMatch;delete next.timingsCleared;
    await openProject(next);
    await save();
    toast(
      next.workflowWarnings?.length
        ? "Transcript ready. Open Timing report for the remaining checks."
        : "Transcript ready.",
    );
  } catch (e) {
    if (String(e) === "Cancelled")
      toast("Transcription cancelled. Your existing transcript is preserved.");
    else
      modal(
        `<header><h2>Transcription could not finish</h2><button data-action="close-modal" aria-label="Close error">×</button></header><p>Your existing transcript is preserved.</p><details><summary>Engine details</summary><pre class="engine-error">${esc(String(e))}</pre></details><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="settings">Settings</button></footer>`,
      );
  } finally {
    ui.busy = false;
    ui.jobId = null;
    renderHeader();
    renderInspector();
    refreshDocumentHeader();
    studio.schedule();
  }
}

function modal(html) {
  $("#dialogs").innerHTML =
    `<div class="modal-backdrop"><section role="dialog" aria-modal="true" class="modal">${html}</section></div>`;
  $("#dialogs").querySelector("input,button,select")?.focus();
}
function closeModal() {
  $("#dialogs").innerHTML = "";
  delete ui.exportProjectId;
  delete ui.chapterDrafts;
}
function showSettings() {
  modal(
    `<header><h2>Settings</h2><button data-action="close-modal" aria-label="Close settings">×</button></header><div class="settings-tabs" role="tablist"><button role="tab" aria-selected="true" data-settings-tab="general">General</button><button role="tab" aria-selected="false" data-settings-tab="models">Transcription Models</button></div><section data-settings-panel="general"><label class="field-label">Theme<select id="theme"><option value="dark" ${prefs.theme !== "light" ? "selected" : ""}>Dark</option><option value="light" ${prefs.theme === "light" ? "selected" : ""}>Light</option></select></label><label class="field-label">Standalone save folder<span id="transcript-directory">${esc(prefs.transcriptDirectory||"Desktop/Subtitler")}</span><button data-action="choose-transcript-directory">Change save folder…</button></label><label class="field-label">Storyboard project<span class="small" id="folder-path">${esc(project()?.studioLink?.directory || "Not connected")}</span><button class="secondary" data-action="project-folder">${project()?.studioLink?.directory ? "Relink project folder" : "Choose project folder"}</button></label><p id="folder-status" class="small">${esc(studio.status().text)}</p><button class="secondary" data-action="shortcuts">Shortcuts</button><section id="shortcuts-list" hidden><dl><dt>Space</dt><dd>Play / pause</dd><dt>Enter in subtitle text</dt><dd>Save text · Shift+Enter adds a line</dd><dt>Escape / Cancel / click outside text</dt><dd>Discard the current text edit</dd><dt>Enter / leave timing fields</dt><dd>Save timing</dd><dt>⌘/Ctrl Z · ⇧⌘/Ctrl Z</dt><dd>Undo · Redo</dd><dt>⌘/Ctrl K · ⌘/Ctrl M</dt><dd>Split · Merge</dd><dt>⌘/Ctrl S</dt><dd>Save project</dd><dt>Shift-click subtitle numbers</dt><dd>Select adjacent subtitles</dd></dl></section></section><section data-settings-panel="models" hidden><p id="tool-message" role="status">${esc(ui.toolMessage)}</p>${[
      ["whisper", "whisper-cli"],
      ["ffmpeg", "FFmpeg"],
      ["model", "Whisper model (.bin)"],
      ["whisperxPython", "WhisperX Python (optional)"],
    ]
      .map(
        ([key, label]) =>
          `<label class="field-label">${label}<div class="path-input"><input id="tool-${key}" value="${esc(prefs[key])}"><button data-browse="${key}">Browse</button></div></label>`,
      )
      .join(
        "",
      )}<button class="secondary" data-action="check-whisperx">Check WhisperX</button><label class="field-label">CPU threads<input id="threads" type="number" min="1" max="16" value="${prefs.threads}"></label><button class="secondary" data-action="rediscover">Find shared tools</button></section><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="save-settings">Save settings</button></footer>`,
  );
}
function showOptions() {
  const o = subtitleOptions(
      project()?.subtitleOptions || prefs.subtitleOptions,
    ),
    ref = project()?.referenceInput || project()?.availableScript;
  modal(
    `<header><h2>Transcription options</h2><button data-action="close-modal" aria-label="Close options">×</button></header><div class="options-grid">${[
      ["minWords", "Minimum words", 1, 100, 1],
      ["maxWords", "Maximum words", 1, 100, 1],
      ["maxChars", "Characters per line", 8, 120, 1],
      ["maxSeconds", "Maximum seconds", 1, 30, 0.5],
      ["pauseSeconds", "Label silence longer than (seconds)", 0.1, 10, 0.1],
      ["speakers", "Speakers (0 = detect)", 0, 20, 1],
    ]
      .map(
        ([k, label, min, max, step]) =>
          `<label class="field-label">${label}<input id="opt-${k}" type="number" min="${min}" max="${max}" step="${step}" value="${o[k]}"></label>`,
      )
      .join(
        "",
      )}<label class="field-label">Lines per subtitle<select id="opt-lines"><option value="1" ${o.lines === 1 ? "selected" : ""}>1</option><option value="2" ${o.lines === 2 ? "selected" : ""}>2</option></select></label></div><p class="small">Transcribe and Match timings finish with WhisperX word alignment when configured.</p><label class="check-label"><input id="opt-mixedLanguages" type="checkbox" ${o.mixedLanguages ? "checked" : ""}> Automatic English / Japanese alignment switching</label><details><summary>Speaker model access</summary><p>More than one speaker uses the free pyannote model through WhisperX. First accept its terms on Hugging Face and provide a read token, or use an existing Hugging Face login. One speaker skips detection.</p><label class="field-label">Hugging Face token (this session only)<input type="password" id="hf-token" autocomplete="off" value="${esc(ui.hfToken || "")}"></label><a href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">Speaker model terms</a></details><section class="script-reference"><strong>Reference text</strong><p>${ref ? esc(ref.projectName || ref.chapters.map((c) => c.title).join(" · ") || "Imported text") + " · " + ref.words.length + " words" : "No reference text"}</p><button class="secondary" data-action="choose-script">Import reference text</button>${project()?.availableScript ? '<button class="secondary" data-action="use-project-script">Use project text</button>' : ""}${ref ? '<button class="secondary" data-action="remove-script">Remove reference</button>' : ""}<label class="check-label"><input id="opt-useScript" type="checkbox" ${ref && project()?.useScript !== false ? "checked" : ""}> Use reference text for recognition</label></section><p class="small">Minimum words is a preference. Silence, speaker changes and maximum limits take priority. An unusually long word stays intact.</p><footer><button class="secondary" data-action="save-options">Save options</button><button class="primary" data-action="apply-layout" ${project()?.cues.length ? "" : "disabled"}>Apply division to current subtitles</button></footer>`,
  );
}
function readOptions() {
  const out = {};
  for (const k of [
    "minWords",
    "maxWords",
    "maxChars",
    "maxSeconds",
    "pauseSeconds",
    "speakers",
    "lines",
  ])
    out[k] = Number($("#opt-" + k).value);
  out.autoAlign=true;
  for (const k of ["mixedLanguages"])
    out[k] = $("#opt-" + k).checked;
  prefs.subtitleOptions = subtitleOptions(out);
  if (project()) {
    project().subtitleOptions = clone(prefs.subtitleOptions);
    project().useScript = !!$("#opt-useScript")?.checked;
  }
  ui.hfToken = $("#hf-token")?.value.trim() || "";
  preferences();
  save();
  return out;
}
async function importAny(input) {
  const fileName=typeof input==='string'?input:input.name;
  if(/\.(subtitler|whisperdesk)$/i.test(fileName))return typeof input==='string'?openDocumentFile(input):readInput(input);
  const name = typeof input === "string" ? input : input.name;
  if (/\.(wav|mp3|m4a|aac|flac|ogg|aiff?|opus|wma)$/i.test(name))
    return audioInput(input);
  if (/\.(txt|docx)$/i.test(name)) return importScript(input);
  return readInput(input);
}
async function importScript(input) {
  const isPath = typeof input === "string",
    name = isPath ? input : input.name;
  let parsed;
  if (/\.docx$/i.test(name)) {
    const data = isPath
      ? Uint8Array.from(
          atob(await invoke("read_script_document", { path: input })),
          (c) => c.charCodeAt(0),
        )
      : await input.arrayBuffer();
    parsed = await docxScript(data);
  } else
    parsed = parseScript(
      isPath
        ? await invoke("read_transcript", { path: input })
        : await input.text(),
    );
  commit('Import reference text',p=>{p.referenceInput=parsed;p.useScript=true;adoptReferenceChapters(p,parsed);});
  toast("Reference text selected.");
  if ($("#opt-maxWords")) showOptions();
}
function cancelText() {
  const c = selectedCue();
  if (!c || !Object.prototype.hasOwnProperty.call(ui.drafts, c.id)) return;
  delete ui.drafts[c.id];
  project().drafts = {};
  const el = $("#subtitle-text");
  if (el) el.value = cueText(c);
  growTextarea();
}
function persistTiming(kind) {
  const c = selectedCue(),
    w = selectedWord();
  if (!c || ui.busy) return;
  try {
    if (kind === "word" && !w) return;
    const a = seconds($(kind === "word" ? "#word-start" : "#cue-start").value),
      b = seconds($(kind === "word" ? "#word-end" : "#cue-end").value),
      target = kind === "word" ? w : c;
    if (a === target.start && b === target.end) return;
    history.change(
      kind === "word" ? "Adjust word timing" : "Adjust subtitle timing",
      (p) => {
        if (kind === "word") {
          const i = c.words.indexOf(w);
          if (
            a < c.start ||
            b > c.end ||
            a >= b ||
            (i && a < c.words[i - 1].end) ||
            (i < c.words.length - 1 && b > c.words[i + 1].start)
          )
            throw Error("Keep the word between its neighbors.");
          Object.assign(w, { start: a, end: b, timing: "manual" });
          delete w.alignmentIssue;
        } else retimeCue(p, c.id, a, b);
      },
    );
    save();
    const badge = document.querySelector(
      `[data-cue-time="${CSS.escape(c.id)}"]`,
    );
    if (badge)
      badge.innerHTML = clock(c.start) + " <span>→ " + clock(c.end) + "</span>";
    updatePlayback(false);
  } catch (e) {
    report(e);
    const a = kind === "word" ? w : c;
    $(kind === "word" ? "#word-start" : "#cue-start").value = clock(a.start);
    $(kind === "word" ? "#word-end" : "#cue-end").value = clock(a.end);
  }
}

function showAlignment() {
  if (ui.busy || !project()?.cues.length) return;
  if (!native())
    return toast("WhisperX alignment runs in the installed desktop app.");
  if (!prefs.whisperxPython || !prefs.ffmpeg) {
    showSettings();
    return toast("Set up WhisperX Python and FFmpeg in Settings first.");
  }
  if (!applyDrafts()) return;
  const lang = ["en", "pt", "es", "ja"].includes(project().language)
    ? project().language
    : prefs.language;
  modal(
    `<header><h2>Improve word timing</h2><button data-action="close-modal" aria-label="Close alignment">×</button></header><p>Align the current transcript to your recording with WhisperX. This process won’t affect your current subtitle text or division. One Undo restores the previous timings.</p><label class="field-label">Recording language<select id="align-language"><option value="auto">Automatic / mixed language</option>${[
      ["en", "English"],
      ["pt", "Português"],
      ["es", "Español"],
      ["ja", "日本語"],
    ]
      .map(
        ([id, label]) =>
          `<option value="${id}" ${id === lang ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="check-label"><input type="checkbox" id="align-manual"> Replace manually adjusted timing too</label><p class="small">Correct transcript errors first for more accurate word timing.</p><footer><button class="secondary" data-action="close-modal">Cancel</button><button class="primary" data-action="run-alignment">Improve timing</button></footer>`,
  );
}
function showAlignmentReport() {
  const p = project(),
    a = p?.recognition?.alignment,
    d = p ? timingDiagnostics(p) : null;
  if (!p) return;
  modal(
    `<header><h2>Word timing report</h2><button data-action="close-modal" aria-label="Close report">×</button></header>${a ? `<p>${a.aligned} aligned · ${a.unresolved} kept previous timing · ${a.protectedWords} manual timings protected.</p>` : ""}<p>${d.words} words · ${d.estimated} estimated · ${d.veryShort.length} shorter than 60 ms.</p>${(p.workflowWarnings || []).map((w) => `<p>${esc(w)}</p>`).join("")}${p.scriptReference ? `<p>Reference text: ${p.scriptReference.matched}/${p.scriptReference.referenceWords} matched. Additions and omissions follow the recording.</p><details><summary>Reference differences</summary>${p.scriptReference.changes.map((c) => `<p>${esc(c.kind)}: ${esc(c.recognized || c.script)}</p>`).join("")}</details>` : ""}<div class="alignment-issues">${p.cues
      .filter((c) =>
        c.words.some((w) => w.alignmentIssue || d.veryShort.includes(w.id)),
      )
      .map(
        (c) =>
          `<button data-review-cue="${esc(c.id)}">${String(p.cues.indexOf(c) + 1).padStart(2, "0")} · ${esc(cueText(c).slice(0, 100))}</button>`,
      )
      .join("")}</div>`,
  );
}

async function runAlignment(probe, automatic = false) {
  if (ui.busy || !native()) return;
  const python = probe
    ? $("#tool-whisperxPython")?.value.trim()
    : prefs.whisperxPython;
  if (!python)
    return toast(
      "Run the WhisperX setup command, then choose its Python in Settings.",
    );
  const original = project(),
    request = probe
      ? {}
      : alignmentRequest(
          original,
          automatic
            ? original.alignmentLanguage || "auto"
            : $("#align-language").value,
          prefs.threads,
        ),
    replaceManual = !automatic && !!$("#align-manual")?.checked;
  request.mixedLanguages = project()?.subtitleOptions?.mixedLanguages !== false;

  const fingerprint = JSON.stringify(original.cues);
  const sourceFingerprint=original.source.fingerprint;
  if (!probe) closeModal();
  ui.busy = true;
  ui.cancelRequested = false;
  ui.jobId = uid();
  ui.percent = null;
  ui.progress = probe ? "Checking WhisperX…" : "Preparing alignment…";
  $("#audio").pause();
  renderHeader();
  renderInspector();
  refreshDocumentHeader();
  try {
    const reply = await invoke("align_words", {
      python,
      ffmpeg: prefs.ffmpeg,
      path: audioPath(original) || "",
      request,
      jobId: ui.jobId,
      probe,
      hfToken: ui.hfToken || null,
    });
    if (ui.cancelRequested) throw "Cancelled";
    if (probe) {
      toast(`WhisperX ${reply.version} is ready (CPU).`);
      return;
    }
    if (
      project()?.id !== original.id ||
      JSON.stringify(project().cues) !== fingerprint || project().source.fingerprint!==sourceFingerprint
    )
      throw Error("The transcript changed during alignment. Run it again.");
    let summary;
    history.change("Improve word timing", (p) => {
      summary = applyAlignment(p, reply, { replaceManual });alignedTiming(p,summary.unresolved);refreshChapterTimes(p);
      delete p.timingsNeedMatch;delete p.timingsCleared;
    });
    await save();
    renderContent();
    showAlignmentReport();
    return !summary.unresolved;
  } catch (e) {
    if (String(e) === "Cancelled")
      toast("Alignment cancelled. Previous timings are preserved.");
    else
      modal(
        `<header><h2>WhisperX could not finish</h2><button data-action="close-modal" aria-label="Close error">×</button></header><p>Previous timings are preserved. Check the Python environment, recording language and network connection for the first model download.</p><details><summary>Engine details</summary><pre class="engine-error">${esc(String(e))}</pre></details><footer><button class="secondary" data-action="close-modal">Close</button><button class="primary" data-action="settings">Settings</button></footer>`,
      );
  } finally {
    ui.busy = false;
    ui.jobId = null;
    renderHeader();
    renderInspector();
    refreshDocumentHeader();
  }
}
function adoptReferenceChapters(p,reference) {
  installReferenceChapters(p,reference);
  if (p.cues.length && p.chapters.some(c=>c.timeMode==='matched')) {
    try { const check=clone(p);const matched=matchScript(check,reference,{correct:false});refreshChapterTimes(p,matched); }
    catch { refreshChapterTimes(p); }
  }
}
function captureChapterDrafts() {
  $('#chapter-list')?.querySelectorAll('[data-chapter-row]').forEach((row,index) => {
    const draft=ui.chapterDrafts[index];
    draft.title=row.querySelector('[data-chapter-title]').value;
    draft.timeText=row.querySelector('[data-chapter-time]').value;
    draft.level=Number(row.querySelector('[data-chapter-level]').value);
  });
}
function chapterDraftValues() {
  captureChapterDrafts();
  const duration=project().source.duration || 0;
  const result=ui.chapterDrafts.map(draft => {
    const chapter=clone(draft), start=chapterSeconds(chapter.timeText);
    delete chapter.timeText;
    chapter.title=chapter.title.trim();
    if (!chapter.title) throw Error('Give every chapter a name, or remove its row.');
    if (start != null && duration && start > duration + .001) throw Error(`“${chapter.title}” starts after the recording ends.`);
    if (start !== chapter.start || chapter.needsReview) { chapter.timeMode='manual';chapter.anchorWordId=null; }
    chapter.start=start;delete chapter.needsReview;
    return chapter;
  });
  validateProject({...project(),chapters:result});
  return result;
}
function showChapters(resume = false) {
  if (!resume) ui.chapterDrafts=clone(project().chapters || []).map(c=>({...c,timeText:c.start == null ? '' : clock(c.start)}));
  modal(`<header><h2>Chapters</h2><button data-action="close-modal" aria-label="Close chapters">×</button></header><p>Optional chapter markers. Enter a name and start time. Your recording stays unchanged.</p><div id="chapter-list">${ui.chapterDrafts.map((c,i)=>`<section class="chapter-row" data-chapter-row="${i}"><label class="field-label">Name<input data-chapter-title maxlength="200" aria-label="Chapter ${i+1} name" value="${esc(c.title)}"></label><label class="field-label">Start time<input data-chapter-time inputmode="decimal" aria-label="Chapter ${i+1} start time" placeholder="Not placed" value="${esc(c.timeText)}"></label><label class="field-label">Heading<select data-chapter-level aria-label="Chapter ${i+1} heading">${Array.from({length:6},(_,n)=>`<option value="${n+1}" ${c.level===n+1?'selected':''}>${n===0?'Chapter':n===1?'Subchapter':'Heading '+(n+1)}</option>`).join('')}</select></label><button class="chapter-remove" data-action="chapter-remove" data-index="${i}" aria-label="Remove chapter ${i+1}">×</button><small>${c.needsReview?'Recording changed — review this time.':c.timeText?(c.timeMode==='matched'?'Matched to speech':'Manual timestamp'):'Not placed — match the reference or enter a time.'}</small></section>`).join('') || '<p class="small">No chapters yet. Use ＋ to add one, or import reference text with Word headings.</p>'}</div><p id="chapter-error" role="status" aria-live="polite"></p><footer><button class="secondary" data-action="chapter-add" aria-label="Add chapter">＋</button>${referenceOf(project())?.chapters?.some(c=>c.isHeading)&&project().cues.length?'<button class="secondary" data-action="chapter-match">Match imported headings</button>':''}<button class="primary" data-action="save-chapters">Save chapters</button></footer>`);
}
function chapterError(fn) { try { fn(); } catch(error) { $('#chapter-error').textContent=error.message || String(error); } }
function matchChapterDrafts() {
  const p=clone(project());p.chapters=chapterDraftValues();
  const matched=matchScript(p,referenceOf(p),{correct:false});
  if (matched.matched < Math.max(1,referenceOf(p).words.length*.65)) throw Error('Not enough reference text matched the transcript. Match timings first or enter chapter times manually.');
  ui.chapterDrafts=p.chapters.map(c=>({...c,timeText:c.start == null?'':clock(c.start)}));
  showChapters(true);
}
function showExport(target = project()) {
  if (ui.exporting) return;
  if (!target) return;
  if (target.id === project()?.id && !applyDrafts()) return;
  ui.exportProjectId = target.id;
  modal(
    `<header><h2>Export transcript</h2><button data-action="close-modal" aria-label="Close export">×</button></header><p>Export your edited subtitles. Timing JSON retains word timings and original recognition for Storyboard Studio.</p>${placedChapters(target).length < (target.chapters || []).length?'<p class="chapter-warning">Some chapters need a valid start time or review. Only placed chapters appear in DOCX and TXT; all chapter entries stay in your editable project.</p>':''}<div class="export-grid">${[
      ["docx", "Word document"],
      ["txt", "Plain text"],
      ["srt", "Subtitles"],
      ["csv", "Subtitle table"],
      ["xlsx", "Subtitles + words"],
      ["json", "Timing for Storyboard Studio"],
      ["subtitler", "Editable Subtitler project"],
    ]
      .map(
        ([format, label]) =>
          `<button data-export="${format}"><strong>.${format}</strong><span>${label}</span></button>`,
      )
      .join(
        "",
      )}</div><label class="check-label"><input id="export-timestamps" type="checkbox"> Include timestamps in DOCX / TXT</label><p id="export-status" class="small" role="status" aria-live="polite"></p><p class="small">The editable .subtitler export is an independent copy, including its available audio. Other formats contain text and timing.</p>`,
  );
}
async function download(format) {
  if (ui.exporting) return;
  const targetId = ui.exportProjectId || project()?.id;
  if (targetId === project()?.id && !applyDrafts()) return;
  const current = project()?.id === targetId ? project() : projects.find(p => p.id === targetId);
  if (!current) throw Error('Open a transcript before exporting.');
  // Export an immutable snapshot of the latest applied edits, not a stale list entry.
  const target = clone(current);
  const timestamps = !!$("#export-timestamps")?.checked;
  const status = $("#export-status");
  const buttons = [...document.querySelectorAll('[data-export], #export-timestamps')];
  ui.exporting = true;
  buttons.forEach(button => { button.disabled = true; });
  if (status) status.textContent = 'Preparing export…';
  try {
  if(format==='subtitler'&&native()){
    const path=await invoke('choose_document_save',{name:target.name});
    if(!path){if(status)status.textContent='Export cancelled. Choose a format to try again.';return;}
    const copy=standalone(target);copy.filePath=path;
    await invoke('write_document',{path,data:JSON.stringify(copy)});
    toast('Subtitler project exported with its available audio.');closeModal();return;
  }
  const output = await makeExport(target, format, {
      timestamps,
    }),
    blob = new Blob([output.data], { type: output.mime });
  if (native()) {
    const data = await new Promise((r, j) => {
      const f = new FileReader();
      f.onload = () => r(String(f.result).split(",")[1]);
      f.onerror = j;
      f.readAsDataURL(blob);
    });
    if (target.studioLink?.directory && format!=="subtitler") {
      await invoke("write_subtitler_export", {
        directory: target.studioLink.directory,
        studioProjectId: target.studioLink.projectId || null,
        projectId: target.id,
        filename: output.name,
        data,
      });
      toast("Saved in your chosen project folder.");
    } else {
      if (!await invoke("save_export", { filename: output.name, data })) {
        if (status) status.textContent = 'Export cancelled. Choose a format to try again.';
        return;
      }
      toast("Export saved.");
    }
  } else {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = output.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  closeModal();
  } catch (error) {
    if (status) status.textContent = 'Could not export: ' + (error.message || String(error));
    else report(error);
  } finally {
    ui.exporting = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}
function splitAt(cueId, wordId) {
  if (ui.busy) return;
  if (!applyDrafts()) return;
  commit("Split subtitle", (p) => {
    const next = splitCue(p, cueId, wordId);
    ui.selected = [next.id];
    ui.anchor = next.id;
    ui.wordId = next.words[0]?.id;
  });
}
function mergeAfter(id) {
  if (ui.busy) return;
  if (!applyDrafts()) return;
  const cues = project().cues,
    i = cues.findIndex((c) => c.id === id);
  if (i < 0 || !cues[i + 1]) return;
  let ids =
    ui.selected.length > 1 && ui.selected.includes(id)
      ? ui.selected
      : [id, cues[i + 1].id];
  commit("Merge subtitles", (p) => {
    const merged = mergeCues(p, ids);
    ui.selected = [merged.id];
    ui.anchor = merged.id;
    ui.wordId = null;
  });
}
function deleteCues(ids) {
  if (ui.busy) return;
  const previous = ui.drafts;
  ui.drafts = Object.fromEntries(
    Object.entries(previous).filter(([id]) => !ids.includes(id)),
  );
  if (!applyDrafts()) {
    ui.drafts = previous;
    return;
  }
  const index = project().cues.findIndex((c) => ids.includes(c.id));
  commit("Delete subtitles", (p) => {
    p.cues = p.cues.filter((c) => !ids.includes(c.id));
    for (const id of ids) delete ui.drafts[id];
    const next = p.cues[Math.min(Math.max(index, 0), p.cues.length - 1)];
    ui.selected = next ? [next.id] : [];
    ui.anchor = next?.id;
    ui.wordId = null;
  });
}
let context = null;
function closeContext() {
  $("#context-menu")?.remove();
  context = null;
}
function contextMenu(kind, id, x, y) {
  closeContext();
  if(kind!=="cue")return;
  context = { kind, id };
  const el = document.createElement("div");
  el.id = "context-menu";
  el.role = "menu";
  el.innerHTML =
    (kind === "cue"
      ? '<button role="menuitem" data-action="context-language">Alignment language…</button>'
      : "") +
    `<button role="menuitem" data-action="context-delete">Delete${kind === "cue" && ui.selected.includes(id) && ui.selected.length > 1 ? " selected subtitles" : ""}</button>`;
  document.body.append(el);
  el.style.left =
    Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top =
    Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + "px";
  el.querySelector("button").focus();
}
async function discover(explicit = false) {
  if (!native()) {
    if (explicit) toast("Tool locations are set in the desktop app.");
    return;
  }
  if (ui.detectingTools) return;
  const before = {
    whisper: prefs.whisper,
    ffmpeg: prefs.ffmpeg,
    model: prefs.model,
    whisperxPython: prefs.whisperxPython,
  };
  ui.detectingTools = true;
  const message = $("#tool-message");
  if (message) message.textContent = "Finding shared tools…";
  try {
    const discovered = await startupDeadline(
      invoke("discover_tools"),
      "Auto-detection did not finish. Existing paths are unchanged.",
      5000,
    );
    tools = {
      ...discovered,
      models: Array.isArray(discovered?.models) ? discovered.models : [],
    };
    for (const key of ["whisper", "ffmpeg", "whisperxPython"])
      if (!prefs[key] && prefs[key] === before[key])
        prefs[key] = tools[key] || "";
    if (!prefs.model && prefs.model === before.model)
      prefs.model =
        tools.models.find((m) => m.path.includes("turbo"))?.path ||
        tools.models[0]?.path ||
        "";
    if (explicit) {
      for (const key of ["whisper", "ffmpeg", "model", "whisperxPython"]) {
        const el = $("#tool-" + key);
        if (el && !el.value.trim()) {
          el.value =
            key === "model"
              ? tools.models.find((m) => m.path.includes("turbo"))?.path ||
                tools.models[0]?.path ||
                ""
              : tools[key] || "";
        }
      }
    }
    ui.toolMessage = "";
    preferences();
  } catch (e) {
    console.warn("Tool discovery:", e);
    ui.toolMessage = explicit
      ? e.message
      : "Auto-detection is unavailable. Configured paths are preserved.";
  } finally {
    ui.detectingTools = false;
    const el = $("#tool-message");
    if (el) el.textContent = ui.toolMessage;
    renderHeader();
  }
}
async function openDocumentFile(path,here=false){
  if(native()&&!here)return invoke('new_document_window',{path,request:null});
  if(native()){
    const opened=await invoke('open_document',{path});
    if(!(await invoke('claim_document',{path:opened.path})))return;
    const next=openedDocument(opened.data,opened.path);if(opened.audioPath)next.source.embeddedPath=opened.audioPath;if(opened.audioWarning)toast(opened.audioWarning);
    if(next.id===opened.data.id)lastSavedKey.set(next.id,contentKey(opened.data));
    await openProject(next);
    const at=projects.findIndex(p=>p.id===next.id);at<0?projects.unshift(clone(next)):projects[at]=clone(next);await db.save(next);
    await save();return;
  }
  return readInput(path);
}
function showRecent(){
  const paths=new Map();for(const p of projects.slice().sort((a,b)=>String(b.lastOpenedAt||b.updatedAt).localeCompare(String(a.lastOpenedAt||a.updatedAt)))){const path=p.filePath||p.studioLink?.projectFile||p.privateFile||p.openedFile;if(path&&!paths.has(path))paths.set(path,p);}
  modal(`<header><h2>Open Recent</h2><button data-action="close-modal">×</button></header><div class="recent-projects">${[...paths].slice(0,30).map(([path,p])=>`<button data-recent-path="${esc(path)}">${esc(p.name)}<small>${esc(path)}</small></button>`).join('')||'No recent projects.'}</div>`);
}
function referenceText(ref) {
  return ref?.chapters?.some(c=>typeof c.text==='string') ? ref.chapters.map(c=>c.text || '').join('\n\n') : ref?.words?.map(w=>w.text).join(' ') || '';
}
function referencePanel(){
 const ref=project().useScript===false?null:project().referenceInput||project().availableScript;
 const text=referenceText(ref);
 modal(`<header><h2>Reference text</h2><button data-action="close-modal">×</button></header><textarea id="reference-input" placeholder="Paste reference text here…" aria-label="Reference text">${esc(text)}</textarea><footer><button class="secondary" data-action="import-reference">Import text…</button><button class="secondary" data-action="clear-reference">Clear</button><button class="primary" data-action="apply-reference">Save reference</button></footer>`);
}
async function importReference(){
 if(native()){const file=await invoke('pick_file',{kind:'script'});if(file){closeModal();await importScript(file);}}else $('#script-file').click();
}
async function matchTimings(){
 const p=project();if(!canMatch(p))return;ui.matchReference=referenceOf(p);ui.matchKeepsDivision=p.cues.length&&spokenKey(p)===spokenKey({cues:[{words:ui.matchReference.words}]});try{await transcribe();}finally{ui.matchReference=null;ui.matchKeepsDivision=false;}
}
async function handleStudioRequest(r,here=false){
 if(!here&&(project()?.source.name||project()?.cues.length||project()?.referenceInput))return invoke('new_document_window',{path:null,request:r});
 const info={...r.workspace,projectId:r.projectId,activeRecording:r.activeRecording||r.workspace?.activeRecording};
 const ok=await openWorkspace(info,{audioPath:info.activeRecording?.path||null,match:true,explicit:true});
 if(ok){prefs.lastStudioRequestId=r.requestId;preferences();}return ok;
}
const actions = {
  'new-project':()=>native()?invoke('new_document_window',{path:null,request:null}):window.open(location.href,'_blank'),
  'open-project':async()=>{const file=await invoke('pick_file',{kind:'project'});if(file)await openDocumentFile(file);},
  'import-audio':()=>chooseAudio(true),
  'import-reference':importReference,
  'import-subtitles':async()=>{if(native()){const file=await invoke('pick_file',{kind:'subtitles'});if(file)await readInput(file);}else $('#transcript-file').click();},
  'reference-text':referencePanel,
  'chapters':()=>showChapters(),
  'chapter-add':()=>{captureChapterDrafts();const time=$('#audio').currentTime || 0;ui.chapterDrafts.push({id:uid(),title:'',level:1,start:time,timeText:clock(time),timeMode:'manual',origin:'manual'});showChapters(true);$('#chapter-list [data-chapter-row]:last-child input')?.focus();},
  'chapter-remove':button=>{captureChapterDrafts();ui.chapterDrafts.splice(Number(button.dataset.index),1);showChapters(true);},
  'chapter-match':()=>chapterError(matchChapterDrafts),
  'save-chapters':()=>chapterError(()=>{const chapters=chapterDraftValues();commit('Edit chapters',p=>{p.chapters=chapters;});closeModal();wave.draw();}),
  'chapter-seek':button=>seek(Number(button.dataset.start)),
  'apply-reference':()=>{const text=$('#reference-input').value;if(text===referenceText(referenceOf(project()))){closeModal();return;}commit('Change reference text',p=>{if(text.trim()){p.referenceInput=parseScript(text);p.useScript=true;}else{delete p.referenceInput;p.useScript=false;}});closeModal();},
  'clear-reference':()=>{commit('Clear reference text',p=>{delete p.referenceInput;delete p.scriptReference;p.useScript=false;});referencePanel();},
  'clear-transcript':()=>{if(!project().cues.length)return;modal(`<header><h2>Clear transcript?</h2></header><p>Remove subtitles and timings from this project. Undo restores them. Audio and reference text stay.</p><footer><button data-action="close-modal">Cancel</button><button class="danger" data-action="confirm-clear-transcript">Clear</button></footer>`);},
  'confirm-clear-transcript':()=>{commit('Clear transcript',p=>{p.cues=[];p.sourceWords=[];p.pauses=[];p.timingsCleared=true;delete p.scriptReference;delete p.recognition;delete p.diagnostics;});closeModal();},
  'confirm-audio':async()=>{const input=ui.pendingAudio;delete ui.pendingAudio;closeModal();ui.audioConfirmed=true;await audioInput(input,true);},
  'confirm-subtitles':async()=>{const input=ui.pendingSubtitles;delete ui.pendingSubtitles;closeModal();ui.importConfirmed=true;await readInput(input);},
  'choose-transcript-directory':moveTranscriptFolder,
  'move-transcript-folder':moveTranscriptFolder,
  'audio-location':()=>{const source=project()?.source;modal(`<header><h2>Audio location</h2><button data-action="close-modal">×</button></header><p class="full-path">${esc(source?.path||'No audio attached')}</p><footer><button data-action="import-audio">Import audio…</button><button data-action="show-audio">Show in folder</button></footer>`);},
  'show-audio':()=>invoke('reveal_transcript_file',{path:project().source.path}),
  'save-as':saveAs,
  'close-project':closeProject,
  'match-timings':matchTimings,
  "workspace-recording":async(el)=>{const pending=pendingWorkspace;if(!pending)return;const audio=pending.info.audioCandidates[+el.dataset.index];closeModal();pendingWorkspace=null;await openWorkspace(pending.info,{audioPath:audio.path,match:pending.match});},
  relink: () => chooseAudio(true),
  import: async () => {
    if (ui.busy) return;
    if (native()) {
      const path = await invoke("pick_file", { kind: "import" });
      if (path) await importAny(path);
    } else $("#import-file").click();
  },
  transcribe,
  "play-pause":async()=>{
    const audio=$('#audio');if(!mediaUrl)return;
    if(ui.playRequested||!audio.paused){ui.playRequested=false;audio.pause();return;}
    const epoch=loadEpoch;ui.playRequested=true;
    try{await audio.play();if(!ui.playRequested||epoch!==loadEpoch)audio.pause();}catch(e){ui.playRequested=false;throw e;}
  },
  cancel: async () => {
    if (ui.jobId) {
      ui.cancelRequested = true;
      await invoke("cancel_transcription");
      ui.progress = "Cancelling…";
      renderHeader();
    }
  },
  settings: showSettings,
  "project-folder":async()=>{if(project()?.source.name||project()?.cues.length||project()?.referenceInput){const directory=await invoke("choose_project_folder");if(!directory)return;const info=await invoke("inspect_project_folder",{directory,expectedProjectId:null,audioRelativePath:null});return invoke("new_document_window",{path:null,request:{requestId:"manual-"+uid(),projectId:info.projectId,workspace:info,activeRecording:info.activeRecording}});}return studio.choose();},
  shortcuts: () => {
    $("#shortcuts-list").hidden = !$("#shortcuts-list").hidden;
  },
  "transcription-options": showOptions,
  "save-options": () => {
    readOptions();
    closeModal();
  },
  "apply-layout": () => {
    const options = readOptions();
    closeModal();
    commit("Change subtitle division", (p) => resegment(p, options));
  },
  "choose-script": async () => {
    readOptions();
    if (native()) {
      const path = await invoke("pick_file", { kind: "script" });
      if (path) await importScript(path);
    } else $("#script-file").click();
  },
  "use-project-script": () => {
    readOptions();
    project().referenceInput = clone(project().availableScript);
    project().useScript = true;
    adoptReferenceChapters(project(),project().referenceInput);
    save();
    showOptions();
  },
  "remove-script": () => {
    readOptions();
    delete project().referenceInput;
    project().useScript = false;
    save();
    showOptions();
  },
  "cancel-text": cancelText,
  "rename-speaker": () => {
    const name = $("#speaker-name").value.trim();
    if (!name) return;
    commit("Rename speaker", (p) => {
      p.speakerNames ||= {};
      p.speakerNames[ui.renameSpeaker] = name;
    });
    closeModal();
  },
  "context-language": () => {
    ui.languageCue = context?.id;
    closeContext();
    const c = project().cues.find((c) => c.id === ui.languageCue);
    if (!c) return;
    modal(
      `<header><h2>Alignment language</h2><button data-action="close-modal">×</button></header><label class="field-label">This subtitle<select id="cue-language">${[
        ["auto", "Automatic"],
        ["en", "English"],
        ["pt", "Português"],
        ["es", "Español"],
        ["ja", "日本語"],
      ]
        .map(
          ([v, t]) =>
            `<option value="${v}" ${v === (c.language || "auto") ? "selected" : ""}>${t}</option>`,
        )
        .join(
          "",
        )}</select></label><footer><button class="primary" data-action="save-cue-language">Save</button></footer>`,
    );
  },
  "save-cue-language": () => {
    const value = $("#cue-language").value;
    commit("Set alignment language", (p) => {
      const c = p.cues.find((c) => c.id === ui.languageCue);
      if (c) c.language = value;
    });
    closeModal();
  },

  "close-modal": closeModal,
  "save-settings": () => {
    for (const key of ["whisper", "ffmpeg", "model", "whisperxPython"])
      prefs[key] = $("#tool-" + key).value.trim();
    prefs.theme = $("#theme").value;
    document.documentElement.dataset.theme = prefs.theme;
    wave.draw();
    prefs.threads = Math.max(1, Math.min(16, +$("#threads").value || 6));
    ui.toolMessage = "";
    preferences();
    closeModal();
    renderHeader();
  },
  rediscover: () => discover(true),
  "improve-timing": showAlignment,
  "request-import-audio": async()=>{closeModal();await chooseAudio();},
  "run-alignment": () => runAlignment(false),
  "check-whisperx": () => runAlignment(true),
  "timing-report": showAlignmentReport,
  export: () => showExport(),
  "save-project":saveCurrent,
  "export-project":()=>{ui.exportProjectId=project().id;return download("subtitler");},
  "recent-projects":showRecent,
  "reveal-transcript":async()=>{const path=documentPath||project()?.studioLink?.projectFile;if(path&&native())await invoke('reveal_transcript_file',{path});else toast('Not saved yet.');},
  undo: () => {
    if (!history || ui.busy) return;
    const pending = Object.keys(ui.drafts).length;
    ui.drafts = {};
    if (pending) {
      project().drafts = {};
      save();
      renderContent();
      return;
    }
    history.back();
    ui.selected = ui.selected.filter((id) =>
      project().cues.some((c) => c.id === id),
    );
    if (!ui.selected.length && project().cues.length)
      ui.selected = [project().cues[0].id];
    save();
    renderContent();
    renderHeader();
  },
  redo: () => {
    if (!history || ui.busy) return;
    ui.drafts = {};
    history.forward();
    ui.selected = ui.selected.filter((id) =>
      project().cues.some((c) => c.id === id),
    );
    if (!ui.selected.length && project().cues.length)
      ui.selected = [project().cues[0].id];
    save();
    renderContent();
    renderHeader();
  },
  scissors: () => {
    ui.scissors = !ui.scissors;
    renderContent();
  },
  "apply-text": () => applyDrafts(),
  split: () => {
    if (!applyDrafts()) return;
    const c = selectedCue();
    if (!c) return;
    let word = selectedWord();
    if (!word)
      word = c.words.find((w, i) => i && w.start >= $("#audio").currentTime);
    if (!word) return toast("Choose the first word of the new subtitle.");
    splitAt(c.id, word.id);
  },
  merge: () => {
    const c = selectedCue();
    if (c) mergeAfter(ui.selected.length > 1 ? ui.selected[0] : c.id);
  },
  "context-delete": () => {
    const target = context;
    closeContext();
    if (!target) return;
    if (target.kind === "cue") {
      const ids = ui.selected.includes(target.id)
        ? [...ui.selected]
        : [target.id];
      deleteCues(ids);
    }
  },

};
document.addEventListener("click", async (e) => {
  try {
    const exportButton = e.target.closest("[data-export]");
    if (exportButton) {
      if (!exportButton.disabled) await download(exportButton.dataset.export);
      return;
    }
    const tab = e.target.closest("[data-settings-tab]");
    if (tab) {
      document
        .querySelectorAll("[data-settings-tab]")
        .forEach((b) => b.setAttribute("aria-selected", String(b === tab)));
      document
        .querySelectorAll("[data-settings-panel]")
        .forEach(
          (p) =>
            (p.hidden = p.dataset.settingsPanel !== tab.dataset.settingsTab),
        );
      return;
    }
    const action = e.target.closest("[data-action]");
    if (action) {
      await actions[action.dataset.action]?.(action);
      return;
    }
    const pause = e.target.closest("[data-seek-pause]");
    if (pause) {
      seek(Number(pause.dataset.seekPause));
      return;
    }
    const speaker = e.target.closest("[data-speaker]");
    if (speaker) {
      ui.renameSpeaker = speaker.dataset.speaker;
      modal(
        `<header><h2>Speaker name</h2><button data-action="close-modal">×</button></header><label class="field-label">Name<input id="speaker-name" value="${esc(project().speakerNames?.[ui.renameSpeaker] || ui.renameSpeaker)}"></label><footer><button class="primary" data-action="rename-speaker">Save</button></footer>`,
      );
      return;
    }
    const review = e.target.closest("[data-review-cue]");
    if (review) {
      closeModal();
      select(review.dataset.reviewCue);
      document
        .querySelector(
          `[data-cue-row="${CSS.escape(review.dataset.reviewCue)}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    const merge = e.target.closest("[data-merge-after]");
    if (merge) {
      mergeAfter(merge.dataset.mergeAfter);
      return;
    }

    const row = e.target.closest("[data-select-cue]");
    if (row) {
      select(row.dataset.selectCue, null, e.shiftKey);
      return;
    }
    const word = e.target.closest("[data-word]");
    if (word) {
      const selection = window.getSelection();
      if (
        selection?.toString() &&
        $("#transcript-list").contains(selection.anchorNode)
      )
        return;
      if (ui.scissors) {
        splitAt(word.dataset.cue, word.dataset.word);
        return;
      }
      select(word.dataset.cue, word.dataset.word, e.shiftKey);
      seek(selectedWord()?.start || 0);
      return;
    }
    const time = e.target.closest("[data-cue-time]");
    if (time) {
      const c = project().cues.find((c) => c.id === time.dataset.cueTime);
      select(c.id);
      seek(c.start);
      return;
    }

  } catch (err) {
    report(err);
  }
});
document.addEventListener("contextmenu", (e) => {
  const cue=e.target.closest("[data-cue-row]");
  if(!cue||ui.busy)return;
  e.preventDefault();
  contextMenu(
    "cue",
    cue.dataset.cueRow,
    e.clientX,
    e.clientY,
  );
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#context-menu")) closeContext();
});
document.addEventListener("pointerover", (e) => {
  document.querySelector(".cut-target")?.classList.remove("cut-target");
  if (ui.scissors) e.target.closest("[data-word]")?.classList.add("cut-target");
});
document.addEventListener("input", (e) => {
  if (e.target.id === "subtitle-text") {
    const c = selectedCue();
    if (c) {
      ui.drafts[c.id] = e.target.value;
      growTextarea();
    }
  }
  if (e.target.id === "search") {
    ui.query = e.target.value;
    ui.limit = 100;
    renderContent();
  }
  if (e.target.id === "volume") $("#audio").volume = +e.target.value;
});
document.addEventListener("change", (e) => {
  try {
    if (e.target.id === "theme") {
      prefs.theme = e.target.value;
      document.documentElement.dataset.theme = prefs.theme;
      preferences();
      wave.draw();
    }
    if (e.target.id === "project-name" && project()) {
      project().name = e.target.value.trim() || "Untitled";
      save();
    }
    if (e.target.id === "language") {
      prefs.language = e.target.value;
      preferences();
    }
    if (e.target.id === "model") {
      prefs.model = e.target.value;
      preferences();
    }
    if (e.target.id === "playback-rate")
      $("#audio").playbackRate = +e.target.value;
    if (e.target.id === "audio-file") {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) audioInput(f, ui.relink).catch(report);
    }
    if (e.target.id === "transcript-file") {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) importAny(f).catch(report);
    }
  } catch (err) {
    report(err);
  }
});
document.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input,textarea,select"),
    mod = e.ctrlKey || e.metaKey,
    k = e.key.toLowerCase();
  if(mod&&k==='s'){e.preventDefault();saveCurrent().catch(report);return;}
  if (e.key === "Escape") {
    cancelText();
    closeContext();
    closeModal();
    if (ui.scissors) {
      ui.scissors = false;
      renderContent();
    }
    return;
  }
  if(mod&&k==='z'&&$('#reference-input')){const field=$('#reference-input'),reference=referenceOf(project()),saved=reference?.chapters?.map(c=>c.text||'').join('\n\n')||reference?.words?.map(w=>w.text).join(' ')||'';if(field.value===saved){e.preventDefault();e.shiftKey?actions.redo():actions.undo();referencePanel();}return;}
  if ($("#dialogs").children.length) return;
  if (e.shiftKey && e.key === "F10") {
    const cue=e.target.closest("[data-cue-row]");
    if(cue){
      e.preventDefault();
      const r = e.target.getBoundingClientRect();
      contextMenu(
        "cue",
        cue.dataset.cueRow,
        r.left,
        r.bottom,
      );
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && e.target.id === "subtitle-text") {
    e.preventDefault();
    applyDrafts();
    return;
  }
  if (e.key === "Enter" && /^(cue|word)-(start|end)$/.test(e.target.id)) {
    e.preventDefault();
    persistTiming(e.target.id.startsWith("word") ? "word" : "cue");
    return;
  }
  if (mod && k === "z") {
    if (typing || ui.busy) return;
    e.preventDefault();
    e.shiftKey ? actions.redo() : actions.undo();
    return;
  }
  if (!typing && mod && k === "y") {
    e.preventDefault();
    actions.redo();
    return;
  }
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    Promise.resolve(actions["play-pause"]()).catch(report);
    return;
  }
  if (mod && k === "k") {
    e.preventDefault();
    actions.split();
  }
  if (mod && k === "m") {
    e.preventDefault();
    actions.merge();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (!native()&&(ui.busy || lastSaveError)) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (ui.busy || native()) return;
  const f = e.dataTransfer.files[0];
  if (f)
    (/\.(srt|json|whisperdesk|subtitler|txt|docx)$/i.test(f.name)
      ? importAny(f)
      : audioInput(f)
    ).catch(report);
});
function startupDeadline(promise, message, ms = 8000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function nativeEvents() {
  if(ui.nativeEventsReady)return;ui.nativeEventsReady=true;
  if (!window.__TAURI__?.event?.listen) return;
  try {
    await listenDocument(window.__TAURI__,'subtitler-open',event=>{void (async()=>{await invoke('take_document_open');if(event.payload.path)await openDocumentFile(event.payload.path,true);else if(event.payload.request){const r=event.payload.request;if(r.uiAction)await actions[r.uiAction]?.();else await handleStudioRequest(r,true);}})().catch(report);});
    await window.__TAURI__.event.listen('subtitler-folder-moved',event=>applyFolderMove(event.payload));
    await listenDocument(window.__TAURI__,'subtitler-close',()=>void closeProject());
    await listenDocument(window.__TAURI__,'subtitler-rematch',()=>{if(!ui.busy){const action=project().cues.length?()=>runAlignment(false,true):transcribe;Promise.resolve(action()).catch(report);}});
    await listenDocument(window.__TAURI__,'subtitler-menu',event=>{if(ui.busy)return toast('Wait for the current task to finish.');const action=actions[event.payload];if(action)Promise.resolve(action()).catch(report);});
    await window.__TAURI__.event.listen("whisper-progress", (event) => {
      if (event.payload.jobId !== ui.jobId) return;
      const line = String(event.payload.message || ""),
        match = line.match(/progress\s*=\s*(\d+)%/i);
      if (match) ui.percent = +match[1];
      if (match) ui.progress = `Transcribing locally · ${ui.percent}%`;
      else if (line.startsWith("Preparing audio;"))
        ui.progress = "Preparing audio; silence and timing preserved…";
      else if (ui.percent === null && /whisper|ggml|model/i.test(line))
        ui.progress = "Loading Whisper model…";
      else return;
      renderHeader();
    });
    await window.__TAURI__.event.listen("alignment-progress", (event) => {
      if (event.payload.jobId !== ui.jobId) return;
      const line = String(event.payload.message || "");
      if (!line.startsWith("SUBTITLER ")) return;
      ui.progress = line.slice(10);
      const match = line.match(/(\d+)%/);
      ui.percent = match ? +match[1] : null;
      renderHeader();
    });
    await listenDocument(window.__TAURI__,"tauri://drag-drop", (event) => {
      if (ui.busy) return;
      const path = event.payload.paths?.[0];
      if (path)
        (/\.(srt|json|whisperdesk|subtitler|txt|docx)$/i.test(path)
          ? importAny(path)
          : audioInput(path)
        ).catch(report);
    });
  } catch (e) {
    console.warn("Native progress events unavailable", e);
  }
}

let studioRequestBusy=false;
let pendingWorkspace=null;
async function openWorkspace(info,{audioPath=null,match=false,explicit=false}={}){
  const workspace={directory:info.directory,projectId:info.projectId||null,projectName:info.projectName||""};
  const audioFiles=info.audioCandidates||[];
  let audio=null;
  const requested=audioPath||info.activeRecording?.path;
  if(requested){try{audio=await invoke('audio_file_info',{path:requested});}catch{audio=null;}}
  else if(audioFiles.length===1)audio=audioFiles[0];
  if(!audio){
    toast(requested?'The requested audio could not be opened. Locate it manually.':'Choose the recording for this project.');
    const chosen=await invoke('pick_file',{kind:'audio'});if(!chosen)return false;
    audio=await invoke('audio_file_info',{path:chosen});
    if(info.activeRecording?.fingerprint&&!sameRecording(audio,info.activeRecording)){toast('This is a different recording. Select it in Storyboard Studio before sharing timing.');return false;}
  }
  // Only an explicit handoff may supersede stale selection metadata. The actual
  // requested bytes are verified natively before timing is published.
  info={...info,activeRecording:audio};
  if(!(await invoke('claim_recording',{projectId:workspace.projectId||'',fingerprint:audio.fingerprint||audio.path})))return false;
  const existing=transcriptCandidate(audio,projects.filter(p=>p.studioLink?.projectId===workspace.projectId),(info.transcripts||[]).filter(t=>!t.studioProjectId||t.studioProjectId===workspace.projectId));
  let target=existing?.project;
  if(existing&&!target){const opened=await invoke('open_document',{path:existing.path});target=openedDocument(opened.data,opened.path);if(opened.audioPath)target.source.embeddedPath=opened.audioPath;target.source={...target.source,...audio};}
  if(!target)target=newProject(audio.name.replace(/\.[^.]+$/,''),audio);
  if((target.filePath||target.studioLink?.projectFile||target.privateFile)?.replace(/\\/g,'/').startsWith(workspace.directory+'/Studio Link/')){delete target.filePath;delete target.privateFile;if(target.studioLink)delete target.studioLink.projectFile;}
  target.studioLink={...target.studioLink,...workspace,recordingFingerprint:audio.fingerprint||null,explicitSelection:explicit,...(target.filePath?{projectFile:target.filePath}:{})};target.closed=false;

  await openProject(target);
  project().source={...project().source,...audio,previewPath:null};await loadAudio();
  await studio.refresh();
  if(project().availableScript){project().useScript=true;history.change('Match shared script',p=>matchScript(p,p.availableScript,{correct:false}));}
  await save();
  if(match&&prefs.ffmpeg){const prepared=await invoke('prepare_audio',{path:audio.path,ffmpeg:prefs.ffmpeg,projectId:project().id});project().source={...project().source,...prepared};await loadAudio();}
  const sharedRef=project().referenceInput||project().availableScript;
  const incompleteReference=sharedRef?.words?.length>12&&project().scriptReference?.matched/sharedRef.words.length<.7;
  const badSavedTiming=incompleteReference||project().timingsNeedMatch||project().cues.some(c=>c.end>project().source.duration+.35);
  if(match){if(!project().cues.length||badSavedTiming)await transcribe();else await runAlignment(false,true);}
  if(!(await studio.flush()))throw Error(studio.status().text||'Could not save shared timing.');
  renderHeader();renderContent();return true;
}
async function receiveStudioRequest(){
 if(!native()||ui.busy||studioRequestBusy||document.hidden)return;studioRequestBusy=true;
 try{
  const r=await invoke('read_studio_request',{lastRequestId:prefs.lastStudioRequestId||null});
  if(!r||r.requestId===prefs.lastStudioRequestId)return;
  if(!(await invoke('claim_studio_request',{id:r.requestId})))return;
  await handleStudioRequest(r);
 }catch(e){report(e);}finally{studioRequestBusy=false;}
}


window.addEventListener("resize", growTextarea);
window.addEventListener("focus", () => {
  void receiveStudioRequest();
  if (native() && project()?.studioLink?.directory) void studio.refresh();
  if (native() && project()?.source.path)
    checkAudio()
      .then(renderHeader)
      .catch(() => {});
});
async function start() {
  try {
    window.whisperDeskStartup?.stage("Building the interface");
    setup();
    window.whisperDeskStartup?.stage("Opening saved files");
    projects = await startupDeadline(
      db.projects(),
      "Saved files did not finish opening. Close other app windows and retry.",
    );
    if(native()&&!prefs.transcriptDirectory){prefs.transcriptDirectory=await invoke("default_transcript_directory");preferences();}
    const p=null;
    window.whisperDeskStartup?.stage("Restoring the transcript and audio");
    await startupDeadline(
      openProject(p || newProject()),
      "The saved transcript or audio could not be restored. Copy the startup error details.",
    );
    if(native())await nativeEvents();
    const startup=native()?await invoke('take_document_open'):null;window.SUBTITLER_OPEN=startup||window.SUBTITLER_OPEN;if(window.SUBTITLER_OPEN?.path){try{await openDocumentFile(window.SUBTITLER_OPEN.path,true);}catch(e){throw Error('Could not open '+window.SUBTITLER_OPEN.path+': '+String(e.message||e));}}
    ui.startupComplete=true;renderHeader();
    window.whisperDeskStartup?.ready();
    if(window.SUBTITLER_OPEN?.request){const request=window.SUBTITLER_OPEN.request;setTimeout(()=>{if(request.uiAction)Promise.resolve(actions[request.uiAction]?.()).catch(report);else handleStudioRequest(request,true).catch(report);},0);}
    setTimeout(() => receiveStudioRequest(), 300);
    setInterval(() => receiveStudioRequest(), 3000);
    if (native())
      requestAnimationFrame(() => {
        if (!prefs.whisper || !prefs.ffmpeg || !prefs.model)
          void discover(false);
      });
  } catch (e) {
    console.error("Subtitler startup:", e);
    if (window.whisperDeskStartup) window.whisperDeskStartup.fail(e);
    else report(e);
  }
}
const studio = createStudioLink({
  saved:path=>{if(path){documentPath=path;if(native())void invoke('claim_document',{path}).catch(report);}renderHeader();},
  openWorkspace,
  project,
  connected: (link) => {
    const workspace = {
      directory: link.directory,
      projectId: link.projectId,
      projectName: link.projectName,
    };
    if (JSON.stringify(prefs.workspace) !== JSON.stringify(workspace)) {
      prefs.workspace = workspace;
      preferences();
    }
  },
  persist: () => save(),
  render: () => {
    if ($("#folder-path"))
      $("#folder-path").textContent =
        project()?.studioLink?.directory || "Not connected";
  },
  audioChanged: () => loadAudio(),
  status: (text, error) => {
    const el = $("#project-sync-status");
    if (el) {
      el.hidden = !text;
      el.textContent = text;
      el.classList.toggle("sync-error", error);
    }
    if ($("#folder-status")) $("#folder-status").textContent = text;
  },
});
document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.closest('[data-action="apply-text"]')) {
      e.preventDefault();
      return;
    }
    if (!e.target.closest("#subtitle-text")) cancelText();
  },
  true,
);
document.addEventListener("focusout", (e) => {
  if (
    e.target.id === "subtitle-text" &&
    !e.relatedTarget?.closest('[data-action="apply-text"]')
  )
    cancelText();
  if (
    /^(cue|word)-(start|end)$/.test(e.target.id) &&
    !e.target.closest(".time-fields")?.contains(e.relatedTarget)
  )
    persistTiming(e.target.id.startsWith("word") ? "word" : "cue");
});
document.addEventListener("change", (e) => {
  if (e.target.id === "import-file" || e.target.id === "script-file") {
    const f = e.target.files[0];
    e.target.value = "";
    if (f)
      (e.target.id === "script-file" ? importScript(f) : importAny(f)).catch(
        report,
      );
  }
});
start();

document.addEventListener('click',e=>{const b=e.target.closest('[data-recent-path]');if(b){closeModal();openDocumentFile(b.dataset.recentPath).catch(report);}});

document.addEventListener('click',e=>{for(const menu of document.querySelectorAll('.file-menu[open]'))if(!menu.contains(e.target))menu.open=false;});
