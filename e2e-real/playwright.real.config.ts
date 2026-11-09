// Smoke test against the real claude / codex / agy CLIs (uses a little quota; run on purpose only):
//   npx vite build && npx playwright test -c e2e-real/playwright.real.config.ts
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const PORT = 47813;
const out = path.resolve('.tmp/m2/real');

export default defineConfig({
  testDir: '.',
  testMatch: 'real-smoke.spec.ts',
  outputDir: path.join(out, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: path.join(out, 'report'), open: 'never' }], ['json', { outputFile: path.join(out, 'results.json') }]],
  timeout: 180_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', viewport: { width: 1600, height: 900 }, trace: 'on', screenshot: 'on' },
  webServer: {
    command: `node server/main.ts --port ${PORT}`,
    cwd: path.resolve('.'),
    url: `http://127.0.0.1:${PORT}/api/state`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { WORKBENCH_STATE_DIR: path.join(out, 'state') },
  },
});
