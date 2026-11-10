import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The real-data suite: read-only specs in e2e/prod-data/ whose expectations come from the production snapshot
 * in e2e/prod-snapshot/ at run time. Same database setup, server and `list` reporter as the main suite; they
 * skip themselves when there is no snapshot. Run with: npm run test:e2e:prod-data
 *
 * Real names and pay appear on screen, so: no HTML report (playwright-report/ is tracked in git), no video, no
 * trace; a failure screenshot goes to test-results/ (git-ignored) like the main suite's.
 */
export default defineConfig(base, {
  testDir: './e2e/prod-data',
  testIgnore: [],
  use: { trace: 'off', video: 'off', screenshot: 'only-on-failure' },
});
