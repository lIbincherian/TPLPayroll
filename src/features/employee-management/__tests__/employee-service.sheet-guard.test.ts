// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee, EmployeeWageHistory } from '@prisma/client'

vi.mock('@/lib/prisma', () => ({
  default: {
    employee: { findUnique: vi.fn(), update: vi.fn() },
    employeeWageHistory: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    settings: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import prisma from '@/lib/prisma'
import { EMPTY_SHEET_PROFILE } from '@/features/employee-management/lib/sheet-profile'
import { bulkUpdateStatus, updateEmployee } from '@/features/employee-management/services/employee.service'

const employee = {
  id: 'uuid-1',
  employeeImportBatchId: null,
  ...EMPTY_SHEET_PROFILE,
  employeeId: 'EMP-100',
  serialNumber: null,
  employeeName: 'Ravi Kumar',
  nationalId: null,
  designation: 'Guard',
  dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
  aadhaarId: null,
  policeVerificationId: null,
  phone: '9876543210',
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
} as unknown as Employee

const wage = {
  id: 'w1',
  employeeId: 'uuid-1',
  weeklySalary: 800,
  hourlyRate: 100,
  effectiveFrom: new Date('2025-01-01'),
  effectiveTo: null,
  changeSource: 'MANUAL',
} as unknown as EmployeeWageHistory

function syncOn(on: boolean) {
  vi.mocked(prisma.settings.findUnique).mockResolvedValue(
    on ? ({ employeeSheetSyncEnabled: true } as never) : ({ employeeSheetSyncEnabled: false } as never),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.employee.findUnique).mockResolvedValue(employee)
  vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([wage])
  vi.mocked(prisma.$transaction).mockImplementation(async (ops) => Promise.all(ops as unknown as Promise<unknown>[]))
  vi.mocked(prisma.employee.update).mockResolvedValue(employee)
  vi.mocked(prisma.employeeWageHistory.updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.employeeWageHistory.create).mockResolvedValue(wage)
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never)
})

describe('updateEmployee server guard (sync on)', () => {
  beforeEach(() => syncOn(true))

  it.each([
    ['employeeName', { employeeName: 'New Name' }],
    ['designation', { designation: 'Driver' }],
    ['phone', { phone: '1111111111' }],
    ['site', { site: 'South' }],
    ['dateOfJoining', { dateOfJoining: new Date('2025-02-01T00:00:00.000Z') }],
    ['bankAccount', { bankAccount: '555' }],
  ])('rejects a change to %s with SHEET_MANAGED and writes nothing', async (field, input) => {
    await expect(updateEmployee('uuid-1', input)).rejects.toMatchObject({ code: 'SHEET_MANAGED' })
    await expect(updateEmployee('uuid-1', input)).rejects.toThrow(field)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.employee.update).not.toHaveBeenCalled()
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects clearing a sheet-owned value', async () => {
    await expect(updateEmployee('uuid-1', { phone: null })).rejects.toMatchObject({ code: 'SHEET_MANAGED' })
  })

  it('allows an unchanged resubmission of sheet-owned fields together with a wage change', async () => {
    await expect(
      updateEmployee('uuid-1', {
        employeeName: 'Ravi Kumar',
        designation: 'Guard',
        phone: '9876543210',
        site: 'North Gate',
        dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
        dateOfResignation: null,
        salary: 900,
      }),
    ).resolves.toBeDefined()
    expect(prisma.employeeWageHistory.create).toHaveBeenCalledTimes(1)
  })

  it('allows a status change and a wage change', async () => {
    await expect(updateEmployee('uuid-1', { isActive: false })).resolves.toBeDefined()
    await expect(updateEmployee('uuid-1', { salary: 1000 })).resolves.toBeDefined()
  })

  it('on a wage change, closes the open row before creating the new one (partial unique index safety)', async () => {
    await updateEmployee('uuid-1', { salary: 1000 })
    const close = vi.mocked(prisma.employeeWageHistory.updateMany).mock.invocationCallOrder[0]
    const open = vi.mocked(prisma.employeeWageHistory.create).mock.invocationCallOrder[0]
    expect(close).toBeLessThan(open)
  })
})

describe('updateEmployee server guard (sync off)', () => {
  it('lets sheet-owned fields change when the setting is off', async () => {
    syncOn(false)
    await expect(updateEmployee('uuid-1', { employeeName: 'New Name', phone: '1' })).resolves.toBeDefined()
    expect(prisma.employee.update).toHaveBeenCalled()
  })

  it('lets them change when there is no settings row', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null)
    await expect(updateEmployee('uuid-1', { site: 'Z' })).resolves.toBeDefined()
  })
})

describe('updateEmployee date and text round-trips (sync on)', () => {
  beforeEach(() => syncOn(true))

  it('a stored date that is not UTC midnight, resubmitted as the same day, is not an edit and is not written', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      ...employee,
      dateOfJoining: new Date('2025-01-01T05:30:00.000Z'),
      phone: ' 9876543210 ',
      nationalId: '',
    } as unknown as Employee)
    await expect(
      updateEmployee('uuid-1', {
        dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
        phone: '9876543210',
        nationalId: null,
        salary: 900,
      }),
    ).resolves.toBeDefined()
    const data = vi.mocked(prisma.employee.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty('dateOfJoining')
    expect(data).not.toHaveProperty('phone')
    expect(prisma.employeeWageHistory.create).toHaveBeenCalledTimes(1)
  })

  it('a different calendar day is still refused', async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValue({
      ...employee,
      dateOfJoining: new Date('2025-01-01T05:30:00.000Z'),
    } as unknown as Employee)
    await expect(
      updateEmployee('uuid-1', { dateOfJoining: new Date('2025-01-02T00:00:00.000Z') }),
    ).rejects.toMatchObject({ code: 'SHEET_MANAGED' })
  })
})

describe('bulkUpdateStatus while the sheet sync is on', () => {
  it('refuses MARK RESIGNED with SHEET_MANAGED and writes nothing', async () => {
    syncOn(true)
    await expect(
      bulkUpdateStatus({ ids: ['uuid-1'], status: 'RESIGNED', dateOfResignation: new Date('2026-11-01') }),
    ).rejects.toMatchObject({ code: 'SHEET_MANAGED' })
    expect(prisma.employee.findUnique).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('still allows MARK INACTIVE (status is app-owned)', async () => {
    syncOn(true)
    await expect(bulkUpdateStatus({ ids: ['uuid-1'], status: 'INACTIVE' })).resolves.toMatchObject({ succeeded: 1 })
  })

  it('allows MARK RESIGNED when the sync is off', async () => {
    syncOn(false)
    await expect(
      bulkUpdateStatus({ ids: ['uuid-1'], status: 'RESIGNED', dateOfResignation: new Date('2026-11-01') }),
    ).resolves.toMatchObject({ succeeded: 1 })
  })
})
