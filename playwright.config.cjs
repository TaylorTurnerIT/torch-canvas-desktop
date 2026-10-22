const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  workers: 1,
  use: { browserName: 'webkit', viewport: { width: 1440, height: 960 } },
  webServer: { command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory web', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
});
