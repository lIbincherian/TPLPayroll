import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the prisma module before importing the service
vi.mock('@/lib/prisma', () => ({
  default: {
    employee: {
      count: vi.fn(),
    },
    payrollRevision: {
      findFirst: vi.fn(),
    },
    attendanceUpload: {
      count: vi.fn(),
    },
    payrollAdjustmentApplication: {
      count: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import {
  countActiveEmployees,
  getLatestPayrollTotal,
  countAttendanceWeeksAwaitingReview,
  countPendingAdjustmentApprovals,
} from '@/services/dashboard.service'

// ─────────────────────────────────────────────────────────────────────────────
// US-01.1: countActiveEmployees
// ─────────────────────────────────────────────────────────────────────────────
describe('countActiveEmployees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns correct count of active employees', async () => {
    // GIVEN employees table has 10 active, 3 inactive, 2 resigned
    vi.mocked(prisma.employee.count).mockResolvedValue(10)

    // WHEN
    const result = await countActiveEmployees()

    // THEN
    expect(result).toBe(10)
    expect(prisma.employee.count).toHaveBeenCalledWith({
      where: { isActive: true },
    })
  })

  it('returns 0 when no employees exist', async () => {
    vi.mocked(prisma.employee.count).mockResolvedValue(0)

    const result = await countActiveEmployees()

    expect(result).toBe(0)
  })

  it('excludes inactive employees — only queries isActive: true', async () => {
    // GIVEN employees table has 5 employees all with isActive = false
    // Mocked DB returns 0 because filter isActive: true yields nothing
    vi.mocked(prisma.employee.count).mockResolvedValue(0)

    const result = await countActiveEmployees()

    expect(result).toBe(0)
    expect(prisma.employee.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-01.2: getLatestPayrollTotal
// ─────────────────────────────────────────────────────────────────────────────
describe('getLatestPayrollTotal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the most recent approved run total as a number', async () => {
    // GIVEN two approved payroll runs — run A (₹80,000, older) and run B (₹95,000.50, newer)
    // findFirst with orderBy approvedAt desc returns run B's revision
    vi.mocked(prisma.payrollRevision.findFirst).mockResolvedValue({
      totalNetPayable: 95000.50 as unknown as never,
    } as never)

    // WHEN
    const result = await getLatestPayrollTotal()

    // THEN
    expect(result).toBe(95000.5)
  })

  it('returns 0 when no approved runs exist', async () => {
    vi.mocked(prisma.payrollRevision.findFirst).mockResolvedValue(null)

    const result = await getLatestPayrollTotal()

    expect(result).toBe(0)
  })

  it('uses the current revision total (isCurrent = true)', async () => {
    // GIVEN a payroll run has revision 1 (₹80,000) and revision 2 (₹85,000, isCurrent = true)
    vi.mocked(prisma.payrollRevision.findFirst).mockResolvedValue({
      totalNetPayable: 85000 as unknown as never,
    } as never)

    const result = await getLatestPayrollTotal()

    // THEN returns revision 2 total
    expect(result).toBe(85000)
    // AND the query always filters isCurrent: true
    expect(prisma.payrollRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isCurrent: true }),
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-01.3: countAttendanceWeeksAwaitingReview (F12 — replaces countPendingAttendanceErrors)
// ─────────────────────────────────────────────────────────────────────────────
describe('countAttendanceWeeksAwaitingReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the count of eTimeOffice weeks that failed to sync or await review', async () => {
    // GIVEN 3 active attendance weeks: 1 SYNC_FAILED, 1 REVIEW, 1 APPROVED
    // DB returns 2 (the two that are not approved)
    vi.mocked(prisma.attendanceUpload.count).mockResolvedValue(2)

    // WHEN
    const result = await countAttendanceWeeksAwaitingReview()

    // THEN
    expect(result).toBe(2)
    expect(prisma.attendanceUpload.count).toHaveBeenCalledWith({
      where: {
        isActiveForPayrollWeek: true,
        source: 'ETIMEOFFICE',
        status: { in: ['SYNC_FAILED', 'REVIEW'] },
      },
    })
  })

  it('returns 0 when every eTimeOffice week is approved', async () => {
    // GIVEN 2 active attendance weeks, both approved
    vi.mocked(prisma.attendanceUpload.count).mockResolvedValue(0)

    const result = await countAttendanceWeeksAwaitingReview()

    expect(result).toBe(0)
  })

  it('never counts approved weeks, Excel-era weeks or superseded rows', async () => {
    vi.mocked(prisma.attendanceUpload.count).mockResolvedValue(0)

    await countAttendanceWeeksAwaitingReview()

    const where = vi.mocked(prisma.attendanceUpload.count).mock.calls[0][0]?.where as {
      isActiveForPayrollWeek: boolean
      source: string
      status: { in: string[] }
    }
    expect(where.source).toBe('ETIMEOFFICE') // Excel-era rows (READY / ERRORS) are read-only
    expect(where.isActiveForPayrollWeek).toBe(true)
    expect(where.status.in.sort()).toEqual(['REVIEW', 'SYNC_FAILED'])
    expect(where.status.in).not.toContain('APPROVED')
  })

  it('propagates a database failure instead of showing a count of 0', async () => {
    vi.mocked(prisma.attendanceUpload.count).mockRejectedValue(new Error('db down'))

    await expect(countAttendanceWeeksAwaitingReview()).rejects.toThrow('db down')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-01.4: countPendingAdjustmentApprovals
// ─────────────────────────────────────────────────────────────────────────────
describe('countPendingAdjustmentApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns correct count of pending adjustment approvals', async () => {
    // GIVEN 5 adjustment applications with approvalStatus PENDING, 3 with APPROVED
    vi.mocked(prisma.payrollAdjustmentApplication.count).mockResolvedValue(5)

    // WHEN
    const result = await countPendingAdjustmentApprovals()

    // THEN
    expect(result).toBe(5)
    expect(prisma.payrollAdjustmentApplication.count).toHaveBeenCalledWith({
      where: { approvalStatus: 'PENDING' },
    })
  })

  it('returns 0 when no adjustments are pending', async () => {
    vi.mocked(prisma.payrollAdjustmentApplication.count).mockResolvedValue(0)

    const result = await countPendingAdjustmentApprovals()

    expect(result).toBe(0)
  })
})
