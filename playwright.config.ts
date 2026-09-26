import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'webkit-compact-phone',
      use: {
        ...devices['iPhone 8'],
      },
    },
    {
      name: 'webkit-small-phone',
      use: {
        ...devices['iPhone 13 Mini'],
      },
    },
    {
      name: 'webkit-ipad',
      use: {
        ...devices['iPad Pro 11'],
      },
    },
  ],
});
