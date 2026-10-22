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
    const item = page.locator('.ctx [data-act^="lib:"]').nth(i + (i > 0 ? 0 : 0));
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
  // Another program (marimo) rewrites the file; the poll reloads the diagram.
  await page.evaluate(text => { window.savedFiles['nb.py'] = Array.from(new TextEncoder().encode(text)); }, notebook.replace('nn.Linear(16, n_out)', 'nn.Linear(16, 9)'));
  await page.evaluate(() => { window.mtimes = { 'nb.py': 456 }; });
  await expect.poll(() => page.evaluate(() => torchCanvas.state.g.nodes.find(n => n.params.name === 'fc2').params.out), { timeout: 8000 }).toBe('9');
  await expect(page.locator('#tabMarimo')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#marimoPane')).toBeVisible();
  await expect(page.locator('#marimoFrames iframe')).toHaveCount(1);
});
