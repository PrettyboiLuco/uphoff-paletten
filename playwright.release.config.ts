import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/release',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'VITE_ALLOW_LOCAL_ONLY=true VITE_FIREBASE_API_KEY= VITE_FIREBASE_AUTH_DOMAIN= VITE_FIREBASE_PROJECT_ID= VITE_FIREBASE_APP_ID= VITE_RECAPTCHA_ENTERPRISE_SITE_KEY= npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
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
