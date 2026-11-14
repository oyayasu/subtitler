import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {parseSrt} from '../src/model.js';

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
vm.runInThisContext(fs.readFileSync(new URL('../src/vendor/jszip.min.js', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../src/', import.meta.url));
const sample = parseSrt('1\n00:00:01,000 --> 00:00:03,000\nOlá, world & friends.\n\n2\n00:00:04,000 --> 00:00:06,000\n日本語の字幕です。');
sample.name = 'Export test';
sample.filePath = '/Documents/Subtitler/Export test.subtitler';
const server = http.createServer((req,res) => {
  try {
    const name = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, name === '/' ? 'index.html' : name);
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: process.env.TEST_BROWSER_PATH || undefined,
  headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--disable-gpu','--no-process-singleton'],
});
const errors = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(p => {
    window.current = p;
    window.events = {};
    window.exportCalls = [];
    window.documentWrites = [];
    window.cancelSave = false;
    window.failSave = false;
    window.delaySave = false;
    window.__TAURI__ = {
      core: {
        convertFileSrc: p => p,
        invoke: async (name, args = {}) => {
          if (name === 'take_document_open') return {path: window.current.filePath};
          if (name === 'open_document') return {path: args.path, data: window.current, audioPath: null};
          if (name === 'default_transcript_directory') return '/Documents/Subtitler';
          if (['document_title','claim_document','claim_recording','finish_document_close'].includes(name)) return true;
          if (name === 'discover_tools') return {models: []};
          if (name === 'read_studio_request') return null;
          if (name === 'inspect_project_folder') return {directory:'/Storyboard', projectId:'ss', audioCandidates:[], transcripts:[]};
          if (name === 'save_project_files') return {projectFile: window.current.filePath};
          if (name === 'write_document') { window.documentWrites.push(args); return {changed: true}; }
          if (name === 'choose_document_save') {
            window.exportCalls.push({command:name,...args});
            return window.cancelSave ? null : '/Exports/Export test copy.subtitler';
          }
          if (name === 'save_export' || name === 'write_subtitler_export') {
            window.exportCalls.push({command:name,...args});
            if (window.delaySave) await new Promise(resolve => { window.releaseSave = resolve; });
            if (window.failSave) throw Error('Test destination is not writable');
            return name === 'save_export' ? !window.cancelSave : '/Storyboard/'+args.filename;
          }
          throw Error('Unexpected native command '+name);
        },
      },
      event: {listen:async(name,fn) => {window.events[name]=fn; return () => {}; }},
    };
  }, sample);
  const page = await context.newPage();
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('.cue').first().waitFor();
  const openExport = async () => {
    await page.locator('.top-actions [data-action="export"]').click();
    await page.locator('[data-export="docx"]').waitFor();
  };
  const outputs = new Map();
  for (const format of ['docx','txt','srt','csv','xlsx','json','subtitler']) {
    await openExport();
    if (['docx','txt'].includes(format)) await page.locator('#export-timestamps').check();
    // Click both the label and extension inside the button, not just the button edge.
    await page.locator(`[data-export="${format}"] ${format === 'txt' ? 'span' : 'strong'}`).click();
    await page.waitForFunction(n => window.exportCalls.length > n, outputs.size, {timeout:2500});
    await page.waitForFunction(() => !document.querySelector('[data-export]'));
    const call = await page.evaluate(() => window.exportCalls.at(-1));
    assert.equal(call.command, format === 'subtitler' ? 'choose_document_save' : 'save_export');
    if (format !== 'subtitler') {
      assert.equal(call.filename, 'Export test.'+format);
      outputs.set(format, Buffer.from(call.data,'base64'));
    } else {
      outputs.set(format, Buffer.alloc(0));
      const write = await page.evaluate(() => window.documentWrites.at(-1));
      const document = JSON.parse(write.data);
      assert.equal(write.path, '/Exports/Export test copy.subtitler');
      assert.notEqual(document.id, sample.id);
      assert.equal(document.studioLink, undefined);
      assert.equal(document.cues.length, 2);
    }
  }
  assert.match(outputs.get('txt').toString(), /\[00:00:01.000 → 00:00:03.000\] Olá/);
  assert.match(outputs.get('srt').toString(), /00:00:01,000 --> 00:00:03,000/);
  assert.match(outputs.get('csv').toString(), /日本語/);
  assert.equal(JSON.parse(outputs.get('json')).format, 'whisperdesk-timing-v1');
  for (const kind of ['docx','xlsx']) {
    const zip = await JSZip.loadAsync(outputs.get(kind));
    assert.ok(zip.file('[Content_Types].xml'));
    const text = await zip.file(kind === 'docx' ? 'word/document.xml' : 'xl/worksheets/sheet1.xml').async('string');
    assert.match(text,/Olá/); assert.match(text,/日本語/);
  }
  console.log('PASS actual export buttons and nested labels write all seven formats with valid content.');

  await page.evaluate(() => {window.cancelSave = true;});
  for (const format of ['txt','subtitler']) {
    if (!await page.locator('[data-export="txt"]').count()) await openExport();
    await page.locator(`[data-export="${format}"]`).click();
    await page.waitForFunction(() => document.querySelector('#export-status')?.textContent.includes('cancelled'));
    assert.equal(await page.locator('[data-export="txt"]').isEnabled(), true);
  }
  await page.evaluate(() => {window.cancelSave = false; window.failSave = true;});
  await page.locator('[data-export="txt"]').click();
  await page.waitForFunction(() => document.querySelector('#export-status')?.textContent.includes('not writable'));
  assert.equal(await page.locator('[data-export="txt"]').isEnabled(), true);
  await page.evaluate(() => {window.failSave = false; window.delaySave = true;});
  const before = await page.evaluate(() => window.exportCalls.length);
  await page.locator('[data-export="txt"]').click();
  await page.waitForFunction(() => !!window.releaseSave);
  await page.locator('[data-export="txt"]').evaluate(button => button.click());
  assert.equal(await page.locator('[data-export="srt"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.exportCalls.length), before+1);
  await page.evaluate(() => {window.releaseSave(); window.delaySave = false;});
  await page.waitForFunction(() => !document.querySelector('[data-export]'));
  console.log('PASS cancellation keeps the dialog, failure is visible and retryable, and repeated clicks start one write.');

  // The current in-memory edit must win over the older project list snapshot.
  await page.locator('.cue-number').first().click();
  await page.locator('#subtitle-text').fill('This is the latest applied edit.');
  await page.locator('[data-action="apply-text"]').click();
  await openExport(); await page.locator('[data-export="txt"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-export]'));
  const latest = await page.evaluate(() => window.exportCalls.at(-1));
  assert.match(Buffer.from(latest.data,'base64').toString(), /latest applied edit/);

  const linked = await context.newPage();
  linked.on('pageerror', err => errors.push(String(err)));
  await linked.addInitScript(() => { window.current.studioLink = {directory:'/Storyboard',projectId:'ss',projectName:'Storyboard test'}; });
  await linked.goto('http://127.0.0.1:'+server.address().port);
  await linked.locator('.cue').first().waitFor();
  await linked.locator('.top-actions [data-action="export"]').click();
  await linked.locator('[data-export="txt"]').click();
  await linked.waitForFunction(() => window.exportCalls.length === 1);
  assert.equal(await linked.evaluate(() => window.exportCalls[0].command), 'write_subtitler_export');
  assert.equal(await linked.evaluate(() => window.exportCalls[0].studioProjectId), 'ss');
  console.log('PASS latest applied edits and linked-project export routing.');
  assert.deepEqual(errors, []);
  if (process.env.TEST_OUTPUT) {
    fs.mkdirSync(process.env.TEST_OUTPUT, {recursive:true});
    for (const [kind,bytes] of outputs) if (kind !== 'subtitler') fs.writeFileSync(path.join(process.env.TEST_OUTPUT,'clicked-export.'+kind),bytes);
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
