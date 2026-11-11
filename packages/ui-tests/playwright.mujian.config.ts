import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const site =
  process.env.MUJIAN_SITE_DIR ||
  fileURLToPath(new URL('../../../mujian-drama-site', import.meta.url));
export default defineConfig({
  testDir: './tests',
  testMatch: 'mujian.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 5000 },
  outputDir: '../../output/playwright/mujian',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3188',
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 3188 --bind 127.0.0.1',
    cwd: site,
    url: 'http://127.0.0.1:3188',
    reuseExistingServer: false,
  },
});
