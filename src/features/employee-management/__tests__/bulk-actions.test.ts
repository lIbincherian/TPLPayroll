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
import { plainPromiseMock } from '@/__tests__/helpers/plain-promise-mock'
import {
  bulkUpdateStatus,
  bulkUpdateHourlyRate,
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

/**
 * Helper to mock Prisma.$transaction (array form) — captures updates and audit logs
 * via top-level prisma method mocks.
 */
function setupTransactionMock() {
  const capturedUpdates: { id: string; data: Record<string, unknown> }[] = []
  const capturedAuditLogs: { data: Record<string, unknown> }[] = []
  const capturedWageCreates: { data: Record<string, unknown> }[] = []
  const capturedWageUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = []

  plainPromiseMock(prisma.employee.update).mockImplementation(async (args) => {
    capturedUpdates.push({ id: (args as { where: { id: string } }).where.id, data: (args as { data: Record<string, unknown> }).data })
    return makeEmployee({ ...(args as { data: Record<string, unknown> }).data, id: (args as { where: { id: string } }).where.id })
  })

  plainPromiseMock(prisma.employeeWageHistory.create).mockImplementation(async (args) => {
    capturedWageCreates.push(args as { data: Record<string, unknown> })
    return { id: 'new-wh-' + capturedWageCreates.length, ...(args as { data: Record<string, unknown> }).data } as EmployeeWageHistory
  })

  plainPromiseMock(prisma.employeeWageHistory.updateMany).mockImplementation(async (args) => {
    capturedWageUpdates.push(args as { where: Record<string, unknown>; data: Record<string, unknown> })
    return { count: 1 }
  })

  plainPromiseMock(prisma.auditLog.create).mockImplementation(async (args) => {
    capturedAuditLogs.push(args as { data: Record<string, unknown> })
    return {} as AuditLog
  })

  vi.mocked(prisma.$transaction).mockImplementation(async (promises) =>
    Promise.all(promises as unknown as Promise<unknown>[])
  )

  return { capturedUpdates, capturedAuditLogs, capturedWageCreates, capturedWageUpdates }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.3: Bulk mark employees as Resigned
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkUpdateStatus — Resigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks employees as resigned with the given date', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', employeeId: 'EMP-001' }),
      makeEmployee({ id: 'uuid-2', employeeId: 'EMP-002' }),
      makeEmployee({ id: 'uuid-3', employeeId: 'EMP-003' }),
    ]
    const resignDate = new Date('2026-06-01')

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    const { capturedUpdates } = setupTransactionMock()

    const result = await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      status: 'RESIGNED',
      dateOfResignation: resignDate,
    })

    expect(result.succeeded).toBe(3)
    expect(result.failed).toBe(0)
    expect(capturedUpdates).toHaveLength(3)
    capturedUpdates.forEach((u) => {
      expect(u.data.dateOfResignation).toEqual(resignDate)
    })
  })

  it('creates audit logs for each employee', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', employeeId: 'EMP-001' }),
      makeEmployee({ id: 'uuid-2', employeeId: 'EMP-002' }),
      makeEmployee({ id: 'uuid-3', employeeId: 'EMP-003' }),
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    const { capturedAuditLogs } = setupTransactionMock()

    await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      status: 'RESIGNED',
      dateOfResignation: new Date('2026-06-01'),
    })

    expect(capturedAuditLogs).toHaveLength(3)
    capturedAuditLogs.forEach((log) => {
      expect(log.data.actionType).toBe('UPDATE')
      expect(log.data.entityType).toBe('EMPLOYEE')
    })
  })

  it('handles partial failure when an employee does not exist', async () => {
    // GIVEN: uuid-1 exists, uuid-2 exists, uuid-GHOST does not
    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      if (id === 'uuid-1') return makeEmployee({ id: 'uuid-1' })
      if (id === 'uuid-2') return makeEmployee({ id: 'uuid-2' })
      return null
    })

    setupTransactionMock()

    const result = await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-GHOST'],
      status: 'RESIGNED',
      dateOfResignation: new Date('2026-06-01'),
    })

    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].employeeId).toBe('uuid-GHOST')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.4: Bulk mark employees as Inactive
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkUpdateStatus — Inactive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks employees as inactive', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', isActive: true }),
      makeEmployee({ id: 'uuid-2', isActive: true }),
      makeEmployee({ id: 'uuid-3', isActive: true }),
      makeEmployee({ id: 'uuid-4', isActive: true }),
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    const { capturedUpdates } = setupTransactionMock()

    const result = await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4'],
      status: 'INACTIVE',
    })

    expect(result.succeeded).toBe(4)
    capturedUpdates.forEach((u) => {
      expect(u.data.isActive).toBe(false)
    })
  })

  it('skips already-inactive employees', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', isActive: true }),
      makeEmployee({ id: 'uuid-2', isActive: true }),
      makeEmployee({ id: 'uuid-3', isActive: false }), // already inactive
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    setupTransactionMock()

    const result = await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      status: 'INACTIVE',
    })

    expect(result.succeeded).toBe(2)
    expect(result.skipped).toBe(1)
  })

  it('creates audit logs only for changed employees', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', isActive: true }),
      makeEmployee({ id: 'uuid-2', isActive: true }),
      makeEmployee({ id: 'uuid-3', isActive: false }), // already inactive — skipped
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    const { capturedAuditLogs } = setupTransactionMock()

    await bulkUpdateStatus({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      status: 'INACTIVE',
    })

    // Only 2 audit logs — skipped employee should not get one
    expect(capturedAuditLogs).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.5: Bulk change hourly rate
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkUpdateHourlyRate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates hourly rates and creates wage history entries', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1', employeeId: 'EMP-010' }),
      makeEmployee({ id: 'uuid-2', employeeId: 'EMP-011' }),
      makeEmployee({ id: 'uuid-3', employeeId: 'EMP-012' }),
    ]
    const wages = [
      makeWageHistory({ id: 'wh-1', employeeId: 'uuid-1', hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'], weeklySalary: 14000 as unknown as EmployeeWageHistory['weeklySalary'] }),
      makeWageHistory({ id: 'wh-2', employeeId: 'uuid-2', hourlyRate: 55 as unknown as EmployeeWageHistory['hourlyRate'], weeklySalary: 12000 as unknown as EmployeeWageHistory['weeklySalary'] }),
      makeWageHistory({ id: 'wh-3', employeeId: 'uuid-3', hourlyRate: 70 as unknown as EmployeeWageHistory['hourlyRate'], weeklySalary: 15000 as unknown as EmployeeWageHistory['weeklySalary'] }),
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    plainPromiseMock(prisma.employeeWageHistory.findMany).mockImplementation(async (args) => {
      const empId = (args as { where: { employeeId: string } }).where.employeeId
      return wages.filter((w) => w.employeeId === empId)
    })

    const { capturedWageCreates, capturedWageUpdates } = setupTransactionMock()

    const result = await bulkUpdateHourlyRate({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      newHourlyRate: 75.00,
    })

    expect(result.succeeded).toBe(3)
    expect(capturedWageCreates).toHaveLength(3)
    capturedWageCreates.forEach((wc) => {
      expect(Number(wc.data.hourlyRate)).toBe(75)
    })
    // Previous wage entries should be closed
    expect(capturedWageUpdates).toHaveLength(3)
  })

  it('skips employees with matching rate', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1' }),
      makeEmployee({ id: 'uuid-2' }),
      makeEmployee({ id: 'uuid-3' }),
    ]
    const wages = [
      makeWageHistory({ employeeId: 'uuid-1', hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'] }),
      makeWageHistory({ employeeId: 'uuid-2', hourlyRate: 75 as unknown as EmployeeWageHistory['hourlyRate'] }), // matches!
      makeWageHistory({ employeeId: 'uuid-3', hourlyRate: 70 as unknown as EmployeeWageHistory['hourlyRate'] }),
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    plainPromiseMock(prisma.employeeWageHistory.findMany).mockImplementation(async (args) => {
      const empId = (args as { where: { employeeId: string } }).where.employeeId
      return wages.filter((w) => w.employeeId === empId)
    })

    setupTransactionMock()

    const result = await bulkUpdateHourlyRate({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      newHourlyRate: 75.00,
    })

    expect(result.succeeded).toBe(2)
    expect(result.skipped).toBe(1)
  })

  it('preserves weekly salary in new wage history', async () => {
    const employee = makeEmployee({ id: 'uuid-1' })
    const wage = makeWageHistory({
      employeeId: 'uuid-1',
      weeklySalary: 14000 as unknown as EmployeeWageHistory['weeklySalary'],
      hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'],
    })

    vi.mocked(prisma.employee.findUnique).mockResolvedValue(employee)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([wage])

    const { capturedWageCreates } = setupTransactionMock()

    await bulkUpdateHourlyRate({
      ids: ['uuid-1'],
      newHourlyRate: 75.00,
    })

    expect(capturedWageCreates).toHaveLength(1)
    expect(Number(capturedWageCreates[0].data.weeklySalary)).toBe(14000)
    expect(Number(capturedWageCreates[0].data.hourlyRate)).toBe(75)
  })

  it('creates audit logs for each changed employee', async () => {
    const employees = [
      makeEmployee({ id: 'uuid-1' }),
      makeEmployee({ id: 'uuid-2' }),
      makeEmployee({ id: 'uuid-3' }),
    ]
    const wages = [
      makeWageHistory({ employeeId: 'uuid-1', hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'] }),
      makeWageHistory({ employeeId: 'uuid-2', hourlyRate: 55 as unknown as EmployeeWageHistory['hourlyRate'] }),
      makeWageHistory({ employeeId: 'uuid-3', hourlyRate: 70 as unknown as EmployeeWageHistory['hourlyRate'] }),
    ]

    plainPromiseMock(prisma.employee.findUnique).mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id
      return employees.find((e) => e.id === id) ?? null
    })

    plainPromiseMock(prisma.employeeWageHistory.findMany).mockImplementation(async (args) => {
      const empId = (args as { where: { employeeId: string } }).where.employeeId
      return wages.filter((w) => w.employeeId === empId)
    })

    const { capturedAuditLogs } = setupTransactionMock()

    await bulkUpdateHourlyRate({
      ids: ['uuid-1', 'uuid-2', 'uuid-3'],
      newHourlyRate: 75.00,
    })

    expect(capturedAuditLogs).toHaveLength(3)
    capturedAuditLogs.forEach((log) => {
      expect(log.data.actionType).toBe('UPDATE')
      expect(log.data.entityType).toBe('WAGE_HISTORY')
    })
  })

  it('uses custom effective date', async () => {
    const employee = makeEmployee({ id: 'uuid-1' })
    const wage = makeWageHistory({ employeeId: 'uuid-1', hourlyRate: 62.5 as unknown as EmployeeWageHistory['hourlyRate'] })
    const customDate = new Date('2026-07-01')

    vi.mocked(prisma.employee.findUnique).mockResolvedValue(employee)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([wage])

    const { capturedWageCreates, capturedWageUpdates } = setupTransactionMock()

    await bulkUpdateHourlyRate({
      ids: ['uuid-1'],
      newHourlyRate: 80.00,
      effectiveFrom: customDate,
    })

    expect(capturedWageCreates).toHaveLength(1)
    expect(capturedWageCreates[0].data.effectiveFrom).toEqual(customDate)
    expect(capturedWageUpdates).toHaveLength(1)
    expect(capturedWageUpdates[0].data.effectiveTo).toEqual(customDate)
  })

  it('rejects zero hourly rate', async () => {
    await expect(
      bulkUpdateHourlyRate({ ids: ['uuid-1'], newHourlyRate: 0 })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })
})
