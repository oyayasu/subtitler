// Bounded-memory PCM WAV peaks. Converted playback audio keeps the original time origin.
export class WavPeaks {
  constructor(count = 2048) {
    this.count = count;
    this.header = new Uint8Array();
    this.carry = new Uint8Array();
    this.peaks = new Float32Array(count);
    this.ready = false;
    this.remaining = 0;
    this.frame = 0;
  }
  push(bytes) {
    if (!this.ready) {
      const joined = new Uint8Array(this.header.length + bytes.length);
      joined.set(this.header);
      joined.set(bytes, this.header.length);
      this.header = joined;
      if (joined.length < 12) return;
      if (
        String.fromCharCode(...joined.slice(0, 4)) !== "RIFF" ||
        String.fromCharCode(...joined.slice(8, 12)) !== "WAVE"
      )
        throw Error("The waveform needs a WAV playback copy.");
      const v = new DataView(joined.buffer);
      let offset = 12;
      while (offset + 8 <= joined.length) {
        const tag = String.fromCharCode(...joined.slice(offset, offset + 4)),
          size = v.getUint32(offset + 4, true),
          body = offset + 8;
        if (tag === "data") {
          if (!this.format || !size)
            throw Error("The WAV has no playable samples.");
          const { channels, rate, bits, type } = this.format;
          if (
            channels < 1 ||
            channels > 32 ||
            !rate ||
            ![8, 16, 24, 32].includes(bits) ||
            !(type === 1 || (type === 3 && bits === 32))
          )
            throw Error("Use a PCM WAV playback copy for the waveform.");
          this.frameBytes = (channels * bits) / 8;
          this.frames = Math.floor(size / this.frameBytes);
          if (!this.frames) throw Error("The WAV has no samples.");
          this.duration = this.frames / rate;
          this.remaining = size;
          this.ready = true;
          this.header = new Uint8Array();
          this.samples(joined.subarray(body));
          return;
        }
        if (size > 1024 * 1024 || body + size > joined.length) {
          if (joined.length > 1024 * 1024)
            throw Error("The WAV header is too large.");
          return;
        }
        if (tag === "fmt " && size >= 16)
          this.format = {
            type: v.getUint16(body, true),
            channels: v.getUint16(body + 2, true),
            rate: v.getUint32(body + 4, true),
            bits: v.getUint16(body + 14, true),
          };
        offset = body + size + (size % 2);
      }
      return;
    }
    this.samples(bytes);
  }
  samples(bytes) {
    if (!this.remaining) return;
    bytes = bytes.subarray(0, Math.min(bytes.length, this.remaining));
    this.remaining -= bytes.length;
    let chunk = bytes;
    if (this.carry.length) {
      chunk = new Uint8Array(this.carry.length + bytes.length);
      chunk.set(this.carry);
      chunk.set(bytes, this.carry.length);
    }
    const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      end = chunk.length - (chunk.length % this.frameBytes),
      { channels, bits, type } = this.format,
      size = bits / 8;
    for (let i = 0; i < end; i += this.frameBytes) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const at = i + c * size;
        let n;
        if (type === 3) n = v.getFloat32(at, true);
        else if (bits === 8) n = (v.getUint8(at) - 128) / 128;
        else if (bits === 16) n = v.getInt16(at, true) / 32768;
        else if (bits === 24) {
          n =
            v.getUint8(at) |
            (v.getUint8(at + 1) << 8) |
            (v.getInt8(at + 2) << 16);
          n /= 8388608;
        } else n = v.getInt32(at, true) / 2147483648;
        if (Number.isFinite(n)) peak = Math.max(peak, Math.min(1, Math.abs(n)));
      }
      const bin = Math.min(
        this.count - 1,
        Math.floor((this.frame++ * this.count) / this.frames),
      );
      this.peaks[bin] = Math.max(this.peaks[bin], peak);
    }
    this.carry = chunk.slice(end);
  }
  finish() {
    if (!this.ready || this.remaining || this.carry.length)
      throw Error("The WAV ended before its samples were complete.");
    return { duration: this.duration, peaks: Array.from(this.peaks) };
  }
}
export async function wavResponse(response, signal) {
  if (!response.ok) throw Error("The audio file could not be read.");
  const parser = new WavPeaks();
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal?.aborted) throw Error("Cancelled");
        const part = await reader.read();
        if (part.done) break;
        parser.push(part.value);
      }
      return parser.finish();
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
  }
  parser.push(new Uint8Array(await response.arrayBuffer()));
  return parser.finish();
}
export async function decodedPeaks(blob) {
  if (blob.size > 64 * 1024 * 1024)
    throw Error("Use a WAV playback copy for a recording this large.");
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw Error("Waveform decoding is unavailable.");
  const context = new AudioContext({ sampleRate: 8000 });
  try {
    const data = await context.decodeAudioData(await blob.arrayBuffer()),
      peaks = new Float32Array(2048);
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const samples = data.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) {
        const bin = Math.min(2047, Math.floor((i * 2048) / samples.length));
        peaks[bin] = Math.max(peaks[bin], Math.abs(samples[i]));
      }
    }
    return { duration: data.duration, peaks: Array.from(peaks) };
  } finally {
    context.close().catch(() => {});
  }
}
export const audioKey = (source) =>
  JSON.stringify([
    source.path || "",
    source.name || "",
    source.size || 0,
    source.modified || 0,
    source.duration || 0,
  ]);
export function createWaveform(host) {
  let peaks = [],
    duration = 0,
    controller = null,
    ticket = 0,
    observer = null,
    loadedKey = "",
    status = "";
  const canvas = () => document.querySelector("#waveform"),
    panel = () => document.querySelector("#waveform-shell");
  function draw() {
    const el = canvas();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(rect.width * ratio);
    el.height = Math.round(rect.height * ratio);
    const x = el.getContext("2d");
    x.scale(ratio, ratio);
    const w = rect.width,
      h = rect.height,
      mid = h / 2,
      time = host.audio().currentTime || 0,
      end = duration || host.duration(),
      progress = end ? Math.min(1, time / end) : 0;
    const light = document.documentElement.dataset.theme === "light";
    x.fillStyle = light ? "#f3f7ee" : "#191f1a";
    x.fillRect(0, 0, w, h);
    const selected = host.cue();
    if (end && selected) {
      x.fillStyle = light ? "#4c7a2322" : "#b7ed7812";
      x.fillRect(
        (selected.start / end) * w,
        0,
        ((selected.end - selected.start) / end) * w,
        h,
      );
    }
    x.strokeStyle = light ? "#b7c5aa" : "#364531";
    x.beginPath();
    x.moveTo(0, mid + 0.5);
    x.lineTo(w, mid + 0.5);
    x.stroke();
    if (peaks.length) {
      for (let at = 0; at < w; at += 3) {
        const from = Math.floor((at / w) * peaks.length),
          to = Math.max(from + 1, Math.ceil(((at + 3) / w) * peaks.length));
        let peak = 0;
        for (let i = from; i < Math.min(to, peaks.length); i++)
          peak = Math.max(peak, peaks[i]);
        const height = Math.max(1, peak * (h - 20));
        x.fillStyle =
          at / w <= progress
            ? light
              ? "#356819"
              : "#c3f58c"
            : light
              ? "#92a77c"
              : "#719456";
        x.fillRect(at, mid - height / 2, 2, height);
      }
    }
    if (end) {
      const playX = Math.max(1, Math.min(w - 1, progress * w));
      x.fillStyle = light ? "#18330a" : "#e2ffc8";
      x.fillRect(Math.round(playX), 0, 2, h);
      x.beginPath();
      x.moveTo(playX - 4, 0);
      x.lineTo(playX + 5, 0);
      x.lineTo(playX + 1, 6);
      x.fill();
    }
    el.setAttribute("aria-valuemax", String(end));
    el.setAttribute("aria-valuenow", String(time));
  }
  function show(text) {
    status = text;
    const el = document.querySelector("#waveform-status");
    if (el) el.textContent = text;
  }
  async function load() {
    const project = host.project();
    if (!project) return;
    const key = audioKey(project.source),
      id = project.id;
    if (loadedKey === id + key) {
      draw();
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal,
      mine = ++ticket;
    loadedKey = id + key;
    peaks = [];
    duration = project.source.duration || 0;
    show("");
    draw();
    const current = () => mine === ticket && host.project()?.id === id;
    const cached = await host.cache.get(id).catch(() => null);
    if (!current()) return;
    if (
      cached?.key === key &&
      Array.isArray(cached.peaks) &&
      cached.peaks.length === 2048
    ) {
      peaks = cached.peaks;
      duration = cached.duration;
      draw();
      return;
    }
    const url = host.waveUrl();
    if (!url) return;
    show("Loading waveform…");
    try {
      let result;
      if (host.isWav()) {
        result = await wavResponse(await fetch(url, { signal }), signal);
      } else {
        const response = await fetch(url, { signal });
        if (!response.ok) throw Error("Audio could not be read.");
        result = await decodedPeaks(await response.blob());
      }
      if (!current()) return;
      peaks = result.peaks;
      duration = result.duration;
      show("");
      draw();
      await host.cache.put(id, { key, ...result }).catch(() => {});
    } catch (e) {
      if (!current() || signal.aborted) return;
      show("Waveform unavailable");
      console.warn("Waveform:", e);
    }
  }
  function mount() {
    observer?.disconnect();
    const el = canvas(),
      shell = panel();
    if (!el || !shell) return;
    observer = new ResizeObserver(draw);
    observer.observe(el);
    shell.style.width = "100%";
    const position = (e) => {
      const r = el.getBoundingClientRect();
      host.seek(
        Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) *
          (duration || host.duration()),
      );
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      position(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (el.hasPointerCapture(e.pointerId)) position(e);
    });
    el.addEventListener("pointerup", (e) => {
      if (el.hasPointerCapture(e.pointerId)) {
        position(e);
        el.releasePointerCapture(e.pointerId);
      }
    });
    el.addEventListener("keydown", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        host.seek(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? duration || host.duration()
              : Math.max(
                  0,
                  Math.min(
                    duration || host.duration(),
                    host.audio().currentTime +
                      (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1),
                  ),
                ),
        );
      }
    });
    draw();
    show(status);
  }
  return {
    load,
    mount,
    draw,
    invalidate: () => {
      loadedKey = "";
    },
    stop: () => {
      controller?.abort();
      ticket++;
    },
  };
}
