# End-to-end tests

The suite runs against a **local** database (never Supabase) in two layers:

1. **The base.** Global setup (`utils/global-setup.ts`) replaces the local database with real production data from
   `e2e/prod-snapshot/` (git-ignored: names, bank details, pay; made once by `scripts/export-prod-snapshot.js`).
   Without the snapshot it starts empty, so the suite still works for anyone who does not have the data.
2. **Each spec's own data**, added on top in a test namespace and removed again by that spec. The specs never assert
   a global total, and nothing in the base is changed: global teardown checks every table's row count and a hash
   of its rows against what setup loaded and fails the run if anything differs.

## Run

```
npm run build                  # the suite tests the production build
npm run test:e2e               # layered suite (database reset, base loaded, specs, base verified)
npm run test:e2e:prod-data     # real-data suite (e2e/prod-data), read-only, needs the snapshot
```

Needs a local Postgres in `DIRECT_DATABASE_URL` (for example `npx prisma dev`). Setup brings its schema to the committed
migrations with `prisma migrate deploy` (the command CI and Vercel use; nothing happens when none is pending), and **its
data is replaced** on every run; setup refuses any host that is not localhost, before it changes anything. A database made
earlier with `prisma db push` has no migration history and is refused: reset it with `npx prisma migrate reset --force`
(local only) or use a fresh one. CI starts from an empty migrated database, so it has no snapshot and an empty base.

Useful variables: `E2E_PORT` (app port, default 3000; build with
`NEXT_PUBLIC_APP_URL=http://localhost:<port>`), `E2E_REUSE_SERVER=0|1`, `E2E_REAL_DATA=0` (empty base even when the
snapshot exists). Only the `list` reporter is used: `playwright-report/` is tracked in git, and a real-data run must
not write names or pay there. Failure screenshots go to `test-results/` (git-ignored).

## Fast base load

Loading the snapshot row by row took minutes. `scripts/seed-local-from-snapshot.js` now does one
`INSERT ... SELECT FROM jsonb_populate_recordset(...)` per table, copies the result once into the `e2e_base` schema, and
every later run restores that copy server-side (about 2 s). `prisma dev` (PGlite) cannot clone a database
(`CREATE DATABASE ... TEMPLATE` is accepted but all names map to one database), so the in-database copy is the template.
It is rebuilt automatically when the snapshot, `prisma/schema.prisma` or the backfill scripts change.

## The test namespace (`utils/test-namespace.ts`)

| What | Rule |
| --- | --- |
| Employees | ID `E2E-<TAG>-<9000+n>`; cleanup deletes by the `E2E-` prefix. No real ID ends in 9000-9999, so a test code never matches a real employee. |
| eTimeOffice codes | `9000+n` (the mock builders refuse anything else). The mock's own default codes `0001-0003` are only used by the one spec that proves the request window. |
| Weeks | **Pre-history** (before 2026-05-01), **far future** (from 2040), and the **reserved weeks**: the last completed and the current Thursday-Wednesday week and later. Global setup deletes the base's rows there (computed from the real clock, IST), so the cron and Pull now specs, which always target "now", never collide with a later snapshot. |

The week lists show only the newest 26 weeks, which the real data fills. A spec that looks at a week's **row** in a list
therefore uses the reserved weeks (always at the top) or the far future; a spec that opens a week by URL uses a pre-history
week. Seeds refuse a week or an employee ID outside the namespace. Setup also fails loudly if a refreshed snapshot ever
overlaps it.

Counts that include real employees (the punch grid lists every active employee as "No punches", the approval summary
lists them as "left out") are derived at run time (`baseGridEmployeeCount`), never hard-coded.

## Real-data suite (`prod-data/`)

Read-only specs whose expectations are computed from the snapshot files when they run (`prod-data/snapshot.ts`): no
name, ID or amount is written in a spec, and none is printed. They skip themselves without the snapshot. The two read
paths that still write (the settings page upserts its row; the slips download rebuilds a run's invoice snapshots) put
the base rows back afterwards from the `e2e_base` copy.
