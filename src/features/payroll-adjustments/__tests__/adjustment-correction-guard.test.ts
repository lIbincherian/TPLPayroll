/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// While a correction is open for a week its adjustment applications are the correction's: it reset them to
// PENDING and settles every balance once, when its revision is approved. A weekly approve, skip, edit or cancel
// in the meantime would move the same balance for a row the correction settles again, so each is refused with
// CORRECTION_IN_PROGRESS and writes nothing.
//
// Also here: the weekly approve and skip take the adjustment's row lock inside a transaction and read the
// application and the adjustment again after it (the race fix). The lock itself needs a real database; what is
// proved here is the sequencing, the re-read under the lock and the all-or-nothing writes. The lock against a
// real Postgres is in src/__tests__/db/f12-settlement.db.test.ts.

vi.mock('@/lib/prisma', () => ({
  default: {
    payrollAdjustment: { findUnique: vi.fn(), update: vi.fn() },
    payrollAdjustmentApplication: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
    },
    payrollCorrectionSession: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', () => ({ lockAdjustmentRows: vi.fn() }))

import _prisma from '@/lib/prisma'
import { lockAdjustmentRows } from '@/features/payroll-adjustments/services/adjustment-lock.service'
import {
  approveAdjustmentApplication,
  cancelAdjustment,
  skipAdjustmentApplication,
  updateAdjustment,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { AdjustmentServiceError } from '@/features/payroll-adjustments/types/adjustment.types'

const prisma = _prisma as any

const WEEK = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')
const MESSAGE = 'A payroll correction is open for this week. Finish or cancel it first.'

function adjustment(over: Record<string, any> = {}) {
  return {
    id: 'adj-1',
    employeeId: 'emp-1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'RECURRING',
    amount: 500,
    reason: 'Advance recovery',
    startPayrollWeekStartDate: WEEK,
    startPayrollWeekEndDate: WEEK_END,
    endPayrollWeekStartDate: null,
    endPayrollWeekEndDate: null,
    totalRecurrenceWeeks: null,
    totalBalance: 2000,
    remainingBalance: 2000,
    recurrenceEndType: 'TOTAL_BALANCE',
    status: 'ACTIVE',
    skippedCarryForwardCount: 0,
    ...over,
  }
}

function application(adj: Record<string, any>, over: Record<string, any> = {}) {
  return {
    id: 'app-1',
    payrollAdjustmentId: adj.id,
    employeeId: 'emp-1',
    payrollRunId: null,
    payrollRevisionId: null,
    payrollWeekStartDate: WEEK,
    payrollWeekEndDate: WEEK_END,
    appliedAmount: 500,
    approvalStatus: 'PENDING',
    appliedAt: null,
    skippedAt: null,
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
    payrollAdjustment: adj,
    ...over,
  }
}

const order = (fn: unknown, index = 0): number => (fn as any).mock.invocationCallOrder[index]

/** Every prisma method that writes. */
const writes = () => [
  prisma.payrollAdjustment.update,
  prisma.payrollAdjustmentApplication.create,
  prisma.payrollAdjustmentApplication.update,
  prisma.payrollAdjustmentApplication.updateMany,
  prisma.payrollAdjustmentApplication.deleteMany,
]
const expectNoWrites = () => {
  for (const write of writes()) expect(write).not.toHaveBeenCalled()
}

function openCorrection(open: boolean) {
  prisma.payrollCorrectionSession.findFirst.mockResolvedValue(open ? { id: 'session-1' } : null)
}

beforeEach(() => {
  vi.resetAllMocks()
  openCorrection(false)
  // the weekly approve and skip run in an interactive transaction: the mock client is the transaction client
  prisma.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[])))
  prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([])
  prisma.payrollAdjustmentApplication.findFirst.mockResolvedValue(null)
  prisma.payrollAdjustmentApplication.aggregate.mockResolvedValue({ _sum: { appliedAmount: null } })
})

// ─── Refused while a correction is open ──────────────────────────────────────

describe('weekly approve, skip, edit and cancel are refused (CORRECTION_IN_PROGRESS) for a week with an open correction', () => {
  it('approveAdjustmentApplication: refused, with the user-facing message, before any transaction or lock, and nothing is written', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    openCorrection(true)

    const error = await approveAdjustmentApplication('app-1').catch((e) => e)

    expect(error).toBeInstanceOf(AdjustmentServiceError)
    expect(error).toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: MESSAGE })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockAdjustmentRows).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('skipAdjustmentApplication (standalone): refused, and nothing is written', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    openCorrection(true)

    await expect(skipAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: MESSAGE })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockAdjustmentRows).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('updateAdjustment: refused, and nothing is written', async () => {
    const adj = adjustment()
    prisma.payrollAdjustment.findUnique.mockResolvedValue({ ...adj, adjustmentApplications: [{ approvalStatus: 'PENDING' }] })
    prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([{ payrollWeekStartDate: WEEK }])
    openCorrection(true)

    await expect(
      updateAdjustment('adj-1', {
        employeeId: 'emp-1',
        adjustmentType: 'DEDUCTION',
        amount: 750,
        reason: 'Updated',
        recurrenceType: 'ONE_TIME',
        startPayrollWeekStartDate: WEEK,
        startPayrollWeekEndDate: WEEK_END,
      } as never),
    ).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: MESSAGE })

    expectNoWrites()
    expect(prisma.payrollAdjustmentApplication.aggregate).not.toHaveBeenCalled()
  })

  it('updateAdjustment: the correction is reported before "already applied" (a week under correction has every application reset to PENDING, but a later week\'s may not)', async () => {
    const adj = adjustment()
    prisma.payrollAdjustment.findUnique.mockResolvedValue({ ...adj, adjustmentApplications: [{ approvalStatus: 'APPROVED' }] })
    prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([{ payrollWeekStartDate: WEEK }])
    openCorrection(true)

    await expect(
      updateAdjustment('adj-1', {
        employeeId: 'emp-1',
        adjustmentType: 'DEDUCTION',
        amount: 750,
        reason: 'Updated',
        recurrenceType: 'ONE_TIME',
        startPayrollWeekStartDate: WEEK,
        startPayrollWeekEndDate: WEEK_END,
      } as never),
    ).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS' })
  })

  it('cancelAdjustment: refused, and nothing is written (the pending applications are not deleted)', async () => {
    prisma.payrollAdjustment.findUnique.mockResolvedValue(adjustment())
    prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([{ payrollWeekStartDate: WEEK }])
    openCorrection(true)

    await expect(cancelAdjustment('adj-1')).rejects.toMatchObject({ code: 'CORRECTION_IN_PROGRESS', message: MESSAGE })

    expectNoWrites()
  })

  it('the open correction is looked up by the week of the application, in an IN_PROGRESS session', async () => {
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adjustment()))
    openCorrection(true)

    await approveAdjustmentApplication('app-1').catch(() => undefined)

    expect(prisma.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({
      where: { status: 'IN_PROGRESS', payrollRun: { payrollWeekStartDate: WEEK } },
      select: { id: true },
    })
  })

  it('edit and cancel look at every week the adjustment has an application in', async () => {
    const W2 = new Date('2025-03-13T00:00:00.000Z')
    prisma.payrollAdjustment.findUnique.mockResolvedValue(adjustment())
    prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([{ payrollWeekStartDate: WEEK }, { payrollWeekStartDate: W2 }])
    openCorrection(true)

    await cancelAdjustment('adj-1').catch(() => undefined)

    expect(prisma.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({ where: { payrollAdjustmentId: 'adj-1' }, select: { payrollWeekStartDate: true } })
    expect(prisma.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({
      where: { status: 'IN_PROGRESS', payrollRun: { payrollWeekStartDate: { in: [WEEK, W2] } } },
      select: { id: true },
    })
  })

  it('an adjustment with no application in any week cannot be under correction: no session is looked up', async () => {
    prisma.payrollAdjustment.findUnique.mockResolvedValue(adjustment())
    prisma.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    prisma.payrollAdjustmentApplication.deleteMany.mockResolvedValue({ count: 0 })
    prisma.payrollAdjustment.update.mockResolvedValue({ ...adjustment(), status: 'CANCELLED' })

    await expect(cancelAdjustment('adj-1')).resolves.toMatchObject({ status: 'CANCELLED' })

    expect(prisma.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
  })

  it('a missing application or adjustment is still reported as missing, not as a correction', async () => {
    openCorrection(true)
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(null)
    prisma.payrollAdjustment.findUnique.mockResolvedValue(null)

    await expect(approveAdjustmentApplication('nope')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' })
    await expect(skipAdjustmentApplication('nope')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' })
    await expect(cancelAdjustment('nope')).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_FOUND' })
  })

  it('with no open correction the same calls go through (nothing about the guard changes the weekly flow)', async () => {
    const adj = adjustment({ recurrenceEndType: null, totalBalance: null, remainingBalance: null, recurrenceType: 'ONE_TIME' })
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(adj), approvalStatus: 'APPROVED', appliedAt: new Date() })
    prisma.payrollAdjustment.update.mockResolvedValue(adj)

    await expect(approveAdjustmentApplication('app-1')).resolves.toMatchObject({ approvalStatus: 'APPROVED' })

    expect(prisma.payrollCorrectionSession.findFirst).toHaveBeenCalledTimes(1)
  })
})

describe('skipAdjustmentApplication inside the caller\'s transaction (approvePayroll)', () => {
  function makeTx(adj: Record<string, any>, app: Record<string, any>) {
    return {
      payrollAdjustmentApplication: {
        findUnique: vi.fn().mockResolvedValue({ ...app, payrollAdjustment: adj }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ ...app, approvalStatus: 'SKIPPED', skippedAt: new Date() }),
        create: vi.fn().mockResolvedValue({}),
      },
      payrollAdjustment: { update: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn(),
    }
  }

  it('does not look for an open correction (its week has no run yet), and does not open a transaction of its own', async () => {
    const adj = adjustment()
    const tx = makeTx(adj, application(adj))
    openCorrection(true) // would refuse a standalone skip

    await expect(skipAdjustmentApplication('app-1', tx as never)).resolves.toMatchObject({ approvalStatus: 'SKIPPED' })

    expect(prisma.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('takes the adjustment\'s row lock on the caller\'s client and reads the application again after it', async () => {
    const adj = adjustment()
    const tx = makeTx(adj, application(adj))

    await skipAdjustmentApplication('app-1', tx as never)

    expect(lockAdjustmentRows).toHaveBeenCalledTimes(1)
    expect(lockAdjustmentRows).toHaveBeenCalledWith(tx, ['adj-1'])
    // read before the lock (to know which adjustment to lock) and again after it
    expect(tx.payrollAdjustmentApplication.findUnique).toHaveBeenCalledTimes(2)
    expect(order(tx.payrollAdjustmentApplication.findUnique, 0)).toBeLessThan(order(lockAdjustmentRows))
    expect(order(lockAdjustmentRows)).toBeLessThan(order(tx.payrollAdjustmentApplication.findUnique, 1))
    expect(order(tx.payrollAdjustmentApplication.findUnique, 1)).toBeLessThan(order(tx.payrollAdjustmentApplication.update))
  })
})

// ─── The weekly race fix: the lock, then the re-read, then the writes ───────

describe('weekly approve takes the adjustment lock in a transaction and re-reads under it', () => {
  it('sequence: read to find the adjustment, transaction, lock, read again, then the writes', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(adj), approvalStatus: 'APPROVED', appliedAt: new Date() })
    prisma.payrollAdjustment.update.mockResolvedValue(adj)

    await approveAdjustmentApplication('app-1')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: expect.any(Number) })
    expect(lockAdjustmentRows).toHaveBeenCalledWith(prisma, ['adj-1'])
    expect(prisma.payrollAdjustmentApplication.findUnique).toHaveBeenCalledTimes(2)
    const [read, tx, lock, reread, appWrite, adjWrite] = [
      order(prisma.payrollAdjustmentApplication.findUnique, 0),
      order(prisma.$transaction),
      order(lockAdjustmentRows),
      order(prisma.payrollAdjustmentApplication.findUnique, 1),
      order(prisma.payrollAdjustmentApplication.update),
      order(prisma.payrollAdjustment.update),
    ]
    expect([read, tx, lock, reread, appWrite, adjWrite]).toEqual([read, tx, lock, reread, appWrite, adjWrite].sort((a, b) => a - b))
  })

  it('an application another request approved while this one waited for the lock is refused on the re-read, and nothing is deducted a second time', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique
      .mockResolvedValueOnce(application(adj, { approvalStatus: 'PENDING' })) // the first look, outside the transaction
      .mockResolvedValueOnce(application(adj, { approvalStatus: 'APPROVED' })) // under the lock: the other approval has committed

    await expect(approveAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already approved' })

    expectNoWrites()
  })

  it('the balance the approval uses is the one read under the lock: 2000 before the lock, 1500 after it gives 1000, not 1500', async () => {
    const before = adjustment({ remainingBalance: 2000 })
    const after = adjustment({ remainingBalance: 1500 }) // another week's approval committed while this one waited
    prisma.payrollAdjustmentApplication.findUnique
      .mockResolvedValueOnce(application(before))
      .mockResolvedValueOnce(application(after))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(after), approvalStatus: 'APPROVED', appliedAmount: 500, appliedAt: new Date() })
    prisma.payrollAdjustment.update.mockResolvedValue(after)

    await approveAdjustmentApplication('app-1')

    expect(prisma.payrollAdjustment.update).toHaveBeenCalledWith({ where: { id: 'adj-1' }, data: { remainingBalance: 1000 } })
  })

  it('the cap is applied to the balance read under the lock: 20 left under the lock at 500 an instalment applies 20 and completes the adjustment', async () => {
    const stale = adjustment({ remainingBalance: 2000 })
    const fresh = adjustment({ remainingBalance: 20 })
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValueOnce(application(stale)).mockResolvedValueOnce(application(fresh))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(fresh), approvalStatus: 'APPROVED', appliedAmount: 20, appliedAt: new Date() })
    prisma.payrollAdjustment.update.mockResolvedValue(fresh)

    await approveAdjustmentApplication('app-1')

    expect(prisma.payrollAdjustmentApplication.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ appliedAmount: 20 }) }))
    expect(prisma.payrollAdjustment.update).toHaveBeenCalledWith({ where: { id: 'adj-1' }, data: { remainingBalance: 0, status: 'COMPLETED' } })
  })

  it('every write goes through the transaction client, and a failure in the middle propagates (the transaction rolls the rest back)', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(adj), approvalStatus: 'APPROVED', appliedAt: new Date() })
    prisma.payrollAdjustment.update.mockRejectedValue(new Error('balance write failed'))

    await expect(approveAdjustmentApplication('app-1')).rejects.toThrow('balance write failed')

    // the mock transaction does not roll back; what is proved is that the failure is not swallowed and runs inside the transaction callback
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('an application that is already APPROVED is refused before any lock is taken', async () => {
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adjustment(), { approvalStatus: 'APPROVED' }))

    await expect(approveAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS' })

    expect(lockAdjustmentRows).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('weekly skip takes the adjustment lock in a transaction and re-reads under it', () => {
  it('standalone: transaction, then the lock, then the re-read, then the carry-forward writes', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValue(application(adj))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(adj), approvalStatus: 'SKIPPED', skippedAt: new Date() })
    prisma.payrollAdjustmentApplication.create.mockResolvedValue({})
    prisma.payrollAdjustment.update.mockResolvedValue(adj)

    await skipAdjustmentApplication('app-1')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(lockAdjustmentRows).toHaveBeenCalledWith(prisma, ['adj-1'])
    expect(prisma.payrollAdjustmentApplication.findUnique).toHaveBeenCalledTimes(2)
    expect(order(prisma.payrollAdjustmentApplication.findUnique, 0)).toBeLessThan(order(prisma.$transaction))
    expect(order(prisma.$transaction)).toBeLessThan(order(lockAdjustmentRows))
    expect(order(lockAdjustmentRows)).toBeLessThan(order(prisma.payrollAdjustmentApplication.findUnique, 1))
    expect(order(prisma.payrollAdjustmentApplication.findUnique, 1)).toBeLessThan(order(prisma.payrollAdjustmentApplication.update))
  })

  it('an application another request skipped while this one waited is refused on the re-read: no second carry-forward, no second count', async () => {
    const adj = adjustment()
    prisma.payrollAdjustmentApplication.findUnique
      .mockResolvedValueOnce(application(adj, { approvalStatus: 'PENDING' }))
      .mockResolvedValueOnce(application(adj, { approvalStatus: 'SKIPPED' }))

    await expect(skipAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already skipped' })

    expectNoWrites()
  })

  it('the carry-forward count is taken from the adjustment read under the lock: 1 before, 2 under the lock, 3 is written', async () => {
    const stale = adjustment({ skippedCarryForwardCount: 1 })
    const fresh = adjustment({ skippedCarryForwardCount: 2 })
    prisma.payrollAdjustmentApplication.findUnique.mockResolvedValueOnce(application(stale)).mockResolvedValueOnce(application(fresh))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(fresh), approvalStatus: 'SKIPPED', skippedAt: new Date() })
    prisma.payrollAdjustmentApplication.create.mockResolvedValue({})
    prisma.payrollAdjustment.update.mockResolvedValue(fresh)

    await skipAdjustmentApplication('app-1')

    expect(prisma.payrollAdjustment.update).toHaveBeenCalledWith({ where: { id: 'adj-1' }, data: expect.objectContaining({ skippedCarryForwardCount: 3 }) })
  })

  it('skipping an APPROVED application gives back the balance read under the lock (1500 under the lock + 500 = 2000)', async () => {
    const stale = adjustment({ remainingBalance: 1000 })
    const fresh = adjustment({ remainingBalance: 1500 })
    prisma.payrollAdjustmentApplication.findUnique
      .mockResolvedValueOnce(application(stale, { approvalStatus: 'APPROVED' }))
      .mockResolvedValueOnce(application(fresh, { approvalStatus: 'APPROVED' }))
    prisma.payrollAdjustmentApplication.update.mockResolvedValue({ ...application(fresh), approvalStatus: 'SKIPPED', skippedAt: new Date() })
    prisma.payrollAdjustmentApplication.create.mockResolvedValue({})
    prisma.payrollAdjustment.update.mockResolvedValue(fresh)

    await skipAdjustmentApplication('app-1')

    expect(prisma.payrollAdjustment.update).toHaveBeenCalledWith({
      where: { id: 'adj-1' },
      data: expect.objectContaining({ remainingBalance: 2000, skippedCarryForwardCount: 1 }),
    })
  })
})
