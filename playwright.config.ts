import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e.spec.ts', 'interactions.spec.ts', 'manual-editing.spec.ts', 'measurement-modes.spec.ts', 'region-recognition.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['html', { outputFolder: `${import.meta.dirname}/playwright-report`, open: 'never' }]],
  outputDir: `${import.meta.dirname}/test-results`,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    channel: process.env.BROWSER_CHANNEL || undefined,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  webServer: {
    command: 'npm run start',
    env: { REVIEWER_PORT: '4318' },
    url: 'http://127.0.0.1:4318',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
