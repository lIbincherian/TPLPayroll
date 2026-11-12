/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The database half of adjustment-settlement.ts, against a hand-made transaction client: what it reads (two
// queries for the whole week), what the recalculation freezes into the applications, and the writes the
// settlement makes for each cell of the table. The effect helpers of the adjustment service are stubbed, so this
// file proves which helper is called, with what, and in which order; the helpers themselves are tested in
// adjustment-effects.test.ts, and the whole path against state in settle-adjustments.test.ts.
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  applyApprovalToAdjustment: vi.fn(),
  carryApplicationForward: vi.fn(),
  removeCarryForward: vi.fn(),
  undoApprovalOnAdjustment: vi.fn(),
}))

import {
  applyApprovalToAdjustment,
  carryApplicationForward,
  removeCarryForward,
  undoApprovalOnAdjustment,
} from '@/features/payroll-adjustments/services/adjustment.service'
import {
  applySettlement,
  freezeDraftAdjustmentAmounts,
  loadSettlementInput,
  planSettlement,
  type AdjustmentSnapshotEntry,
  type ApplicationPlan,
} from '@/features/payroll-correction/services/adjustment-settlement'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'

type Row = Record<string, any>

const RUN = { id: 'run-1', payrollWeekStartDate: new Date('2025-07-10T00:00:00.000Z') }
const NEXT = new Date('2025-07-17T00:00:00.000Z')

function adjustment(over: Row = {}): Row {
  return {
    id: 'adj-1',
    employeeId: 'emp-1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'RECURRING',
    amount: 500,
    startPayrollWeekStartDate: RUN.payrollWeekStartDate,
    totalBalance: 2000,
    remainingBalance: 2000,
    recurrenceEndType: 'TOTAL_BALANCE',
    status: 'ACTIVE',
    skippedCarryForwardCount: 0,
    ...over,
  }
}

function application(adj: Row, over: Row = {}): any {
  return {
    id: 'app-1',
    payrollAdjustmentId: adj.id,
    employeeId: 'emp-1',
    payrollRunId: 'run-1',
    payrollWeekStartDate: RUN.payrollWeekStartDate,
    appliedAmount: Number(adj.amount),
    approvalStatus: 'PENDING',
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
    payrollAdjustment: adj,
    ...over,
  }
}

function entry(applicationId: string, approvalStatus: string, over: Partial<AdjustmentSnapshotEntry> = {}): AdjustmentSnapshotEntry {
  return { applicationId, approvalStatus, isReversed: false, approvedAt: null, skippedAt: null, appliedAt: null, appliedAmount: 500, ...over }
}

function makeTx(applications: any[] = [], waiting: Row[] = []) {
  const tx = {
    payrollAdjustmentApplication: {
      findMany: vi.fn(async (args: any) => (args.include ? applications : waiting)),
      update: vi.fn(async () => ({})),
    },
    payrollAdjustment: { findUniqueOrThrow: vi.fn() },
  }
  return tx
}

const asTx = (tx: unknown) => tx as never

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── loadSettlementInput ─────────────────────────────────────────────────────

describe('loadSettlementInput: the whole week in two queries', () => {
  it('reads the scope with the adjustments, then which of those adjustments have a PENDING application the week after', async () => {
    const adjA = adjustment({ id: 'adj-a' })
    const adjB = adjustment({ id: 'adj-b' })
    const apps = [application(adjA, { id: 'app-1' }), application(adjA, { id: 'app-2', employeeId: 'emp-2' }), application(adjB, { id: 'app-3' })]
    const tx = makeTx(apps, [{ payrollAdjustmentId: 'adj-b' }])

    const result = await loadSettlementInput(asTx(tx), RUN)

    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledTimes(2)
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenNthCalledWith(1, {
      where: { payrollWeekStartDate: RUN.payrollWeekStartDate, OR: [{ payrollRunId: 'run-1' }, { payrollRunId: null }] },
      include: { payrollAdjustment: true },
    })
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenNthCalledWith(2, {
      // once per adjustment, however many applications it has
      where: { payrollAdjustmentId: { in: ['adj-a', 'adj-b'] }, payrollWeekStartDate: NEXT, approvalStatus: 'PENDING' },
      select: { payrollAdjustmentId: true },
    })
    expect(result.applications).toBe(apps)
    expect([...result.adjustmentsWithNextWeekPending]).toEqual(['adj-b'])
  })

  it('a week with no applications still costs two queries and returns nothing', async () => {
    const tx = makeTx([], [])

    const result = await loadSettlementInput(asTx(tx), RUN)

    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledTimes(2)
    expect(result.applications).toEqual([])
    expect(result.adjustmentsWithNextWeekPending.size).toBe(0)
  })

  it('"the week after" is seven days on from the run\'s week', async () => {
    const tx = makeTx([application(adjustment())], [])

    await loadSettlementInput(asTx(tx), { id: 'run-1', payrollWeekStartDate: new Date('2025-12-25T00:00:00.000Z') })

    const second = tx.payrollAdjustmentApplication.findMany.mock.calls[1][0]
    expect(second.where.payrollWeekStartDate).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })
})

// ─── freezeDraftAdjustmentAmounts ────────────────────────────────────────────

describe('freezeDraftAdjustmentAmounts: what the recalculation writes', () => {
  const snapshot = (...entries: AdjustmentSnapshotEntry[]) => entries

  it('writes the amount the draft deducts into the application: the 70/50 cap freezes 50 over the stored 70, and the draft row carries 50', async () => {
    const adj = adjustment({ amount: 70, totalBalance: 120, remainingBalance: 50 })
    const tx = makeTx([application(adj, { approvalStatus: 'APPROVED', appliedAmount: 70 })])

    const sums = await freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('app-1', 'PENDING', { appliedAmount: 70 })), new Set(['emp-1']))

    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledWith({ where: { id: 'app-1' }, data: { appliedAmount: 50 } })
    expect(sums.get('emp-1')).toEqual({ additions: 0, deductions: 50 })
  })

  it('writes nothing when the stored amount already is what the draft deducts', async () => {
    const tx = makeTx([application(adjustment(), { approvalStatus: 'APPROVED', appliedAmount: 500 })])

    const sums = await freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('app-1', 'PENDING')), new Set(['emp-1']))

    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
    expect(sums.get('emp-1')).toEqual({ additions: 0, deductions: 500 })
  })

  it('writes nothing for a kept, skipped, pending or left-out application: only a new approval has an amount to freeze', async () => {
    const adj = adjustment()
    const apps = [
      application(adj, { id: 'kept', approvalStatus: 'APPROVED', appliedAmount: 123 }), // O = 500 in the snapshot, whatever the row says
      application(adj, { id: 'skipped', approvalStatus: 'SKIPPED', employeeId: 'emp-2', appliedAmount: 70 }),
      application(adj, { id: 'pending', approvalStatus: 'PENDING', employeeId: 'emp-3', appliedAmount: 70 }),
      application(adj, { id: 'left-out', approvalStatus: 'APPROVED', employeeId: 'emp-9', appliedAmount: 70 }),
    ]
    const tx = makeTx(apps)

    const sums = await freezeDraftAdjustmentAmounts(
      asTx(tx),
      RUN,
      snapshot(entry('kept', 'APPROVED', { appliedAmount: 500 }), entry('skipped', 'PENDING'), entry('pending', 'PENDING'), entry('left-out', 'PENDING')),
      new Set(['emp-1', 'emp-2', 'emp-3']),
    )

    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
    expect([...sums.entries()]).toEqual([['emp-1', { additions: 0, deductions: 500 }]])
  })

  it('returns sums per employee in rupees: two applications of one employee add up in whole paise (66.67 + 33.33 = 100, an addition apart)', async () => {
    const deductionA = adjustment({ id: 'adj-a', amount: 66.67, recurrenceEndType: null, totalBalance: null, remainingBalance: null, recurrenceType: 'ONE_TIME' })
    const deductionB = adjustment({ id: 'adj-b', amount: 33.33, recurrenceEndType: null, totalBalance: null, remainingBalance: null, recurrenceType: 'ONE_TIME' })
    const addition = adjustment({ id: 'adj-c', adjustmentType: 'ADDITION', amount: 12.5, recurrenceEndType: null, totalBalance: null, remainingBalance: null, recurrenceType: 'ONE_TIME' })
    const apps = [
      application(deductionA, { id: 'a', approvalStatus: 'APPROVED', appliedAmount: 66.67 }),
      application(deductionB, { id: 'b', approvalStatus: 'APPROVED', appliedAmount: 33.33 }),
      application(addition, { id: 'c', approvalStatus: 'APPROVED', appliedAmount: 12.5 }),
    ]
    const tx = makeTx(apps)

    const sums = await freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('a', 'PENDING'), entry('b', 'PENDING'), entry('c', 'PENDING')), new Set(['emp-1']))

    expect(sums.get('emp-1')).toEqual({ additions: 12.5, deductions: 100 })
  })

  it('a week with nothing to deduct returns no sums and writes nothing', async () => {
    const tx = makeTx([application(adjustment(), { approvalStatus: 'PENDING' })])

    const sums = await freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('app-1', 'PENDING')), new Set(['emp-1']))

    expect(sums.size).toBe(0)
    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
  })

  it.each([
    ['the adjustment is COMPLETED', adjustment({ status: 'COMPLETED', remainingBalance: 0 }), 'This adjustment is already completed or cancelled.'],
    ['the adjustment is CANCELLED', adjustment({ status: 'CANCELLED' }), 'This adjustment is already completed or cancelled.'],
    ['nothing is left to deduct', adjustment({ remainingBalance: 0 }), 'Nothing is left to deduct for this adjustment.'],
  ])('ADJUSTMENT_NOT_APPLICABLE when %s, and nothing is written (not even for the applications that could be applied)', async (_why, adj, message) => {
    const ok = application(adjustment({ id: 'adj-ok', remainingBalance: 2000 }), { id: 'ok', approvalStatus: 'APPROVED', appliedAmount: 70, employeeId: 'emp-2' })
    const bad = application(adj, { id: 'bad', approvalStatus: 'APPROVED' })
    const tx = makeTx([ok, bad])

    const error = await freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('ok', 'PENDING'), entry('bad', 'PENDING')), new Set(['emp-1', 'emp-2'])).catch((e) => e)

    expect(error).toBeInstanceOf(CorrectionServiceError)
    expect(error).toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message })
    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
  })

  it('the ONE_TIME carried-forward chain is not applicable either (row k)', async () => {
    const adj = adjustment({ recurrenceType: 'ONE_TIME', recurrenceEndType: null, totalBalance: null, remainingBalance: null })
    const tx = makeTx([application(adj, { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })], [])

    await expect(
      freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })), new Set(['emp-1'])),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message: 'This adjustment was carried to the next week and has been dealt with there.' })
  })

  it('a failing write is the caller\'s failure: the error goes up and no later amount is written', async () => {
    const adj = adjustment({ amount: 70, totalBalance: 120, remainingBalance: 120 })
    const apps = [
      application(adj, { id: 'a', approvalStatus: 'APPROVED', appliedAmount: 99 }),
      application(adjustment({ id: 'adj-2', amount: 70, totalBalance: 120, remainingBalance: 120 }), { id: 'b', approvalStatus: 'APPROVED', employeeId: 'emp-2', appliedAmount: 99 }),
    ]
    const tx = makeTx(apps)
    tx.payrollAdjustmentApplication.update.mockRejectedValueOnce(new Error('write failed'))

    await expect(freezeDraftAdjustmentAmounts(asTx(tx), RUN, snapshot(entry('a', 'PENDING'), entry('b', 'PENDING')), new Set(['emp-1', 'emp-2']))).rejects.toThrow('write failed')

    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledTimes(1)
  })
})

// ─── applySettlement ─────────────────────────────────────────────────────────

describe('applySettlement: the writes of each cell', () => {
  /** A plan for one application, as planSettlement would make it for the situation the test builds. */
  function settle(apps: any[], snapshot: AdjustmentSnapshotEntry[] | null, paid: string[] = ['emp-1'], nextPending: string[] = []) {
    const { plans, problems } = planSettlement({ applications: apps, snapshot, paidEmployeeIds: new Set(paid), adjustmentsWithNextWeekPending: new Set(nextPending) })
    expect(problems).toEqual([])
    return plans
  }

  it('KEEP, NONE and INERT write nothing and read nothing', async () => {
    const adj = adjustment()
    const apps = [
      application(adj, { id: 'keep', approvalStatus: 'APPROVED' }),
      application(adj, { id: 'none', approvalStatus: 'PENDING', employeeId: 'emp-2' }),
      application(adjustment({ id: 'adj-x', status: 'CANCELLED' }), { id: 'inert', approvalStatus: 'PENDING', employeeId: 'emp-3' }),
    ]
    const plans = settle(apps, [entry('keep', 'APPROVED'), entry('none', 'PENDING'), entry('inert', 'PENDING')], ['emp-1', 'emp-2', 'emp-3'])
    expect(plans.map((p) => p.cell).sort()).toEqual(['INERT', 'KEEP', 'NONE'])
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, apps, [entry('keep', 'APPROVED'), entry('none', 'PENDING'), entry('inert', 'PENDING')])

    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
    expect(tx.payrollAdjustment.findUniqueOrThrow).not.toHaveBeenCalled()
    for (const helper of [applyApprovalToAdjustment, carryApplicationForward, removeCarryForward, undoApprovalOnAdjustment]) expect(helper).not.toHaveBeenCalled()
  })

  it('APPLY applies the amount the plan says (the cap: 50) to the adjustment loaded with the applications, and removes no carry-forward', async () => {
    const adj = adjustment({ amount: 70, totalBalance: 120, remainingBalance: 50 })
    const app = application(adj, { approvalStatus: 'APPROVED', appliedAmount: 50 })
    const plans = settle([app], [entry('app-1', 'PENDING')])
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], [entry('app-1', 'PENDING')])

    expect(applyApprovalToAdjustment).toHaveBeenCalledTimes(1)
    expect(applyApprovalToAdjustment).toHaveBeenCalledWith(tx, app, adj, 50)
    expect(removeCarryForward).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
    expect(tx.payrollAdjustment.findUniqueOrThrow).not.toHaveBeenCalled() // unchanged applications cost no query
  })

  it('APPLY of an application carried forward before the correction takes the carry-forward back first, clears the carry date, then applies', async () => {
    const adj = adjustment()
    const app = application(adj, { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })
    const snap = [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })]
    const plans = settle([app], snap)
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(removeCarryForward).toHaveBeenCalledWith(tx, app, adj)
    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledWith({ where: { id: 'app-1' }, data: { carriedForwardToPayrollWeekStartDate: null } })
    expect(applyApprovalToAdjustment).toHaveBeenCalledWith(tx, app, adj, 500)
    const order = (fn: unknown) => (fn as any).mock.invocationCallOrder[0]
    expect(order(removeCarryForward)).toBeLessThan(order(tx.payrollAdjustmentApplication.update))
    expect(order(tx.payrollAdjustmentApplication.update)).toBeLessThan(order(applyApprovalToAdjustment))
  })

  it('UNAPPLY_CARRY carries the application forward with the balance given back at what it was applied at (not what the row says now)', async () => {
    const adj = adjustment({ remainingBalance: 1500 })
    const app = application(adj, { approvalStatus: 'SKIPPED', appliedAmount: 70 })
    const snap = [entry('app-1', 'APPROVED', { appliedAmount: 500 })]
    const plans = settle([app], snap)
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(carryApplicationForward).toHaveBeenCalledTimes(1)
    expect(carryApplicationForward).toHaveBeenCalledWith(tx, { ...app, appliedAmount: 500 }, adj, { undoApproval: true })
    expect(applyApprovalToAdjustment).not.toHaveBeenCalled()
  })

  it('UNAPPLY_SKIP marks it SKIPPED (no second carry-forward) and gives the balance back', async () => {
    const adj = adjustment({ remainingBalance: 1500 })
    const app = application(adj, { approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT })
    const snap = [entry('app-1', 'APPROVED', { appliedAmount: 500 })]
    const plans = settle([app], snap)
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(carryApplicationForward).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledWith({ where: { id: 'app-1' }, data: { approvalStatus: 'SKIPPED', skippedAt: expect.any(Date) } })
    expect(undoApprovalOnAdjustment).toHaveBeenCalledWith(tx, { appliedAmount: 500 }, adj)
  })

  it('UNAPPLY_PENDING gives the balance back and leaves the application alone', async () => {
    const adj = adjustment({ remainingBalance: 1500 })
    const app = application(adj, { approvalStatus: 'PENDING' })
    const snap = [entry('app-1', 'APPROVED', { appliedAmount: 500 })]
    const plans = settle([app], snap)
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(undoApprovalOnAdjustment).toHaveBeenCalledWith(tx, { appliedAmount: 500 }, adj)
    expect(tx.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
    expect(carryApplicationForward).not.toHaveBeenCalled()
  })

  it('CARRY carries it forward with no balance undone', async () => {
    const adj = adjustment()
    const app = application(adj, { approvalStatus: 'SKIPPED' })
    const snap = [entry('app-1', 'PENDING')]
    const plans = settle([app], snap)
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(carryApplicationForward).toHaveBeenCalledWith(tx, app, adj, { undoApproval: false })
    expect(undoApprovalOnAdjustment).not.toHaveBeenCalled()
  })

  it('SKIP_ONLY of a row that is not SKIPPED yet marks it SKIPPED at the time the snapshot recorded, and carries nothing', async () => {
    const adj = adjustment()
    const app = application(adj, { approvalStatus: 'PENDING', employeeId: 'emp-9', carriedForwardToPayrollWeekStartDate: NEXT })
    const snap = [entry('app-1', 'SKIPPED', { skippedAt: '2025-07-17T08:00:00.000Z', carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })]
    const plans = settle([app], snap)
    expect(plans[0].cell).toBe('SKIP_ONLY')
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [app], snap)

    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: { approvalStatus: 'SKIPPED', skippedAt: new Date('2025-07-17T08:00:00.000Z') },
    })
    expect(carryApplicationForward).not.toHaveBeenCalled()
    expect(undoApprovalOnAdjustment).not.toHaveBeenCalled()
  })

  it('SKIP_ONLY with no recorded skip time stamps now; with the row already SKIPPED it writes nothing', async () => {
    const adj = adjustment({ status: 'COMPLETED' })
    const pending = application(adj, { id: 'p', approvalStatus: 'PENDING', employeeId: 'emp-9' })
    const done = application(adj, { id: 'd', approvalStatus: 'SKIPPED', employeeId: 'emp-9' })
    const snap = [entry('p', 'PENDING'), entry('d', 'PENDING')]
    const plans = settle([pending, done], snap)
    expect(plans.map((p) => p.cell)).toEqual(['SKIP_ONLY', 'SKIP_ONLY'])
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [pending, done], snap)

    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.update).toHaveBeenCalledWith({ where: { id: 'p' }, data: { approvalStatus: 'SKIPPED', skippedAt: expect.any(Date) } })
  })

  it('an adjustment an earlier plan wrote is read again before the next plan uses it (the helpers take the balance from the row), and one that was not is not', async () => {
    const adj = adjustment({ remainingBalance: 1000 })
    const other = adjustment({ id: 'adj-2', remainingBalance: 2000 })
    const skipped = application(adj, { id: 'a', approvalStatus: 'SKIPPED' })
    const approved = application(adj, { id: 'b', approvalStatus: 'APPROVED', employeeId: 'emp-2' })
    const elsewhere = application(other, { id: 'c', approvalStatus: 'APPROVED', employeeId: 'emp-3' })
    const snap = [entry('a', 'APPROVED'), entry('b', 'PENDING'), entry('c', 'PENDING')]
    const plans = settle([skipped, approved, elsewhere], snap, ['emp-1', 'emp-2', 'emp-3'])
    expect(plans.map((p) => [p.applicationId, p.cell])).toEqual([['a', 'UNAPPLY_CARRY'], ['b', 'APPLY'], ['c', 'APPLY']])
    const fresh = adjustment({ remainingBalance: 1500 })
    const tx = makeTx()
    tx.payrollAdjustment.findUniqueOrThrow.mockResolvedValue(fresh)

    await applySettlement(asTx(tx), plans, [skipped, approved, elsewhere], snap)

    // a: the row loaded with the applications; b: the same adjustment after a wrote it, read again; c: another adjustment, not read
    expect(tx.payrollAdjustment.findUniqueOrThrow).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustment.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'adj-1' } })
    expect(carryApplicationForward).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'a' }), adj, { undoApproval: true })
    expect(applyApprovalToAdjustment).toHaveBeenNthCalledWith(1, tx, approved, fresh, 500)
    expect(applyApprovalToAdjustment).toHaveBeenNthCalledWith(2, tx, elsewhere, other, 500)
  })

  it('SKIP_ONLY does not count as writing the adjustment: the next plan of it uses the row it was loaded with', async () => {
    const adj = adjustment({ status: 'ACTIVE' })
    const skipOnly = application(adj, { id: 'a', approvalStatus: 'PENDING', employeeId: 'emp-9', carriedForwardToPayrollWeekStartDate: NEXT })
    const approved = application(adj, { id: 'b', approvalStatus: 'APPROVED', employeeId: 'emp-2' })
    const snap = [entry('a', 'SKIPPED'), entry('b', 'PENDING')]
    const plans = settle([skipOnly, approved], snap, ['emp-2'])
    const tx = makeTx()

    await applySettlement(asTx(tx), plans, [skipOnly, approved], snap)

    expect(tx.payrollAdjustment.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(applyApprovalToAdjustment).toHaveBeenCalledWith(tx, approved, adj, 500)
  })

  it('applies the plans in plan order, and a helper that throws stops the rest (the transaction rolls back what was written)', async () => {
    const adj = adjustment({ remainingBalance: 1000 })
    const skipped = application(adj, { id: 'a', approvalStatus: 'SKIPPED' })
    const approved = application(adj, { id: 'b', approvalStatus: 'APPROVED', employeeId: 'emp-2' })
    const snap = [entry('a', 'APPROVED'), entry('b', 'PENDING')]
    const plans = settle([approved, skipped], snap, ['emp-1', 'emp-2'])
    const tx = makeTx()
    tx.payrollAdjustment.findUniqueOrThrow.mockResolvedValue(adj)
    vi.mocked(carryApplicationForward).mockRejectedValueOnce(new Error('carry failed'))

    await expect(applySettlement(asTx(tx), plans, [approved, skipped], snap)).rejects.toThrow('carry failed')

    expect(carryApplicationForward).toHaveBeenCalledTimes(1)
    expect(applyApprovalToAdjustment).not.toHaveBeenCalled() // the give-back came first and failed: nothing after it ran
  })

  it('a plan for an application that is not in the loaded set is an error, not a silent skip', async () => {
    const plan: ApplicationPlan = { applicationId: 'ghost', adjustmentId: 'adj-1', employeeId: 'emp-1', adjustmentType: 'DEDUCTION', cell: 'APPLY', originalAmount: 0, newAmount: 500 }
    const tx = makeTx()

    await expect(applySettlement(asTx(tx), [plan], [], null)).rejects.toThrow()
  })
})
