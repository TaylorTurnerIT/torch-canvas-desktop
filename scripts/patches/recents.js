
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
function openRecent(i) {
  const x = liveRecents()[i]; if (!x) return;
  if (x.kind === 'lib') return openLibrary(S.library.find(l => l.file === x.key));
  // A file's tab is still open: switch to it. File access does not outlive the session, so otherwise choose it again.
  for (const d of S.docs) {
    const f = d.id === S.cur ? S.file : d.file, id = (f && f.handle && f.handle._nativeIdentity) || (d.sourceFile && d.sourceFile.identity);
    if (id && id === x.key) { if (d.id !== S.cur) activateDoc(d.id); return toast(`Switched to ${x.title}.`); }
  }
  toast(`Choose ${x.title} again. File access doesn't carry over between sessions.`);
  openFileDialog();
}
