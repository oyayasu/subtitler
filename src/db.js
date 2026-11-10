import { clone } from "./model.js";
let opening;
function db() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    let request,
      finished = false;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opening = null;
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          Error(
            "Saved transcripts could not be opened. Close other Subtitler windows, then retry. No saved data was deleted.",
          ),
        ),
      5000,
    );
    try {
      request = indexedDB.open("whisper-desk-v1", 2);
    } catch (error) {
      fail(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("projects"))
        request.result.createObjectStore("projects", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("audio"))
        request.result.createObjectStore("audio");
      if (!request.result.objectStoreNames.contains("waveforms"))
        request.result.createObjectStore("waveforms");
    };
    request.onsuccess = () => {
      if (finished) {
        request.result.close();
        return;
      }
      finished = true;
      clearTimeout(timer);
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        opening = null;
      };
      resolve(connection);
    };
    request.onerror = () =>
      fail(request.error || Error("Saved transcripts could not be opened."));
    request.onblocked = () =>
      fail(
        Error(
          "Another Subtitler window is blocking storage. Close it and retry.",
        ),
      );
  });
  return opening;
}
async function operation(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    let done = false,
      tx,
      r;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        tx?.abort();
      } catch {}
      finish(
        Error(
          "The saved transcript operation timed out. Retry opening the app.",
        ),
      );
    }, 5000);
    try {
      tx = d.transaction(store, mode);
      r = fn(tx.objectStore(store));
      tx.oncomplete = () => finish(null, r?.result);
      tx.onerror = () =>
        finish(tx.error || Error("Could not access saved transcripts."));
      tx.onabort = () => finish(tx.error || Error("Autosave interrupted"));
    } catch (error) {
      finish(error);
    }
  });
}
export const database = {
  projects: () => operation("projects", "readonly", (s) => s.getAll()),
  save: (p) => operation("projects", "readwrite", (s) => s.put(clone(p))),
  remove: async (id) => {
    await operation("projects", "readwrite", (s) => s.delete(id));
    await operation("audio", "readwrite", (s) => s.delete(id));
    await operation("waveforms", "readwrite", (s) => s.delete(id));
  },
  audio: (id) => operation("audio", "readonly", (s) => s.get(id)),
  putAudio: (id, blob) =>
    operation("audio", "readwrite", (s) => s.put(blob, id)),
  waveform: (id) => operation("waveforms", "readonly", (s) => s.get(id)),
  putWaveform: (id, value) =>
    operation("waveforms", "readwrite", (s) => s.put(value, id)),
};
