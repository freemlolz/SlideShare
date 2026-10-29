import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
});
