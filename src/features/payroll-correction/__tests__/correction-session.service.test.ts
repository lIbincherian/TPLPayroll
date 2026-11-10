import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// F12 correction flow (US-12.29 / 12.30 / 12.31, spec C5 and C8): a correction is a session that
// edits a COPY of the week's punches. The current revision, the PayrollRun and the approved
// AttendanceRecord hours only change in approveRevision. Abandon puts everything back.

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => {
  const m = () => vi.fn()
  return {
    default: {
      payrollRun: { findUnique: m(), update: m() },
      payrollRevision: { findUnique: m(), findMany: m(), create: m(), update: m(), updateMany: m(), deleteMany: m() },
      payrollRunEmployee: { findMany: m(), createMany: m(), deleteMany: m() },
      payrollCorrectionSession: { findUnique: m(), findFirst: m(), create: m(), update: m() },
      attendancePunch: { count: m(), findMany: m(), createMany: m(), deleteMany: m(), updateMany: m() },
      attendanceEmployeeDecision: { findMany: m() },
      payrollAdjustmentApplication: { findUnique: m(), findMany: m(), update: m(), updateMany: m() },
      attendanceUpload: { findFirst: m() },
      attendanceRecord: { findMany: m(), deleteMany: m(), createMany: m() },
      employee: { findMany: m() },
      $transaction: m(),
    },
  }
})

vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))
vi.mock('@/features/attendance-sync/services/attendance-audit.service', () => ({ auditEntry: vi.fn() }))
// approveRevision locks the week row first (SELECT ... FOR UPDATE), and carries forward left-out adjustments.
vi.mock('@/features/attendance-sync/services/week-lock.service', () => ({ lockWeekRow: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({ skipAdjustmentApplication: vi.fn() }))

// Plain arithmetic stand-ins for the payroll maths; this file is about which hours go in.
vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  calculateRegularPay: vi.fn((hours: number[], rate: number) => {
    const total = hours.reduce((s, h) => s + h, 0)
    return { regularHours: total, regularPay: total * rate }
  }),
  calculateOvertimePay: vi.fn((hours: number[], rate: number) => {
    const total = hours.reduce((s, h) => s + h, 0)
    return { overtimeHours: total, overtimePay: total * rate }
  }),
  calculateNetPayable: vi.fn((gross: number, add: number, ded: number) => gross + add - ded),
}))

import prisma from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import {
  beginCorrection,
  getActiveCorrection,
  startAttendanceCorrection,
  approveCorrectionPunches,
  recalculateAndCreateRevision,
  approveRevision,
  abandonCorrection,
  getRevisionEmployees,
} from '@/features/payroll-correction/services/correction.service'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { buildGridEmployees } from '@/features/attendance-sync/lib/review'
import { getWeekDates, weekFromStartISO } from '@/features/attendance-sync/lib/week'
import type { EmployeeLite, StoredPunchRow } from '@/features/attendance-sync/types/attendance-sync.types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RUN_ID = 'run-uuid-1'
const SESSION_ID = 'session-uuid-1'
const UPLOAD_ID = 'upload-uuid-1'
const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')
const THU = new Date('2025-03-06T00:00:00.000Z')

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    status: 'APPROVED',
    currentRevisionNumber: 1,
    totalRegularPay: 7075,
    totalOvertimePay: 375,
    totalAdditions: 0,
    totalDeductions: 500,
    totalNetPayable: 6950,
    ...overrides,
  }
}

function makeRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'revision-uuid-1',
    payrollRunId: RUN_ID,
    revisionNumber: 1,
    status: 'APPROVED',
    isCurrent: true,
    correctionReason: null,
    totalRegularPay: 7075,
    totalOvertimePay: 375,
    totalAdditions: 0,
    totalDeductions: 500,
    totalNetPayable: 6950,
    generatedAt: new Date('2025-03-14'),
    approvedAt: new Date('2025-03-14'),
    ...overrides,
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    payrollRunId: RUN_ID,
    attendanceUploadId: UPLOAD_ID,
    status: 'IN_PROGRESS',
    correctionReason: null,
    correctionTypesJson: [],
    adjustmentSnapshotJson: null,
    draftRevisionId: null,
    createdAt: new Date('2025-03-15T00:00:00Z'),
    attendanceUpload: { id: UPLOAD_ID, source: 'ETIMEOFFICE', payrollWeekStartDate: WEEK_START },
    ...overrides,
  }
}

const EMPLOYEE_ONE: EmployeeLite = {
  id: 'emp-uuid-1',
  employeeId: 'EMP-001',
  employeeName: 'Kavitha Rajan',
  isActive: true,
  dateOfResignation: null,
}
const EMPLOYEE_TWO: EmployeeLite = {
  id: 'emp-uuid-2',
  employeeId: 'EMP-002',
  employeeName: 'Arun Kumar',
  isActive: true,
  dateOfResignation: null,
}

function punchRow(
  id: string,
  employeeId: string,
  pairIndex: number,
  position: 'IN' | 'OUT',
  time: string | null,
  original: string | null = time,
): StoredPunchRow & { employeeId: string; punchDate: Date } {
  return { id, employeeId, punchDate: THU, pairIndex, position, source: 'API', originalTime: original, currentTime: time, note: null }
}

/**
 * The review of a correction's punch copy, built with the real grid code so the hours are the
 * ones the review grid would show. 07:40-13:04 and 13:56-18:00 make 9.47 h: 8.00 regular and 1.47 overtime.
 */
function correctedReview(opts: { needsFixingDays?: number; withZeroHourEmployee?: boolean } = {}) {
  const punches = [
    punchRow('c-1', EMPLOYEE_ONE.id, 0, 'IN', '07:40'),
    punchRow('c-2', EMPLOYEE_ONE.id, 0, 'OUT', '13:04'),
    punchRow('c-3', EMPLOYEE_ONE.id, 1, 'IN', '13:56'),
    punchRow('c-4', EMPLOYEE_ONE.id, 1, 'OUT', '18:00', '17:47'),
  ]
  const eligible = [
    { ...EMPLOYEE_ONE, tag: 'ACTIVE' as const },
    ...(opts.withZeroHourEmployee ? [{ ...EMPLOYEE_TWO, tag: 'ACTIVE' as const }] : []),
  ]
  const dates = getWeekDates(weekFromStartISO('2025-03-06'))
  return {
    employees: buildGridEmployees(eligible, punches, dates),
    counts: { needsFixingDays: opts.needsFixingDays ?? 0 },
  }
}

function payEmployee(employee: EmployeeLite) {
  return {
    id: employee.id,
    employeeId: employee.employeeId,
    employeeName: employee.employeeName,
    designation: 'Guard',
    designationShort: 'Guard',
    site: 'North Gate',
    gPay: null,
    bankAccount: null,
    wageHistory: [{ weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: new Date('2025-01-01') }],
  }
}

/** A transaction client whose writes can be checked apart from calls made outside the transaction. */
function makeTx() {
  const m = () => vi.fn()
  const tx = {
    payrollRun: { findUnique: m(), update: m() },
    payrollRevision: { findFirst: m(), updateMany: m(), deleteMany: m(), create: m() },
    payrollRunEmployee: { findMany: m(), deleteMany: m(), createMany: m() },
    payrollCorrectionSession: { create: m(), update: m(), findUnique: m(), findFirst: m() },
    payrollAdjustmentApplication: { findMany: m(), updateMany: m() },
    attendanceEmployeeDecision: { findMany: m() },
    attendancePunch: { count: m(), findMany: m(), createMany: m(), deleteMany: m(), updateMany: m() },
    attendanceRecord: { deleteMany: m(), createMany: m(), findMany: m() },
    attendanceUpload: { findFirst: m() },
    employee: { findMany: m() },
    auditLog: { create: m(), update: m(), delete: m(), deleteMany: m(), updateMany: m() },
  }
  // Every writer reads its session again under the week lock; unless a test says otherwise it is still in progress.
  tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
  // recalculateAndCreateRevision reads the current revision again under the lock.
  tx.payrollRevision.findFirst.mockResolvedValue(makeRevision())
  return tx
}
type Tx = ReturnType<typeof makeTx>

function withInteractiveTransaction(tx: Tx) {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(tx) : Promise.all(arg as Promise<unknown>[])) as never)
}

function callOrder(fn: unknown, index = 0): number {
  return (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  // Every correction step works from the database only (US-12.29 AC6, US-12.30 AC7).
  expect(fetchSpy).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

// ─── beginCorrection (US-12.29 AC1, AC5) ──────────────────────────────────────

describe('beginCorrection', () => {
  it('fails for a run that does not exist', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(beginCorrection(RUN_ID)).rejects.toMatchObject({ code: 'PAYROLL_RUN_NOT_FOUND' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('is blocked for a run that is not approved and creates no session', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun({ status: 'DRAFT' }) as never)

    await expect(beginCorrection(RUN_ID)).rejects.toMatchObject({ code: 'CANNOT_CORRECT_UNAPPROVED_PAYROLL' })
    expect(prisma.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('accepts a REVISED run', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun({ status: 'REVISED' }) as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: UPLOAD_ID } as never)
    tx.payrollCorrectionSession.findFirst.mockResolvedValue(null)
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([] as never)
    tx.payrollCorrectionSession.create.mockResolvedValue(makeSession())
    tx.payrollRun.findUnique.mockResolvedValue({ payrollWeekStartDate: WEEK_START })

    await expect(beginCorrection(RUN_ID)).resolves.toMatchObject({ sessionId: SESSION_ID, resumed: false })
  })

  it('opens an IN_PROGRESS session that remembers the adjustments, then resets them, in one transaction', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun() as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: UPLOAD_ID } as never)
    tx.payrollCorrectionSession.findFirst.mockResolvedValue(null)
    // The snapshot is read under the week lock, on the transaction client.
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([
      {
        id: 'app-1',
        approvalStatus: 'APPROVED',
        isReversed: false,
        approvedAt: new Date('2025-03-14T10:00:00Z'),
        skippedAt: null,
        appliedAt: new Date('2025-03-14T10:00:00Z'),
      },
      {
        id: 'app-2',
        approvalStatus: 'SKIPPED',
        isReversed: true,
        approvedAt: null,
        skippedAt: new Date('2025-03-14T11:00:00Z'),
        appliedAt: null,
      },
    ] as never)
    tx.payrollCorrectionSession.create.mockResolvedValue(makeSession())
    tx.payrollRun.findUnique.mockResolvedValue({ payrollWeekStartDate: WEEK_START })

    const result = await beginCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, resumed: false, correctionTypes: [] })
    // The session stores what each application looked like before the reset.
    expect(tx.payrollCorrectionSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payrollRunId: RUN_ID,
        attendanceUploadId: UPLOAD_ID,
        status: 'IN_PROGRESS',
        correctionTypesJson: [],
        adjustmentSnapshotJson: [
          {
            applicationId: 'app-1',
            approvalStatus: 'APPROVED',
            isReversed: false,
            approvedAt: '2025-03-14T10:00:00.000Z',
            skippedAt: null,
            appliedAt: '2025-03-14T10:00:00.000Z',
          },
          {
            applicationId: 'app-2',
            approvalStatus: 'SKIPPED',
            isReversed: true,
            approvedAt: null,
            skippedAt: '2025-03-14T11:00:00.000Z',
            appliedAt: null,
          },
        ],
      }),
    })
    // The reset (prepareAdjustmentsForCorrection) runs on the same transaction client, after the session exists.
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: expect.arrayContaining([{ payrollRunId: RUN_ID }]) }),
      data: { approvalStatus: 'PENDING', isReversed: false, approvedAt: null, skippedAt: null },
    })
    expect(callOrder(tx.payrollCorrectionSession.create)).toBeLessThan(callOrder(tx.payrollAdjustmentApplication.updateMany))
    expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // The week's attendance and the current revision are not touched.
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(prisma.payrollRevision.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollRun.update).not.toHaveBeenCalled()
  })

  it('resumes an in-progress session without a second reset', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun() as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ correctionTypesJson: ['ATTENDANCE', 'NOT_A_TYPE'] }) as never,
    )

    const result = await beginCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, resumed: true, correctionTypes: ['ATTENDANCE'] })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.payrollCorrectionSession.create).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
  })

  it('fails when the run has no attendance row for its week, and creates nothing', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun() as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    await expect(beginCorrection(RUN_ID)).rejects.toMatchObject({ code: 'PAYROLL_RUN_NOT_FOUND' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

// ─── getActiveCorrection ──────────────────────────────────────────────────────

describe('getActiveCorrection', () => {
  it('returns null when no correction is in progress', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)

    await expect(getActiveCorrection(RUN_ID)).resolves.toBeNull()
  })

  it('describes the session, the week id and whether the punches were copied', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ correctionReason: 'Wrong OUT', correctionTypesJson: ['ATTENDANCE'], draftRevisionId: 'draft-1' }) as never,
    )
    vi.mocked(prisma.attendancePunch.count).mockResolvedValue(12)

    await expect(getActiveCorrection(RUN_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      payrollRunId: RUN_ID,
      attendanceUploadId: UPLOAD_ID,
      weekId: '2025-03-06',
      attendanceSource: 'ETIMEOFFICE',
      correctionReason: 'Wrong OUT',
      correctionTypes: ['ATTENDANCE'],
      hasPunchClone: true,
      draftRevisionId: 'draft-1',
    })
  })

  it('reports an Excel-era run as EXCEL with no punch copy', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ attendanceUpload: { source: 'EXCEL', payrollWeekStartDate: WEEK_START } }) as never,
    )
    vi.mocked(prisma.attendancePunch.count).mockResolvedValue(0)

    await expect(getActiveCorrection(RUN_ID)).resolves.toMatchObject({ attendanceSource: 'EXCEL', hasPunchClone: false })
  })
})

// ─── startAttendanceCorrection (US-12.29 AC2-AC4) ─────────────────────────────

describe('startAttendanceCorrection', () => {
  function livePunch(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      attendanceUploadId: UPLOAD_ID,
      correctionId: null,
      employeeId: EMPLOYEE_ONE.id,
      empCode: '0001',
      empName: 'Empname0001',
      matchStatus: 'MATCHED',
      punchDate: THU,
      pairIndex: 0,
      position: 'IN',
      source: 'API',
      originalTime: '07:40',
      currentTime: '07:40',
      note: null,
      mergedScansJson: null,
      mcid: 'M1',
      ...overrides,
    }
  }

  it('requires at least one correction type', async () => {
    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: [] })).rejects.toMatchObject({
      code: 'NO_CORRECTION_TYPE_SELECTED',
    })
    expect(prisma.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
  })

  it('needs a correction in progress', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)

    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })).rejects.toMatchObject({
      code: 'CORRECTION_NOT_ACTIVE',
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("refuses an Attendance correction for an Excel-era week and writes nothing", async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ attendanceUpload: { id: UPLOAD_ID, source: 'EXCEL', payrollWeekStartDate: WEEK_START } }) as never,
    )

    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })).rejects.toMatchObject({
      code: 'EXCEL_ERA_ATTENDANCE_CORRECTION',
      message: "Attendance can't be corrected for an Excel-era week",
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('lets an Excel-era run correct adjustments only', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ attendanceUpload: { id: UPLOAD_ID, source: 'EXCEL', payrollWeekStartDate: WEEK_START } }) as never,
    )

    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: ['ADJUSTMENTS'] })).resolves.toEqual({
      sessionId: SESSION_ID,
      weekId: '2025-03-06',
    })
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('stores a given reason and the types on the session', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(0)
    tx.attendancePunch.findMany.mockResolvedValue([])

    await startAttendanceCorrection(RUN_ID, { reason: 'Wrong OUT time for TPLGOAHLP036', types: ['ATTENDANCE', 'ADJUSTMENTS'] })

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { correctionReason: 'Wrong OUT time for TPLGOAHLP036', correctionTypesJson: ['ATTENDANCE', 'ADJUSTMENTS'] },
    })
  })

  it('stores a blank reason as null', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(0)
    tx.attendancePunch.findMany.mockResolvedValue([])

    await startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { correctionReason: null, correctionTypesJson: ['ATTENDANCE'] },
    })
  })

  it('copies the live punches once, tagged with the session and linked to their source punch', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(0)
    tx.attendancePunch.findMany.mockResolvedValue([
      livePunch('live-1'),
      livePunch('live-2', { position: 'OUT', originalTime: '17:47', currentTime: '18:00', note: 'Late scan', mergedScansJson: ['17:47', '17:48'] }),
      livePunch('live-3', { source: 'MANUAL', originalTime: null, currentTime: '09:00', mcid: null }),
    ])

    const result = await startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })

    expect(result).toEqual({ sessionId: SESSION_ID, weekId: '2025-03-06' })
    // Reads only the live set of this week.
    expect(tx.attendancePunch.findMany).toHaveBeenCalledWith({ where: { attendanceUploadId: UPLOAD_ID, correctionId: null } })
    expect(tx.attendancePunch.createMany).toHaveBeenCalledTimes(1)
    const data = tx.attendancePunch.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(data).toHaveLength(3)
    expect(data.every((row) => row.correctionId === SESSION_ID)).toBe(true)
    expect(data.map((row) => row.clonedFromPunchId)).toEqual(['live-1', 'live-2', 'live-3'])
    // Original time, current time, note and merged scans are carried over exactly.
    expect(data[1]).toMatchObject({
      attendanceUploadId: UPLOAD_ID,
      employeeId: EMPLOYEE_ONE.id,
      empCode: '0001',
      position: 'OUT',
      source: 'API',
      originalTime: '17:47',
      currentTime: '18:00',
      note: 'Late scan',
      mergedScansJson: ['17:47', '17:48'],
      mcid: 'M1',
    })
    expect(data[2]).toMatchObject({ source: 'MANUAL', originalTime: null, currentTime: '09:00' })
    // A punch with no merged scans is stored as a database NULL, not the JSON string "null".
    expect(data[0].mergedScansJson).toBe(Prisma.DbNull)
    // The live set and the approved hours are untouched.
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.createMany).not.toHaveBeenCalled()
  })

  it('does not copy again when coming back, so edits made so far are kept', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(24)

    await startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })

    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
  })

  it('copies a large week in chunks of 1000', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(0)
    tx.attendancePunch.findMany.mockResolvedValue(Array.from({ length: 2500 }, (_, i) => livePunch(`live-${i}`)))

    await startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })

    const sizes = tx.attendancePunch.createMany.mock.calls.map((call) => (call[0].data as unknown[]).length)
    expect(sizes).toEqual([1000, 1000, 500])
  })

  it('copies nothing for an adjustments-only correction', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)

    await startAttendanceCorrection(RUN_ID, { reason: 'Bonus fix', types: ['ADJUSTMENTS'] })

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { correctionReason: 'Bonus fix', correctionTypesJson: ['ADJUSTMENTS'] },
    })
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
  })
})

// ─── recalculateAndCreateRevision with a correction session (C8, US-12.30) ────

describe('recalculateAndCreateRevision for a correction session', () => {
  /** The draft is calculated and written in one interactive transaction; everything it reads and writes goes through the returned tx. */
  function setup(opts: { clonedPunches?: number; session?: Record<string, unknown> | null; review?: ReturnType<typeof correctedReview> } = {}) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    const session = (opts.session === undefined ? makeSession() : opts.session) as never
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    // The session is found before the transaction, and read again inside it (after the week row is locked).
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(session)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    tx.attendancePunch.count.mockResolvedValue(opts.clonedPunches ?? 28)
    vi.mocked(getPunchReview).mockResolvedValue((opts.review ?? correctedReview()) as never)
    tx.employee.findMany.mockResolvedValue([payEmployee(EMPLOYEE_ONE), payEmployee(EMPLOYEE_TWO)])
    tx.payrollRunEmployee.findMany.mockResolvedValue([
      { employeeId: EMPLOYEE_ONE.id, netPayable: 2750, regularPay: 2875, overtimePay: 375, additions: 0, deductions: 500 },
    ])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    return tx
  }

  const input = {
    payrollRunId: RUN_ID,
    correctionReason: 'Wrong OUT time',
    correctionTypes: ['ATTENDANCE' as const],
    correctionSessionId: SESSION_ID,
  }

  it('refuses a session that is not in progress', async () => {
    setup({ session: makeSession({ status: 'ABANDONED' }) })

    await expect(recalculateAndCreateRevision(input)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("refuses another run's session", async () => {
    setup({ session: makeSession({ payrollRunId: 'some-other-run' }) })

    await expect(recalculateAndCreateRevision(input)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('refuses a session that does not exist', async () => {
    setup({ session: null })

    await expect(recalculateAndCreateRevision(input)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('takes the hours from the corrected punches, not from the approved attendance records', async () => {
    const tx = setup()

    const result = await recalculateAndCreateRevision(input)

    // Hours come from the review of the correction's punch copy, read on the transaction client.
    expect(getPunchReview).toHaveBeenCalledWith(
      '2025-03-06',
      { kind: 'CORRECTION', payrollRunId: RUN_ID, correctionId: SESSION_ID, revisionNumber: 1 },
      tx,
    )
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.findMany).not.toHaveBeenCalled()
    // 07:40-13:04 + 13:56-18:00 = 9.47 h: 8.00 regular and 1.47 overtime.
    const rows = tx.payrollRunEmployee.createMany.mock.calls[0][0]?.data as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ employeeId: EMPLOYEE_ONE.id, regularHours: 8, overtimeHours: 1.47 })
    expect(result.employeeCount).toBe(1)
  })

  it('leaves out an employee who has zero hours after the correction', async () => {
    const tx = setup({ review: correctedReview({ withZeroHourEmployee: true }) })

    const result = await recalculateAndCreateRevision(input)

    const rows = tx.payrollRunEmployee.createMany.mock.calls[0][0]?.data as Array<{ employeeId: string }>
    expect(rows.map((r) => r.employeeId)).toEqual([EMPLOYEE_ONE.id])
    expect(result.employeeCount).toBe(1)
  })

  it('saves a DRAFT, links it to the session and leaves the current revision and the run alone', async () => {
    const tx = setup()

    const result = await recalculateAndCreateRevision(input)

    expect(tx.payrollRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.revisionId,
        revisionNumber: 2,
        status: 'DRAFT',
        isCurrent: false,
        approvedAt: null,
        correctionReason: 'Wrong OUT time',
      }),
    })
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { draftRevisionId: result.revisionId, correctionReason: 'Wrong OUT time', correctionTypesJson: ['ATTENDANCE'] },
    })
    for (const client of [prisma, tx]) {
      expect(client.payrollRevision.updateMany).not.toHaveBeenCalled()
      expect(client.payrollRun.update).not.toHaveBeenCalled()
      expect(client.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
      expect(client.attendanceRecord.deleteMany).not.toHaveBeenCalled()
      expect(client.attendanceRecord.createMany).not.toHaveBeenCalled()
      expect(client.attendancePunch.deleteMany).not.toHaveBeenCalled()
      expect(client.attendancePunch.updateMany).not.toHaveBeenCalled()
    }
    expect(prisma.payrollRevision.update).not.toHaveBeenCalled()
    // Everything was written through the transaction client.
    expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
    expect(prisma.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('replaces an earlier draft in the same transaction, deleting its employees first', async () => {
    const tx = setup()

    await recalculateAndCreateRevision(input)

    expect(tx.payrollRunEmployee.deleteMany).toHaveBeenCalledWith({
      where: { payrollRunId: RUN_ID, payrollRevision: { status: 'DRAFT' } },
    })
    expect(tx.payrollRevision.deleteMany).toHaveBeenCalledWith({ where: { payrollRunId: RUN_ID, status: 'DRAFT' } })
    expect(callOrder(tx.payrollRunEmployee.deleteMany)).toBeLessThan(callOrder(tx.payrollRevision.deleteMany))
    expect(callOrder(tx.payrollRevision.deleteMany)).toBeLessThan(callOrder(tx.payrollRevision.create))
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('totals only the employees who have hours', async () => {
    setup({ review: correctedReview({ withZeroHourEmployee: true }) })

    const result = await recalculateAndCreateRevision(input)

    expect(result.totals.totalRegularHours).toBe(8)
    expect(result.totals.totalOvertimeHours).toBe(1.47)
  })

  it('uses the approved attendance records when the session copied no punches', async () => {
    const tx = setup({ clonedPunches: 0 })
    tx.attendanceUpload.findFirst.mockResolvedValue({ id: UPLOAD_ID })
    tx.attendanceRecord.findMany.mockResolvedValue([
      {
        employeeId: EMPLOYEE_ONE.id,
        regularHours: 8,
        overtimeHours: 0,
        employee: payEmployee(EMPLOYEE_ONE),
      },
    ])

    await recalculateAndCreateRevision({ ...input, correctionTypes: ['ADJUSTMENTS'] })

    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
  })
})

// ─── approveCorrectionPunches (US-12.30 AC1) ──────────────────────────────────

describe('approveCorrectionPunches', () => {
  it('needs a correction in progress', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('fails for a run that does not exist', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({ code: 'PAYROLL_RUN_NOT_FOUND' })
  })

  it('is blocked while any day still has an incomplete pair, and creates no draft', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ correctionTypesJson: ['ATTENDANCE'] }) as never,
    )
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(28)
    // The check runs on the review read inside the recalculation's transaction.
    vi.mocked(getPunchReview).mockResolvedValue(correctedReview({ needsFixingDays: 2 }) as never)

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({
      code: 'CORRECTION_HAS_INCOMPLETE_PAIRS',
      message: expect.stringContaining('2 day(s)'),
    })
    expect(getPunchReview).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getPunchReview).mock.calls[0][2]).toBe(tx)
    expect(tx.payrollRevision.create).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
  })

  it('builds the draft revision from the corrected punches when nothing needs fixing', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ correctionReason: 'Wrong OUT time', correctionTypesJson: ['ATTENDANCE'] }) as never,
    )
    vi.mocked(getPunchReview).mockResolvedValue(correctedReview() as never)
    // approveCorrectionPunches only checks that the run exists, then recalculate reads the run with its revisions.
    vi.mocked(prisma.payrollRun.findUnique)
      .mockResolvedValueOnce({ id: RUN_ID } as never)
      .mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(makeSession() as never)
    tx.attendancePunch.count.mockResolvedValue(28)
    tx.employee.findMany.mockResolvedValue([payEmployee(EMPLOYEE_ONE)])
    tx.payrollRunEmployee.findMany.mockResolvedValue([])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])

    const result = await approveCorrectionPunches(RUN_ID)

    // The review is read once, on the transaction client, from the same punches the draft is built from.
    expect(getPunchReview).toHaveBeenCalledTimes(1)
    expect(getPunchReview).toHaveBeenCalledWith(
      '2025-03-06',
      { kind: 'CORRECTION', payrollRunId: RUN_ID, correctionId: SESSION_ID, revisionNumber: 1 },
      tx,
    )
    expect(result.revisionNumber).toBe(2)
    expect(tx.payrollRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'DRAFT', isCurrent: false, correctionReason: 'Wrong OUT time' }),
    })
    // The current revision still has isCurrent = true: only the draft was created.
    expect(tx.payrollRevision.updateMany).not.toHaveBeenCalled()
    expect(tx.payrollRun.update).not.toHaveBeenCalled()
    expect(prisma.payrollRun.update).not.toHaveBeenCalled()
  })
})

// ─── approveRevision for an attendance correction (C8, US-12.30 AC2-AC6) ──────

describe('approveRevision for an attendance correction', () => {
  function makeDraft(overrides: Record<string, unknown> = {}) {
    return {
      ...makeRevision({ id: 'revision-uuid-2', revisionNumber: 2, status: 'DRAFT', isCurrent: false, approvedAt: null, ...overrides }),
      payrollRun: makeRun(),
    }
  }

  function setup(
    tx: Tx,
    opts: { clonedPunches?: number; session?: ReturnType<typeof makeSession> | null; review?: ReturnType<typeof correctedReview> } = {},
  ) {
    withInteractiveTransaction(tx)
    const session = opts.session === undefined ? makeSession({ draftRevisionId: 'revision-uuid-2' }) : opts.session
    vi.mocked(prisma.payrollRevision.findUnique).mockResolvedValue(makeDraft() as never)
    // The session is found before the transaction, and read again inside it (after the week row is locked).
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(session as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    vi.mocked(lockWeekRow).mockResolvedValue({
      id: UPLOAD_ID,
      source: 'ETIMEOFFICE',
      status: 'APPROVED',
      syncLockedAt: null,
      approvedAt: new Date('2025-03-14'),
      payrollWeekStartDate: WEEK_START,
    })
    // The corrected punches and decisions are read on the transaction client.
    tx.attendancePunch.count.mockResolvedValue(opts.clonedPunches ?? 28)
    vi.mocked(getPunchReview).mockResolvedValue((opts.review ?? correctedReview({ withZeroHourEmployee: true })) as never)
    tx.attendanceEmployeeDecision.findMany.mockResolvedValue([
      { employeeId: EMPLOYEE_ONE.id, decision: 'APPROVED' },
    ])
    // Everyone in the draft is paid, so no adjustment is carried forward.
    tx.payrollRunEmployee.findMany.mockResolvedValue([{ employeeId: EMPLOYEE_ONE.id }, { employeeId: EMPLOYEE_TWO.id }])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    tx.payrollRevision.updateMany.mockResolvedValue({ count: 1 })
  }

  it('does everything in one interactive transaction: promote, supersede, update the run, re-point adjustments', async () => {
    const tx = makeTx()
    setup(tx)

    const result = await approveRevision('revision-uuid-2')

    expect(result).toMatchObject({ revisionId: 'revision-uuid-2', revisionNumber: 2, status: 'APPROVED' })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prisma.$transaction).mock.calls[0][1]).toEqual({ timeout: 30000 })
    // The draft becomes the current approved revision, only if it is still a draft.
    expect(tx.payrollRevision.updateMany).toHaveBeenCalledWith({
      where: { id: 'revision-uuid-2', status: 'DRAFT' },
      data: { status: 'APPROVED', isCurrent: true, approvedAt: expect.any(Date) },
    })
    // The revision it replaces is superseded.
    expect(tx.payrollRevision.updateMany).toHaveBeenCalledWith({
      where: { payrollRunId: RUN_ID, isCurrent: true, id: { not: 'revision-uuid-2' } },
      data: { isCurrent: false, status: 'SUPERSEDED' },
    })
    expect(tx.payrollRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: expect.objectContaining({ currentRevisionNumber: 2, status: 'REVISED', totalNetPayable: 6950 }),
    })
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { payrollRunId: RUN_ID },
          { payrollWeekStartDate: WEEK_START, approvalStatus: 'APPROVED', isReversed: false, payrollRunId: null },
        ],
      },
      data: { payrollRunId: RUN_ID, payrollRevisionId: 'revision-uuid-2' },
    })
    // None of it happens outside the transaction client.
    expect(prisma.payrollRevision.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollRun.update).not.toHaveBeenCalled()
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  })

  it('rebuilds the AttendanceRecord hours from the corrected punches for employees with hours only', async () => {
    const tx = makeTx()
    setup(tx)

    await approveRevision('revision-uuid-2')

    expect(tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: UPLOAD_ID } })
    expect(tx.attendanceRecord.createMany).toHaveBeenCalledTimes(1)
    const rows = tx.attendanceRecord.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    // Seven rows (one per week date) for EMP-001; the zero-hour employee gets none.
    expect(rows).toHaveLength(7)
    expect(new Set(rows.map((r) => r.employeeId))).toEqual(new Set([EMPLOYEE_ONE.id]))
    expect(rows.every((r) => r.attendanceUploadId === UPLOAD_ID)).toBe(true)
    expect(rows[0]).toMatchObject({ attendanceDate: THU, regularHours: 8, overtimeHours: 1.47, verificationDecision: 'APPROVED' })
    expect(rows.slice(1).every((r) => r.regularHours === 0 && r.overtimeHours === 0)).toBe(true)
    expect(callOrder(tx.attendanceRecord.deleteMany)).toBeLessThan(callOrder(tx.attendanceRecord.createMany))
    // The review is read on the transaction client, so it sees the punches the lock protects.
    expect(getPunchReview).toHaveBeenCalledWith(
      '2025-03-06',
      expect.objectContaining({ kind: 'CORRECTION', correctionId: SESSION_ID }),
      tx,
    )
  })

  it('replaces the live punches with the corrected copy: delete live first, then promote the copy', async () => {
    const tx = makeTx()
    setup(tx)

    await approveRevision('revision-uuid-2')

    expect(tx.attendancePunch.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: UPLOAD_ID, correctionId: null } })
    expect(tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { correctionId: SESSION_ID },
      data: { correctionId: null, clonedFromPunchId: null },
    })
    // Deleting after promoting would delete the corrected punches too.
    expect(callOrder(tx.attendancePunch.deleteMany)).toBeLessThan(callOrder(tx.attendancePunch.updateMany))
  })

  it('marks the session APPLIED and writes one audit entry on the transaction client', async () => {
    const tx = makeTx()
    setup(tx)

    await approveRevision('revision-uuid-2')

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'APPLIED', appliedAt: expect.any(Date) },
    })
    expect(auditEntry).toHaveBeenCalledTimes(1)
    expect(auditEntry).toHaveBeenCalledWith(
      {
        actionType: 'UPDATE',
        entityType: 'ATTENDANCE_WEEK',
        entityId: UPLOAD_ID,
        details: expect.objectContaining({
          summary: 'Correction applied as revision 2',
          correctionId: SESSION_ID,
          payrollRunId: RUN_ID,
          revisionNumber: 2,
        }),
      },
      tx,
    )
  })

  it('leaves attendance alone for an adjustments-only correction (session without a punch copy)', async () => {
    const tx = makeTx()
    setup(tx, { clonedPunches: 0 })

    await approveRevision('revision-uuid-2')

    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
    // The session still closes.
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'APPLIED', appliedAt: expect.any(Date) },
    })
  })

  it('works without any session (a legacy draft)', async () => {
    const tx = makeTx()
    setup(tx, { session: null })

    await expect(approveRevision('revision-uuid-2')).resolves.toMatchObject({ status: 'APPROVED' })
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  })

  it('rejects a draft that someone else already approved, and writes nothing else (double approve)', async () => {
    const tx = makeTx()
    setup(tx)
    tx.payrollRevision.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveRevision('revision-uuid-2')).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

    // The guard is the first write; nothing after it runs, so the transaction rolls back untouched.
    expect(tx.payrollRevision.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.payrollRun.update).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })

  it('propagates a failure inside the transaction instead of reporting success', async () => {
    const tx = makeTx()
    setup(tx)
    tx.attendanceRecord.createMany.mockRejectedValue(new Error('db down'))

    await expect(approveRevision('revision-uuid-2')).rejects.toThrow('db down')
    // Nothing after the failing write ran, so the session is not marked applied and no audit row is added.
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })
})

// ─── abandonCorrection (C5, US-12.31) ─────────────────────────────────────────

describe('abandonCorrection', () => {
  const snapshot = [
    {
      applicationId: 'app-1',
      approvalStatus: 'APPROVED',
      isReversed: false,
      approvedAt: '2025-03-14T10:00:00.000Z',
      skippedAt: null,
      appliedAt: '2025-03-14T10:00:00.000Z',
    },
    { applicationId: 'app-2', approvalStatus: 'SKIPPED', isReversed: true, approvedAt: null, skippedAt: '2025-03-14T11:00:00.000Z', appliedAt: null },
  ]

  type SelectRow = {
    id: string
    clonedFromPunchId: string | null
    punchDate: Date
    position: string
    source: string
    originalTime: string | null
    currentTime: string | null
    note: string | null
    employee: { employeeId: string } | null
  }

  function row(id: string, overrides: Partial<SelectRow> = {}): SelectRow {
    return {
      id,
      clonedFromPunchId: null,
      punchDate: THU,
      position: 'OUT',
      source: 'API',
      originalTime: '17:47',
      currentTime: '17:47',
      note: null,
      employee: { employeeId: 'EMP-001' },
      ...overrides,
    }
  }

  // The transaction client of the current test: the copy is counted and compared with the live set inside it.
  let activeTx: Tx

  /** The copy and the live set, as the two queries in findDiscardedEdits return them (on the transaction client). */
  function setPunches(clones: SelectRow[], live: SelectRow[]) {
    activeTx.attendancePunch.count.mockResolvedValue(clones.length)
    activeTx.attendancePunch.findMany.mockImplementation((async (args: { where: { correctionId: string | null } }) =>
      args.where.correctionId === SESSION_ID ? clones : live) as never)
  }

  function setup(tx: Tx, session = makeSession({ adjustmentSnapshotJson: snapshot, draftRevisionId: 'draft-1' })) {
    activeTx = tx
    withInteractiveTransaction(tx)
    // Found before the transaction, and read again inside it once the week row is locked.
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(session as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
  }

  it('needs a correction in progress', async () => {
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)

    await expect(abandonCorrection(RUN_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('discards the punch copy, the draft revision and its employees, and ends the session', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches([row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])

    const result = await abandonCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, discardedEdits: 1 })
    // Only the copy is deleted: the live set is never selected for deletion.
    expect(tx.attendancePunch.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.deleteMany).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.payrollRunEmployee.deleteMany).toHaveBeenCalledWith({ where: { payrollRunId: RUN_ID, payrollRevision: { status: 'DRAFT' } } })
    expect(tx.payrollRevision.deleteMany).toHaveBeenCalledWith({ where: { payrollRunId: RUN_ID, status: 'DRAFT' } })
    expect(callOrder(tx.payrollRunEmployee.deleteMany)).toBeLessThan(callOrder(tx.payrollRevision.deleteMany))
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'ABANDONED', abandonedAt: expect.any(Date) },
    })
  })

  it('leaves the approved hours and the current revision untouched', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches([row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])

    await abandonCorrection(RUN_ID)

    // Revision 1 stays current, no revision 2 appears, the run and its totals are not written.
    for (const client of [prisma, tx]) {
      expect(client.payrollRevision.updateMany).not.toHaveBeenCalled()
    }
    expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
    expect(prisma.payrollRevision.update).not.toHaveBeenCalled()
    expect(prisma.payrollRun.update).not.toHaveBeenCalled()
    expect(tx.payrollRun.update).not.toHaveBeenCalled()
    // The AttendanceRecord hours and the live punches are not rewritten.
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('puts the adjustment applications back as the snapshot recorded them', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches([], [])

    await abandonCorrection(RUN_ID)

    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: {
        approvalStatus: 'APPROVED',
        isReversed: false,
        approvedAt: new Date('2025-03-14T10:00:00.000Z'),
        skippedAt: null,
        appliedAt: new Date('2025-03-14T10:00:00.000Z'),
      },
    })
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-2' },
      data: {
        approvalStatus: 'SKIPPED',
        isReversed: true,
        approvedAt: null,
        skippedAt: new Date('2025-03-14T11:00:00.000Z'),
        appliedAt: null,
      },
    })
  })

  it('writes exactly one DISCARD audit entry listing the discarded punch edits', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches(
      [
        // Edited: 17:47 -> 18:00 with a note.
        row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00', note: 'Late scan' }),
        // Untouched copy of an approved punch: not an edit.
        row('c-2', { clonedFromPunchId: 'p-2', position: 'IN', originalTime: '07:40', currentTime: '07:40' }),
        // Added by hand in the correction.
        row('c-3', { clonedFromPunchId: null, source: 'MANUAL', position: 'IN', originalTime: null, currentTime: '09:00' }),
        // Added by hand and deleted again: nothing to discard.
        row('c-4', { clonedFromPunchId: null, source: 'MANUAL', originalTime: null, currentTime: null }),
        // An approved API punch deleted in the correction.
        row('c-5', { clonedFromPunchId: 'p-5', originalTime: '16:00', currentTime: null }),
      ],
      [
        row('p-1'),
        row('p-2', { position: 'IN', originalTime: '07:40', currentTime: '07:40' }),
        row('p-5', { originalTime: '16:00', currentTime: '16:00' }),
        // An approved hand-entered punch that the copy no longer has.
        row('p-6', { source: 'MANUAL', originalTime: null, currentTime: '12:00', position: 'IN' }),
      ],
    )

    const result = await abandonCorrection(RUN_ID)

    expect(result.discardedEdits).toBe(4)
    expect(auditEntry).toHaveBeenCalledTimes(1)
    const [entry, client] = vi.mocked(auditEntry).mock.calls[0]
    expect(client).toBe(tx)
    expect(entry).toMatchObject({ actionType: 'DISCARD', entityType: 'ATTENDANCE_WEEK', entityId: UPLOAD_ID })
    expect(entry.details).toMatchObject({
      summary: 'Discarded correction: 4 punch edit(s)',
      correctionId: SESSION_ID,
      payrollRunId: RUN_ID,
      weekStart: '2025-03-06',
    })
    const edits = (entry.details as { edits: Array<Record<string, unknown>> }).edits
    expect(edits).toEqual([
      { punchId: 'c-1', employeeCode: 'EMP-001', date: '2025-03-06', position: 'OUT', original: '17:47', current: '18:00', note: 'Late scan' },
      { punchId: 'c-3', employeeCode: 'EMP-001', date: '2025-03-06', position: 'IN', original: null, current: '09:00', note: null },
      { punchId: 'c-5', employeeCode: 'EMP-001', date: '2025-03-06', position: 'OUT', original: '16:00', current: null, note: null },
      { punchId: 'p-6', employeeCode: 'EMP-001', date: '2025-03-06', position: 'IN', original: '12:00', current: null, note: null },
    ])
    // The same list is under `discarded.edits` for the audit viewer.
    expect((entry.details as { discarded: { edits: unknown[] } }).discarded.edits).toEqual(edits)
  })

  it('keeps earlier audit entries: it never updates or deletes an audit row', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches([row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])

    await abandonCorrection(RUN_ID)

    for (const op of [tx.auditLog.update, tx.auditLog.updateMany, tx.auditLog.delete, tx.auditLog.deleteMany]) {
      expect(op).not.toHaveBeenCalled()
    }
    // The only audit write is the single DISCARD entry.
    expect(auditEntry).toHaveBeenCalledTimes(1)
    expect(vi.mocked(auditEntry).mock.calls[0][0].actionType).toBe('DISCARD')
  })

  it('caps the audited edits at 500 but still reports every discarded edit', async () => {
    const tx = makeTx()
    setup(tx)
    const clones = Array.from({ length: 600 }, (_, i) => row(`c-${i}`, { clonedFromPunchId: `p-${i}`, currentTime: '18:00' }))
    const live = Array.from({ length: 600 }, (_, i) => row(`p-${i}`))
    setPunches(clones, live)

    const result = await abandonCorrection(RUN_ID)

    expect(result.discardedEdits).toBe(600)
    const details = vi.mocked(auditEntry).mock.calls[0][0].details as { edits: unknown[]; summary: string }
    expect(details.edits).toHaveLength(500)
    expect(details.summary).toBe('Discarded correction: 600 punch edit(s)')
  })

  it('writes no audit entry and reads no punches for an adjustments-only correction', async () => {
    const tx = makeTx()
    setup(tx)
    tx.attendancePunch.count.mockResolvedValue(0)

    const result = await abandonCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, discardedEdits: 0 })
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(prisma.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
    // The draft is still removed, the adjustments are still restored and the session still ends.
    expect(tx.payrollRevision.deleteMany).toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'ABANDONED', abandonedAt: expect.any(Date) },
    })
  })

  it('tolerates a session that has no adjustment snapshot', async () => {
    const tx = makeTx()
    setup(tx, makeSession({ adjustmentSnapshotJson: null }))
    tx.attendancePunch.count.mockResolvedValue(0)

    await expect(abandonCorrection(RUN_ID)).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  })

  it('propagates a failed transaction without claiming success', async () => {
    const tx = makeTx()
    setup(tx)
    setPunches([row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])
    tx.payrollRevision.deleteMany.mockRejectedValue(new Error('db down'))

    await expect(abandonCorrection(RUN_ID)).rejects.toThrow('db down')
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })
})

// ─── getRevisionEmployees (left-out and new rows) ─────────────────────────────

describe('getRevisionEmployees', () => {
  function runEmployee(employeeId: string, code: string, name: string, net: number, extra: Record<string, unknown> = {}) {
    return {
      employeeId,
      weeklySalaryUsed: 2500,
      hourlyRateUsed: 62.5,
      regularHours: 40,
      overtimeHours: 4,
      regularPay: net,
      overtimePay: 250,
      additions: 100,
      deductions: 50,
      netPayable: net,
      employee: {
        employeeId: code,
        employeeName: name,
        designation: 'Guard',
        designationShort: 'Guard',
        site: 'North Gate',
        gPay: null,
        bankAccount: null,
      },
      ...extra,
    }
  }

  function setRevisions(draft: unknown[], previous: unknown[]) {
    vi.mocked(prisma.payrollRunEmployee.findMany).mockImplementation((async (args: { where: { payrollRevisionId: string } }) =>
      args.where.payrollRevisionId === 'draft-1' ? draft : previous) as never)
  }

  it('marks an employee paid only in the draft as new', async () => {
    setRevisions(
      [runEmployee('emp-1', 'EMP-001', 'Kavitha', 2800), runEmployee('emp-3', 'EMP-003', 'Meena', 1900)],
      [runEmployee('emp-1', 'EMP-001', 'Kavitha', 2750)],
    )

    const rows = await getRevisionEmployees('draft-1', 'current-1')

    expect(rows.map((r) => r.employeeCode)).toEqual(['EMP-001', 'EMP-003'])
    expect(rows[0]).toMatchObject({ isNew: false, isLeftOut: false, netPayable: 2800, previousNetPayable: 2750 })
    expect(rows[1]).toMatchObject({ isNew: true, isLeftOut: false, previousNetPayable: null })
  })

  it('adds an employee paid only in the current revision as a left-out row with zeros and the previous values', async () => {
    setRevisions(
      [runEmployee('emp-1', 'EMP-001', 'Kavitha', 2800)],
      [runEmployee('emp-1', 'EMP-001', 'Kavitha', 2750), runEmployee('emp-2', 'EMP-002', 'Arun', 3100)],
    )

    const rows = await getRevisionEmployees('draft-1', 'current-1')

    const leftOut = rows.find((r) => r.employeeCode === 'EMP-002')
    expect(leftOut).toMatchObject({
      isLeftOut: true,
      isNew: false,
      regularHours: 0,
      overtimeHours: 0,
      regularPay: 0,
      overtimePay: 0,
      grossPay: 0,
      additions: 0,
      deductions: 0,
      netPayable: 0,
      previousNetPayable: 3100,
      previousRegularPay: 3100,
      previousOvertimePay: 250,
      previousAdditions: 100,
      previousDeductions: 50,
      employeeName: 'Arun',
    })
    expect(rows.filter((r) => r.isLeftOut)).toHaveLength(1)
  })

  it('sorts new, unchanged and left-out rows together by employee code', async () => {
    setRevisions(
      [runEmployee('emp-3', 'EMP-003', 'Meena', 1900), runEmployee('emp-1', 'EMP-001', 'Kavitha', 2800)],
      [runEmployee('emp-2', 'EMP-002', 'Arun', 3100), runEmployee('emp-1', 'EMP-001', 'Kavitha', 2750)],
    )

    const rows = await getRevisionEmployees('draft-1', 'current-1')

    expect(rows.map((r) => r.employeeCode)).toEqual(['EMP-001', 'EMP-002', 'EMP-003'])
  })

  it('shows no new or left-out rows when there is nothing to compare with', async () => {
    setRevisions([runEmployee('emp-1', 'EMP-001', 'Kavitha', 2800)], [])

    const rows = await getRevisionEmployees('draft-1')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ isNew: false, isLeftOut: false, previousNetPayable: null })
    expect(prisma.payrollRunEmployee.findMany).toHaveBeenCalledTimes(1)
  })
})
