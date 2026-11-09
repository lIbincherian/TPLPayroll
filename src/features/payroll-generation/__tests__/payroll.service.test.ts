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
  },
}))

// ─── Mock F05 adjustment service ──────────────────────────────────────────────
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  getAdjustmentsForWeekReview: vi.fn(),
  skipAdjustmentApplication: vi.fn(),
}))

// ─── Mock F12 attendance services (the payroll week list and readiness build on them) ─
vi.mock('@/features/attendance-sync/services/week-list.service', () => ({
  listAttendanceWeeks: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/week-approval.service', () => ({
  getApprovalSummary: vi.fn(),
}))

import prisma from '@/lib/prisma'
import { getAdjustmentsForWeekReview } from '@/features/payroll-adjustments/services/adjustment.service'
import { listAttendanceWeeks } from '@/features/attendance-sync/services/week-list.service'
import { getApprovalSummary } from '@/features/attendance-sync/services/week-approval.service'
import type { AttendanceWeekListItem } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  calculateRegularPay,
  calculateOvertimePay,
  calculateNetPayable,
  getAvailablePayrollWeeks,
  checkAttendanceReadiness,
  getPendingAdjustmentsForWeek,
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
    ...overrides,
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
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'APPROVED' }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecord({ employeeId: 'emp-1', regularHours: 8 as unknown as AttendanceRecord['regularHours'], overtimeHours: 0 as unknown as AttendanceRecord['overtimeHours'] }),
      makeRecord({ id: 'rec-2', employeeId: 'emp-2', regularHours: 6 as unknown as AttendanceRecord['regularHours'], overtimeHours: 2 as unknown as AttendanceRecord['overtimeHours'] }),
    ])
    vi.mocked(getApprovalSummary).mockResolvedValue({ leftOut: [{ employeeId: 'emp-3' }] } as never)

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
})

// ─── US-06.6: approvePayroll ──────────────────────────────────────────────────

// approvePayroll runs in one interactive transaction, so the carry-forward of left-out
// employees' adjustments commits or rolls back with the approval. In these tests the
// transaction client is the same mock client.
function mockInteractiveTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[])) as never)
  vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([])
}

describe('approvePayroll', () => {
  it('creates PayrollRun with status APPROVED, revision 1, and employee records', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)

    const createdRun = makePayrollRun()
    const createdRevision = makeRevision()

    vi.mocked(prisma.payrollRun.create).mockResolvedValue(createdRun)
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as any)

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

    vi.mocked(prisma.payrollRun.create).mockImplementation(async ({ data }: any) => {
      capturedRunData = data
      return createdRun
    })
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 15 } as any)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as any)

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
    expect(result.totalNetPayable).toBe(44000)
    expect(result.employeeCount).toBe(15)
  })

  it('throws PAYROLL_ALREADY_EXISTS when run already approved for the week', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(makePayrollRun())

    await expect(approvePayroll(makeSummary())).rejects.toThrow(PayrollServiceError)
    await expect(approvePayroll(makeSummary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
  })
})
