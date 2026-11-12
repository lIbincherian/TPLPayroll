<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Setup, Dev Server and Validation

- **Fresh checkout or worktree**: `npm ci`, then `npx prisma generate` (the client in `src/generated/prisma` is gitignored). Env files are gitignored too: copy `.env` from the main checkout (or fill one in from `.env.example`). Never commit an env file.
- **Dev server on a given port**: `npx next dev -p <port>` (`npm run dev` uses port 3000). Pages that read data need the database in `.env`.
- **Validation** (what `factory/checks.sh` runs, mirroring CI's `lint-typecheck`, `unit` and `build` jobs and its migration-history guard): `npx prisma generate`, `npm run lint`, `npx tsc --noEmit`, `npm run test:run` (vitest, no watch), `npm run build`. CI's `migrations` and `e2e` jobs need PostgreSQL and run on the PR; locally, run E2E tests separately (see Testing Rules).

## Architecture Rules

- **Feature Slice Architecture**: Every feature built must follow the feature slice architecture. Code should be organized by feature (e.g., `features/[feature-name]/` or similar feature-centric directories) rather than by global technical concerns. Each feature slice should be self-contained, encapsulating its own components, hooks, business logic, API calls, and types.

## Testing Rules

- **Running E2E Tests**: When instructed to run E2E tests (`npm run test:e2e`), you must choose the appropriate workflow:
  - **Dev Workflow (Fast)**: If iterating on tests, ensure `npm run dev` is running, then execute `npm run test:e2e`. Playwright's `reuseExistingServer` will utilize the running dev server.
  - **Prod Workflow (Stable)**: If running the full test suite for verification or if encountering Next.js compiler panics, you MUST run `npm run build` first, ensure no dev server is running on port 3000, and then execute `npm run test:e2e` to test against the production build.
  - **Database Requirements**: A local PostgreSQL database must be actively running (e.g., via `npx prisma dev`) with the migrations applied (`npx prisma migrate deploy`). The `test:e2e` script handles its own DB seeding, and refuses to truncate or seed a non-local database.

## Database Migrations (Prisma Migrate)

The schema is managed with Prisma Migrate. `prisma/migrations/` is the source of truth for every database, and `0_init` is the baseline of what `prisma db push` used to apply.

- **Changing the schema**: edit `prisma/schema.prisma`, then run `npx prisma migrate dev --name <describe_the_change>` against a local database. Commit the generated `prisma/migrations/<timestamp>_<name>/` directory in the same PR as the schema change.
- **Never run `prisma db push`, `prisma migrate reset` or `prisma migrate dev` against Production or Staging** (the Supabase projects below). They are for throwaway local databases only. Shared environments change only through `prisma migrate deploy`.
- **Never edit, rename or delete a migration that has been merged.** Add a new migration instead. CI fails a PR that changes `schema.prisma` without a new migration directory, or that alters an existing `migration.sql`.
- **How migrations reach Production and Staging**: the Vercel build runs the `vercel-build` script (`prisma migrate deploy && prisma generate && next build`), so each build migrates the database of its own environment before the app ships. Production builds migrate `tpl-payroll`; Preview builds (every preview branch) migrate `tpl-payroll-stage`. `DIRECT_DATABASE_URL` must be set in both Vercel environments, because migrations cannot run through the transaction pooler (port `6543`). The `build` script stays migration-free so local and CI builds never touch a database.
- **Write migrations to be safe on a live database**: all Preview branches share the one staging database, and Production keeps serving the previous deployment until the new build succeeds. Prefer additive changes (add a column, backfill, then drop in a later migration).
- **Existing rows that a schema change must fix go in the same migration**: add the columns, then the data steps, then the unique indexes that need them, and make the data steps stop with `RAISE EXCEPTION` (naming what is wrong) instead of guessing. The F12 migration, `prisma/migrations/20261111072041_f12_etimeoffice_attendance`, does this for the approved-week and active-week keys. `scripts/backfill-approved-week-start.js` and `scripts/backfill-active-week-start.js` are no longer release steps: they are re-runnable repair tools, and `src/__tests__/db/f12-migration.db.test.ts` checks that the migration's data steps follow the same rules.
- **Releasing F12** is that one migration, applied by the deploy: a Preview build migrates `tpl-payroll-stage` first, the merge to `main` migrates `tpl-payroll`. Never `db push` it and never run the backfill scripts as a release step. The steps, expected counts and what to do if the migration stops are in `docs/ci-and-migrations.md` ("Releasing F12").
- **CI** (`.github/workflows/ci.yml`) runs `lint-typecheck`, `unit`, `migrations`, `build` and `e2e` on every PR to `main`. See `docs/ci-and-migrations.md` for the one-time per-environment baseline, the paused-staging caveat and the branch protection settings.

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
  - Set these five variables separately for Vercel **Production** and **Preview** before the F12 build deploys, so the first scheduled sync after the release finds them. All are server-only; never prefix them with `NEXT_PUBLIC_`, never log them, and never return them from an action or route.
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
audit and critique through it, report-only). Open Code Review runs twice: the
builder self-reviews with `/open-code-review:delegate-review` and fixes High
and Medium issues before pushing, then the code reviewer independently applies
the same house rules through the read-only `ocr delegate` CLI. Issue
labels use the triage vocabulary in `docs/agents/triage-labels.md`, plus
`factory` to queue an issue.

This machine is Windows: the factory scripts run with `python` (not
`python3`) and are patched for Windows file locking, UTF-8 I/O and Git Bash.
