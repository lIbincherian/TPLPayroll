import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'list',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    // Next.js reads .env.local, which may point at staging or hold the real eTimeOffice login. Next never
    // overrides a variable that is already set, so pin these to the local test setup: empty Supabase keys
    // keep the mock storage, an empty eTimeOffice login keeps the in-app mock API. DATABASE_URL and
    // DIRECT_DATABASE_URL already come from .env via dotenv above.
    env: {
      ...(process.env as Record<string, string>),
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      ETIMEOFFICE_CORPORATE_ID: '',
      ETIMEOFFICE_USERNAME: '',
      ETIMEOFFICE_PASSWORD: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120000,
  },
});
