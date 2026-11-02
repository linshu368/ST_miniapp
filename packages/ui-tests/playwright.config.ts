import { defineConfig } from '@playwright/test';

const appUrl = `http://127.0.0.1:${Number(process.env.ST_UI_TEST_APP_PORT ?? '3130')}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  outputDir: '../../output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: '../../output/playwright/report', open: 'never' }]],
  use: {
    baseURL: appUrl,
    browserName: 'chromium',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    viewport: { width: 390, height: 844 },
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'android' },
    { name: 'narrow', grep: /@layout/, use: { viewport: { width: 320, height: 568 } } },
  ],
  webServer: {
    command: 'node preview.mjs --test',
    // Wait until Next and its local API proxy both answer, not just the fixture process.
    url: `${appUrl}/api/lobby-characters`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
