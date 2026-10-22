
// Draggable dividers between the palette, the canvas, and the right pane.
(() => {
  const main = document.querySelector('.main'), KEY = 'torchcanvas.panes';
  const bars = { left: $('#resizeLeft'), right: $('#resizeRight') };
  let size = { left: null, right: null };
  try { size = Object.assign(size, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const MIN = { left: 160, right: 280, center: 320 };
  const bounds = () => {
    const total = main.getBoundingClientRect().width, bar = 10;
    return {
      left: [MIN.left, Math.max(MIN.left, total - (size.right || 340) - MIN.center - bar)],
      right: [MIN.right, Math.max(MIN.right, total - (size.left || 228) - MIN.center - bar)],
    };
  };
  function apply() {
    for (const side of ['left', 'right']) {
      if (size[side]) main.style.setProperty('--' + side + '-w', size[side] + 'px');
      else main.style.removeProperty('--' + side + '-w');
    }
  }
  let notify = 0;
  const changed = () => { cancelAnimationFrame(notify); notify = requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); };
  function set(side, px) {
    const [lo, hi] = bounds()[side];
    size[side] = Math.round(Math.min(hi, Math.max(lo, px)));
    apply(); changed();
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(size)); } catch {} };
  const current = side => (side === 'left' ? document.querySelector('aside') : document.querySelector('.right')).getBoundingClientRect().width;
  for (const side of ['left', 'right']) {
    const bar = bars[side];
    bar.addEventListener('pointerdown', e => {
      e.preventDefault(); bar.setPointerCapture(e.pointerId); bar.classList.add('drag');
      const rect = main.getBoundingClientRect();
      const move = ev => set(side, side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX);
      const up = () => { bar.classList.remove('drag'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); save(); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', () => { size[side] = null; apply(); save(); changed(); });
    bar.addEventListener('keydown', e => {
      const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (!dir) return;
      e.preventDefault(); set(side, current(side) + (side === 'left' ? 1 : -1) * dir * 24); save();
    });
  }
  apply();
  window.addEventListener('resize', () => { for (const side of ['left', 'right']) if (size[side]) { const [lo, hi] = bounds()[side]; if (size[side] > hi) size[side] = hi; } apply(); });
})();
