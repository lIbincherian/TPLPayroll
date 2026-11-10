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
import type { PrismaClient } from '@prisma/client'

vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal
const ROOT = path.resolve(__dirname, '../../..')
const BACKFILL = path.join(ROOT, 'scripts/backfill-active-week-start.js')

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
}
const ALL_WEEKS = Object.values(W).map(utc)

const FULL_DAY = ['08:00', '12:00', '13:00', '17:00']

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
    const runs = await prisma.payrollRun.findMany({ where: { payrollWeekStartDate: { in: ALL_WEEKS } }, select: { id: true } })
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
    await prisma.attendanceUpload.deleteMany({ where: { id: { in: ids } } })
    await prisma.employeeWageHistory.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  }

  function runBackfill(env: Record<string, string> = { DIRECT_DATABASE_URL: URL, DATABASE_URL: URL }) {
    try {
      const stdout = execFileSync(process.execPath, [BACKFILL], {
        cwd: os.tmpdir(), // not the repo: dotenv must not pick up the developer's .env
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env } as unknown as NodeJS.ProcessEnv,
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
        savePunchEdit({ weekId: W.syncGuard, mode: { kind: 'LIVE' }, employeeId: empA.id, date: W.syncGuard, pairs }),
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

      const saved = await savePunchEdit({ weekId: W.syncGuard, mode: { kind: 'LIVE' }, employeeId: empA.id, date: W.syncGuard, pairs })
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
        savePunchEdit({ weekId: W.syncGuard, mode: { kind: 'LIVE' }, employeeId: empA.id, date: W.syncGuard, pairs }),
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

    const clearDay = (date: string, employeeId: string, mode: { kind: 'CORRECTION'; payrollRunId: string; correctionId: string; revisionNumber: number }) =>
      savePunchEdit({
        weekId: week,
        mode,
        employeeId,
        date,
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
      const edit = (out: string) =>
        savePunchEdit({
          weekId: week, mode, employeeId: empA.id, date: week,
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

      await correction.beginCorrection(runId)
      await correction.startAttendanceCorrection(runId, { types: ['ATTENDANCE'], reason: 'f12 db 3' } as never)
      const session = await activeSession(runId)
      const mode = { kind: 'CORRECTION' as const, payrollRunId: runId, correctionId: session.id, revisionNumber: run.currentRevisionNumber }

      // Applications added during the correction, for the employee who is about to be left out (B) and one who stays (A).
      const adjB = await adjustment(empB.id)
      const adjBCancelled = await adjustment(empB.id, 'CANCELLED')
      const adjA = await adjustment(empA.id)
      const bApproved = await application(adjB.id, empB.id, 'APPROVED', { payrollRunId: runId, approvedAt: new Date() })
      const bPending = await application(adjB.id, empB.id, 'PENDING')
      const bSkipped = await application(adjB.id, empB.id, 'SKIPPED', { skippedAt: new Date('2026-03-01T00:00:00Z') })
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
})
