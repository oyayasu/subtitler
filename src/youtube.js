import {newProject, tokenize, distribute, uid, validateProject} from './model.js';

export function youtubeId(input) {
  const invalid = 'Paste a YouTube video link, such as youtube.com/watch?v=… or youtu.be/…';
  let url;
  try {
    const text = input.trim();
    url = new URL(text.includes('://') ? text : 'https://' + text);
  } catch { throw Error(invalid); }
  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw Error(invalid);
  const parts = url.pathname.split('/').filter(Boolean);
  let id;
  if (['youtu.be', 'www.youtu.be'].includes(host) && parts.length === 1) id = parts[0];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['shorts','live','embed'].includes(parts[0]) && parts.length === 2) id = parts[1];
  }
  if (!/^[\w-]{11}$/.test(id || '')) throw Error(invalid);
  return id;
}

const languageKey = code => (code || '').toLowerCase().replace(/-orig$/, '');
export function preferredTrack(tracks, preference, original) {
  const target = languageKey(preference === 'auto' ? original : preference);
  const matching = !target ? tracks : tracks.filter(track =>
    languageKey(track.code).split('-')[0] === target.split('-')[0]);
  return [...matching].sort((a,b) => Number(a.automatic) - Number(b.automatic) ||
    Number(languageKey(b.code) === target) - Number(languageKey(a.code) === target))[0] || null;
}

export function youtubeProject(data, videoId, title, track) {
  const project = newProject(title || 'YouTube captions');
  const lines = (data?.events || []).filter(event => Array.isArray(event.segs))
    .map(event => ({start:event.tStartMs, duration:event.dDurationMs,
      text:event.segs.map(seg => typeof seg.utf8 === 'string' ? seg.utf8 : '').join('').trim()}))
    .filter(line => line.text && Number.isFinite(line.start) && line.start >= 0)
    .sort((a,b) => a.start-b.start);
  if (lines.length > 50000) throw Error('Import at most 50,000 captions per project.');
  for (const [index, line] of lines.entries()) {
    const start = line.start / 1000;
    const end = (line.duration > 0 ? line.start + line.duration : lines[index+1]?.start) / 1000;
    if (!Number.isFinite(end) || end <= start) continue;
    const words = distribute(tokenize(line.text), start, end);
    if (words.length) project.cues.push({id:uid(),start,end,words});
  }
  if (!project.cues.length) throw Error('This track contains no timed captions.');
  project.source.duration = Math.max(...project.cues.map(c => c.end));
  project.language = languageKey(track.code);
  project.recognition = {engine:'YouTube captions', videoId, language:track.code,
    automatic:track.automatic, note:'Caption timings from YouTube. Individual word timings are estimated.'};
  return validateProject(project);
}
