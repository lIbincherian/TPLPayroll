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
  - **Database Requirements**: A local PostgreSQL database must be actively running (e.g., via `npx prisma dev`) with the migrations applied (`npx prisma migrate deploy`). The `test:e2e` script handles its own DB seeding, and refuses to truncate or seed a non-local database.

## Database Migrations (Prisma Migrate)

The schema is managed with Prisma Migrate. `prisma/migrations/` is the source of truth for every database, and `0_init` is the baseline of what `prisma db push` used to apply.

- **Changing the schema**: edit `prisma/schema.prisma`, then run `npx prisma migrate dev --name <describe_the_change>` against a local database. Commit the generated `prisma/migrations/<timestamp>_<name>/` directory in the same PR as the schema change.
- **Never run `prisma db push`, `prisma migrate reset` or `prisma migrate dev` against Production or Staging** (the Supabase projects below). They are for throwaway local databases only. Shared environments change only through `prisma migrate deploy`.
- **Never edit, rename or delete a migration that has been merged.** Add a new migration instead. CI fails a PR that changes `schema.prisma` without a new migration directory, or that alters an existing `migration.sql`.
- **How migrations reach Production and Staging**: the Vercel build runs the `vercel-build` script (`prisma migrate deploy && prisma generate && next build`), so each build migrates the database of its own environment before the app ships. Production builds migrate `tpl-payroll`; Preview builds (every preview branch) migrate `tpl-payroll-stage`. `DIRECT_DATABASE_URL` must be set in both Vercel environments, because migrations cannot run through the transaction pooler (port `6543`). The `build` script stays migration-free so local and CI builds never touch a database.
- **Write migrations to be safe on a live database**: all Preview branches share the one staging database, and Production keeps serving the previous deployment until the new build succeeds. Prefer additive changes (add a column, backfill, then drop in a later migration).
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

