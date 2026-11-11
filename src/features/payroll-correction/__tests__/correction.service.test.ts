import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PayrollRun, PayrollRevision, PayrollRunEmployee, PayrollAdjustmentApplication } from '@prisma/client'

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    payrollRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    payrollRevision: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    payrollRunEmployee: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    payrollAdjustmentApplication: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    attendanceUpload: {
      findFirst: vi.fn(),
    },
    attendanceRecord: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

// ─── Mock payroll calc helpers ────────────────────────────────────────────────
vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  calculateRegularPay: vi.fn((hours: number[], rate: number) => {
    const totalHours = hours.reduce((s: number, h: number) => s + h, 0)
    return { regularHours: totalHours, regularPay: totalHours * rate }
  }),
  calculateOvertimePay: vi.fn((hours: number[], rate: number) => {
    const totalHours = hours.reduce((s: number, h: number) => s + h, 0)
    return { overtimeHours: totalHours, overtimePay: totalHours * rate }
  }),
  calculateNetPayable: vi.fn((gross: number, add: number, ded: number) => gross + add - ded),
}))

import prisma from '@/lib/prisma'
import {
  initiateCorrection,
  reverseAdjustmentApplication,
  approveSkippedAdjustment,
  recalculateAndCreateRevision,
  approveRevision,
  getRevisionHistory,
  prepareAdjustmentsForCorrection,
} from '@/features/payroll-correction/services/correction.service'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')

function makePayrollRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run-uuid-1',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    status: 'APPROVED',
    currentRevisionNumber: 1,
    totalRegularPay: 7075 as unknown as PayrollRun['totalRegularPay'],
    totalOvertimePay: 375 as unknown as PayrollRun['totalOvertimePay'],
    totalAdditions: 0 as unknown as PayrollRun['totalAdditions'],
    totalDeductions: 500 as unknown as PayrollRun['totalDeductions'],
    totalNetPayable: 6950 as unknown as PayrollRun['totalNetPayable'],
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
    totalRegularPay: 7075 as unknown as PayrollRevision['totalRegularPay'],
    totalOvertimePay: 375 as unknown as PayrollRevision['totalOvertimePay'],
    totalAdditions: 0 as unknown as PayrollRevision['totalAdditions'],
    totalDeductions: 500 as unknown as PayrollRevision['totalDeductions'],
    totalNetPayable: 6950 as unknown as PayrollRevision['totalNetPayable'],
    generatedBy: null,
    approvedBy: null,
    generatedAt: new Date('2025-03-14'),
    approvedAt: new Date('2025-03-14'),
    invoicesGeneratedAt: null,
    isCurrent: true,
    ...overrides,
  }
}

function makeRunEmployee(overrides: Partial<PayrollRunEmployee> & { employee?: { employeeId: string; employeeName: string } } = {}) {
  const { employee, ...rest } = overrides
  return {
    id: 'pre-uuid-1',
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'revision-uuid-1',
    employeeId: 'emp-uuid-1',
    weeklySalaryUsed: 2500 as unknown as PayrollRunEmployee['weeklySalaryUsed'],
    hourlyRateUsed: 62.5 as unknown as PayrollRunEmployee['hourlyRateUsed'],
    regularHours: 46 as unknown as PayrollRunEmployee['regularHours'],
    overtimeHours: 6 as unknown as PayrollRunEmployee['overtimeHours'],
    regularPay: 2875 as unknown as PayrollRunEmployee['regularPay'],
    overtimePay: 375 as unknown as PayrollRunEmployee['overtimePay'],
    additions: 0 as unknown as PayrollRunEmployee['additions'],
    deductions: 500 as unknown as PayrollRunEmployee['deductions'],
    netPayable: 2750 as unknown as PayrollRunEmployee['netPayable'],
    employee: employee ?? { employeeId: 'EMP-001', employeeName: 'Kavitha Rajan' },
    ...rest,
  }
}

function makeAdjApplication(overrides: Partial<PayrollAdjustmentApplication> = {}) {
  return {
    id: 'app-uuid-1',
    payrollAdjustmentId: 'adj-uuid-1',
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'revision-uuid-1',
    employeeId: 'emp-uuid-1',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    appliedAmount: 500 as unknown as PayrollAdjustmentApplication['appliedAmount'],
    approvalStatus: 'APPROVED',
    approvedBy: null,
    approvedAt: new Date('2025-03-14'),
    appliedAt: new Date('2025-03-14'),
    skippedAt: null,
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── US-08.1: Initiate payroll correction ────────────────────────────────────

describe('initiateCorrection', () => {
  it('loads current revision data for an approved payroll run', async () => {
    const run = makePayrollRun()
    const revision = makeRevision()
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
      ...run,
      revisions: [revision],
    } as never)
    vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
      makeRunEmployee(),
    ] as never)
    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([
      {
        ...makeAdjApplication(),
        payrollAdjustment: { adjustmentType: 'DEDUCTION', amount: 500, reason: 'Advance recovery' },
        employee: { employeeName: 'Kavitha Rajan', employeeId: 'EMP-001' },
      },
    ] as never)

    const result = await initiateCorrection('run-uuid-1')

    expect(result.payrollRunId).toBe('run-uuid-1')
    expect(result.revisionNumber).toBe(1)
    expect(result.employees).toHaveLength(1)
    expect(result.employees[0].employeeName).toBe('Kavitha Rajan')
    expect(result.adjustmentApplications).toHaveLength(1)
    expect(result.totals.totalNetPayable).toBe(6950)
  })

  it('throws CANNOT_CORRECT_UNAPPROVED_PAYROLL for DRAFT payroll', async () => {
    const run = makePayrollRun({ status: 'DRAFT' })
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
      ...run,
      revisions: [],
    } as never)

    await expect(initiateCorrection('run-uuid-1')).rejects.toThrow(CorrectionServiceError)
    await expect(initiateCorrection('run-uuid-1')).rejects.toMatchObject({
      code: 'CANNOT_CORRECT_UNAPPROVED_PAYROLL',
    })
  })
})

// ─── US-08.2: Modify adjustments in correction ──────────────────────────────

describe('reverseAdjustmentApplication', () => {
  it('marks an approved application as reversed', async () => {
    const app = makeAdjApplication({ approvalStatus: 'APPROVED', isReversed: false })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(app as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      isReversed: true,
    } as never)

    const result = await reverseAdjustmentApplication('app-uuid-1')

    expect(result.isReversed).toBe(true)
    expect(vi.mocked(prisma.payrollAdjustmentApplication.update)).toHaveBeenCalledWith({
      where: { id: 'app-uuid-1' },
      data: { isReversed: true },
    })
  })

  it('throws ALREADY_REVERSED for already-reversed applications', async () => {
    const app = makeAdjApplication({ isReversed: true })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(app as never)

    await expect(reverseAdjustmentApplication('app-uuid-1')).rejects.toMatchObject({
      code: 'ALREADY_REVERSED',
    })
  })
})

describe('approveSkippedAdjustment', () => {
  it('approves a previously skipped application', async () => {
    const app = makeAdjApplication({ approvalStatus: 'SKIPPED', isReversed: false })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(app as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)

    const result = await approveSkippedAdjustment('app-uuid-1')

    expect(result.approvalStatus).toBe('APPROVED')
    expect(vi.mocked(prisma.payrollAdjustmentApplication.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'app-uuid-1' },
        data: expect.objectContaining({ approvalStatus: 'APPROVED' }),
      }),
    )
  })

  it('throws CANNOT_APPROVE_NON_SKIPPED for non-skipped applications', async () => {
    const app = makeAdjApplication({ approvalStatus: 'APPROVED' })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(app as never)

    await expect(approveSkippedAdjustment('app-uuid-1')).rejects.toMatchObject({
      code: 'CANNOT_APPROVE_NON_SKIPPED',
    })
  })
})

// ─── US-08.3: Recalculate and create new revision ───────────────────────────

describe('recalculateAndCreateRevision', () => {
  function setupRecalculateMocks() {
    const run = makePayrollRun()
    const revision = makeRevision()

    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
      ...run,
      revisions: [revision],
    } as never)

    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({
      id: 'upload-uuid-1',
      status: 'READY',
      isActiveForPayrollWeek: true,
    } as never)

    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      {
        id: 'rec-1',
        attendanceUploadId: 'upload-uuid-1',
        employeeId: 'emp-uuid-1',
        attendanceDate: WEEK_START,
        regularHours: 8,
        overtimeHours: 2,
        employee: {
          id: 'emp-uuid-1',
          employeeId: 'EMP-001',
          employeeName: 'Kavitha Rajan',
          designation: 'Guard',
          designationShort: 'Guard',
          site: 'North Gate',
          gPay: '9876543210',
          bankAccount: '012345678901',
          wageHistory: [
            { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: new Date('2025-01-01') },
          ],
        },
      },
    ] as never)

    vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
      makeRunEmployee(),
    ] as never)

    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 0 } as never)

    const newRevision = makeRevision({
      id: 'revision-uuid-2',
      revisionNumber: 2,
      isCurrent: true,
    })

    vi.mocked(prisma.payrollRevision.update).mockResolvedValue(revision as never)
    vi.mocked(prisma.payrollRevision.create).mockResolvedValue(newRevision as never)
    vi.mocked(prisma.payrollRunEmployee.createMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.payrollRun.update).mockResolvedValue({ ...run, currentRevisionNumber: 2 } as never)

    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    return { newRevision }
  }

  it('increments revision number from 1 to 2', async () => {
    setupRecalculateMocks()

    const result = await recalculateAndCreateRevision({
      payrollRunId: 'run-uuid-1',
      correctionReason: null,
      correctionTypes: ['ADJUSTMENTS'],
    })

    expect(result.revisionNumber).toBe(2)
    expect(result.payrollRunId).toBe('run-uuid-1')
    expect(result.employeeCount).toBe(1)
  })

  it('supersedes previous revision (isCurrent=false, status=SUPERSEDED)', async () => {
    setupRecalculateMocks()

    await recalculateAndCreateRevision({
      payrollRunId: 'run-uuid-1',
      correctionReason: null,
      correctionTypes: ['EMPLOYEE_DATA'],
    })

    // Verify the transaction was called
    expect(prisma.$transaction).toHaveBeenCalled()

    expect(prisma.payrollRevision.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'revision-uuid-1' },
        data: { isCurrent: false, status: 'SUPERSEDED' },
      }),
    )
  })

  it('stores correction reason on the new revision', async () => {
    setupRecalculateMocks()

    await recalculateAndCreateRevision({
      payrollRunId: 'run-uuid-1',
      correctionReason: 'Wrong overtime hours for EMP-003',
      correctionTypes: ['ADJUSTMENTS'],
    })

    expect(prisma.payrollRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          correctionReason: 'Wrong overtime hours for EMP-003',
        }),
      }),
    )
  })

  it('allows null correction reason', async () => {
    setupRecalculateMocks()

    await recalculateAndCreateRevision({
      payrollRunId: 'run-uuid-1',
      correctionReason: null,
      correctionTypes: ['ADJUSTMENTS'],
    })

    expect(prisma.payrollRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          correctionReason: null,
        }),
      }),
    )
  })

  it('throws NO_CORRECTION_TYPE_SELECTED when no types given', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
      ...makePayrollRun(),
      revisions: [makeRevision()],
    } as never)

    await expect(
      recalculateAndCreateRevision({
        payrollRunId: 'run-uuid-1',
        correctionReason: null,
        correctionTypes: [],
      }),
    ).rejects.toMatchObject({ code: 'NO_CORRECTION_TYPE_SELECTED' })
  })
})

// ─── US-08.4: Preview and approve revised payroll ───────────────────────────

describe('approveRevision', () => {
  it('sets status to APPROVED and sets approvedAt timestamp', async () => {
    const revision = makeRevision({ status: 'APPROVED' as never, approvedAt: null })
    vi.mocked(prisma.payrollRevision.findUnique).mockResolvedValue(revision as never)

    const now = new Date()
    vi.mocked(prisma.payrollRevision.update).mockResolvedValue({
      ...revision,
      status: 'APPROVED',
      approvedAt: now,
    } as never)

    const result = await approveRevision('revision-uuid-1')

    expect(result.status).toBe('APPROVED')
    expect(result.approvedAt).toBeDefined()
    expect(result.revisionNumber).toBe(1)
    expect(vi.mocked(prisma.payrollRevision.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'revision-uuid-1' },
        data: expect.objectContaining({ status: 'APPROVED' }),
      }),
    )
  })

  it('throws REVISION_NOT_FOUND for non-existent revision', async () => {
    vi.mocked(prisma.payrollRevision.findUnique).mockResolvedValue(null)

    await expect(approveRevision('non-existent')).rejects.toMatchObject({
      code: 'REVISION_NOT_FOUND',
    })
  })
})

// ─── US-08.5: View revision history ─────────────────────────────────────────

describe('getRevisionHistory', () => {
  it('returns all revisions sorted by revisionNumber descending', async () => {
    vi.mocked(prisma.payrollRevision.findMany).mockResolvedValue([
      makeRevision({ id: 'rev-3', revisionNumber: 3, isCurrent: true, status: 'APPROVED', correctionReason: 'Final fix' }),
      makeRevision({ id: 'rev-2', revisionNumber: 2, isCurrent: false, status: 'SUPERSEDED', correctionReason: 'OT error' }),
      makeRevision({ id: 'rev-1', revisionNumber: 1, isCurrent: false, status: 'SUPERSEDED', correctionReason: null }),
    ] as never)

    const result = await getRevisionHistory('run-uuid-1')

    expect(result).toHaveLength(3)
    expect(result[0].revisionNumber).toBe(3)
    expect(result[0].isCurrent).toBe(true)
    expect(result[0].status).toBe('APPROVED')
    expect(result[1].revisionNumber).toBe(2)
    expect(result[1].status).toBe('SUPERSEDED')
    expect(result[1].correctionReason).toBe('OT error')
    expect(result[2].revisionNumber).toBe(1)
    expect(result[2].correctionReason).toBeNull()
  })

  it('returns empty array when no revisions exist', async () => {
    vi.mocked(prisma.payrollRevision.findMany).mockResolvedValue([])

    const result = await getRevisionHistory('run-uuid-1')

    expect(result).toHaveLength(0)
  })
})

// ─── Regression: Post-payroll adjustments visible during correction ──────────

describe('post-payroll adjustments (created after approval)', () => {
  describe('initiateCorrection', () => {
    it('includes unlinked PENDING adjustment applications for the same week', async () => {
      const run = makePayrollRun()
      const revision = makeRevision()
      vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
        ...run,
        revisions: [revision],
      } as never)
      vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
        makeRunEmployee(),
      ] as never)

      // Mock returns both: one previously-linked app AND one new unlinked PENDING app
      const linkedApp = {
        ...makeAdjApplication({ id: 'app-linked', approvalStatus: 'PENDING' }),
        payrollAdjustment: { adjustmentType: 'DEDUCTION', amount: 500, reason: 'Advance recovery' },
        employee: { employeeName: 'Kavitha Rajan', employeeId: 'EMP-001' },
      }
      const newUnlinkedApp = {
        ...makeAdjApplication({
          id: 'app-new',
          payrollRunId: null,
          payrollRevisionId: null,
          approvalStatus: 'PENDING',
          approvedAt: null,
          appliedAt: null,
        }),
        payrollAdjustment: { adjustmentType: 'ADDITION', amount: 200, reason: 'Bonus' },
        employee: { employeeName: 'Kavitha Rajan', employeeId: 'EMP-001' },
      }

      vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([
        linkedApp,
        newUnlinkedApp,
      ] as never)

      const result = await initiateCorrection('run-uuid-1')

      // Verify the query used the OR clause to fetch both linked and unlinked apps
      expect(vi.mocked(prisma.payrollAdjustmentApplication.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            payrollWeekStartDate: WEEK_START,
            OR: [
              { payrollRunId: 'run-uuid-1' },
              { payrollRunId: null, approvalStatus: 'PENDING' },
            ],
          }),
        }),
      )

      // Both apps should be returned
      expect(result.adjustmentApplications).toHaveLength(2)
      expect(result.adjustmentApplications.map((a) => a.applicationId)).toContain('app-linked')
      expect(result.adjustmentApplications.map((a) => a.applicationId)).toContain('app-new')
    })
  })

  describe('prepareAdjustmentsForCorrection', () => {
    it('resets both linked and unlinked PENDING apps for the payroll week', async () => {
      vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
        payrollWeekStartDate: WEEK_START,
      } as never)
      vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 2 } as never)

      await prepareAdjustmentsForCorrection('run-uuid-1')

      expect(vi.mocked(prisma.payrollAdjustmentApplication.updateMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { payrollRunId: 'run-uuid-1' },
              expect.objectContaining({
                payrollWeekStartDate: WEEK_START,
                payrollRunId: null,
                approvalStatus: 'PENDING',
              }),
            ]),
          }),
        }),
      )
    })
  })
})
