/* Runs before the app, independently of module loading and newer browser APIs. */
(function () {
  'use strict';
  var ready = false, failed = false, stage = 'Loading the interface';
  function message(error) { return error && error.message ? error.message : String(error || 'Unknown startup error'); }
  function fail(error) {
    if (ready || failed) return;
    failed = true; clearTimeout(watchdog);
    var root = document.getElementById('app'); if (!root) return;
    root.textContent = '';
    var card = document.createElement('section'); card.className = 'startup-error';
    var title = document.createElement('h1'); title.textContent = 'Subtitler could not open';
    var explanation = document.createElement('p'); explanation.textContent = 'The interface could not finish starting. Your saved transcripts and audio have not been deleted.';
    var detail = document.createElement('textarea'); detail.readOnly = true; detail.rows = 7; detail.setAttribute('aria-label', 'Startup error details');
    detail.value = 'Subtitler 0.8.1\nStage: ' + stage + '\n' + message(error) + '\nBrowser: ' + navigator.userAgent;
    var actions = document.createElement('div'); actions.className = 'startup-error-actions';
    var retry = document.createElement('button'); retry.className = 'primary'; retry.textContent = 'Retry opening'; retry.onclick = function () { location.reload(); };
    var copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = 'Copy error details'; copy.onclick = function () { detail.focus(); detail.select(); try { document.execCommand('copy'); } catch (_) {} };
    actions.appendChild(retry); actions.appendChild(copy); card.appendChild(title); card.appendChild(explanation); card.appendChild(detail); card.appendChild(actions); root.appendChild(card);
  }
  if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: function (index) { index = Number(index) || 0; index = index < 0 ? Math.ceil(index) : Math.floor(index); if (index < 0) index += this.length; return this[index]; } });
  var watchdog = setTimeout(function () { fail(new Error('Startup did not finish within 12 seconds. Copy these details so the startup failure can be diagnosed.')); }, 12000);
  window.whisperDeskStartup = { stage: function (value) { stage = value; }, fail: fail, ready: function () { if (!failed) { ready = true; clearTimeout(watchdog); window.__whisperDeskReady = true; } } };
  window.addEventListener('error', function (event) {
    if (ready) return;
    if (event.target && event.target.tagName === 'SCRIPT') fail(new Error('The local script could not load: ' + (event.target.getAttribute('src') || 'unknown script')));
    else if (event.error || event.message) fail(event.error || event.message);
  }, true);
  window.addEventListener('unhandledrejection', function (event) { if (!ready) fail(event.reason); });
}());
