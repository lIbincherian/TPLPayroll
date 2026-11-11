import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { Employee, PayrollAdjustment, PayrollAdjustmentApplication } from '@prisma/client'

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    employee: {
      findUnique: vi.fn(),
    },
    payrollAdjustment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    payrollAdjustmentApplication: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import _prisma from '@/lib/prisma'

// Loose view of the mocked client declared in vi.mock above: every delegate method is a
// vitest mock, and these tests feed them minimal fixtures that don't satisfy Prisma's
// generated return types.
type LooseMock = Mock<(...args: unknown[]) => unknown>
type PrismaMock = {
  employee: Record<'findUnique', LooseMock>
  payrollAdjustment: Record<'create' | 'findUnique' | 'findMany' | 'count' | 'update', LooseMock>
  payrollAdjustmentApplication: Record<
    | 'create'
    | 'findUnique'
    | 'findFirst'
    | 'findMany'
    | 'update'
    | 'updateMany'
    | 'deleteMany'
    | 'count'
    | 'aggregate',
    LooseMock
  >
  $transaction: LooseMock
}
const prisma = _prisma as unknown as PrismaMock
import {
  createAdjustment,
  getAdjustmentList,
  getAdjustmentDetail,
  approveAdjustmentApplication,
  skipAdjustmentApplication,
  updateAdjustment,
  cancelAdjustment,
  getAdjustmentsForWeekReview,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { AdjustmentServiceError } from '@/features/payroll-adjustments/types/adjustment.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'emp-uuid-1',
  employeeImportBatchId: null,
  employeeId: 'EMP-001',
  serialNumber: null,
  employeeName: 'Lakshmi Venkatesh',
  nationalId: null,
  designation: 'Guard',
  dateOfJoining: null,
  aadhaarId: null,
  policeVerificationId: null,
  phone: null,
  dateOfBirth: null,
  healthCardId: null,
  gPay: null,
  bankAccount: null,
  dateOfResignation: null,
  site: null,
  isActive: true,
  designationShort: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
})

const makeAdjustment = (overrides: Partial<PayrollAdjustment> = {}): PayrollAdjustment => ({
  id: 'adj-uuid-1',
  employeeId: 'emp-uuid-1',
  adjustmentType: 'DEDUCTION',
  recurrenceType: 'ONE_TIME',
  amount: 500 as unknown as PayrollAdjustment['amount'],
  reason: 'Advance recovery',
  startPayrollWeekStartDate: new Date('2025-03-06'),
  startPayrollWeekEndDate: new Date('2025-03-12'),
  endPayrollWeekStartDate: null,
  endPayrollWeekEndDate: null,
  totalRecurrenceWeeks: null,
  totalBalance: null,
  remainingBalance: null,
  recurrenceEndType: null,
  status: 'ACTIVE',
  skippedCarryForwardCount: 0,
  createdBy: null,
  createdAt: new Date('2025-03-01'),
  ...overrides,
})

const makeApplication = (
  overrides: Partial<PayrollAdjustmentApplication> = {},
): PayrollAdjustmentApplication => ({
  id: 'app-uuid-1',
  payrollAdjustmentId: 'adj-uuid-1',
  payrollRunId: null,
  payrollRevisionId: null,
  employeeId: 'emp-uuid-1',
  payrollWeekStartDate: new Date('2025-03-06'),
  payrollWeekEndDate: new Date('2025-03-12'),
  appliedAmount: 500 as unknown as PayrollAdjustmentApplication['appliedAmount'],
  approvalStatus: 'PENDING',
  approvedBy: null,
  approvedAt: null,
  appliedAt: null,
  skippedAt: null,
  carriedForwardToPayrollWeekStartDate: null,
  isReversed: false,
  ...overrides,
})

const validOneTimeInput = {
  employeeId: 'emp-uuid-1',
  adjustmentType: 'DEDUCTION' as const,
  amount: 500,
  reason: 'Advance recovery',
  recurrenceType: 'ONE_TIME' as const,
  startPayrollWeekStartDate: new Date('2025-03-06'),
  startPayrollWeekEndDate: new Date('2025-03-12'),
}

// ─────────────────────────────────────────────────────────────────────────────
// US-05.1: Create one-time adjustment
// ─────────────────────────────────────────────────────────────────────────────

describe('createAdjustment — one-time', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates adjustment and application for a one-time deduction', async () => {
    // GIVEN valid one-time input for EMP-001
    const adj = makeAdjustment()
    const app = makeApplication()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.payrollAdjustment.create).mockResolvedValue(adj as never)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(app as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    // WHEN
    const result = await createAdjustment(validOneTimeInput)

    // THEN a PayrollAdjustment is created with recurrenceType = ONE_TIME
    expect(result.recurrenceType).toBe('ONE_TIME')
    expect(result.adjustmentType).toBe('DEDUCTION')
    expect(result.amount).toBe(500)
  })

  it('creates a PENDING application for the start payroll week', async () => {
    // GIVEN valid one-time input
    const adj = makeAdjustment()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    let capturedAppCreate: unknown = null
    vi.mocked(prisma.payrollAdjustment.create).mockResolvedValue(adj as never)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedAppCreate = args
      return Promise.resolve(makeApplication() as never)
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    await createAdjustment(validOneTimeInput)

    // THEN a PENDING application is created for March 6-12
    expect(capturedAppCreate).toMatchObject({
      data: expect.objectContaining({
        approvalStatus: 'PENDING',
        payrollWeekStartDate: new Date('2025-03-06'),
      }),
    })
  })

  it('rejects missing reason with VALIDATION_ERROR', async () => {
    // GIVEN adjustment with empty reason
    const badInput = { ...validOneTimeInput, reason: '' }
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    await expect(createAdjustment(badInput)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('accepts decimal amounts (e.g. 1250.75)', async () => {
    // GIVEN adjustment with decimal amount
    const adj = makeAdjustment({ amount: 1250.75 as unknown as PayrollAdjustment['amount'] })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    let capturedCreate: unknown = null
    vi.mocked(prisma.payrollAdjustment.create).mockImplementation((args: unknown) => {
      capturedCreate = args
      return Promise.resolve(adj as never)
    })
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    await createAdjustment({ ...validOneTimeInput, amount: 1250.75 })

    expect(capturedCreate).toMatchObject({
      data: expect.objectContaining({ amount: 1250.75 }),
    })
  })

  it('throws EMPLOYEE_NOT_FOUND when employee does not exist', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)

    await expect(createAdjustment(validOneTimeInput)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-05.2: Create recurring adjustment
// ─────────────────────────────────────────────────────────────────────────────

describe('createAdjustment — recurring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates recurring adjustment with END_WEEK end condition', async () => {
    // GIVEN type=RECURRING, endType=END_WEEK
    const input = {
      ...validOneTimeInput,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'END_WEEK' as const,
      endPayrollWeekStartDate: new Date('2025-04-03'),
      endPayrollWeekEndDate: new Date('2025-04-09'),
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'END_WEEK',
      endPayrollWeekStartDate: new Date('2025-04-03'),
    })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.payrollAdjustment.create).mockResolvedValue(adj as never)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    const result = await createAdjustment(input)

    expect(result.recurrenceType).toBe('RECURRING')
    expect(result.recurrenceEndType).toBe('END_WEEK')
    expect(result.endPayrollWeekStartDate).toEqual(new Date('2025-04-03'))
  })

  it('creates recurring adjustment with FIXED_WEEKS end condition', async () => {
    // GIVEN type=RECURRING, endType=FIXED_WEEKS, totalWeeks=4
    const input = {
      ...validOneTimeInput,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'FIXED_WEEKS' as const,
      totalRecurrenceWeeks: 4,
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      totalRecurrenceWeeks: 4,
    })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    let capturedAdjCreate: unknown = null
    vi.mocked(prisma.payrollAdjustment.create).mockImplementation((args: unknown) => {
      capturedAdjCreate = args
      return Promise.resolve(adj as never)
    })
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    const result = await createAdjustment(input)

    expect(result.recurrenceEndType).toBe('FIXED_WEEKS')
    expect(result.totalRecurrenceWeeks).toBe(4)
    expect(capturedAdjCreate).toMatchObject({
      data: expect.objectContaining({ totalRecurrenceWeeks: 4 }),
    })
  })

  it('creates recurring adjustment with TOTAL_BALANCE and sets remainingBalance', async () => {
    // GIVEN type=RECURRING, endType=TOTAL_BALANCE, totalBalance=8000
    const input = {
      ...validOneTimeInput,
      amount: 2000,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'TOTAL_BALANCE' as const,
      totalBalance: 8000,
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'TOTAL_BALANCE',
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
    })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    let capturedAdjCreate: unknown = null
    vi.mocked(prisma.payrollAdjustment.create).mockImplementation((args: unknown) => {
      capturedAdjCreate = args
      return Promise.resolve(adj as never)
    })
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises as never
    })

    const result = await createAdjustment(input)

    // THEN remainingBalance = totalBalance initially
    expect(result.remainingBalance).toBe(8000)
    expect(capturedAdjCreate).toMatchObject({
      data: expect.objectContaining({
        totalBalance: 8000,
        remainingBalance: 8000,
      }),
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-05.3: Adjustments list
// ─────────────────────────────────────────────────────────────────────────────

describe('getAdjustmentList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all adjustments with count', async () => {
    // GIVEN 10 adjustments
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...makeAdjustment({ id: `adj-${i}` }),
      employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
    }))
    vi.mocked(prisma.payrollAdjustment.count).mockResolvedValue(10)
    vi.mocked(prisma.payrollAdjustment.findMany).mockResolvedValue(rows as never)

    const result = await getAdjustmentList({})

    expect(result.totalCount).toBe(10)
    expect(result.adjustments).toHaveLength(10)
  })

  it('filters by status ACTIVE', async () => {
    // GIVEN 7 active adjustments
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...makeAdjustment({ id: `adj-${i}`, status: 'ACTIVE' }),
      employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
    }))
    vi.mocked(prisma.payrollAdjustment.count).mockResolvedValue(7)
    vi.mocked(prisma.payrollAdjustment.findMany).mockResolvedValue(rows as never)

    const result = await getAdjustmentList({ status: 'ACTIVE' })

    expect(result.adjustments).toHaveLength(7)
    expect(prisma.payrollAdjustment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    )
  })

  it('filters by type DEDUCTION', async () => {
    // GIVEN 6 deductions
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...makeAdjustment({ id: `adj-${i}`, adjustmentType: 'DEDUCTION' }),
      employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
    }))
    vi.mocked(prisma.payrollAdjustment.count).mockResolvedValue(6)
    vi.mocked(prisma.payrollAdjustment.findMany).mockResolvedValue(rows as never)

    const result = await getAdjustmentList({ type: 'DEDUCTION' })

    expect(result.adjustments).toHaveLength(6)
    expect(prisma.payrollAdjustment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ adjustmentType: 'DEDUCTION' }),
      }),
    )
  })

  it('includes employee name in list items', async () => {
    const rows = [
      {
        ...makeAdjustment(),
        employee: { employeeName: 'Arjun Mehrotra', employeeId: 'EMP-002' },
      },
    ]
    vi.mocked(prisma.payrollAdjustment.count).mockResolvedValue(1)
    vi.mocked(prisma.payrollAdjustment.findMany).mockResolvedValue(rows as never)

    const result = await getAdjustmentList({})

    expect(result.adjustments[0].employeeName).toBe('Arjun Mehrotra')
    expect(result.adjustments[0].employeeCode).toBe('EMP-002')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-05.6: Adjustment detail
// ─────────────────────────────────────────────────────────────────────────────

describe('getAdjustmentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns full adjustment with 4 application entries', async () => {
    // GIVEN adjustment with 4 applications
    const apps = Array.from({ length: 4 }, (_, i) => makeApplication({ id: `app-${i}` }))
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue({
      ...makeAdjustment(),
      employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
      adjustmentApplications: apps,
    } as never)

    const result = await getAdjustmentDetail('adj-uuid-1')

    expect(result.id).toBe('adj-uuid-1')
    expect(result.applications).toHaveLength(4)
  })

  it('throws ADJUSTMENT_NOT_FOUND when adjustment does not exist', async () => {
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(null)

    await expect(getAdjustmentDetail('nonexistent')).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_FOUND',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-05.4: Approve adjustment application
// ─────────────────────────────────────────────────────────────────────────────

describe('approveAdjustmentApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets approvalStatus to APPROVED and sets appliedAt', async () => {
    // GIVEN a PENDING application for EMP-001
    const app = makeApplication({ approvalStatus: 'PENDING' })
    const adj = makeAdjustment({ recurrenceEndType: null })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
      appliedAt: new Date(),
    } as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    const result = await approveAdjustmentApplication('app-uuid-1')

    expect(result.approvalStatus).toBe('APPROVED')
    expect(result.appliedAt).toBeDefined()
    expect(prisma.payrollAdjustmentApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'app-uuid-1' },
        data: expect.objectContaining({ approvalStatus: 'APPROVED' }),
      }),
    )
  })

  it('caps applied amount at remainingBalance for TOTAL_BALANCE adjustments', async () => {
    // GIVEN adjustment amount=2000, remainingBalance=1500
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'TOTAL_BALANCE',
      amount: 2000 as unknown as PayrollAdjustment['amount'],
      remainingBalance: 1500 as unknown as PayrollAdjustment['remainingBalance'],
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollAdjustmentId: adj.id,
      appliedAmount: 2000 as unknown as PayrollAdjustmentApplication['appliedAmount'],
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)

    let capturedAppUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockImplementation(
      (args: unknown) => {
        capturedAppUpdate = args
        return Promise.resolve({ ...app, approvalStatus: 'APPROVED', appliedAmount: 1500 } as never)
      },
    )
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    await approveAdjustmentApplication('app-uuid-1')

    // THEN applied amount = min(2000, 1500) = 1500
    expect(capturedAppUpdate).toMatchObject({
      data: expect.objectContaining({ appliedAmount: 1500 }),
    })
  })

  it('sets adjustment status to COMPLETED when remainingBalance reaches 0', async () => {
    // GIVEN adjustment amount=2000, remainingBalance=1500
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'TOTAL_BALANCE',
      amount: 2000 as unknown as PayrollAdjustment['amount'],
      remainingBalance: 1500 as unknown as PayrollAdjustment['remainingBalance'],
    })
    const app = makeApplication({ approvalStatus: 'PENDING', payrollAdjustmentId: adj.id })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, status: 'COMPLETED', remainingBalance: 0 } as never)
    })

    await approveAdjustmentApplication('app-uuid-1')

    // THEN adjustment status = COMPLETED and remainingBalance = 0
    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({
        status: 'COMPLETED',
        remainingBalance: 0,
      }),
    })
  })

  it('sets ONE_TIME adjustment status to COMPLETED on approval', async () => {
    // GIVEN a ONE_TIME adjustment
    const adj = makeAdjustment({
      recurrenceType: 'ONE_TIME',
    })
    const app = makeApplication({ approvalStatus: 'PENDING', payrollAdjustmentId: adj.id })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, status: 'COMPLETED' } as never)
    })

    await approveAdjustmentApplication('app-uuid-1')

    // THEN adjustment status = COMPLETED
    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({
        status: 'COMPLETED',
      }),
    })
  })

  it('allows approving a SKIPPED application and deletes carry-forward next-week PENDING application', async () => {
    // GIVEN a SKIPPED application that was carried forward to next week
    const adj = makeAdjustment({ recurrenceType: 'ONE_TIME' })
    const app = makeApplication({
      approvalStatus: 'SKIPPED',
      payrollAdjustmentId: adj.id,
      carriedForwardToPayrollWeekStartDate: new Date('2025-03-13'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.deleteMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    await approveAdjustmentApplication('app-uuid-1')

    // THEN the next-week PENDING application is deleted
    expect(prisma.payrollAdjustmentApplication.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          payrollAdjustmentId: adj.id,
          payrollWeekStartDate: new Date('2025-03-13'),
          approvalStatus: 'PENDING',
        },
      }),
    )
  })

  it('throws APPLICATION_NOT_FOUND when application does not exist', async () => {
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(null)

    await expect(approveAdjustmentApplication('nonexistent')).rejects.toMatchObject({
      code: 'APPLICATION_NOT_FOUND',
    })
  })

  it('throws INVALID_APPROVAL_STATUS when application is already approved', async () => {
    const app = makeApplication({ approvalStatus: 'APPROVED' })
    const adj = makeAdjustment()
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)

    await expect(approveAdjustmentApplication('app-uuid-1')).rejects.toMatchObject({
      code: 'INVALID_APPROVAL_STATUS',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-05.5: Skip adjustment application
// ─────────────────────────────────────────────────────────────────────────────

describe('skipAdjustmentApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets approvalStatus to SKIPPED and creates next PENDING application', async () => {
    // GIVEN a PENDING application for week March 6-12
    const adj = makeAdjustment({ recurrenceType: 'RECURRING' })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)

    let capturedNextApp: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedNextApp = args
      return Promise.resolve(
        makeApplication({ approvalStatus: 'PENDING', payrollWeekStartDate: new Date('2025-03-13') }) as never,
      )
    })
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({ ...adj, skippedCarryForwardCount: 1 } as never)

    const result = await skipAdjustmentApplication('app-uuid-1')

    // THEN approvalStatus = SKIPPED
    expect(result.approvalStatus).toBe('SKIPPED')

    // AND a new PENDING application is created for the next payroll week (March 13-19)
    expect(capturedNextApp).toMatchObject({
      data: expect.objectContaining({
        approvalStatus: 'PENDING',
        payrollWeekStartDate: new Date('2025-03-13'),
        payrollWeekEndDate: new Date('2025-03-19'),
      }),
    })
  })

  it('increments skippedCarryForwardCount on the adjustment', async () => {
    const adj = makeAdjustment({ recurrenceType: 'RECURRING', skippedCarryForwardCount: 2 })
    const app = makeApplication({ approvalStatus: 'PENDING', payrollAdjustmentId: adj.id })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, skippedCarryForwardCount: 3 } as never)
    })

    await skipAdjustmentApplication('app-uuid-1')

    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({ skippedCarryForwardCount: 3 }),
    })
  })

  it('carries forward a one-time adjustment to the next payroll week', async () => {
    // GIVEN a ONE_TIME adjustment PENDING for March 6-12
    const adj = makeAdjustment({ recurrenceType: 'ONE_TIME' })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)

    let capturedNextApp: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedNextApp = args
      return Promise.resolve(makeApplication() as never)
    })
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    await skipAdjustmentApplication('app-uuid-1')

    // THEN a new PENDING application is created for March 13-19
    expect(capturedNextApp).toMatchObject({
      data: expect.objectContaining({
        approvalStatus: 'PENDING',
        payrollWeekStartDate: new Date('2025-03-13'),
      }),
    })
  })

  it('allows skipping an APPROVED ONE_TIME application and reverts status to ACTIVE', async () => {
    const adj = makeAdjustment({ recurrenceType: 'ONE_TIME', status: 'COMPLETED' })
    const app = makeApplication({
      approvalStatus: 'APPROVED',
      appliedAmount: 500 as unknown as PayrollAdjustmentApplication['appliedAmount'],
      payrollAdjustmentId: adj.id,
      payrollWeekStartDate: new Date('2025-03-06'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, status: 'ACTIVE' } as never)
    })

    await skipAdjustmentApplication('app-uuid-1')

    // THEN adjustment status is reverted to ACTIVE
    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({
        status: 'ACTIVE',
      }),
    })
  })

  it('allows skipping an APPROVED TOTAL_BALANCE application and restores remainingBalance', async () => {
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'TOTAL_BALANCE',
      remainingBalance: 500 as unknown as PayrollAdjustment['remainingBalance'],
      totalBalance: 2000 as unknown as PayrollAdjustment['totalBalance'],
      status: 'ACTIVE',
    })
    const app = makeApplication({
      approvalStatus: 'APPROVED',
      appliedAmount: 500 as unknown as PayrollAdjustmentApplication['appliedAmount'],
      payrollAdjustmentId: adj.id,
      payrollWeekStartDate: new Date('2025-03-06'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve(adj as never)
    })

    await skipAdjustmentApplication('app-uuid-1')

    // THEN remainingBalance is restored by 500 (500 + 500 = 1000)
    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({
        remainingBalance: 1000,
      }),
    })
  })

  it('throws INVALID_APPROVAL_STATUS when application is already SKIPPED', async () => {
    const app = makeApplication({ approvalStatus: 'SKIPPED' })
    const adj = makeAdjustment()
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)

    await expect(skipAdjustmentApplication('app-uuid-1')).rejects.toMatchObject({
      code: 'INVALID_APPROVAL_STATUS',
    })
  })

  it('throws APPLICATION_NOT_FOUND when application does not exist', async () => {
    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue(null)

    await expect(skipAdjustmentApplication('nonexistent')).rejects.toMatchObject({
      code: 'APPLICATION_NOT_FOUND',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// updateAdjustment
// ─────────────────────────────────────────────────────────────────────────────

const validUpdateInput = {
  adjustmentType: 'DEDUCTION' as const,
  amount: 750,
  reason: 'Updated recovery',
  recurrenceType: 'ONE_TIME' as const,
  startPayrollWeekStartDate: new Date('2025-03-06'),
  startPayrollWeekEndDate: new Date('2025-03-12'),
}

describe('updateAdjustment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.payrollAdjustmentApplication.aggregate).mockResolvedValue({
      _sum: { appliedAmount: null },
    } as never)
  })

  it('updates amount and reason on an ACTIVE adjustment with no approved applications', async () => {
    // GIVEN an ACTIVE adjustment with only a PENDING application
    const adj = makeAdjustment({ status: 'ACTIVE' })
    const apps = [makeApplication({ approvalStatus: 'PENDING' })]
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue({
      ...adj,
      adjustmentApplications: apps,
    } as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({
      ...adj,
      amount: 750 as unknown as typeof adj.amount,
      reason: 'Updated recovery',
    })
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 1 })

    // WHEN
    const result = await updateAdjustment('adj-uuid-1', validUpdateInput)

    // THEN amount and reason are updated
    expect(result.amount).toBe(750)
    expect(result.reason).toBe('Updated recovery')
    expect(prisma.payrollAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'adj-uuid-1' },
        data: expect.objectContaining({ amount: 750, reason: 'Updated recovery' }),
      }),
    )
  })

  it('also updates PENDING applications to reflect new amount and start week', async () => {
    // GIVEN ACTIVE adjustment with a PENDING app for March 6-12
    const adj = makeAdjustment({ status: 'ACTIVE' })
    const apps = [makeApplication({ approvalStatus: 'PENDING' })]
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue({
      ...adj,
      adjustmentApplications: apps,
    } as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({
      ...adj,
      amount: 750 as unknown as typeof adj.amount,
    })

    let capturedAppUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockImplementation((args: unknown) => {
      capturedAppUpdate = args
      return Promise.resolve({ count: 1 })
    })

    await updateAdjustment('adj-uuid-1', validUpdateInput)

    // THEN PENDING applications are updated with new amount and week
    expect(capturedAppUpdate).toMatchObject({
      where: expect.objectContaining({ payrollAdjustmentId: 'adj-uuid-1', approvalStatus: 'PENDING' }),
      data: expect.objectContaining({
        appliedAmount: 750,
        payrollWeekStartDate: new Date('2025-03-06'),
        payrollWeekEndDate: new Date('2025-03-12'),
      }),
    })
  })

  it('throws ADJUSTMENT_NOT_FOUND when adjustment does not exist', async () => {
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(null)

    await expect(updateAdjustment('nonexistent', validUpdateInput)).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_FOUND',
    })
  })

  it('throws EDIT_NOT_ALLOWED when any application is already APPROVED', async () => {
    // GIVEN an adjustment that has one APPROVED application
    const adj = makeAdjustment({ status: 'ACTIVE' })
    const apps = [
      makeApplication({ approvalStatus: 'APPROVED' }),
      makeApplication({ id: 'app-uuid-2', approvalStatus: 'PENDING' }),
    ]
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue({
      ...adj,
      adjustmentApplications: apps,
    } as never)

    await expect(updateAdjustment('adj-uuid-1', validUpdateInput)).rejects.toMatchObject({
      code: 'EDIT_NOT_ALLOWED',
    })
  })

  it('allows update when applications are only SKIPPED (none APPROVED)', async () => {
    // GIVEN an adjustment with only SKIPPED + PENDING applications
    const adj = makeAdjustment({ status: 'ACTIVE' })
    const apps = [
      makeApplication({ id: 'app-uuid-1', approvalStatus: 'SKIPPED' }),
      makeApplication({ id: 'app-uuid-2', approvalStatus: 'PENDING' }),
    ]
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue({
      ...adj,
      adjustmentApplications: apps,
    } as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({
      ...adj,
      amount: 750 as unknown as typeof adj.amount,
    })
    vi.mocked(prisma.payrollAdjustmentApplication.updateMany).mockResolvedValue({ count: 1 })

    // WHEN (should not throw)
    const result = await updateAdjustment('adj-uuid-1', validUpdateInput)

    expect(result.amount).toBe(750)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// cancelAdjustment
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelAdjustment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets adjustment status to CANCELLED and deletes PENDING applications', async () => {
    // GIVEN an ACTIVE adjustment
    const adj = makeAdjustment({ status: 'ACTIVE' })
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(adj)

    let capturedDeleteMany: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.deleteMany).mockImplementation((args: unknown) => {
      capturedDeleteMany = args
      return Promise.resolve({ count: 1 })
    })
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({
      ...adj,
      status: 'CANCELLED',
    })

    const result = await cancelAdjustment('adj-uuid-1')

    // THEN status is CANCELLED
    expect(result.status).toBe('CANCELLED')

    // AND only PENDING applications are deleted
    expect(capturedDeleteMany).toMatchObject({
      where: expect.objectContaining({
        payrollAdjustmentId: 'adj-uuid-1',
        approvalStatus: 'PENDING',
      }),
    })
  })

  it('throws ADJUSTMENT_NOT_FOUND when adjustment does not exist', async () => {
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(null)

    await expect(cancelAdjustment('nonexistent')).rejects.toMatchObject({
      code: 'ADJUSTMENT_NOT_FOUND',
    })
  })

  it('throws CANCEL_NOT_ALLOWED when adjustment is already COMPLETED', async () => {
    const adj = makeAdjustment({ status: 'COMPLETED' })
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(adj)

    await expect(cancelAdjustment('adj-uuid-1')).rejects.toMatchObject({
      code: 'CANCEL_NOT_ALLOWED',
    })
  })

  it('throws CANCEL_NOT_ALLOWED when adjustment is already CANCELLED', async () => {
    const adj = makeAdjustment({ status: 'CANCELLED' })
    vi.mocked(prisma.payrollAdjustment.findUnique).mockResolvedValue(adj)

    await expect(cancelAdjustment('adj-uuid-1')).rejects.toMatchObject({
      code: 'CANCEL_NOT_ALLOWED',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BF-01: FIXED_WEEKS — create stores weekly instalment, not full amount
// ─────────────────────────────────────────────────────────────────────────────

describe('BF-01 — createAdjustment FIXED_WEEKS splits amount evenly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores per-week instalment (total ÷ weeks) in amount', async () => {
    // GIVEN ₹8,000 total over 8 weeks → expect ₹1,000/week stored
    const input = {
      ...validOneTimeInput,
      amount: 8000,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'FIXED_WEEKS' as const,
      totalRecurrenceWeeks: 8,
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })

    let capturedAdjCreate: unknown = null
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.payrollAdjustment.create).mockImplementation((args: unknown) => {
      capturedAdjCreate = args
      return Promise.resolve(adj as never)
    })
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) return Promise.all(promises)
      return promises as never
    })

    const result = await createAdjustment(input)

    // amount stored = 1000 (weekly slice), not 8000 (total)
    expect(result.amount).toBe(1000)
    expect(capturedAdjCreate).toMatchObject({
      data: expect.objectContaining({ amount: 1000 }),
    })
  })

  it('stores original total in totalBalance for FIXED_WEEKS', async () => {
    const input = {
      ...validOneTimeInput,
      amount: 8000,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'FIXED_WEEKS' as const,
      totalRecurrenceWeeks: 8,
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })

    let capturedAdjCreate: unknown = null
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.payrollAdjustment.create).mockImplementation((args: unknown) => {
      capturedAdjCreate = args
      return Promise.resolve(adj as never)
    })
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockResolvedValue(makeApplication() as never)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) return Promise.all(promises)
      return promises as never
    })

    await createAdjustment(input)

    expect(capturedAdjCreate).toMatchObject({
      data: expect.objectContaining({ totalBalance: 8000, remainingBalance: 8000 }),
    })
  })

  it('sets first application appliedAmount to the weekly slice, not the total', async () => {
    const input = {
      ...validOneTimeInput,
      amount: 8000,
      recurrenceType: 'RECURRING' as const,
      recurrenceEndType: 'FIXED_WEEKS' as const,
      totalRecurrenceWeeks: 8,
    }
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })

    let capturedAppCreate: unknown = null
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.payrollAdjustment.create).mockResolvedValue(adj as never)
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedAppCreate = args
      return Promise.resolve(makeApplication() as never)
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (promises: unknown) => {
      if (Array.isArray(promises)) return Promise.all(promises)
      return promises as never
    })

    await createAdjustment(input)

    // First application must use 1000, not 8000
    expect(capturedAppCreate).toMatchObject({
      data: expect.objectContaining({ appliedAmount: 1000 }),
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BF-01: FIXED_WEEKS — approve schedules next week and completes on last week
// ─────────────────────────────────────────────────────────────────────────────

describe('BF-01 — approveAdjustmentApplication FIXED_WEEKS creates next-week app', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a PENDING application for the next week after approving a mid-run week', async () => {
    // GIVEN 8-week plan, 1 of 8 approved so far (this is week 1)
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
      appliedAmount: 1000 as unknown as PayrollAdjustmentApplication['appliedAmount'],
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)
    // After approval, count returns 1 (this week is now approved)
    vi.mocked(prisma.payrollAdjustmentApplication.count as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    let capturedNextApp: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedNextApp = args
      return Promise.resolve(makeApplication() as never)
    })
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    await approveAdjustmentApplication('app-uuid-1')

    // THEN a PENDING application for March 13-19 is created
    expect(capturedNextApp).toMatchObject({
      data: expect.objectContaining({
        approvalStatus: 'PENDING',
        payrollWeekStartDate: new Date('2025-03-13'),
        payrollWeekEndDate: new Date('2025-03-19'),
        appliedAmount: 1000,
      }),
    })
  })

  it('marks adjustment COMPLETED and does NOT create next-week app after the last week', async () => {
    // GIVEN 8-week plan, all 8 weeks now approved (this is week 8)
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 1000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollAdjustmentId: adj.id,
      appliedAmount: 1000 as unknown as PayrollAdjustmentApplication['appliedAmount'],
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)
    // Count = 8 after this approval — all weeks done
    vi.mocked(prisma.payrollAdjustmentApplication.count as ReturnType<typeof vi.fn>).mockResolvedValue(8)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, status: 'COMPLETED', remainingBalance: 0 } as never)
    })

    await approveAdjustmentApplication('app-uuid-1')

    // THEN adjustment is COMPLETED
    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
    // AND no next-week application is created
    expect(prisma.payrollAdjustmentApplication.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BF-01: END_WEEK — approve schedules next week and completes on last week
// ─────────────────────────────────────────────────────────────────────────────

describe('BF-01 — approveAdjustmentApplication END_WEEK creates next-week app', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates next-week PENDING application when current week is before end week', async () => {
    // GIVEN end week = March 27; current week = March 6 → not yet at end
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'END_WEEK',
      endPayrollWeekStartDate: new Date('2025-03-27'),
      endPayrollWeekEndDate: new Date('2025-04-02'),
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)

    let capturedNextApp: unknown = null
    vi.mocked(prisma.payrollAdjustmentApplication.create).mockImplementation((args: unknown) => {
      capturedNextApp = args
      return Promise.resolve(makeApplication() as never)
    })
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    await approveAdjustmentApplication('app-uuid-1')

    expect(capturedNextApp).toMatchObject({
      data: expect.objectContaining({
        approvalStatus: 'PENDING',
        payrollWeekStartDate: new Date('2025-03-13'),
        payrollWeekEndDate: new Date('2025-03-19'),
      }),
    })
  })

  it('marks adjustment COMPLETED when the end week is approved', async () => {
    // GIVEN end week = March 6; current week = March 6 → this IS the end week
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'END_WEEK',
      endPayrollWeekStartDate: new Date('2025-03-06'),
      endPayrollWeekEndDate: new Date('2025-03-12'),
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)

    let capturedAdjUpdate: unknown = null
    vi.mocked(prisma.payrollAdjustment.update).mockImplementation((args: unknown) => {
      capturedAdjUpdate = args
      return Promise.resolve({ ...adj, status: 'COMPLETED' } as never)
    })

    await approveAdjustmentApplication('app-uuid-1')

    expect(capturedAdjUpdate).toMatchObject({
      data: expect.objectContaining({ status: 'COMPLETED' }),
    })
    expect(prisma.payrollAdjustmentApplication.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication and Snowball Prevention Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Deduplication and Snowball Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('approveAdjustmentApplication does not create duplicate PENDING next-week application if one already exists', async () => {
    // GIVEN a FIXED_WEEKS adjustment
    const adj = makeAdjustment({
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      amount: 1000 as unknown as PayrollAdjustment['amount'],
      totalBalance: 8000 as unknown as PayrollAdjustment['totalBalance'],
      remainingBalance: 8000 as unknown as PayrollAdjustment['remainingBalance'],
      totalRecurrenceWeeks: 8,
    })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
      appliedAmount: 1000 as unknown as PayrollAdjustmentApplication['appliedAmount'],
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'APPROVED',
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.count as ReturnType<typeof vi.fn>).mockResolvedValue(1)

    // Mock an existing PENDING application for the next week
    const existingNextApp = makeApplication({
      id: 'existing-pending-uuid',
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-13'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findFirst).mockResolvedValue(existingNextApp as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue(adj)

    // WHEN we approve the current week
    await approveAdjustmentApplication('app-uuid-1')

    // THEN the system should NOT create another application because one already exists
    expect(prisma.payrollAdjustmentApplication.create).not.toHaveBeenCalled()
  })

  it('skipAdjustmentApplication does not create duplicate PENDING next-week application if one already exists', async () => {
    // GIVEN a RECURRING adjustment
    const adj = makeAdjustment({ recurrenceType: 'RECURRING' })
    const app = makeApplication({
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-06'),
      payrollWeekEndDate: new Date('2025-03-12'),
      payrollAdjustmentId: adj.id,
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findUnique).mockResolvedValue({
      ...app,
      payrollAdjustment: adj,
    } as never)
    vi.mocked(prisma.payrollAdjustmentApplication.update).mockResolvedValue({
      ...app,
      approvalStatus: 'SKIPPED',
    } as never)

    // Mock an existing PENDING application for the next week
    const existingNextApp = makeApplication({
      id: 'existing-pending-uuid',
      approvalStatus: 'PENDING',
      payrollWeekStartDate: new Date('2025-03-13'),
    })
    vi.mocked(prisma.payrollAdjustmentApplication.findFirst).mockResolvedValue(existingNextApp as never)
    vi.mocked(prisma.payrollAdjustment.update).mockResolvedValue({ ...adj, skippedCarryForwardCount: 1 } as never)

    // WHEN we skip the current week
    await skipAdjustmentApplication('app-uuid-1')

    // THEN the system should NOT create a carry-forward application because one already exists
    expect(prisma.payrollAdjustmentApplication.create).not.toHaveBeenCalled()
  })

  it('getAdjustmentsForWeekReview deduplicates applications for the same adjustment in defense-in-depth', async () => {
    // GIVEN two duplicate PENDING applications for the same adjustment and same week
    const adj = makeAdjustment()
    const app1 = makeApplication({
      id: 'app-uuid-1',
      payrollAdjustmentId: adj.id,
      approvalStatus: 'PENDING',
    })
    const app2 = makeApplication({
      id: 'app-uuid-2',
      payrollAdjustmentId: adj.id,
      approvalStatus: 'PENDING',
    })

    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([
      {
        ...app1,
        payrollAdjustment: adj,
        employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
      },
      {
        ...app2,
        payrollAdjustment: adj,
        employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-001' },
      },
    ] as never)

    // WHEN we fetch adjustments for review
    const results = await getAdjustmentsForWeekReview(new Date('2025-03-06'))

    // THEN it should only return one review item, to keep the UI clean
    expect(results).toHaveLength(1)
    expect(results[0].applicationId).toBe('app-uuid-1')
  })
})

