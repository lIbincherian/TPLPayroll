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
  ]),
  // The attendance feature is below payroll-correction, never the other way round. The page that
  // mounts a correction passes the correction actions in as props.
  {
    files: ['src/features/attendance-sync/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/payroll-correction/*', '**/payroll-correction/*'],
              message: 'attendance-sync must not import payroll-correction; inject actions from the page.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
