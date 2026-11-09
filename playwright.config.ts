import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const PORT = 47811;
const out = path.resolve('.tmp/m1');
// State now persists to state.json; start every run empty. Workers re-load this file, so only the main process clears it.
if (!process.env.TEST_WORKER_INDEX) fs.rmSync(path.join(out, 'state'), { recursive: true, force: true });

export default defineConfig({
  testDir: 'e2e',
  outputDir: path.join(out, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(out, 'report'), open: 'never' }],
    ['json', { outputFile: path.join(out, 'results.json') }],
  ],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    viewport: { width: 1600, height: 900 },
    trace: 'on',
    screenshot: 'on',
  },
  webServer: {
    command: `node server/main.ts --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/state`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    env: {
      WORKBENCH_FAKE_AGENT: '1',
      WORKBENCH_STATE_DIR: path.join(out, 'state'),
      FAKE_AGENT_LOG: path.join(out, 'fake-agent.jsonl'),
      // POST /api/open appends the command it would run here instead of starting anything.
      WORKBENCH_OPEN_LOG: path.join(out, 'open-log.jsonl'),
      WORKBENCH_EDITOR: 'C:\\fake\\Code.exe',
    },
  },
});
