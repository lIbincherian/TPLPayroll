// @vitest-environment node
//
// Real-database tests for the F12 fix round. They run the real services against a local Postgres.
//
//   F12_TEST_DB_URL=postgres://postgres:postgres@localhost:51214/template1?sslmode=disable npx vitest run src/__tests__/db
//
// Skipped (and reported as skipped) when F12_TEST_DB_URL is not set, so the normal unit run needs no
// database. The URL must point at localhost: these tests write rows, and refuse anything else.
// The schema must already be pushed (`prisma db push`). Rows use their own employees (TPLF12DB*) and
// January to March 2026 weeks, and are removed afterwards.
//
// Limits of the local database: `prisma dev` serves every client through ONE Postgres session
// (backend pid is the same for all connections) and queues a second connection's queries while the
// first has a transaction open. So what these tests prove is the SQL, the data rules and the
// sequencing of each service; they cannot prove that SELECT ... FOR UPDATE makes two concurrent
// writers wait for each other, because the proxy serialises them before the lock is ever involved.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { Prisma, type PrismaClient } from '@prisma/client'
import { punchSetSignature } from '@/features/attendance-sync/lib/day-signature'

vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal
const ROOT = path.resolve(__dirname, '../../..')
const BACKFILL = path.join(ROOT, 'scripts/backfill-active-week-start.js')
const BACKFILL_APPROVED = path.join(ROOT, 'scripts/backfill-approved-week-start.js')

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(utc(iso).getTime() + n * 86400000).toISOString().slice(0, 10)

// Thursdays in early 2026 (all long over, so the weeks can be approved on any run date).
const W = {
  unique: '2026-01-08',
  race: '2026-01-15',
  excel: '2026-01-22',
  lockSel: '2026-01-29',
  bf1: '2026-02-05',
  bf2: '2026-02-12',
  bf3: '2026-02-19',
  bf4: '2026-02-26',
  bf5: '2026-04-02',
  sync: '2026-03-05',
  syncGuard: '2026-03-26',
  payroll: '2026-03-12',
  matrix: '2026-03-19',
  // Fix round 3 (Thursdays, June to October 2026)
  apr1: '2026-06-04', // concurrent approvePayroll
  apr2: '2026-06-11', // the unique key
  apr3: '2026-06-18', // backfill-approved: legacy runs
  apr4: '2026-06-25',
  apr5: '2026-07-02', // backfill-approved: two approved runs in one week
  apr6: '2026-07-09', // backfill-approved: a mis-keyed run (all-or-nothing)
  apr7: '2026-07-16',
  aw1: '2026-07-30', // backfill-active: the winner rule
  aw2: '2026-08-06',
  aw3: '2026-08-13',
  aw4: '2026-08-20',
  aw5: '2026-08-27',
  aw6: '2026-09-03',
  aw7: '2026-09-10',
  aw8: '2026-09-17',
  day: '2026-09-24', // DAY_CHANGED
  codes: '2026-10-01', // employee-check writers
  corr: '2026-10-08', // correction writers
  // Fix round 4 (Thursdays)
  r4apr: '2026-10-15', // the real approved-week P2002
  r4apr2: '2026-10-22', // approvePayroll against a leftover key
  r4mem: '2026-10-29', // a duplicate decision (two-column P2002)
  r4day: '2026-11-05', // day version and membership
  r4rematch: '2026-04-09', // rematchWeekCodes per code
  r4corr: '2026-04-16', // drafts and promotions without a session
  // Final fix pass (Thursdays)
  r6rematch: '2026-04-23', // rematchWeekCodes: an employee deleted before the lock
  r6day: '2026-04-30', // the day savePunchEdit returns
  r6rematch2: '2026-05-07', // rematchWeekCodes: a real foreign-key refusal
}
const ALL_WEEKS = Object.values(W).map(utc)

const FULL_DAY = ['08:00', '12:00', '13:00', '17:00']
// The local database serves every connection through one session. Two operations started together can have their
// protocol messages mixed up ("bind message supplies N parameters"). That is the database, not the product, so a
// racing test that sees it reports itself skipped instead of passing or failing.
const interleaved = (results: PromiseSettledResult<unknown>[]) =>
  results.some((r) => r.status === 'rejected' && /bind message supplies \d+ parameters/.test(String(r.reason)))
// Codes the employee-check tests save as exceptions (AttendanceCodeException.empCode is unique and global).
const CODE_EXCEPTIONS = ['9301', '9302', '9303']

if (URL !== '' && !isLocal) {
  describe('F12 fix round (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F12_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

describe.skipIf(!enabled)('F12 fix round (real database)', { timeout: 90000 }, () => {
  let prisma: PrismaClient
  let empA: { id: string; employeeId: string }
  let empB: { id: string; employeeId: string }
  // Services, imported after the connection string is set.
  let lockWeekRow: typeof import('@/features/attendance-sync/services/week-lock.service').lockWeekRow
  let getOrCreateApiWeekRow: typeof import('@/features/attendance-sync/services/week-list.service').getOrCreateApiWeekRow
  let approveWeek: typeof import('@/features/attendance-sync/services/week-approval.service').approveWeek
  let reopenWeek: typeof import('@/features/attendance-sync/services/week-approval.service').reopenWeek
  let savePunchEdit: typeof import('@/features/attendance-sync/services/punch-review.service').savePunchEdit
  let getPunchReview: typeof import('@/features/attendance-sync/services/punch-review.service').getPunchReview
  let setEmployeeDecision: typeof import('@/features/attendance-sync/services/employee-check.service').setEmployeeDecision
  let syncWeek: typeof import('@/features/attendance-sync/services/sync.service').syncWeek
  let fetchPunchData: ReturnType<typeof vi.fn>
  let calculatePayroll: typeof import('@/features/payroll-generation/services/payroll.service').calculatePayroll
  let approvePayroll: typeof import('@/features/payroll-generation/services/payroll.service').approvePayroll
  let correction: typeof import('@/features/payroll-correction/services/correction.service')

  async function seedWeek(weekStart: string, status = 'REVIEW', over: Record<string, unknown> = {}) {
    const upload = await prisma.attendanceUpload.create({
      data: {
        source: 'ETIMEOFFICE',
        payrollWeekSource: 'ETIMEOFFICE',
        status,
        isActiveForPayrollWeek: true,
        activeWeekStart: utc(weekStart),
        payrollWeekStartDate: utc(weekStart),
        payrollWeekEndDate: utc(addDays(weekStart, 6)),
        ...over,
      },
    })
    return upload
  }

  /** The `baseSignature` an editor opened on this employee-day holds: the signature of the stored rows right now. */
  async function baseSignatureOf(weekStart: string, employeeId: string, date: string, correctionId: string | null = null) {
    const upload = await prisma.attendanceUpload.findFirstOrThrow({
      where: { payrollWeekStartDate: utc(weekStart), isActiveForPayrollWeek: true },
    })
    const rows = await prisma.attendancePunch.findMany({
      where: { attendanceUploadId: upload.id, correctionId, employeeId, punchDate: utc(date) },
    })
    return punchSetSignature(rows as never)
  }

  async function seedPunches(uploadId: string, weekStart: string, employees = [empA, empB]) {
    const rows: Array<Record<string, unknown>> = []
    for (const emp of employees) {
      for (let d = 0; d < 7; d++) {
        FULL_DAY.forEach((time, i) =>
          rows.push({
            attendanceUploadId: uploadId,
            employeeId: emp.id,
            empCode: emp === empA ? '9101' : '9102',
            matchStatus: 'MATCHED',
            punchDate: utc(addDays(weekStart, d)),
            pairIndex: Math.floor(i / 2),
            position: i % 2 === 0 ? 'IN' : 'OUT',
            source: 'API',
            originalTime: time,
            currentTime: time,
          }),
        )
      }
    }
    await prisma.attendancePunch.createMany({ data: rows as never })
  }

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { employeeId: { startsWith: 'TPLF12DB' } }, select: { id: true } })
    const empIds = emps.map((e) => e.id)
    const uploads = await prisma.attendanceUpload.findMany({ where: { payrollWeekStartDate: { in: ALL_WEEKS } }, select: { id: true } })
    const ids = uploads.map((u) => u.id)
    const runs = await prisma.payrollRun.findMany({
      where: { OR: [{ payrollWeekStartDate: { in: ALL_WEEKS } }, { id: { startsWith: 'f12db-' } }] },
      select: { id: true },
    })
    const runIds = runs.map((r) => r.id)
    await prisma.payrollCorrectionSession.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { payrollRunId: { in: runIds } }] } })
    await prisma.payrollAdjustmentApplication.deleteMany({ where: { OR: [{ payrollRunId: { in: runIds } }, { employeeId: { in: empIds } }] } })
    await prisma.payrollAdjustment.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.payrollRunEmployee.deleteMany({ where: { payrollRunId: { in: runIds } } })
    await prisma.payrollRevision.deleteMany({ where: { payrollRunId: { in: runIds } } })
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } })
    await prisma.attendanceRecord.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.attendancePunch.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.attendanceEmployeeDecision.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } })
    // Audit rows keyed by an exception, decision or punch id (not the upload) still name the week.
    await prisma.auditLog.deleteMany({
      where: { OR: Object.values(W).map((wk) => ({ detailsJson: { path: ['weekStart'], equals: wk } })) },
    })
    await prisma.attendanceCodeException.deleteMany({ where: { empCode: { in: CODE_EXCEPTIONS } } })
    await prisma.attendanceUpload.deleteMany({ where: { id: { in: ids } } })
    await prisma.employeeWageHistory.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  }

  function runBackfill(env: Record<string, string> = { DIRECT_DATABASE_URL: URL, DATABASE_URL: URL }, script = BACKFILL) {
    try {
      const stdout = execFileSync(process.execPath, [script], {
        cwd: os.tmpdir(), // not the repo: dotenv must not pick up the developer's .env
        // TZ is passed on so a run under TZ=UTC can tell a time-zone problem in a script from any other.
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...(process.env.TZ ? { TZ: process.env.TZ } : {}), ...env } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      })
      return { code: 0, stdout, stderr: '' }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
  }

  const count = (out: string, label: string) => Number(new RegExp(`${label}: (\\d+)`).exec(out)?.[1] ?? NaN)

  beforeAll(async () => {
    process.env.DIRECT_DATABASE_URL = URL
    process.env.DATABASE_URL = URL
    prisma = (await import('@/lib/prisma')).default
    ;({ lockWeekRow } = await import('@/features/attendance-sync/services/week-lock.service'))
    ;({ getOrCreateApiWeekRow } = await import('@/features/attendance-sync/services/week-list.service'))
    ;({ approveWeek, reopenWeek } = await import('@/features/attendance-sync/services/week-approval.service'))
    ;({ savePunchEdit, getPunchReview } = await import('@/features/attendance-sync/services/punch-review.service'))
    ;({ setEmployeeDecision } = await import('@/features/attendance-sync/services/employee-check.service'))
    ;({ syncWeek } = await import('@/features/attendance-sync/services/sync.service'))
    ;({ calculatePayroll, approvePayroll } = await import('@/features/payroll-generation/services/payroll.service'))
    correction = await import('@/features/payroll-correction/services/correction.service')
    fetchPunchData = (await import('@/features/attendance-sync/services/etimeoffice.client')).fetchPunchData as never

    await cleanup()
    const mk = (code: string, name: string) =>
      prisma.employee.create({
        data: {
          employeeId: code,
          employeeName: name,
          designation: 'Guard',
          designationShort: 'G',
          site: 'Gate',
          isActive: true,
          wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
        },
      })
    empA = await mk('TPLF12DB9101', 'F12 Alpha')
    empB = await mk('TPLF12DB9102', 'F12 Bravo')
  }, 60000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  }, 60000)

  // ─── Item 5: one active row per week ────────────────────────────────────────

  describe('item 5: AttendanceUpload.activeWeekStart is a unique key for the active row', () => {
    it('rejects a second active row for the same week with P2002', async () => {
      await seedWeek(W.unique, 'REVIEW')

      await expect(seedWeek(W.unique, 'SYNC_FAILED')).rejects.toMatchObject({ code: 'P2002' })
      expect(await prisma.attendanceUpload.count({ where: { payrollWeekStartDate: utc(W.unique), isActiveForPayrollWeek: true } })).toBe(1)
    })

    it('allows any number of inactive rows for the week (their key is NULL)', async () => {
      for (let i = 0; i < 3; i++) await seedWeek(W.unique, 'SYNC_FAILED', { isActiveForPayrollWeek: false, activeWeekStart: null })

      expect(await prisma.attendanceUpload.count({ where: { payrollWeekStartDate: utc(W.unique) } })).toBe(4)
    })

    it('frees the week when the active row is deactivated and its key cleared', async () => {
      await prisma.attendanceUpload.updateMany({
        where: { payrollWeekStartDate: utc(W.unique), isActiveForPayrollWeek: true },
        data: { isActiveForPayrollWeek: false, activeWeekStart: null },
      })

      await expect(seedWeek(W.unique, 'REVIEW')).resolves.toMatchObject({ isActiveForPayrollWeek: true })
    })

    it('keeps a deactivated row\'s old key from freeing the week (the key is what is unique)', async () => {
      await expect(seedWeek(W.unique, 'REVIEW')).rejects.toMatchObject({ code: 'P2002' })
    })

    it('getOrCreateApiWeekRow stores activeWeekStart on the placeholder it creates', async () => {
      const row = await getOrCreateApiWeekRow({ start: W.race, end: addDays(W.race, 6) })

      expect(row).toMatchObject({ status: 'SYNC_FAILED', isActiveForPayrollWeek: true })
      expect(row.activeWeekStart?.toISOString()).toBe(utc(W.race).toISOString())
      expect((await getOrCreateApiWeekRow({ start: W.race, end: addDays(W.race, 6) })).id).toBe(row.id)
    })

    it('two callers creating the same new week end up with one active row and the same id', async () => {
      const week = { start: addDays(W.race, 98), end: addDays(W.race, 104) } // 23 Apr 2026: a Thursday no other test uses
      const [x, y] = await Promise.all([getOrCreateApiWeekRow(week), getOrCreateApiWeekRow(week)])

      expect(x.id).toBe(y.id)
      expect(await prisma.attendanceUpload.count({ where: { payrollWeekStartDate: utc(week.start), isActiveForPayrollWeek: true } })).toBe(1)
      await prisma.attendanceUpload.deleteMany({ where: { payrollWeekStartDate: utc(week.start) } })
    })

    it('refuses an Excel-era week without creating anything', async () => {
      await seedWeek(W.excel, 'READY', { source: 'EXCEL', payrollWeekSource: 'FILE_NAME', fileName: 'x.xlsx', fileType: 'xlsx' })

      await expect(getOrCreateApiWeekRow({ start: W.excel, end: addDays(W.excel, 6) })).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
      expect(await prisma.attendanceUpload.count({ where: { payrollWeekStartDate: utc(W.excel) } })).toBe(1)
    })
  })

  // ─── Week lock: SQL on a real database ──────────────────────────────────────

  describe('lockWeekRow: the SQL runs and maps rows', () => {
    it('by id returns the row with Date fields', async () => {
      const upload = await seedWeek(W.lockSel, 'APPROVED', { approvedAt: new Date('2026-02-05T08:00:00.123Z'), syncLockedAt: new Date('2026-02-05T08:01:00.000Z') })

      const locked = await prisma.$transaction((tx) => lockWeekRow(tx, { id: upload.id }))

      expect(locked).toEqual({
        id: upload.id,
        source: 'ETIMEOFFICE',
        status: 'APPROVED',
        syncLockedAt: new Date('2026-02-05T08:01:00.000Z'),
        approvedAt: new Date('2026-02-05T08:00:00.123Z'),
        payrollWeekStartDate: utc(W.lockSel),
      })
    })

    it('by week returns the active row of that Thursday, never an inactive one', async () => {
      const active = await prisma.attendanceUpload.findFirstOrThrow({ where: { payrollWeekStartDate: utc(W.lockSel), isActiveForPayrollWeek: true } })
      await seedWeek(W.lockSel, 'REVIEW', { isActiveForPayrollWeek: false, activeWeekStart: null, uploadedAt: new Date(Date.now() + 60_000) })

      const locked = await prisma.$transaction((tx) => lockWeekRow(tx, { weekStart: utc(W.lockSel) }))

      expect(locked?.id).toBe(active.id)
    })

    it('returns null for a week and an id that do not exist', async () => {
      expect(await prisma.$transaction((tx) => lockWeekRow(tx, { weekStart: utc('2020-01-02') }))).toBeNull()
      expect(await prisma.$transaction((tx) => lockWeekRow(tx, { id: 'no-such-row' }))).toBeNull()
    })
  })

  // ─── Item 5: the backfill script ────────────────────────────────────────────

  describe('item 5: scripts/backfill-active-week-start.js', () => {
    const rowsOfWeek = (week: string) =>
      prisma.attendanceUpload.findMany({
        where: { payrollWeekStartDate: utc(week) },
        select: { id: true, isActiveForPayrollWeek: true, activeWeekStart: true },
        orderBy: { id: 'asc' },
      })

    const snapshot = async () =>
      JSON.stringify(
        await prisma.attendanceUpload.findMany({
          select: { id: true, isActiveForPayrollWeek: true, activeWeekStart: true },
          orderBy: { id: 'asc' },
        }),
      )

    beforeAll(async () => {
      // Normalise the database first, so the counts of the runs below are exactly this test's own rows.
      expect(runBackfill().code).toBe(0)

      const old = (iso: string) => new Date(iso)
      const legacy = (weekStart: string, id: string, uploadedAt: string, over: Record<string, unknown> = {}) =>
        prisma.attendanceUpload.create({
          data: {
            id,
            source: 'ETIMEOFFICE',
            payrollWeekSource: 'ETIMEOFFICE',
            status: 'REVIEW',
            isActiveForPayrollWeek: true,
            activeWeekStart: null, // the state before the column existed
            payrollWeekStartDate: utc(weekStart),
            payrollWeekEndDate: utc(addDays(weekStart, 6)),
            uploadedAt: old(uploadedAt),
            ...over,
          },
        })

      // bf1: three active rows for one week; the newest (r2) must win.
      await legacy(W.bf1, 'f12db-bf1-r1', '2026-02-12T08:00:00Z')
      await legacy(W.bf1, 'f12db-bf1-r2', '2026-02-12T09:00:00Z')
      await legacy(W.bf1, 'f12db-bf1-r3', '2026-02-12T07:00:00Z')
      // bf2: a tie on uploadedAt; the larger id wins.
      await legacy(W.bf2, 'f12db-bf2-a', '2026-02-19T08:00:00Z')
      await legacy(W.bf2, 'f12db-bf2-b', '2026-02-19T08:00:00Z')
      // bf3: one active row without a key.
      await legacy(W.bf3, 'f12db-bf3-only', '2026-02-26T08:00:00Z')
      // bf4: an inactive row (stays as it is) and an active row that already has its key.
      await legacy(W.bf4, 'f12db-bf4-inactive', '2026-03-05T08:00:00Z', { isActiveForPayrollWeek: false })
      await legacy(W.bf4, 'f12db-bf4-keyed', '2026-03-05T09:00:00Z', { activeWeekStart: utc(W.bf4) })
    }, 120000)

    it('keeps the newest active row of a week and deactivates the others; a tie keeps the larger id', async () => {
      const first = runBackfill()
      expect(first.code, first.stderr).toBe(0)

      const bf1 = await rowsOfWeek(W.bf1)
      expect(bf1.find((r) => r.id === 'f12db-bf1-r2')).toMatchObject({ isActiveForPayrollWeek: true, activeWeekStart: utc(W.bf1) })
      for (const id of ['f12db-bf1-r1', 'f12db-bf1-r3']) {
        expect(bf1.find((r) => r.id === id)).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })
      }
      const bf2 = await rowsOfWeek(W.bf2)
      expect(bf2.find((r) => r.id === 'f12db-bf2-b')).toMatchObject({ isActiveForPayrollWeek: true, activeWeekStart: utc(W.bf2) })
      expect(bf2.find((r) => r.id === 'f12db-bf2-a')).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })

      // Exactly one active row per week afterwards.
      for (const week of [W.bf1, W.bf2, W.bf3, W.bf4]) {
        expect((await rowsOfWeek(week)).filter((r) => r.isActiveForPayrollWeek)).toHaveLength(1)
      }
    })

    it('fills the key of a lone active row, and leaves inactive rows and keyed rows alone', async () => {
      const bf3 = await rowsOfWeek(W.bf3)
      expect(bf3).toEqual([{ id: 'f12db-bf3-only', isActiveForPayrollWeek: true, activeWeekStart: utc(W.bf3) }])

      const bf4 = await rowsOfWeek(W.bf4)
      expect(bf4.find((r) => r.id === 'f12db-bf4-inactive')).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })
      expect(bf4.find((r) => r.id === 'f12db-bf4-keyed')).toMatchObject({ isActiveForPayrollWeek: true, activeWeekStart: utc(W.bf4) })
    })

    it('after the backfill the database refuses a second active row for those weeks', async () => {
      await expect(seedWeek(W.bf1, 'REVIEW')).rejects.toMatchObject({ code: 'P2002' })
      await expect(seedWeek(W.bf3, 'REVIEW')).rejects.toMatchObject({ code: 'P2002' })
    })

    it('is idempotent: a second run changes nothing and reports zero', async () => {
      const before = await snapshot()

      const again = runBackfill()

      expect(again.code, again.stderr).toBe(0)
      expect(count(again.stdout, 'Duplicate active rows deactivated')).toBe(0)
      expect(count(again.stdout, 'activeWeekStart filled')).toBe(0)
      expect(await snapshot()).toBe(before)
    })

    it('reports exact counts for a fresh legacy state: 1 duplicate deactivated, 2 keys filled', async () => {
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-bf5-old', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: null, payrollWeekStartDate: utc(W.bf5), payrollWeekEndDate: utc(addDays(W.bf5, 6)), uploadedAt: new Date('2026-04-09T08:00:00Z'),
        },
      })
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-bf5-new', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: null, payrollWeekStartDate: utc(W.bf5), payrollWeekEndDate: utc(addDays(W.bf5, 6)), uploadedAt: new Date('2026-04-09T09:00:00Z'),
        },
      })
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-bf5-other', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: null, payrollWeekStartDate: utc(addDays(W.bf5, 7)), payrollWeekEndDate: utc(addDays(W.bf5, 13)), uploadedAt: new Date('2026-04-09T09:00:00Z'),
        },
      })

      const run = runBackfill()

      expect(count(run.stdout, 'Duplicate active rows deactivated')).toBe(1)
      expect(count(run.stdout, 'activeWeekStart filled')).toBe(2)
      await prisma.attendanceUpload.deleteMany({ where: { id: { in: ['f12db-bf5-old', 'f12db-bf5-new', 'f12db-bf5-other'] } } })
    })

    it('prints where it is pointed (host, port, database) and never the login', async () => {
      const run = runBackfill()

      expect(run.stdout).toMatch(/^Target: (localhost|127\.0\.0\.1):\d+\//m)
      expect(run.stdout + run.stderr).not.toContain('postgres:postgres')
      expect(run.stdout + run.stderr).not.toMatch(/password/i)
    })

    it('stops with a message and exit code 1 when no connection string is set', () => {
      const run = runBackfill({ DIRECT_DATABASE_URL: '', DATABASE_URL: '' })

      expect(run.code).toBe(1)
      expect(run.stderr).toContain('Set DIRECT_DATABASE_URL or DATABASE_URL first.')
    })

    it('is all-or-nothing: when the fill step fails, the dedupe is rolled back too', async () => {
      // A row whose key is another week's start (mis-keyed) blocks the fill of that other week's row (unique
      // key). The older duplicate of the first week would be deactivated by the dedupe step before that.
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-atomic-miskeyed', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: utc(addDays(W.bf5, 7)), payrollWeekStartDate: utc(W.bf5), payrollWeekEndDate: utc(addDays(W.bf5, 6)), uploadedAt: new Date('2026-04-09T09:00:00Z'),
        },
      })
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-atomic-dup', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: null, payrollWeekStartDate: utc(W.bf5), payrollWeekEndDate: utc(addDays(W.bf5, 6)), uploadedAt: new Date('2026-04-09T08:00:00Z'),
        },
      })
      await prisma.attendanceUpload.create({
        data: {
          id: 'f12db-atomic-other', source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status: 'REVIEW', isActiveForPayrollWeek: true,
          activeWeekStart: null, payrollWeekStartDate: utc(addDays(W.bf5, 7)), payrollWeekEndDate: utc(addDays(W.bf5, 13)), uploadedAt: new Date('2026-04-09T09:00:00Z'),
        },
      })
      const before = await snapshot()

      const run = runBackfill()

      try {
        expect(run.code).toBe(1)
        expect(run.stderr).toContain('Backfill failed')
        // Nothing changed: the older duplicate was not deactivated.
        expect(await snapshot()).toBe(before)
      } finally {
        await prisma.attendanceUpload.deleteMany({
          where: { id: { in: ['f12db-atomic-miskeyed', 'f12db-atomic-dup', 'f12db-atomic-other'] } },
        })
      }
    })
  })

  // ─── Item 3 and 6: guards on a real database ────────────────────────────────

  describe('items 3 and 6: a running pull blocks approve and edit', () => {
    const pairs = [
      { pairIndex: 0, in: { time: '08:05' }, out: { time: '12:00' } },
      { pairIndex: 1, in: { time: '13:00' }, out: { time: '17:00' } },
    ]
    let uploadId: string

    beforeAll(async () => {
      const upload = await seedWeek(W.syncGuard, 'REVIEW')
      uploadId = upload.id
      await seedPunches(uploadId, W.syncGuard)
    })

    it('approveWeek and savePunchEdit say SYNC_IN_PROGRESS while the lock is fresh, and change nothing', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date() } })

      await expect(approveWeek(W.syncGuard)).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' })
      await expect(
        savePunchEdit({
          weekId: W.syncGuard,
          mode: { kind: 'LIVE' },
          employeeId: empA.id,
          date: W.syncGuard,
          baseSignature: await baseSignatureOf(W.syncGuard, empA.id, W.syncGuard),
          pairs,
        }),
      ).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' })

      const after = await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })
      expect(after.status).toBe('REVIEW')
      expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })).toBe(0)
      const edited = await prisma.attendancePunch.count({ where: { attendanceUploadId: uploadId, currentTime: '08:05' } })
      expect(edited).toBe(0)
    })

    it('setEmployeeDecision is refused too', async () => {
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: false } })
      try {
        await expect(setEmployeeDecision(W.syncGuard, empB.id, 'APPROVED')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' })
        expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: uploadId } })).toBe(0)
      } finally {
        await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      }
    })

    it('a stale lock (older than 5 minutes) no longer blocks: the edit saves, then the week approves', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date(Date.now() - 6 * 60 * 1000) } })

      const saved = await savePunchEdit({
        weekId: W.syncGuard,
        mode: { kind: 'LIVE' },
        employeeId: empA.id,
        date: W.syncGuard,
        baseSignature: await baseSignatureOf(W.syncGuard, empA.id, W.syncGuard),
        pairs,
      })
      expect(saved.day.date).toBe(W.syncGuard)

      const approved = await approveWeek(W.syncGuard)
      expect(approved.summary.employeeCount).toBe(2)
      expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })).toBe(14)
    })

    it('a second approve is refused: the week is no longer in review', async () => {
      await expect(approveWeek(W.syncGuard)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })
      expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })).toBe(14)
    })

    it('an edit of an approved week is WEEK_LOCKED', async () => {
      await expect(
        savePunchEdit({
          weekId: W.syncGuard,
          mode: { kind: 'LIVE' },
          employeeId: empA.id,
          date: W.syncGuard,
          baseSignature: await baseSignatureOf(W.syncGuard, empA.id, W.syncGuard),
          pairs,
        }),
      ).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    })
  })

  describe('item 3: a pull that finds the week approved replaces nothing', () => {
    it('WEEK_CHANGED when the week is approved while the API call is running', async () => {
      const upload = await seedWeek(W.sync, 'REVIEW')
      await seedPunches(upload.id, W.sync)
      const punchesBefore = await prisma.attendancePunch.count({ where: { attendanceUploadId: upload.id } })
      fetchPunchData.mockImplementation(async () => {
        // The "API call": while it runs, someone approves the week.
        await prisma.attendanceUpload.update({ where: { id: upload.id }, data: { status: 'APPROVED', approvedAt: new Date() } })
        return {
          ok: true,
          punches: [{ empCode: '9101', empName: 'F12 Alpha', date: W.sync, time: '08:00', mcid: '1' }],
        }
      })

      const outcome = await syncWeek({ week: { start: W.sync, end: addDays(W.sync, 6) }, trigger: 'MANUAL' }).catch((e) => e)

      // A week that is already APPROVED when the pull starts is refused with WEEK_APPROVED before the call;
      // here it changes during the call, so the replace transaction finds it APPROVED.
      expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'WEEK_CHANGED' })
      const after = await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: upload.id } })
      expect(after.status).toBe('APPROVED')
      expect(after.syncLockedAt).toBeNull()
      expect(after.lastSyncError).toContain('approved while the pull was running')
      expect(await prisma.attendancePunch.count({ where: { attendanceUploadId: upload.id } })).toBe(punchesBefore)
      const audit = await prisma.auditLog.findMany({ where: { entityId: upload.id, actionType: 'PULL' } })
      expect(audit).toHaveLength(1)
      expect(audit[0].detailsJson).toMatchObject({ outcome: 'FAILED', code: 'WEEK_CHANGED' })
    })

    it('replaces a week that stays in review, and reports edits made while the call was running', async () => {
      const probe = addDays(W.sync, 63) // 7 May 2026: a Thursday no other test uses
      const upload = await seedWeek(probe, 'REVIEW')
      await seedPunches(upload.id, probe)
      fetchPunchData.mockImplementation(async () => {
        await prisma.attendancePunch.updateMany({
          where: { attendanceUploadId: upload.id, employeeId: empA.id, punchDate: utc(probe), position: 'OUT', pairIndex: 1 },
          data: { currentTime: '18:30' },
        })
        return {
          ok: true,
          punches: ['08:00', '12:00', '13:00', '17:00'].map((time) => ({ empCode: '9101', empName: 'F12 Alpha', date: probe, time, mcid: '1' })),
        }
      })

      const outcome = await syncWeek({ week: { start: probe, end: addDays(probe, 6) }, trigger: 'MANUAL' })

      expect(outcome).toMatchObject({ outcome: 'LOADED' })
      if (outcome.outcome === 'LOADED') expect(outcome.discarded).toMatchObject({ editedDays: 1 })
      expect(await prisma.attendancePunch.count({ where: { attendanceUploadId: upload.id, currentTime: '18:30' } })).toBe(0)
      await prisma.auditLog.deleteMany({ where: { entityId: upload.id } })
      await prisma.attendancePunch.deleteMany({ where: { attendanceUploadId: upload.id } })
      await prisma.attendanceUpload.delete({ where: { id: upload.id } })
    })
  })

  // ─── Items 1, 2, 4, 7: payroll and correction ───────────────────────────────

  describe('items 1, 2, 4, 7: payroll approval and the correction flow', () => {
    let uploadId: string
    let runId: string
    const week = W.payroll
    const end = addDays(week, 6)
    let summary: Awaited<ReturnType<typeof calculatePayroll>>

    const clearDay = async (date: string, employeeId: string, mode: { kind: 'CORRECTION'; payrollRunId: string; correctionId: string; revisionNumber: number }) =>
      savePunchEdit({
        weekId: week,
        mode,
        employeeId,
        date,
        baseSignature: await baseSignatureOf(week, employeeId, date, mode.correctionId),
        pairs: [
          { pairIndex: 0, in: { time: null }, out: { time: null } },
          { pairIndex: 1, in: { time: null }, out: { time: null } },
        ],
      } as never)

    const activeSession = (id: string) =>
      prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId: id, status: 'IN_PROGRESS' } })

    beforeAll(async () => {
      const upload = await seedWeek(week, 'REVIEW')
      uploadId = upload.id
      await seedPunches(uploadId, week)
    })

    it('item 4: the summary carries the approval time of the attendance it used', async () => {
      const approved = await approveWeek(week)

      summary = await calculatePayroll(utc(week), utc(end))

      expect(summary.attendanceApprovedAt.getTime()).toBe(approved.approvedAt.getTime())
    })

    it('item 4: after the week is reopened and approved again, approving the old summary is ATTENDANCE_CHANGED', async () => {
      await reopenWeek(week)
      await new Promise((r) => setTimeout(r, 25))
      await approveWeek(week)

      await expect(approvePayroll(summary)).rejects.toMatchObject({ code: 'ATTENDANCE_CHANGED' })

      expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(week) } })).toBe(0)
    })

    it('item 4: while the week is reopened, payroll can neither be calculated nor approved (ATTENDANCE_NOT_APPROVED)', async () => {
      const fresh = await calculatePayroll(utc(week), utc(end))
      await reopenWeek(week)

      await expect(calculatePayroll(utc(week), utc(end))).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
      await expect(approvePayroll(fresh)).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
      await approveWeek(week)
    })

    it('item 4: a summary of the current approval is accepted, and the week can no longer be reopened', async () => {
      summary = await calculatePayroll(utc(week), utc(end))

      const approved = await approvePayroll(summary)
      runId = approved.payrollRunId

      expect(approved.employeeCount).toBe(2)
      await expect(reopenWeek(week)).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_APPROVED' })
      expect((await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe('APPROVED')
    })

    it('item 1: editing a correction\'s punches clears the draft pointer, and the older preview is REVISION_STALE', async () => {
      await correction.beginCorrection(runId)
      await correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db' } as never)
      const session = await activeSession(runId)
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: 1 }
      const edit = async (out: string) =>
        savePunchEdit({
          weekId: week, mode, employeeId: empA.id, date: week,
          baseSignature: await baseSignatureOf(week, empA.id, week, session.id),
          pairs: [
            { pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } },
            { pairIndex: 1, in: { time: '13:00' }, out: { time: out } },
          ],
        } as never)

      await edit('18:00')
      await correction.approveCorrectionPunches(runId)
      const stale = await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(stale.draftRevisionId).toBeTruthy()

      await edit('19:00') // a change after the preview was calculated
      expect((await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })).draftRevisionId).toBeNull()

      const liveBefore = JSON.stringify(
        await prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, correctionId: null }, orderBy: { id: 'asc' } }),
      )
      await expect(correction.approveRevision(stale.draftRevisionId!)).rejects.toMatchObject({ code: 'REVISION_STALE' })

      // Nothing was applied: the stale draft is still a draft, revision 1 is current, the live punches are untouched.
      expect((await prisma.payrollRevision.findUniqueOrThrow({ where: { id: stale.draftRevisionId! } })).status).toBe('DRAFT')
      expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('APPROVED')
      expect(
        JSON.stringify(await prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, correctionId: null }, orderBy: { id: 'asc' } })),
      ).toBe(liveBefore)
      expect((await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('IN_PROGRESS')

      // Approving the punches again gives a fresh draft; a save that changes nothing keeps its pointer.
      await correction.approveCorrectionPunches(runId)
      const fresh = await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(fresh.draftRevisionId).toBeTruthy()
      expect(fresh.draftRevisionId).not.toBe(stale.draftRevisionId)
      await edit('19:00')
      expect((await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })).draftRevisionId).toBe(fresh.draftRevisionId)

      // The matching draft approves, once.
      await expect(correction.approveRevision(fresh.draftRevisionId!)).resolves.toMatchObject({ status: 'APPROVED' })
      await expect(correction.approveRevision(fresh.draftRevisionId!)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })
      const records = await prisma.attendanceRecord.findMany({ where: { attendanceUploadId: uploadId, employeeId: empA.id, attendanceDate: utc(week) } })
      expect(Number(records[0].overtimeHours)).toBeGreaterThan(0) // 08:00-19:00 with a break: 3 h overtime
    })

    it('item 2: an employee deactivated after approval stays in the correction grid and keeps their records', async () => {
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: false } })
      await correction.beginCorrection(runId)
      await correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db 2' } as never)
      const session = await activeSession(runId)
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: 2 }

      const review = await getPunchReview(week, mode)
      expect(review.employees.find((e) => e.employeeId === empB.id)).toMatchObject({ tag: 'INACTIVE_APPROVED' })
      expect(review.counts.pendingDecisions).toBe(0)
      expect(review.approval.blockers).not.toContain('PENDING_DECISIONS')

      // The live week is approved, so its grid is locked; it would also list them only with a decision.
      const live = await getPunchReview(week, { kind: 'LIVE' })
      expect(live.employees.find((e) => e.employeeId === empB.id)).toBeUndefined()

      // An edit of their day is accepted in the correction.
      await expect(
        savePunchEdit({
          weekId: week, mode, employeeId: empB.id, date: week,
          baseSignature: await baseSignatureOf(week, empB.id, week, session.id),
          pairs: [
            { pairIndex: 0, in: { time: '08:30' }, out: { time: '12:00' } },
            { pairIndex: 1, in: { time: '13:00' }, out: { time: '17:00' } },
          ],
        } as never),
      ).resolves.toMatchObject({ day: { date: week } })

      await correction.approveCorrectionPunches(runId)
      const draftId = (await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })).draftRevisionId!
      await correction.approveRevision(draftId)

      // Their records survive, and they are paid in the new revision.
      expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId, employeeId: empB.id } })).toBe(7)
      const paid = await prisma.payrollRunEmployee.findMany({ where: { payrollRevisionId: draftId } })
      expect(paid.map((p) => p.employeeId).sort()).toEqual([empA.id, empB.id].sort())
    })

    it('item 7: an employee a correction leaves out has their pending and approved adjustments carried forward; the rest is untouched', async () => {
      const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })
      const weekStart = utc(week)
      const nextWeek = utc(addDays(week, 7))
      const adjustment = (employeeId: string, status = 'ACTIVE') =>
        prisma.payrollAdjustment.create({
          data: {
            employeeId, adjustmentType: 'DEDUCTION', recurrenceType: 'ONE_TIME', amount: 100, reason: 'f12 db',
            startPayrollWeekStartDate: weekStart, startPayrollWeekEndDate: utc(end), status,
          },
        })
      const application = (adjId: string, employeeId: string, approvalStatus: string, over: Record<string, unknown> = {}) =>
        prisma.payrollAdjustmentApplication.create({
          data: {
            payrollAdjustmentId: adjId, employeeId, payrollWeekStartDate: weekStart, payrollWeekEndDate: utc(end),
            appliedAmount: 100, approvalStatus, ...over,
          },
        })

      // B had an application skipped before the correction starts: the snapshot knows it was already carried forward.
      const adjB = await adjustment(empB.id)
      const bSkipped = await application(adjB.id, empB.id, 'SKIPPED', { skippedAt: new Date('2026-03-01T00:00:00Z') })

      await correction.beginCorrection(runId)
      await correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db 3' } as never)
      const session = await activeSession(runId)
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: run.currentRevisionNumber }

      // Applications added during the correction, for the employee who is about to be left out (B) and one who stays (A).
      const adjBCancelled = await adjustment(empB.id, 'CANCELLED')
      const adjA = await adjustment(empA.id)
      const bApproved = await application(adjB.id, empB.id, 'APPROVED', { payrollRunId: runId, approvedAt: new Date() })
      const bPending = await application(adjB.id, empB.id, 'PENDING')
      const bCancelledAdj = await application(adjBCancelled.id, empB.id, 'PENDING')
      const aApproved = await application(adjA.id, empA.id, 'APPROVED', { payrollRunId: runId, approvedAt: new Date() })
      const aPending = await application(adjA.id, empA.id, 'PENDING')

      // Delete every punch of B for the week: zero hours, so B is left out of the revision.
      for (let d = 0; d < 7; d++) await clearDay(addDays(week, d), empB.id, mode)
      await correction.approveCorrectionPunches(runId)
      const draftId = (await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })).draftRevisionId!
      await correction.approveRevision(draftId)

      const status = async (id: string) => prisma.payrollAdjustmentApplication.findUniqueOrThrow({ where: { id } })
      // B's approved and pending applications are skipped and carried to the next week.
      for (const id of [bApproved.id, bPending.id]) {
        const row = await status(id)
        expect(row.approvalStatus, id).toBe('SKIPPED')
        expect(row.carriedForwardToPayrollWeekStartDate?.toISOString(), id).toBe(nextWeek.toISOString())
      }
      const carried = await prisma.payrollAdjustmentApplication.findMany({ where: { payrollAdjustmentId: adjB.id, payrollWeekStartDate: nextWeek } })
      expect(carried).toHaveLength(1)
      expect(carried[0].approvalStatus).toBe('PENDING')
      // Already skipped, on a cancelled adjustment, or for an employee who is paid: untouched.
      expect((await status(bSkipped.id)).skippedAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
      expect((await status(bCancelledAdj.id)).approvalStatus).toBe('PENDING')
      expect((await status(aApproved.id)).approvalStatus).toBe('APPROVED')
      expect((await status(aPending.id)).approvalStatus).toBe('PENDING')
      expect(await prisma.payrollAdjustmentApplication.count({ where: { payrollAdjustmentId: adjBCancelled.id, payrollWeekStartDate: nextWeek } })).toBe(0)
      // B has no payslip in the new revision.
      const paid = await prisma.payrollRunEmployee.findMany({ where: { payrollRevisionId: draftId } })
      expect(paid.map((p) => p.employeeId)).toEqual([empA.id])
    })
  })

  // ─── Round 3, item 1: one approved payroll run per week ─────────────────────

  describe('round 3 item 1: PayrollRun.approvedWeekStart and approvePayroll', () => {
    const week = W.apr1
    const end = addDays(week, 6)

    beforeAll(async () => {
      // An earlier test in this file leaves empB deactivated; the round 3 blocks need both employees active.
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      const upload = await seedWeek(week, 'REVIEW')
      await seedPunches(upload.id, week)
      await approveWeek(week)
    })

    it('two approvePayroll calls started together create one run and one revision; the other is PAYROLL_ALREADY_EXISTS', async (ctx) => {
      const summary = await calculatePayroll(utc(week), utc(end))

      const results = await Promise.allSettled([approvePayroll(summary), approvePayroll(summary)])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: 'Payroll for this week is already approved' })

      const runs = await prisma.payrollRun.findMany({ where: { payrollWeekStartDate: utc(week) } })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      expect(runs[0].approvedWeekStart?.toISOString()).toBe(utc(week).toISOString())
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: runs[0].id } })).toBe(1)
      expect(await prisma.payrollRunEmployee.count({ where: { payrollRunId: runs[0].id } })).toBe(2)
    })

    it('a later call is refused by the pre-check and changes nothing', async () => {
      const summary = await calculatePayroll(utc(week), utc(end)).catch(() => null)
      // The week is still approved attendance, but payroll exists: calculatePayroll may refuse; build the call from the run.
      const run = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: utc(week) } })
      const attendanceApprovedAt = (await prisma.attendanceUpload.findFirstOrThrow({ where: { payrollWeekStartDate: utc(week), isActiveForPayrollWeek: true } })).approvedAt!
      const second = summary ?? {
        weekStart: utc(week), weekEnd: utc(end), attendanceApprovedAt, employees: [],
        totals: { totalRegularHours: 0, totalOvertimeHours: 0, totalRegularPay: 0, totalOvertimePay: 0, totalAdditions: 0, totalDeductions: 0, totalNetPayable: 0 },
      }

      await expect(approvePayroll(second as never)).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })

      expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(week) } })).toBe(1)
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: run.id } })).toBe(1)
    })

    describe('the unique key itself', () => {
      const wk = W.apr2
      const totals = { totalRegularPay: 0, totalOvertimePay: 0, totalAdditions: 0, totalDeductions: 0, totalNetPayable: 0 }
      const run = (status: string, key: Date | null, over: Record<string, unknown> = {}) =>
        prisma.payrollRun.create({
          data: { payrollWeekStartDate: utc(wk), payrollWeekEndDate: utc(addDays(wk, 6)), status, approvedWeekStart: key, ...totals, ...over },
        })

      it('a second run holding the same approvedWeekStart is refused with P2002 on that column', async () => {
        await run('APPROVED', utc(wk))

        const error = await run('APPROVED', utc(wk)).catch((e) => e)

        expect(error).toMatchObject({ code: 'P2002' })
        expect(JSON.stringify(error.meta)).toContain('approvedWeekStart')
        expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(wk) } })).toBe(1)
      })

      it('the constraint is in the database, not only in Prisma: a plain SQL insert violates it too (23505)', async () => {
        const client = new Client({ connectionString: URL })
        await client.connect()
        try {
          const error = await client
            .query(
              `INSERT INTO "PayrollRun" (id, "payrollWeekStartDate", "payrollWeekEndDate", status, "currentRevisionNumber",
               "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable", "approvedWeekStart")
               VALUES ('f12db-raw-dup', $1::timestamp, $2::timestamp, 'APPROVED', 1, 0, 0, 0, 0, 0, $1::timestamp)`,
              [`${wk} 00:00:00`, `${addDays(wk, 6)} 00:00:00`], // zone-less text: pg would shift a JS Date into local time
            )
            .catch((e) => e)
          expect(error).toMatchObject({ code: '23505', constraint: 'PayrollRun_approvedWeekStart_key' })
        } finally {
          await client.end()
        }
      })

      it('rows with a NULL key are unlimited (DRAFT beside the APPROVED run, and several of them)', async () => {
        await run('DRAFT', null)
        await run('DRAFT', null)

        expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(wk) } })).toBe(3)
      })

      it('a different week takes its own key; the same week cannot take it back after a REVISED update', async () => {
        const other = addDays(wk, 7)
        await prisma.payrollRun.create({
          data: { payrollWeekStartDate: utc(other), payrollWeekEndDate: utc(addDays(other, 6)), status: 'APPROVED', approvedWeekStart: utc(other), ...totals },
        })
        const approved = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: utc(wk), status: 'APPROVED' } })

        await prisma.payrollRun.update({ where: { id: approved.id }, data: { status: 'REVISED' } })

        const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: approved.id } })
        expect(after.approvedWeekStart?.toISOString()).toBe(utc(wk).toISOString()) // the app never clears it
        await expect(run('APPROVED', utc(wk))).rejects.toMatchObject({ code: 'P2002' })
        await prisma.payrollRun.deleteMany({ where: { payrollWeekStartDate: utc(other) } })
      })

      it('approvePayroll refuses a week whose run is legacy (NULL key): the existing run is found by status', async () => {
        const legacyWeek = addDays(wk, 14)
        await prisma.payrollRun.create({
          data: { payrollWeekStartDate: utc(legacyWeek), payrollWeekEndDate: utc(addDays(legacyWeek, 6)), status: 'APPROVED', approvedWeekStart: null, ...totals },
        })
        const summary = {
          weekStart: utc(legacyWeek), weekEnd: utc(addDays(legacyWeek, 6)), attendanceApprovedAt: new Date(), employees: [],
          totals: { totalRegularHours: 0, totalOvertimeHours: 0, ...totals },
        }

        await expect(approvePayroll(summary as never)).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })

        expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(legacyWeek) } })).toBe(1)
        await prisma.payrollRun.deleteMany({ where: { payrollWeekStartDate: utc(legacyWeek) } })
      })
    })
  })

  // ─── Round 3, item 1: scripts/backfill-approved-week-start.js ────────────────

  describe('round 3 item 1: scripts/backfill-approved-week-start.js', () => {
    const totals = { totalRegularPay: 0, totalOvertimePay: 0, totalAdditions: 0, totalDeductions: 0, totalNetPayable: 0 }
    const runRow = (id: string, wk: string, status: string, key: string | null) =>
      prisma.payrollRun.create({
        data: {
          id, payrollWeekStartDate: utc(wk), payrollWeekEndDate: utc(addDays(wk, 6)), status,
          approvedWeekStart: key ? utc(key) : null, approvedAt: new Date('2026-07-01T00:00:00Z'), ...totals,
        },
      })
    const run = () => runBackfill(undefined, BACKFILL_APPROVED)
    const snapshot = async () =>
      JSON.stringify(await prisma.payrollRun.findMany({ select: { id: true, status: true, approvedWeekStart: true }, orderBy: { id: 'asc' } }))
    const keyOf = async (id: string) => (await prisma.payrollRun.findUniqueOrThrow({ where: { id } })).approvedWeekStart?.toISOString() ?? null
    const ids = (...names: string[]) => names.map((n) => `f12db-apw-${n}`)

    beforeAll(async () => {
      // Normalise the table first so the counts below are exactly this block's rows.
      const first = run()
      expect(first.code, first.stdout + first.stderr).toBe(0)
    }, 60000)

    it('fills the key of APPROVED and REVISED runs from their week start, clears a stale key on a DRAFT run, and reports exact counts', async () => {
      await runRow('f12db-apw-a', W.apr3, 'APPROVED', null) // legacy: no key yet
      await runRow('f12db-apw-b', W.apr4, 'REVISED', null)
      await runRow('f12db-apw-c', W.apr7, 'APPROVED', W.apr7) // already keyed: untouched
      await runRow('f12db-apw-d', W.apr3, 'DRAFT', W.apr3) // not approved but holding a key (stale)
      await runRow('f12db-apw-e', W.apr4, 'DRAFT', null) // not approved, no key: untouched

      const result = run()

      expect(result.code, result.stderr).toBe(0)
      expect(count(result.stdout, 'Weeks with several approved runs')).toBe(0)
      expect(count(result.stdout, 'Stale keys cleared on runs that are not approved')).toBe(1)
      expect(count(result.stdout, 'approvedWeekStart filled')).toBe(2)
      expect(await keyOf('f12db-apw-a')).toBe(utc(W.apr3).toISOString())
      expect(await keyOf('f12db-apw-b')).toBe(utc(W.apr4).toISOString())
      expect(await keyOf('f12db-apw-c')).toBe(utc(W.apr7).toISOString())
      expect(await keyOf('f12db-apw-d')).toBeNull()
      expect(await keyOf('f12db-apw-e')).toBeNull()
    })

    it('after the backfill the database refuses a second approved run for a backfilled week', async () => {
      await expect(runRow('f12db-apw-x', W.apr3, 'APPROVED', W.apr3)).rejects.toMatchObject({ code: 'P2002' })
    })

    it('is idempotent: a second run reports zero everywhere and changes nothing', async () => {
      const before = await snapshot()

      const again = run()

      expect(again.code, again.stderr).toBe(0)
      expect(count(again.stdout, 'Weeks with several approved runs')).toBe(0)
      expect(count(again.stdout, 'Stale keys cleared on runs that are not approved')).toBe(0)
      expect(count(again.stdout, 'approvedWeekStart filled')).toBe(0)
      expect(await snapshot()).toBe(before)
    })

    it('refuses to run while a week has two APPROVED/REVISED runs: exit 1, both runs named, nothing changed anywhere', async () => {
      await runRow('f12db-apw-dup1', W.apr5, 'APPROVED', null)
      await runRow('f12db-apw-dup2', W.apr5, 'REVISED', null)
      await runRow('f12db-apw-legacy', W.apr6, 'APPROVED', null) // another week that WOULD be filled
      await runRow('f12db-apw-stale', W.apr6, 'DRAFT', W.apr6) // and a stale key that WOULD be cleared
      const before = await snapshot()

      const result = run()

      try {
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('more than one APPROVED/REVISED payroll run')
        expect(result.stderr).toContain('f12db-apw-dup1')
        expect(result.stderr).toContain('f12db-apw-dup2')
        expect(result.stderr).toContain('Resolve by hand: exactly one APPROVED/REVISED run per week must remain.')
        expect(result.stdout).not.toMatch(/approvedWeekStart filled: \d+/) // it never got as far as reporting
        expect(await snapshot()).toBe(before) // the other week was not filled, the stale key not cleared
        expect(await keyOf('f12db-apw-legacy')).toBeNull()
        expect(await keyOf('f12db-apw-stale')).toBe(utc(W.apr6).toISOString())
      } finally {
        await prisma.payrollRun.deleteMany({ where: { id: { in: ids('dup1', 'dup2', 'legacy', 'stale') } } })
      }
    })

    it('names the duplicate week by its Thursday (the date a person will look up), whatever time zone the script runs in', async () => {
      await runRow('f12db-apw-tz1', W.apr5, 'APPROVED', null)
      await runRow('f12db-apw-tz2', W.apr5, 'REVISED', null)

      const result = run()

      try {
        expect(result.code).toBe(1)
        // The week start is a UTC-midnight timestamp without a zone; read in a zone east of UTC it is
        // the evening before, so a script that formats it carelessly names the Wednesday.
        expect(result.stderr).toContain(`${W.apr5}: `)
      } finally {
        await prisma.payrollRun.deleteMany({ where: { id: { in: ids('tz1', 'tz2') } } })
      }
    })

    it('after the duplicate is resolved by hand (one run deleted) the script succeeds', async () => {
      await runRow('f12db-apw-dup1', W.apr5, 'APPROVED', null)
      await runRow('f12db-apw-dup2', W.apr5, 'REVISED', null)
      expect(run().code).toBe(1)

      await prisma.payrollRun.delete({ where: { id: 'f12db-apw-dup2' } })
      const result = run()

      expect(result.code, result.stderr).toBe(0)
      expect(await keyOf('f12db-apw-dup1')).toBe(utc(W.apr5).toISOString())
    })

    it('two DRAFT runs (or a DRAFT beside an APPROVED one) in a week are not duplicates', async () => {
      await runRow('f12db-apw-g1', W.apr6, 'DRAFT', null)
      await runRow('f12db-apw-g2', W.apr6, 'DRAFT', null)
      await runRow('f12db-apw-g3', W.apr6, 'APPROVED', null)

      const result = run()

      expect(result.code, result.stderr).toBe(0)
      expect(await keyOf('f12db-apw-g3')).toBe(utc(W.apr6).toISOString())
      expect(await keyOf('f12db-apw-g1')).toBeNull()
    })

    it('is all-or-nothing: when the fill hits the unique index the cleared stale key comes back', async () => {
      // A mis-keyed APPROVED run holds week apr7's key... on week apr8; apr7's own APPROVED run has no key.
      // (apw-c above holds apr7's key legitimately, so use a fresh pair on two other weeks.)
      const wk1 = addDays(W.apr7, 7)
      const wk2 = addDays(W.apr7, 14)
      await runRow('f12db-apw-mis', wk1, 'APPROVED', wk2) // approved, keyed with ANOTHER week's start
      await runRow('f12db-apw-need', wk2, 'APPROVED', null) // its fill would collide with the mis-keyed row
      await runRow('f12db-apw-clr', wk1, 'DRAFT', wk1) // a stale key the script clears first
      const before = await snapshot()

      const result = run()

      try {
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Backfill failed')
        expect(await snapshot()).toBe(before) // the DRAFT's cleared key was rolled back too
        expect(await keyOf('f12db-apw-clr')).toBe(utc(wk1).toISOString())
      } finally {
        await prisma.payrollRun.deleteMany({ where: { id: { in: ids('mis', 'need', 'clr') } } })
      }
    })

    it('prints where it is pointed (host, port, database) and never the login', () => {
      const result = run()

      expect(result.stdout).toMatch(/^Target: (localhost|127\.0\.0\.1):\d+\//m)
      expect(result.stdout + result.stderr).not.toContain('postgres:postgres')
      expect(result.stdout + result.stderr).not.toMatch(/password/i)
    })

    it('stops with a message and exit code 1 when no connection string is set', () => {
      const result = runBackfill({ DIRECT_DATABASE_URL: '', DATABASE_URL: '' }, BACKFILL_APPROVED)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Set DIRECT_DATABASE_URL or DATABASE_URL first.')
    })

    it('exits 1 with "Backfill failed" when the database is unreachable', () => {
      const result = runBackfill({ DIRECT_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', DATABASE_URL: '' }, BACKFILL_APPROVED)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Backfill failed')
      expect(result.stdout + result.stderr).not.toContain('u:p@')
    })
  })

  // ─── Round 3, item 6: scripts/backfill-active-week-start.js keeps the row that holds data ─

  describe('round 3 item 6: the active-week backfill keeps the row that holds data', () => {
    const run = () => runBackfill()
    const legacy = (id: string, wk: string, uploadedAt: string, status: string, over: Record<string, unknown> = {}) =>
      prisma.attendanceUpload.create({
        data: {
          id, source: 'ETIMEOFFICE', payrollWeekSource: 'ETIMEOFFICE', status, isActiveForPayrollWeek: true,
          activeWeekStart: null, // legacy: before the key existed
          payrollWeekStartDate: utc(wk), payrollWeekEndDate: utc(addDays(wk, 6)), uploadedAt: new Date(uploadedAt), ...over,
        },
      })
    const withPunch = (uploadId: string, wk: string) =>
      prisma.attendancePunch.create({
        data: {
          attendanceUploadId: uploadId, employeeId: empA.id, empCode: '9101', matchStatus: 'MATCHED', punchDate: utc(wk),
          pairIndex: 0, position: 'IN', source: 'API', originalTime: '08:00', currentTime: '08:00',
        },
      })
    const withRecord = (uploadId: string, wk: string) =>
      prisma.attendanceRecord.create({
        data: { attendanceUploadId: uploadId, employeeId: empA.id, attendanceDate: utc(wk), regularHours: 8, overtimeHours: 0 },
      })
    const rows = (wk: string) =>
      prisma.attendanceUpload.findMany({
        where: { payrollWeekStartDate: utc(wk) },
        select: { id: true, status: true, isActiveForPayrollWeek: true, activeWeekStart: true },
        orderBy: { id: 'asc' },
      })
    const winnerOf = async (wk: string) => (await rows(wk)).filter((r) => r.isActiveForPayrollWeek).map((r) => r.id)
    const snapshot = async () =>
      JSON.stringify(await prisma.attendanceUpload.findMany({ select: { id: true, isActiveForPayrollWeek: true, activeWeekStart: true }, orderBy: { id: 'asc' } }))

    beforeAll(async () => {
      expect(run().code).toBe(0) // normalise: later counts are this block's own rows

      // aw1: an older APPROVED week with records vs a newer empty REVIEW placeholder.
      await legacy('f12db-aw1-approved', W.aw1, '2026-08-06T08:00:00Z', 'APPROVED', { approvedAt: new Date('2026-08-06T09:00:00Z') })
      await withRecord('f12db-aw1-approved', W.aw1)
      await legacy('f12db-aw1-placeholder', W.aw1, '2026-08-13T08:00:00Z', 'REVIEW')
      // aw2: two REVIEW rows, the older one has punches.
      await legacy('f12db-aw2-data', W.aw2, '2026-08-13T08:00:00Z', 'REVIEW')
      await withPunch('f12db-aw2-data', W.aw2)
      await legacy('f12db-aw2-empty', W.aw2, '2026-08-20T08:00:00Z', 'REVIEW')
      // aw3: both hold data; the newer wins (the old tie-breakers still apply after data).
      await legacy('f12db-aw3-old', W.aw3, '2026-08-20T08:00:00Z', 'REVIEW')
      await withPunch('f12db-aw3-old', W.aw3)
      await legacy('f12db-aw3-new', W.aw3, '2026-08-27T08:00:00Z', 'REVIEW')
      await withPunch('f12db-aw3-new', W.aw3)
      // aw4: records only (no punches) beat an empty row of the same status.
      await legacy('f12db-aw4-records', W.aw4, '2026-08-27T08:00:00Z', 'APPROVED', { approvedAt: new Date('2026-08-27T09:00:00Z') })
      await withRecord('f12db-aw4-records', W.aw4)
      await legacy('f12db-aw4-empty', W.aw4, '2026-09-03T08:00:00Z', 'APPROVED', { approvedAt: new Date('2026-09-03T09:00:00Z') })
      // aw5: a READY (Excel) row with records ranks with APPROVED: it beats a newer empty REVIEW.
      await legacy('f12db-aw5-excel', W.aw5, '2026-09-03T08:00:00Z', 'READY', { source: 'EXCEL', payrollWeekSource: 'FILE_NAME', fileName: 'x.xlsx', fileType: 'xlsx' })
      await withRecord('f12db-aw5-excel', W.aw5)
      await legacy('f12db-aw5-review', W.aw5, '2026-09-10T08:00:00Z', 'REVIEW')
      // aw6: status ranks before data: a REVIEW row without data beats an older SYNC_FAILED row with punches.
      await legacy('f12db-aw6-failed', W.aw6, '2026-09-10T08:00:00Z', 'SYNC_FAILED')
      await withPunch('f12db-aw6-failed', W.aw6)
      await legacy('f12db-aw6-review', W.aw6, '2026-09-17T08:00:00Z', 'REVIEW')
      // aw7: the stale-key state: an inactive row still holding the key + the active row without it.
      await legacy('f12db-aw7-inactive', W.aw7, '2026-09-10T08:00:00Z', 'SYNC_FAILED', { isActiveForPayrollWeek: false, activeWeekStart: utc(W.aw7) })
      await legacy('f12db-aw7-active', W.aw7, '2026-09-17T08:00:00Z', 'REVIEW')
      // aw8: three active rows: APPROVED with data, REVIEW with data, newest empty SYNC_FAILED.
      await legacy('f12db-aw8-a', W.aw8, '2026-09-17T08:00:00Z', 'APPROVED', { approvedAt: new Date('2026-09-17T09:00:00Z') })
      await withRecord('f12db-aw8-a', W.aw8)
      await legacy('f12db-aw8-b', W.aw8, '2026-09-18T08:00:00Z', 'REVIEW')
      await withPunch('f12db-aw8-b', W.aw8)
      await legacy('f12db-aw8-c', W.aw8, '2026-09-19T08:00:00Z', 'SYNC_FAILED')
    }, 120000)

    let first: ReturnType<typeof runBackfill>
    let beforeSecond: string

    it('runs to completion (exit 0) on a state that holds a stale key on an inactive row', async () => {
      // The old script failed here: the inactive row's key made the fill hit the unique index (rolled back, exit 1).
      first = run()
      expect(first.code, first.stdout + first.stderr).toBe(0)
      beforeSecond = await snapshot()
    })

    it('an older APPROVED week with records keeps the key; the newer empty REVIEW placeholder is deactivated with a NULL key', async () => {
      const r = await rows(W.aw1)
      expect(r.find((x) => x.id === 'f12db-aw1-approved')).toMatchObject({ isActiveForPayrollWeek: true, activeWeekStart: utc(W.aw1) })
      expect(r.find((x) => x.id === 'f12db-aw1-placeholder')).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })
    })

    it('two REVIEW rows: the one with punches wins even though it is older', async () => {
      expect(await winnerOf(W.aw2)).toEqual(['f12db-aw2-data'])
      expect((await rows(W.aw2)).find((x) => x.id === 'f12db-aw2-empty')).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })
    })

    it('both hold data: the newest uploadedAt wins', async () => {
      expect(await winnerOf(W.aw3)).toEqual(['f12db-aw3-new'])
    })

    it('records alone count as data', async () => {
      expect(await winnerOf(W.aw4)).toEqual(['f12db-aw4-records'])
    })

    it('a READY (Excel) row with records beats a newer empty REVIEW row', async () => {
      expect(await winnerOf(W.aw5)).toEqual(['f12db-aw5-excel'])
    })

    it('status ranks before data: an empty REVIEW row beats an older SYNC_FAILED row that has punches', async () => {
      expect(await winnerOf(W.aw6)).toEqual(['f12db-aw6-review'])
    })

    it('a stale key on an inactive row is cleared and the active row takes the key', async () => {
      const r = await rows(W.aw7)
      expect(r.find((x) => x.id === 'f12db-aw7-inactive')).toMatchObject({ isActiveForPayrollWeek: false, activeWeekStart: null })
      expect(r.find((x) => x.id === 'f12db-aw7-active')).toMatchObject({ isActiveForPayrollWeek: true, activeWeekStart: utc(W.aw7) })
    })

    it('three active rows: APPROVED with records wins over REVIEW with punches and a newer SYNC_FAILED', async () => {
      expect(await winnerOf(W.aw8)).toEqual(['f12db-aw8-a'])
    })

    it('every deactivated row has a NULL key, and every week has exactly one active row holding the week start as its key', async () => {
      for (const wk of [W.aw1, W.aw2, W.aw3, W.aw4, W.aw5, W.aw6, W.aw7, W.aw8]) {
        const r = await rows(wk)
        expect(r.filter((x) => x.isActiveForPayrollWeek), wk).toHaveLength(1)
        for (const x of r) {
          expect(x.activeWeekStart?.toISOString() ?? null, `${wk} ${x.id}`).toBe(x.isActiveForPayrollWeek ? utc(wk).toISOString() : null)
        }
      }
    })

    it('prints the stale-key count and each deactivated row (week, id, status) and the totals', () => {
      expect(count(first.stdout, 'Stale keys cleared on inactive rows')).toBeGreaterThanOrEqual(1)
      expect(first.stdout).toMatch(/deactivated: week \d{4}-\d{2}-\d{2}, f12db-aw1-placeholder, REVIEW/)
      expect(first.stdout).toMatch(/deactivated: week \d{4}-\d{2}-\d{2}, f12db-aw6-failed, SYNC_FAILED/)
      expect(first.stdout).toMatch(/deactivated: week \d{4}-\d{2}-\d{2}, f12db-aw8-b, REVIEW/)
      expect(first.stdout).toMatch(/deactivated: week \d{4}-\d{2}-\d{2}, f12db-aw8-c, SYNC_FAILED/)
      const lines = first.stdout.split('\n').filter((l) => l.trim().startsWith('deactivated:'))
      expect(count(first.stdout, 'Duplicate active rows deactivated')).toBe(lines.length)
      expect(lines.length).toBe(8) // aw1..aw6 one each, aw8 two, aw7 none (its duplicate was inactive already)
    })

    it('names each deactivated week by its Thursday, whatever time zone the script runs in', () => {
      // Same time-zone trap as the approved-run script: the week start is a zone-less timestamp.
      expect(first.stdout).toContain(`deactivated: week ${W.aw1}, f12db-aw1-placeholder, REVIEW`)
      expect(first.stdout).toContain(`deactivated: week ${W.aw6}, f12db-aw6-failed, SYNC_FAILED`)
      expect(first.stdout).toContain(`deactivated: week ${W.aw8}, f12db-aw8-b, REVIEW`)
      expect(first.stdout).toContain(`deactivated: week ${W.aw8}, f12db-aw8-c, SYNC_FAILED`)
    })

    it('a second run changes nothing and reports zero', async () => {
      const again = run()

      expect(again.code, again.stderr).toBe(0)
      expect(count(again.stdout, 'Stale keys cleared on inactive rows')).toBe(0)
      expect(count(again.stdout, 'Duplicate active rows deactivated')).toBe(0)
      expect(count(again.stdout, 'activeWeekStart filled')).toBe(0)
      expect(await snapshot()).toBe(beforeSecond)
    })

    it('after the backfill the database refuses a second active row for those weeks', async () => {
      await expect(seedWeek(W.aw1, 'REVIEW')).rejects.toMatchObject({ code: 'P2002' })
      await expect(seedWeek(W.aw8, 'REVIEW')).rejects.toMatchObject({ code: 'P2002' })
    })
  })

  // ─── Round 3, items 2 and 5: writers on a real database ─────────────────────

  describe('round 3 item 2: employee-check writers take the week lock and still do their work', () => {
    let uploadId: string
    let empC: { id: string }
    let empD: { id: string }
    let ec: typeof import('@/features/attendance-sync/services/employee-check.service')

    const punch = (employeeId: string | null, empCode: string, matchStatus: string, day: number, pairIndex = 0, position = 'IN', time = '08:00') =>
      ({
        attendanceUploadId: uploadId, employeeId, empCode, matchStatus, punchDate: utc(addDays(W.codes, day)),
        pairIndex, position, source: 'API', originalTime: time, currentTime: time,
      })

    beforeAll(async () => {
      ec = await import('@/features/attendance-sync/services/employee-check.service')
      const mk = (code: string, name: string, over: Record<string, unknown> = {}) =>
        prisma.employee.create({
          data: {
            employeeId: code, employeeName: name, designation: 'Guard', designationShort: 'G', site: 'Gate', isActive: true,
            wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
            ...over,
          },
        })
      empC = await mk('TPLF12DB9303', 'F12 Charlie')
      empD = await mk('TPLF12DB9304', 'F12 Delta (inactive)', { isActive: false })
      const upload = await seedWeek(W.codes, 'REVIEW')
      uploadId = upload.id
      await prisma.attendancePunch.createMany({
        data: [
          // empA already has a pair on day 0, so code 9301 is appended after it.
          punch(empA.id, '9101', 'MATCHED', 0, 0, 'IN'), punch(empA.id, '9101', 'MATCHED', 0, 0, 'OUT', '12:00'),
          punch(null, '9301', 'UNKNOWN', 0, 0, 'IN', '13:00'), punch(null, '9301', 'UNKNOWN', 0, 0, 'OUT', '17:00'),
          punch(null, '9302', 'UNKNOWN', 1, 0, 'IN'), punch(null, '9302', 'UNKNOWN', 1, 0, 'OUT', '12:00'),
          punch(null, '9303', 'UNKNOWN', 2, 0, 'IN'), punch(null, '9303', 'UNKNOWN', 2, 0, 'OUT', '12:00'),
          punch(empD.id, '9304', 'MATCHED', 3, 0, 'IN'), punch(empD.id, '9304', 'MATCHED', 3, 0, 'OUT', '12:00'),
        ] as never,
      })
    }, 60000)

    const punchesOf = (code: string) =>
      prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, empCode: code }, orderBy: [{ punchDate: 'asc' }, { pairIndex: 'asc' }, { position: 'desc' }] })

    it('matchCodeToEmployee links the code, appends its pair after the employee\'s existing pair and saves a MATCH exception', async () => {
      const result = await ec.matchCodeToEmployee(W.codes, '9301', empA.id)

      expect(result).toEqual({ linkedPunches: 2 })
      const rows = await punchesOf('9301')
      expect(rows.map((r) => [r.matchStatus, r.employeeId, r.pairIndex])).toEqual([
        ['MATCHED', empA.id, 1],
        ['MATCHED', empA.id, 1],
      ])
      expect(await prisma.attendanceCodeException.findUnique({ where: { empCode: '9301' } })).toMatchObject({ kind: 'MATCH', employeeId: empA.id })
      expect(await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', detailsJson: { path: ['empCode'], equals: '9301' } } })).toBe(1)
    })

    it('a second match of the same code is CODE_NOT_FOUND (it is resolved now) and changes nothing', async () => {
      await expect(ec.matchCodeToEmployee(W.codes, '9301', empA.id)).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })

      expect((await punchesOf('9301')).every((r) => r.pairIndex === 1)).toBe(true)
      expect(await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', detailsJson: { path: ['empCode'], equals: '9301' } } })).toBe(1)
    })

    it('ignoreCode marks the code IGNORED and saves an IGNORE exception; ignoring again is CODE_NOT_FOUND', async () => {
      await expect(ec.ignoreCode(W.codes, '9302')).resolves.toEqual({ ignoredPunches: 2 })

      expect((await punchesOf('9302')).map((r) => [r.matchStatus, r.employeeId])).toEqual([['IGNORED', null], ['IGNORED', null]])
      expect(await prisma.attendanceCodeException.findUnique({ where: { empCode: '9302' } })).toMatchObject({ kind: 'IGNORE', employeeId: null })
      await expect(ec.ignoreCode(W.codes, '9302')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
    })

    it('rematchWeekCodes links a code to the employee created after the fix, in one transaction, and writes its audit row', async () => {
      const result = await ec.rematchWeekCodes(W.codes)

      expect(result.matched).toEqual([{ empCode: '9303', employeeId: empC.id, employeeCode: 'TPLF12DB9303' }])
      expect(result.stillUnresolved).toEqual([])
      expect((await punchesOf('9303')).every((r) => r.matchStatus === 'MATCHED' && r.employeeId === empC.id)).toBe(true)
      expect(await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', detailsJson: { path: ['empCode'], equals: '9303' } } })).toBe(1)
      // Nothing is left to do: a second rematch changes nothing.
      await expect(ec.rematchWeekCodes(W.codes)).resolves.toEqual({ matched: [], stillUnresolved: [] })
    })

    it('setEmployeeDecision records a decision for an inactive employee with punches, then changes it, with the audit trail', async () => {
      await expect(ec.setEmployeeDecision(W.codes, empD.id, 'APPROVED')).resolves.toEqual({ decision: 'APPROVED' })
      await expect(ec.setEmployeeDecision(W.codes, empD.id, 'REJECTED')).resolves.toEqual({ decision: 'REJECTED' })

      const decision = await prisma.attendanceEmployeeDecision.findUniqueOrThrow({
        where: { attendanceUploadId_employeeId: { attendanceUploadId: uploadId, employeeId: empD.id } },
      })
      expect(decision).toMatchObject({ decision: 'REJECTED', reason: 'INACTIVE' })
      expect(await prisma.auditLog.count({ where: { entityId: decision.id, entityType: 'ATTENDANCE_DECISION' } })).toBe(2)
    })

    it('an employee who does not need a decision is refused (VALIDATION_ERROR) and no decision row appears', async () => {
      await expect(ec.setEmployeeDecision(W.codes, empA.id, 'APPROVED')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: uploadId, employeeId: empA.id } })).toBe(0)
    })

    it('a fresh pull lock refuses all four writers with SYNC_IN_PROGRESS and the shared message; a stale lock does not', async () => {
      await prisma.attendancePunch.create({ data: punch(null, '9302', 'UNKNOWN', 4, 0, 'IN') as never })
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date() } })
      const message = 'A pull is running for this week. Wait for it to finish, then try again.'
      try {
        await expect(ec.matchCodeToEmployee(W.codes, '9302', empA.id)).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message })
        await expect(ec.ignoreCode(W.codes, '9302')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message })
        await expect(ec.rematchWeekCodes(W.codes)).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message })
        await expect(ec.setEmployeeDecision(W.codes, empD.id, 'APPROVED')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message })
      } finally {
        await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date(Date.now() - 6 * 60 * 1000) } })
      }
      await expect(ec.ignoreCode(W.codes, '9302')).resolves.toEqual({ ignoredPunches: 1 })
    })

    it('an approved week refuses all four writers with WEEK_LOCKED and writes nothing', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { status: 'APPROVED', approvedAt: new Date(), syncLockedAt: null } })
      const decisionsBefore = await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: uploadId } })
      const exceptionsBefore = await prisma.attendanceCodeException.count()
      try {
        await expect(ec.matchCodeToEmployee(W.codes, '9302', empA.id)).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
        await expect(ec.ignoreCode(W.codes, '9302')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
        await expect(ec.rematchWeekCodes(W.codes)).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
        await expect(ec.setEmployeeDecision(W.codes, empD.id, 'APPROVED')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
      } finally {
        await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { status: 'REVIEW', approvedAt: null } })
      }
      expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: uploadId } })).toBe(decisionsBefore)
      expect(await prisma.attendanceCodeException.count()).toBe(exceptionsBefore)
    })
  })

  describe('round 3 item 5: two saves of the same empty employee-day', () => {
    const week = W.day
    const pairs = [{ pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } }]

    beforeAll(async () => {
      const upload = await seedWeek(week, 'REVIEW')
      await seedPunches(upload.id, week, [empA]) // empB has nothing: the day is empty
    })

    it('started together they leave exactly one IN and one OUT; every refusal is DAY_CHANGED, never an unexpected error', async (ctx) => {
      // Both editors opened the same empty day, so they carry the same version.
      const baseSignature = await baseSignatureOf(week, empB.id, week)
      const save = () => savePunchEdit({ weekId: week, mode: { kind: 'LIVE' }, employeeId: empB.id, date: week, baseSignature, pairs })

      const results = await Promise.allSettled([save(), save()])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      for (const r of rejected) expect(r.reason).toMatchObject({ code: 'DAY_CHANGED' })
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
      const rows = await prisma.attendancePunch.findMany({
        where: { attendanceUploadId: (await prisma.attendanceUpload.findFirstOrThrow({ where: { payrollWeekStartDate: utc(week), isActiveForPayrollWeek: true } })).id, employeeId: empB.id, punchDate: utc(week) },
        orderBy: { position: 'asc' },
      })
      expect(rows.map((r) => [r.position, r.pairIndex, r.currentTime, r.source])).toEqual([['IN', 0, '08:00', 'MANUAL'], ['OUT', 0, '12:00', 'MANUAL']])
      console.info(`[db] item 5 concurrent saves: ${results.map((r) => (r.status === 'fulfilled' ? 'saved' : (r.reason as { code?: string }).code)).join(' / ')}`)
    })

    it('replaying the same save once the day holds the pair is a no-change save: no new rows, no error', async () => {
      // The day now holds the MANUAL pair created above. Saving the same times again changes nothing.
      const baseSignature = await baseSignatureOf(week, empB.id, week)
      const saved = await savePunchEdit({ weekId: week, mode: { kind: 'LIVE' }, employeeId: empB.id, date: week, baseSignature, pairs })

      expect(saved.day.date).toBe(week)
      const count2 = await prisma.attendancePunch.count({ where: { employeeId: empB.id, punchDate: utc(week) } })
      expect(count2).toBe(2)
    })
  })

  // ─── Round 3, items 3, 13, 14, 15: correction writers ───────────────────────
  //
  // Two kinds of test. The sequential ones run the two operations one after the other in each order and
  // check what the loser is told and what state is left: they are exact. The racing ones start both
  // together and check the invariant that must hold whichever wins. The local database serialises
  // connections, so a racing test shows the re-checks inside the transactions (a second writer finds the
  // first one's rows); it cannot show a second writer waiting on the row lock. It can also hit the local
  // database's own protocol interleaving ("bind message supplies N parameters"), which is not a product
  // failure: the racing test then reports itself skipped rather than passing.

  describe('round 3 items 3, 13, 14, 15: correction writers on a real database', () => {
    const week = W.corr
    const end = addDays(week, 6)
    let uploadId: string
    let runId: string

    const sessionsOf = () => prisma.payrollCorrectionSession.findMany({ where: { payrollRunId: runId }, orderBy: { createdAt: 'asc' } })
    const activeSession = () => prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId: runId, status: 'IN_PROGRESS' } })
    const codesOf = (results: PromiseSettledResult<unknown>[]) =>
      results.map((r) => (r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code ?? r.reason)))
    const hours = (rows: Array<{ employeeId: string; regularHours: unknown; overtimeHours: unknown }>) =>
      rows.map((r) => [r.employeeId, Number(r.regularHours), Number(r.overtimeHours)])
    const liveSnapshot = async () =>
      JSON.stringify(await prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, correctionId: null }, orderBy: { id: 'asc' }, select: { id: true, currentTime: true } }))
    const editDay0 = async (mode: { kind: 'CORRECTION'; payrollRunId: string; correctionId: string; revisionNumber: number }, out: string) =>
      savePunchEdit({
        weekId: week, mode, employeeId: empA.id, date: week,
        baseSignature: await baseSignatureOf(week, empA.id, week, mode.correctionId),
        pairs: [
          { pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } },
          { pairIndex: 1, in: { time: '13:00' }, out: { time: out } },
        ],
      } as never)
    /** A correction with punches copied, one edit and a draft built from it. */
    async function openWithDraft(out: string) {
      await correction.beginCorrection(runId)
      await correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db round 3' } as never)
      const session = await activeSession()
      const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })
      await editDay0({ kind: 'CORRECTION', payrollRunId: runId, correctionId: session.id, revisionNumber: run.currentRevisionNumber }, out)
      await correction.approveCorrectionPunches(runId)
      return { session, draftId: (await activeSession()).draftRevisionId!, revisionNumber: run.currentRevisionNumber }
    }

    beforeAll(async () => {
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      const upload = await seedWeek(week, 'REVIEW')
      uploadId = upload.id
      await seedPunches(uploadId, week)
      await approveWeek(week)
      runId = (await approvePayroll(await calculatePayroll(utc(week), utc(end)))).payrollRunId
    }, 60000)

    // Sequential, exact ----------------------------------------------------------

    it('item 13: a second beginCorrection resumes the open session, and the adjustments are not snapshotted again', async () => {
      const first = await correction.beginCorrection(runId)
      const again = await correction.beginCorrection(runId)

      expect(first.resumed).toBe(false)
      expect(again).toMatchObject({ sessionId: first.sessionId, resumed: true })
      expect((await sessionsOf()).filter((x) => x.status === 'IN_PROGRESS')).toHaveLength(1)
    })

    it('item 14: startAttendanceCorrection copies every live punch once; coming back keeps the copy', async () => {
      const start = () => correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db round 3' } as never)

      await start()
      await start()

      const session = await activeSession()
      const live = await prisma.attendancePunch.count({ where: { attendanceUploadId: uploadId, correctionId: null } })
      expect(live).toBe(56) // 2 employees x 7 days x 4 punches
      expect(await prisma.attendancePunch.count({ where: { correctionId: session.id } })).toBe(live)
      const sources = await prisma.attendancePunch.findMany({ where: { correctionId: session.id }, select: { clonedFromPunchId: true } })
      expect(new Set(sources.map((x) => x.clonedFromPunchId)).size).toBe(live)
    })

    it('item 14: a session that is no longer in progress is refused (CORRECTION_NOT_ACTIVE) and copies nothing', async () => {
      const session = await activeSession()
      await prisma.payrollCorrectionSession.update({ where: { id: session.id }, data: { status: 'ABANDONED' } })
      const clonesBefore = await prisma.attendancePunch.count({ where: { correctionId: session.id } })
      try {
        await expect(
          correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'late' } as never),
        ).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
        expect(await prisma.attendancePunch.count({ where: { correctionId: session.id } })).toBe(clonesBefore)
      } finally {
        await prisma.payrollCorrectionSession.update({ where: { id: session.id }, data: { status: 'IN_PROGRESS' } })
      }
    })

    it('item 3: with the edit already saved, "Approve punches" builds the draft from it and points the session at it', async () => {
      const session = await activeSession()
      await editDay0({ kind: 'CORRECTION', payrollRunId: runId, correctionId: session.id, revisionNumber: 1 }, '19:30')

      await correction.approveCorrectionPunches(runId)

      const after = await activeSession()
      expect(after.draftRevisionId).toBeTruthy()
      const rows = await prisma.payrollRunEmployee.findMany({ where: { payrollRevisionId: after.draftRevisionId! } })
      const a = rows.find((r) => r.employeeId === empA.id)!
      const untouched = rows.find((r) => r.employeeId === empB.id)!
      // Day 1 is 08:00-12:00 and 13:00-19:30 = 4 + 6.5 h, so the draft pays more hours than the untouched employee.
      expect(Number(a.regularHours) + Number(a.overtimeHours)).toBeGreaterThan(Number(untouched.regularHours) + Number(untouched.overtimeHours))
    })

    it('item 3: "Approve punches" with an incomplete pair is CORRECTION_HAS_INCOMPLETE_PAIRS and creates no draft', async () => {
      const session = await activeSession()
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: 1 }
      const revisionsBefore = await prisma.payrollRevision.count({ where: { payrollRunId: runId } })
      // Clear the OUT of pair 1: an IN with no OUT is an incomplete pair. The save also clears the draft pointer.
      await savePunchEdit({
        weekId: week, mode, employeeId: empA.id, date: week,
        baseSignature: await baseSignatureOf(week, empA.id, week, session.id),
        pairs: [
          { pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } },
          { pairIndex: 1, in: { time: '13:00' }, out: { time: null } },
        ],
      } as never)
      expect((await activeSession()).draftRevisionId).toBeNull()

      await expect(correction.approveCorrectionPunches(runId)).rejects.toMatchObject({
        code: 'CORRECTION_HAS_INCOMPLETE_PAIRS',
        message: expect.stringMatching(/^\d+ day\(s\) still have an incomplete pair\. Fix or delete them first\.$/),
      })

      expect(await prisma.payrollRevision.count({ where: { payrollRunId: runId } })).toBe(revisionsBefore) // no draft was added or replaced
      expect((await activeSession()).draftRevisionId).toBeNull() // and the pointer was not set
      // Fix the day again and rebuild the draft for the next tests.
      await editDay0(mode, '19:30')
      await correction.approveCorrectionPunches(runId)
      expect((await activeSession()).draftRevisionId).toBeTruthy()
    })

    it('item 15: abandon first, then approving its draft: approval is refused, the run and the live punches are untouched', async () => {
      const draft = (await activeSession()).draftRevisionId!
      const live = await liveSnapshot()
      const records = await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })

      await correction.abandonCorrection(runId)
      const error = await correction.approveRevision(draft).catch((e) => e)

      expect(error).toMatchObject({ code: 'REVISION_NOT_FOUND' }) // abandon deleted the draft
      const sessions = await sessionsOf()
      expect(sessions.at(-1)).toMatchObject({ status: 'ABANDONED', appliedAt: null })
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      expect(await liveSnapshot()).toBe(live)
      expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })).toBe(records)
      expect(await prisma.attendancePunch.count({ where: { correctionId: sessions.at(-1)!.id } })).toBe(0)
    })

    it('item 15: approve first, then abandoning: abandon is refused (CORRECTION_NOT_ACTIVE) and the session stays APPLIED', async () => {
      const { session, draftId } = await openWithDraft('18:30')

      await correction.approveRevision(draftId)
      const error = await correction.abandonCorrection(runId).catch((e) => e)

      expect(error).toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
      const final = await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(final).toMatchObject({ status: 'APPLIED', abandonedAt: null })
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
      // The corrected punches are the live ones now; the 18:30 edit is in the live set.
      expect(await prisma.attendancePunch.count({ where: { attendanceUploadId: uploadId, correctionId: null, employeeId: empA.id, punchDate: utc(week), currentTime: '18:30' } })).toBe(1)
      expect(await prisma.attendancePunch.count({ where: { correctionId: session.id } })).toBe(0)
    })

    // Racing -----------------------------------------------------------------------

    it('item 13 (racing): two beginCorrection calls started together open one session and both report its id', async (ctx) => {
      const results = await Promise.allSettled([correction.beginCorrection(runId), correction.beginCorrection(runId)])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      const sessions = (await sessionsOf()).filter((x) => x.status === 'IN_PROGRESS')
      expect(sessions).toHaveLength(1)
      expect(results.every((r) => r.status === 'fulfilled'), codesOf(results).join()).toBe(true)
      const ok = results.map((r) => (r as PromiseFulfilledResult<{ sessionId: string; resumed: boolean }>).value)
      expect(new Set(ok.map((r) => r.sessionId))).toEqual(new Set([sessions[0].id]))
      expect(ok.filter((r) => !r.resumed)).toHaveLength(1) // exactly one of them created it
      console.info(`[db] item 13 racing beginCorrection: ${ok.map((r) => (r.resumed ? 'resumed' : 'created')).join(' / ')}`)
    })

    it('item 14 (racing): two startAttendanceCorrection calls started together copy the punches once', async (ctx) => {
      const start = () => correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db round 3' } as never)

      const results = await Promise.allSettled([start(), start()])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      expect(results.every((r) => r.status === 'fulfilled'), codesOf(results).join()).toBe(true)
      const session = await activeSession()
      const live = await prisma.attendancePunch.count({ where: { attendanceUploadId: uploadId, correctionId: null } })
      expect(await prisma.attendancePunch.count({ where: { correctionId: session.id } })).toBe(live)
    })

    it('item 3 (racing): a punch edit and "Approve punches" started together never leave a draft that disagrees with the punches', async (ctx) => {
      const session = await activeSession()
      const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: run.currentRevisionNumber }

      const results = await Promise.allSettled([editDay0(mode, '20:15'), correction.approveCorrectionPunches(runId)])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      expect(results.every((r) => r.status === 'fulfilled'), codesOf(results).join()).toBe(true)
      expect(await prisma.attendancePunch.count({ where: { correctionId: session.id, employeeId: empA.id, punchDate: utc(week), currentTime: '20:15' } })).toBe(1)
      const after = await activeSession()
      if (after.draftRevisionId === null) {
        console.info('[db] item 3 racing: the edit committed after the draft, so the pointer was cleared (safe outcome)')
        return
      }
      // A draft is still pointed at: it must be exactly what the punches give now. Recalculate and compare.
      const draftHours = hours(await prisma.payrollRunEmployee.findMany({ where: { payrollRevisionId: after.draftRevisionId }, orderBy: { employeeId: 'asc' } }))
      await correction.approveCorrectionPunches(runId)
      const fresh = await activeSession()
      const freshHours = hours(await prisma.payrollRunEmployee.findMany({ where: { payrollRevisionId: fresh.draftRevisionId! }, orderBy: { employeeId: 'asc' } }))
      expect(draftHours).toEqual(freshHours)
      console.info('[db] item 3 racing: the edit was in the draft before the pointer was set (safe outcome)')
    })

    it('item 15 (racing): approveRevision and abandonCorrection started together end the session as APPLIED xor ABANDONED, never both', async (ctx) => {
      const session = await activeSession()
      const draftId = session.draftRevisionId ?? (await correction.approveCorrectionPunches(runId)).revisionId
      const live = await liveSnapshot()
      const records = await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })
      const runBefore = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })

      const results = await Promise.allSettled([correction.approveRevision(draftId), correction.abandonCorrection(runId)])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      const final = await prisma.payrollCorrectionSession.findUniqueOrThrow({ where: { id: session.id } })
      const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })
      const codes = codesOf(results)
      console.info(`[db] item 15 racing approveRevision / abandonCorrection: ${codes.join(' / ')} -> session ${final.status}`)
      expect(['APPLIED', 'ABANDONED']).toContain(final.status)
      expect(await prisma.attendancePunch.count({ where: { correctionId: session.id } })).toBe(0) // promoted or deleted, never left behind
      if (final.status === 'APPLIED') {
        expect(final.abandonedAt).toBeNull()
        expect(results[0].status).toBe('fulfilled')
        expect(codes[1]).toBe('CORRECTION_NOT_ACTIVE')
        expect(run).toMatchObject({ status: 'REVISED', currentRevisionNumber: runBefore.currentRevisionNumber + 1 })
        expect((await prisma.payrollRevision.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('APPROVED')
      } else {
        expect(final.appliedAt).toBeNull()
        expect(results[1].status).toBe('fulfilled')
        expect(['CORRECTION_NOT_ACTIVE', 'REVISION_NOT_FOUND', 'REVISION_NOT_DRAFT']).toContain(codes[0])
        expect(run).toMatchObject({ status: runBefore.status, currentRevisionNumber: runBefore.currentRevisionNumber })
        expect(await prisma.payrollRevision.count({ where: { id: draftId } })).toBe(0) // the draft was thrown away
        expect(await liveSnapshot()).toBe(live)
        expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: uploadId } })).toBe(records)
      }
      expect((await sessionsOf()).filter((x) => x.status === 'IN_PROGRESS')).toHaveLength(0)
    })
  })

  // ─── Round 4 ────────────────────────────────────────────────────────────────

  describe('round 4 item 3: isApprovedWeekConflict on the real P2002', () => {
    let Prisma: typeof import('@prisma/client').Prisma
    let isApprovedWeekConflict: typeof import('@/features/payroll-generation/services/payroll.service').isApprovedWeekConflict
    const wk = W.r4apr
    const totals = { totalRegularPay: 0, totalOvertimePay: 0, totalAdditions: 0, totalDeductions: 0, totalNetPayable: 0 }
    const run = (status: string, key: Date | null) =>
      prisma.payrollRun.create({
        data: { payrollWeekStartDate: utc(wk), payrollWeekEndDate: utc(addDays(wk, 6)), status, approvedWeekStart: key, ...totals },
      })

    beforeAll(async () => {
      ;({ Prisma } = await import('@prisma/client'))
      ;({ isApprovedWeekConflict } = await import('@/features/payroll-generation/services/payroll.service'))
    })

    it('the error a second approved run produces is a Prisma P2002 that isApprovedWeekConflict recognises', async () => {
      await run('APPROVED', utc(wk))

      const error = await run('APPROVED', utc(wk)).catch((e) => e)

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(error).toMatchObject({ code: 'P2002' })
      console.info(`[db] round 4 item 3 real P2002 meta: ${JSON.stringify(error.meta)}`)
      expect(isApprovedWeekConflict(error)).toBe(true)
    })

    it('the P2002 of another unique key (a duplicate Employee ID) is not taken for the approved-week key', async () => {
      const error = await prisma.employee
        .create({ data: { employeeId: empA.employeeId, employeeName: 'Duplicate', designation: 'Guard', designationShort: 'G', site: 'Gate' } })
        .catch((e) => e)

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(error).toMatchObject({ code: 'P2002' })
      expect(isApprovedWeekConflict(error)).toBe(false)
    })

    it('the P2002 of a two-column key (one decision per employee per week) is not taken for it either', async () => {
      const upload = await seedWeek(W.r4mem, 'REVIEW')
      const decision = { attendanceUploadId: upload.id, employeeId: empA.id, reason: 'INACTIVE', decision: 'APPROVED' }
      await prisma.attendanceEmployeeDecision.create({ data: decision })

      const error = await prisma.attendanceEmployeeDecision.create({ data: decision }).catch((e) => e)

      expect(error).toMatchObject({ code: 'P2002' })
      expect(isApprovedWeekConflict(error)).toBe(false)
      await prisma.attendanceEmployeeDecision.deleteMany({ where: { attendanceUploadId: upload.id } })
    })

    it('approvePayroll turns the database\'s own refusal into PAYROLL_ALREADY_EXISTS and leaves nothing behind', async () => {
      // Attendance for the week is approved, and a leftover DRAFT run already holds the week's key: both checks
      // in front of the insert (they look for APPROVED / REVISED runs) pass, so the unique key is what stops it.
      const week = W.r4apr2
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      const upload = await seedWeek(week, 'REVIEW')
      await seedPunches(upload.id, week)
      await approveWeek(week)
      const summary = await calculatePayroll(utc(week), utc(addDays(week, 6)))
      await prisma.payrollRun.create({
        data: { payrollWeekStartDate: utc(week), payrollWeekEndDate: utc(addDays(week, 6)), status: 'DRAFT', approvedWeekStart: utc(week), ...totals },
      })
      const before = await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(week) } })

      const error = await approvePayroll(summary).catch((e) => e)

      expect(error).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: 'Payroll for this week is already approved' })
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: utc(week) } })).toBe(before)
      const runs = await prisma.payrollRun.findMany({ where: { payrollWeekStartDate: utc(week) }, select: { id: true } })
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: { in: runs.map((r) => r.id) } } })).toBe(0)
      expect(await prisma.payrollRunEmployee.count({ where: { payrollRunId: { in: runs.map((r) => r.id) } } })).toBe(0)
    })
  })

  describe('round 4 items 1 and 10: the day version and the single-row membership check on a real database', () => {
    const week = W.r4day
    let uploadId: string
    let empE: { id: string; employeeId: string }

    const dayRows = (employeeId: string, date = week, correctionId: string | null = null) =>
      prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, correctionId, employeeId, punchDate: utc(date) }, orderBy: [{ pairIndex: 'asc' }, { position: 'desc' }] })
    /** The pairs an editor holds for a stored day, with the punch ids it was opened on. */
    const pairsOf = (rows: Array<{ id: string; pairIndex: number; position: string; currentTime: string | null }>) => {
      const byIndex = new Map<number, { pairIndex: number; in: { punchId: string; time: string | null }; out: { punchId: string; time: string | null } }>()
      for (const r of rows) {
        const pair = byIndex.get(r.pairIndex) ?? { pairIndex: r.pairIndex, in: { punchId: '', time: null }, out: { punchId: '', time: null } }
        pair[r.position === 'IN' ? 'in' : 'out'] = { punchId: r.id, time: r.currentTime }
        byIndex.set(r.pairIndex, pair)
      }
      return [...byIndex.values()]
    }
    const live = { kind: 'LIVE' as const }

    beforeAll(async () => {
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      empE = await prisma.employee.create({
        data: {
          employeeId: 'TPLF12DB9305', employeeName: 'F12 Echo (inactive)', designation: 'Guard', designationShort: 'G', site: 'Gate', isActive: false,
          wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
        },
      })
      const upload = await seedWeek(week, 'REVIEW')
      uploadId = upload.id
      await seedPunches(uploadId, week, [empA]) // empB has nothing
    }, 60000)

    it('the signature the review shows for a day equals the signature of its stored rows (for a full day and an empty one)', async () => {
      const review = await getPunchReview(week)

      const full = review.employees.find((e) => e.employeeId === empA.id)!.days.find((d) => d.date === week)!
      const empty = review.employees.find((e) => e.employeeId === empB.id)!.days.find((d) => d.date === week)!
      expect(full.signature).toBe(await baseSignatureOf(week, empA.id, week))
      expect(empty.signature).toBe(await baseSignatureOf(week, empB.id, week))
      expect(full.signature).toMatch(/^4\./)
      expect(empty.signature).toMatch(/^0\./)
    })

    it('a save with the day\'s own signature goes through, and the result carries the signature of what is now stored', async () => {
      const rows = await dayRows(empA.id)
      const base = await baseSignatureOf(week, empA.id, week)

      const result = await savePunchEdit({
        weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: base,
        pairs: pairsOf(rows).map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:30' } } : p)),
      } as never)

      const after = await baseSignatureOf(week, empA.id, week)
      expect(after).not.toBe(base)
      expect(result.day.signature).toBe(after)
      expect((await dayRows(empA.id)).find((r) => r.pairIndex === 1 && r.position === 'OUT')).toMatchObject({ currentTime: '17:30', originalTime: '17:00' })
    })

    it('a tab opened before another tab added a pair is refused, the pair survives, and no DELETE is audited', async () => {
      const staleRows = await dayRows(empA.id)
      const staleBase = await baseSignatureOf(week, empA.id, week)
      const stalePairs = pairsOf(staleRows) // what tab B holds: the two API pairs
      // Tab A saves a third, hand-entered pair.
      await savePunchEdit({
        weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: staleBase,
        pairs: [...stalePairs, { pairIndex: 2, in: { time: '18:00' }, out: { time: '19:00' } }],
      } as never)
      const afterA = await dayRows(empA.id)
      expect(afterA).toHaveLength(6)
      const deletesBefore = await prisma.auditLog.count({ where: { actionType: 'DELETE', detailsJson: { path: ['weekStart'], equals: week } } })

      // Tab B (opened before) now changes pair 2's OUT.
      const error = await savePunchEdit({
        weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: staleBase,
        pairs: stalePairs.map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:15' } } : p)),
      } as never).catch((e) => e)

      expect(error).toMatchObject({ code: 'DAY_CHANGED' })
      const afterB = await dayRows(empA.id)
      expect(afterB).toHaveLength(6)
      expect(afterB.filter((r) => r.source === 'MANUAL').map((r) => r.currentTime).sort()).toEqual(['18:00', '19:00'])
      expect(afterB.find((r) => r.pairIndex === 1 && r.position === 'OUT')!.currentTime).toBe('17:30') // tab A's day, not tab B's edit
      expect(await prisma.auditLog.count({ where: { actionType: 'DELETE', detailsJson: { path: ['weekStart'], equals: week } } })).toBe(deletesBefore)

      // After the reload tab B holds the new version and the same edit saves.
      const fresh = await dayRows(empA.id)
      await expect(
        savePunchEdit({
          weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: await baseSignatureOf(week, empA.id, week),
          pairs: pairsOf(fresh).map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:15' } } : p)),
        } as never),
      ).resolves.toMatchObject({ day: { date: week } })
      expect(await dayRows(empA.id)).toHaveLength(6)
    })

    it('two editors opened on the same empty day: the second is refused and the day holds one pair', async () => {
      const base = await baseSignatureOf(week, empB.id, week)
      const pairs = [{ pairIndex: 0, in: { time: '08:00' }, out: { time: '16:00' } }]
      expect(base).toMatch(/^0\./)

      await savePunchEdit({ weekId: week, mode: live, employeeId: empB.id, date: week, baseSignature: base, pairs } as never)
      const error = await savePunchEdit({ weekId: week, mode: live, employeeId: empB.id, date: week, baseSignature: base, pairs: [{ pairIndex: 0, in: { time: '09:30' }, out: { time: '16:00' } }] } as never).catch((e) => e)

      expect(error).toMatchObject({ code: 'DAY_CHANGED' })
      const rows = await dayRows(empB.id)
      expect(rows.map((r) => [r.position, r.currentTime])).toEqual([['OUT', '16:00'], ['IN', '08:00']])
    })

    it('a pull that replaced the rows with new ids and identical times is also a changed day', async () => {
      const rows = await dayRows(empA.id)
      const base = await baseSignatureOf(week, empA.id, week)
      // What a pull does to a day: the same scans come back as brand-new rows.
      for (const r of rows) {
        await prisma.$executeRaw`UPDATE "AttendancePunch" SET id = ${`${r.id}-pulled`} WHERE id = ${r.id}`
      }

      const error = await savePunchEdit({
        weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: base,
        pairs: pairsOf(rows).map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:45' } } : p)),
      } as never).catch((e) => e)

      expect(error).toMatchObject({ code: 'DAY_CHANGED' })
      expect(error.message).not.toMatch(/unexpected|no longer exists/i)
      expect((await dayRows(empA.id)).every((r) => r.id.endsWith('-pulled'))).toBe(true)
    })

    it('item 10: an inactive employee is editable only with an APPROVED decision (the compound-key lookup on the real table)', async () => {
      const pairs = [{ pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } }]
      const save = async () =>
        savePunchEdit({ weekId: week, mode: live, employeeId: empE.id, date: week, baseSignature: await baseSignatureOf(week, empE.id, week), pairs } as never)

      await expect(save()).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: "That employee isn't in this week's review." }) // no decision

      const decision = await prisma.attendanceEmployeeDecision.create({
        data: { attendanceUploadId: uploadId, employeeId: empE.id, reason: 'INACTIVE', decision: 'REJECTED' },
      })
      await expect(save()).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' }) // rejected
      expect(await dayRows(empE.id)).toHaveLength(0)

      await prisma.attendanceEmployeeDecision.update({ where: { id: decision.id }, data: { decision: 'APPROVED' } })
      await expect(save()).resolves.toMatchObject({ day: { date: week } }) // approved
      expect(await dayRows(empE.id)).toHaveLength(2)
    })

    it('item 10: an employee Prisma has never heard of is refused the same way, with nothing written', async () => {
      const error = await savePunchEdit({
        weekId: week, mode: live, employeeId: '00000000-0000-4000-8000-000000000000', date: week, baseSignature: 'x',
        pairs: [{ pairIndex: 0, in: { time: '08:00' }, out: { time: '12:00' } }],
      } as never).catch((e) => e)

      expect(error).toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
    })
  })

  describe('round 4 item 5: rematchWeekCodes commits each code on its own, on a real database', () => {
    const week = W.r4rematch
    let uploadId: string
    let empF: { id: string }
    let empG: { id: string }
    let ec: typeof import('@/features/attendance-sync/services/employee-check.service')

    const punch = (employeeId: string | null, empCode: string, matchStatus: string, day: number, pairIndex: number, position: string, time: string) => ({
      attendanceUploadId: uploadId, employeeId, empCode, matchStatus, punchDate: utc(addDays(week, day)),
      pairIndex, position, source: 'API', originalTime: time, currentTime: time,
    })
    const rowsOf = (code: string) =>
      prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, empCode: code }, orderBy: [{ punchDate: 'asc' }, { pairIndex: 'asc' }, { position: 'desc' }] })

    beforeAll(async () => {
      ec = await import('@/features/attendance-sync/services/employee-check.service')
      const mk = (code: string, name: string) =>
        prisma.employee.create({
          data: {
            employeeId: code, employeeName: name, designation: 'Guard', designationShort: 'G', site: 'Gate', isActive: true,
            wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
          },
        })
      empF = await mk('TPLF12DB9401', 'F12 Foxtrot')
      empG = await mk('TPLF12DB9402', 'F12 Golf')
      uploadId = (await seedWeek(week, 'REVIEW')).id
      await prisma.attendancePunch.createMany({
        data: [
          // Foxtrot already has two pairs on day 0; code 9401 (his number) has a pair on day 0 and one on day 1.
          punch(empF.id, '9401', 'MATCHED', 0, 0, 'IN', '06:00'), punch(empF.id, '9401', 'MATCHED', 0, 0, 'OUT', '06:30'),
          punch(empF.id, '9401', 'MATCHED', 0, 1, 'IN', '07:00'), punch(empF.id, '9401', 'MATCHED', 0, 1, 'OUT', '07:30'),
          punch(null, '9401', 'UNKNOWN', 0, 0, 'IN', '13:00'), punch(null, '9401', 'UNKNOWN', 0, 0, 'OUT', '17:00'),
          punch(null, '9401', 'UNKNOWN', 1, 0, 'IN', '08:00'), punch(null, '9401', 'UNKNOWN', 1, 0, 'OUT', '12:00'),
          punch(null, '9402', 'UNKNOWN', 2, 0, 'IN', '08:00'), punch(null, '9402', 'UNKNOWN', 2, 0, 'OUT', '12:00'),
          punch(null, '9402', 'UNKNOWN', 2, 1, 'IN', '13:00'), punch(null, '9402', 'UNKNOWN', 2, 1, 'OUT', '17:00'),
          punch(null, '9499', 'UNKNOWN', 3, 0, 'IN', '08:00'), punch(null, '9499', 'UNKNOWN', 3, 0, 'OUT', '12:00'),
        ] as never,
      })
    }, 60000)

    it('links every code that now matches, moving a code\'s rows by their offset in one statement per offset', async () => {
      const result = await ec.rematchWeekCodes(week)

      expect(result.matched).toEqual(
        expect.arrayContaining([
          { empCode: '9401', employeeId: empF.id, employeeCode: 'TPLF12DB9401' },
          { empCode: '9402', employeeId: empG.id, employeeCode: 'TPLF12DB9402' },
        ]),
      )
      expect(result.matched).toHaveLength(2)
      expect(result.stillUnresolved).toEqual(['9499'])
      // Day 0 had pairs 0 and 1: the code's pair now sits at index 2. Day 1 had nothing: pair 0 stays pair 0.
      const nine401 = (await rowsOf('9401')).filter((r) => r.matchStatus === 'MATCHED' && r.originalTime !== null && ['13:00', '17:00', '08:00', '12:00'].includes(r.originalTime))
      expect(nine401.map((r) => [r.punchDate.toISOString().slice(0, 10), r.pairIndex, r.position, r.employeeId === empF.id])).toEqual([
        [week, 2, 'OUT', true],
        [week, 2, 'IN', true],
        [addDays(week, 1), 0, 'OUT', true],
        [addDays(week, 1), 0, 'IN', true],
      ])
      // The employee's own earlier pairs were not touched.
      const own = (await rowsOf('9401')).filter((r) => r.punchDate.getTime() === utc(week).getTime() && ['06:00', '06:30', '07:00', '07:30'].includes(r.originalTime ?? ''))
      expect(own.map((r) => r.pairIndex).sort()).toEqual([0, 0, 1, 1])
      expect((await rowsOf('9402')).every((r) => r.matchStatus === 'MATCHED' && r.employeeId === empG.id)).toBe(true)
      expect((await rowsOf('9499')).every((r) => r.matchStatus === 'UNKNOWN' && r.employeeId === null)).toBe(true)
    })

    it('each linked code has its own audit row with the number of rows it moved', async () => {
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'ATTENDANCE_CODE', entityId: uploadId },
        orderBy: { createdAt: 'asc' },
      })

      expect(audits.map((a) => (a.detailsJson as { empCode: string }).empCode).sort()).toEqual(['9401', '9402'])
      expect(Object.fromEntries(audits.map((a) => [(a.detailsJson as { empCode: string }).empCode, (a.detailsJson as { linkedPunches: number }).linkedPunches]))).toEqual({ '9401': 4, '9402': 4 })
    })

    it('a second run has nothing left to link, writes nothing more and reports the unmatched code', async () => {
      const auditsBefore = await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', entityId: uploadId } })

      await expect(ec.rematchWeekCodes(week)).resolves.toEqual({ matched: [], stillUnresolved: ['9499'] })

      expect(await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', entityId: uploadId } })).toBe(auditsBefore)
    })

    it('two runs started together link each code once (the second finds nothing left to do)', async (ctx) => {
      // Fresh unresolved code for Golf's number so there is something to race for.
      await prisma.attendancePunch.createMany({
        data: [punch(null, '9402', 'UNKNOWN', 4, 0, 'IN', '08:00'), punch(null, '9402', 'UNKNOWN', 4, 0, 'OUT', '12:00')] as never,
      })
      const auditsBefore = await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', entityId: uploadId } })

      const results = await Promise.allSettled([ec.rematchWeekCodes(week), ec.rematchWeekCodes(week)])
      if (interleaved(results)) return ctx.skip('local database interleaved two connections; not exercised')

      expect(results.every((r) => r.status === 'fulfilled'), results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join()).toBe(true)
      const matchedCounts = results.map((r) => (r as PromiseFulfilledResult<{ matched: unknown[] }>).value.matched.length).sort()
      expect(matchedCounts).toEqual([0, 1])
      expect(await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_CODE', entityId: uploadId } })).toBe(auditsBefore + 1)
      expect((await rowsOf('9402')).every((r) => r.matchStatus === 'MATCHED')).toBe(true)
    })
  })

  describe('round 4 item 2: a draft and a promotion without a session take the week lock on a real database', () => {
    const week = W.r4corr
    let runId: string

    beforeAll(async () => {
      await prisma.employee.update({ where: { id: empB.id }, data: { isActive: true } })
      const upload = await seedWeek(week, 'REVIEW')
      await seedPunches(upload.id, week)
      await approveWeek(week)
      runId = (await approvePayroll(await calculatePayroll(utc(week), utc(addDays(week, 6))))).payrollRunId
    }, 60000)

    it('recalculateAndCreateRevision with no session numbers the draft after the current revision', async () => {
      const result = await correction.recalculateAndCreateRevision({
        payrollRunId: runId, correctionReason: 'f12 db round 4', correctionTypes: ['ADJUSTMENTS'],
      })

      expect(result).toMatchObject({ payrollRunId: runId, revisionNumber: 2, employeeCount: 2 })
      expect(await prisma.payrollRevision.findUniqueOrThrow({ where: { id: result.revisionId } })).toMatchObject({ status: 'DRAFT', isCurrent: false, revisionNumber: 2 })
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
    })

    it('a second draft replaces the first and is still number 2 (the current revision is still revision 1)', async () => {
      const result = await correction.recalculateAndCreateRevision({
        payrollRunId: runId, correctionReason: 'f12 db round 4 again', correctionTypes: ['ADJUSTMENTS'],
      })

      expect(result.revisionNumber).toBe(2)
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: runId, status: 'DRAFT' } })).toBe(1)
    })

    it('approveRevision with no session promotes that draft: revision 2 is current, the run is REVISED', async () => {
      const draft = await prisma.payrollRevision.findFirstOrThrow({ where: { payrollRunId: runId, status: 'DRAFT' } })

      await correction.approveRevision(draft.id)

      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
      expect(await prisma.payrollRevision.findMany({ where: { payrollRunId: runId }, orderBy: { revisionNumber: 'asc' }, select: { revisionNumber: true, status: true, isCurrent: true } })).toEqual([
        { revisionNumber: 1, status: 'SUPERSEDED', isCurrent: false },
        { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
      ])
    })

    it('the next draft is numbered after the revision that is current now (3)', async () => {
      const result = await correction.recalculateAndCreateRevision({
        payrollRunId: runId, correctionReason: 'f12 db round 4 third', correctionTypes: ['ADJUSTMENTS'],
      })

      expect(result.revisionNumber).toBe(3)
    })

    it('promoting the same draft again is REVISION_NOT_DRAFT and changes nothing', async () => {
      const approved = await prisma.payrollRevision.findFirstOrThrow({ where: { payrollRunId: runId, revisionNumber: 2 } })

      await expect(correction.approveRevision(approved.id)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
    })
  })
  // ─── Final fix pass ─────────────────────────────────────────────────────────

  describe('final pass item 1: rematchWeekCodes matches each code again under its lock, on a real database', () => {
    const week = W.r6rematch
    const week2 = W.r6rematch2
    let uploadId: string
    let upload2Id: string
    let ec: typeof import('@/features/attendance-sync/services/employee-check.service')

    const mk = (code: string, name: string) =>
      prisma.employee.create({
        data: {
          employeeId: code, employeeName: name, designation: 'Guard', designationShort: 'G', site: 'Gate', isActive: true,
          wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
        },
      })
    /** An unresolved code with one IN/OUT pair on the week's first day. */
    const unresolved = (id: string, empCode: string) => [
      { attendanceUploadId: id, employeeId: null, empCode, matchStatus: 'UNKNOWN', punchDate: utc(week), pairIndex: 0, position: 'IN', source: 'API', originalTime: '08:00', currentTime: '08:00' },
      { attendanceUploadId: id, employeeId: null, empCode, matchStatus: 'UNKNOWN', punchDate: utc(week), pairIndex: 0, position: 'OUT', source: 'API', originalTime: '12:00', currentTime: '12:00' },
    ]
    const rowsOf = (id: string, code: string) => prisma.attendancePunch.findMany({ where: { attendanceUploadId: id, empCode: code } })
    const auditedCodes = async (id: string) =>
      (await prisma.auditLog.findMany({ where: { entityType: 'ATTENDANCE_CODE', entityId: id } })).map((a) => (a.detailsJson as { empCode: string }).empCode).sort()

    beforeAll(async () => {
      ec = await import('@/features/attendance-sync/services/employee-check.service')
      uploadId = (await seedWeek(week, 'REVIEW')).id
      upload2Id = (await seedWeek(week2, 'REVIEW')).id
    }, 60000)

    it('an employee deleted after the first read and before the lock leaves the code unresolved: no link, no audit, no foreign-key error', async () => {
      const hotel = await mk('TPLF12DB9601', 'F12 Hotel')
      const india = await mk('TPLF12DB9602', 'F12 India')
      await prisma.attendancePunch.createMany({ data: [...unresolved(uploadId, '9601'), ...unresolved(uploadId, '9602')] as never })
      // Everything the service reads before its transactions sees Hotel. The moment its first transaction is
      // about to start, Hotel is deleted, so every locked read after that sees only India.
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
      let started = 0
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
        if (started++ === 0) {
          await prisma.employeeWageHistory.deleteMany({ where: { employeeId: hotel.id } })
          await prisma.employee.delete({ where: { id: hotel.id } })
        }
        return real(...args)
      }) as never)

      let result: Awaited<ReturnType<typeof ec.rematchWeekCodes>>
      try {
        result = await ec.rematchWeekCodes(week)
      } finally {
        spy.mockRestore()
      }

      expect(started).toBe(2) // one transaction per code that might change
      expect(result.matched).toEqual([{ empCode: '9602', employeeId: india.id, employeeCode: 'TPLF12DB9602' }])
      expect(result.stillUnresolved).toEqual(['9601'])
      const hotelRows = await rowsOf(uploadId, '9601')
      expect(hotelRows).toHaveLength(2)
      expect(hotelRows.every((r) => r.employeeId === null && r.matchStatus === 'UNKNOWN')).toBe(true)
      const indiaRows = await rowsOf(uploadId, '9602')
      expect(indiaRows.every((r) => r.employeeId === india.id && r.matchStatus === 'MATCHED')).toBe(true)
      expect(await auditedCodes(uploadId)).toEqual(['9602'])
    })

    it('the database refuses a link to an employee that does not exist with a Prisma P2003', async () => {
      await prisma.attendancePunch.createMany({ data: unresolved(upload2Id, '9620') as never })

      const error = await prisma.attendancePunch
        .updateMany({ where: { attendanceUploadId: upload2Id, empCode: '9620' }, data: { employeeId: 'f12db-no-such-employee', matchStatus: 'MATCHED' } })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(error).toMatchObject({ code: 'P2003' })
      expect((await rowsOf(upload2Id, '9620')).every((r) => r.employeeId === null && r.matchStatus === 'UNKNOWN')).toBe(true)
      await prisma.attendancePunch.deleteMany({ where: { attendanceUploadId: upload2Id, empCode: '9620' } })
    })

    it('an employee that disappears after the locked read: the real P2003 rolls that code back and it is reported unresolved; the other code links', async () => {
      const juliet = await mk('TPLF12DB9611', 'F12 Juliet')
      const kilo = await mk('TPLF12DB9612', 'F12 Kilo')
      const punchesOf = (code: string) => [
        { attendanceUploadId: upload2Id, employeeId: null, empCode: code, matchStatus: 'UNKNOWN', punchDate: utc(week2), pairIndex: 0, position: 'IN', source: 'API', originalTime: '08:00', currentTime: '08:00' },
        { attendanceUploadId: upload2Id, employeeId: null, empCode: code, matchStatus: 'UNKNOWN', punchDate: utc(week2), pairIndex: 0, position: 'OUT', source: 'API', originalTime: '12:00', currentTime: '12:00' },
      ]
      await prisma.attendancePunch.createMany({ data: [...punchesOf('9611'), ...punchesOf('9612')] as never })
      // Under the lock the service reads Juliet as an employee that no longer exists (a row id the database
      // does not have), exactly what is left when she is deleted between the locked read and the link. Every
      // other statement of the transaction runs against the real database.
      const ghost = { id: 'f12db-ghost-employee', employeeId: 'TPLF12DB9611', employeeName: 'F12 Juliet', isActive: true, dateOfResignation: null }
      const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        real(
          (tx) =>
            fn(
              new Proxy(tx as object, {
                get(target, prop) {
                  if (prop === 'employee') {
                    return {
                      findMany: async (args: unknown) => {
                        const all = (await (target as { employee: { findMany: (a: unknown) => Promise<Array<{ employeeId: string }>> } }).employee.findMany(args)) as Array<{ employeeId: string }>
                        return all.map((e) => (e.employeeId === 'TPLF12DB9611' ? ghost : e))
                      },
                    }
                  }
                  const value = Reflect.get(target, prop)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              }),
            ),
          options,
        )) as never)

      let result: Awaited<ReturnType<typeof ec.rematchWeekCodes>>
      try {
        result = await ec.rematchWeekCodes(week2)
      } finally {
        spy.mockRestore()
      }

      expect(result.matched).toEqual([{ empCode: '9612', employeeId: kilo.id, employeeCode: 'TPLF12DB9612' }])
      expect(result.stillUnresolved).toEqual(['9611'])
      // Juliet's code was rolled back as a whole: still unmatched, still unresolved, and no audit row for it.
      const julietRows = await rowsOf(upload2Id, '9611')
      expect(julietRows).toHaveLength(2)
      expect(julietRows.every((r) => r.employeeId === null && r.matchStatus === 'UNKNOWN')).toBe(true)
      expect((await rowsOf(upload2Id, '9612')).every((r) => r.employeeId === kilo.id && r.matchStatus === 'MATCHED')).toBe(true)
      expect(await auditedCodes(upload2Id)).toEqual(['9612'])
      // With the real employee in the list the same code links normally on the next run.
      await expect(ec.rematchWeekCodes(week2)).resolves.toEqual({
        matched: [{ empCode: '9611', employeeId: juliet.id, employeeCode: 'TPLF12DB9611' }],
        stillUnresolved: [],
      })
    })
  })

  describe('final pass item 2: the day savePunchEdit returns is the day it saved, on a real database', () => {
    const week = W.r6day
    let uploadId: string

    const dayRows = () =>
      prisma.attendancePunch.findMany({ where: { attendanceUploadId: uploadId, correctionId: null, employeeId: empA.id, punchDate: utc(week) }, orderBy: [{ pairIndex: 'asc' }, { position: 'desc' }] })
    const pairsOf = (rows: Array<{ id: string; pairIndex: number; position: string; currentTime: string | null }>) => {
      const byIndex = new Map<number, { pairIndex: number; in: { punchId: string; time: string | null }; out: { punchId: string; time: string | null } }>()
      for (const r of rows) {
        const pair = byIndex.get(r.pairIndex) ?? { pairIndex: r.pairIndex, in: { punchId: '', time: null }, out: { punchId: '', time: null } }
        pair[r.position === 'IN' ? 'in' : 'out'] = { punchId: r.id, time: r.currentTime }
        byIndex.set(r.pairIndex, pair)
      }
      return [...byIndex.values()]
    }
    const live = { kind: 'LIVE' as const }
    const deleteAudits = () => prisma.auditLog.count({ where: { actionType: 'DELETE', detailsJson: { path: ['weekStart'], equals: week } } })

    beforeAll(async () => {
      uploadId = (await seedWeek(week, 'REVIEW')).id
      await seedPunches(uploadId, week, [empA])
    }, 60000)

    it('another tab\'s save that commits right after this one is not in the returned day, and the next save from it is refused instead of deleting that pair', async () => {
      const opened = await dayRows()
      const base = await baseSignatureOf(week, empA.id, week)
      const editorPairs = pairsOf(opened) // the two pairs the editor holds
      let signatureAtCommit = ''
      // The save's own transaction commits; then, before the review is read for the display data, another tab's
      // save lands: a hand-entered third pair.
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
        const out = await real(...args)
        signatureAtCommit = await baseSignatureOf(week, empA.id, week)
        await prisma.attendancePunch.createMany({
          data: [
            { attendanceUploadId: uploadId, employeeId: empA.id, empCode: '9101', matchStatus: 'MATCHED', punchDate: utc(week), pairIndex: 2, position: 'IN', source: 'MANUAL', originalTime: null, currentTime: '18:30' },
            { attendanceUploadId: uploadId, employeeId: empA.id, empCode: '9101', matchStatus: 'MATCHED', punchDate: utc(week), pairIndex: 2, position: 'OUT', source: 'MANUAL', originalTime: null, currentTime: '19:30' },
          ] as never,
        })
        return out
      }) as never)

      let result: Awaited<ReturnType<typeof savePunchEdit>>
      try {
        result = await savePunchEdit({
          weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: base,
          pairs: editorPairs.map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:30' } } : p)),
        } as never)
      } finally {
        spy.mockRestore()
      }

      // The day is this save's own: two pairs, the edited OUT, the signature of the rows at the moment of commit.
      expect(result.day.pairs).toHaveLength(2)
      expect(result.day.pairs[1].out?.time).toBe('17:30')
      expect(result.day.signature).toBe(signatureAtCommit)
      expect(await dayRows()).toHaveLength(6)
      expect(result.day.signature).not.toBe(await baseSignatureOf(week, empA.id, week))
      // The display data is the later read: the employee's totals are those of a fresh review, which already holds the other tab's hour.
      const fresh = (await getPunchReview(week)).employees.find((e) => e.employeeId === empA.id)!
      expect(result.employeeTotals).toEqual({ regular: fresh.totalRegularHours, overtime: fresh.totalOvertimeHours, hasAnyPunch: true })
      expect(fresh.days.find((d) => d.date === week)!.totalHours).toBeCloseTo(result.day.totalHours + 1, 2)

      // The editor's next save (two pairs, the signature it was just given) is refused, and the other tab's pair survives.
      const deletesBefore = await deleteAudits()
      const next = await savePunchEdit({
        weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: result.day.signature,
        pairs: editorPairs.map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:45' } } : p)),
      } as never).catch((e) => e)

      expect(next).toMatchObject({ code: 'DAY_CHANGED' })
      const after = await dayRows()
      expect(after).toHaveLength(6)
      expect(after.filter((r) => r.source === 'MANUAL').map((r) => r.currentTime).sort()).toEqual(['18:30', '19:30'])
      expect(after.find((r) => r.pairIndex === 1 && r.position === 'OUT')!.currentTime).toBe('17:30')
      expect(await deleteAudits()).toBe(deletesBefore)

      // After a reload the editor holds all three pairs and the same edit goes through.
      const reloaded = await dayRows()
      await expect(
        savePunchEdit({
          weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: await baseSignatureOf(week, empA.id, week),
          pairs: pairsOf(reloaded).map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, time: '17:45' } } : p)),
        } as never),
      ).resolves.toMatchObject({ day: { date: week } })
      expect(await dayRows()).toHaveLength(6)
    })

    it('with nothing to write there is no transaction, and the returned day is the one the base signature matched', async () => {
      const rows = await dayRows()
      const base = await baseSignatureOf(week, empA.id, week)
      const spy = vi.spyOn(prisma, '$transaction')

      let result: Awaited<ReturnType<typeof savePunchEdit>>
      try {
        result = await savePunchEdit({ weekId: week, mode: live, employeeId: empA.id, date: week, baseSignature: base, pairs: pairsOf(rows) } as never)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }

      expect(result.day.signature).toBe(base)
      expect(result.day.pairs).toHaveLength(3)
    })
  })

})
