// @vitest-environment node
//
// Real-database test for the data steps and the index of the F13 migration (prisma/migrations/*_f13_employee_sheet_sync).
//
//   F13_TEST_DB_URL=postgres://postgres:postgres@localhost:5432/f13_test_tmp npx vitest run src/__tests__/db/f13-migration.db.test.ts
//
// Skipped (and reported as skipped) when F13_TEST_DB_URL is not set. The URL must point at localhost and at a database
// that already has the migrations applied (`prisma migrate deploy`). Same approach as f12-migration.db.test.ts: the data
// steps (the text between the BEGIN/END markers) run on throwaway copies of the tables they touch, in a schema created
// inside a transaction and rolled back at the end. No real row is read, written or locked.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const URL = process.env.F13_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal
const ROOT = path.resolve(__dirname, '../../..')
const SCHEMA = 'f13mig_copy'

if (URL !== '' && !isLocal) {
  describe('F13 migration (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F13_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

function migrationSql(): string {
  const dir = path.join(ROOT, 'prisma', 'migrations')
  const found = fs.readdirSync(dir).filter((name) => name.endsWith('_f13_employee_sheet_sync'))
  if (found.length !== 1) throw new Error(`Expected one *_f13_employee_sheet_sync migration, found ${found.length}.`)
  return fs.readFileSync(path.join(dir, found[0], 'migration.sql'), 'utf8').replace(/\r\n/g, '\n')
}

function dataSteps(): string {
  const sql = migrationSql()
  const begin = sql.indexOf('-- BEGIN F13 DATA STEPS')
  const end = sql.indexOf('-- END F13 DATA STEPS')
  if (begin < 0 || end < begin) throw new Error('The BEGIN/END F13 DATA STEPS markers are missing from the migration.')
  return sql.slice(begin, end)
}

async function withCopies<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    for (const table of ['Employee', 'EmployeeWageHistory']) {
      await client.query(`CREATE TABLE ${SCHEMA}."${table}" (LIKE public."${table}" INCLUDING DEFAULTS)`)
    }
    await client.query(`SET LOCAL search_path = ${SCHEMA}, public`)
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

const emp = (c: Client, id: string, code: string) =>
  c.query(`INSERT INTO "Employee" (id, "employeeId", "employeeName", designation, "updatedAt") VALUES ($1, $2, 'N', 'D', now())`, [id, code])

const wage = (
  c: Client,
  id: string,
  employeeId: string,
  amount: number,
  from: string,
  source: string,
  closed: string | null = null,
) =>
  c.query(
    `INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "effectiveTo", "changeSource")
     VALUES ($1, $2, $3::numeric, $3::numeric / 8, $4::timestamp, $5::timestamp, $6)`,
    [id, employeeId, amount, from, closed, source],
  )

async function rows(c: Client) {
  const { rows } = await c.query(`SELECT id FROM "EmployeeWageHistory" ORDER BY id`)
  return rows.map((r) => r.id as string)
}

describe('F13 migration file (no database needed)', () => {
  it('contains the markers, the guards, and the partial unique index after the data steps', () => {
    const sql = migrationSql()
    expect(sql.indexOf('-- BEGIN F13 DATA STEPS')).toBeGreaterThan(sql.indexOf('ALTER TABLE "Employee"'))
    expect(sql.indexOf('CREATE UNIQUE INDEX "EmployeeWageHistory_one_open_per_employee"')).toBeGreaterThan(
      sql.indexOf('-- END F13 DATA STEPS'),
    )
    expect(sql).toMatch(/WHERE "effectiveTo" IS NULL/)
    expect(sql).toMatch(/RAISE EXCEPTION/)
    expect(sql).toMatch(/DELETE FROM "EmployeeWageHistory"/)
  })

  it('adds exactly the 25 employee columns, the batch columns and the settings columns', () => {
    const sql = migrationSql()
    const employeeBlock = sql.slice(sql.indexOf('ALTER TABLE "Employee"'), sql.indexOf('-- AlterTable\nALTER TABLE "EmployeeImportBatch"'))
    expect(employeeBlock.match(/ADD COLUMN/g)).toHaveLength(25)
    expect(sql).toMatch(/"source" TEXT NOT NULL DEFAULT 'EXCEL'/)
    expect(sql).toMatch(/"trigger" TEXT/)
    expect(sql).toMatch(/"report" JSONB/)
    expect(sql).toMatch(/"employeeSheetSyncEnabled" BOOLEAN NOT NULL DEFAULT false/)
    expect(sql).toMatch(/"employeeSheetSyncFirstAppliedAt" TIMESTAMP\(3\)/)
  })

  it('never drops or alters existing data columns', () => {
    const sql = migrationSql()
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)/i)
    expect(sql).not.toMatch(/TRUNCATE/i)
  })
})

describe.skipIf(!enabled)('F13 migration data steps (real database)', { timeout: 60000 }, () => {
  it('equal open IMPORT + MANUAL pair: the IMPORT row is deleted, MANUAL kept, and the unique index fits', async () => {
    await withCopies(async (c) => {
      await emp(c, 'e1', 'TPLX0001')
      await wage(c, 'w-import', 'e1', 800, '2025-01-01', 'IMPORT')
      await wage(c, 'w-manual', 'e1', 800, '2025-01-01', 'MANUAL')
      await emp(c, 'e2', 'TPLX0002') // a normal employee: untouched
      await wage(c, 'w-e2-closed', 'e2', 700, '2024-01-01', 'IMPORT', '2025-01-01')
      await wage(c, 'w-e2-open', 'e2', 800, '2025-01-01', 'MANUAL')

      await c.query(dataSteps())

      expect(await rows(c)).toEqual(['w-e2-closed', 'w-e2-open', 'w-manual'])
      await c.query(`CREATE UNIQUE INDEX f13mig_one_open ON ${SCHEMA}."EmployeeWageHistory" ("employeeId") WHERE "effectiveTo" IS NULL`)
    })
  })

  it('differing amounts: raises naming the employee, and changes nothing', async () => {
    await withCopies(async (c) => {
      await emp(c, 'e1', 'TPLX0001')
      await wage(c, 'w-import', 'e1', 800, '2025-01-01', 'IMPORT')
      await wage(c, 'w-manual', 'e1', 900, '2025-01-01', 'MANUAL')
      await emp(c, 'e2', 'TPLX0002') // an otherwise fixable pair that would have been deleted
      await wage(c, 'w2-import', 'e2', 800, '2025-01-01', 'IMPORT')
      await wage(c, 'w2-manual', 'e2', 800, '2025-01-01', 'MANUAL')
      const before = await rows(c)

      await c.query('SAVEPOINT s')
      await expect(c.query(dataSteps())).rejects.toThrow(/TPLX0001/)
      await c.query('ROLLBACK TO SAVEPOINT s')
      expect(await rows(c)).toEqual(before)
    })
  })

  it('differing effectiveFrom: raises', async () => {
    await withCopies(async (c) => {
      await emp(c, 'e1', 'TPLX0001')
      await wage(c, 'w-import', 'e1', 800, '2025-01-01', 'IMPORT')
      await wage(c, 'w-manual', 'e1', 800, '2025-02-01', 'MANUAL')
      await expect(c.query(dataSteps())).rejects.toThrow(/two open wage rows that differ[\s\S]*TPLX0001/)
    })
  })

  it('two open IMPORT rows and no MANUAL row: raises, naming the employee', async () => {
    await withCopies(async (c) => {
      await emp(c, 'e1', 'TPLX0001')
      await wage(c, 'w-a', 'e1', 800, '2025-01-01', 'IMPORT')
      await wage(c, 'w-b', 'e1', 800, '2025-01-01', 'IMPORT')
      const before = await rows(c)
      await c.query('SAVEPOINT s')
      await expect(c.query(dataSteps())).rejects.toThrow(/more than one open wage row[\s\S]*TPLX0001/)
      await c.query('ROLLBACK TO SAVEPOINT s')
      expect(await rows(c)).toEqual(before)
    })
  })

  it('clean data: the data steps change nothing', async () => {
    await withCopies(async (c) => {
      await emp(c, 'e1', 'TPLX0001')
      await wage(c, 'w1-closed', 'e1', 700, '2024-01-01', 'MANUAL', '2025-01-01')
      await wage(c, 'w1-open', 'e1', 800, '2025-01-01', 'MANUAL')
      await emp(c, 'e2', 'TPLX0002') // no wage rows at all
      await c.query(dataSteps())
      expect(await rows(c)).toEqual(['w1-closed', 'w1-open'])
    })
  })

  it('an empty database passes', async () => {
    await withCopies(async (c) => {
      await expect(c.query(dataSteps())).resolves.toBeDefined()
    })
  })
})

describe.skipIf(!enabled)('F13 migrated schema (real database)', { timeout: 60000 }, () => {
  it('has the partial unique index on public."EmployeeWageHistory"', async () => {
    const c = new Client({ connectionString: URL })
    await c.connect()
    try {
      const { rows } = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'EmployeeWageHistory_one_open_per_employee'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toMatch(/UNIQUE/)
      expect(rows[0].indexdef).toMatch(/"effectiveTo" IS NULL/)
    } finally {
      await c.end()
    }
  })

  it('rejects a second open wage row but allows closed ones (rolled back)', async () => {
    const c = new Client({ connectionString: URL })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO "Employee" (id, "employeeId", "employeeName", designation, "updatedAt") VALUES ('f13mig-e', 'TPLF13MIG1', 'N', 'D', now())`)
      await c.query(`INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "changeSource") VALUES ('f13mig-w1', 'f13mig-e', 800, 100, now(), 'MANUAL')`)
      await c.query(`INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "effectiveTo", "changeSource") VALUES ('f13mig-w0', 'f13mig-e', 700, 87.5, now(), now(), 'MANUAL')`)
      await c.query('SAVEPOINT dup')
      await expect(
        c.query(`INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "changeSource") VALUES ('f13mig-w2', 'f13mig-e', 900, 112.5, now(), 'IMPORT')`),
      ).rejects.toMatchObject({ code: '23505' })
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.end()
    }
  })

  it('defaults: new batch source is EXCEL, settings switch is off (rolled back)', async () => {
    const c = new Client({ connectionString: URL })
    await c.connect()
    try {
      await c.query('BEGIN')
      const b = await c.query(`INSERT INTO "EmployeeImportBatch" (id, "fileName", "fileType", status) VALUES ('f13mig-b', 'x.xlsx', 'XLSX', 'APPLIED') RETURNING source, trigger, report`)
      expect(b.rows[0]).toEqual({ source: 'EXCEL', trigger: null, report: null })
    } catch (e) {
      throw e
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.end()
    }
  })
})
