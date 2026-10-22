"""Derive the offline desktop page from upstream sources via build.js."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
# build.js writes ./index.html from src.html, core.js, engine.js, export.js and the examples library.
subprocess.run(["node", "build.js"], cwd=ROOT, check=True)
page = (ROOT / "index.html").read_text()
# Apply desktop compatibility fixes to the built upstream page.
evaluator = (ROOT / "scripts/patches/eval-dim.js").read_text().rstrip()
page, count = re.subn(r'  function evalDim\(expr, symbols\) \{.*?\n  \}(?=\n  function dimEq)', lambda _: evaluator, page, flags=re.S)
if count != 1:
    raise RuntimeError('Expected exactly one upstream dimension evaluator')
needle = '      const n = byId.get(id), p = n.params, shape = shapeOf(id);'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one variance prediction loop')
page = page.replace(needle, needle + '''
      if (!shape || !shape.length || shape.some(d => !Number.isInteger(d) || d <= 0)) {
        return { error: `Set positive numeric sizes for ${p.title || p.name || n.type} before plotting variance.`, node: id };
      }''')
needle = 'async function openHandle(h, path, root, inDir) {\n  try {'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one native file-open handler')
page = page.replace(needle, needle + '''
    // Native and browser file handles identify files independently of basename.
    // Reuse the live document without rereading or replacing unsaved changes.
    for (const doc of S.docs) {
      const file = doc.id === S.cur ? S.file : doc.file;
      const source = file && file.handle ? null : doc.sourceFile;
      let same = h._nativeIdentity && source && source.identity === h._nativeIdentity;
      if (!same && file && file.handle) same = file.handle === h;
      if (!same && file && file.handle && typeof h.isSameEntry === 'function') {
        try { same = await h.isSameEntry(file.handle); } catch {}
      }
      if (same) {
        if (!file || !file.handle) {
          const disk = await h.getFile();
          const attached = Object.assign({}, source, { handle: h, lastModified: disk.lastModified, changedOnDisk: (await disk.text()) !== source.diskText });
          doc.file = attached;
          if (doc.id === S.cur) S.file = attached;
        }
        if (doc.id !== S.cur) activateDoc(doc.id);
        else { renderFileBar(); renderTabs(); save(); }
        toast(`Switched to ${(file || source).name}.`);
        return;
      }
    }''')
# marimo notebooks: keep @app.class_definition decorators and setup-cell imports on save.
marimo = (ROOT / "scripts/patches/source-sync.js").read_text().rstrip()
needle = '  return { HELPER_OPS, helperDoc,'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one core export list')
page = page.replace(needle, marimo + '\n\n' + needle)
page = page.replace('syncWidths, mergeIntoSource, uid,', 'syncWidths, mergeIntoSource, isMarimo, syncSource: (...a) => mergeIntoSource.sync(...a), uid,', 1)
needle = "kind: k, diskText: text, used: res.usedClasses || [], root: o.root, changedOnDisk: false }) : null;"
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one open-file record')
page = page.replace(needle, "kind: k, marimo: k === 'py' && NN.isMarimo(text), diskText: text, used: res.usedClasses || [], root: o.root, changedOnDisk: false }) : null;")
needle = '<span class="spacer"></span>\n    ${f.handle && f.kind'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one file bar template')
page = page.replace(needle, '${f.marimo ? \'<span class="pill" title="Saving rewrites only the model classes. marimo reloads the file when it changes.">marimo</span>\' : \'\'}\n    ' + needle)
# Remember file identity without persisting filesystem permission. Reopening a
# file after restarting reattaches a freshly granted handle to its saved tab.
needle = 'from: S.docs.map(d => d.fromLib || null), cur:'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one document autosave record')
page = page.replace(needle, '''from: S.docs.map(d => d.fromLib || null), sourceFiles: S.docs.map(d => {
    const f = d.id === S.cur ? S.file : d.file;
    if (f && f.handle && f.handle._nativeIdentity) return { identity: f.handle._nativeIdentity, name: f.name, path: f.path, kind: f.kind, root: f.root, used: f.used, diskText: f.diskText, savedCode: f.savedCode };
    return d.sourceFile || null;
  }), cur:''')
needle = "const fromOf = new Map();"
page = page.replace(needle, needle + '''
const sourceOf = new Map();
if (saved && saved.v === 2 && Array.isArray(saved.docs) && Array.isArray(saved.sourceFiles)) saved.docs.forEach((g, i) => {
  const source = saved.sourceFiles[i];
  if (g && source && typeof source.identity === 'string') sourceOf.set(g, source);
});''')
page = page.replace('fromLib: fromOf.get(r) || null', 'sourceFile: sourceOf.get(r) || null, fromLib: fromOf.get(r) || null')
page = page.replace("on('fbClose', () => { S.file = null;", "on('fbClose', () => { const doc = docById(S.cur); if (doc) doc.sourceFile = null; S.file = null; save();")
# Live code editor: the file text is the working copy. Typing reimports it; diagram edits patch it.
for old, new, why in [
    ("async function saveFile() {", "async function saveFile(auto) {", 'saveFile signature'),
    ("    const gen = NN.generate(R(), genOpts()).code;\n    let out;\n    if (S.file.kind === 'graph')",
     "    if (auto === true && disk !== S.file.diskText) { S.file.changedOnDisk = true; renderFileBar(); return; }\n    const gen = NN.generate(R(), genOpts()).code;\n    let out;\n    if (S.file.kind === 'graph')", 'autosave conflict'),
    ("Saving merges the diagram into the newer version.", "${typeof S.file.text === 'string' ? 'Saving replaces it with your version.' : 'Saving merges the diagram into the newer version.'}", 'conflict message'),
    ("out = NN.mergeIntoSource(disk, gen, S.file.used);", "out = typeof S.file.text === 'string' ? S.file.text : NN.mergeIntoSource(disk, gen, S.file.used);", 'save text'),
    ("    toast(`Saved ${name}. Only the model classes changed; the rest of the file is untouched.`,", "    auto === true || toast(`Saved ${name}.${typeof S.file.text === 'string' ? '' : ' Only the model classes changed; the rest of the file is untouched.'}`,", 'save toast'),
    ("Object.assign(S.file, { diskText: disk, lastModified: f2.lastModified, savedCode: null }); renderFileBar();", "Object.assign(S.file, { diskText: disk, lastModified: f2.lastModified, savedCode: null }); if (typeof S.file.text === 'string') return reloadFromDisk(false); renderFileBar();", 'undo save'),
    ("kind: 'py', diskText: gen, used, savedCode: gen, lastModified: f.lastModified };", "kind: 'py', text: gen, diskText: gen, used, savedCode: gen, lastModified: f.lastModified };", 'save as text'),
    ("marimo: k === 'py' && NN.isMarimo(text), diskText: text,", "marimo: k === 'py' && NN.isMarimo(text), text: k === 'py' ? text : undefined, diskText: text,", 'open text'),
    ("diskText: f.diskText, savedCode: f.savedCode };", "diskText: f.diskText, savedCode: f.savedCode, text: f.text };", 'persist text'),
    ('<pre class="code" id="code"></pre></div>', '<div class="codewrap"><pre class="code" id="code" aria-hidden="true"></pre><textarea id="codeEdit" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="PyTorch code"></textarea></div></div><div id="marimoPane" hidden><div class="marimo-head"><span id="marimoStatus"></span><label title="Write the file shortly after each edit, so marimo follows"><input type="checkbox" id="oAuto2"> auto-save</label><button class="btn" id="marimoReload">Reload</button><button class="btn" id="marimoStop" title="Stop the marimo server">Stop</button></div><div id="marimoFrames"></div></div>', 'editor markup'),
    ('    </aside>\n', '    </aside>\n    <div class="resizer" id="resizeLeft" role="separator" aria-orientation="vertical" aria-label="Resize the component palette" tabindex="0" title="Drag to resize. Double-click to reset."></div>\n', 'left divider'),
    ('\n    <div class="right">', '\n    <div class="resizer" id="resizeRight" role="separator" aria-orientation="vertical" aria-label="Resize the code and marimo pane" tabindex="0" title="Drag to resize. Double-click to reset."></div>\n    <div class="right">', 'right divider'),
    ('<div class="tabs"><span class="tab" aria-selected="true" style="cursor:default">PyTorch</span></div>',
     '<div class="tabs"><button class="tab" id="tabCode" aria-selected="true">PyTorch</button><button class="tab" id="tabMarimo" aria-selected="false" hidden>marimo</button></div>', 'right tabs'),
    ('<span class="spacer"></span>\n        <button class="btn" id="bCopy">', '<label id="autoLabel" hidden title="Write the file shortly after each edit, so a running marimo notebook follows"><input type="checkbox" id="oAuto"> auto-save</label>\n        <span class="spacer"></span>\n        <button class="btn" id="bCopy">', 'auto-save toggle'),
]:
    if page.count(old) != 1:
        raise RuntimeError('Expected exactly one ' + why)
    page = page.replace(old, new)
page = page.replace('</style>', """.codewrap { position: relative; min-width: 100%; width: max-content; min-height: 100%; background: var(--code-bg); }
.codewrap pre.code { position: relative; }
#codeEdit { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 10px 14px 24px 4.4em; border: 0; border-radius: 0; outline: 0; resize: none; overflow: hidden; white-space: pre; tab-size: 4; background: transparent; color: transparent; caret-color: var(--ink); font: 12px/1.6 var(--mono); }
#codeEdit::selection { background: color-mix(in srgb, var(--sel) 30%, transparent); color: transparent; }
.warns li.err { color: var(--err); }
.right[data-tab="marimo"] #codeBar, .right[data-tab="marimo"] #codePane { display: none; }
#marimoPane { grid-row: 2 / 4; display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
#marimoPane[hidden] { display: none; }
.marimo-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.marimo-head #marimoStatus { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.marimo-head #marimoStatus.err { color: var(--err); white-space: pre-wrap; }
.marimo-head label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
#marimoFrames { min-height: 0; position: relative; }
#marimoFrames iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.resizer { display: none; }
@media (min-width: 981px) {
  .main { grid-template-columns: var(--left-w, 228px) 5px minmax(0, 1fr) 5px var(--right-w, minmax(340px, 34%)); }
  .resizer { display: block; position: relative; z-index: 2; cursor: col-resize; touch-action: none; background: var(--line); opacity: .55; transition: opacity .12s, background .12s; }
  .resizer:hover, .resizer.drag, .resizer:focus-visible { background: var(--stream); opacity: 1; outline: 0; }
  .resizer::after { content: ""; position: absolute; inset: 0 -4px; }
}
</style>""", 1)
# Poll the open file every 5 s only when native watching is not active (see scripts/patches/file-watch.js).
needle = 'setInterval(checkDisk, 5000);'
if page.count(needle) != 1:
    raise RuntimeError('Expected exactly one disk poll interval')
page = page.replace(needle, 'setInterval(() => { if (!window.__torchNativeWatch) checkDisk(); }, 5000);')
live = '\n'.join((ROOT / f"scripts/patches/{name}.js").read_text().rstrip() for name in ("live-code", "recents", "marimo-pane", "resizers", "open-files", "file-watch"))
end = page.rindex('})();\n</script>')
page = page[:end] + live + '\n' + page[end:]
for old, new, why in [
    ("function openLibrary(entry) {\n  if (!entry) return;", "function openLibrary(entry) {\n  if (!entry) return;\n  recordRecent({ kind: 'lib', key: entry.file, title: entry.title, note: entry.kind === 'block' ? 'Block' : 'Example' });", 'recent examples'),
    ("    // Native and browser file handles identify files independently of basename.", "    if (h.kind === 'file') recordRecent({ kind: 'file', key: h._nativeIdentity || path || h.name, title: h.name, note: h._nativeIdentity ? h._nativeIdentity.slice(0, h._nativeIdentity.lastIndexOf('/')) : 'File' });\n    // Native and browser file handles identify files independently of basename.", 'recent files'),
    ("title=\"Close (Esc)\">×</button></div>`\n    + (nets.length ?", "title=\"Close (Esc)\">×</button></div>`\n    + recentMenu()\n    + (nets.length ?", 'recent menu'),
    ("      if (a.startsWith('lib:')) return openLibrary(", "      if (a.startsWith('recent:')) return openRecent(+a.slice(7));\n      if (a.startsWith('lib:')) return openLibrary(", 'recent dispatch'),
]:
    if page.count(old) != 1:
        raise RuntimeError('Expected exactly one ' + why)
    page = page.replace(old, new)
# Use native system fonts: no remote styles, fonts, scripts, or runtime server.
page = re.sub(r'<link[^>]+href="https://fonts.googleapis.com[^>]+>\n?', '', page)
page = page.replace('<title>Torch Canvas</title>', '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Torch Canvas</title>')
# Upstream is an HTML fragment. Keep its markup and script order intact.
first_markup = page.index('<div class="app">')
page = page[:first_markup] + '</head>\n<body>\n' + page[first_markup:]
page = page.replace('<script id="tc-core">', '<script src="desktop.js"></script>\n<script id="tc-core">')
page = page.replace('if (/^https?:$/.test(location.protocol) && typeof fetch', 'if (!window.__TAURI__ && /^https?:$/.test(location.protocol) && typeof fetch')
page = page.replace('async function offerFile(name, data) {', '''async function offerFile(name, data) {
  if (window.torchDesktop) {
    try { if (await window.torchDesktop.save(name, data)) toast(`Saved ${name}.`); }
    catch (e) { toast(`Couldn't save ${name}: ${e.message || e}`); }
    return;
  }''')
# Native handles are session grants, not durable browser file handles.
page = page.replace("async function rememberHandles() { try", "async function rememberHandles() { if (window.torchDesktop) { save(); return; } try")
page = page.replace("idb.get('last').then", "(window.torchDesktop ? Promise.resolve(null) : idb.get('last')).then")
page = page.replace('id="exDlModel">Download model.py', 'id="exDlModel">Save model.py')
page = page.replace('id="exDlTrain">Download train.py', 'id="exDlTrain">Save train.py')
page = page.replace('</header>', '<span class="desktop-credit" title="Original Torch Canvas by Jesse Roberts · https://www.jessetnroberts.com/torch-canvas/">By Jesse Roberts · Desktop</span></header>', 1)
page = page.replace('</style>', 'body { margin: 0; }\n.desktop-credit { font: 11px var(--sans); color: var(--muted); white-space: nowrap; margin-left: 8px; }\n</style>', 1)
(ROOT / "web/index.html").write_text(page + '\n</body>\n</html>\n')
print('Prepared offline Torch Canvas with Jesse Roberts attribution.')
