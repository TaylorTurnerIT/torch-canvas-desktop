
// Files the system opens with this app (Finder, `open -a`) arrive as scoped handles from the native side.
(() => {
  if (!window.torchDesktop || !window.__TAURI__) return;
  const invoke = window.__TAURI__.core.invoke;
  async function take() {
    let list = [];
    try { list = await invoke('native_take_opened'); } catch {}
    for (const info of list) await openHandle(window.torchDesktop.handle(info), info.name);
  }
  const events = window.__TAURI__.event;
  if (events && events.listen) events.listen('torch-open', take);
  take();
})();
