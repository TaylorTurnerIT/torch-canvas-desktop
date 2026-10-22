
// Recent models (function-scoped constants: openLibrary can run before this code does): the last few examples and files opened, listed at the top of Open / import.
function loadRecents() {
  try { const r = JSON.parse(localStorage.getItem('torchcanvas.recents') || '[]'); return Array.isArray(r) ? r.filter(x => x && x.key && x.title).slice(0, 5) : []; }
  catch { return []; }
}
function recordRecent(entry) {
  if (!entry || !entry.key) return;
  const list = [entry].concat(loadRecents().filter(x => !(x.kind === entry.kind && x.key === entry.key))).slice(0, 5);
  try { localStorage.setItem('torchcanvas.recents', JSON.stringify(list)); } catch {}
}
// Entries whose example no longer exists are skipped.
const liveRecents = () => loadRecents().filter(x => x.kind !== 'lib' || S.library.some(l => l.file === x.key));
function recentMenu() {
  const list = liveRecents();
  if (!list.length) return '';
  return `<div class="hd">Recent</div>` + list.map((x, i) => item('recent:' + i, x.title, x.note || '')).join('') + '<hr>';
}
async function openRecent(i) {
  const x = liveRecents()[i]; if (!x) return;
  if (x.kind === 'lib') return openLibrary(S.library.find(l => l.file === x.key));
  // The native side reopens files you chose before, and only those. A moved or deleted file falls back to the picker.
  if (window.__TAURI__) {
    let info = null;
    try { info = await window.__TAURI__.core.invoke('native_reopen', { identity: x.key }); } catch {}
    if (info) return openHandle(window.torchDesktop.handle(info), info.name);
  }
  toast(`Couldn't reopen ${x.title}. Choose it again.`);
  openFileDialog();
}
// First run of this feature: start from the tabs that are already open.
(() => {
  let stored = null; try { stored = localStorage.getItem('torchcanvas.recents'); } catch {}
  if (stored !== null) return;
  for (const d of S.docs.slice().reverse()) {
    const f = d.id === S.cur ? S.file : d.file, src = (f && f.handle && f.handle._nativeIdentity ? { identity: f.handle._nativeIdentity, name: f.name } : d.sourceFile);
    const lib = d.fromLib && S.library.find(l => l.file === d.fromLib);
    if (src && src.identity) recordRecent({ kind: 'file', key: src.identity, title: src.name, note: src.identity.slice(0, src.identity.lastIndexOf('/')) });
    else if (lib) recordRecent({ kind: 'lib', key: lib.file, title: lib.title, note: lib.kind === 'block' ? 'Block' : 'Example' });
  }
  try { if (localStorage.getItem('torchcanvas.recents') === null) localStorage.setItem('torchcanvas.recents', '[]'); } catch {}
})();
