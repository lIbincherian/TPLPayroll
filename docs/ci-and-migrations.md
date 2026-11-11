# CI and database migrations

How pull requests are checked, and how schema changes reach Production and Staging.

## What CI runs

`.github/workflows/ci.yml` runs on every pull request to `main` and on every push to `main`. A newer push to the same PR cancels the older run. The workflow uses no secrets: Supabase and eTimeOffice variables are empty, so the app uses its in-process mock storage and mock eTimeOffice API, and every job talks only to its own throwaway Postgres.

| Job (required check) | What it does |
| --- | --- |
| `lint-typecheck` | `prisma generate`, `npm run lint`, `tsc --noEmit` |
| `unit` | `prisma generate`, `npm run test:run` (Vitest). The real-database tests under `src/__tests__/db` skip themselves here (no `F12_TEST_DB_URL`); run them locally against a throwaway migrated database. |
| `migrations` | On an empty Postgres 16: `prisma migrate deploy`, then two drift checks (the migration history must reproduce `schema.prisma`, and the migrated database must match it). On PRs it also fails if `schema.prisma` changed without a new migration directory, or if an existing `migration.sql` was edited, renamed or deleted. |
| `build` | `npm run build` (`prisma generate && next build`). Needs no database. |
| `e2e` | Postgres 16 service, `prisma migrate deploy`, `npx playwright install --with-deps chromium`, `npm run build`, `npm run test:e2e`. The suite's global setup (`e2e/utils/global-setup.ts`) applies the migrations again (a no-op here), starts from an empty base, and refuses a database that is not on localhost. Uploads `test-results/` only when the job fails. |

Do not rename these jobs or add path filters to the triggers: branch protection matches the job names, and a skipped required check blocks a merge.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name <describe_the_change>` against a **local** database.
3. Commit the generated `prisma/migrations/<timestamp>_<name>/` directory in the same PR.

Prisma 7 reads the shadow database that `migrate dev` needs from `SHADOW_DATABASE_URL` (see `prisma.config.ts`). A `prisma dev` instance is not safe to use without it: `migrate dev` then fails with P3006 once the database already has tables. Every `prisma dev` instance has its own shadow database; its URL is inside the `api_key` of the `prisma+postgres://` URL that `npx prisma dev ls` prints:

```bash
npx prisma dev ls    # copy the api_key value of the DATABASE_URL, then:
node -e "console.log(JSON.parse(Buffer.from(process.argv[1], 'base64url')).shadowDatabaseUrl)" "<api_key value>"
```

Set the printed URL as `SHADOW_DATABASE_URL` for that shell and `migrate dev` runs normally.

Never run `prisma db push`, `prisma migrate reset` or `prisma migrate dev` against Production or Staging. Merged migrations are immutable; fix a mistake with a new migration.

## How migrations reach Production and Staging

`package.json` has a `vercel-build` script:

```
prisma migrate deploy && prisma generate && next build
```

- **Which command Vercel runs.** Vercel's [Configuring a Build](https://vercel.com/docs/builds/configure-a-build#build-command) page only says that for Next.js it runs the `build` script. The `vercel-build` precedence comes from the open source builder (`@vercel/next`, `packages/next/src/index.ts`), which resolves the script with `getScriptName(pkg, ['vercel-build', 'now-build', 'build'])` and runs a configured Build Command in preference to any script. So `vercel-build` wins over `build` unless a Build Command is set: an Override in Project Settings > Build and Deployment, or `buildCommand` in `vercel.json` ([docs](https://vercel.com/docs/project-configuration/vercel-json#buildcommand): it overrides the Build Command in Project Settings and the `build` script). Keep that Override off. The first deployment after merging should show `prisma migrate deploy` output near the top of its build log; if it does not, something is overriding the command.
- **Which database.** Production builds migrate `tpl-payroll`; Preview builds (every preview branch) migrate `tpl-payroll-stage`. Both Vercel environments need `DIRECT_DATABASE_URL` (the session-mode host on port `5432`). Migrations cannot run through the transaction pooler on port `6543`.
- **Failure behaviour.** `migrate deploy` runs before `next build`. If it fails, the build fails and the previous deployment keeps serving.
- **Local and CI builds** use `npm run build`, which does not migrate.

## One-time baseline per environment (before this PR merges)

Production and Staging were created with `prisma db push`, so they already contain every table that `0_init` creates. Each one must be told that `0_init` is already applied. **Do this for both environments before merging this PR.**

Production's `_prisma_migrations` table already exists and is empty. Staging may not have one yet; `migrate resolve` creates it.

From a checkout of this branch (it needs `prisma/migrations/`), staging first, then production, in PowerShell:

```powershell
$env:DIRECT_DATABASE_URL = '<DIRECT_DATABASE_URL of that environment>'   # session host, port 5432
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code   # read-only; expect "No difference detected."
npx prisma migrate resolve --applied 0_init     # check the printed host first: it must be the environment you mean
npx prisma migrate status                       # expect "Database schema is up to date!"
Remove-Item Env:DIRECT_DATABASE_URL
```

Do not paste the URL into a file or a commit. `migrate resolve --applied` only records `0_init` in `_prisma_migrations`; it does not run any SQL. If the `migrate diff` step reports a difference, stop: the environment drifted from `schema.prisma` and `0_init` is not a faithful baseline for it.

If the PR merges first, the build fails at `prisma migrate deploy` before anything is changed in the schema:

- a database without a `_prisma_migrations` table fails with `P3005` (schema not empty); baseline it and redeploy;
- Production, which has the empty table, fails with `P3018` (`type "DayOfWeek" already exists`) and records `0_init` as a failed migration. Every later deploy then fails with `P3009` until you run `npx prisma migrate resolve --rolled-back 0_init` followed by `npx prisma migrate resolve --applied 0_init`, then redeploy.

Both outcomes were reproduced against a local database while preparing this PR.

**Production vs `0_init`.** Production's columns, indexes and enum match `0_init` exactly (compared read-only, category by category). One representational difference: production holds `Employee_employeeId_key` as a UNIQUE *constraint*, `0_init` creates it as a unique *index*. Both enforce the same rule on the same index. A future migration that changes it must use `ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_employeeId_key"` before `DROP INDEX IF EXISTS`, so it runs on both.

## Releasing F12 (eTimeOffice attendance)

F12 ships as one migration, `prisma/migrations/20261111072041_f12_etimeoffice_attendance`, applied by the deploy like any other. There is no `prisma db push` and no backfill script to run by hand. Staging goes first because every Preview build migrates `tpl-payroll-stage`, then the merge to `main` migrates `tpl-payroll`.

**What it does**, in one transaction (all of it applies, or none of it):

1. adds the sync columns to `AttendanceUpload`. Existing rows get `source = 'EXCEL'` from the column default and keep their status and file columns, and `fileName` and `fileType` may now be empty;
2. adds `PayrollRun.approvedWeekStart` and the tables `AttendancePunch`, `AttendanceEmployeeDecision`, `AttendanceCodeException` and `PayrollCorrectionSession`;
3. data steps. It stops with an error that lists the weeks if any week has more than one `APPROVED`/`REVISED` payroll run. Otherwise it sets `approvedWeekStart` on every approved run, keeps one active attendance row per week (APPROVED/READY first, then REVIEW, then the rest; a row with punches or attendance records beats an empty one; then the newest `uploadedAt`, then the larger id), deactivates the others, and sets `activeWeekStart` on every active row;
4. creates the two unique indexes on those keys (after the data is consistent), the other indexes and the foreign keys;
5. drops `AttendanceUploadSession`, which only held short-lived upload sessions for the Excel upload that this release removes.

The settings week start is not part of it: the first read of the settings after the release changes a non-Thursday value to Thursday at runtime.

**Before the release**

- The one-time baseline above is done for both environments: `npx prisma migrate status` against each shows `20261111072041_f12_etimeoffice_attendance` as the only pending migration.
- `ETIMEOFFICE_CORPORATE_ID`, `ETIMEOFFICE_USERNAME`, `ETIMEOFFICE_PASSWORD`, optionally `ETIMEOFFICE_BASE_URL`, and `CRON_SECRET` are set separately for Vercel Production and Preview (see `AGENTS.md`), and `DIRECT_DATABASE_URL` is set in both.
- Any Excel-era week that still needs payroll has been run: after the release it cannot start payroll.
- Optional read-only check against Production (Supabase SQL editor): it must return no rows, because the migration refuses to run otherwise.

  ```sql
  select "payrollWeekStartDate"::date::text as week, count(*) as approved_runs
  from "PayrollRun" where status in ('APPROVED', 'REVISED')
  group by 1 having count(*) > 1;
  ```

**Order**

1. Open or update the PR. Its Preview build runs `prisma migrate deploy` against Staging. The build log shows `Applying migration 20261111072041_f12_etimeoffice_attendance` and `All migrations have been successfully applied`. Staging holds its own data, so this also proves the migration against data other than the rehearsal's.
2. Check Staging with the queries below, and `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (read-only; it must report "No difference detected.").
3. Merge. The Production build runs the same migration against `tpl-payroll`; check it the same way.

**Counts to expect.** A rehearsal on a copy of the production data (taken 2026-11-10: 24 payroll runs, 54 attendance uploads, 40,621 attendance records, one expired upload session) gave: `approvedWeekStart` set on all 24 runs (24 APPROVED/REVISED), `activeWeekStart` set on 24 rows (the 24 active weeks), no attendance row deactivated, all 54 rows `source = 'EXCEL'`, `AttendanceUploadSession` dropped together with its one row, and every other row in every other table identical to before. Production will have more rows by the time you deploy, but these relations hold:

```sql
select count(*) filter (where status in ('APPROVED', 'REVISED')) as approved, count("approvedWeekStart") as keyed
from "PayrollRun";                                                    -- approved = keyed
select count(*) filter (where "isActiveForPayrollWeek") as active, count("activeWeekStart") as keyed,
       count(*) filter (where source = 'EXCEL') as excel, count(*) as total
from "AttendanceUpload";                                              -- active = keyed, excel = total until the first sync
```

**If the migration stops.** The build fails at `prisma migrate deploy` and the previous deployment keeps serving. The transaction rolls back, so the schema and every row are as they were, but Prisma records the migration as failed, and every later deploy fails with `P3009` until you resolve it.

- *The guard* (`F12 migration stopped, nothing was changed. These weeks have more than one APPROVED/REVISED payroll run ...`): the message lists each week with its run ids. Decide by hand which run is the real one (the one whose revision is current and that has invoice snapshots) and change the other so that it is no longer `APPROVED`/`REVISED`, then continue below. Do not guess.
- *Any other error*: fix the cause the error message names, then continue below.

Then mark the failed attempt rolled back, and redeploy (run the build again):

```powershell
$env:DIRECT_DATABASE_URL = '<DIRECT_DATABASE_URL of that environment>'   # session host, port 5432
npx prisma migrate resolve --rolled-back 20261111072041_f12_etimeoffice_attendance
Remove-Item Env:DIRECT_DATABASE_URL
```

Both the refusal and this recovery were reproduced against a local copy of the production data: a duplicated approved run made the migration fail with every table unchanged, `P3009` followed on the next deploy, and after the duplicate was removed and the attempt marked rolled back the migration applied.

**While the build runs.** Between the migration finishing and the new deployment going live (about the length of `next build`), the previous deployment is still serving against the new schema. Its Excel upload page fails in that window (its session table is gone), and an attendance row or payroll run it creates gets no week key. Do not upload attendance or approve payroll in the old app during the release. If something was written anyway, `node scripts/backfill-approved-week-start.js` and `node scripts/backfill-active-week-start.js` (idempotent; they print the target host first) set the missing keys.

**The backfill scripts** `scripts/backfill-approved-week-start.js` and `scripts/backfill-active-week-start.js` are not release steps any more. The migration does their work, and `src/__tests__/db/f12-migration.db.test.ts` checks that its data steps follow the same rules. They stay as re-runnable repair tools, and `npm run seed:local-from-snapshot` and the e2e real-data base use them to put old production data into the new schema.

## Preview builds and the paused staging project

Every Preview build runs `prisma migrate deploy` against `tpl-payroll-stage`. If that Supabase project is paused (Supabase pauses inactive projects), the build cannot reach the database and fails with `P1001`. Restore the project in the Supabase dashboard, wait for it to come back, then redeploy the preview.

All Preview branches share the one staging database, so a PR's migration is applied to staging as soon as its preview builds, before the PR merges. Two open PRs with conflicting migrations can break each other's previews; if staging ends up in a bad state, check what data it holds before resetting it.

## Branch protection (repo owner)

Settings to apply on `main`:

- require a pull request before merging (no direct pushes);
- require these status checks: `lint-typecheck`, `unit`, `migrations`, `build`, `e2e`;
- require branches to be up to date before merging;
- no force pushes, no branch deletion;
- apply to administrators as well (set `enforce_admins` to `false` below if you want an escape hatch; the field is required, so don't remove it).

This needs admin rights on the repository. Apply it once CI has run on a PR so the check names exist.

PowerShell:

```powershell
$repo = gh repo view --json nameWithOwner -q .nameWithOwner
@'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-typecheck", "unit", "migrations", "build", "e2e"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
'@ | gh api --method PUT "repos/$repo/branches/main/protection" --input -
```

bash (macOS, Linux, Git Bash):

```bash
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api --method PUT "repos/$repo/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-typecheck", "unit", "migrations", "build", "e2e"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Check it took effect: `gh api "repos/$repo/branches/main/protection" -q .required_status_checks.contexts` should list the five checks.

`required_approving_review_count: 0` requires a pull request without requiring a second person to approve it. The call replaces the whole protection rule for `main`, so re-run it with the full body if you change one setting.
