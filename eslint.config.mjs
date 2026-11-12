import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Software factory job worktrees (full checkouts of the repo).
    ".worktrees/**",
    // Local agent tooling (skills, helpers, their own worktrees); not app code.
    ".claude/**",
    ".claude-flow/**",
    ".agents/**",
    ".gemini/**",
    ".codex/**",
    ".swarm/**",
    // Generated reports.
    "playwright-report/**",
    "test-results/**",
  ]),
  // The attendance feature is below every payroll slice (correction, generation, adjustments, ...),
  // never the other way round. The page that mounts a correction passes the correction actions in as props.
  {
    files: ['src/features/attendance-sync/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/payroll-*/*', '**/payroll-*/*'],
              message: 'attendance-sync must not import payroll-correction or any other payroll slice; inject what it needs from the page.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
