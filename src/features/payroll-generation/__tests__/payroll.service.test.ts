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
}))

import prisma from '@/lib/prisma'
import { plainPromiseMock } from '@/__tests__/helpers/plain-promise-mock'
import { getAdjustmentsForWeekReview } from '@/features/payroll-adjustments/services/adjustment.service'
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
    fileName: 'attendance.xlsx',
    fileType: 'xlsx',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    payrollWeekSource: 'SHEET_CONTENT',
    status: 'READY',
    isActiveForPayrollWeek: true,
    uploadedBy: null,
    uploadedAt: new Date('2025-03-14'),
    sourceStorageKey: 'attendance/attendance.xlsx',
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
    beforeNoonIn: null,
    beforeNoonOut: null,
    afternoonIn: null,
    afternoonOut: null,
    overtimeIn: null,
    overtimeOut: null,
    sourceSheetName: 'Sheet1',
    sourceEmployeeBlockIndex: 0,
    verificationDecision: null,
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
  it('returns ready:true with stats when attendance is clean', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'READY' }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      makeRecord({ employeeId: 'emp-1', regularHours: 8 as unknown as AttendanceRecord['regularHours'], overtimeHours: 0 as unknown as AttendanceRecord['overtimeHours'] }),
      makeRecord({ id: 'rec-2', employeeId: 'emp-2', regularHours: 6 as unknown as AttendanceRecord['regularHours'], overtimeHours: 2 as unknown as AttendanceRecord['overtimeHours'] }),
    ])

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(true)
    if (result.ready) {
      expect(result.matchedEmployeeCount).toBe(2)
      expect(result.totalRegularHours).toBe(14)
      expect(result.totalOvertimeHours).toBe(2)
    }
  })

  it('returns UNRESOLVED_ERRORS when attendance status is ERRORS', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(makeUpload({ status: 'ERRORS' }))

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('UNRESOLVED_ERRORS')
    }
  })

  it('returns NO_UPLOAD when no active upload exists', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

    const result = await checkAttendanceReadiness(WEEK_START, WEEK_END)

    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.reason).toBe('NO_UPLOAD')
    }
  })
})

// ─── US-06.3: getPendingAdjustmentsForWeek ────────────────────────────────────

describe('getPendingAdjustmentsForWeek', () => {
  it('returns 3 pending applications for the week', async () => {
    const pendingItems = [
      { applicationId: 'app-1', adjustmentType: 'DEDUCTION', appliedAmount: 500 },
      { applicationId: 'app-2', adjustmentType: 'ADDITION', appliedAmount: 200 },
      { applicationId: 'app-3', adjustmentType: 'DEDUCTION', appliedAmount: 300 },
    ]
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue(pendingItems as never)

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toHaveLength(3)
    expect(vi.mocked(getAdjustmentsForWeekReview)).toHaveBeenCalledWith(WEEK_START)
  })

  it('returns empty array when no pending adjustments', async () => {
    vi.mocked(getAdjustmentsForWeekReview).mockResolvedValue([])

    const result = await getPendingAdjustmentsForWeek(WEEK_START, WEEK_END)

    expect(result).toHaveLength(0)
  })
})

// ─── US-06.1: getAvailablePayrollWeeks ───────────────────────────────────────

describe('getAvailablePayrollWeeks', () => {
  it('returns weeks with their attendance statuses', async () => {
    const week2Start = new Date('2025-02-27T00:00:00.000Z')
    const week2End = new Date('2025-03-05T00:00:00.000Z')

    vi.mocked(prisma.attendanceUpload.findMany).mockResolvedValue([
      makeUpload({ payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, status: 'READY' }),
      makeUpload({
        id: 'upload-uuid-2',
        payrollWeekStartDate: week2Start,
        payrollWeekEndDate: week2End,
        status: 'READY',
      }),
    ])
    vi.mocked(prisma.payrollRun.findMany).mockResolvedValue([])
    vi.mocked(prisma.attendanceRecord.groupBy)
      .mockResolvedValueOnce([
        { attendanceUploadId: 'upload-uuid-1', employeeId: 'emp-1' },
        { attendanceUploadId: 'upload-uuid-2', employeeId: 'emp-2' },
      ] as never)
      .mockResolvedValueOnce([
        { attendanceUploadId: 'upload-uuid-1', _sum: { regularHours: 46, overtimeHours: 6 } },
        { attendanceUploadId: 'upload-uuid-2', _sum: { regularHours: 40, overtimeHours: 0 } },
      ] as never)

    const result = await getAvailablePayrollWeeks()

    expect(result).toHaveLength(2)
    expect(result[0].weekId).toBe('2025-03-06')
    expect(result[0].attendanceStatus).toBe('READY')
    expect(result[0].payrollStatus).toBe('NOT_GENERATED')
  })

  it('marks weeks with blocking errors as ERRORS', async () => {
    vi.mocked(prisma.attendanceUpload.findMany).mockResolvedValue([
      makeUpload({ status: 'ERRORS' }),
    ])
    vi.mocked(prisma.payrollRun.findMany).mockResolvedValue([])
    vi.mocked(prisma.attendanceRecord.groupBy)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)

    const result = await getAvailablePayrollWeeks()

    expect(result[0].attendanceStatus).toBe('ERRORS')
    expect(result[0].payrollStatus).toBe('NOT_GENERATED')
  })

  it('marks weeks with approved payroll run as APPROVED', async () => {
    vi.mocked(prisma.attendanceUpload.findMany).mockResolvedValue([makeUpload({ status: 'READY' })])
    vi.mocked(prisma.payrollRun.findMany).mockResolvedValue([
      makePayrollRun({ payrollWeekStartDate: WEEK_START }),
    ])
    vi.mocked(prisma.attendanceRecord.groupBy)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)

    const result = await getAvailablePayrollWeeks()

    expect(result[0].payrollStatus).toBe('APPROVED')
    expect(result[0].payrollRunId).toBe('run-uuid-1')
  })
})

// ─── US-06.6: approvePayroll ──────────────────────────────────────────────────

describe('approvePayroll', () => {
  it('creates PayrollRun with status APPROVED, revision 1, and employee records', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)

    const createdRun = makePayrollRun()
    const createdRevision = makeRevision()

    vi.mocked(prisma.payrollRun.create).mockResolvedValue(createdRun)
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 })

    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    const summary = makeSummary()
    const result = await approvePayroll(summary)

    expect(result.payrollRunId).toBeTypeOf('string')
    expect(result.payrollRunId.length).toBe(36)
    expect(result.revisionNumber).toBe(1)
    expect(result.employeeCount).toBe(1)
  })

  it('stores correct totals on the run', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)

    // Assigned inside the mock below; the cast stops TS narrowing the initial null to `never`.
    let capturedRunData = null as Record<string, unknown> | null
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

    plainPromiseMock(prisma.payrollRun.create).mockImplementation(async (args) => {
      capturedRunData = (args as { data: Record<string, unknown> }).data
      return createdRun
    })
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(createdRevision)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 15 })
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 })

    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

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
