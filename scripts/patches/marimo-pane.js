
// marimo pane: runs `marimo edit` for the open notebook (native side) and shows it beside the diagram.
(() => {
  const invoke = window.__TAURI__ && window.__TAURI__.core.invoke;
  const right = document.querySelector('.right'), main = document.querySelector('.main');
  const tabCode = $('#tabCode'), tabMarimo = $('#tabMarimo'), pane = $('#marimoPane'), frames = $('#marimoFrames');
  const status = $('#marimoStatus'), auto2 = $('#oAuto2'), auto = $('#oAuto');
  const sessions = new Map(); // file identity -> { state, url, project, error, frame }
  let tab = 'code';

  const eligible = () => !!invoke && !!S.file && S.file.kind === 'py' && !!S.file.marimo && !!S.file.handle && !!S.file.handle._nativeId;
  const current = () => (eligible() ? sessions.get(S.file.handle._nativeIdentity) : null);

  function render() {
    const ok = eligible();
    tabMarimo.hidden = !ok;
    if (!ok) tab = 'code';
    right.dataset.tab = tab;
    tabCode.setAttribute('aria-selected', String(tab === 'code'));
    tabMarimo.setAttribute('aria-selected', String(tab === 'marimo'));
    pane.hidden = tab !== 'marimo';
    auto2.checked = auto.checked;
    const s = current();
    for (const [, x] of sessions) if (x.frame) x.frame.hidden = x !== s;
    $('#marimoStop').hidden = !s;
    $('#marimoReload').hidden = !(s && s.state === 'ready');
    if (!s) status.textContent = '';
    else if (s.state === 'starting') status.textContent = 'Starting marimo. The first run can take a while while uv prepares the environment.';
    else if (s.state === 'error') status.textContent = s.error;
    else status.textContent = s.project;
    status.className = s && s.state === 'error' ? 'err' : '';
  }

  async function start() {
    if (!eligible()) return;
    const key = S.file.handle._nativeIdentity, id = S.file.handle._nativeId;
    let s = sessions.get(key);
    if (s && s.state !== 'error') return render();
    if (s && s.frame) s.frame.remove();
    s = { state: 'starting' }; sessions.set(key, s); render();
    try {
      const info = await invoke('marimo_start', { id });
      if (sessions.get(key) !== s) return; // stopped while starting
      const frame = document.createElement('iframe');
      frame.title = 'marimo'; frame.src = info.url; frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frames.appendChild(frame);
      Object.assign(s, { state: 'ready', url: info.url, project: info.project, frame });
    } catch (e) { if (sessions.get(key) === s) Object.assign(s, { state: 'error', error: String(e && e.message || e) }); }
    render();
  }
  async function stop() {
    if (!eligible()) return;
    const key = S.file.handle._nativeIdentity, s = sessions.get(key);
    sessions.delete(key);
    if (s && s.frame) s.frame.remove();
    try { await invoke('marimo_stop', { id: S.file.handle._nativeId }); } catch {}
    render();
  }

  tabCode.onclick = () => { tab = 'code'; render(); };
  tabMarimo.onclick = () => { tab = 'marimo'; render(); start(); };
  $('#marimoStop').onclick = stop;
  $('#marimoReload').onclick = () => { const s = current(); if (s && s.frame) s.frame.src = s.url; };
  $('#marimoWide').onclick = () => { main.dataset.wide = main.dataset.wide === '1' ? '0' : '1'; };
  auto2.onchange = () => { auto.checked = auto2.checked; auto.dispatchEvent(new Event('change')); };

  const base = renderFileBar;
  renderFileBar = function () { base(); render(); };
  render();
})();
