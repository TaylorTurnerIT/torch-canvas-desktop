// Native file watching: the desktop app asks the native side to watch the open file. Changes arrive as
// `torch-file-changed` and run checkDisk at once. While the active file is watched, the 5 s poll is skipped.
(() => {
  if (!window.__TAURI__) return;
  const invoke = window.__TAURI__.core.invoke;
  const events = window.__TAURI__.event;
  const requested = new Set(); // native ids already sent to native_watch, so each is sent once
  const watched = new Set(); // native ids the native side confirmed
  const activeId = () => (S.file && S.file.handle && S.file.handle._nativeId) || null;
  // The poll is skipped only while the active file itself is watched.
  const syncFlag = () => { const id = activeId(); window.__torchNativeWatch = !!id && watched.has(id); };
  async function ensureWatch() {
    const id = activeId();
    if (id && !requested.has(id)) {
      requested.add(id);
      try { await invoke('native_watch', { id }); watched.add(id); } catch {}
    }
    syncFlag();
  }
  if (events && events.listen) events.listen('torch-file-changed', () => checkDisk());
  // renderFileBar runs whenever the open file changes, so each new active file is watched here.
  const renderBar = renderFileBar;
  renderFileBar = function () { renderBar.apply(this, arguments); ensureWatch(); };
  ensureWatch();
})();
