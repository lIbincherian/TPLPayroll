// @vitest-environment node
//
// Real-database test for the data steps of the F12 migration (prisma/migrations/*_f12_etimeoffice_attendance).
//
//   F12_TEST_DB_URL=postgres://postgres:postgres@localhost:51214/template1?sslmode=disable npx vitest run src/__tests__/db/f12-migration.db.test.ts
//
// Skipped (and reported as skipped) when F12_TEST_DB_URL is not set, so the normal unit run needs no database. The URL
// must point at localhost and at a database that already has the migrations applied (`prisma migrate deploy`).
//
// The data steps are the SQL between the BEGIN and END markers in the migration file. Each test runs that exact text on
// throwaway copies of the four tables it touches, in a schema that is created inside a transaction and rolled back at the
// end: the block names its tables without a schema, so `search_path` points it at the copies. No real row is read, written
// or locked, and rows other tests leave in the real tables cannot trip the block's guard. The copies carry the columns and
// defaults but no indexes, which is the state the block meets in the migration (before the unique indexes exist); the tests
// create those unique indexes afterwards to prove the data is fit for them.
//
// The rules asserted here are the ones scripts/backfill-*.js assert in f12-fix-round.db.test.ts: the two implementations
// are meant to agree.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal
const ROOT = path.resolve(__dirname, '../../..')
const SCHEMA = 'f12mig_copy'

if (URL !== '' && !isLocal) {
  describe('F12 migration data steps (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F12_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

/** The migration's data steps: the text between the markers, exactly as the migration runs it. */
function dataSteps(): string {
  const dir = path.join(ROOT, 'prisma', 'migrations')
  const found = fs.readdirSync(dir).filter((name) => name.endsWith('_f12_etimeoffice_attendance'))
  const [name] = found
  if (found.length !== 1 || !name) throw new Error(`Expected one *_f12_etimeoffice_attendance migration, found ${found.length}.`)
  const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n')
  const begin = sql.indexOf('-- BEGIN F12 DATA STEPS')
  const end = sql.indexOf('-- END F12 DATA STEPS')
  if (begin < 0 || end < begin) throw new Error('The BEGIN/END F12 DATA STEPS markers are missing from the migration.')
  return sql.slice(begin, end)
}

/** Thursdays from 2034 (no other test and no real data uses them), as YYYY-MM-DD. */
const week = (n: number) => new Date(Date.UTC(2034, 0, 5) + n * 7 * 86400000).toISOString().slice(0, 10)

/** Run `fn` against fresh copies of the tables the data steps use; everything is rolled back afterwards. */
async function withCopies<T>(fn: (c: Client, notices: string[]) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: URL })
  const notices: string[] = []
  client.on('notice', (notice) => notices.push(notice.message ?? ''))
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    for (const table of ['PayrollRun', 'AttendanceUpload', 'AttendancePunch', 'AttendanceRecord']) {
      await client.query(`CREATE TABLE ${SCHEMA}."${table}" (LIKE public."${table}" INCLUDING DEFAULTS)`)
    }
    // The data steps name their tables without a schema, so they resolve to the copies first.
    await client.query(`SET LOCAL search_path = ${SCHEMA}, public`)
    return await fn(client, notices)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

const insertRun = (c: Client, id: string, weekStart: string, status: string, key: string | null) =>
  c.query(
    `INSERT INTO "PayrollRun" (id, "payrollWeekStartDate", "payrollWeekEndDate", status, "approvedWeekStart", "approvedAt",
                               "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable")
     VALUES ($1, $2::timestamp, $2::timestamp + interval '6 days', $3, $4::timestamp, now(), 0, 0, 0, 0, 0)`,
    [id, weekStart, status, key],
  )

const insertUpload = (
  c: Client,
  id: string,
  weekStart: string,
  status: string,
  uploadedAt: string,
  opts: { active?: boolean; key?: string | null } = {},
) =>
  c.query(
    `INSERT INTO "AttendanceUpload" (id, "payrollWeekStartDate", "payrollWeekEndDate", "payrollWeekSource", status,
                                     "isActiveForPayrollWeek", "activeWeekStart", "uploadedAt")
     VALUES ($1, $2::timestamp, $2::timestamp + interval '6 days', 'ETIMEOFFICE', $3, $4, $5::timestamp, $6::timestamp)`,
    [id, weekStart, status, opts.active ?? true, opts.key ?? null, uploadedAt],
  )

const insertPunch = (c: Client, id: string, uploadId: string, weekStart: string) =>
  c.query(
    `INSERT INTO "AttendancePunch" (id, "attendanceUploadId", "empCode", "matchStatus", "punchDate", "pairIndex", position, source, "updatedAt")
     VALUES ($1, $2, '9001', 'UNKNOWN', $3::timestamp, 0, 'IN', 'API', now())`,
    [id, uploadId, weekStart],
  )

const insertRecord = (c: Client, id: string, uploadId: string, weekStart: string) =>
  c.query(
    `INSERT INTO "AttendanceRecord" (id, "attendanceUploadId", "employeeId", "attendanceDate", "regularHours", "overtimeHours")
     VALUES ($1, $2, 'no-such-employee', $3::timestamp, 8, 0)`,
    [id, uploadId, weekStart],
  )

async function runKeys(c: Client): Promise<Record<string, string | null>> {
  const { rows } = await c.query(`SELECT id, "approvedWeekStart"::date::text AS key FROM "PayrollRun" ORDER BY id`)
  return Object.fromEntries(rows.map((r) => [r.id, r.key]))
}

async function uploadState(c: Client): Promise<Record<string, { active: boolean; key: string | null }>> {
  const { rows } = await c.query(
    `SELECT id, "isActiveForPayrollWeek" AS active, "activeWeekStart"::date::text AS key FROM "AttendanceUpload" ORDER BY id`,
  )
  return Object.fromEntries(rows.map((r) => [r.id, { active: r.active, key: r.key }]))
}

describe.skipIf(!enabled)('F12 migration data steps (real database)', { timeout: 60000 }, () => {
  it('keys APPROVED and REVISED runs with their week start, clears a stale key on a run that is not approved, and fits the unique index', async () => {
    await withCopies(async (c) => {
      await insertRun(c, 'f12mig-a', week(0), 'APPROVED', null) // legacy: no key yet
      await insertRun(c, 'f12mig-b', week(1), 'REVISED', null)
      await insertRun(c, 'f12mig-c', week(2), 'APPROVED', week(2)) // already keyed: untouched
      await insertRun(c, 'f12mig-d', week(3), 'DRAFT', week(3)) // not approved but holding a key (stale)
      await insertRun(c, 'f12mig-e', week(4), 'DRAFT', null) // not approved, no key: untouched

      await c.query(dataSteps())

      expect(await runKeys(c)).toEqual({
        'f12mig-a': week(0),
        'f12mig-b': week(1),
        'f12mig-c': week(2),
        'f12mig-d': null,
        'f12mig-e': null,
      })
      // The migration creates this index right after the data steps; it must accept the result.
      await c.query(`CREATE UNIQUE INDEX f12mig_run_key ON ${SCHEMA}."PayrollRun" ("approvedWeekStart")`)
    })
  })

  it('refuses a week with two APPROVED/REVISED runs: the message names the week and both runs, and nothing else changes', async () => {
    await withCopies(async (c) => {
      await insertRun(c, 'f12mig-dup1', week(0), 'APPROVED', null)
      await insertRun(c, 'f12mig-dup2', week(0), 'REVISED', null)
      await insertRun(c, 'f12mig-would-fill', week(1), 'APPROVED', null) // another week that WOULD be keyed
      await insertRun(c, 'f12mig-stale', week(2), 'DRAFT', week(2)) // and a stale key that WOULD be cleared
      await insertUpload(c, 'f12mig-u1', week(3), 'REVIEW', '2034-02-01 08:00:00') // two active rows that WOULD be deduplicated
      await insertUpload(c, 'f12mig-u2', week(3), 'REVIEW', '2034-02-01 09:00:00')
      const runsBefore = await runKeys(c)
      const uploadsBefore = await uploadState(c)

      await c.query('SAVEPOINT before_data_steps')
      await expect(c.query(dataSteps())).rejects.toThrow(new RegExp(`${week(0)}: f12mig-dup1, f12mig-dup2`))
      await c.query('ROLLBACK TO SAVEPOINT before_data_steps')

      expect(await runKeys(c)).toEqual(runsBefore)
      expect(await uploadState(c)).toEqual(uploadsBefore)
    })
  })

  it('keeps one active attendance row per week by the winner rule, deactivates the rest, keys the winners, and fits the unique index', async () => {
    await withCopies(async (c, notices) => {
      // 0: three REVIEW rows; the newest uploadedAt wins.
      await insertUpload(c, 'f12mig-0a', week(0), 'REVIEW', '2034-02-01 09:00:00')
      await insertUpload(c, 'f12mig-0b', week(0), 'REVIEW', '2034-02-01 10:00:00')
      await insertUpload(c, 'f12mig-0c', week(0), 'REVIEW', '2034-02-01 08:00:00')
      // 1: a tie on uploadedAt; the larger id wins.
      await insertUpload(c, 'f12mig-1a', week(1), 'REVIEW', '2034-02-08 08:00:00')
      await insertUpload(c, 'f12mig-1b', week(1), 'REVIEW', '2034-02-08 08:00:00')
      // 2: status beats recency: READY (oldest) > REVIEW > ERRORS (newest).
      await insertUpload(c, 'f12mig-2ready', week(2), 'READY', '2034-02-15 08:00:00')
      await insertUpload(c, 'f12mig-2review', week(2), 'REVIEW', '2034-02-15 09:00:00')
      await insertUpload(c, 'f12mig-2errors', week(2), 'ERRORS', '2034-02-15 10:00:00')
      // 3: APPROVED and READY rank the same, so the newer one wins.
      await insertUpload(c, 'f12mig-3approved', week(3), 'APPROVED', '2034-02-22 08:00:00')
      await insertUpload(c, 'f12mig-3ready', week(3), 'READY', '2034-02-22 09:00:00')
      // 4: attendance records beat recency within a status.
      await insertUpload(c, 'f12mig-4holds', week(4), 'READY', '2034-03-01 08:00:00')
      await insertUpload(c, 'f12mig-4empty', week(4), 'READY', '2034-03-01 09:00:00')
      await insertRecord(c, 'f12mig-4rec', 'f12mig-4holds', week(4))
      // 5: punches beat recency within a status.
      await insertUpload(c, 'f12mig-5holds', week(5), 'REVIEW', '2034-03-08 08:00:00')
      await insertUpload(c, 'f12mig-5empty', week(5), 'REVIEW', '2034-03-08 09:00:00')
      await insertPunch(c, 'f12mig-5punch', 'f12mig-5holds', week(5))
      // 6: an inactive row with a stale key (the key is cleared, the row stays inactive) and a lone keyless active row.
      await insertUpload(c, 'f12mig-6inactive', week(6), 'READY', '2034-03-15 08:00:00', { active: false, key: week(6) })
      await insertUpload(c, 'f12mig-6lone', week(6), 'REVIEW', '2034-03-15 09:00:00')
      // 7: an active row that already has its key (untouched).
      await insertUpload(c, 'f12mig-7keyed', week(7), 'REVIEW', '2034-03-22 08:00:00', { key: week(7) })

      await c.query(dataSteps())

      const winners = ['0b', '1b', '2ready', '3ready', '4holds', '5holds', '6lone', '7keyed']
      const losers = ['0a', '0c', '1a', '2review', '2errors', '3approved', '4empty', '5empty', '6inactive']
      const state = await uploadState(c)
      winners.forEach((name, i) => expect(state[`f12mig-${name}`], name).toEqual({ active: true, key: week(i) }))
      for (const name of losers) expect(state[`f12mig-${name}`], name).toEqual({ active: false, key: null })

      // One notice per row the data steps deactivated (the stale-key row 6inactive was already inactive).
      expect(notices.filter((n) => /deactivated a duplicate active attendance row/.test(n))).toHaveLength(8)
      expect(notices.some((n) => n.includes('f12mig-0a') && n.includes(week(0)))).toBe(true)

      // The migration creates this index right after the data steps; it must accept the result.
      await c.query(`CREATE UNIQUE INDEX f12mig_active_key ON ${SCHEMA}."AttendanceUpload" ("activeWeekStart")`)
    })
  })

  it('is idempotent: a second run changes nothing and deactivates nothing', async () => {
    await withCopies(async (c, notices) => {
      await insertRun(c, 'f12mig-r1', week(0), 'APPROVED', null)
      await insertRun(c, 'f12mig-r2', week(1), 'REVISED', null)
      await insertUpload(c, 'f12mig-u1', week(2), 'REVIEW', '2034-02-15 08:00:00')
      await insertUpload(c, 'f12mig-u2', week(2), 'REVIEW', '2034-02-15 09:00:00')
      await insertUpload(c, 'f12mig-u3', week(3), 'READY', '2034-02-22 08:00:00')

      await c.query(dataSteps())
      const runs = await runKeys(c)
      const uploads = await uploadState(c)
      notices.length = 0

      await c.query(dataSteps())

      expect(await runKeys(c)).toEqual(runs)
      expect(await uploadState(c)).toEqual(uploads)
      expect(notices).toEqual([])
    })
  })
})
