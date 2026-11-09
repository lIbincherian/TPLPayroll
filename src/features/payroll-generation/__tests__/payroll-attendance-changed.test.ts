import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceRecord, AttendanceUpload } from '@prisma/client'

// Fix round, item 4: a payroll summary remembers the approval time of the attendance it was built
// from. approvePayroll locks the week row and refuses (ATTENDANCE_CHANGED) when the week was
// reopened and approved again, possibly with different hours, since the summary was calculated.

vi.mock('@/lib/prisma', () => ({
  default: {
    attendanceUpload: { findFirst: vi.fn(), findMany: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn() },
    payrollRevision: { create: vi.fn() },
    payrollRun: { findFirst: vi.fn(), create: vi.fn() },
    payrollRunEmployee: { createMany: vi.fn() },
    payrollAdjustmentApplication: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}))
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  getAdjustmentsForWeekReview: vi.fn(),
  skipAdjustmentApplication: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/week-list.service', () => ({ listAttendanceWeeks: vi.fn() }))
vi.mock('@/features/attendance-sync/services/week-approval.service', () => ({ getApprovalSummary: vi.fn() }))

import prisma from '@/lib/prisma'
import { skipAdjustmentApplication } from '@/features/payroll-adjustments/services/adjustment.service'
import { approvePayroll, calculatePayroll } from '@/features/payroll-generation/services/payroll.service'
import type { PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')
const APPROVED_AT = new Date('2025-03-14T09:30:15.123Z')

const upload = (overrides: Partial<AttendanceUpload> = {}) =>
  ({
    id: 'upload-1',
    source: 'ETIMEOFFICE',
    status: 'APPROVED',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    isActiveForPayrollWeek: true,
    syncLockedAt: null,
    approvedAt: APPROVED_AT,
    ...overrides,
  }) as AttendanceUpload

const lockRow = (overrides: Partial<AttendanceUpload> = {}) => {
  const u = upload(overrides)
  return {
    id: u.id,
    source: u.source,
    status: u.status,
    syncLockedAt: u.syncLockedAt,
    approvedAt: u.approvedAt,
    payrollWeekStartDate: u.payrollWeekStartDate,
  }
}

function summary(overrides: Partial<PayrollSummary> = {}): PayrollSummary {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    attendanceApprovedAt: APPROVED_AT,
    employees: [
      {
        employeeId: 'emp-1',
        employeeCode: 'EMP-001',
        employeeName: 'Lakshmi',
        designation: 'Guard',
        designationShort: null,
        site: null,
        gPay: null,
        bankAccount: null,
        weeklySalaryUsed: 2500,
        hourlyRateUsed: 62.5,
        regularHours: 8,
        overtimeHours: 0,
        regularPay: 500,
        overtimePay: 0,
        grossPay: 500,
        additions: 0,
        deductions: 0,
        netPayable: 500,
      },
    ],
    totals: {
      totalRegularHours: 8,
      totalOvertimeHours: 0,
      totalRegularPay: 500,
      totalOvertimePay: 0,
      totalAdditions: 0,
      totalDeductions: 0,
      totalNetPayable: 500,
    },
    ...overrides,
  }
}

function record(): unknown {
  return {
    id: 'r1',
    attendanceUploadId: 'upload-1',
    employeeId: 'emp-1',
    attendanceDate: new Date('2025-03-06T00:00:00.000Z'),
    regularHours: 8 as unknown as AttendanceRecord['regularHours'],
    overtimeHours: 0 as unknown as AttendanceRecord['overtimeHours'],
    employee: {
      id: 'emp-1',
      employeeId: 'EMP-001',
      employeeName: 'Lakshmi',
      designation: 'Guard',
      designationShort: null,
      site: null,
      gPay: null,
      bankAccount: null,
      wageHistory: [{ hourlyRate: 62.5, weeklySalary: 2500, effectiveFrom: new Date('2025-01-01') }],
    },
  }
}

const order = (fn: unknown): number => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([])
  vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)
  vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.payrollRun.create).mockResolvedValue({} as never)
  vi.mocked(prisma.payrollRevision.create).mockResolvedValue({} as never)
  vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[])) as never)
  vi.mocked(prisma.$queryRaw).mockResolvedValue([lockRow()] as never)
})

function expectNothingCreated() {
  expect(prisma.payrollRun.create).not.toHaveBeenCalled()
  expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
  expect(prisma.payrollRunEmployee.createMany).not.toHaveBeenCalled()
  expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
  expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  expect(skipAdjustmentApplication).not.toHaveBeenCalled()
}

describe('calculatePayroll returns the approval time of the attendance it used', () => {
  it('attendanceApprovedAt is the upload approvedAt, as the same instant', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(upload())
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([record()] as never)

    const result = await calculatePayroll(WEEK_START, WEEK_END)

    expect(result.attendanceApprovedAt).toBeInstanceOf(Date)
    expect(result.attendanceApprovedAt.getTime()).toBe(APPROVED_AT.getTime())
  })

  it('a different approval time gives a different stamp', async () => {
    const later = new Date('2025-03-15T10:00:00.000Z')
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(upload({ approvedAt: later }))
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([record()] as never)

    expect((await calculatePayroll(WEEK_START, WEEK_END)).attendanceApprovedAt.getTime()).toBe(later.getTime())
  })

  it('an APPROVED week with no approval time is not approved (ATTENDANCE_NOT_APPROVED) and reads no records', async () => {
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(upload({ approvedAt: null }))

    await expect(calculatePayroll(WEEK_START, WEEK_END)).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
  })
})

describe('approvePayroll refuses a summary built from different attendance', () => {
  it('passes when the locked week was approved at the same instant as the summary says', async () => {
    await expect(approvePayroll(summary())).resolves.toMatchObject({ revisionNumber: 1, employeeCount: 1 })

    expect(prisma.payrollRun.create).toHaveBeenCalledTimes(1)
    expect(prisma.payrollRunEmployee.createMany).toHaveBeenCalledTimes(1)
  })

  it('passes when the summary carries the approval time as an ISO string (it travelled through the browser)', async () => {
    const wire = summary({ attendanceApprovedAt: APPROVED_AT.toISOString() as unknown as Date })

    await expect(approvePayroll(wire)).resolves.toMatchObject({ revisionNumber: 1 })
  })

  it('ATTENDANCE_CHANGED when the week was reopened and approved again (a later approval time)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([lockRow({ approvedAt: new Date('2025-03-15T08:00:00.000Z') })] as never)

    const error = await approvePayroll(summary()).catch((e: { code: string; message: string; name: string }) => e)

    expect(error).toMatchObject({
      name: 'PayrollServiceError',
      code: 'ATTENDANCE_CHANGED',
      message: 'Attendance for this week changed after this summary was calculated. Go back and recalculate.',
    })
    expectNothingCreated()
  })

  it('ATTENDANCE_CHANGED for a difference of a single millisecond', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([lockRow({ approvedAt: new Date(APPROVED_AT.getTime() + 1) })] as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'ATTENDANCE_CHANGED' })
    expectNothingCreated()
  })

  it('ATTENDANCE_CHANGED when the locked week is APPROVED but has no approval time', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([lockRow({ approvedAt: null })] as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'ATTENDANCE_CHANGED' })
    expectNothingCreated()
  })

  it('ATTENDANCE_CHANGED when the summary has no usable approval time', async () => {
    await expect(approvePayroll(summary({ attendanceApprovedAt: undefined as unknown as Date }))).rejects.toMatchObject({
      code: 'ATTENDANCE_CHANGED',
    })
    expectNothingCreated()
  })

  it.each([
    ['REVIEW (reopened)', { status: 'REVIEW', approvedAt: null }],
    ['an Excel-era week', { source: 'EXCEL', status: 'READY' }],
    ['SYNC_FAILED', { status: 'SYNC_FAILED' }],
  ])('stays ATTENDANCE_NOT_APPROVED for %s, even when the approval time differs too', async (_label, over) => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      lockRow({ ...over, approvedAt: (over as { approvedAt?: Date | null }).approvedAt ?? new Date('2025-03-20T00:00:00Z') }),
    ] as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
    expectNothingCreated()
  })

  it('stays ATTENDANCE_NOT_APPROVED when the week row is missing', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
    expectNothingCreated()
  })

  it('takes the row lock for the summary week before it creates or carries forward anything', async () => {
    await approvePayroll(summary())

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prisma.$queryRaw).mock.calls[0].slice(1)).toEqual([WEEK_START])
    expect(order(prisma.$queryRaw)).toBeLessThan(order(prisma.payrollAdjustmentApplication.findMany))
    expect(order(prisma.$queryRaw)).toBeLessThan(order(prisma.payrollRun.create))
  })

  it('does not even open a transaction for a week that already has approved payroll', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue({ id: 'run-1' } as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })
})
