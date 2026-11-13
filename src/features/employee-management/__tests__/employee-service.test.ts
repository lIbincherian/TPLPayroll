import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  getEmployeeList,
  getEmployeeById,
  getEmployeeWageHistory,
  updateEmployee,
  getDistinctDesignations,
  getDistinctSites,
} from '@/features/employee-management/services/employee.service'
import { EmployeeServiceError, UpdateEmployeeSchema } from '@/features/employee-management/types/employee.types'

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
// US-02.1: createEmployee
// ─────────────────────────────────────────────────────────────────────────────

describe('createEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves employee and returns record', async () => {
    // GIVEN valid employee data
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null) // no duplicate
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    // WHEN
    const result = await createEmployee(validInput)

    // THEN
    expect(result.employeeId).toBe('EMP-100')
    expect(result.employeeName).toBe('Ravi Kumar')
  })

  it('rejects duplicate employeeId with DUPLICATE_EMPLOYEE_ID error', async () => {
    // GIVEN EMP-100 already exists
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee())

    // WHEN / THEN
    await expect(createEmployee(validInput)).rejects.toThrow(EmployeeServiceError)
    await expect(createEmployee(validInput)).rejects.toMatchObject({
      code: 'DUPLICATE_EMPLOYEE_ID',
    })
  })

  it('rejects missing required fields (employeeName)', async () => {
    // GIVEN employee data missing employeeName
    const badInput = { ...validInput, employeeName: '' }
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)

    // WHEN / THEN
    await expect(createEmployee(badInput)).rejects.toThrow(EmployeeServiceError)
    await expect(createEmployee(badInput)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('creates initial wage history with weeklySalary and hourlyRate', async () => {
    // GIVEN valid input with salary = 12000, hourlyRate = 62.50
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await createEmployee(validInput)

    // THEN wage history was created with correct values
    expect(prisma.employeeWageHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          weeklySalary: 12000,
          hourlyRate: 62.5,
          changeSource: 'MANUAL',
        }),
      })
    )
  })

  describe('first wage row effectiveFrom (#37)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-13T10:30:00.000Z'))
      vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
      vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
      vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function storedEffectiveFrom(): Date {
      return vi.mocked(prisma.employeeWageHistory.create).mock.calls[0][0].data.effectiveFrom as Date
    }

    it('stores an explicit wage effective date at UTC midnight', async () => {
      await createEmployee({ ...validInput, wageEffectiveFrom: new Date('2026-10-01T15:45:00.000Z') })
      expect(storedEffectiveFrom().toISOString()).toBe('2026-10-01T00:00:00.000Z')
    })

    it('defaults to the date of joining when the field is blank', async () => {
      await createEmployee({ ...validInput, dateOfJoining: new Date('2026-09-15') })
      expect(storedEffectiveFrom().toISOString()).toBe('2026-09-15T00:00:00.000Z')
    })

    it('defaults to the 1st of the current month when both are blank', async () => {
      await createEmployee(validInput)
      expect(storedEffectiveFrom().toISOString()).toBe('2026-11-01T00:00:00.000Z')
    })

    it('accepts a date exactly 7 days ahead', async () => {
      await createEmployee({ ...validInput, wageEffectiveFrom: new Date('2026-11-20') })
      expect(storedEffectiveFrom().toISOString()).toBe('2026-11-20T00:00:00.000Z')
    })

    it('rejects a date 8 days ahead', async () => {
      await expect(
        createEmployee({ ...validInput, wageEffectiveFrom: new Date('2026-11-21') })
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: "Wage effective date can't be more than one week in the future.",
      })
      expect(prisma.employeeWageHistory.create).not.toHaveBeenCalled()
    })

    it('accepts a date earlier than the date of joining', async () => {
      await createEmployee({
        ...validInput,
        dateOfJoining: new Date('2026-11-10'),
        wageEffectiveFrom: new Date('2026-10-01'),
      })
      expect(storedEffectiveFrom().toISOString()).toBe('2026-10-01T00:00:00.000Z')
    })

    it('the update schema does not accept the field', () => {
      const parsed = UpdateEmployeeSchema.safeParse({ wageEffectiveFrom: new Date('2026-10-01') })
      expect(parsed.success && 'wageEffectiveFrom' in parsed.data).toBe(false)
    })
  })

  it('creates audit log with actionType CREATE and entityType EMPLOYEE', async () => {
    // GIVEN valid input
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.create).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await createEmployee(validInput)

    // THEN
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'CREATE',
          entityType: 'EMPLOYEE',
        }),
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.2: getEmployeeList
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all employees with no filters', async () => {
    // GIVEN 15 employees in the database
    const employees = Array.from({ length: 15 }, (_, i) =>
      makeEmployee({ id: `uuid-${i}`, employeeId: `EMP-${i}` })
    )
    vi.mocked(prisma.employee.count).mockResolvedValue(15)
    vi.mocked(prisma.employee.findMany).mockResolvedValue(employees)

    // WHEN
    const result = await getEmployeeList({})

    // THEN
    expect(result.totalCount).toBe(15)
    expect(result.employees).toHaveLength(15)
  })

  it('paginates correctly returning 10 of 30 employees', async () => {
    // GIVEN 30 employees, requesting page 1 limit 10
    const employees = Array.from({ length: 10 }, (_, i) =>
      makeEmployee({ id: `uuid-${i}`, employeeId: `EMP-${i}` })
    )
    vi.mocked(prisma.employee.count).mockResolvedValue(30)
    vi.mocked(prisma.employee.findMany).mockResolvedValue(employees)

    // WHEN
    const result = await getEmployeeList({ page: 1, limit: 10 })

    // THEN
    expect(result.totalCount).toBe(30)
    expect(result.employees).toHaveLength(10)
    expect(result.page).toBe(1)
    expect(result.limit).toBe(10)
  })

  it('computes status RESIGNED for employee with dateOfResignation set', async () => {
    // GIVEN an employee with isActive=false and dateOfResignation set
    const resignedEmployee = makeEmployee({
      isActive: false,
      dateOfResignation: new Date('2025-01-15'),
    })
    vi.mocked(prisma.employee.count).mockResolvedValue(1)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([resignedEmployee])

    // WHEN
    const result = await getEmployeeList({})

    // THEN
    expect(result.employees[0].status).toBe('RESIGNED')
  })

  it('computes status INACTIVE for isActive=false employee without resignation', async () => {
    const inactiveEmployee = makeEmployee({ isActive: false, dateOfResignation: null })
    vi.mocked(prisma.employee.count).mockResolvedValue(1)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([inactiveEmployee])

    const result = await getEmployeeList({})

    expect(result.employees[0].status).toBe('INACTIVE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.3: Search employees
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeList — search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches employees by name substring (case-insensitive)', async () => {
    const raviKumar = makeEmployee({ employeeName: 'Ravi Kumar' })
    const raviSharma = makeEmployee({ id: 'uuid-2', employeeId: 'EMP-101', employeeName: 'Ravi Sharma' })
    vi.mocked(prisma.employee.count).mockResolvedValue(2)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([raviKumar, raviSharma])

    const result = await getEmployeeList({ search: 'ravi' })

    expect(result.employees).toHaveLength(2)
    // AND the Prisma query used a case-insensitive contains
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              employeeName: expect.objectContaining({ contains: 'ravi', mode: 'insensitive' }),
            }),
          ]),
        }),
      })
    )
  })

  it('matches employees by employee ID', async () => {
    const emp = makeEmployee({ employeeId: 'EMP-042' })
    vi.mocked(prisma.employee.count).mockResolvedValue(1)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([emp])

    const result = await getEmployeeList({ search: 'EMP-04' })

    expect(result.employees).toHaveLength(1)
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              employeeId: expect.objectContaining({ contains: 'EMP-04', mode: 'insensitive' }),
            }),
          ]),
        }),
      })
    )
  })

  it('returns empty array when no employees match the search term', async () => {
    vi.mocked(prisma.employee.count).mockResolvedValue(0)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([])

    const result = await getEmployeeList({ search: 'zzzzz' })

    expect(result.employees).toHaveLength(0)
    expect(result.totalCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.4: Filter employees by status
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeList — status filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns only active employees when status=ACTIVE', async () => {
    const activeEmployees = Array.from({ length: 10 }, (_, i) =>
      makeEmployee({ id: `uuid-${i}`, employeeId: `EMP-${i}`, isActive: true })
    )
    vi.mocked(prisma.employee.count).mockResolvedValue(10)
    vi.mocked(prisma.employee.findMany).mockResolvedValue(activeEmployees)

    const result = await getEmployeeList({ status: 'ACTIVE' })

    expect(result.employees).toHaveLength(10)
    result.employees.forEach((e) => expect(e.isActive).toBe(true))
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      })
    )
  })

  it('returns only resigned employees when status=RESIGNED', async () => {
    const resignedEmployees = [
      makeEmployee({ dateOfResignation: new Date('2025-01-01') }),
      makeEmployee({ id: 'uuid-2', employeeId: 'EMP-101', dateOfResignation: new Date('2025-02-01') }),
    ]
    vi.mocked(prisma.employee.count).mockResolvedValue(2)
    vi.mocked(prisma.employee.findMany).mockResolvedValue(resignedEmployees)

    const result = await getEmployeeList({ status: 'RESIGNED' })

    expect(result.employees).toHaveLength(2)
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dateOfResignation: expect.objectContaining({ not: null }),
        }),
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.5: View employee profile
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeById', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns complete employee record for a valid id', async () => {
    const employee = makeEmployee()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(employee)

    const result = await getEmployeeById('uuid-1')

    expect(result.id).toBe('uuid-1')
    expect(result.employeeId).toBe('EMP-100')
    expect(prisma.employee.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uuid-1' } })
    )
  })

  it('throws EMPLOYEE_NOT_FOUND when employee does not exist', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(null)

    await expect(getEmployeeById('nonexistent')).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
  })
})

describe('getEmployeeWageHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns wage history sorted by effectiveFrom descending', async () => {
    const entries = [
      makeWageHistory({ id: 'wh-3', effectiveFrom: new Date('2025-06-01') }),
      makeWageHistory({ id: 'wh-2', effectiveFrom: new Date('2025-03-01') }),
      makeWageHistory({ id: 'wh-1', effectiveFrom: new Date('2023-03-01') }),
    ]
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue(entries)

    const result = await getEmployeeWageHistory('uuid-1')

    expect(result).toHaveLength(3)
    expect(result[0].id).toBe('wh-3')
    expect(prisma.employeeWageHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employeeId: 'uuid-1' },
        orderBy: { effectiveFrom: 'desc' },
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.6: Edit employee
// ─────────────────────────────────────────────────────────────────────────────

describe('updateEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves changes and returns updated employee record', async () => {
    // GIVEN EMP-042 with phone = 9876543210
    const existing = makeEmployee({ phone: '9876543210' })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ phone: '1111111111' }))
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    const result = await updateEmployee('uuid-1', { phone: '1111111111' })

    expect(result.phone).toBe('1111111111')
  })

  it('creates new wage history entry when salary changes', async () => {
    const existing = makeEmployee()
    const existingWage = makeWageHistory({ weeklySalary: 12000 as unknown as EmployeeWageHistory['weeklySalary'] })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([existingWage])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await updateEmployee('uuid-1', { salary: 14000 })

    // THEN new wage history was created with new salary
    expect(prisma.employeeWageHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ weeklySalary: 14000 }),
      })
    )
  })

  it('closes previous wage history entry effectiveTo=today on salary change', async () => {
    const existing = makeEmployee()
    const existingWage = makeWageHistory()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([existingWage])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(makeWageHistory())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await updateEmployee('uuid-1', { salary: 14000 })

    // THEN previous wage history was closed
    expect(prisma.employeeWageHistory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employeeId: 'uuid-1', effectiveTo: null },
        data: expect.objectContaining({
          effectiveTo: expect.any(Date),
        }),
      })
    )
  })

  it('creates audit log with actionType UPDATE on any change', async () => {
    const existing = makeEmployee()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await updateEmployee('uuid-1', { site: 'North Gate' })

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'UPDATE',
          entityType: 'EMPLOYEE',
        }),
      })
    )
  })

  it('does NOT create wage history when only non-wage fields change', async () => {
    const existing = makeEmployee()
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(existing)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    await updateEmployee('uuid-1', { phone: '9999999999' })

    expect(prisma.employeeWageHistory.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.7: Deactivate / Reactivate
// ─────────────────────────────────────────────────────────────────────────────

describe('updateEmployee — deactivate / reactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets isActive to false when deactivating', async () => {
    const existing = makeEmployee({ isActive: true })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ isActive: false }))
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    const result = await updateEmployee('uuid-1', { isActive: false })

    expect(result.isActive).toBe(false)
  })

  it('sets isActive to true when reactivating', async () => {
    const existing = makeEmployee({ isActive: false })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ isActive: true }))
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    const result = await updateEmployee('uuid-1', { isActive: true })

    expect(result.isActive).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-02.8: Set Date of Resignation
// ─────────────────────────────────────────────────────────────────────────────

describe('updateEmployee — resignation date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves the resignation date on the employee record', async () => {
    const existing = makeEmployee({ dateOfResignation: null })
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(existing)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee({ dateOfResignation: new Date('2025-06-15') }))
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)

    const result = await updateEmployee('uuid-1', { dateOfResignation: new Date('2025-06-15') })

    expect(result.dateOfResignation).toEqual(new Date('2025-06-15'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E02.1 - US-E02.2: Sorting
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeList — sorting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.employee.count).mockResolvedValue(0)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([])
  })

  it('sorts by employeeId ascending when sortBy=employeeId, sortOrder=asc', async () => {
    await getEmployeeList({ sortBy: 'employeeId', sortOrder: 'asc' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { employeeId: 'asc' } })
    )
  })

  it('sorts by designation descending', async () => {
    await getEmployeeList({ sortBy: 'designation', sortOrder: 'desc' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { designation: 'desc' } })
    )
  })

  it('defaults to employeeName ascending when no sort specified', async () => {
    await getEmployeeList({})
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { employeeName: 'asc' } })
    )
  })

  it('sorts by site ascending', async () => {
    await getEmployeeList({ sortBy: 'site', sortOrder: 'asc' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { site: 'asc' } })
    )
  })

  it('sorts by status ascending: ACTIVE before INACTIVE before RESIGNED', async () => {
    await getEmployeeList({ sortBy: 'status', sortOrder: 'asc' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { dateOfResignation: 'asc' },
          { isActive: 'desc' }
        ]
      })
    )
  })

  it('sorts by status descending: RESIGNED before INACTIVE before ACTIVE', async () => {
    await getEmployeeList({ sortBy: 'status', sortOrder: 'desc' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { dateOfResignation: 'desc' },
          { isActive: 'asc' }
        ]
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E02.5 - US-E02.6: Distinct filter values
// ─────────────────────────────────────────────────────────────────────────────

describe('getDistinctDesignations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns sorted unique designation strings', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([
      { designation: 'Guard' } as never,
      { designation: 'Manager' } as never,
      { designation: 'Supervisor' } as never,
    ])
    const result = await getDistinctDesignations()
    expect(result).toEqual(['Guard', 'Manager', 'Supervisor'])
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { designation: true },
        distinct: ['designation'],
        orderBy: { designation: 'asc' },
      })
    )
  })
})

describe('getDistinctSites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns sorted unique non-null site strings', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([
      { site: 'North Gate' } as never,
      { site: 'South Gate' } as never,
    ])
    const result = await getDistinctSites()
    expect(result).toEqual(['North Gate', 'South Gate'])
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { site: true },
        distinct: ['site'],
        where: { site: { not: null } },
        orderBy: { site: 'asc' },
      })
    )
  })

  it('returns empty array when all sites are null', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([
      { site: null } as never,
      { site: null } as never,
    ])
    const result = await getDistinctSites()
    expect(result).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E02.7 - US-E02.9: Filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('getEmployeeList — filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.employee.count).mockResolvedValue(0)
    vi.mocked(prisma.employee.findMany).mockResolvedValue([])
  })

  it('filters by designation', async () => {
    await getEmployeeList({ designation: 'Guard' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ designation: 'Guard' })
      })
    )
  })

  it('filters by site', async () => {
    await getEmployeeList({ site: 'North Gate' })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ site: 'North Gate' })
      })
    )
  })

  it('designation + site + status + search all combine in the where clause', async () => {
    await getEmployeeList({
      designation: 'Guard',
      site: 'North Gate',
      status: 'ACTIVE',
      search: 'Ravi'
    })
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          designation: 'Guard',
          site: 'North Gate',
          isActive: true,
          OR: expect.arrayContaining([
            expect.objectContaining({ employeeName: expect.any(Object) })
          ])
        })
      })
    )
  })
})

// Issue #36: clearing an optional field on edit writes null
const OPTIONAL_FIELD_VALUES = {
  designationShort: 'GRD',
  nationalId: 'NID-1',
  aadhaarId: '1234 5678 9012',
  policeVerificationId: 'PV-1',
  phone: '9876543210',
  site: 'North Gate',
  healthCardId: 'HC-1',
  gPay: '9876543210',
  bankAccount: 'HDFC 1234',
  dateOfBirth: new Date('1990-01-01'),
  dateOfJoining: new Date('2024-01-01'),
  dateOfResignation: new Date('2025-06-01'),
} as const

const OPTIONAL_FIELDS = Object.keys(OPTIONAL_FIELD_VALUES) as (keyof typeof OPTIONAL_FIELD_VALUES)[]

describe('updateEmployee — clearing optional fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([makeWageHistory()])
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => Promise.all(promises as unknown as Promise<unknown>[]))
    vi.mocked(prisma.employee.update).mockResolvedValue(makeEmployee())
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as AuditLog)
  })

  it('writes gPay: null when GPay is cleared (regression)', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee({ gPay: '9876543210' }))

    await updateEmployee('uuid-1', { gPay: null })

    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gPay: null }) })
    )
  })

  it.each(OPTIONAL_FIELDS)('writes %s: null when it is cleared', async (field) => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(
      makeEmployee({ [field]: OPTIONAL_FIELD_VALUES[field] } as Partial<Employee>)
    )

    await updateEmployee('uuid-1', { [field]: null })

    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ [field]: null }) })
    )
  })

  it('leaves a field alone when it is absent', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue(makeEmployee({ gPay: '9876543210' }))

    await updateEmployee('uuid-1', { phone: '1111111111' })

    const [args] = vi.mocked(prisma.employee.update).mock.calls[0]
    expect(args.data).not.toHaveProperty('gPay')
  })
})

describe('UpdateEmployeeSchema — nullable optional fields', () => {
  it.each(OPTIONAL_FIELDS)('accepts null for %s', (field) => {
    expect(UpdateEmployeeSchema.safeParse({ [field]: null }).success).toBe(true)
  })

  it.each(['employeeName', 'designation', 'salary', 'hourlyRate'])('rejects null for %s', (field) => {
    expect(UpdateEmployeeSchema.safeParse({ [field]: null }).success).toBe(false)
  })

  it.each(['employeeName', 'designation'])('rejects "" for %s', (field) => {
    expect(UpdateEmployeeSchema.safeParse({ [field]: '' }).success).toBe(false)
  })
})
