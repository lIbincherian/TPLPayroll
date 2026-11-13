// @vitest-environment node
//
// Real-database tests for the correction settlement redesign. They run the real services against a local Postgres.
//
//   F12_TEST_DB_URL=postgres://postgres:postgres@localhost:51236/template1?sslmode=disable \
//     npx vitest run src/__tests__/db/f12-settlement.db.test.ts --no-file-parallelism
//
// Skipped (and reported as skipped) when F12_TEST_DB_URL is not set. The URL must point at localhost: these tests
// write rows, and refuse anything else. The schema must already be migrated (`prisma migrate deploy`). Rows use their own
// employees (TPLF12ST*) and Thursdays from January 2024 on (each case has its own weeks, none used by the other
// DB suites), and are removed afterwards.
//
// Limits of the local database: `prisma dev` serves every client through ONE Postgres session, so two
// transactions never really overlap, and two started together (Promise.all) get each other's protocol messages
// ("bind message supplies 2 parameters, but prepared statement requires 0"), so no case here starts two at once.
// What is proved here is the SQL (SELECT ... FOR UPDATE ... ORDER BY id runs),
// the data rules, the order of the steps and the invariants; NOT that the lock makes a second writer wait. Cases
// that need "another writer committed while this one waited" make that change inside the waiting transaction,
// right after the lock is taken, which is what the waiting transaction finds once it holds the lock.
//
// What is proved here, in SQL and with the balances read back:
//   rows a to l of the decision table, each end to end (weekly approval, payroll, correction, draft, approval),
//   the staleness checks (REVISION_STALE writes nothing), abandon moving nothing, the weekly approve, skip, edit
//   and cancel refused while a correction is open, the adjustment row lock and the re-read under it, atomic
//   rollback of a failing settlement, and, after every case, that no balance is below 0 or above its total.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Prisma, type PrismaClient } from '@prisma/client'

// The real lock, as a spy: a test can run something right after the lock is taken (what a transaction that waited
// for the lock finds) and look at what was locked.
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/payroll-adjustments/services/adjustment-lock.service')>()
  return { lockAdjustmentRows: vi.fn(actual.lockAdjustmentRows) }
})

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(utc(iso).getTime() + n * 86400000).toISOString().slice(0, 10)

/** Week number n: Thursdays from 2024-01-04. Everything is long over, and before the other DB suites' weeks (2025-10 on). */
const wk = (n: number) => addDays('2024-01-04', 7 * n)
let cursor = 0
/** The first of `span` consecutive weeks reserved for one case (the weeks after the first hold carried applications). */
const take = (span: number) => {
  const first = wk(cursor)
  cursor += span
  return first
}
const W = {
  a: take(2), b: take(2), c: take(2), d: take(3), e: take(2), f: take(2), g: take(2), h: take(2), i: take(2), j: take(4),
  k: take(3), kAllowed: take(3), l: take(2), clickDraft: take(2), clickSkip: take(2), abandon: take(2), twoCorr: take(3),
  weeklyRefused: take(2), refusedAbandoned: take(2), noSession: take(2), doubleApprove: take(2), reread: take(3), skipReread: take(3),
  skipBack: take(2), repeatKeep: take(2), repeatSkip: take(2), leftOutPayroll: take(2), lockSql: take(2), stale: take(2), lockFails: take(2), rollback: take(2), tight: take(2), paise: take(2),
}
const ALL_WEEKS = Array.from({ length: cursor }, (_, n) => utc(wk(n)))
const FULL_DAY = ['08:00', '12:00', '13:00', '17:00'] // 8 regular hours

if (URL !== '' && !isLocal) {
  describe('F12 settlement redesign (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F12_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

const STALE = 'This preview is out of date: an adjustment or its balance changed after it was calculated. Go back and recalculate.'
const IN_PROGRESS = 'A payroll correction is open for this week. Finish or cancel it first.'

describe.skipIf(!enabled)('F12 settlement redesign (real database)', { timeout: 180000 }, () => {
  let prisma: PrismaClient
  let empA: { id: string; employeeId: string }
  let empB: { id: string; employeeId: string }
  let empC: { id: string; employeeId: string }
  let approveWeek: typeof import('@/features/attendance-sync/services/week-approval.service').approveWeek
  let calculatePayroll: typeof import('@/features/payroll-generation/services/payroll.service').calculatePayroll
  let approvePayroll: typeof import('@/features/payroll-generation/services/payroll.service').approvePayroll
  let adjustments: typeof import('@/features/payroll-adjustments/services/adjustment.service')
  let correction: typeof import('@/features/payroll-correction/services/correction.service')
  let lockSpy: ReturnType<typeof vi.fn>
  let realLock: typeof import('@/features/payroll-adjustments/services/adjustment-lock.service').lockAdjustmentRows

  const codeOf = (emp: { id: string }) => ({ [empA?.id]: '9301', [empB?.id]: '9302', [empC?.id]: '9303' })[emp.id] ?? '9399'

  async function seedWeek(weekStart: string) {
    return prisma.attendanceUpload.create({
      data: {
        source: 'ETIMEOFFICE',
        payrollWeekSource: 'ETIMEOFFICE',
        status: 'REVIEW',
        isActiveForPayrollWeek: true,
        activeWeekStart: utc(weekStart),
        payrollWeekStartDate: utc(weekStart),
        payrollWeekEndDate: utc(addDays(weekStart, 6)),
      },
    })
  }

  async function seedPunches(uploadId: string, weekStart: string, employees: Array<{ id: string }>) {
    const rows: Array<Record<string, unknown>> = []
    for (const emp of employees) {
      for (let d = 0; d < 7; d++) {
        FULL_DAY.forEach((time, i) =>
          rows.push({
            attendanceUploadId: uploadId,
            employeeId: emp.id,
            empCode: codeOf(emp),
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
    const emps = await prisma.employee.findMany({ where: { employeeId: { startsWith: 'TPLF12ST' } }, select: { id: true } })
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

  const mkEmployee = (code: string, name: string) =>
    prisma.employee.create({
      data: {
        employeeId: code,
        employeeName: name,
        designation: 'Guard',
        designationShort: 'G',
        site: 'Gate',
        isActive: true,
        wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2020-01-01'), changeSource: 'SEED' } },
      },
    })

  let originalSettings: { payrollWeekStartDay: string; updatedAt: Date } | null = null

  let activeBefore: string[] = []

  beforeAll(async () => {
    process.env.DIRECT_DATABASE_URL = URL
    process.env.DATABASE_URL = URL
    prisma = (await import('@/lib/prisma')).default
    // Approving a week sets employee status (issue #35); afterAll puts back who was active.
    activeBefore = (await prisma.employee.findMany({ where: { isActive: true }, select: { id: true } })).map((e) => e.id)
    ;({ approveWeek } = await import('@/features/attendance-sync/services/week-approval.service'))
    ;({ calculatePayroll, approvePayroll } = await import('@/features/payroll-generation/services/payroll.service'))
    adjustments = await import('@/features/payroll-adjustments/services/adjustment.service')
    correction = await import('@/features/payroll-correction/services/correction.service')
    const lockModule = await import('@/features/payroll-adjustments/services/adjustment-lock.service')
    lockSpy = vi.mocked(lockModule.lockAdjustmentRows) as unknown as ReturnType<typeof vi.fn>
    realLock = (await vi.importActual<typeof import('@/features/payroll-adjustments/services/adjustment-lock.service')>(
      '@/features/payroll-adjustments/services/adjustment-lock.service',
    )).lockAdjustmentRows

    const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } })
    originalSettings = settings ? { payrollWeekStartDay: settings.payrollWeekStartDay, updatedAt: settings.updatedAt } : null

    await cleanup()
    empA = await mkEmployee('TPLF12ST9301', 'ST Alpha')
    empB = await mkEmployee('TPLF12ST9302', 'ST Bravo')
    empC = await mkEmployee('TPLF12ST9303', 'ST Charlie')
  }, 120000)

  afterAll(async () => {
    await prisma.employee.updateMany({ where: { id: { in: activeBefore } }, data: { isActive: true } })
    await cleanup()
    if (originalSettings) {
      await prisma.$executeRawUnsafe(`UPDATE "Settings" SET "payrollWeekStartDay" = '${originalSettings.payrollWeekStartDay}', "updatedAt" = $1 WHERE id = 'singleton'`, originalSettings.updatedAt)
    } else {
      await prisma.settings.deleteMany({ where: { id: 'singleton' } })
    }
    await prisma.$disconnect()
  }, 120000)

  afterEach(async () => {
    lockSpy.mockReset()
    lockSpy.mockImplementation(realLock as never) // a test that replaced the lock must not leak into the next
    // Invariant of every case: no balance is below zero or above its total.
    const ids = [empA.id, empB.id, empC.id]
    const bad = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "PayrollAdjustment"
      WHERE "employeeId" IN (${Prisma.join(ids)})
        AND ("remainingBalance" < 0 OR ("totalBalance" IS NOT NULL AND "remainingBalance" > "totalBalance"))`)
    expect(bad).toEqual([])
  })

  // ─── Building blocks ───────────────────────────────────────────────────────

  interface NewAdjustment {
    employee?: { id: string }
    kind: 'TOTAL_BALANCE' | 'FIXED_WEEKS' | 'ONE_TIME'
    type?: 'DEDUCTION' | 'ADDITION'
    /** TOTAL_BALANCE: the weekly instalment. FIXED_WEEKS: the total over `weeks`. ONE_TIME: the amount. */
    amount: number
    totalBalance?: number
    weeks?: number
    /** Put the balance at this before anything happens (what earlier weeks left). */
    remaining?: number
    /** Approve it in the weekly review before the payroll is approved, as the original approval would have. */
    weeklyApprove: boolean
  }

  /** An adjustment starting at `week`, with its application for that week. */
  async function newAdjustment(week: string, a: NewAdjustment) {
    const created = await adjustments.createAdjustment({
      employeeId: (a.employee ?? empA).id,
      adjustmentType: a.type ?? 'DEDUCTION',
      amount: a.amount,
      reason: `f12 settlement ${a.kind}`,
      recurrenceType: a.kind === 'ONE_TIME' ? 'ONE_TIME' : 'RECURRING',
      startPayrollWeekStartDate: utc(week),
      startPayrollWeekEndDate: utc(addDays(week, 6)),
      recurrenceEndType: a.kind === 'ONE_TIME' ? null : a.kind,
      totalBalance: a.kind === 'TOTAL_BALANCE' ? (a.totalBalance ?? null) : null,
      totalRecurrenceWeeks: a.kind === 'FIXED_WEEKS' ? (a.weeks ?? null) : null,
    })
    if (a.remaining !== undefined) await prisma.payrollAdjustment.update({ where: { id: created.id }, data: { remainingBalance: a.remaining } })
    const application = await prisma.payrollAdjustmentApplication.findFirstOrThrow({ where: { payrollAdjustmentId: created.id, payrollWeekStartDate: utc(week) } })
    if (a.weeklyApprove) await adjustments.approveAdjustmentApplication(application.id)
    return { adjustmentId: created.id, applicationId: application.id }
  }

  /** A week with approved attendance. */
  async function attendanceWeek(week: string, punches: Array<{ id: string }> = [empA, empB]) {
    const upload = await seedWeek(week)
    await seedPunches(upload.id, week, punches)
    // These employees work this week: an earlier approval may have marked them inactive for having no punches.
    await prisma.employee.updateMany({ where: { id: { in: punches.map((e) => e.id) } }, data: { isActive: true } })
    await approveWeek(week)
    return upload.id
  }

  const approveRun = async (week: string) => (await approvePayroll(await calculatePayroll(utc(week), utc(addDays(week, 6))))).payrollRunId

  /** An approved week and an approved payroll run for it, with an optional adjustment. */
  async function payrollWeek(week: string, o: { punches?: Array<{ id: string }>; adjustment?: NewAdjustment } = {}) {
    const uploadId = await attendanceWeek(week, o.punches)
    const created = o.adjustment ? await newAdjustment(week, o.adjustment) : { adjustmentId: '', applicationId: '' }
    const payrollRunId = await approveRun(week)
    return { uploadId, payrollRunId, ...created }
  }

  /** Another application of an existing adjustment, for another week, made the way a carry-forward makes one. */
  async function addApplication(adjustmentId: string, week: string, employee: { id: string } = empA) {
    const row = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } })
    return prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adjustmentId,
        employeeId: employee.id,
        payrollWeekStartDate: utc(week),
        payrollWeekEndDate: utc(addDays(week, 6)),
        appliedAmount: Number(row.amount),
        approvalStatus: 'PENDING',
      },
    })
  }

  const adj = async (id: string) => {
    const row = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id } })
    return {
      status: row.status,
      remainingBalance: row.remainingBalance === null ? null : Number(row.remainingBalance),
      totalBalance: row.totalBalance === null ? null : Number(row.totalBalance),
      skippedCarryForwardCount: row.skippedCarryForwardCount,
    }
  }
  const app = async (id: string) => {
    const row = await prisma.payrollAdjustmentApplication.findUniqueOrThrow({ where: { id } })
    return {
      approvalStatus: row.approvalStatus,
      appliedAmount: Number(row.appliedAmount),
      carriedTo: row.carriedForwardToPayrollWeekStartDate?.toISOString().slice(0, 10) ?? null,
    }
  }
  const appsOf = (adjustmentId: string) =>
    prisma.payrollAdjustmentApplication.findMany({ where: { payrollAdjustmentId: adjustmentId }, orderBy: [{ payrollWeekStartDate: 'asc' }, { id: 'asc' }] })
  const inWeek = async (adjustmentId: string, week: string) => (await appsOf(adjustmentId)).filter((a) => a.payrollWeekStartDate.toISOString().slice(0, 10) === week)
  const approvedSum = async (adjustmentId: string) =>
    Math.round((await appsOf(adjustmentId)).filter((a) => a.approvalStatus === 'APPROVED').reduce((sum, a) => sum + Number(a.appliedAmount), 0) * 100) / 100
  const rowOf = (revisionId: string, employeeId: string) => prisma.payrollRunEmployee.findFirstOrThrow({ where: { payrollRevisionId: revisionId, employeeId } })
  const revisionDeductions = async (revisionId: string, employeeId: string) => Number((await rowOf(revisionId, employeeId)).deductions)
  const revisionAdditions = async (revisionId: string, employeeId: string) => Number((await rowOf(revisionId, employeeId)).additions)
  const revisionNet = async (revisionId: string, employeeId: string) => Number((await rowOf(revisionId, employeeId)).netPayable)
  const sessionOf = (payrollRunId: string) => prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId, status: 'IN_PROGRESS' } })
  const runOf = (payrollRunId: string) => prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
  const revisions = (payrollRunId: string) => prisma.payrollRevision.findMany({ where: { payrollRunId }, orderBy: { revisionNumber: 'asc' } })
  const draftOf = async (payrollRunId: string) => (await revisions(payrollRunId)).find((r) => r.status === 'DRAFT')
  /** Every adjustment and application of the test employees, as plain data: what "nothing moved" is compared with. */
  const everything = async () => ({
    adjustments: JSON.parse(JSON.stringify(await prisma.payrollAdjustment.findMany({ where: { employeeId: { in: [empA.id, empB.id, empC.id] } }, orderBy: { id: 'asc' } }))) as Array<{ id: string }>,
    applications: JSON.parse(JSON.stringify(await prisma.payrollAdjustmentApplication.findMany({ where: { employeeId: { in: [empA.id, empB.id, empC.id] } }, orderBy: { id: 'asc' } }))) as Array<{ id: string }>,
  })

  async function openCorrection(payrollRunId: string) {
    await correction.beginCorrection(payrollRunId)
    await correction.startAttendanceCorrection(payrollRunId, { types: ['ADJUSTMENTS'], reason: 'f12 settlement' } as never)
  }
  /** "Recalculate". */
  async function draft(payrollRunId: string) {
    const session = await sessionOf(payrollRunId)
    return correction.recalculateAndCreateRevision({ payrollRunId, correctionReason: 'f12 settlement', correctionTypes: ['ADJUSTMENTS'], correctionSessionId: session.id })
  }
  /** Open a correction that edits punches, remove every punch of `employee` from its copy, and recalculate: the draft leaves them out. */
  async function leaveOut(payrollRunId: string, employee: { id: string }) {
    await correction.beginCorrection(payrollRunId)
    await correction.startAttendanceCorrection(payrollRunId, { types: ['ATTENDANCE', 'ADJUSTMENTS'], reason: 'f12 settlement left out' } as never)
    const session = await sessionOf(payrollRunId)
    await prisma.attendancePunch.deleteMany({ where: { correctionId: session.id, employeeId: employee.id } })
    return correction.approveCorrectionPunches(payrollRunId)
  }
  const weeklyApprove = (applicationId: string) => adjustments.approveAdjustmentApplication(applicationId)

  // ─── Rows a to l of the decision table ─────────────────────────────────────

  describe('row a: newly approved, nothing else happens', () => {
    it('TOTAL_BALANCE 120 at 70 with 50 left: the draft freezes and deducts 50, approving takes the balance to 0 and completes it', async () => {
      const run = await payrollWeek(W.a, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 70 }) // the click stores no amount

      const d = await draft(run.payrollRunId)

      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(50)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' }) // freezing moves no balance

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED', skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
      expect(Number((await runOf(run.payrollRunId)).totalDeductions)).toBe(50)
    })
  })

  describe('row b: newly approved, another week takes the rest', () => {
    it('week 3\'s application is approved in the weekly review after the draft froze 50: the approval is REVISION_STALE and writes nothing; the next recalculation is refused; skipping the row is the way out', async () => {
      const run = await payrollWeek(W.b, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: false } })
      const week3 = await addApplication(run.adjustmentId, addDays(W.b, 7))
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(50)

      // week 3 is not under correction: its weekly approval takes min(70, 50) = 50, the rest
      await weeklyApprove(week3.id)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
      const before = await everything()

      await expect(correction.approveRevision(d.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE })

      expect(await everything()).toEqual(before)
      expect((await draftOf(run.payrollRunId))?.id).toBe(d.revisionId)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      await expect(draft(run.payrollRunId)).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message: 'This adjustment is already completed or cancelled.' })
      expect(await everything()).toEqual(before)

      // the way out: skip the row; the new draft deducts nothing, and the COMPLETED adjustment is given no carry-forward
      await correction.skipAdjustmentInCorrection(run.applicationId)
      const d2 = await draft(run.payrollRunId)
      expect(await revisionDeductions(d2.revisionId, empA.id)).toBe(0)
      await correction.approveRevision(d2.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED', skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: null })
      expect(await inWeek(run.adjustmentId, addDays(W.b, 7))).toHaveLength(1) // week 3's own application, nothing new
    })
  })

  describe('row c: newly approved, another week takes part of it', () => {
    it('TOTAL_BALANCE 200 at 80 with 100 left: week 3\'s approval takes 80 after the draft froze 80, so the approval is REVISION_STALE; recalculated, the draft deducts 20 and the balance ends at 0, not below', async () => {
      const run = await payrollWeek(W.c, { adjustment: { kind: 'TOTAL_BALANCE', amount: 80, totalBalance: 200, remaining: 100, weeklyApprove: false } })
      const week3 = await addApplication(run.adjustmentId, addDays(W.c, 7))
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await app(run.applicationId)).toMatchObject({ appliedAmount: 80 })
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(80)

      await weeklyApprove(week3.id) // takes 80: 20 left
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 20, status: 'ACTIVE' })
      const before = await everything()

      await expect(correction.approveRevision(d.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE })

      expect(await everything()).toEqual(before)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED' })

      const d2 = await draft(run.payrollRunId)
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 20 })
      expect(await revisionDeductions(d2.revisionId, empA.id)).toBe(20)
      await correction.approveRevision(d2.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
      expect(await approvedSum(run.adjustmentId)).toBe(100) // 80 (week 3) + 20 (this week); the other 100 was taken by earlier weeks
    })
  })

  describe('row d: newly approved, the balance grew', () => {
    it('week 1 is skipped in another correction after week 2\'s draft froze 50 (120 left again): week 2\'s approval is REVISION_STALE; recalculated it deducts 70, 120 -> 50', async () => {
      const first = await payrollWeek(W.d, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, weeklyApprove: true } })
      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' }) // week 1 applied 70
      const W2 = addDays(W.d, 7)
      const second = await payrollWeek(W2, {})
      const app2 = await addApplication(first.adjustmentId, W2) // week 2's instalment, left PENDING by its payroll
      await openCorrection(second.payrollRunId)
      await correction.approveAdjustmentInCorrection(app2.id)
      const d2 = await draft(second.payrollRunId)
      expect(await app(app2.id)).toMatchObject({ appliedAmount: 50 })

      // week 1 is corrected and its 70 skipped: the balance goes back to 120
      await openCorrection(first.payrollRunId)
      await correction.skipAdjustmentInCorrection(first.applicationId)
      const d1 = await draft(first.payrollRunId)
      await correction.approveRevision(d1.revisionId)
      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 120, status: 'ACTIVE', skippedCarryForwardCount: 1 })
      const before = await everything()

      await expect(correction.approveRevision(d2.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE })

      expect(await everything()).toEqual(before)
      const d2b = await draft(second.payrollRunId)
      expect(await app(app2.id)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 70 })
      expect(await revisionDeductions(d2b.revisionId, empA.id)).toBe(70)
      await correction.approveRevision(d2b.revisionId)

      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
    })
  })

  describe('row e: applied 50 (the 70/50 cap) and kept', () => {
    it('another application gives 20 back meanwhile: approving again keeps the 50 and the balance stays 20', async () => {
      const run = await payrollWeek(W.e, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: true } })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      await prisma.payrollAdjustment.update({ where: { id: run.adjustmentId }, data: { remainingBalance: 20, status: 'ACTIVE' } })

      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(50) // N = O, whatever is left now
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 20, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
    })
  })

  describe('row f: applied 50, skipped now', () => {
    it('with 20 left: 70 left, ACTIVE, carried once at the adjustment\'s 70; the draft deducts 0', async () => {
      const run = await payrollWeek(W.f, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: true } })
      await prisma.payrollAdjustment.update({ where: { id: run.adjustmentId }, data: { remainingBalance: 20, status: 'ACTIVE' } })
      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)

      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0)
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 70, status: 'ACTIVE', skippedCarryForwardCount: 1 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(W.f, 7) })
      const next = await inWeek(run.adjustmentId, addDays(W.f, 7))
      expect(next).toHaveLength(1)
      expect(next[0]).toMatchObject({ approvalStatus: 'PENDING' })
      expect(Number(next[0].appliedAmount)).toBe(70)
    })
  })

  describe('row g: applied 50 with 100 left (total 120)', () => {
    it('the balance goes back to 120, never 150', async () => {
      const run = await payrollWeek(W.g, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: true } })
      await prisma.payrollAdjustment.update({ where: { id: run.adjustmentId }, data: { remainingBalance: 100, status: 'ACTIVE' } })
      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)

      await correction.approveRevision((await draft(run.payrollRunId)).revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 120, totalBalance: 120, status: 'ACTIVE' })
    })
  })

  describe('row h: ADDITION, ONE_TIME 300, newly approved', () => {
    it('the draft adds 300 to the pay, the adjustment is COMPLETED, no balance', async () => {
      const run = await payrollWeek(W.h, { adjustment: { kind: 'ONE_TIME', type: 'ADDITION', amount: 300, weeklyApprove: false } })
      const rev1 = (await revisions(run.payrollRunId))[0]
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)

      const d = await draft(run.payrollRunId)
      expect(await revisionAdditions(d.revisionId, empA.id)).toBe(300)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0)
      expect(await revisionNet(d.revisionId, empA.id)).toBe((await revisionNet(rev1.id, empA.id)) + 300)
      expect((await adj(run.adjustmentId)).status).toBe('ACTIVE') // not yet

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'COMPLETED', remainingBalance: null })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 300 })
      expect(Number((await runOf(run.payrollRunId)).totalAdditions)).toBe(300)
    })
  })

  describe('row i: ADDITION, ONE_TIME 300 applied, the employee left out', () => {
    it('COMPLETED -> ACTIVE, a PENDING 300 for the next week, counted once; the draft pays the employee nothing', async () => {
      const run = await payrollWeek(W.i, { punches: [empA, empB, empC], adjustment: { employee: empC, kind: 'ONE_TIME', type: 'ADDITION', amount: 300, weeklyApprove: true } })
      expect((await adj(run.adjustmentId)).status).toBe('COMPLETED')

      const d = await leaveOut(run.payrollRunId, empC)
      expect(d.employeeCount).toBe(2)
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(W.i, 7) })
      const next = await inWeek(run.adjustmentId, addDays(W.i, 7))
      expect(next).toHaveLength(1)
      expect(next[0]).toMatchObject({ approvalStatus: 'PENDING', employeeId: empC.id })
      expect(Number(next[0].appliedAmount)).toBe(300)
    })
  })

  describe('row j: FIXED_WEEKS 200 over 3 (66.67 a week), the third week newly approved', () => {
    it('with 66.66 left the draft deducts 66.66, 0 left, COMPLETED by count, and the total is never exceeded', async () => {
      const W1 = W.j
      const W2 = addDays(W1, 7)
      const W3 = addDays(W1, 14)
      const first = await payrollWeek(W1, { adjustment: { kind: 'FIXED_WEEKS', amount: 200, weeks: 3, weeklyApprove: true } })
      expect(await adj(first.adjustmentId)).toMatchObject({ totalBalance: 200, remainingBalance: 133.33, status: 'ACTIVE' })
      // week 2: its instalment was scheduled by the approval of week 1; approve it before its payroll
      await attendanceWeek(W2)
      const app2 = (await inWeek(first.adjustmentId, W2))[0]
      await weeklyApprove(app2.id)
      await approveRun(W2)
      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 66.66, status: 'ACTIVE' })
      // week 3: left PENDING by its payroll
      const third = await payrollWeek(W3, {})
      const app3 = (await inWeek(first.adjustmentId, W3))[0]
      expect(app3.approvalStatus).toBe('PENDING')

      await openCorrection(third.payrollRunId)
      await correction.approveAdjustmentInCorrection(app3.id)
      const d = await draft(third.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(66.66)
      await correction.approveRevision(d.revisionId)

      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
      expect(await app(app3.id)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 66.66 })
      expect(await inWeek(first.adjustmentId, addDays(W3, 7))).toHaveLength(0) // the last instalment schedules nothing
    })
  })

  describe('row k: ONE_TIME skipped twice (W -> W+1 -> W+2), then approved in a correction of W', () => {
    it('is refused (ADJUSTMENT_NOT_APPLICABLE): the PENDING at W+1 is gone, so approving W would deduct W+2\'s later as well', async () => {
      const W1 = addDays(W.k, 7)
      const run = await payrollWeek(W.k, { adjustment: { kind: 'ONE_TIME', amount: 500, weeklyApprove: false } })
      // the weekly review skips it (carried to W+1), and skips the carried one again (carried to W+2)
      await adjustments.skipAdjustmentApplication(run.applicationId)
      const appW1 = (await inWeek(run.adjustmentId, W1))[0]
      expect(appW1).toBeTruthy()
      await adjustments.skipAdjustmentApplication(appW1.id)
      expect(await app(appW1.id)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(W1, 7) })
      await openCorrection(run.payrollRunId)
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED' }) // not on the run, so not reset
      const before = await everything()

      const error = await correction.approveAdjustmentInCorrection(run.applicationId).catch((e) => e)

      expect(error).toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message: 'This adjustment was carried to the next week and has been dealt with there.' })
      expect(await everything()).toEqual(before)
    })

    it('with the PENDING at W+1 still waiting it is allowed, and approving the revision takes that carry-forward back: no second deduction later', async () => {
      const W1 = addDays(W.kAllowed, 7)
      const run = await payrollWeek(W.kAllowed, { adjustment: { kind: 'ONE_TIME', amount: 500, weeklyApprove: false } })
      await adjustments.skipAdjustmentApplication(run.applicationId) // carried to W+1, where its PENDING waits
      expect(await inWeek(run.adjustmentId, W1)).toHaveLength(1)
      await openCorrection(run.payrollRunId)

      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(500)
      await correction.approveRevision(d.revisionId)

      expect((await adj(run.adjustmentId)).status).toBe('COMPLETED')
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', carriedTo: null })
      expect(await inWeek(run.adjustmentId, W1)).toHaveLength(0)
    })
  })

  describe('row l and finding 2: a linked SKIPPED application is not carried again', () => {
    it('correction 1 leaves the employee out (carried, count 1); the next week approves the carried application; correction 2 leaves the employee out again: count stays 1, one application next week, balance = total - the approved amounts', async () => {
      const W1 = addDays(W.l, 7)
      const run = await payrollWeek(W.l, { punches: [empA, empB, empC], adjustment: { employee: empC, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 0 })

      // correction 1: C is left out of the payroll
      const d1 = await leaveOut(run.payrollRunId, empC)
      await correction.approveRevision(d1.revisionId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1, status: 'ACTIVE' })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: W1 })
      const carried = await inWeek(run.adjustmentId, W1)
      expect(carried).toHaveLength(1)

      // the next week approves the carried application (its week has no correction): 500 off the balance
      await weeklyApprove(carried[0].id)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })

      // correction 2: the application is linked to the run and SKIPPED; the correction resets it to PENDING; C is left out again
      const d2 = await leaveOut(run.payrollRunId, empC)
      await correction.approveRevision(d2.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 1, status: 'ACTIVE' })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: W1 })
      const nextWeek = await inWeek(run.adjustmentId, W1)
      expect(nextWeek).toHaveLength(1) // no second application for the week after
      expect(nextWeek[0]).toMatchObject({ approvalStatus: 'APPROVED' })
      expect(2000 - 1500).toBe(await approvedSum(run.adjustmentId)) // total - remaining = what the approved applications took
    })
  })

  // ─── The cases of the plan, section 7.4 ────────────────────────────────────

  describe('approving or skipping in a correction after a draft', () => {
    it('approve: the draft row is gone and the pointer cleared; the old draft is REVISION_STALE (a missing draft while the correction is open); after recalculating it approves and the balance moves once', async () => {
      const run = await payrollWeek(W.clickDraft, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      const first = await draft(run.payrollRunId)
      expect((await sessionOf(run.payrollRunId)).draftRevisionId).toBe(first.revisionId)

      await correction.approveAdjustmentInCorrection(run.applicationId)

      expect((await sessionOf(run.payrollRunId)).draftRevisionId).toBeNull()
      expect(await draftOf(run.payrollRunId)).toBeUndefined()
      expect(await prisma.payrollRunEmployee.count({ where: { payrollRevisionId: first.revisionId } })).toBe(0)
      await expect(correction.approveRevision(first.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE' })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000 })

      const second = await draft(run.payrollRunId)
      expect(await revisionDeductions(second.revisionId, empA.id)).toBe(500)
      await correction.approveRevision(second.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE' }) // once
    })

    it('skip: the same, and the skip of an applied application puts nothing back until the revision is approved', async () => {
      const run = await payrollWeek(W.clickSkip, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })
      await openCorrection(run.payrollRunId)
      const first = await draft(run.payrollRunId)
      expect(await revisionDeductions(first.revisionId, empA.id)).toBe(0) // PENDING after the reset

      await correction.skipAdjustmentInCorrection(run.applicationId)

      expect((await sessionOf(run.payrollRunId)).draftRevisionId).toBeNull()
      expect(await draftOf(run.payrollRunId)).toBeUndefined()
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 0 })
      await expect(correction.approveRevision(first.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE' })
    })
  })

  describe('the same week corrected twice: no double deduction', () => {
    it('a pending application approved by correction 1 is kept by correction 2: the balance moved once (1500), and approving the same amount again changes nothing', async () => {
      const run = await payrollWeek(W.repeatKeep, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      await correction.approveRevision((await draft(run.payrollRunId)).revisionId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })

      await openCorrection(run.payrollRunId)
      expect((await app(run.applicationId)).approvalStatus).toBe('PENDING') // reset by the second correction
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(500)
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect(await approvedSum(run.adjustmentId)).toBe(500)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'REVISED', currentRevisionNumber: 3 })
    })

    it('correction 2 skipping what correction 1 approved gives the balance back once (2000) and carries it once', async () => {
      const run = await payrollWeek(W.repeatSkip, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      await correction.approveRevision((await draft(run.payrollRunId)).revisionId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })

      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0)
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(W.repeatSkip, 7) })
      expect(await inWeek(run.adjustmentId, addDays(W.repeatSkip, 7))).toHaveLength(1)
      expect(await approvedSum(run.adjustmentId)).toBe(0)
    })
  })

  describe('abandon after approve, recalculate (a frozen cap) and skip', () => {
    it('every application and adjustment column equals its value before the correction opened; an application created during it is PENDING at the adjustment\'s amount again', async () => {
      const run = await payrollWeek(W.abandon, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: false } })
      const before = await everything()
      await openCorrection(run.payrollRunId)
      // created after the correction opened (a skip in the week before carries an application into this week)
      const created = await newAdjustment(W.abandon, { employee: empB, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      const createdBefore = await app(created.applicationId)

      await correction.approveAdjustmentInCorrection(run.applicationId) // the 70/50 one
      await draft(run.payrollRunId) // freezes 50
      expect(await app(run.applicationId)).toMatchObject({ appliedAmount: 50 })
      await correction.approveAdjustmentInCorrection(created.applicationId)
      await correction.skipAdjustmentInCorrection(run.applicationId) // a skip after the draft: the amount goes back to 70
      await draft(run.payrollRunId)

      const result = await correction.abandonCorrection(run.payrollRunId)

      expect(result).toMatchObject({ discardedEdits: 0 })
      const after = await everything()
      expect(after.adjustments.filter((a) => a.id !== created.adjustmentId)).toEqual(before.adjustments)
      expect(after.applications.filter((a) => a.id !== created.applicationId)).toEqual(before.applications)
      expect(await app(created.applicationId)).toEqual(createdBefore) // PENDING, at 500, no times: as it was created
      expect(await adj(created.adjustmentId)).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE' })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 70 })
      expect(await draftOf(run.payrollRunId)).toBeUndefined()
      expect((await prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId: run.payrollRunId } })).status).toBe('ABANDONED')
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
    })
  })

  describe('two corrections of different weeks on one adjustment', () => {
    async function twoCorrections() {
      const W2 = addDays(W.twoCorr, 7)
      const first = await payrollWeek(W.twoCorr, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      const second = await payrollWeek(W2, {})
      const app2 = await addApplication(first.adjustmentId, W2)
      await openCorrection(first.payrollRunId)
      await openCorrection(second.payrollRunId)
      await correction.approveAdjustmentInCorrection(first.applicationId)
      await correction.approveAdjustmentInCorrection(app2.id)
      return { first, second, app2, d1: await draft(first.payrollRunId), d2: await draft(second.payrollRunId) }
    }

    it('approved one after the other, both commit and the balance equals the total minus the sum of the APPROVED amounts; each approval locked the adjustment\'s row (this database cannot show them waiting for each other)', async () => {
      const { first, d1, d2 } = await twoCorrections()
      lockSpy.mockClear()

      await correction.approveRevision(d1.revisionId)
      await correction.approveRevision(d2.revisionId)

      expect(await adj(first.adjustmentId)).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' })
      expect(2000 - 1000).toBe(await approvedSum(first.adjustmentId))
      expect(lockSpy).toHaveBeenCalledTimes(2)
      for (const call of lockSpy.mock.calls) expect(call[1]).toEqual([first.adjustmentId])
    })
  })

  describe('weekly approve, skip, edit and cancel while a correction is open', () => {
    it('each is refused with CORRECTION_IN_PROGRESS and the balance, the statuses and the draft are as they were', async () => {
      const run = await payrollWeek(W.weeklyRefused, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      const d = await draft(run.payrollRunId)
      const before = await everything()

      await expect(adjustments.approveAdjustmentApplication(run.applicationId)).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: IN_PROGRESS })
      await expect(adjustments.skipAdjustmentApplication(run.applicationId)).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: IN_PROGRESS })
      await expect(
        adjustments.updateAdjustment(run.adjustmentId, {
          employeeId: empA.id, adjustmentType: 'DEDUCTION', amount: 700, reason: 'edited', recurrenceType: 'ONE_TIME',
          startPayrollWeekStartDate: utc(W.weeklyRefused), startPayrollWeekEndDate: utc(addDays(W.weeklyRefused, 6)),
        } as never),
      ).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: IN_PROGRESS })
      await expect(adjustments.cancelAdjustment(run.adjustmentId)).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: IN_PROGRESS })

      expect(await everything()).toEqual(before)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect((await draftOf(run.payrollRunId))?.id).toBe(d.revisionId)
    })

    it('once the correction is abandoned the same calls work again', async () => {
      const run = await payrollWeek(W.refusedAbandoned, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await expect(adjustments.cancelAdjustment(run.adjustmentId)).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS' })
      await correction.abandonCorrection(run.payrollRunId)

      await expect(adjustments.cancelAdjustment(run.adjustmentId)).resolves.toMatchObject({ status: 'CANCELLED' })
    })
  })

  describe('a draft made without a session', () => {
    it('approves as before, and a weekly approval between the draft and its approval is REVISION_STALE (nothing written)', async () => {
      const run = await payrollWeek(W.noSession, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      const d = await correction.recalculateAndCreateRevision({ payrollRunId: run.payrollRunId, correctionReason: 'no session', correctionTypes: ['ADJUSTMENTS'] })
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0) // PENDING

      // no session means nothing blocks the weekly approval of the week's PENDING application
      await weeklyApprove(run.applicationId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })
      const before = await everything()

      await expect(correction.approveRevision(d.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE })

      expect(await everything()).toEqual(before)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      // recalculated, it approves: the application is APPROVED now, and the draft deducts what it did
      const d2 = await correction.recalculateAndCreateRevision({ payrollRunId: run.payrollRunId, correctionReason: 'no session', correctionTypes: ['ADJUSTMENTS'] })
      expect(await revisionDeductions(d2.revisionId, empA.id)).toBe(500)
      await correction.approveRevision(d2.revisionId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })
    })
  })

  describe('approving the same draft twice', () => {
    it('the second is REVISION_NOT_DRAFT and the balance moved once', async () => {
      const run = await payrollWeek(W.doubleApprove, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)

      await correction.approveRevision(d.revisionId)
      await expect(correction.approveRevision(d.revisionId)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500 })
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: run.payrollRunId } })).toBe(2)
    })
  })

  // ─── The adjustment row lock, and the weekly race fix's sequencing ─────────

  describe('lockAdjustmentRows against Postgres', () => {
    it('runs for zero, one, several and repeated ids (the SQL is valid and the order of the ids does not matter), inside a transaction', async () => {
      const a = await newAdjustment(W.lockSql, { kind: 'ONE_TIME', amount: 100, weeklyApprove: false })
      const b = await newAdjustment(W.lockSql, { employee: empB, kind: 'ONE_TIME', amount: 100, weeklyApprove: false })
      const c = await newAdjustment(W.lockSql, { employee: empC, kind: 'ONE_TIME', amount: 100, weeklyApprove: false })

      await prisma.$transaction(async (tx) => {
        await realLock(tx, [])
        await realLock(tx, [a.adjustmentId])
        await realLock(tx, [c.adjustmentId, a.adjustmentId, b.adjustmentId])
        await realLock(tx, [a.adjustmentId, a.adjustmentId, b.adjustmentId])
        await realLock(tx, ['no-such-adjustment']) // a missing row locks nothing and is no error
      })
    })

    it('the lock is released when the transaction ends: a second transaction over the same rows runs, also after a rollback', async () => {
      const a = await newAdjustment(W.lockSql, { kind: 'ONE_TIME', amount: 100, weeklyApprove: false })

      await expect(prisma.$transaction(async (tx) => { await realLock(tx, [a.adjustmentId]); throw new Error('abort') })).rejects.toThrow('abort')
      await prisma.$transaction(async (tx) => { await realLock(tx, [a.adjustmentId]) })
    })
  })

  describe('the weekly approve and skip re-read under the adjustment lock', () => {
    it('approve locks the adjustment and uses the balance it finds after the lock: 2000 before, 1500 after (another week committed 500) gives 1000, not 1500', async () => {
      const mine = await newAdjustment(W.reread, { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      lockSpy.mockImplementationOnce((async (tx: Prisma.TransactionClient, ids: string[]) => {
        await realLock(tx, ids)
        // what a transaction that waited for the lock finds once it holds it: the other week's approval is in
        await tx.payrollAdjustment.update({ where: { id: mine.adjustmentId }, data: { remainingBalance: 1500 } })
      }) as never)

      await weeklyApprove(mine.applicationId)

      expect(lockSpy).toHaveBeenCalledWith(expect.anything(), [mine.adjustmentId])
      expect(await adj(mine.adjustmentId)).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' }) // 1500 - 500, nothing lost
      expect(await app(mine.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
    })

    it('an application approved by another request while this one waited is refused on the re-read; the balance is taken once', async () => {
      const mine = await newAdjustment(W.reread, { employee: empB, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      lockSpy.mockImplementationOnce((async (tx: Prisma.TransactionClient, ids: string[]) => {
        await realLock(tx, ids)
        await tx.payrollAdjustmentApplication.update({ where: { id: mine.applicationId }, data: { approvalStatus: 'APPROVED', appliedAt: new Date() } })
        await tx.payrollAdjustment.update({ where: { id: mine.adjustmentId }, data: { remainingBalance: 1500 } })
      }) as never)

      await expect(weeklyApprove(mine.applicationId)).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already approved' })

      // the transaction is rolled back with the simulated winner's writes: nothing of either is left, and nothing was deducted twice
      expect(await adj(mine.adjustmentId)).toMatchObject({ remainingBalance: 2000 })
      expect(await app(mine.applicationId)).toMatchObject({ approvalStatus: 'PENDING' })
    })

    it('two approvals one after the other: the second is refused, the balance moved once', async () => {
      const mine = await newAdjustment(W.reread, { employee: empC, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })

      await weeklyApprove(mine.applicationId)
      await expect(weeklyApprove(mine.applicationId)).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS' })

      expect(await adj(mine.adjustmentId)).toMatchObject({ remainingBalance: 1500 })
    })

    it('skip locks the adjustment and counts on the row it finds after the lock: a count of 1 before, 2 after gives 3', async () => {
      const mine = await newAdjustment(W.skipReread, { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      await prisma.payrollAdjustment.update({ where: { id: mine.adjustmentId }, data: { skippedCarryForwardCount: 1 } })
      lockSpy.mockImplementationOnce((async (tx: Prisma.TransactionClient, ids: string[]) => {
        await realLock(tx, ids)
        await tx.payrollAdjustment.update({ where: { id: mine.adjustmentId }, data: { skippedCarryForwardCount: 2 } })
      }) as never)

      await adjustments.skipAdjustmentApplication(mine.applicationId)

      expect(await adj(mine.adjustmentId)).toMatchObject({ skippedCarryForwardCount: 3, remainingBalance: 2000 })
      expect(await app(mine.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(W.skipReread, 7) })
      expect(await inWeek(mine.adjustmentId, addDays(W.skipReread, 7))).toHaveLength(1)
    })

    it('a skip of an approved application gives back the balance found under the lock: 1000 + 500 = 1500 (1500 + 500 = 2000 had the lock not been used)', async () => {
      const mine = await newAdjustment(W.skipBack, { employee: empB, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true })
      expect(await adj(mine.adjustmentId)).toMatchObject({ remainingBalance: 1500 })
      lockSpy.mockImplementationOnce((async (tx: Prisma.TransactionClient, ids: string[]) => {
        await realLock(tx, ids)
        await tx.payrollAdjustment.update({ where: { id: mine.adjustmentId }, data: { remainingBalance: 1000 } }) // another week took 500 meanwhile
      }) as never)

      await adjustments.skipAdjustmentApplication(mine.applicationId)

      expect(await adj(mine.adjustmentId)).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 1 })
    })

    it('approvePayroll carries a left-out employee\'s pending applications in its own transaction, taking the adjustment\'s row lock first', async () => {
      // C has no punches, so the payroll leaves C out; their pending deduction is carried by approvePayroll
      const week = W.leftOutPayroll
      await attendanceWeek(week, [empA, empB])
      const left = await newAdjustment(week, { employee: empC, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      lockSpy.mockClear()

      await approveRun(week)

      expect(lockSpy).toHaveBeenCalledWith(expect.anything(), [left.adjustmentId])
      expect(await app(left.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(week, 7) })
      expect(await adj(left.adjustmentId)).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    })
  })

  describe('approveRevision reads the balance after the lock', () => {
    it('a balance that changed while the lock was awaited makes the draft stale (REVISION_STALE), and nothing of the approval is left', async () => {
      const run = await payrollWeek(W.stale, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 50, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId) // freezes 50
      lockSpy.mockImplementationOnce((async (tx: Prisma.TransactionClient, ids: string[]) => {
        await realLock(tx, ids)
        await tx.payrollAdjustment.update({ where: { id: run.adjustmentId }, data: { remainingBalance: 20 } })
      }) as never)

      await expect(correction.approveRevision(d.revisionId)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE })

      expect(lockSpy).toHaveBeenCalledWith(expect.anything(), [run.adjustmentId])
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      expect((await draftOf(run.payrollRunId))?.id).toBe(d.revisionId)
      expect(await app(run.applicationId)).toMatchObject({ appliedAmount: 50 })
    })

    it('a lock that fails stops the approval before anything is written', async () => {
      const run = await payrollWeek(W.lockFails, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      const before = await everything()
      lockSpy.mockImplementationOnce((async () => { throw new Error('lock timeout') }) as never)

      await expect(correction.approveRevision(d.revisionId)).rejects.toThrow('lock timeout')

      expect(await everything()).toEqual(before)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      expect((await sessionOf(run.payrollRunId)).draftRevisionId).toBe(d.revisionId)
    })
  })

  describe('a settlement that fails in the middle rolls everything back', () => {
    it('the second adjustment\'s write is refused by the database: the first adjustment\'s balance, the promotion and the run are as they were; with the cause gone the same draft approves', async () => {
      const run = await payrollWeek(W.rollback, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      const other = await newAdjustment(W.rollback, { employee: empB, kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false })
      // plans go in adjustment id order: the one with the larger id is written second. Make that one the one the database refuses
      // (its balance becomes 1234 when it is applied; the constraint below refuses exactly that value).
      const [first, second] = [run.adjustmentId, other.adjustmentId].sort()
      await prisma.payrollAdjustment.update({ where: { id: second }, data: { remainingBalance: 1734 } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      await correction.approveAdjustmentInCorrection(other.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(500)
      expect(await revisionDeductions(d.revisionId, empB.id)).toBe(500)
      const before = await everything()

      await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT st_refuse_1234 CHECK ("remainingBalance" IS NULL OR "remainingBalance" <> 1234)`)
      try {
        await expect(correction.approveRevision(d.revisionId)).rejects.toThrow()
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollAdjustment" DROP CONSTRAINT IF EXISTS st_refuse_1234`)
      }

      expect(await everything()).toEqual(before) // the first adjustment's balance write was rolled back with it
      expect((await adj(first)).remainingBalance).toBe(2000)
      expect(await runOf(run.payrollRunId)).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
      expect(await draftOf(run.payrollRunId)).toMatchObject({ id: d.revisionId, status: 'DRAFT', isCurrent: false })
      expect((await sessionOf(run.payrollRunId)).draftRevisionId).toBe(d.revisionId)

      await correction.approveRevision(d.revisionId)
      expect((await adj(first)).remainingBalance).toBe(1500)
      expect((await adj(second)).remainingBalance).toBe(1234)
    })
  })

  describe('the balance is never driven below zero', () => {
    it('TOTAL_BALANCE 120 at 70 with 20 left, newly approved: the draft deducts 20 and the balance ends at exactly 0', async () => {
      const run = await payrollWeek(W.tight, { adjustment: { kind: 'TOTAL_BALANCE', amount: 70, totalBalance: 120, remaining: 20, weeklyApprove: false } })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(20)

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
    })
  })

  describe('the paise are exact', () => {
    it('FIXED_WEEKS 100 over 3 is 33.33 a week: newly approved the draft deducts exactly 33.33, and 66.67 is left', async () => {
      const run = await payrollWeek(W.paise, { adjustment: { kind: 'FIXED_WEEKS', amount: 100, weeks: 3, weeklyApprove: false } })
      expect(await adj(run.adjustmentId)).toMatchObject({ totalBalance: 100, remainingBalance: 100 })
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)

      const d = await draft(run.payrollRunId)

      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(33.33)
      await correction.approveRevision(d.revisionId)
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 66.67, status: 'ACTIVE' })
    })
  })
})
