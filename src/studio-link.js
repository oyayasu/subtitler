import {sameRecording} from './recording-identity.js';
import { clone, timingExport } from "./model.js";
import { parseScript } from "./workflow.js";
export function createStudioLink(host) {
  let timer = null,
    busy = false,
    again = false,
    last = "",
    status = "",
    error = false,
    pending = null;
  const native = () => !!window.__TAURI__?.core?.invoke,
    invoke = (n, a) => window.__TAURI__.core.invoke(n, a);
  function show(text, failed = false) {
    status = text;
    error = failed;
    host.status?.(text, failed);
  }
  async function refresh() {
    const p = host.project(),
      link = p?.studioLink;
    if (!native() || !link?.directory) return;
    try {
      const result = await invoke("inspect_project_folder", {
        directory: link.directory,
        expectedProjectId: link.projectId || null,
        audioRelativePath: p.source.relativePath || null,
      });
      if (host.project()?.id !== p.id) return;
      // A transcript keeps its explicit project and recording identity. Missing
      // audio is attached manually; never search for or switch to another file.
      link.directory = result.directory;
      link.projectId = result.projectId || null;
      link.projectName = result.projectName || "";
      host.connected?.(link);
      if (result.script) {
        const script = parseScript(result.script);
        const changed =
          JSON.stringify(p.availableScript) !== JSON.stringify(script);
        p.availableScript = script;
        if (changed) host.persist?.();
      }
      show(
        result.warnings?.join(" ") || "Studio Link connected",
        !!result.warnings?.length,
      );
      schedule();
    } catch (e) {
      show(
        "Project folder unavailable. Relink it in Settings. " +
          String(e.message || e),
        true,
      );
    }
  }
  async function choose() {
    if (!native()) throw Error("Choose a project folder in the installed app.");
    const directory = await invoke("choose_project_folder");
    if (!directory) return;
    if(host.openWorkspace){
      const info=await invoke("inspect_project_folder",{directory,expectedProjectId:null,audioRelativePath:null});
      last="";await host.openWorkspace(info);return;
    }
    const p = host.project(),
      result = await invoke("inspect_project_folder", {
        directory,
        expectedProjectId:
          p.source.name || p.cues.length
            ? p.studioLink?.projectId || null
            : null,
        audioRelativePath: p.source.relativePath || null,
      });
    if (host.project()?.id !== p.id) return;
    p.studioLink = {
      ...p.studioLink,
      directory: result.directory,
      projectId: result.projectId || null,
      projectName: result.projectName || "",
    };
    host.connected?.(p.studioLink);
    if (result.script) p.availableScript = parseScript(result.script);
    last = "";
    host.persist?.();
    show(
      result.warnings?.join(" ") || "Studio Link connected",
      !!result.warnings?.length,
    );
    await flush();
    host.render?.();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), 1200);
  }
  async function flush() {
    clearTimeout(timer);
    const p = host.project(),
      link = p?.studioLink;
    if (!native() || !link?.directory || (!p.source.name && !p.cues.length))
      return false;
    if (busy) {
      again = true;
      if(pending)await pending;
      return flush();
    }
    const snapshot = clone(p);
    delete snapshot.drafts;
    const timing = timingExport(snapshot),
      fingerprint = JSON.stringify([
        link.directory,
        { ...snapshot, updatedAt: "", lastOpenedAt: "", closed:false, lastSyncedAt: null },
        { ...timing, exportedAt: "" },
      ]);
    if (last === fingerprint) return true;
    busy = true;
    try {
      const result = await (pending=invoke("save_project_files", {
        directory: link.directory,
        studioProjectId: link.projectId || null,
        projectId: p.id,
        filename: (p.name || "Transcript") + ".subtitler",
        projectData: JSON.stringify(snapshot),
        timingData: JSON.stringify(timing),
      }));
      if (host.project()?.id === p.id) {
        const metadataChanged =
          (result.audioRelativePath &&
            p.source.relativePath !== result.audioRelativePath) ||
          link.projectFile !== result.projectFile;
        if (result.audioRelativePath)
          p.source.relativePath = result.audioRelativePath;
        link.projectFile = result.projectFile;
        p.filePath=result.projectFile;
        
        last = fingerprint;
        if (metadataChanged) host.persist?.();
        show(result.warning||"Timing shared with Storyboard Studio",!!result.warning);
        host.saved?.(result.projectFile);
      }
      return true;
    } catch (e) {
      show(String(e.message || e), true);
      return false;
    } finally {
      busy = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }
  return {
    choose,
    refresh,
    schedule,
    flush,
    status: () => ({ text: status, error }),
    reset: () => {
      clearTimeout(timer);
      last = "";
      status = "";
      error = false,
    pending = null;
      host.status?.("",false);
    },
  };
}
