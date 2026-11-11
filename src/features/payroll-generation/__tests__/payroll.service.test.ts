import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AttendanceUpload, AttendanceRecord, PayrollRun, PayrollRevision } from '@prisma/client'

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    attendanceUpload: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    attendanceRecord: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    payrollRevision: {
      create: vi.fn(),
      update: vi.fn(),
    },
    payrollRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    payrollRunEmployee: {
      createMany: vi.fn(),
    },
    payrollAdjustmentApplication: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
    // The week row lock (lockWeekRow) is a raw SELECT ... FOR UPDATE.
    $queryRaw: vi.fn(),
  },
}))

// ─── Mock F05 adjustment service ──────────────────────────────────────────────
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  getAdjustmentsForWeekReview: vi.fn(),
  skipAdjustmentApplication: vi.fn(),
}))

// ─── Mock F12 attendance services (the payroll week list builds on them) ─
vi.mock('@/features/attendance-sync/services/week-list.service', () => ({
  listAttendanceWeeks: vi.fn(),
}))

import prisma from '@/lib/prisma'
import {
  getAdjustmentsForWeekReview,
  skipAdjustmentApplication,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { listAttendanceWeeks } from '@/features/attendance-sync/services/week-list.service'
import type { AttendanceWeekListItem } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  calculateRegularPay,
  calculateOvertimePay,
  calculateNetPayable,
  getAvailablePayrollWeeks,
  checkAttendanceReadiness,
  getPendingAdjustmentsForWeek,
  calculatePayroll,
  approvePayroll,
} from '@/features/payroll-generation/services/payroll.service'
import { PayrollServiceError } from '@/features/payroll-generation/types/payroll.types'
import type { PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')

function makeUpload(overrides: Partial<AttendanceUpload> = {}): AttendanceUpload {
  return {
    id: 'upload-uuid-1',
    fileName: null,
    fileType: null,
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    payrollWeekSource: 'ETIMEOFFICE',
    source: 'ETIMEOFFICE',
    status: 'APPROVED',
    isActiveForPayrollWeek: true,
    uploadedBy: null,
    uploadedAt: new Date('2025-03-14'),
    sourceStorageKey: null,
    lastSyncAttemptAt: null,
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncTrigger: null,
    staleNoticeAt: null,
    syncLockedAt: null,
    approvedAt: new Date('2025-03-14'),
    approvedLeftOutCount: null,
    activeWeekStart: WEEK_START,
    ...overrides,
  }
}

/** The row `lockWeekRow` returns for an upload. */
function lockRow(overrides: Partial<AttendanceUpload> = {}) {
  const upload = makeUpload(overrides)
  return {
    id: upload.id,
    source: upload.source,
    status: upload.status,
    syncLockedAt: upload.syncLockedAt,
    approvedAt: upload.approvedAt,
    payrollWeekStartDate: upload.payrollWeekStartDate,
  }
}

function makeRecord(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'rec-uuid-1',
    attendanceUploadId: 'upload-uuid-1',
    employeeId: 'emp-uuid-1',
    attendanceDate: new Date('2025-03-06'),
    regularHours: 8 as unknown as AttendanceRecord['regularHours'],
    overtimeHours: 0 as unknown as AttendanceRecord['overtimeHours'],
    sourceSheetName: 'Sheet1',
    sourceEmployeeBlockIndex: 0,
    createdAt: new Date('2025-03-14'),
    ...overrides,
  }
}

function makePayrollRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run-uuid-1',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    status: 'APPROVED',
    currentRevisionNumber: 1,
    totalRegularPay: 2875 as unknown as PayrollRun['totalRegularPay'],
    totalOvertimePay: 375 as unknown as PayrollRun['totalOvertimePay'],
    totalAdditions: 200 as unknown as PayrollRun['totalAdditions'],
    totalDeductions: 500 as unknown as PayrollRun['totalDeductions'],
    totalNetPayable: 2950 as unknown as PayrollRun['totalNetPayable'],
    generatedBy: null,
    approvedBy: null,
    generatedAt: new Date('2025-03-14'),
    approvedAt: new Date('2025-03-14'),
    invoicesGeneratedAt: null,
    approvedWeekStart: null,
    ...overrides,
  }
}

function makeRevision(overrides: Partial<PayrollRevision> = {}): PayrollRevision {
  return {
    id: 'revision-uuid-1',
    payrollRunId: 'run-uuid-1',
    revisionNumber: 1,
    status: 'APPROVED',
    correctionReason: null,
    totalRegularPay: 2875 as unknown as PayrollRevision['totalRegularPay'],
    totalOvertimePay: 375 as unknown as PayrollRevision['totalOvertimePay'],
    totalAdditions: 200 as unknown as PayrollRevision['totalAdditions'],
    totalDeductions: 500 as unknown as PayrollRevision['totalDeductions'],
    totalNetPayable: 2950 as unknown as PayrollRevision['totalNetPayable'],
    generatedBy: null,
    approvedBy: null,
    generatedAt: new Date('2025-03-14'),
    approvedAt: new Date('2025-03-14'),
    invoicesGeneratedAt: null,
    isCurrent: true,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<PayrollSummary> = {}): PayrollSummary {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    attendanceApprovedAt: makeUpload().approvedAt as Date,
    employees: [
      {
        employeeId: 'emp-uuid-1',
        employeeCode: 'EMP-001',
        employeeName: 'Lakshmi Venkatesh',
        designation: 'Guard',
        designationShort: null,
        site: null,
        gPay: null,
        bankAccount: null,
        weeklySalaryUsed: 2500,
        hourlyRateUsed: 62.5,
        regularHours: 46,
        overtimeHours: 6,
        regularPay: 2875,
        overtimePay: 375,
        grossPay: 3250,
        additions: 200,
        deductions: 500,
        netPayable: 2950,
      },
    ],
    totals: {
      totalRegularHours: 46,
      totalOvertimeHours: 6,
      totalRegularPay: 2875,
      totalOvertimePay: 375,
      totalAdditions: 200,
      totalDeductions: 500,
      totalNetPayable: 2950,
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── US-06.4: Pure calculation helpers ───────────────────────────────────────

describe('calculateRegularPay', () => {
  it('caps daily regular hours at 8 and multiplies by rate', () => {
    // E2E-03 scenario: [8, 8, 6, 0, 8, 8, 8] — hourlyRate 62.50
    const result = calculateRegularPay([8, 8, 6, 0, 8, 8, 8], 62.5)
    expect(result.regularHours).toBe(46)
    expect(result.regularPay).toBe(2875.0)
  })



  it('returns zero for all-zero hours', () => {
    const result = calculateRegularPay([0, 0, 0, 0, 0, 0, 0], 62.5)
    expect(result.regularHours).toBe(0)
    expect(result.regularPay).toBe(0)
  })

  it('retains paise precision', () => {
    // 46 * 71.43 = 3285.78
    const result = calculateRegularPay([8, 8, 6, 0, 8, 8, 8], 71.43)
    expect(result.regularPay).toBeCloseTo(3285.78, 2)
    expect(result.regularPay).not.toBe(3286)
  })
})

describe('calculateOvertimePay', () => {
  it('sums overtime hours and multiplies by rate', () => {
    // E2E-03: OT = [2, 0, 0, 0, 3, 1, 0] — hourlyRate 62.50
    const result = calculateOvertimePay([2, 0, 0, 0, 3, 1, 0], 62.5)
    expect(result.overtimeHours).toBe(6)
    expect(result.overtimePay).toBe(375.0)
  })

  it('retains paise precision', () => {
    // 3 * 71.43 = 214.29
    const result = calculateOvertimePay([1, 1, 1, 0, 0, 0, 0], 71.43)
    expect(result.overtimePay).toBeCloseTo(214.29, 2)
    expect(result.overtimePay).not.toBe(215)
  })
})

describe('calculateNetPayable', () => {
  it('includes approved additions and deductions', () => {
    // grossPay=3250, additions=200, deductions=500 → 2950
    const result = calculateNetPayable(3250, 200, 500)
    expect(result).toBe(2950)
  })

  it('returns grossPay when there are no adjustments', () => {
    expect(calculateNetPayable(3250, 0, 0)).toBe(3250)
  })
})

// ─── US-06.2: checkAttendanceReadiness ───────────────────────────────────────

describe('checkAttendanceReadiness', () => {
  it('returns ready:true with stats when attendance is approved', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'APPROVED', approvedLeftOutCount: 1 }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecord({ employeeId: 'emp-1', regularHours: 8 as unknown as AttendanceRecord['regularHours'], overtimeHours: 0 as unknown as AttendanceRecord['overtimeHours'] }),
      makeRecord({ id: 'rec-2', employeeId: 'emp-2', regularHours: 6 as unknown as AttendanceRecord['regularHours'], overtimeHours: 2 as unknown as AttendanceRecord['overtimeHours'] }),
    ])

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(true)
    if (result.ready) {
      expect(result.matchedEmployeeCount).toBe(2)
      expect(result.leftOutCount).toBe(1)
      expect(result.totalRegularHours).toBe(14)
      expect(result.totalOvertimeHours).toBe(2)
    }
  })

  it('returns NOT_APPROVED when the week is still in review', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'REVIEW' }))

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('NOT_APPROVED')
    }
  })

  it('returns SYNC_FAILED when the last sync failed', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'SYNC_FAILED' }))

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('SYNC_FAILED')
    }
  })

  it('returns EXCEL_ERA for a week imported from Excel', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(
      makeUpload({ source: 'EXCEL', status: 'READY', payrollWeekSource: 'SHEET_CONTENT' }),
    )

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('EXCEL_ERA')
    }
  })

  it('returns NO_DATA when no active attendance row exists', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('NO_DATA')
    }
  })

  // US-12.26: an approved week with 8.00 regular and 1.25 overtime hours
  it('is ready for an approved week with 8.00 regular and 1.25 overtime hours', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'APPROVED' }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecord({
        regularHours: 8 as unknown as AttendanceRecord['regularHours'],
        overtimeHours: 1.25 as unknown as AttendanceRecord['overtimeHours'],
      }),
    ])

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result).toEqual({
      ready: true,
      matchedEmployeeCount: 1,
      leftOutCount: 0,
      totalRegularHours: 8,
      totalOvertimeHours: 1.25,
    })
  })

  it('counts an employee once however many day rows the week has', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecord({ id: 'r1', employeeId: 'emp-1' }),
      makeRecord({ id: 'r2', employeeId: 'emp-1' }),
      makeRecord({ id: 'r3', employeeId: 'emp-1' }),
    ])

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready && result.matchedEmployeeCount).toBe(1)
    expect(result.ready && result.totalRegularHours).toBe(24)
  })

  it('takes leftOutCount from the count stored when the week was approved (zero-hour and rejected employees)', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ approvedLeftOutCount: 2 }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([makeRecord()])

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready && result.leftOutCount).toBe(2)
  })

  // US-12.27: a reopened week goes back to REVIEW and its records are removed
  it('is not ready for a reopened week and reads no records', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(
      makeUpload({ status: 'REVIEW', approvedAt: null }),
    )

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result).toEqual({ ready: false, reason: 'NOT_APPROVED' })
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('only looks at the active attendance row for exactly this week', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(prisma.attendanceUpload.findFirst).toHaveBeenCalledWith({
      where: {
        payrollWeekStartDate: WEEK_START,
        payrollWeekEndDate: WEEK_END,
        isActiveForPayrollWeek: true,
      },
    })
  })

  it('propagates a database failure instead of reporting a week as ready', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockRejectedValue(new Error('db down'))

    await expect(checkAttendanceReadiness(WEEK_START, WEEK_END)).rejects.toThrow('db down')
  })
})

// ─── US-06.3: getPendingAdjustmentsForWeek ────────────────────────────────────

describe('getPendingAdjustmentsForWeek', () => {
  it('returns the 3 pending applications of employees included in the week', async () => {
    const pendingItems = [
      { applicationId: 'app-1', employeeId: 'emp-1', adjustmentType: 'DEDUCTION', appliedAmount: 500 },
      { applicationId: 'app-2', employeeId: 'emp-2', adjustmentType: 'ADDITION', appliedAmount: 200 },
      { applicationId: 'app-3', employeeId: 'emp-1', adjustmentType: 'DEDUCTION', appliedAmount: 300 },
    ]
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue(pendingItems as never)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      { employeeId: 'emp-1' },
      { employeeId: 'emp-2' },
    ] as never)

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toHaveLength(3)
    expect(vi.mocked(getAdjustmentsForWeekReview)).toHaveBeenCalledWith(WEEK_START)
  })

  it('leaves out the adjustments of an employee who has no hours in the week', async () => {
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue([
      { applicationId: 'app-1', employeeId: 'emp-1', adjustmentType: 'DEDUCTION', appliedAmount: 500 },
      { applicationId: 'app-2', employeeId: 'emp-left-out', adjustmentType: 'DEDUCTION', appliedAmount: 500 },
    ] as never)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([{ employeeId: 'emp-1' }] as never)

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result.map((r) => r.applicationId)).toEqual(['app-1'])
  })

  it('returns empty array when no pending adjustments', async () => {
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue([])
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([{ employeeId: 'emp-1' }] as never)

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toHaveLength(0)
  })

  it('returns nothing when the week has no attendance row, without reading adjustments', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toEqual([])
    expect(getAdjustmentsForWeekReview).not.toHaveBeenCalled()
  })

  it('returns nothing when every employee with adjustments is left out of the week', async () => {
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue([
      { applicationId: 'app-1', employeeId: 'emp-left-out', adjustmentType: 'DEDUCTION', appliedAmount: 500 },
    ] as never)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([])

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toEqual([])
  })

  it('reads the included employees from this week\'s attendance records, one row per employee', async () => {
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue([])
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ id: 'upload-uuid-9' }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([])

    await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-uuid-9' },
      select: { employeeId: true },
      distinct: ['employeeId'],
    })
  })
})

// ─── US-06.1: getAvailablePayrollWeeks ───────────────────────────────────────

function makeWeekItem(overrides: Partial<AttendanceWeekListItem> = {}): AttendanceWeekListItem {
  return {
    weekId: '2025-03-06',
    week: { start: '2025-03-06', end: '2025-03-12' },
    source: 'ETIMEOFFICE',
    status: 'APPROVED',
    isSyncing: false,
    uploadId: 'upload-uuid-1',
    employeeCount: 2,
    totalRegularHours: 46,
    totalOvertimeHours: 6,
    unresolvedCodes: 0,
    pendingDecisions: 0,
    needsFixingDays: 0,
    lastSyncError: null,
    lastSyncAttemptAt: null,
    lastSyncedAt: null,
    staleNoticeAt: null,
    fileName: null,
    payrollStatus: 'NOT_GENERATED',
    payrollRunId: null,
    canPullNow: false,
    canReopen: true,
    hasEnded: true,
    ...overrides,
  }
}

describe('getAvailablePayrollWeeks', () => {
  it('returns weeks with their attendance statuses', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem(),
      makeWeekItem({ weekId: '2025-02-27', week: { start: '2025-02-27', end: '2025-03-05' }, uploadId: 'upload-uuid-2' }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result).toHaveLength(2)
    expect(result[0].weekId).toBe('2025-03-06')
    expect(result[0].weekStart).toEqual(WEEK_START)
    expect(result[0].weekEnd).toEqual(WEEK_END)
    expect(result[0].attendanceStatus).toBe('APPROVED')
    expect(result[0].source).toBe('ETIMEOFFICE')
    expect(result[0].payrollStatus).toBe('NOT_GENERATED')
    expect(result[0].matchedEmployeeCount).toBe(2)
    expect(result[0].canGenerate).toBe(true)
  })

  it('does not allow generating a week whose attendance is not approved', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ status: 'REVIEW' }),
      makeWeekItem({ weekId: '2025-02-27', status: 'SYNC_FAILED' }),
      makeWeekItem({ weekId: '2025-02-20', status: 'NO_DATA', source: null, uploadId: null }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result.map((w) => w.attendanceStatus)).toEqual(['REVIEW', 'SYNC_FAILED', 'NO_DATA'])
    expect(result.every((w) => w.canGenerate === false)).toBe(true)
    expect(result[0].payrollStatus).toBe('NOT_GENERATED')
  })

  it('does not allow generating an Excel-era week', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([makeWeekItem({ source: 'EXCEL', status: 'APPROVED' })])

    const result = await getAvailablePayrollWeeks()

    expect(result[0].source).toBe('EXCEL')
    expect(result[0].canGenerate).toBe(false)
  })

  it('marks weeks with approved payroll run as APPROVED', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ payrollStatus: 'APPROVED', payrollRunId: 'run-uuid-1' }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result[0].payrollStatus).toBe('APPROVED')
    expect(result[0].payrollRunId).toBe('run-uuid-1')
    expect(result[0].canGenerate).toBe(false)
  })

  it('does not allow generating a revised week either', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ payrollStatus: 'REVISED', payrollRunId: 'run-uuid-1' }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result[0].payrollStatus).toBe('REVISED')
    expect(result[0].canGenerate).toBe(false)
  })

  it('allows generating only the approved eTimeOffice week without payroll in a mixed list', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ weekId: '2025-03-13', status: 'REVIEW' }),
      makeWeekItem({ weekId: '2025-03-06', status: 'APPROVED' }),
      makeWeekItem({ weekId: '2025-02-27', source: 'EXCEL', status: 'APPROVED' }),
      makeWeekItem({ weekId: '2025-02-20', status: 'APPROVED', payrollStatus: 'APPROVED', payrollRunId: 'run-x' }),
      makeWeekItem({ weekId: '2025-02-13', status: 'NO_DATA', source: null, uploadId: null }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result.filter((w) => w.canGenerate).map((w) => w.weekId)).toEqual(['2025-03-06'])
  })

  it('treats a virtual week with no row as an eTimeOffice week that cannot be generated', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ status: 'NO_DATA', source: null, uploadId: null, employeeCount: 0 }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(result[0].source).toBe('ETIMEOFFICE')
    expect(result[0].attendanceStatus).toBe('NO_DATA')
    expect(result[0].canGenerate).toBe(false)
  })

  it('builds the week list from the attendance week list (one read) and keeps its totals', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([
      makeWeekItem({ totalRegularHours: 8, totalOvertimeHours: 1.25 }),
    ])

    const result = await getAvailablePayrollWeeks()

    expect(listAttendanceWeeks).toHaveBeenCalledTimes(1)
    // The payroll page shows no counts for weeks in review, so it asks for no review grids.
    expect(listAttendanceWeeks).toHaveBeenCalledWith(undefined, { includeReviewStats: false })
    expect(result[0].totalRegularHours).toBe(8)
    expect(result[0].totalOvertimeHours).toBe(1.25)
  })

  it('returns an empty list when there are no attendance weeks', async () => {
    vi.mocked(listAttendanceWeeks).mockResolvedValue([])

    await expect(getAvailablePayrollWeeks()).resolves.toEqual([])
  })

  it('propagates a failure of the attendance week list', async () => {
    vi.mocked(listAttendanceWeeks).mockRejectedValue(new Error('db down'))

    await expect(getAvailablePayrollWeeks()).rejects.toThrow('db down')
  })
})

// ─── US-12.26 / US-12.25: calculatePayroll ───────────────────────────────────

function makeWageHistory(hourlyRate = 100, weeklySalary = 4000) {
  return [{ hourlyRate, weeklySalary }]
}

/** An attendance record with the employee (and one wage row) joined, as calculatePayroll reads it. */
function makeRecordWithEmployee(opts: {
  id: string
  employeeDbId: string
  code: string
  date: string
  regular: number
  overtime?: number
  wageHistory?: Array<{ hourlyRate: number; weeklySalary: number }>
}) {
  return {
    ...makeRecord({
      id: opts.id,
      employeeId: opts.employeeDbId,
      attendanceDate: new Date(`${opts.date}T00:00:00.000Z`),
      regularHours: opts.regular as unknown as AttendanceRecord['regularHours'],
      overtimeHours: (opts.overtime ?? 0) as unknown as AttendanceRecord['overtimeHours'],
    }),
    employee: {
      id: opts.employeeDbId,
      employeeId: opts.code,
      employeeName: `Name ${opts.code}`,
      designation: 'Worker',
      designationShort: null,
      site: null,
      gPay: null,
      bankAccount: null,
      wageHistory: opts.wageHistory ?? makeWageHistory(),
    },
  }
}

describe('calculatePayroll', () => {
  beforeEach(() => {
    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([])
  })

  // US-12.26 AC3: payroll generation refuses a week that is not approved, even when called directly
  it('throws NO_ATTENDANCE_UPLOAD when the week has no attendance row, and reads nothing else', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({
      name: 'PayrollServiceError',
      code: 'NO_ATTENDANCE_UPLOAD',
    })
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('throws EXCEL_ERA_WEEK for an Excel-era week (C6) and reads no records', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(
      makeUpload({ source: 'EXCEL', status: 'READY', payrollWeekSource: 'SHEET_CONTENT' }),
    )

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('throws ATTENDANCE_NOT_APPROVED for a week in review and creates nothing', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'REVIEW', approvedAt: null }))

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })

    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
    expect(prisma.payrollRun.create).not.toHaveBeenCalled()
    expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
    expect(prisma.payrollRunEmployee.createMany).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('throws ATTENDANCE_NOT_APPROVED for a week whose sync failed', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'SYNC_FAILED' }))

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
  })

  it('throws NO_EMPLOYEES when an approved week has no attendance records', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([])

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'NO_EMPLOYEES' })
  })

  it('calculates pay from the approved records: 8.00 regular and 1.25 overtime', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecordWithEmployee({ id: 'r1', employeeDbId: 'emp-1', code: 'TPLGOAHLP001', date: '2025-03-06', regular: 8, overtime: 1.25 }),
    ] as never)

    const summary = await calculatePayroll(WEEK_START, WEEK_END)

    expect(summary.employees).toHaveLength(1)
    expect(summary.employees[0].regularHours).toBe(8)
    expect(summary.employees[0].overtimeHours).toBe(1.25)
    expect(summary.employees[0].regularPay).toBe(800)
    expect(summary.employees[0].overtimePay).toBe(125)
    expect(summary.employees[0].netPayable).toBe(925)
    expect(summary.totals.totalRegularHours).toBe(8)
    expect(summary.totals.totalOvertimeHours).toBe(1.25)
  })

  // US-12.25 AC1: a zero-hour employee gets no AttendanceRecord rows at approval, so no payroll row
  it('creates no payroll row for an employee with no attendance records (zero-hour employee)', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecordWithEmployee({ id: 'r1', employeeDbId: 'emp-1', code: 'TPLGOAHLP001', date: '2025-03-06', regular: 8 }),
      makeRecordWithEmployee({ id: 'r2', employeeDbId: 'emp-1', code: 'TPLGOAHLP001', date: '2025-03-07', regular: 8 }),
    ] as never)

    const summary = await calculatePayroll(WEEK_START, WEEK_END)

    // emp-zero (no records) is simply absent; emp-1 is the only row.
    expect(summary.employees.map((e) => e.employeeId)).toEqual(['emp-1'])
    expect(summary.employees[0].regularHours).toBe(16)
  })

  it('reads the records of the approved upload only, ordered by employee then date', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ id: 'upload-approved' }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecordWithEmployee({ id: 'r1', employeeDbId: 'emp-1', code: 'E1', date: '2025-03-06', regular: 8 }),
    ] as never)

    await calculatePayroll(WEEK_START, WEEK_END)

    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendanceUploadId: 'upload-approved' },
        orderBy: [{ employeeId: 'asc' }, { attendanceDate: 'asc' }],
      }),
    )
  })

  it('skips an employee without wage history and throws NO_EMPLOYEES when nobody has one', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecordWithEmployee({ id: 'r1', employeeDbId: 'emp-1', code: 'E1', date: '2025-03-06', regular: 8, wageHistory: [] }),
    ] as never)

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'NO_EMPLOYEES' })
  })

  it('applies approved adjustments only for employees in the week and nets them into pay', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecordWithEmployee({ id: 'r1', employeeDbId: 'emp-1', code: 'E1', date: '2025-03-06', regular: 8 }),
    ] as never)
    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([
      { employeeId: 'emp-1', appliedAmount: 500, payrollAdjustment: { adjustmentType: 'DEDUCTION' } },
      { employeeId: 'emp-1', appliedAmount: 200, payrollAdjustment: { adjustmentType: 'ADDITION' } },
    ] as never)

    const summary = await calculatePayroll(WEEK_START, WEEK_END)

    expect(prisma.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          approvalStatus: 'APPROVED',
          employeeId: { in: ['emp-1'] },
        }),
      }),
    )
    expect(summary.employees[0].additions).toBe(200)
    expect(summary.employees[0].deductions).toBe(500)
    expect(summary.employees[0].netPayable).toBe(800 + 200 - 500)
  })
})

// ─── US-06.6: approvePayroll ──────────────────────────────────────────────────

// approvePayroll runs in one interactive transaction, so the carry-forward of left-out
// employees' adjustments commits or rolls back with the approval. In these tests the
// transaction client is the same mock client.
function mockInteractiveTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[])) as never)
  vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([])
  // approvePayroll re-checks, inside its transaction and under the week row lock, that the week's
  // attendance is still the approved one the summary was calculated from.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([lockRow({ status: 'APPROVED' })] as never)
}

describe('approvePayroll', () => {
  it('creates PayrollRun with status APPROVED, revision 1, and employee records', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)

    const createdRun = makePayrollRun()
    const createdRevision = makeRevision()

    vi.mocked(prisma.payrollRun.create).mockResolvedValue(createdRun)
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)

    mockInteractiveTransaction()

    const summary = makeSummary()
    const result = await approvePayroll(summary)

    expect(result.payrollRunId).toBeTypeOf('string')
    expect(result.payrollRunId.length).toBe(36)
    expect(result.revisionNumber).toBe(1)
    expect(result.employeeCount).toBe(1)
  })

  it('stores correct totals on the run', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)

    let capturedRunData: Record<string, unknown> | null = null
    const createdRun = makePayrollRun({
      totalRegularPay: 40000 as unknown as PayrollRun['totalRegularPay'],
      totalOvertimePay: 5000 as unknown as PayrollRun['totalOvertimePay'],
      totalAdditions: 2000 as unknown as PayrollRun['totalAdditions'],
      totalDeductions: 3000 as unknown as PayrollRun['totalDeductions'],
      totalNetPayable: 44000 as unknown as PayrollRun['totalNetPayable'],
    })
    const createdRevision = makeRevision({
      totalNetPayable: 44000 as unknown as PayrollRevision['totalNetPayable'],
    })

    vi.mocked(prisma.payrollRun.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
      capturedRunData = data
      return createdRun
    }) as never)
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 15 } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)

    mockInteractiveTransaction()

    const summary = makeSummary({
      employees: Array(15).fill(null).map((_, i) => ({
        employeeId: `emp-${i}`,
        employeeCode: `EMP-${String(i).padStart(3, '0')}`,
        employeeName: `Employee ${i}`,
        designation: 'Worker',
        designationShort: null,
        site: null,
        gPay: null,
        bankAccount: null,
        weeklySalaryUsed: 3200,
        hourlyRateUsed: 80,
        regularHours: 46,
        overtimeHours: 0,
        regularPay: 40000 / 15,
        overtimePay: 5000 / 15,
        grossPay: 45000 / 15,
        additions: 2000 / 15,
        deductions: 3000 / 15,
        netPayable: 44000 / 15,
      })),
      totals: {
        totalRegularHours: 690,
        totalOvertimeHours: 0,
        totalRegularPay: 40000,
        totalOvertimePay: 5000,
        totalAdditions: 2000,
        totalDeductions: 3000,
        totalNetPayable: 44000,
      },
    })

    const result = await approvePayroll(summary)

    expect(capturedRunData?.totalNetPayable).toBe(44000)
    expect(capturedRunData?.status).toBe('APPROVED')
    // The run carries the unique approved-week key.
    expect((capturedRunData as Record<string, unknown> | null)?.approvedWeekStart).toEqual(WEEK_START)
    expect(result.totalNetPayable).toBe(44000)
    expect(result.employeeCount).toBe(15)
  })

  it('throws PAYROLL_ALREADY_EXISTS when run already approved for the week', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(makePayrollRun())

    await expect(approvePayroll(makeSummary())).rejects.toThrow(PayrollServiceError)
    await expect(approvePayroll(makeSummary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
  })

  it('runs as one interactive transaction with the 30 second timeout', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.payrollRun.create).mockResolvedValue(makePayrollRun())
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(makeRevision())
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)
    mockInteractiveTransaction()

    await approvePayroll(makeSummary())

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })

  // Attendance re-check inside the approval (a reopened week, an Excel week, a missing week)
  describe('attendance re-check inside the approval', () => {
    beforeEach(() => {
      vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
      mockInteractiveTransaction()
    })

    async function expectRefused(upload: Partial<AttendanceUpload> | null) {
      vi.mocked(prisma.$queryRaw).mockResolvedValue((upload === null ? [] : [lockRow(upload)]) as never)

      await expect(approvePayroll(makeSummary())).rejects.toMatchObject({
        name: 'PayrollServiceError',
        code: 'ATTENDANCE_NOT_APPROVED',
      })

      // Nothing is created or carried forward when the check fails.
      expect(prisma.payrollRun.create).not.toHaveBeenCalled()
      expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
      expect(prisma.payrollRunEmployee.createMany).not.toHaveBeenCalled()
      expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
      expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
      expect(skipAdjustmentApplication).not.toHaveBeenCalled()
    }

    it('refuses when the week was reopened after the calculation (status back to REVIEW)', async () => {
      await expectRefused({ status: 'REVIEW', approvedAt: null })
    })

    it('refuses when the attendance row is gone', async () => {
      await expectRefused(null)
    })

    it('refuses an Excel-era week', async () => {
      await expectRefused({ source: 'EXCEL', status: 'READY', payrollWeekSource: 'SHEET_CONTENT' })
    })

    it('refuses a week whose sync failed', async () => {
      await expectRefused({ status: 'SYNC_FAILED' })
    })

    it('locks the active attendance row for exactly the summary week', async () => {
      vi.mocked(prisma.payrollRun.create).mockResolvedValue(makePayrollRun())
      vi.mocked(prisma.payrollRevision.create).mockResolvedValue(makeRevision())
      vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
      vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)

      await approvePayroll(makeSummary())

      // lockWeekRow is a tagged-template raw query: (strings, ...values), the value being the week start.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(vi.mocked(prisma.$queryRaw).mock.calls[0].slice(1)).toEqual([WEEK_START])
    })
  })

  // E2E-38: a left-out employee's pending deduction is not applied and moves to the next week
  describe('carry-forward of left-out employees', () => {
    type App = { id: string; employeeId: string; approvalStatus: string; payrollRunId: string | null; adjStatus: string }

    const apps: App[] = [
      { id: 'app-included', employeeId: 'emp-uuid-1', approvalStatus: 'PENDING', payrollRunId: null, adjStatus: 'ACTIVE' },
      { id: 'app-left-pending', employeeId: 'emp-left-out', approvalStatus: 'PENDING', payrollRunId: null, adjStatus: 'ACTIVE' },
      { id: 'app-left-approved', employeeId: 'emp-left-out', approvalStatus: 'APPROVED', payrollRunId: null, adjStatus: 'ACTIVE' },
      { id: 'app-left-rejected', employeeId: 'emp-left-out', approvalStatus: 'REJECTED', payrollRunId: null, adjStatus: 'ACTIVE' },
      { id: 'app-left-linked', employeeId: 'emp-left-out', approvalStatus: 'APPROVED', payrollRunId: 'older-run', adjStatus: 'ACTIVE' },
      { id: 'app-left-cancelled', employeeId: 'emp-left-out', approvalStatus: 'PENDING', payrollRunId: null, adjStatus: 'CANCELLED' },
    ]

    /** A fake table that honours the where clause approvePayroll actually sends. */
    function fakeApplicationTable() {
      vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockImplementation((async (args: {
        where: {
          payrollRunId: null
          approvalStatus: { in: string[] }
          employeeId: { notIn: string[] }
          payrollAdjustment: { status: { not: string } }
        }
      }) => {
        const w = args.where
        return apps
          .filter(
            (a) =>
              a.payrollRunId === w.payrollRunId &&
              w.approvalStatus.in.includes(a.approvalStatus) &&
              !w.employeeId.notIn.includes(a.employeeId) &&
              a.adjStatus !== w.payrollAdjustment.status.not,
          )
          .map((a) => ({ id: a.id }))
      }) as never)
    }

    beforeEach(() => {
      vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.payrollRun.create).mockResolvedValue(makePayrollRun())
      vi.mocked(prisma.payrollRevision.create).mockResolvedValue(makeRevision())
      vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
      vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)
      mockInteractiveTransaction()
      fakeApplicationTable()
    })

    it('skips every unlinked PENDING or APPROVED application of an employee who is left out', async () => {
      await approvePayroll(makeSummary()) // only emp-uuid-1 is in the payroll

      const skipped = vi.mocked(skipAdjustmentApplication).mock.calls.map((c) => c[0])
      expect(skipped.sort()).toEqual(['app-left-approved', 'app-left-pending'])
    })

    it('does not skip the included employee\'s applications, or rejected, already linked or cancelled ones', async () => {
      await approvePayroll(makeSummary())

      const skipped = vi.mocked(skipAdjustmentApplication).mock.calls.map((c) => c[0])
      expect(skipped).not.toContain('app-included')
      expect(skipped).not.toContain('app-left-rejected')
      expect(skipped).not.toContain('app-left-linked')
      expect(skipped).not.toContain('app-left-cancelled')
    })

    it('queries only this week\'s unlinked applications of employees not in the payroll', async () => {
      await approvePayroll(makeSummary())

      expect(prisma.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({
        where: {
          payrollWeekStartDate: WEEK_START,
          payrollRunId: null,
          approvalStatus: { in: ['PENDING', 'APPROVED'] },
          employeeId: { notIn: ['emp-uuid-1'] },
          payrollAdjustment: { status: { not: 'CANCELLED' } },
        },
        select: { id: true },
        // the skips lock their adjustments' rows, in adjustment id order
        orderBy: [{ payrollAdjustmentId: 'asc' }, { id: 'asc' }],
      })
    })

    it('runs the skip inside the same transaction client, before the run is created and the rest are linked', async () => {
      await approvePayroll(makeSummary())

      // Same client as the transaction (the mock passes `prisma` itself as `tx`).
      for (const call of vi.mocked(skipAdjustmentApplication).mock.calls) {
        expect(call[1]).toBe(prisma)
      }
      const lastSkip = Math.max(...vi.mocked(skipAdjustmentApplication).mock.invocationCallOrder)
      const runCreate = vi.mocked(prisma.payrollRun.create).mock.invocationCallOrder[0]
      const link = vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mock.invocationCallOrder[0]
      expect(lastSkip).toBeLessThan(runCreate)
      expect(lastSkip).toBeLessThan(link)
    })

    it('skips nothing when everyone with an application is in the payroll', async () => {
      const summary = makeSummary()
      summary.employees.push({ ...summary.employees[0], employeeId: 'emp-left-out', employeeCode: 'EMP-002' })

      await approvePayroll(summary)

      expect(skipAdjustmentApplication).not.toHaveBeenCalled()
    })

    it('still carries forward when the left-out employee is left out again (same step each approval)', async () => {
      await approvePayroll(makeSummary())
      await approvePayroll(makeSummary())

      // Two approvals, two left-out applications each: the step runs every time.
      expect(skipAdjustmentApplication).toHaveBeenCalledTimes(4)
    })

    it('aborts the approval when a carry-forward fails: the run is never created', async () => {
      vi.mocked(skipAdjustmentApplication).mockRejectedValueOnce(new Error('carry-forward failed'))

      await expect(approvePayroll(makeSummary())).rejects.toThrow('carry-forward failed')

      expect(prisma.payrollRun.create).not.toHaveBeenCalled()
      expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
      expect(prisma.payrollRunEmployee.createMany).not.toHaveBeenCalled()
    })

    it('does not carry anything forward when payroll already exists for the week', async () => {
      vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(makePayrollRun())

      await expect(approvePayroll(makeSummary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(skipAdjustmentApplication).not.toHaveBeenCalled()
    })
  })
})
