const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

test.beforeEach(async ({ page }) => {
  // Tauri adds nonces to script-src and style-src at runtime. These override
  // unsafe-inline, so testing the unmodified config misses blocked style attrs.
  const nonce = 'dG9yY2gtY2FudmFzLXRlc3Q=';
  const csp = require('../../src-tauri/tauri.conf.json').app.security.csp
    .replace(/(script-src|style-src) ([^;]+)/g, `$1 $2 'nonce-${nonce}'`);
  await page.route('http://127.0.0.1:4173/**', async route => {
    const response = await route.fetch();
    const headers = { ...response.headers(), 'content-security-policy': csp };
    if (headers['content-type']?.includes('text/html')) {
      const body = (await response.text()).replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);
      await route.fulfill({ response, headers, body });
    } else await route.fulfill({ response, headers });
  });
  await page.addInitScript(() => {
    window.nativeCalls = [];
    window.savedFiles = {};
    window.cancelNextPick = false;
    window.tauriListeners = {};
    window.openedFiles = [];
    window.__TAURI__ = { event: { listen: async (name, fn) => { window.tauriListeners[name] = fn; } }, core: { invoke: async (command, args) => {
      window.nativeCalls.push({ command, args });
      if (command === 'native_pick') {
        if (window.cancelNextPick) { window.cancelNextPick = false; return null; }
        if (window.nextPickedFile) { const file = window.nextPickedFile; window.nextPickedFile = null; return file; }
        return { id: args.name || 'model.py', identity: '/test/' + (args.name || 'model.py'), name: args.name || 'model.py', kind: args.mode === 'directory' ? 'directory' : 'file' };
      }
      if (command === 'native_write') { window.savedFiles[args.id] = args.bytes; return; }
      if (command === 'native_read') return { bytes: window.savedFiles[args.id] || [], lastModified: (window.mtimes && window.mtimes[args.id]) || 123 };
      if (command === 'native_child') return { id: args.name, identity: '/test/' + args.name, name: args.name, kind: 'file' };
      if (command === 'marimo_start') return { url: 'http://127.0.0.1:4173/desktop.js', project: '/test/project' };
      if (command === 'marimo_stop') return;
      if (command === 'native_reopen') return window.reopenable && window.reopenable[args.identity] || null;
      if (command === 'native_take_opened') return window.openedFiles.splice(0);
      if (command === 'native_watch') { if (window.rejectWatch) throw new Error('watch unavailable'); return; }
      if (command === 'native_unwatch') return;
      throw new Error('Unexpected native command: ' + command);
    } } };
  });
});

test('editor loads offline, edits, persists, and exports through native bridge', async ({ page }) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(r.url()));
  await page.goto('http://127.0.0.1:4173');
  await expect(page.locator('.desktop-credit')).toContainText('Jesse Roberts');
  await expect(page.locator('#modelName')).toHaveValue('ResidualMLP');
  await expect(page.locator('.node').first()).toBeVisible();
  await expect(page.locator('#codeEdit')).toHaveCount(1);
  await expect(page.locator('#codeEdit')).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(page.locator('#bEditCode, #codeTa')).toHaveCount(0);
  await page.locator('#bNew').click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.locator('#modelName').fill('DesktopTest');
  await page.locator('#modelName').press('Tab');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('torchcanvas.graph.v1')).docs.some(g => g.name === 'DesktopTest'))).toBe(true);
  await page.reload();
  await expect(page.locator('#modelName')).toHaveValue('DesktopTest');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Object.keys(window.savedFiles))).toContain('desktop_test.py');
  const code = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['desktop_test.py'])));
  expect(code).toContain('class DesktopTest');
  expect(code).toContain('def forward');
  await page.locator('#zSvg').click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.savedFiles).some(n => n.endsWith('.svg')))).toBe(true);
  expect(errors).toEqual([]);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4173/'))).toBe(true);
  expect(requests.some(url => url.includes('examples/'))).toBe(false);
  await page.screenshot({ path: 'test-results/editor.png', fullPage: true });
});

test('training graph exports Python, ZIP, and a native folder', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.locator('#bMore').click();
  await page.locator('[data-act="paste"]').click();
  await page.locator('#imText').fill(fs.readFileSync('tests/training-graph.json', 'utf8'));
  await page.locator('#imGo').click();
  await expect(page.locator('#modelName')).toHaveValue('TrainingTest');
  await page.locator('#bExport').click();
  await page.locator('#exDlModel').click();
  await page.locator('#exDlTrain').click();
  await page.locator('#exZip').click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.savedFiles).length)).toBe(3);
  const saved = await page.evaluate(() => Object.fromEntries(Object.entries(window.savedFiles).map(([name, bytes]) => [name, new TextDecoder().decode(new Uint8Array(bytes))])));
  expect(saved['model.py']).toContain('class TrainingTest');
  expect(saved['train.py']).toContain('optimizer');
  expect(saved['training_test_training.zip']).toMatch(/^PK/);
  await page.locator('#exGo').click();
  await expect.poll(() => page.evaluate(() => window.nativeCalls.filter(x => x.command === 'native_child').length)).toBe(2);
});

test('native save cancellation writes nothing', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const result = await page.evaluate(async () => {
    window.cancelNextPick = true;
    return window.torchDesktop.save('cancel.py', 'should not be saved');
  });
  expect(result).toBe(false);
  expect(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'native_write'))).toEqual([]);
});

test('default model plots variance through a background worker', async ({ page }) => {
  const workers = [];
  page.on('worker', worker => workers.push(worker));
  await page.goto('http://127.0.0.1:4173');
  await page.locator('#zVar').click();
  await expect(page.locator('#varPane .var-plot')).toBeVisible();
  await expect(page.locator('#varPane')).not.toContainText("Couldn't compute");
  expect(workers).toHaveLength(1);
  await page.screenshot({ path: 'test-results/variance.png' });
});

test('variance also works when workers are unavailable', async ({ page }) => {
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto('http://127.0.0.1:4173');
  await page.locator('#zVar').click();
  await expect(page.locator('#varPane .var-plot')).toBeVisible();
  await expect(page.locator('#varPane')).not.toContainText("Couldn't compute");
});

for (const theme of ['light', 'dark']) {
  test(`plot lines, legend, and arrowheads retain theme colors in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('http://127.0.0.1:4173');
    await page.locator('#zVar').click();
    await expect(page.locator('#varPane .var-plot')).toBeVisible();
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const resolve = name => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(name).trim();
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return {
        expected: ['--stream', '--bwd'].map(resolve),
        strokes: [...document.querySelectorAll('.var-plot .ln')].map(p => getComputedStyle(p).stroke),
        lengths: [...document.querySelectorAll('.var-plot .ln')].map(p => p.getTotalLength()),
        pointColors: [...document.querySelectorAll('.var-plot .pt')].map(p => getComputedStyle(p).fill),
        legend: [...document.querySelectorAll('.var-legend i:not(.dash)')].map(p => getComputedStyle(p).borderTopColor),
        arrow: getComputedStyle(document.querySelector('#ar path')).fill,
        expectedArrow: resolve('--edge'),
      };
    });
    expect(colors.strokes).toEqual(colors.expected);
    expect(colors.lengths.every(length => length > 0)).toBe(true);
    expect(colors.pointColors.every(color => colors.expected.includes(color))).toBe(true);
    expect(colors.legend).toEqual(colors.expected);
    expect(colors.arrow).toBe(colors.expectedArrow);
    await page.screenshot({ path: `test-results/rendering-${theme}.png` });
  });
}

test('reopening the same file reuses its edited tab, including after reload', async ({ page }) => {
  const source = 'import torch.nn as nn\n\nclass DiskModel(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.fc = nn.Linear(4, 2)\n\n    def forward(self, x):\n        return self.fc(x)\n';
  async function openFile(id, identity) {
    await page.evaluate(({ id, identity, source }) => {
      window.nextPickedFile = { id, identity, name: 'model.py', kind: 'file' };
      window.savedFiles[id] = Array.from(new TextEncoder().encode(source));
    }, { id, identity, source });
    await page.locator('#bMore').click();
    await page.locator('[data-act="ofile"]').click();
  }
  await page.goto('http://127.0.0.1:4173');
  await openFile('folder-grant', '/project-a/model.py');
  await expect(page.locator('#modelName')).toHaveValue('DiskModel');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.locator('#modelName').fill('LocalEdits');
  await page.locator('#modelName').press('Tab');
  await expect(page.locator('#fileBar')).toContainText('unsaved changes');
  await page.locator('#bNew').click();
  await expect(page.locator('#tabstrip .ctab.model')).toHaveCount(3);
  await openFile('direct-grant', '/project-a/model.py');
  await expect(page.locator('#modelName')).toHaveValue('LocalEdits');
  await expect(page.locator('#tabstrip .ctab.model')).toHaveCount(3);
  await expect(page.locator('#fileBar')).toContainText('unsaved changes');

  await page.reload();
  await page.locator('#tabstrip .ctab.model').first().click();
  await openFile('new-process-grant', '/project-a/model.py');
  await expect(page.locator('#modelName')).toHaveValue('LocalEdits');
  await expect(page.locator('#tabstrip .ctab.model')).toHaveCount(3);
  await expect(page.locator('#fileBar')).toContainText('unsaved changes');

  // A matching basename is not sufficient: this is a different file.
  await openFile('other-directory', '/project-b/model.py');
  await expect(page.locator('#modelName')).toHaveValue('DiskModel');
  await expect(page.locator('#tabstrip .ctab.model')).toHaveCount(4);
});

test('marimo notebook: code panel and diagram edit the same file text', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const notebook = fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8');
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
  }, notebook);
  await page.keyboard.press('Control+o');
  await expect(page.locator('#fileBar')).toContainText('marimo');
  const editor = page.locator('#codeEdit');
  await expect(editor).toHaveValue(notebook);
  // Diagram edit: only the touched statement changes; comments, docstrings, extra methods stay.
  await page.evaluate(() => torchCanvas.commit(() => { torchCanvas.state.g.nodes.find(n => n.type === 'linear' && n.params.name === 'fc1').params.out = '32'; }));
  const edited = await editor.inputValue();
  expect(edited).toContain('self.fc1 = nn.Linear(n_in, 32)');
  for (const kept of ['# keep me', '"""Doc."""', 'def predict', '@app.class_definition', '"""Tiny net."""']) expect(edited).toContain(kept);
  await expect(page.locator('#fileBar')).toContainText('unsaved changes');
  // Code edit: the diagram follows while typing.
  await editor.fill(notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 5)'));
  await expect.poll(() => page.evaluate(() => torchCanvas.state.g.nodes.find(n => n.type === 'linear' && n.params.name === 'fc2').params.out)).toBe('5');
  // A syntax error is reported and the diagram is kept.
  await editor.fill(notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, '));
  await expect(page.locator('#warns .err')).toBeVisible();
  await expect.poll(() => page.evaluate(() => torchCanvas.state.g.nodes.some(n => n.params.name === 'fc2'))).toBe(true);
  await editor.fill(notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 7)'));
  await expect(page.locator('#warns .err')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/marimo.png' });
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['nb.py'])))).toContain('nn.Linear(16, 7)');
  const saved = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['nb.py'])));
  expect(saved).toBe(notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 7)'));
  expect(errors).toEqual([]);
});

test('marimo pane starts the notebook server, embeds it, and stops it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');
  await expect(page.locator('#tabMarimo')).toBeHidden();
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
  }, fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8'));
  await page.keyboard.press('Control+o');
  await expect(page.locator('#tabMarimo')).toBeVisible();
  await page.locator('#tabMarimo').click();
  await expect(page.locator('#marimoFrames iframe')).toHaveAttribute('src', 'http://127.0.0.1:4173/desktop.js');
  await expect(page.locator('#marimoStatus')).toHaveText('/test/project');
  await expect(page.locator('#codePane')).toBeHidden();
  // An iframe can exist and load while its grid track has zero height.
  for (const viewport of [{ width: 1440, height: 960 }, { width: 1080, height: 720 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const frame = await page.locator('#marimoFrames iframe').boundingBox();
      const right = await page.locator('.right').boundingBox();
      return !!frame && !!right && frame.width > 280 && frame.height > right.height * 0.6
        && Math.abs(frame.y + frame.height - right.y - right.height) < 2;
    }).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: 'test-results/marimo-pane.png' });
  expect(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'marimo_start').map(c => c.args))).toEqual([{ id: 'nb.py' }]);
  await page.locator('#tabCode').click();
  await expect(page.locator('#codeEdit')).toBeVisible();
  await expect(page.locator('#marimoFrames iframe')).toHaveCount(1);
  await page.locator('#tabMarimo').click();
  await page.locator('#marimoStop').click();
  await expect(page.locator('#marimoFrames iframe')).toHaveCount(0);
  expect(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'marimo_stop').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('marimo tab returns for a restored notebook tab after reopening its file', async ({ page }) => {
  const notebook = fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8');
  const open = async () => {
    await page.evaluate(text => {
      window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
      window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
    }, notebook);
    await page.keyboard.press('Control+o');
  };
  await page.goto('http://127.0.0.1:4173');
  await open();
  await expect(page.locator('#tabMarimo')).toBeVisible();
  await page.reload();
  await page.locator('#tabstrip .ctab.model').last().click();
  await open();
  await expect(page.locator('#tabMarimo')).toBeVisible();
  await expect(page.locator('#fileBar')).toContainText('marimo');
});

test('files the system opens with the app open in the editor', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(text => {
    window.savedFiles['finder.py'] = Array.from(new TextEncoder().encode(text));
    window.openedFiles.push({ id: 'finder.py', identity: '/test/finder.py', name: 'finder.py', kind: 'file' });
    return window.tauriListeners['torch-open']();
  }, fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8'));
  await expect(page.locator('#fileBar')).toContainText('finder.py');
  await expect(page.locator('#modelName')).toHaveValue('Net');
  await expect(page.locator('#tabMarimo')).toBeVisible();
});

test('dividers resize the side panes, persist, and reset on double-click', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const width = sel => page.locator(sel).evaluate(e => e.getBoundingClientRect().width);
  const before = await width('.right');
  const bar = await page.locator('#resizeRight').boundingBox();
  await page.mouse.move(bar.x + 2, bar.y + 200);
  await page.mouse.down();
  await page.mouse.move(bar.x - 298, bar.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await width('.right')) - (before + 300))).toBeLessThan(8);
  const leftBar = await page.locator('#resizeLeft').boundingBox();
  await page.mouse.move(leftBar.x + 2, leftBar.y + 200);
  await page.mouse.down();
  await page.mouse.move(leftBar.x + 62, leftBar.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await width('aside')) - 288)).toBeLessThan(8);
  await page.screenshot({ path: 'test-results/resized.png' });
  await page.reload();
  expect(Math.abs((await width('.right')) - (before + 300))).toBeLessThan(8);
  await page.locator('#resizeRight').dblclick();
  expect(Math.abs((await width('.right')) - before)).toBeLessThan(8);
  await page.locator('#resizeRight').focus();
  await page.keyboard.press('ArrowLeft');
  expect(Math.abs((await width('.right')) - (before + 24))).toBeLessThan(8);
});

test('Open / import lists up to five recent models, newest first, and hides the list when empty', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const recent = () => page.locator('.ctx .hd', { hasText: 'Recent' });
  await page.locator('#bMore').click();
  await expect(recent()).toHaveCount(0);
  const titles = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Escape');
    await page.locator('#bMore').click();
    const item = page.locator('.ctx [data-act^="lib:"]').nth(i);
    const category = item.locator('..').locator('..');
    if (!(await category.getAttribute('class')).split(' ').includes('open')) await category.locator('.cat-hd').click();
    titles.push((await item.locator('span').nth(1).evaluate(e => e.firstChild.textContent)).trim());
    await item.click();
  }
  await page.locator('#bMore').click();
  await expect(recent()).toHaveCount(1);
  const shown = await page.locator('.ctx [data-act^="recent:"]').evaluateAll(els => els.map(e => e.querySelector('span:nth-child(2)').firstChild.textContent.trim()));
  expect(shown).toEqual(titles.slice(1).reverse());
  await page.reload();
  await page.locator('#bMore').click();
  await expect(page.locator('.ctx [data-act^="recent:"]')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/recents.png' });
});

test('recents start from tabs that were already open', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(() => { window.savedFiles['old.py'] = Array.from(new TextEncoder().encode('import torch.nn as nn\n\nclass Old(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.fc = nn.Linear(2, 2)\n\n    def forward(self, x):\n        return self.fc(x)\n')); window.nextPickedFile = { id: 'old.py', identity: '/test/old.py', name: 'old.py', kind: 'file' }; });
  await page.keyboard.press('Control+o');
  await expect(page.locator('#modelName')).toHaveValue('Old');
  // Simulate the state before this feature existed: tabs saved, no recents key.
  await page.evaluate(() => localStorage.removeItem('torchcanvas.recents'));
  await page.reload();
  await page.locator('#bMore').click();
  await expect(page.locator('.ctx [data-act^="recent:"]')).toHaveCount(1);
  await expect(page.locator('.ctx [data-act^="recent:"]')).toContainText('old.py');
});

test('choosing a recent file reopens it without a dialog', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const source = 'import torch.nn as nn\n\nclass Again(nn.Module):\n    def __init__(self):\n        super().__init__()\n        self.fc = nn.Linear(2, 2)\n\n    def forward(self, x):\n        return self.fc(x)\n';
  await page.evaluate(text => { window.savedFiles['again.py'] = Array.from(new TextEncoder().encode(text)); window.nextPickedFile = { id: 'again.py', identity: '/test/again.py', name: 'again.py', kind: 'file' }; }, source);
  await page.keyboard.press('Control+o');
  await expect(page.locator('#modelName')).toHaveValue('Again');
  await page.locator('#fileBar button', { hasText: 'Close file' }).click();
  await page.locator('#tabstrip .ctab.model', { hasText: 'Again' }).locator('.x, [aria-label^="Close"]').first().click();
  await expect(page.locator('#modelName')).not.toHaveValue('Again');
  await page.evaluate(() => { window.reopenable = { '/test/again.py': { id: 'again.py', identity: '/test/again.py', name: 'again.py', kind: 'file' } }; window.nativeCalls.length = 0; });
  await page.locator('#bMore').click();
  await page.locator('.ctx [data-act^="recent:"]', { hasText: 'again.py' }).click();
  await expect(page.locator('#modelName')).toHaveValue('Again');
  await expect(page.locator('#fileBar')).toContainText('again.py');
  expect(await page.evaluate(() => window.nativeCalls.map(c => c.command))).not.toContain('native_pick');
});

test('the marimo tab stays selected when the file changes on disk', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const notebook = fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8');
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
  }, notebook);
  await page.keyboard.press('Control+o');
  await page.locator('#tabMarimo').click();
  await expect(page.locator('#marimoFrames iframe')).toHaveCount(1);
  // Another program (marimo) rewrites the file; the watcher reloads the diagram.
  await page.evaluate(text => { window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text)); }, notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 9)'));
  await page.evaluate(() => { window.mtimes = { 'nb.py': 456 }; });
  // The native watcher reports the change; the poll is skipped while the file is watched.
  await page.evaluate(() => window.tauriListeners['torch-file-changed']({ id: 'nb.py' }));
  await expect.poll(() => page.evaluate(() => torchCanvas.state.g.nodes.find(n => n.params.name === 'fc2').params.out), { timeout: 8000 }).toBe('9');
  await expect(page.locator('#tabMarimo')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#marimoPane')).toBeVisible();
  await expect(page.locator('#marimoFrames iframe')).toHaveCount(1);
});

// Native watching: the page asks for a watch on the open file, and a torch-file-changed event reloads it
// without waiting for the 5 s poll. The clock is controlled so the poll can be run on demand.
async function openNotebookWithClock(page) {
  await page.clock.install();
  await page.goto('http://127.0.0.1:4173');
  await page.clock.pauseAt(Date.now() + 1000);
  const notebook = fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8');
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
  }, notebook);
  await page.keyboard.press('Control+o');
  await expect(page.locator('#fileBar')).toContainText('nb.py');
  return notebook;
}
const nativeCallsNamed = (page, command) => page.evaluate(name => window.nativeCalls.filter(c => c.command === name).map(c => c.args.id), command);

test('opening a file asks the native side to watch it once', async ({ page }) => {
  await openNotebookWithClock(page);
  await expect.poll(() => page.evaluate(() => window.__torchNativeWatch)).toBe(true);
  expect(await nativeCallsNamed(page, 'native_watch')).toEqual(['nb.py']);
  // Redraws of the same file do not ask again.
  await page.evaluate(() => torchCanvas.commit(() => { torchCanvas.state.g.nodes.find(n => n.type === 'linear' && n.params.name === 'fc1').params.out = '32'; }));
  await page.evaluate(() => torchCanvas.commit(() => { torchCanvas.state.g.nodes.find(n => n.type === 'linear' && n.params.name === 'fc1').params.out = '48'; }));
  expect(await nativeCallsNamed(page, 'native_watch')).toEqual(['nb.py']);
});

test('a torch-file-changed event reloads the diagram without waiting for the poll', async ({ page }) => {
  const notebook = await openNotebookWithClock(page);
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.mtimes = { 'nb.py': 456 };
  }, notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 9)'));
  await page.evaluate(() => window.tauriListeners['torch-file-changed']({ id: 'nb.py' }));
  await expect.poll(() => page.evaluate(() => torchCanvas.state.g.nodes.find(n => n.params.name === 'fc2').params.out), { timeout: 2000 }).toBe('9');
});

test('the 5 s poll is skipped while the active file is watched', async ({ page }) => {
  await openNotebookWithClock(page);
  await expect.poll(() => page.evaluate(() => window.__torchNativeWatch)).toBe(true);
  const reads = await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'native_read').length);
  await page.clock.runFor(10000);
  expect(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'native_read').length)).toBe(reads);
});

test('the 5 s poll keeps running when native_watch fails', async ({ page }) => {
  await page.clock.install();
  await page.goto('http://127.0.0.1:4173');
  await page.clock.pauseAt(Date.now() + 1000);
  await page.evaluate(() => { window.rejectWatch = true; });
  await page.evaluate(text => {
    window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'nb.py', identity: '/test/nb.py', name: 'nb.py', kind: 'file' };
  }, fs.readFileSync('tests/fixtures/marimo-net.py', 'utf8'));
  await page.keyboard.press('Control+o');
  await expect(page.locator('#fileBar')).toContainText('nb.py');
  await expect.poll(() => nativeCallsNamed(page, 'native_watch')).toEqual(['nb.py']);
  expect(await page.evaluate(() => window.__torchNativeWatch)).toBeFalsy();
  const reads = await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'native_read').length);
  await page.clock.runFor(5000);
  await expect.poll(() => page.evaluate(() => window.nativeCalls.filter(c => c.command === 'native_read').length)).toBeGreaterThan(reads);
});

test('auto-save is on by default and remembers being turned off', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  expect(await page.evaluate(() => document.querySelector('#oAuto').checked)).toBe(true);
  await page.evaluate(() => { const box = document.querySelector('#oAuto'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(await page.evaluate(() => localStorage.getItem('torchcanvas.autosave'))).toBe('0');
  await page.reload();
  expect(await page.evaluate(() => document.querySelector('#oAuto').checked)).toBe(false);
});

async function openBranchedGate(page) {
  await page.clock.install();
  await page.goto('http://127.0.0.1:4173');
  await page.clock.pauseAt(Date.now() + 1000);
  const source = fs.readFileSync('tests/fixtures/branched-gate.py', 'utf8');
  await page.evaluate(text => {
    window.savedFiles['gate.py'] = Array.from(new TextEncoder().encode(text));
    window.nextPickedFile = { id: 'gate.py', identity: '/test/gate.py', name: 'gate.py', kind: 'file' };
  }, source);
  await page.keyboard.press('Control+o');
  await expect(page.locator('#fileBar')).toContainText('gate.py');
  return source;
}

test('an incomplete gate never auto-saves or manually saves over working Python', async ({ page }) => {
  const original = await openBranchedGate(page);
  await page.evaluate(() => torchCanvas.commit(() => {
    const gate = Object.values(torchCanvas.state.root.blocks)[0].graph;
    const multiply = gate.nodes.find(n => n.type === 'binop' && n.params.op === '*');
    window.disconnectedGateEdge = gate.edges.find(e => e.to === multiply.id && e.port === 1);
    gate.edges = gate.edges.filter(e => e !== window.disconnectedGateEdge);
  }));
  await expect(page.locator('#warns')).toContainText('connect input 2');
  await page.clock.runFor(1500);
  await page.keyboard.press('Control+s');
  expect(await nativeCallsNamed(page, 'native_write')).toEqual([]);
  expect(await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['gate.py'])))).toBe(original);
  await page.evaluate(() => torchCanvas.commit(() => {
    const gate = Object.values(torchCanvas.state.root.blocks)[0].graph;
    gate.edges.push(window.disconnectedGateEdge);
    gate.nodes.find(n => n.params.name === 'left').params.bias = false;
  }));
  await expect(page.locator('#warns li.err')).toHaveCount(0);
  await page.clock.runFor(1500);
  await expect.poll(() => nativeCallsNamed(page, 'native_write')).toEqual(['gate.py']);
  const saved = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['gate.py'])));
  expect(saved).not.toContain('return None');
  expect(saved).toContain('bias=False');
  expect(saved).toContain('TRAINING_SETTING = 123');
});

test('a completed gate can recover an older return-None file and auto-save it', async ({ page }) => {
  const original = await openBranchedGate(page);
  const broken = original
    .replace('        self.norm = nn.LayerNorm(width)\n', '')
    .replace('        self.left = nn.Linear(width, width)\n', '')
    .replace('        n = self.norm(x)\n        return self.left(n) * self.right(n)', '        return None');
  await page.evaluate(text => {
    window.savedFiles['gate.py'] = Array.from(new TextEncoder().encode(text));
    torchCanvas.state.file.text = text;
    torchCanvas.state.file.diskText = text;
    torchCanvas.commit(() => {
      const gate = Object.values(torchCanvas.state.root.blocks)[0].graph;
      gate.nodes.find(n => n.params.name === 'left').params.bias = false;
    });
  }, broken);
  await expect(page.locator('#warns li.err')).toHaveCount(0);
  await expect(page.locator('#codeEdit')).not.toHaveValue(/return None/);
  await page.clock.runFor(1500);
  await expect.poll(() => nativeCallsNamed(page, 'native_write')).toEqual(['gate.py']);
  const saved = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.savedFiles['gate.py'])));
  expect(saved).not.toContain('return None');
  expect(saved).toContain("return 'keep this method'");
  expect(saved).toContain('def predict(self, x):');
  expect(saved).toContain('TRAINING_SETTING = 123');
});

// press a button drawn on the canvas; looked up at the moment of the press, since the canvas redraws often
const press = (page, selector) => page.evaluate(sel => document.querySelector(sel).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })), selector);

test('a block can be drawn open in place, inside its frame, without touching the model', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');
  await page.locator('#bMore').click();
  await page.locator('[data-act="lib:networks/02_residual_mlp_block.json"]').evaluate(b => b.click());
  await expect(page.locator('.node.t-block')).toHaveCount(1);
  const state = () => page.evaluate(() => {
    const S = torchCanvas.state, use = S.g.nodes.find(n => n.type === 'block');
    return { use: use.id, nodes: S.g.nodes.length, edges: S.g.edges.length, code: document.querySelector('#codeEdit').value, json: JSON.stringify(S.root) };
  });
  const before = await state();
  await expect(page.locator('.pvf')).toHaveCount(0);
  // the Inside button on the box draws its layers where it stood
  await press(page, '.node [data-peek]');
  await expect(page.locator('.pvf')).toHaveCount(1);
  await expect(page.locator('.pv-title')).toHaveText('GatedBlock × 3');
  await expect(page.locator('.node.t-block')).toHaveCount(0);
  const inner = await page.locator('.node.pv').count();
  expect(inner).toBeGreaterThan(5);
  expect(await page.locator('.node.pv[data-node]').count()).toBe(0);
  // what is drawn inside the frame is flat (nothing to hover or click), and the frame drags like any other block
  await expect(page.locator('.node.pv .n-box').first()).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('.eg.pv .edge-hit').first()).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('.pvf .pv-box')).toHaveCSS('cursor', 'grab');
  // connections to the block end at anchors on its frame; the ones inside are drawn, not editable
  await expect(page.locator('.pvanc')).toHaveCount(2);
  const into = await page.evaluate(() => { const S = torchCanvas.state, use = S.g.nodes.find(n => n.type === 'block'); return S.g.edges.find(e => e.to === use.id).id; });
  await expect(page.locator(`[data-edge="${into}"]`)).toHaveCount(1);
  await expect(page.locator('.eg.pv [data-edge]')).toHaveCount(0);
  // the connection into the block can be reshaped while it is open, and keeps its shape when folded
  const grab = await page.evaluate(id => { const el = document.querySelector(`[data-edge="${id}"]`), p = el.getPointAtLength(el.getTotalLength() / 2), m = el.getScreenCTM(); return [m.a * p.x + m.e, m.d * p.y + m.f]; }, into);
  await page.mouse.move(grab[0], grab[1]); await page.mouse.down(); await page.mouse.move(grab[0] + 25, grab[1] + 25, { steps: 4 }); await page.mouse.up();
  expect(await page.evaluate(id => !!torchCanvas.state.g.edges.find(e => e.id === id).route, into)).toBe(true);
  await page.evaluate(id => { delete torchCanvas.state.g.edges.find(e => e.id === id).route; }, into);
  await page.evaluate(() => torchCanvas.commit(() => {}));
  // the stream runs on into the block's first layer and out of its last one: no Input or Output arrow of the block is drawn
  await expect(page.locator('.node.pv.t-io')).toHaveCount(0);
  await expect(page.locator('.pvb [data-openblock]')).toHaveCount(1);
  // nothing in the model changed
  expect(await state()).toEqual(before);
  // a click on one of its layers selects the block use and shows the block's details
  const at = await page.locator('.node.pv .n-box').first().boundingBox();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(page.locator('.pvf.sel')).toHaveCount(1);
  await expect(page.locator('#f-peek')).toBeChecked();
  // the inspector's checkbox and the frame's Fold button both put it back
  await page.locator('#f-peek').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('.pvf')).toHaveCount(0);
  await expect(page.locator('.node.t-block')).toHaveCount(1);
  await press(page, '.node [data-peek]');
  await expect(page.locator('.pvf')).toHaveCount(1);
  await press(page, '.pvb [data-peek]');
  await expect(page.locator('.pvf')).toHaveCount(0);
  expect(await state()).toEqual(before);
  expect(errors).toEqual([]);
});

test('blocks inside blocks open in their own frames, and a layer in a frame cannot be wired from', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');
  await page.locator('#bMore').click();
  await page.locator('[data-act="lib:networks/22_ijepa_small.json"]').evaluate(b => b.click());
  await expect(page.locator('#modelName')).toHaveValue('IJEPA');
  await expect(page.locator('.node.t-block').first()).toBeVisible();
  for (let round = 0; round < 3; round++) {
    const n = await page.locator('.node [data-peek]').count();
    for (let i = 0; i < n; i++) await press(page, '.node [data-peek]');
  }
  await expect(page.locator('.node.t-block')).toHaveCount(0);
  expect(await page.locator('.pvf').count()).toBeGreaterThan(3);
  await expect(page.locator('.node.pv .port')).toHaveCount(0);
  await expect(page.locator('.pv [data-lindim], .pv [data-out]')).toHaveCount(0);
  // every layer sits inside some frame
  const outside = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('.pvf .pv-box')].map(r => r.getBoundingClientRect());
    return [...document.querySelectorAll('.node.pv .n-box')].filter(b => { const r = b.getBoundingClientRect(); return !frames.some(f => r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1); }).length;
  });
  expect(outside).toBe(0);
  await page.locator('#zFit').click();
  expect(errors).toEqual([]);
});


test('reloading an identical block under its saved name reuses the library entry', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  const source = fs.readFileSync('tests/fixtures/aliased-block-width.py', 'utf8');
  async function open(name, text) {
    await page.evaluate(({name, text}) => {
      window.savedFiles[name] = Array.from(new TextEncoder().encode(text));
      window.nextPickedFile = { id: name, identity: '/test/' + name, name, kind: 'file' };
    }, {name, text});
    await page.keyboard.press('Control+o');
    await expect(page.locator('#fileBar')).toContainText(name);
  }
  await open('first.py', source);
  const count = await page.evaluate(() => Object.keys(torchCanvas.state.libBlocks).length);
  await open('renamed.py', source.replaceAll('Block19', 'Block24'));
  expect(await page.evaluate(() => Object.keys(torchCanvas.state.libBlocks).length)).toBe(count);
  expect(await page.evaluate(() => Object.values(torchCanvas.state.root.blocks).map(b => b.name))).toEqual(['Block24']);
  await open('again.py', source);
  expect(await page.evaluate(() => Object.keys(torchCanvas.state.libBlocks).length)).toBe(count);
});
