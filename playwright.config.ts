import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
dotenv.config({ path: path.resolve(__dirname, '.env') });

// The app's port. Default 3000; set E2E_PORT to run the production server somewhere else (the build must then
// be made with NEXT_PUBLIC_APP_URL=http://localhost:<port>, it is inlined at build time). E2E_REUSE_SERVER=0
// always starts a fresh server, =1 always reuses a running one; unset reuses one outside CI.
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;
const reuseExistingServer =
  process.env.E2E_REUSE_SERVER === '0' ? false : process.env.E2E_REUSE_SERVER === '1' ? true : !process.env.CI;

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * The suite runs on a LOCAL database that global setup (e2e/utils/global-setup.ts) fills with real production
 * data from e2e/prod-snapshot/ when it exists, or leaves empty. Each spec adds its own data in the test
 * namespace (e2e/utils/test-namespace.ts) and deletes only that; global teardown proves the base is untouched.
 * The real-data specs in e2e/prod-data/ run separately: npm run test:e2e:prod-data.
 *
 * Reporters: only `list`. The HTML reporter would write playwright-report/, which is tracked in git, and a
 * real-data run must never put names or pay into a tracked folder. Screenshots and traces go to test-results/
 * (git-ignored).
 */
export default defineConfig({
  testDir: './e2e',
  /* The real-data specs have their own config (playwright.prod-data.config.ts). */
  testIgnore: ['**/prod-data/**'],
  globalSetup: './e2e/utils/global-setup.ts',
  globalTeardown: './e2e/utils/global-teardown.ts',
  outputDir: './test-results',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* One worker: every spec shares one database and cleans its own namespace. */
  workers: 1,
  /* The local database and the real-data base make pages heavier than a bare one. */
  timeout: 60000,
  expect: { timeout: 10000 },
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'list',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: `node node_modules/next/dist/bin/next start -p ${port}`,
    url: baseURL,
    reuseExistingServer,
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
