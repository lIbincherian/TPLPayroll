// @vitest-environment node
//
// Real-database tests for the final F12 fixes. They run the real services against a local Postgres.
//
//   F12_TEST_DB_URL=postgres://postgres:postgres@localhost:51236/template1?sslmode=disable \
//     npx vitest run src/__tests__/db --no-file-parallelism
//
// (--no-file-parallelism because `prisma dev` serves every client through one Postgres session, so two DB test
// files running at once can have their protocol messages mixed up; see f12-fix-round.db.test.ts.)
//
// Skipped (and reported as skipped) when F12_TEST_DB_URL is not set, so the normal unit run needs no database. The URL
// must point at localhost: these tests write rows, and refuse anything else. The schema must already be pushed
// (`prisma db push`). Rows use their own employees (TPLF12FX*) and Thursdays from October 2025 to January 2026, and
// are removed afterwards. The Settings row is put back as it was.
//
// What is proved here, in SQL and with the balances read back:
//   1. a correction settles every adjustment application's effect on its balance once, when the revision is
//      approved (applied->skipped, applied->pending, not applied->approved, not applied->skipped / left out),
//      and moves nothing while it is open or when it is abandoned;
//   2. approvedLeftOutCount is stored by approving a week, by a correction that rebuilds its records, and cleared
//      by a reopen; payroll's readiness reads it (null reads 0); approve and reopen clear the stale notice;
//   3. the payroll week list does not build review grids; getSettings writes only when it must.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(utc(iso).getTime() + n * 86400000).toISOString().slice(0, 10)

// Thursdays long over, none used by f12-fix-round.db.test.ts
const W = {
  appliedSkip: '2025-10-02',
  appliedPending: '2025-10-09',
  notAppliedApprove: '2025-10-16',
  notAppliedSkip: '2025-10-23',
  abandon: '2025-10-30',
  fixedWeeks: '2025-11-06',
  oneTime: '2025-11-13',
  leftOutA: '2025-11-20',
  leftOutB: '2025-11-27',
  notices: '2025-12-04',
  list: '2025-12-11',
  leftOutC: '2025-12-18',
  noSnapshot: '2025-12-25',
}
const ALL_WEEKS = Object.values(W).map(utc)
const FULL_DAY = ['08:00', '12:00', '13:00', '17:00'] // 8 regular hours

if (URL !== '' && !isLocal) {
  describe('F12 final fixes (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F12_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

describe.skipIf(!enabled)('F12 final fixes (real database)', { timeout: 120000 }, () => {
  let prisma: PrismaClient
  let empA: { id: string; employeeId: string }
  let empB: { id: string; employeeId: string }
  let empC: { id: string; employeeId: string }
  let empD: { id: string; employeeId: string } // inactive: its punches need a decision
  let approveWeek: typeof import('@/features/attendance-sync/services/week-approval.service').approveWeek
  let reopenWeek: typeof import('@/features/attendance-sync/services/week-approval.service').reopenWeek
  let listAttendanceWeeks: typeof import('@/features/attendance-sync/services/week-list.service').listAttendanceWeeks
  let calculatePayroll: typeof import('@/features/payroll-generation/services/payroll.service').calculatePayroll
  let approvePayroll: typeof import('@/features/payroll-generation/services/payroll.service').approvePayroll
  let checkAttendanceReadiness: typeof import('@/features/payroll-generation/services/payroll.service').checkAttendanceReadiness
  let getAvailablePayrollWeeks: typeof import('@/features/payroll-generation/services/payroll.service').getAvailablePayrollWeeks
  let createAdjustment: typeof import('@/features/payroll-adjustments/services/adjustment.service').createAdjustment
  let approveAdjustmentApplication: typeof import('@/features/payroll-adjustments/services/adjustment.service').approveAdjustmentApplication
  let correction: typeof import('@/features/payroll-correction/services/correction.service')
  let getSettings: typeof import('@/features/settings/services/settings.service').getSettings
  let originalSettings: { payrollWeekStartDay: string; updatedAt: Date } | null = null

  const codeOf = (emp: { id: string }) => ({ [empA?.id]: '9201', [empB?.id]: '9202', [empC?.id]: '9203', [empD?.id]: '9204' })[emp.id] ?? '9299'

  async function seedWeek(weekStart: string, status = 'REVIEW', over: Record<string, unknown> = {}) {
    return prisma.attendanceUpload.create({
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
    const emps = await prisma.employee.findMany({ where: { employeeId: { startsWith: 'TPLF12FX' } }, select: { id: true } })
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

  const mkEmployee = (code: string, name: string, isActive = true) =>
    prisma.employee.create({
      data: {
        employeeId: code,
        employeeName: name,
        designation: 'Guard',
        designationShort: 'G',
        site: 'Gate',
        isActive,
        wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
      },
    })

  beforeAll(async () => {
    process.env.DIRECT_DATABASE_URL = URL
    process.env.DATABASE_URL = URL
    prisma = (await import('@/lib/prisma')).default
    ;({ approveWeek, reopenWeek } = await import('@/features/attendance-sync/services/week-approval.service'))
    ;({ listAttendanceWeeks } = await import('@/features/attendance-sync/services/week-list.service'))
    ;({ calculatePayroll, approvePayroll, checkAttendanceReadiness, getAvailablePayrollWeeks } = await import('@/features/payroll-generation/services/payroll.service'))
    ;({ createAdjustment, approveAdjustmentApplication } = await import('@/features/payroll-adjustments/services/adjustment.service'))
    correction = await import('@/features/payroll-correction/services/correction.service')
    ;({ getSettings } = await import('@/features/settings/services/settings.service'))

    const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } })
    originalSettings = settings ? { payrollWeekStartDay: settings.payrollWeekStartDay, updatedAt: settings.updatedAt } : null

    await cleanup()
    empA = await mkEmployee('TPLF12FX9201', 'FX Alpha')
    empB = await mkEmployee('TPLF12FX9202', 'FX Bravo')
    empC = await mkEmployee('TPLF12FX9203', 'FX Charlie')
    empD = await mkEmployee('TPLF12FX9204', 'FX Delta', false)
  }, 60000)

  afterAll(async () => {
    await cleanup()
    if (originalSettings) {
      await prisma.$executeRawUnsafe(`UPDATE "Settings" SET "payrollWeekStartDay" = '${originalSettings.payrollWeekStartDay}', "updatedAt" = $1 WHERE id = 'singleton'`, originalSettings.updatedAt)
    } else {
      await prisma.settings.deleteMany({ where: { id: 'singleton' } })
    }
    await prisma.$disconnect()
  }, 60000)

  // ─── Building blocks ───────────────────────────────────────────────────────

  interface NewAdjustment {
    employee?: { id: string }
    kind: 'TOTAL_BALANCE' | 'FIXED_WEEKS' | 'ONE_TIME'
    /** TOTAL_BALANCE: the weekly instalment. FIXED_WEEKS: the total over `weeks`. ONE_TIME: the amount. */
    amount: number
    totalBalance?: number
    weeks?: number
    /** Approve it in the weekly review before the payroll is approved, as the original approval would have. */
    weeklyApprove: boolean
  }

  /** An approved week and an approved payroll run for it, with an adjustment application on one employee. */
  async function payrollWeek(week: string, o: { punches?: Array<{ id: string }>; adjustment?: NewAdjustment } = {}) {
    const upload = await seedWeek(week, 'REVIEW')
    await seedPunches(upload.id, week, o.punches ?? [empA, empB])
    await approveWeek(week)

    let adjustmentId: string | null = null
    let applicationId: string | null = null
    if (o.adjustment) {
      const a = o.adjustment
      const created = await createAdjustment({
        employeeId: (a.employee ?? empA).id,
        adjustmentType: 'DEDUCTION',
        amount: a.amount,
        reason: `f12 final ${a.kind}`,
        recurrenceType: a.kind === 'ONE_TIME' ? 'ONE_TIME' : 'RECURRING',
        startPayrollWeekStartDate: utc(week),
        startPayrollWeekEndDate: utc(addDays(week, 6)),
        recurrenceEndType: a.kind === 'ONE_TIME' ? null : a.kind,
        totalBalance: a.kind === 'TOTAL_BALANCE' ? (a.totalBalance ?? null) : null,
        totalRecurrenceWeeks: a.kind === 'FIXED_WEEKS' ? (a.weeks ?? null) : null,
      })
      adjustmentId = created.id
      const application = await prisma.payrollAdjustmentApplication.findFirstOrThrow({ where: { payrollAdjustmentId: created.id, payrollWeekStartDate: utc(week) } })
      applicationId = application.id
      if (a.weeklyApprove) await approveAdjustmentApplication(application.id)
    }

    const payrollRunId = (await approvePayroll(await calculatePayroll(utc(week), utc(addDays(week, 6))))).payrollRunId
    return { uploadId: upload.id, payrollRunId, adjustmentId: adjustmentId!, applicationId: applicationId! }
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
      isReversed: row.isReversed,
    }
  }
  const appsOf = (adjustmentId: string) =>
    prisma.payrollAdjustmentApplication.findMany({ where: { payrollAdjustmentId: adjustmentId }, orderBy: { payrollWeekStartDate: 'asc' } })
  const rawSnapshot = async () => ({
    adjustments: JSON.parse(JSON.stringify(await prisma.payrollAdjustment.findMany({ where: { employeeId: { in: [empA.id, empB.id, empC.id] } }, orderBy: { id: 'asc' } }))),
    applications: JSON.parse(JSON.stringify(await prisma.payrollAdjustmentApplication.findMany({ where: { employeeId: { in: [empA.id, empB.id, empC.id] } }, orderBy: { id: 'asc' } }))),
  })
  const revisionNet = async (revisionId: string, employeeId: string) =>
    Number((await prisma.payrollRunEmployee.findFirstOrThrow({ where: { payrollRevisionId: revisionId, employeeId } })).netPayable)
  const revisionDeductions = async (revisionId: string, employeeId: string) =>
    Number((await prisma.payrollRunEmployee.findFirstOrThrow({ where: { payrollRevisionId: revisionId, employeeId } })).deductions)
  const revisionOf = (payrollRunId: string, revisionNumber: number) =>
    prisma.payrollRevision.findFirstOrThrow({ where: { payrollRunId, revisionNumber } })
  const sessionOf = (payrollRunId: string) => prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId, status: 'IN_PROGRESS' } })

  /** Open an adjustments-only correction. */
  async function openCorrection(payrollRunId: string) {
    await correction.beginCorrection(payrollRunId)
    await correction.startAttendanceCorrection(payrollRunId, { types: ['ADJUSTMENTS'], reason: 'f12 final fixes' } as never)
  }
  /** "Recalculate": the draft revision. */
  async function draft(payrollRunId: string, types: Array<'ADJUSTMENTS' | 'ATTENDANCE'> = ['ADJUSTMENTS']) {
    const session = await sessionOf(payrollRunId)
    return correction.recalculateAndCreateRevision({
      payrollRunId, correctionReason: 'f12 final fixes', correctionTypes: types, correctionSessionId: session.id,
    })
  }

  // ─── 1. Settling a correction's adjustment effects, once, at approveRevision ─

  describe('applied before, now SKIPPED: the balance goes back and the instalment is carried forward', () => {
    let run: Awaited<ReturnType<typeof payrollWeek>>
    const week = W.appliedSkip

    beforeAll(async () => {
      run = await payrollWeek(week, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })
    }, 60000)

    it('the original approval took 500 off the balance (1500 left) and deducted 500 from the employee', async () => {
      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 1500, skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
      expect(await revisionDeductions((await revisionOf(run.payrollRunId, 1)).id, empA.id)).toBe(500)
    })

    it('opening the correction and skipping the application moves no balance: still 1500 and one application', async () => {
      await openCorrection(run.payrollRunId)
      expect((await app(run.applicationId)).approvalStatus).toBe('PENDING') // reset for re-evaluation

      await correction.skipAdjustmentInCorrection(run.applicationId)

      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: null })
      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 1500, skippedCarryForwardCount: 0 })
      expect(await appsOf(run.adjustmentId)).toHaveLength(1)
    })

    it('recalculating moves nothing either, and the draft has no deduction', async () => {
      const d = await draft(run.payrollRunId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 0 })
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0)
    })

    it('approving the revision gives the 500 back (2000), carries the application to the next week and counts it once', async () => {
      const draftId = (await sessionOf(run.payrollRunId)).draftRevisionId!

      await correction.approveRevision(draftId)

      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 2000, skippedCarryForwardCount: 1 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(week, 7) })
      const apps = await appsOf(run.adjustmentId)
      expect(apps).toHaveLength(2)
      expect(apps[1]).toMatchObject({ approvalStatus: 'PENDING', employeeId: empA.id })
      expect(Number(apps[1].appliedAmount)).toBe(500)
      expect(apps[1].payrollWeekStartDate.toISOString().slice(0, 10)).toBe(addDays(week, 7))
      // pay: revision 2 pays 500 more than revision 1
      const rev1 = await revisionOf(run.payrollRunId, 1)
      expect(await revisionNet(draftId, empA.id)).toBe((await revisionNet(rev1.id, empA.id)) + 500)
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.payrollRunId } })).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
    })

    it('approving the same draft again is refused and moves nothing a second time', async () => {
      const draftId = (await revisionOf(run.payrollRunId, 2)).id

      await expect(correction.approveRevision(draftId)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
      expect(await appsOf(run.adjustmentId)).toHaveLength(2)
    })
  })

  describe('applied before, left PENDING for a paid employee: the balance goes back, nothing is carried', () => {
    const week = W.appliedPending
    let run: Awaited<ReturnType<typeof payrollWeek>>

    beforeAll(async () => {
      run = await payrollWeek(week, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })
    }, 60000)

    it('1500 left -> 2000 on approve, the application stays PENDING, nothing is created or counted', async () => {
      expect((await adj(run.adjustmentId)).remainingBalance).toBe(1500)
      await openCorrection(run.payrollRunId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(0) // a PENDING application is not deducted
      expect((await adj(run.adjustmentId)).remainingBalance).toBe(1500) // still nothing moved

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 2000, skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'PENDING', carriedTo: null })
      expect(await appsOf(run.adjustmentId)).toHaveLength(1)
    })
  })

  describe('not applied before, now APPROVED: applied now, at the amount the draft froze', () => {
    const week = W.notAppliedApprove
    let run: Awaited<ReturnType<typeof payrollWeek>>
    let capped: { adjustmentId: string; applicationId: string }

    beforeAll(async () => {
      run = await payrollWeek(week, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false } })
      // A second adjustment on the same week: 120 at 70 a week with 50 left (earlier weeks took 70)
      const created = await createAdjustment({
        employeeId: empB.id, adjustmentType: 'DEDUCTION', amount: 70, reason: 'f12 final cap', recurrenceType: 'RECURRING',
        startPayrollWeekStartDate: utc(week), startPayrollWeekEndDate: utc(addDays(week, 6)), recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 120,
      })
      await prisma.payrollAdjustment.update({ where: { id: created.id }, data: { remainingBalance: 50 } })
      const application = await prisma.payrollAdjustmentApplication.findFirstOrThrow({ where: { payrollAdjustmentId: created.id, payrollWeekStartDate: utc(week) } })
      capped = { adjustmentId: created.id, applicationId: application.id }
    }, 60000)

    it('the application was left PENDING by the original approval: nothing applied, 2000 left', async () => {
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'PENDING' })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000 })
    })

    it('approving both in the correction changes the statuses only (no amount, no balance): the 70/50 one still has its 70', async () => {
      await openCorrection(run.payrollRunId)

      await correction.approveAdjustmentInCorrection(run.applicationId)
      await correction.approveAdjustmentInCorrection(capped.applicationId)

      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
      expect(await app(capped.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 70 })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE' })
      expect(await adj(capped.adjustmentId)).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
    })

    it('the draft freezes 500 and 50 (the 70/50 cap) and deducts exactly those, and approving the revision takes exactly those off: 1500, and 0 / COMPLETED', async () => {
      const d = await draft(run.payrollRunId)
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
      expect(await app(capped.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
      expect(await adj(capped.adjustmentId)).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' }) // freezing moves no balance
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(500)
      expect(await revisionDeductions(d.revisionId, empB.id)).toBe(50)

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect(await adj(capped.adjustmentId)).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
      expect(await app(capped.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.payrollRunId } })).toMatchObject({ status: 'REVISED' })
    })
  })

  describe('not applied before, now SKIPPED or left out: carried and counted, the balance untouched', () => {
    const week = W.notAppliedSkip
    let run: Awaited<ReturnType<typeof payrollWeek>>
    let leftOut: { adjustmentId: string; applicationId: string }

    beforeAll(async () => {
      // A, B and C are all paid by the original payroll. A's deduction was never approved (PENDING).
      run = await payrollWeek(week, {
        punches: [empA, empB, empC],
        adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: false },
      })
      // C has a deduction too, also never approved; C will be left out by the correction.
      const created = await createAdjustment({
        employeeId: empC.id, adjustmentType: 'DEDUCTION', amount: 500, reason: 'f12 final left out', recurrenceType: 'RECURRING',
        startPayrollWeekStartDate: utc(week), startPayrollWeekEndDate: utc(addDays(week, 6)), recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 2000,
      })
      const application = await prisma.payrollAdjustmentApplication.findFirstOrThrow({ where: { payrollAdjustmentId: created.id, payrollWeekStartDate: utc(week) } })
      leftOut = { adjustmentId: created.id, applicationId: application.id }
    }, 60000)

    it('A skipped in the correction and C left out by it: both are carried to the next week, counted once, with 2000 still left', async () => {
      const rev1 = await revisionOf(run.payrollRunId, 1)
      expect(await prisma.payrollRunEmployee.count({ where: { payrollRevisionId: rev1.id } })).toBe(3)
      const leftOutBefore = (await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: run.uploadId } })).approvedLeftOutCount!
      expect(leftOutBefore).not.toBeNull() // stored by the original approval

      await correction.beginCorrection(run.payrollRunId)
      await correction.startAttendanceCorrection(run.payrollRunId, { types: ['ATTENDANCE', 'ADJUSTMENTS'], reason: 'f12 final left out' } as never)
      const session = await sessionOf(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)
      // every punch of C is removed from the correction's copy: C has no hours, so the revision leaves C out
      await prisma.attendancePunch.deleteMany({ where: { correctionId: session.id, employeeId: empC.id } })
      const d = await correction.approveCorrectionPunches(run.payrollRunId)
      expect(d.employeeCount).toBe(2)

      await correction.approveRevision(d.revisionId)

      // A: skipped by the user
      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 2000, skippedCarryForwardCount: 1 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(week, 7) })
      // C: left out by the revision
      expect(await adj(leftOut.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 2000, skippedCarryForwardCount: 1 })
      expect(await app(leftOut.applicationId)).toMatchObject({ approvalStatus: 'SKIPPED', carriedTo: addDays(week, 7) })
      for (const id of [run.adjustmentId, leftOut.adjustmentId]) {
        const apps = await appsOf(id)
        expect(apps).toHaveLength(2)
        expect(apps[1]).toMatchObject({ approvalStatus: 'PENDING' })
        expect(Number(apps[1].appliedAmount)).toBe(500)
      }
      // the rebuilt records changed who is left out: C is now one more
      expect((await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: run.uploadId } })).approvedLeftOutCount).toBe(leftOutBefore + 1)
      expect(await prisma.payrollRunEmployee.count({ where: { payrollRevisionId: d.revisionId } })).toBe(2)
    })
  })

  describe('FIXED_WEEKS and ONE_TIME', () => {
    it('FIXED_WEEKS 1500 over 3: week 1 applied (1000 left, week 2 waiting); skipped in a correction -> 1500, still one application waiting, counted once', async () => {
      const run = await payrollWeek(W.fixedWeeks, { adjustment: { kind: 'FIXED_WEEKS', amount: 1500, weeks: 3, weeklyApprove: true } })
      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' })
      const before = await appsOf(run.adjustmentId)
      expect(before.map((a) => a.approvalStatus)).toEqual(['APPROVED', 'PENDING']) // the next instalment is already waiting

      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 1 })
      const after = await appsOf(run.adjustmentId)
      expect(after.map((a) => a.approvalStatus)).toEqual(['SKIPPED', 'PENDING']) // no second PENDING for the next week
      expect(after[0].carriedForwardToPayrollWeekStartDate?.toISOString().slice(0, 10)).toBe(addDays(W.fixedWeeks, 7))
    })

    it('ONE_TIME 500: applied (COMPLETED); skipped in a correction -> ACTIVE again with a PENDING 500 next week', async () => {
      const run = await payrollWeek(W.oneTime, { adjustment: { kind: 'ONE_TIME', amount: 500, weeklyApprove: true } })
      expect((await adj(run.adjustmentId)).status).toBe('COMPLETED')

      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect((await adj(run.adjustmentId)).status).toBe('COMPLETED') // not yet

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
      const apps = await appsOf(run.adjustmentId)
      expect(apps).toHaveLength(2)
      expect(apps[1]).toMatchObject({ approvalStatus: 'PENDING' })
    })
  })

  describe('a draft made without a session settles from the application\'s own status', () => {
    it('APPROVED and the employee paid: nothing moves (1500 stays 1500); the revision is promoted', async () => {
      const run = await payrollWeek(W.noSnapshot, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })

      const d = await correction.recalculateAndCreateRevision({ payrollRunId: run.payrollRunId, correctionReason: 'no session', correctionTypes: ['ADJUSTMENTS'] })
      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
      expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.payrollRunId } })).toMatchObject({ status: 'REVISED', currentRevisionNumber: 2 })
    })
  })

  describe('abandon: only statuses are put back', () => {
    const week = W.abandon
    let run: Awaited<ReturnType<typeof payrollWeek>>

    beforeAll(async () => {
      run = await payrollWeek(week, { adjustment: { kind: 'TOTAL_BALANCE', amount: 500, totalBalance: 2000, weeklyApprove: true } })
    }, 60000)

    it('after skipping, drafting and abandoning, every adjustment and application is exactly as it was, and no balance moved', async () => {
      const before = await rawSnapshot()
      const runBefore = JSON.stringify(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.payrollRunId } }))
      await openCorrection(run.payrollRunId)
      await correction.skipAdjustmentInCorrection(run.applicationId)
      await draft(run.payrollRunId)
      expect((await adj(run.adjustmentId)).remainingBalance).toBe(1500)

      const result = await correction.abandonCorrection(run.payrollRunId)

      expect(result).toMatchObject({ discardedEdits: 0 })
      expect(await rawSnapshot()).toEqual(before)
      expect(await adj(run.adjustmentId)).toMatchObject({ status: 'ACTIVE', remainingBalance: 1500, skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500, carriedTo: null })
      expect(await appsOf(run.adjustmentId)).toHaveLength(1)
      expect(JSON.stringify(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.payrollRunId } }))).toBe(runBefore)
      expect(await prisma.payrollRevision.count({ where: { payrollRunId: run.payrollRunId } })).toBe(1) // the draft is gone
      expect((await prisma.payrollCorrectionSession.findFirstOrThrow({ where: { payrollRunId: run.payrollRunId } })).status).toBe('ABANDONED')
    })

    it('a correction opened and abandoned with no change at all also leaves everything as it was', async () => {
      const before = await rawSnapshot()
      await correction.beginCorrection(run.payrollRunId)
      expect((await app(run.applicationId)).approvalStatus).toBe('PENDING') // the reset

      await correction.abandonCorrection(run.payrollRunId)

      expect(await rawSnapshot()).toEqual(before)
    })

    it('after the abandon a new correction snapshots the restored state: re-approving the application moves nothing', async () => {
      await openCorrection(run.payrollRunId)
      await correction.approveAdjustmentInCorrection(run.applicationId)
      const d = await draft(run.payrollRunId)
      expect(await revisionDeductions(d.revisionId, empA.id)).toBe(500) // the stored amount of the original approval

      await correction.approveRevision(d.revisionId)

      expect(await adj(run.adjustmentId)).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
      expect(await app(run.applicationId)).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
    })
  })

  // ─── 2. approvedLeftOutCount, the stale notice, readiness ───────────────────

  describe('approvedLeftOutCount: stored by the approval, cleared by a reopen, read by payroll', () => {
    const week = W.leftOutA
    let uploadId: string

    beforeAll(async () => {
      uploadId = (await seedWeek(week, 'REVIEW')).id
      // A and B work. C is active with no punches (zero hours). D is inactive with punches and was REJECTED.
      await seedPunches(uploadId, week, [empA, empB, empD])
      await prisma.attendanceEmployeeDecision.create({ data: { attendanceUploadId: uploadId, employeeId: empD.id, reason: 'INACTIVE', decision: 'REJECTED' } })
    }, 60000)

    const stored = async () => (await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })).approvedLeftOutCount
    const zeroHourActives = async () =>
      (await prisma.employee.count({ where: { isActive: true } })) - 2 // everyone active except A and B (who have punches)

    it('a week in review has no stored count', async () => {
      expect(await stored()).toBeNull()
    })

    it('approving stores the count the summary showed: every active employee without hours, plus the rejected one', async () => {
      const { summary } = await approveWeek(week)

      expect(summary.leftOut.map((l) => l.reason).filter((r) => r === 'REJECTED')).toHaveLength(1)
      expect(await stored()).toBe(summary.leftOut.length)
      expect(await stored()).toBe((await zeroHourActives()) + 1)
    })

    it('payroll shows the stored number, and keeps showing it when the live punches change afterwards', async () => {
      const count = (await stored())!
      const ready = await checkAttendanceReadiness(utc(week), utc(addDays(week, 6)))
      expect(ready).toMatchObject({ ready: true, matchedEmployeeCount: 2, leftOutCount: count })

      // C starts to have punches in the live set (they were never approved). A recount from the live grid would say one fewer.
      await seedPunches(uploadId, week, [empC])

      expect(await checkAttendanceReadiness(utc(week), utc(addDays(week, 6)))).toMatchObject({ leftOutCount: count })
    })

    it('a week approved before the column existed (null) reads as 0 left out', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { approvedLeftOutCount: null } })

      expect(await checkAttendanceReadiness(utc(week), utc(addDays(week, 6)))).toMatchObject({ ready: true, leftOutCount: 0 })
    })

    it('reopening clears the count; the week is not ready; approving again stores the new number (C now has hours: one fewer)', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { approvedLeftOutCount: 99 } })

      await reopenWeek(week)

      expect(await stored()).toBeNull()
      expect(await checkAttendanceReadiness(utc(week), utc(addDays(week, 6)))).toEqual({ ready: false, reason: 'NOT_APPROVED' })

      const { summary } = await approveWeek(week)
      expect(await stored()).toBe(summary.leftOut.length)
      expect(await stored()).toBe((await zeroHourActives()) - 1 + 1) // C now has hours, D is still rejected
    })
  })

  describe('a correction that rebuilds the records updates the stored count; an adjustments-only one leaves it', () => {
    it('B loses all punches in an attendance correction: one more left out; then an adjustments-only correction leaves the count', async () => {
      const run = await payrollWeek(W.leftOutB, { punches: [empA, empB] })
      const before = (await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: run.uploadId } })).approvedLeftOutCount!

      await correction.beginCorrection(run.payrollRunId)
      await correction.startAttendanceCorrection(run.payrollRunId, { types: ['ATTENDANCE'], reason: 'f12 final count' } as never)
      const session = await sessionOf(run.payrollRunId)
      await prisma.attendancePunch.deleteMany({ where: { correctionId: session.id, employeeId: empB.id } })
      const d1 = await correction.approveCorrectionPunches(run.payrollRunId)
      await correction.approveRevision(d1.revisionId)

      expect((await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: run.uploadId } })).approvedLeftOutCount).toBe(before + 1)

      await openCorrection(run.payrollRunId)
      const d2 = await draft(run.payrollRunId)
      await correction.approveRevision(d2.revisionId)

      expect((await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: run.uploadId } })).approvedLeftOutCount).toBe(before + 1)
    })
  })

  describe('the stale notice does not outlive an approval or a reopen', () => {
    const week = W.notices
    let uploadId: string

    beforeAll(async () => {
      uploadId = (await seedWeek(week, 'REVIEW')).id
      await seedPunches(uploadId, week, [empA, empB])
    }, 60000)

    const notice = async () => (await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })).staleNoticeAt

    it('approving clears a notice (and a pull error) stored on the week in review', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { staleNoticeAt: new Date(), lastSyncError: 'eTimeOffice returned HTTP 500.' } })
      expect(await notice()).not.toBeNull()

      await approveWeek(week)

      const row = await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })
      expect(row).toMatchObject({ status: 'APPROVED', staleNoticeAt: null, lastSyncError: null })
    })

    it('reopening clears a notice stored on the approved week, and the count', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { staleNoticeAt: new Date() } })

      await reopenWeek(week)

      const row = await prisma.attendanceUpload.findUniqueOrThrow({ where: { id: uploadId } })
      expect(row).toMatchObject({ status: 'REVIEW', staleNoticeAt: null, approvedLeftOutCount: null, approvedAt: null })
    })

    it('the week list no longer offers the notice for the approved week (nothing stored to show)', async () => {
      await approveWeek(week)

      const item = (await listAttendanceWeeks()).find((w) => w.weekId === week)!

      expect(item).toMatchObject({ status: 'APPROVED', staleNoticeAt: null, canPullNow: false })
    })
  })

  // ─── 3. The payroll week list builds no review grids ─────────────────────────

  describe('the payroll week list does not build review grids for weeks in review', () => {
    const week = W.list
    let uploadId: string

    beforeAll(async () => {
      uploadId = (await seedWeek(week, 'REVIEW')).id
      await seedPunches(uploadId, week, [empA, empB])
    }, 60000)

    it('the attendance week list counts the review week (2 employees, 112 regular hours); the payroll one reports zeros for it', async () => {
      const attendance = (await listAttendanceWeeks()).find((w) => w.weekId === week)!
      const payroll = (await getAvailablePayrollWeeks()).find((w) => w.weekId === week)!

      expect(attendance).toMatchObject({ status: 'REVIEW', employeeCount: 2, totalRegularHours: 112, totalOvertimeHours: 0 })
      expect(payroll).toMatchObject({ attendanceStatus: 'REVIEW', matchedEmployeeCount: 0, totalRegularHours: 0, totalOvertimeHours: 0, canGenerate: false })
    })

    it('everything else about the week is the same in both lists, and an approved week keeps its counts in the payroll list', async () => {
      const attendance = (await listAttendanceWeeks()).find((w) => w.weekId === week)!
      const payroll = (await getAvailablePayrollWeeks()).find((w) => w.weekId === week)!
      expect(payroll).toMatchObject({ weekId: attendance.weekId, source: 'ETIMEOFFICE', payrollStatus: attendance.payrollStatus, payrollRunId: attendance.payrollRunId })

      await approveWeek(week)

      const approved = (await getAvailablePayrollWeeks()).find((w) => w.weekId === week)!
      expect(approved).toMatchObject({ attendanceStatus: 'APPROVED', matchedEmployeeCount: 2, totalRegularHours: 112, canGenerate: true })
    })
  })

  // ─── 4. getSettings writes only when it must ─────────────────────────────────

  describe('getSettings writes only when the row is missing or is not Thursday', () => {
    const updatedAt = async () => (await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).updatedAt

    it('no row: the read creates it, Thursday', async () => {
      await prisma.settings.deleteMany({ where: { id: 'singleton' } })

      const result = await getSettings()

      expect(result.payrollWeekStartDay).toBe('THURSDAY')
      expect(await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).toMatchObject({ payrollWeekStartDay: 'THURSDAY' })
    })

    it('a Thursday row: reads leave the row, and its updatedAt, exactly as it was', async () => {
      const old = new Date('2020-01-02T03:04:05.000Z')
      await prisma.$executeRawUnsafe(`UPDATE "Settings" SET "updatedAt" = $1 WHERE id = 'singleton'`, old)

      for (let i = 0; i < 3; i++) expect((await getSettings()).payrollWeekStartDay).toBe('THURSDAY')

      expect((await updatedAt()).toISOString()).toBe(old.toISOString())
    })

    it('a row that is not Thursday is changed to Thursday, and the write shows in updatedAt; the next read is quiet again', async () => {
      const old = new Date('2020-01-02T03:04:05.000Z')
      await prisma.$executeRawUnsafe(`UPDATE "Settings" SET "payrollWeekStartDay" = 'MONDAY', "updatedAt" = $1 WHERE id = 'singleton'`, old)

      const result = await getSettings()

      expect(result.payrollWeekStartDay).toBe('THURSDAY')
      const healed = await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })
      expect(healed.payrollWeekStartDay).toBe('THURSDAY')
      expect(healed.updatedAt.getTime()).toBeGreaterThan(old.getTime())

      await getSettings()
      expect((await updatedAt()).getTime()).toBe(healed.updatedAt.getTime())
    })
  })
})
