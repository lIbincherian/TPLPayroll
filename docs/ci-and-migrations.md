# CI and database migrations

How pull requests are checked, and how schema changes reach Production and Staging.

## What CI runs

`.github/workflows/ci.yml` runs on every pull request to `main` and on every push to `main`. A newer push to the same PR cancels the older run. The workflow uses no secrets: Supabase and eTimeOffice variables are empty, so the app uses its in-process mock storage and mock eTimeOffice API, and every job talks only to its own throwaway Postgres.

| Job (required check) | What it does |
| --- | --- |
| `lint-typecheck` | `prisma generate`, `npm run lint`, `tsc --noEmit` |
| `unit` | `prisma generate`, `npm run test:run` (Vitest) |
| `migrations` | On an empty Postgres 16: `prisma migrate deploy`, then two drift checks (the migration history must reproduce `schema.prisma`, and the migrated database must match it). On PRs it also fails if `schema.prisma` changed without a new migration directory, or if an existing `migration.sql` was edited, renamed or deleted. |
| `build` | `npm run build` (`prisma generate && next build`). Needs no database. |
| `e2e` | Postgres 16 service, `prisma migrate deploy`, `npx playwright install --with-deps chromium`, `npm run build`, `npm run test:e2e`. Uploads `test-results/` only when the job fails. |

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

## Preview builds and the paused staging project

Every Preview build runs `prisma migrate deploy` against `tpl-payroll-stage`. If that Supabase project is paused (Supabase pauses inactive projects), the build cannot reach the database and fails with `P1001`. Restore the project in the Supabase dashboard, wait for it to come back, then redeploy the preview.

All Preview branches share the one staging database, so a PR's migration is applied to staging as soon as its preview builds, before the PR merges. Two open PRs with conflicting migrations can break each other's previews; if staging ends up in a bad state it can be reset, since it holds no real data.

## Branch protection (repo owner)

Settings to apply on `main`:

- require a pull request before merging (no direct pushes);
- require these status checks: `lint-typecheck`, `unit`, `migrations`, `build`, `e2e`;
- require branches to be up to date before merging;
- no force pushes, no branch deletion;
- apply to administrators as well (remove `enforce_admins` below if you want an escape hatch).

This needs admin rights on the repository. Apply it once CI has run on a PR so the check names exist:

```bash
gh api --method PUT "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection" --input - <<'JSON'
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

`required_approving_review_count: 0` requires a pull request without requiring a second person to approve it. The call replaces the whole protection rule for `main`, so re-run it with the full body if you change one setting.
