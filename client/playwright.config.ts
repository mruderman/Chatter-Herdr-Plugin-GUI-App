import { defineConfig, devices } from '@playwright/test';
import { BASE_URL_ENV } from './e2e/harness/world';

export default defineConfig({
  testDir: 'e2e',
  // Builds the client and boots a real bridge over real Chatter (needs CHATTER_JS); see e2e/harness.
  globalSetup: './e2e/harness/global-setup.ts',
  // One bridge serves the whole run and specs count rows in its Chatter database, so one test at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Set by the global setup; the fixtures also pass it explicitly to every context they create.
    baseURL: process.env[BASE_URL_ENV],
    trace: 'retain-on-failure',
    // A missing element fails fast and names the selector instead of running into the test timeout.
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
