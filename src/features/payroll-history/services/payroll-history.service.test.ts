import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    payrollRunEmployee: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    payrollRun: {
      findMany: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import {
  searchPayrollHistory,
  getPayrollHistoryByWeek,
  getPayrollRecordDetail,
  getApprovedPayrollWeeks,
} from './payroll-history.service'

const mockDate = new Date('2025-03-06T00:00:00.000Z')

class MockDecimal {
  constructor(private value: number) {}
  toNumber() { return this.value; }
  add(other: MockDecimal) { return new MockDecimal(this.value + other.toNumber()); }
  toString() { return this.value.toString(); }
}

function makeRunEmployee(overrides = {}) {
  return {
    id: 'prem-uuid-1',
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'rev-uuid-1',
    employeeId: 'emp-uuid-1',
    regularHours: new MockDecimal(46),
    overtimeHours: new MockDecimal(6.5),
    regularPay: new MockDecimal(2875),
    overtimePay: new MockDecimal(406.25),
    additions: new MockDecimal(200),
    deductions: new MockDecimal(2150),
    netPayable: new MockDecimal(1331.25),
    hourlyRateUsed: new MockDecimal(68.75),
    employee: {
      employeeName: 'Ravi Kumar',
      employeeId: 'EMP-001',
      designation: 'Guard',
    },
    payrollRun: {
      payrollWeekStartDate: new Date('2025-03-06T00:00:00.000Z'),
      payrollWeekEndDate: new Date('2025-03-12T00:00:00.000Z'),
      status: 'APPROVED',
    },
    payrollRevision: {
      revisionNumber: 2,
      isCurrent: true,
    },
    ...overrides,
  }
}

describe('F09 — Payroll History Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // US-09.1: Search payroll history by employee
  describe('searchPayrollHistory', () => {
    it('searches by employee name (case-insensitive) and returns their history', async () => {
      vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
        makeRunEmployee(),
        makeRunEmployee({ id: 'prem-uuid-2' })
      ] as never)

      const result = await searchPayrollHistory({ employeeName: 'Ravi' })

      expect(prisma.payrollRunEmployee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            employee: { employeeName: { contains: 'Ravi', mode: 'insensitive' } },
            payrollRun: { status: { in: ['APPROVED', 'REVISED'] } },
            payrollRevision: { isCurrent: true },
          },
          include: { employee: true, payrollRun: true, payrollRevision: true },
          orderBy: { payrollRun: { payrollWeekStartDate: 'desc' } }
        })
      )
      expect(result).toHaveLength(2)
      expect(result[0].employeeName).toBe('Ravi Kumar')
    })

    it('searches by employee ID and returns their history', async () => {
      vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
        makeRunEmployee()
      ] as never)

      const result = await searchPayrollHistory({ employeeId: 'EMP-001' })

      expect(prisma.payrollRunEmployee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            employee: { employeeId: { contains: 'EMP-001', mode: 'insensitive' } },
            payrollRun: { status: { in: ['APPROVED', 'REVISED'] } },
            payrollRevision: { isCurrent: true },
          }
        })
      )
      expect(result).toHaveLength(1)
    })

    it('returns empty for unknown employee', async () => {
      vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([])

      const result = await searchPayrollHistory({ employeeName: 'Nobody' })

      expect(result).toHaveLength(0)
    })
  })

  // US-09.2: Search payroll history by payroll week
  describe('getPayrollHistoryByWeek', () => {
    it('returns all employees for the week, from current revision', async () => {
      vi.mocked(prisma.payrollRunEmployee.findMany).mockResolvedValue([
        makeRunEmployee(),
        makeRunEmployee({ id: 'prem-uuid-3', employee: { employeeName: 'Lakshmi Venkatesh', employeeId: 'EMP-042', designation: 'Guard' } })
      ] as never)

      const result = await getPayrollHistoryByWeek('2025-03-06', '2025-03-12')

      expect(prisma.payrollRunEmployee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            payrollRun: { 
              payrollWeekStartDate: new Date('2025-03-06'), 
              payrollWeekEndDate: new Date('2025-03-12'),
              status: { in: ['APPROVED', 'REVISED'] }
            },
            payrollRevision: { isCurrent: true }
          }
        })
      )
      expect(result).toHaveLength(2)
      expect(result[1].employeeName).toBe('Lakshmi Venkatesh')
    })
  })

  describe('getApprovedPayrollWeeks', () => {
    it('returns a list of distinct approved payroll weeks', async () => {
      vi.mocked(prisma.payrollRun.findMany).mockResolvedValue([
        { payrollWeekStartDate: mockDate, payrollWeekEndDate: mockDate }
      ] as never)

      const result = await getApprovedPayrollWeeks()

      expect(prisma.payrollRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: ['APPROVED', 'REVISED'] } },
          select: { payrollWeekStartDate: true, payrollWeekEndDate: true },
          distinct: ['payrollWeekStartDate', 'payrollWeekEndDate'],
          orderBy: { payrollWeekStartDate: 'desc' }
        })
      )
      expect(result).toHaveLength(1)
    })
  })

  // US-09.3: View detailed payroll record
  describe('getPayrollRecordDetail', () => {
    it('returns full breakdown for a specific record ID', async () => {
      vi.mocked(prisma.payrollRunEmployee.findUnique).mockResolvedValue({
        ...makeRunEmployee(),
        employee: {
          ...makeRunEmployee().employee,
          attendanceRecords: [
            { attendanceDate: new Date('2025-03-06'), regularHours: new MockDecimal(8), overtimeHours: new MockDecimal(2) },
            { attendanceDate: new Date('2025-03-07'), regularHours: new MockDecimal(8), overtimeHours: new MockDecimal(0) },
          ]
        },
        payrollRun: {
          ...makeRunEmployee().payrollRun,
          adjustmentApplications: [
            { 
              employeeId: 'emp-uuid-1',
              appliedAmount: new MockDecimal(200),
              payrollAdjustment: { adjustmentType: 'ADDITION', reason: 'Transport allowance' }
            },
            { 
              employeeId: 'emp-uuid-1',
              appliedAmount: new MockDecimal(2150),
              payrollAdjustment: { adjustmentType: 'DEDUCTION', reason: 'Advance recovery' }
            }
          ]
        }
      } as never)

      const result = await getPayrollRecordDetail('prem-uuid-1')

      expect(prisma.payrollRunEmployee.findUnique).toHaveBeenCalled()
      expect(result.regularPay.toString()).toBe('2875')
      expect(result.attendance).toHaveLength(2)
      expect(result.adjustments).toHaveLength(2)
      expect(result.adjustments[0].type).toBe('ADDITION')
      expect(result.adjustments[0].reason).toBe('Transport allowance')
    })
    
    it('throws error if record not found', async () => {
      vi.mocked(prisma.payrollRunEmployee.findUnique).mockResolvedValue(null)
      
      await expect(getPayrollRecordDetail('non-existent')).rejects.toThrow('Payroll record not found')
    })
  })
})
