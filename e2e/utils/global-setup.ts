/* eslint-disable @typescript-eslint/no-require-imports */
import 'dotenv/config'
import path from 'path'
import { execFileSync } from 'child_process'
import { Client } from 'pg'
import { computeReservedFrom, deleteTestNamespace } from './test-data'
import { FAR_FUTURE_START, PRE_HISTORY_END, TEST_EMPLOYEE_PREFIX } from './test-namespace'

// Playwright global setup: gets the local database into the state every e2e run starts from.
//
//   1. refuse any database that is not on localhost (this setup replaces the data in it);
//   2. bring the schema to the committed migrations with `prisma migrate deploy` (a no-op when nothing is pending);
//   3. load the BASE: real production data from e2e/prod-snapshot/ when it exists (copied from a prepared
//      in-database copy, a few seconds), otherwise an empty database, so the suite still works for anyone
//      without the data;
//   4. check the base does not use the test namespace (see test-namespace.ts);
//   5. reserve the test weeks: delete the base's data for the last completed and the current Thursday-Wednesday
//      week and every week after, so the cron and Pull now specs, which target "now", never collide with a
//      snapshot taken later;
//   6. remember what the base looks like (a hash per table), so the global teardown can prove that every spec
//      left it untouched.
//
// Each spec then adds its own data in the test namespace and deletes only that.

const ROOT = path.resolve(__dirname, '..', '..')
const loader = require(path.join(ROOT, 'scripts', 'seed-local-from-snapshot.js')) as {
  assertLocal(url: string | undefined): string
  snapshotAvailable(): boolean
  loadViaBase(url: string, opts: { backfill: boolean; log: (line: string) => void }): Promise<{ path: string }>
}

const log = (line: string) => console.log(`[e2e setup] ${line}`)

export function databaseUrl(): string {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('E2E: set DIRECT_DATABASE_URL (or DATABASE_URL) to a local database.')
  return url
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000 })
  await client.connect()
  return client
}

/**
 * Apply the committed migrations with `prisma migrate deploy`, the same command Vercel and CI use, so the e2e
 * database is shaped by the migrations and not by schema.prisma. A database that has nothing pending is left
 * alone. A database that was not created by migrations (an old `prisma db push` one) or that holds a failed
 * migration is refused with the way out; this setup never drops or rewrites a schema.
 */
function ensureSchema(url: string): 'migrated' {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      stdio: 'pipe',
    })
  } catch (error) {
    const out = `${(error as { stdout?: Buffer }).stdout ?? ''}${(error as { stderr?: Buffer }).stderr ?? ''}`
    if (/P3005/.test(out)) {
      throw new Error(
        'E2E: this local database has tables but no migration history (it was made with `prisma db push`). Reset it so the ' +
          'migrations create it: `npx prisma migrate reset --force` (local only, drops all its data), or use a fresh database.',
      )
    }
    const tail = out.trim().split('\n').slice(-12).join('\n')
    if (/P3009|P3018/.test(out)) {
      throw new Error(
        'E2E: a migration failed on this local database. Reset it (`npx prisma migrate reset --force`, local only) or fix the ' +
          `cause and run \`npx prisma migrate resolve --rolled-back <name>\`.\n${tail}`,
      )
    }
    throw new Error(`E2E: \`prisma migrate deploy\` failed.\n${tail}`)
  }
  return 'migrated'
}

async function publicTables(client: Client): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
  )
  return rows.map((r) => r.table_name as string)
}

/** A count and a content hash per public table: what "the base is untouched" means. */
export async function fingerprintTables(client: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const table of await publicTables(client)) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM "${table}" x`,
    )
    out[table] = `${rows[0].n}:${rows[0].h}`
  }
  return out
}

/** The base must not already use the test namespace, or cleaning the namespace would delete real data. */
async function assertNamespaceFree(client: Client): Promise<void> {
  const problems: string[] = []
  const count = async (sql: string, params: unknown[] = []) => Number((await client.query(sql, params)).rows[0].n)

  const prefixed = await count(`SELECT count(*) AS n FROM "Employee" WHERE "employeeId" ILIKE $1`, [`${TEST_EMPLOYEE_PREFIX}%`])
  if (prefixed > 0) problems.push(`${prefixed} employee ID(s) start with "${TEST_EMPLOYEE_PREFIX}"`)

  const testRange = await count(`SELECT count(*) AS n FROM "Employee" WHERE "employeeId" ~ '(^|[^0-9])9[0-9]{3}$'`)
  if (testRange > 0) problems.push(`${testRange} employee(s) have a trailing number in 9000-9999 (the test range)`)

  const weekQueries: Array<[string, string]> = [
    ['AttendanceUpload', 'payrollWeekStartDate'],
    ['PayrollRun', 'payrollWeekStartDate'],
    ['PayrollAdjustment', 'startPayrollWeekStartDate'],
    ['PayrollAdjustmentApplication', 'payrollWeekStartDate'],
  ]
  for (const [table, column] of weekQueries) {
    const n = await count(
      `SELECT count(*) AS n FROM "${table}" WHERE "${column}" < $1::timestamp OR "${column}" >= $2::timestamp`,
      [PRE_HISTORY_END, FAR_FUTURE_START],
    )
    if (n > 0) problems.push(`${n} ${table} row(s) are dated before ${PRE_HISTORY_END} or from ${FAR_FUTURE_START} (the test week zones)`)
  }

  if (problems.length > 0) {
    throw new Error(
      `The real-data base overlaps the e2e test namespace, so the specs could not tell their rows from real ones:\n  - ${problems.join('\n  - ')}\n` +
        'Change PRE_HISTORY_END / FAR_FUTURE_START / TEST_NUMBER_BASE in e2e/utils/test-namespace.ts.',
    )
  }
}

export default async function globalSetup(): Promise<void> {
  const started = Date.now()
  const url = databaseUrl()
  const host = loader.assertLocal(url)
  const port = new URL(url).port
  log(`database ${host}${port ? `:${port}` : ''} (local). Its data is replaced for this run.`)

  log(`schema: ${ensureSchema(url)} (prisma migrate deploy)`)

  const useRealData = loader.snapshotAvailable() && process.env.E2E_REAL_DATA !== '0'
  let baseKind: 'real-data' | 'empty'
  if (useRealData) {
    const result = await loader.loadViaBase(url, { backfill: true, log })
    log(`base: real production snapshot (${result.path})`)
    baseKind = 'real-data'
  } else {
    const client = await connect(url)
    try {
      const tables = await publicTables(client)
      await client.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
    } finally {
      await client.end()
    }
    log(
      loader.snapshotAvailable()
        ? 'base: empty (E2E_REAL_DATA=0)'
        : 'base: empty (no e2e/prod-snapshot/manifest.json; the real-data specs will skip)',
    )
    baseKind = 'empty'
  }

  const client = await connect(url)
  try {
    await assertNamespaceFree(client)

    const reservedFrom = computeReservedFrom()
    await deleteTestNamespace((sql, params) => client.query(sql, params), { reservedFrom })
    log(`reserved weeks: from ${reservedFrom} (last completed week) onward, plus everything before ${PRE_HISTORY_END} and from ${FAR_FUTURE_START}`)

    const fingerprint = await fingerprintTables(client)
    process.env.E2E_BASE_KIND = baseKind
    process.env.E2E_RESERVED_FROM = reservedFrom
    process.env.E2E_RUN_STARTED_AT = new Date().toISOString()
    process.env.E2E_BASE_FINGERPRINT = JSON.stringify(fingerprint)
    const rows = Object.values(fingerprint).reduce((sum, v) => sum + Number(v.split(':')[0]), 0)
    log(`base ready: ${Object.keys(fingerprint).length} tables, ${rows} rows, in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } finally {
    await client.end()
  }
}
