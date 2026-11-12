<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Setup, Dev Server and Validation

- **Fresh checkout or worktree**: `npm ci`, then `npx prisma generate` (the client in `src/generated/prisma` is gitignored). Env files are gitignored too: copy `.env` from the main checkout (or fill one in from `.env.example`). Never commit an env file.
- **Dev server on a given port**: `npx next dev -p <port>` (`npm run dev` uses port 3000). Pages that read data need the database in `.env`.
- **Validation** (what `factory/checks.sh` runs): `npm run lint`, `npx tsc --noEmit`, `npm run test:run` (vitest, no watch), `npm run build`. E2E tests (`npm run test:e2e`) need a local PostgreSQL and are run separately (see Testing Rules).

## Architecture Rules

- **Feature Slice Architecture**: Every feature built must follow the feature slice architecture. Code should be organized by feature (e.g., `features/[feature-name]/` or similar feature-centric directories) rather than by global technical concerns. Each feature slice should be self-contained, encapsulating its own components, hooks, business logic, API calls, and types.

## Testing Rules

- **Running E2E Tests**: When instructed to run E2E tests (`npm run test:e2e`), you must choose the appropriate workflow:
  - **Dev Workflow (Fast)**: If iterating on tests, ensure `npm run dev` is running, then execute `npm run test:e2e`. Playwright's `reuseExistingServer` will utilize the running dev server.
  - **Prod Workflow (Stable)**: If running the full test suite for verification or if encountering Next.js compiler panics, you MUST run `npm run build` first, ensure no dev server is running on port 3000, and then execute `npm run test:e2e` to test against the production build.
  - **Database Requirements**: A local PostgreSQL database must be actively running (e.g., via `npx prisma dev`). The `test:e2e` script handles its own DB seeding.

## Database & Environment Separation Rules

- **Supabase Projects Separation**:
  - **Production Environment**:
    - Project Name: `tpl-payroll`
    - Supabase Project Ref: `aacgdygsjeflnenqbdgv`
    - Target Environment in Vercel: **Production**
  - **Staging / Preview Environment**:
    - Project Name: `tpl-payroll-stage`
    - Supabase Project Ref: `zuwybpjeeiypmwhtlvbe`
    - Target Environment in Vercel: **Preview** (across all preview branches)

- **Required Environment Variables**:
  The application utilizes the server-side REST API for Supabase storage and prisma client for DB connection. Both environments require the following environment variables:
  - `DATABASE_URL`: Transaction pooler URL (host `aws-1-ap-south-1.pooler.supabase.com`, port `6543`, containing `?pgbouncer=true`).
  - `DIRECT_DATABASE_URL`: Direct database connection URL (host `aws-1-ap-south-1.pooler.supabase.com`, port `5432`).
  - `SUPABASE_URL`: `https://[project-ref].supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY`: Service role API key for storage access.

- **Unused Variables**:
  - Do not use or configure client-side `NEXT_PUBLIC_SUPABASE_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_URL` environment variables in Vercel as the app does not load any client-side Supabase libraries.

- **eTimeOffice Attendance Sync (F12)**:
  - Attendance enters only via eTimeOffice sync (F12); the Excel upload is removed.
  - Set these five variables separately for Vercel **Production** and **Preview**. All are server-only; never prefix them with `NEXT_PUBLIC_`, never log them, and never return them from an action or route.
    - `ETIMEOFFICE_CORPORATE_ID`, `ETIMEOFFICE_USERNAME`, `ETIMEOFFICE_PASSWORD`: the eTimeOffice API login. Only `src/features/attendance-sync/services/etimeoffice.client.ts` reads them.
    - `ETIMEOFFICE_BASE_URL`: optional, defaults to `https://api.etimeoffice.com/api/`.
    - `CRON_SECRET`: Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>` to `/api/cron/attendance-sync` (schedule in `vercel.json`, `30 0 * * 4` UTC). The route rejects every request when it is missing or wrong, and when `CRON_SECRET` is unset.
  - The in-app mock eTimeOffice API (`/api/mock-etimeoffice/...`) is active only when `ETIMEOFFICE_CORPORATE_ID` is unset and `VERCEL` is unset (local dev and e2e). Local `.env` needs `CRON_SECRET=local-cron-secret` for e2e and leaves `ETIMEOFFICE_*` unset. On Vercel with no login configured, every sync fails with "eTimeOffice login isn't configured."

## Software factory

`/factory run` builds every open GitHub issue labeled `factory` through
intake → spec → build → gate → review → approve, one PR per issue. State is in
`factory/jobs/` (gitignored); `factory/bin/job` is its only writer. Checks:
`factory/checks.sh`. Dashboard: `cd factory && python -m http.server`, then
open http://localhost:8000/dashboard.html.

Each job works in its own git worktree, a full checkout of the repo at
`.worktrees/<job-id>` (gitignored). A tool run from the repo root that doesn't
read `.gitignore` sees those copies too; exclude `.worktrees/` in its config
(ESLint, `tsconfig.json` and Vitest already do).

Factory agents follow the same conventions as the `feature-pipeline` skill:
every UI change is built with the `impeccable` skill (the UI and UX reviewers
audit and critique through it, report-only), and the code reviewer applies the
Open Code Review house rules through the read-only `ocr delegate` CLI. Issue
labels use the triage vocabulary in `docs/agents/triage-labels.md`, plus
`factory` to queue an issue.

This machine is Windows: the factory scripts run with `python` (not
`python3`) and are patched for Windows file locking, UTF-8 I/O and Git Bash.
