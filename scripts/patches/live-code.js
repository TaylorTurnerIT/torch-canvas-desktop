// Live code editor. The code panel is editable: typing re-imports the code into the diagram,
// and diagram edits patch the open file's text (NN.syncSource), so hand-written code survives.
(() => {
  const ta = $('#codeEdit'), pre = $('#code'), auto = $('#oAuto'), autoLabel = $('#autoLabel');
  let timer = null, saveTimer = null, typing = false, codeError = null;
  S.live = false;
  window.torchCanvas = { state: S, commit }; // test hook
  try { auto.checked = localStorage.getItem('torchcanvas.autosave') === '1'; } catch {}

  const fileMode = () => !!S.file && S.file.kind === 'py' && typeof S.file.text === 'string';
  const paint = text => { pre.innerHTML = text.replace(/\n$/, '').split('\n').map((ln, i) => `<span class="ln" data-n="${i + 1}">${highlight(ln) || ' '}</span>`).join(''); };
  function showError() {
    const w = $('#warns');
    w.querySelectorAll('li.err').forEach(li => li.remove());
    if (codeError) { w.hidden = false; w.insertAdjacentHTML('afterbegin', `<li class="err">Code: ${esc(codeError)} The diagram keeps its last good version.</li>`); }
  }
  // Fold a diagram edit into the file text.
  function syncFile() {
    const f = S.file, key = S.gen.code + '\0' + f.text;
    if (f.syncKey === key) return;
    if (!S.live) {
      try { f.text = NN.syncSource(f.text, R(), { root: f.root, gen: genOpts() }); codeError = null; }
      catch (e) { codeError = e.message; }
    }
    f.syncKey = S.gen.code + '\0' + f.text;
  }
  function show(text) {
    if (ta.value !== text) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = text;
      if (document.activeElement === ta) ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
    }
    if (text !== S.gen.code) paint(text);
  }
  const baseRender = renderCode;
  renderCode = function () {
    baseRender();
    const fm = fileMode();
    ta.readOnly = !!R().libHost;
    autoLabel.hidden = !(fm && S.file.handle);
    if (fm) { syncFile(); show(S.file.text); }
    else if (!(typing && document.activeElement === ta)) { codeError = null; show(S.gen.code); }
    showError();
    clearTimeout(saveTimer);
    if (fm && auto.checked && S.file.handle && !S.file.changedOnDisk && !codeError && isDirty()) saveTimer = setTimeout(() => saveFile(true), 700);
  };
  const baseDirty = isDirty;
  isDirty = () => (fileMode() ? S.file.text !== S.file.diskText : baseDirty());

  // Typing: reimport the text and replace the diagram when it describes a different model.
  function apply(text) {
    let res;
    try { res = NN.importPython(text, { root: S.file && S.file.root }); }
    catch (e) { codeError = e.message; return showError(); }
    codeError = null;
    const opts = Object.assign({}, genOpts(), { shapeComments: false, literalDims: false });
    const gen = g => NN.generate(g, Object.assign({}, opts, { className: res.graph.name })).code;
    let same = false; try { same = gen(res.graph) === gen(R()); } catch {}
    if (same) return showError();
    NN.autoLayout(res.graph, sizeOf);
    if (res.graph.blocks) for (const b of Object.values(res.graph.blocks)) NN.autoLayout(b.graph, sizeOf);
    if (S.file) saveLayout();
    syncLinked(res.graph);
    S.live = true;
    try { commit(() => { setModel(res.graph); if (S.file) restoreLayout(); clearSel(); }); }
    finally { S.live = false; }
    if (res.warnings.length) { const w = $('#warns'); w.hidden = false; w.innerHTML += res.warnings.map(x => `<li>Import: ${esc(x)}</li>`).join(''); }
    showError();
  }
  ta.addEventListener('input', () => {
    typing = true;
    const text = ta.value;
    paint(text);
    if (fileMode()) { S.file.text = text; renderFileBar(); }
    clearTimeout(timer); timer = setTimeout(() => apply(text), 350);
  });
  ta.addEventListener('blur', () => { typing = false; if (!codeError) renderCode(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); document.execCommand('insertText', false, '    '); }
  });
  auto.addEventListener('change', () => {
    try { localStorage.setItem('torchcanvas.autosave', auto.checked ? '1' : '0'); } catch {}
    renderCode();
  });
})();
