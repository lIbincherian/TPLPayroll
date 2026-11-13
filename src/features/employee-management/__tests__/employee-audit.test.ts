import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Employee, EmployeeWageHistory, AuditLog } from '@prisma/client'

// ─── Mock Prisma ─────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    employee: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    employeeWageHistory: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import prisma from '@/lib/prisma'
import {
  createEmployee,
  updateEmployee,
} from '@/features/employee-management/services/employee.service'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'uuid-1',
  employeeImportBatchId: null,
  employeeId: 'EMP-100',
  serialNumber: null,
  employeeName: 'Ravi Kumar',
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
  site: 'North Gate',
  isActive: true,
  designationShort: 'GRD',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
})

const makeWageHistory = (overrides: Partial<EmployeeWageHistory> = {}): EmployeeWageHistory => ({
  id: 'wh-uuid-1',
  employeeId: 'uuid-1',
  weeklySalary: 12000 as unknown as EmployeeWageHistory['weeklySalary'],
  hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'],
  effectiveFrom: new Date('2025-01-01'),
  effectiveTo: null,
  changeSource: 'MANUAL',
  employeeImportBatchId: null,
  changedBy: null,
  createdAt: new Date('2025-01-01'),
  ...overrides,
})

const validInput = {
  employeeId: 'EMP-100',
  employeeName: 'Ravi Kumar',
  designation: 'Guard',
  salary: 12000,
  hourlyRate: 62.5,
  isActive: true,
}

// ─────────────────────────────────────────────────────────────────────────────
// US-11.1: createEmployee audit log — detailsJson contains all initial fields
// ─────────────────────────────────────────────────────────────────────────────

describe('createEmployee — audit log detailsJson', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores all initial fields in detailsJson', async () => {
    // GIVEN employee created with employeeName="Ravi Kumar", designation="Guard",
    //       salary=12000, hourlyRate=62.5
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN createEmployee is called
    await createEmployee(validInput)

    // THEN detailsJson contains { employeeName, designation, salary, hourlyRate }
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          detailsJson: expect.objectContaining({
            employeeName: 'Ravi Kumar',
            designation: 'Guard',
            salary: 12000,
            hourlyRate: 62.5,
          }),
        }),
      })
    )
  })

  it('stores changeSource MANUAL in detailsJson', async () => {
    // GIVEN valid employee data
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN createEmployee is called
    await createEmployee(validInput)

    // THEN detailsJson includes changeSource: 'MANUAL'
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          detailsJson: expect.objectContaining({
            changeSource: 'MANUAL',
          }),
        }),
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-11.2: updateEmployee — EMPLOYEE audit log changedFields diff
// ─────────────────────────────────────────────────────────────────────────────

describe('updateEmployee — EMPLOYEE audit log changedFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates EMPLOYEE audit log with changedFields diff when phone changes', async () => {
    // GIVEN employee with phone="9876543210"
    const existing = makeEmployee({ phone: '9876543210' })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ phone: '1111111111' }))
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN updateEmployee is called with { phone: "1111111111" }
    await updateEmployee('uuid-1', { phone: '1111111111' })

    // THEN EMPLOYEE auditLog.create is called with actionType = "UPDATE", entityType = "EMPLOYEE"
    const auditCalls = vi.mocked(prisma.auditLog.create).mock.calls
    const employeeAuditCall = auditCalls.find(
      ([args]) => (args as { data: { entityType: string } }).data.entityType === 'EMPLOYEE'
    )
    expect(employeeAuditCall).toBeDefined()

    const [employeeAuditArgs] = employeeAuditCall!
    expect(employeeAuditArgs).toMatchObject({
      data: expect.objectContaining({
        actionType: 'UPDATE',
        entityType: 'EMPLOYEE',
      }),
    })

    // AND detailsJson.changedFields.phone = { old: "9876543210", new: "1111111111" }
    expect(employeeAuditArgs).toMatchObject({
      data: expect.objectContaining({
        detailsJson: expect.objectContaining({
          changedFields: expect.objectContaining({
            phone: { old: '9876543210', new: '1111111111' },
          }),
        }),
      }),
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-11.3: updateEmployee — WAGE_HISTORY audit log on wage changes
// ─────────────────────────────────────────────────────────────────────────────

describe('updateEmployee — WAGE_HISTORY audit log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates separate WAGE_HISTORY audit log when salary changes', async () => {
    // GIVEN employee with salary=12000
    const existing = makeEmployee()
    const existingWage = makeWageHistory({ weeklySalary: 12000 as unknown as EmployeeWageHistory['weeklySalary'] })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([existingWage])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN updateEmployee is called with { salary: 14000 }
    await updateEmployee('uuid-1', { salary: 14000 })

    // THEN auditLog.create is called TWICE
    const auditCalls = vi.mocked(prisma.auditLog.create).mock.calls
    expect(auditCalls).toHaveLength(2)

    // One call: entityType = "EMPLOYEE"
    const employeeCall = auditCalls.find(
      ([args]) => (args as { data: { entityType: string } }).data.entityType === 'EMPLOYEE'
    )
    expect(employeeCall).toBeDefined()

    // One call: entityType = "WAGE_HISTORY" with detailsJson containing oldSalary, newSalary
    const wageHistoryCall = auditCalls.find(
      ([args]) => (args as { data: { entityType: string } }).data.entityType === 'WAGE_HISTORY'
    )
    expect(wageHistoryCall).toBeDefined()
    expect(wageHistoryCall![0]).toMatchObject({
      data: expect.objectContaining({
        entityType: 'WAGE_HISTORY',
        detailsJson: expect.objectContaining({
          oldSalary: 12000,
          newSalary: 14000,
        }),
      }),
    })
  })

  it('WAGE_HISTORY audit log includes effectiveFrom and employeeId when hourlyRate changes', async () => {
    // GIVEN employee with hourlyRate=62.50
    const existing = makeEmployee()
    const existingWage = makeWageHistory({ hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'] })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([existingWage])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN updateEmployee is called with { hourlyRate: 75.00 }
    await updateEmployee('uuid-1', { hourlyRate: 75.0 })

    // THEN WAGE_HISTORY auditLog detailsJson includes employeeId, effectiveFrom, oldHourlyRate, newHourlyRate
    const auditCalls = vi.mocked(prisma.auditLog.create).mock.calls
    const wageHistoryCall = auditCalls.find(
      ([args]) => (args as { data: { entityType: string } }).data.entityType === 'WAGE_HISTORY'
    )
    expect(wageHistoryCall).toBeDefined()
    expect(wageHistoryCall![0]).toMatchObject({
      data: expect.objectContaining({
        detailsJson: expect.objectContaining({
          employeeId: 'uuid-1',
          effectiveFrom: expect.any(Date),
          oldHourlyRate: 62.5,
          newHourlyRate: 75.0,
        }),
      }),
    })
  })

  it('does NOT create WAGE_HISTORY audit log for non-wage changes', async () => {
    // GIVEN employee phone changes
    const existing = makeEmployee({ phone: '9876543210' })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ phone: '9999999999' }))
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN updateEmployee is called with { phone: "9999999999" }
    await updateEmployee('uuid-1', { phone: '9999999999' })

    // THEN auditLog.create is called exactly ONCE (EMPLOYEE only)
    const auditCalls = vi.mocked(prisma.auditLog.create).mock.calls
    expect(auditCalls).toHaveLength(1)

    const [[singleArgs]] = auditCalls
    expect((singleArgs as { data: { entityType: string } }).data.entityType).toBe('EMPLOYEE')
  })
})

// Issue #36: clearing an optional field records old -> null
describe('updateEmployee — clearing an optional field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)
  })

  function employeeChangedFields() {
    const call = vi.mocked(prisma.auditLog.create).mock.calls.find(
      ([args]) => (args as { data: { entityType: string } }).data.entityType === 'EMPLOYEE'
    )
    return (call?.[0] as { data: { detailsJson: { changedFields: Record<string, unknown> } } } | undefined)
      ?.data.detailsJson.changedFields
  }

  it('records { old: <value>, new: null } for a cleared field and nothing for a field already null', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee({ gPay: '9876543210', phone: null }))

    await updateEmployee('uuid-1', { gPay: null, phone: null })

    const changedFields = employeeChangedFields()
    expect(changedFields).toEqual({ gPay: { old: '9876543210', new: null } })
    expect(changedFields).not.toHaveProperty('phone')
  })

  it('records no change when only already-null fields are sent as null', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee({ gPay: null, dateOfBirth: null }))

    await updateEmployee('uuid-1', { gPay: null, dateOfBirth: null })

    expect(employeeChangedFields()).toEqual({})
  })
})
