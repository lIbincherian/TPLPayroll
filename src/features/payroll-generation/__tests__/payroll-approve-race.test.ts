import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// Fix round 3, item 1: approvePayroll must never leave two APPROVED/REVISED runs for one week.
// Layer 1: after the week row is locked the transaction looks for an approved run again (the check
// before the transaction ran without the lock). Layer 2: PayrollRun.approvedWeekStart is unique, so the
// database refuses a second run even if layer 1 were missed; a P2002 from the transaction is
// reported as PAYROLL_ALREADY_EXISTS. What a unit test cannot show is the row lock making a second
// approval wait: the "two approvals" test below models the lock with a mutex and says so.

// A separate transaction client, so what runs inside the transaction is told apart from what runs before it.
const tx = {
  $queryRaw: vi.fn(),
  payrollRun: { findFirst: vi.fn(), create: vi.fn() },
  payrollRevision: { create: vi.fn() },
  payrollRunEmployee: { createMany: vi.fn() },
  payrollAdjustmentApplication: { findMany: vi.fn(), updateMany: vi.fn() },
}

vi.mock('@/lib/prisma', () => ({
  default: {
    payrollRun: { findFirst: vi.fn(), create: vi.fn() },
    payrollRevision: { create: vi.fn() },
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
import { approvePayroll } from '@/features/payroll-generation/services/payroll.service'
import { PayrollServiceError, type PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')
const APPROVED_AT = new Date('2025-03-14T09:30:15.123Z')
const ALREADY = 'Payroll for this week is already approved'

const lockRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'upload-1',
  source: 'ETIMEOFFICE',
  status: 'APPROVED',
  syncLockedAt: null,
  approvedAt: APPROVED_AT,
  payrollWeekStartDate: WEEK_START,
  ...overrides,
})

function summary(): PayrollSummary {
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
  }
}

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

const p2002 = (target = 'approvedWeekStart') =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  })

function expectNothingWritten() {
  expect(tx.payrollRun.create).not.toHaveBeenCalled()
  expect(tx.payrollRevision.create).not.toHaveBeenCalled()
  expect(tx.payrollRunEmployee.createMany).not.toHaveBeenCalled()
  expect(tx.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
  expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  expect(skipAdjustmentApplication).not.toHaveBeenCalled()
  // Nothing outside the transaction either.
  expect(prisma.payrollRun.create).not.toHaveBeenCalled()
  expect(prisma.payrollRevision.create).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const model of [tx.payrollRun, tx.payrollRevision, tx.payrollRunEmployee, tx.payrollAdjustmentApplication]) {
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset()
  }
  tx.$queryRaw.mockReset()
  tx.$queryRaw.mockResolvedValue([lockRow()])
  tx.payrollRun.findFirst.mockResolvedValue(null)
  tx.payrollRun.create.mockResolvedValue({})
  tx.payrollRevision.create.mockResolvedValue({})
  tx.payrollRunEmployee.createMany.mockResolvedValue({ count: 1 })
  tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
  tx.payrollAdjustmentApplication.updateMany.mockResolvedValue({ count: 0 })

  vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(tx) : Promise.all(arg as Promise<unknown>[])) as never)
})

describe('the in-transaction re-check (layer 1)', () => {
  it('another approval committed after the pre-check: PAYROLL_ALREADY_EXISTS and nothing is created or carried forward', async () => {
    tx.payrollRun.findFirst.mockResolvedValue({ id: 'run-from-the-other-tab' })

    const error = await approvePayroll(summary()).catch((e) => e)

    expect(error).toBeInstanceOf(PayrollServiceError)
    expect(error).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: ALREADY })
    expectNothingWritten()
  })

  it('looks for the run with the same week and status filter as the pre-check, selecting only the id', async () => {
    await approvePayroll(summary())

    const where = { payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, status: { in: ['APPROVED', 'REVISED'] } }
    expect(prisma.payrollRun.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.payrollRun.findFirst).toHaveBeenCalledWith({ where })
    expect(tx.payrollRun.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.payrollRun.findFirst).toHaveBeenCalledWith({ where, select: { id: true } })
  })

  it('reads inside the transaction on tx, never on the plain client a second time', async () => {
    await approvePayroll(summary())

    // The plain client's findFirst is the pre-check only; the repeat is on the transaction client.
    expect(vi.mocked(prisma.payrollRun.findFirst).mock.calls).toHaveLength(1)
    expect(tx.payrollRun.findFirst).toHaveBeenCalledTimes(1)
    expect(order(prisma.payrollRun.findFirst)).toBeLessThan(order(prisma.$transaction))
    expect(order(tx.payrollRun.findFirst)).toBeGreaterThan(order(prisma.$transaction))
  })

  it('is ordered: week lock, then the run re-check, then the carry-forward read, then the run insert', async () => {
    await approvePayroll(summary())

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(order(tx.$queryRaw)).toBeLessThan(order(tx.payrollRun.findFirst))
    expect(order(tx.payrollRun.findFirst)).toBeLessThan(order(tx.payrollAdjustmentApplication.findMany))
    expect(order(tx.payrollAdjustmentApplication.findMany)).toBeLessThan(order(tx.payrollRun.create))
    expect(order(tx.payrollRun.create)).toBeLessThan(order(tx.payrollRevision.create))
  })

  it('a raced run wins over the attendance checks (the run is looked for straight after the lock)', async () => {
    tx.$queryRaw.mockResolvedValue([lockRow({ status: 'REVIEW', approvedAt: null })])
    tx.payrollRun.findFirst.mockResolvedValue({ id: 'run-1' })

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
    expectNothingWritten()
  })

  it('with no raced run the attendance checks still apply: reopened week is ATTENDANCE_NOT_APPROVED', async () => {
    tx.$queryRaw.mockResolvedValue([lockRow({ status: 'REVIEW', approvedAt: null })])

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_APPROVED' })
    expect(tx.payrollRun.findFirst).toHaveBeenCalledTimes(1)
    expectNothingWritten()
  })

  it('the pre-check still fails fast without opening a transaction or taking the lock', async () => {
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue({ id: 'run-1' } as never)

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: ALREADY })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.payrollRun.findFirst).not.toHaveBeenCalled()
  })

  it('a failed re-check releases nothing it did not take: the lock query ran once and the transaction was used once', async () => {
    tx.payrollRun.findFirst.mockResolvedValue({ id: 'run-1' })

    await approvePayroll(summary()).catch(() => undefined)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })
})

describe('the run row carries the unique week key (layer 2)', () => {
  it('payrollRun.create stores approvedWeekStart equal to the week start', async () => {
    await approvePayroll(summary())

    expect(tx.payrollRun.create).toHaveBeenCalledTimes(1)
    const { data } = tx.payrollRun.create.mock.calls[0][0]
    expect(data.approvedWeekStart).toBe(WEEK_START)
    expect(data.approvedWeekStart.getTime()).toBe(data.payrollWeekStartDate.getTime())
  })

  it('the rest of the run row is as before', async () => {
    const result = await approvePayroll(summary())

    expect(tx.payrollRun.create).toHaveBeenCalledWith({
      data: {
        id: result.payrollRunId,
        payrollWeekStartDate: WEEK_START,
        payrollWeekEndDate: WEEK_END,
        status: 'APPROVED',
        currentRevisionNumber: 1,
        totalRegularPay: 500,
        totalOvertimePay: 0,
        totalAdditions: 0,
        totalDeductions: 0,
        totalNetPayable: 500,
        approvedAt: result.approvedAt,
        approvedWeekStart: WEEK_START,
      },
    })
    expect(result).toMatchObject({ revisionNumber: 1, employeeCount: 1, totalNetPayable: 500 })
  })

  it('the revision and employee rows are not given the key (it belongs to the run only)', async () => {
    await approvePayroll(summary())

    expect(JSON.stringify(tx.payrollRevision.create.mock.calls[0][0])).not.toContain('approvedWeekStart')
    expect(JSON.stringify(tx.payrollRunEmployee.createMany.mock.calls[0][0])).not.toContain('approvedWeekStart')
  })
})

describe('a unique-key violation from the transaction (P2002)', () => {
  it('on the run insert becomes PAYROLL_ALREADY_EXISTS with the same message', async () => {
    tx.payrollRun.create.mockRejectedValue(p2002())

    const error = await approvePayroll(summary()).catch((e) => e)

    expect(error).toBeInstanceOf(PayrollServiceError)
    expect(error).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: ALREADY })
    expect(tx.payrollRevision.create).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.createMany).not.toHaveBeenCalled()
  })

  it('(pinned deviation) any P2002 in the transaction maps to PAYROLL_ALREADY_EXISTS, not only one on approvedWeekStart', async () => {
    tx.payrollRevision.create.mockRejectedValue(p2002('some_other_unique_index'))

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: ALREADY })
  })

  it('also maps when the violation is raised by the commit of the transaction call itself', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(p2002())

    await expect(approvePayroll(summary())).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
  })

  it.each([
    ['P2003 (foreign key)', 'P2003'],
    ['P2025 (record not found)', 'P2025'],
    ['P2034 (write conflict / deadlock)', 'P2034'],
  ])('%s is rethrown unchanged (same object), not turned into PAYROLL_ALREADY_EXISTS', async (_label, code) => {
    const boom = new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' })
    tx.payrollRun.create.mockRejectedValue(boom)

    const error = await approvePayroll(summary()).catch((e) => e)

    expect(error).toBe(boom)
    expect(error).not.toBeInstanceOf(PayrollServiceError)
  })

  it('an ordinary Error is rethrown unchanged', async () => {
    const boom = new Error('connection lost')
    tx.payrollRunEmployee.createMany.mockRejectedValue(boom)

    await expect(approvePayroll(summary())).rejects.toBe(boom)
  })

  it('a plain object that merely has code "P2002" is not a Prisma error and is rethrown unchanged', async () => {
    const lookalike = Object.assign(new Error('not prisma'), { code: 'P2002' })
    tx.payrollRun.create.mockRejectedValue(lookalike)

    const error = await approvePayroll(summary()).catch((e) => e)

    expect(error).toBe(lookalike)
    expect(error).not.toBeInstanceOf(PayrollServiceError)
  })

  it('the service errors raised inside the transaction pass through untouched (same instance)', async () => {
    tx.$queryRaw.mockResolvedValue([lockRow({ approvedAt: new Date(APPROVED_AT.getTime() + 1) })])

    const error = await approvePayroll(summary()).catch((e) => e)

    expect(error).toBeInstanceOf(PayrollServiceError)
    expect(error).toMatchObject({ code: 'ATTENDANCE_CHANGED' })
    expect(error.code).not.toBe('PAYROLL_ALREADY_EXISTS')
  })
})

describe('two approvals of one summary', () => {
  /**
   * A tiny model of the database: a table of runs and a mutex standing in for the week row lock (the
   * second transaction cannot start its reads until the first has finished). The mutex is part of this
   * test's model, not of the product; it is what the real `SELECT ... FOR UPDATE` provides and what the
   * local database cannot demonstrate. What is under test is that the second transaction looks again.
   */
  function installModelDb(opts: { enforceUniqueKey: boolean }) {
    const runs: Array<{ id: string; approvedWeekStart: Date | null }> = []
    let tail: Promise<unknown> = Promise.resolve()

    // Both callers made their pre-check before either committed: it always answers "no run yet".
    vi.mocked(prisma.payrollRun.findFirst).mockResolvedValue(null)
    tx.payrollRun.findFirst.mockImplementation((async () => (runs.length > 0 ? { id: runs[0].id } : null)) as never)
    tx.payrollRun.create.mockImplementation((async ({ data }: { data: { id: string; approvedWeekStart: Date | null } }) => {
      if (opts.enforceUniqueKey && runs.some((r) => r.approvedWeekStart?.getTime() === data.approvedWeekStart?.getTime())) {
        throw p2002()
      }
      runs.push({ id: data.id, approvedWeekStart: data.approvedWeekStart })
      return {}
    }) as never)
    vi.mocked(prisma.$transaction).mockImplementation(((fn: (t: typeof tx) => Promise<unknown>) => {
      const run = tail.then(() => fn(tx))
      tail = run.catch(() => undefined)
      return run
    }) as never)
    return runs
  }

  it('started together: exactly one run is created and the other call is PAYROLL_ALREADY_EXISTS', async () => {
    const runs = installModelDb({ enforceUniqueKey: true })

    const results = await Promise.allSettled([approvePayroll(summary()), approvePayroll(summary())])

    expect(runs).toHaveLength(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS', message: ALREADY })
    expect(tx.payrollRevision.create).toHaveBeenCalledTimes(1)
    expect(tx.payrollRunEmployee.createMany).toHaveBeenCalledTimes(1)
  })

  it('the second call is stopped by the re-check alone, without needing the unique key', async () => {
    const runs = installModelDb({ enforceUniqueKey: false })

    const results = await Promise.allSettled([approvePayroll(summary()), approvePayroll(summary())])

    expect(runs).toHaveLength(1)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    // The second transaction found the first one's run and never reached the insert.
    expect(tx.payrollRun.create).toHaveBeenCalledTimes(1)
    expect(tx.payrollRun.findFirst).toHaveBeenCalledTimes(2)
  })

  it('without the re-check (the pre-check answered "none" for both) the unique key still leaves one run', async () => {
    const runs = installModelDb({ enforceUniqueKey: true })
    tx.payrollRun.findFirst.mockResolvedValue(null) // switch layer 1 off: the key is the floor

    const results = await Promise.allSettled([approvePayroll(summary()), approvePayroll(summary())])

    expect(runs).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ code: 'PAYROLL_ALREADY_EXISTS' })
  })
})
