const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.nativeCalls = [];
    window.savedFiles = {};
    window.cancelNextPick = false;
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.nativeCalls.push({ command, args });
      if (command === 'native_pick') {
        if (window.cancelNextPick) { window.cancelNextPick = false; return null; }
        return { id: args.name || 'model.py', name: args.name || 'model.py', kind: args.mode === 'directory' ? 'directory' : 'file' };
      }
      if (command === 'native_write') { window.savedFiles[args.id] = args.bytes; return; }
      if (command === 'native_read') return { bytes: window.savedFiles[args.id] || [], lastModified: 123 };
      if (command === 'native_child') return { id: args.name, name: args.name, kind: 'file' };
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
  await page.locator('#modelName').fill('DesktopTest');
  await page.locator('#modelName').press('Tab');
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
