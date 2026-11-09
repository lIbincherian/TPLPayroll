<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

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

