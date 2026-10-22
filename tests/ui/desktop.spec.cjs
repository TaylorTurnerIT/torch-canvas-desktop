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
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.nativeCalls.push({ command, args });
      if (command === 'native_pick') {
        if (window.cancelNextPick) { window.cancelNextPick = false; return null; }
        if (window.nextPickedFile) { const file = window.nextPickedFile; window.nextPickedFile = null; return file; }
        return { id: args.name || 'model.py', identity: '/test/' + (args.name || 'model.py'), name: args.name || 'model.py', kind: args.mode === 'directory' ? 'directory' : 'file' };
      }
      if (command === 'native_write') { window.savedFiles[args.id] = args.bytes; return; }
      if (command === 'native_read') return { bytes: window.savedFiles[args.id] || [], lastModified: 123 };
      if (command === 'native_child') return { id: args.name, identity: '/test/' + args.name, name: args.name, kind: 'file' };
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
