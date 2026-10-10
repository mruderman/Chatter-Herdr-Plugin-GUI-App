import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: {
    // Set by the harness once it has booted a bridge; left unset when specs are only listed.
    baseURL: process.env.E2E_BASE_URL,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
