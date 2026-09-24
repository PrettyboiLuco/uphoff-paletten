import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/release',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
