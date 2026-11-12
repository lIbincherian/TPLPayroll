/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

// The adjustment settlement plan (the pure part of adjustment-settlement.ts): what a correction does to each of
// the week's adjustment applications, from how it was before the correction (the session snapshot) and how it
// ends (its status, and whether the draft pays its employee), and what the draft deducts for it.
//
// Nothing here touches a database. The module imports the adjustment service for its writers, so the service is
// stubbed to keep prisma out of a pure test.
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  applyApprovalToAdjustment: vi.fn(),
  carryApplicationForward: vi.fn(),
  removeCarryForward: vi.fn(),
  undoApprovalOnAdjustment: vi.fn(),
}))

import {
  draftMatchesPlan,
  parseAdjustmentSnapshot,
  planProblemMessage,
  planSettlement,
  settlementScope,
  type AdjustmentSnapshotEntry,
  type ApplicationPlan,
  type PlanProblem,
} from '@/features/payroll-correction/services/adjustment-settlement'

type Row = Record<string, any>

const WEEK = new Date('2025-07-10T00:00:00.000Z')
const NEXT = new Date('2025-07-17T00:00:00.000Z')

// ─── Builders ────────────────────────────────────────────────────────────────

/** An adjustment of 500 a week unless the test says otherwise; no balance, ACTIVE. */
function adjustment(over: Row = {}): Row {
  return {
    id: 'adj-1',
    employeeId: 'emp-1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'RECURRING',
    amount: 500,
    reason: 'Advance recovery',
    startPayrollWeekStartDate: WEEK,
    startPayrollWeekEndDate: new Date('2025-07-16T00:00:00.000Z'),
    endPayrollWeekStartDate: null,
    endPayrollWeekEndDate: null,
    totalRecurrenceWeeks: null,
    totalBalance: null,
    remainingBalance: null,
    recurrenceEndType: null,
    status: 'ACTIVE',
    skippedCarryForwardCount: 0,
    ...over,
  }
}

/** TOTAL_BALANCE: `amount` a week until `totalBalance` is paid; `remaining` is what is left. */
const totalBalance = (remaining: number, over: Row = {}) =>
  adjustment({ recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 2000, remainingBalance: remaining, ...over })
/** FIXED_WEEKS: 1500 over 3 weeks, so 500 a week. */
const fixedWeeks = (remaining: number, over: Row = {}) =>
  adjustment({ recurrenceEndType: 'FIXED_WEEKS', totalRecurrenceWeeks: 3, totalBalance: 1500, remainingBalance: remaining, ...over })
const oneTime = (over: Row = {}) => adjustment({ recurrenceType: 'ONE_TIME', ...over })
const endWeek = (over: Row = {}) => adjustment({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: NEXT, ...over })

function application(adj: Row, over: Row = {}): any {
  return {
    id: 'app-1',
    payrollAdjustmentId: adj.id,
    employeeId: 'emp-1',
    payrollRunId: 'run-1',
    payrollRevisionId: null,
    payrollWeekStartDate: WEEK,
    payrollWeekEndDate: new Date('2025-07-16T00:00:00.000Z'),
    appliedAmount: Number(adj.amount),
    approvalStatus: 'PENDING',
    approvedAt: null,
    appliedAt: null,
    skippedAt: null,
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
    payrollAdjustment: adj,
    ...over,
  }
}

function entry(applicationId: string, approvalStatus: string, over: Partial<AdjustmentSnapshotEntry> = {}): AdjustmentSnapshotEntry {
  return {
    applicationId,
    approvalStatus,
    isReversed: false,
    approvedAt: null,
    skippedAt: null,
    appliedAt: null,
    appliedAmount: 500,
    carriedForwardToPayrollWeekStartDate: null,
    ...over,
  }
}

interface PlanOptions {
  /** `null` is "no snapshot" (a draft made without a session); the default is an empty snapshot. */
  snapshot?: AdjustmentSnapshotEntry[] | null
  /** The employees the draft pays; default emp-1. */
  paid?: string[]
  /** Adjustments that have a PENDING application in the week after. */
  nextPending?: string[]
}

function plan(applications: any[], options: PlanOptions = {}) {
  return planSettlement({
    applications,
    snapshot: options.snapshot === undefined ? [] : options.snapshot,
    paidEmployeeIds: new Set(options.paid ?? ['emp-1']),
    adjustmentsWithNextWeekPending: new Set(options.nextPending ?? []),
  })
}

/** The one plan of a one-application week, with no problem. */
function single(app: any, options: PlanOptions = {}) {
  const result = plan([app], options)
  expect(result.problems).toEqual([])
  expect(result.plans).toHaveLength(1)
  return result.plans[0]
}

// The adjustments the cells are tried on. `applied` is the state of the adjustment after the original approval
// applied the week's instalment (the snapshot says the application was APPROVED); `fresh` is before it was.
interface Kind {
  name: string
  type: 'DEDUCTION' | 'ADDITION'
  amount: number
  build(state: 'applied' | 'fresh', over?: Row): Row
}

const KINDS: Kind[] = [
  { name: 'TOTAL_BALANCE 2000 at 500', type: 'DEDUCTION', amount: 500, build: (s, o) => totalBalance(s === 'applied' ? 1500 : 2000, o) },
  { name: 'FIXED_WEEKS 1500 over 3', type: 'DEDUCTION', amount: 500, build: (s, o) => fixedWeeks(s === 'applied' ? 1000 : 1500, o) },
  { name: 'ONE_TIME 500', type: 'DEDUCTION', amount: 500, build: (s, o) => oneTime({ status: s === 'applied' ? 'COMPLETED' : 'ACTIVE', ...o }) },
  { name: 'END_WEEK 500', type: 'DEDUCTION', amount: 500, build: (_s, o) => endWeek(o) },
  { name: 'ADDITION ONE_TIME 300', type: 'ADDITION', amount: 300, build: (s, o) => oneTime({ adjustmentType: 'ADDITION', amount: 300, status: s === 'applied' ? 'COMPLETED' : 'ACTIVE', ...o }) },
  {
    name: 'ADDITION TOTAL_BALANCE 900 at 300',
    type: 'ADDITION',
    amount: 300,
    build: (s, o) => totalBalance(s === 'applied' ? 600 : 900, { adjustmentType: 'ADDITION', amount: 300, totalBalance: 900, ...o }),
  },
]

// ─── The table: one test per cell, for every kind of adjustment ──────────────

describe.each(KINDS)('planSettlement cells, $name', (kind) => {
  const fresh = () => kind.build('fresh')
  const applied = () => kind.build('applied')
  const A = kind.amount

  it('KEEP: applied before and APPROVED again for a paid employee: nothing moves, the draft keeps deducting what it did (N = O)', () => {
    const adj = applied()
    const app = application(adj, { approvalStatus: 'APPROVED' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'KEEP', originalAmount: A, newAmount: A, adjustmentType: kind.type, applicationId: 'app-1', adjustmentId: 'adj-1', employeeId: 'emp-1' })
  })

  it('APPLY: not applied before and APPROVED for a paid employee: the draft deducts the instalment, nothing was absorbed before (O = 0)', () => {
    const app = application(fresh(), { approvalStatus: 'APPROVED' })

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result).toMatchObject({ cell: 'APPLY', originalAmount: 0, newAmount: A, adjustmentType: kind.type })
  })

  it('UNAPPLY_CARRY: applied before and SKIPPED, not carried: the balance goes back (O) and the draft deducts nothing', () => {
    const app = application(applied(), { approvalStatus: 'SKIPPED' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: A, newAmount: 0 })
  })

  it('UNAPPLY_CARRY: applied before and PENDING, but the employee is left out of the draft: the same as skipped', () => {
    const app = application(applied(), { approvalStatus: 'PENDING', employeeId: 'emp-9' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })], paid: ['emp-1'] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: A, newAmount: 0 })
  })

  it('UNAPPLY_CARRY: applied before and APPROVED, but the employee is left out of the draft: given back and carried, not kept', () => {
    const app = application(applied(), { approvalStatus: 'APPROVED', employeeId: 'emp-9' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: A, newAmount: 0 })
  })

  it('UNAPPLY_SKIP: applied before and SKIPPED, but already carried (defensive): the balance goes back, nothing is carried again', () => {
    const app = application(applied(), { approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_SKIP', originalAmount: A, newAmount: 0 })
  })

  it('UNAPPLY_PENDING: applied before and left PENDING for a paid employee: the balance goes back, nothing is carried', () => {
    const app = application(applied(), { approvalStatus: 'PENDING' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_PENDING', originalAmount: A, newAmount: 0 })
  })

  it('CARRY: not applied before and SKIPPED, not carried, the adjustment active: carried to the next week, no balance, nothing deducted', () => {
    const app = application(fresh(), { approvalStatus: 'SKIPPED' })

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result).toMatchObject({ cell: 'CARRY', originalAmount: 0, newAmount: 0 })
  })

  it('CARRY: not applied before and PENDING, but the employee is left out of the draft', () => {
    const app = application(fresh(), { approvalStatus: 'PENDING', employeeId: 'emp-9' })

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result.cell).toBe('CARRY')
  })

  it('SKIP_ONLY: not applied before and SKIPPED, already carried (finding 2): only the status, nothing carried again', () => {
    const app = application(fresh(), { approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT })

    const result = single(app, { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })] })

    expect(result).toMatchObject({ cell: 'SKIP_ONLY', originalAmount: 0, newAmount: 0 })
  })

  it('SKIP_ONLY: the row was SKIPPED before the correction even with no carry date recorded', () => {
    const app = application(fresh(), { approvalStatus: 'PENDING', employeeId: 'emp-9', carriedForwardToPayrollWeekStartDate: null })

    const result = single(app, { snapshot: [entry('app-1', 'SKIPPED')] })

    expect(result.cell).toBe('SKIP_ONLY')
  })

  it('SKIP_ONLY: not applied, SKIPPED, and the adjustment is COMPLETED: no new carry-forward for a finished adjustment', () => {
    const app = application(fresh(), { approvalStatus: 'SKIPPED' })
    app.payrollAdjustment = { ...app.payrollAdjustment, status: 'COMPLETED' }

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result.cell).toBe('SKIP_ONLY')
  })

  it('NONE: not applied before and left PENDING for a paid employee: nothing', () => {
    const app = application(fresh(), { approvalStatus: 'PENDING' })

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result).toMatchObject({ cell: 'NONE', originalAmount: 0, newAmount: 0 })
  })

  it('INERT: the adjustment was CANCELLED: nothing moves, and nothing is deducted for an application that was never applied and is PENDING', () => {
    const app = application(kind.build('fresh', { status: 'CANCELLED' }), { approvalStatus: 'PENDING' })

    const result = single(app, { snapshot: [entry('app-1', 'PENDING')] })

    expect(result).toMatchObject({ cell: 'INERT', originalAmount: 0, newAmount: 0 })
  })

  it('INERT: a CANCELLED adjustment whose applied application is APPROVED again deducts what it did (today\'s behaviour, X5)', () => {
    const app = application(kind.build('applied', { status: 'CANCELLED' }), { approvalStatus: 'APPROVED' })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })

    expect(result).toMatchObject({ cell: 'INERT', originalAmount: A, newAmount: A })
  })

  it('INERT: a CANCELLED adjustment and the application is SKIPPED or the employee is left out: nothing, no carry-forward', () => {
    const skipped = application(kind.build('applied', { status: 'CANCELLED' }), { approvalStatus: 'SKIPPED' })
    const leftOut = application(kind.build('applied', { status: 'CANCELLED' }), { approvalStatus: 'APPROVED', employeeId: 'emp-9' })

    expect(single(skipped, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })).toMatchObject({ cell: 'INERT', newAmount: 0 })
    expect(single(leftOut, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: A })] })).toMatchObject({ cell: 'INERT', newAmount: 0 })
  })
})

// ─── Worked rows of the decision table ───────────────────────────────────────

describe('planSettlement worked rows (TOTAL_BALANCE 120 at 70 a week: week 1 applied 70, so 50 left; the correction is on week 2)', () => {
  const capped = (remaining: number, over: Row = {}) => totalBalance(remaining, { amount: 70, totalBalance: 120, ...over })

  it('row a: newly approved, nothing else happens: N = min(70, 50) = 50', () => {
    const app = application(capped(50), { approvalStatus: 'APPROVED', appliedAmount: 70 })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 70 })] })).toMatchObject({ cell: 'APPLY', originalAmount: 0, newAmount: 50 })
  })

  it('row b: newly approved, another week takes the rest (0 left, COMPLETED): a problem, ADJUSTMENT_NOT_ACTIVE, and N = 0', () => {
    const app = application(capped(0, { status: 'COMPLETED' }), { approvalStatus: 'APPROVED', appliedAmount: 50 })

    const result = plan([app], { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 70 })] })

    expect(result.problems).toEqual([{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
    expect(result.plans[0]).toMatchObject({ cell: 'APPLY', newAmount: 0 })
  })

  it('row c: newly approved, another application takes 30 (20 left): the plan is now N = min(70, 20) = 20', () => {
    const app = application(capped(20), { approvalStatus: 'APPROVED', appliedAmount: 50 })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 70 })] })).toMatchObject({ cell: 'APPLY', newAmount: 20 })
  })

  it('row d: newly approved, the balance grew (week 1 skipped elsewhere: 120 left): the plan is now N = 70', () => {
    const app = application(capped(120), { approvalStatus: 'APPROVED', appliedAmount: 50 })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 70 })] })).toMatchObject({ cell: 'APPLY', newAmount: 70 })
  })

  it('row e: applied 50 (the 70/50 cap) and kept, while the balance moved on to 20: N = O = 50, whatever is left now', () => {
    const app = application(capped(20), { approvalStatus: 'APPROVED', appliedAmount: 50 })

    expect(single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 50 })] })).toMatchObject({ cell: 'KEEP', originalAmount: 50, newAmount: 50 })
  })

  it('row e: kept even with nothing left at all (0 left, COMPLETED): no cap can fail on an amount the balance already absorbed', () => {
    const app = application(capped(0, { status: 'COMPLETED' }), { approvalStatus: 'APPROVED', appliedAmount: 50 })

    expect(single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 50 })] })).toMatchObject({ cell: 'KEEP', newAmount: 50 })
  })

  it('row f: applied 50, skipped now: O = 50 goes back (20 -> 70), carried once; the draft deducts 0', () => {
    const app = application(capped(20), { approvalStatus: 'SKIPPED', appliedAmount: 50 })

    expect(single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 50 })] })).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: 50, newAmount: 0 })
  })

  it('row f: the 50 that went back (20 -> 70) is what a second, newly approved application of the same adjustment can then take: N = min(70, 70) = 70', () => {
    const adj = capped(20)
    const skipped = application(adj, { id: 'app-a', approvalStatus: 'SKIPPED', employeeId: 'emp-1', appliedAmount: 50 })
    const approved = application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2', appliedAmount: 70 })

    const result = plan([skipped, approved], {
      snapshot: [entry('app-a', 'APPROVED', { appliedAmount: 50 }), entry('app-b', 'PENDING', { appliedAmount: 70 })],
      paid: ['emp-1', 'emp-2'],
    })

    expect(result.problems).toEqual([])
    // the give-back comes first in the plan order, then the application it feeds
    expect(result.plans.map((p) => [p.applicationId, p.cell, p.newAmount])).toEqual([
      ['app-a', 'UNAPPLY_CARRY', 0],
      ['app-b', 'APPLY', 70],
    ])
  })

  it('row g: applied 50 with 100 left (total 120): the balance goes back only up to the total (120, not 150), so a second approval of 120 leaves the adjustment completed for a third', () => {
    // amount 120 = the whole total, so the instalments of the other two applications can only be told apart by what is left.
    const adj = totalBalance(100, { amount: 120, totalBalance: 120 })
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'SKIPPED', appliedAmount: 50 }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2', appliedAmount: 120 }),
      application(adj, { id: 'app-c', approvalStatus: 'APPROVED', employeeId: 'emp-3', appliedAmount: 120 }),
    ]

    const result = plan(apps, {
      snapshot: [entry('app-a', 'APPROVED', { appliedAmount: 50 }), entry('app-b', 'PENDING'), entry('app-c', 'PENDING')],
      paid: ['emp-1', 'emp-2', 'emp-3'],
    })

    // 100 + 50 would be 150; capped at the total it is 120, so b takes all 120 (COMPLETED) and c is refused. Without the cap b would
    // leave 30 and c would be approved at 30.
    expect(result.plans.find((p) => p.applicationId === 'app-b')).toMatchObject({ cell: 'APPLY', newAmount: 120 })
    expect(result.plans.find((p) => p.applicationId === 'app-c')).toMatchObject({ cell: 'APPLY', newAmount: 0 })
    expect(result.problems).toEqual([{ applicationId: 'app-c', employeeId: 'emp-3', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
  })

  it('row h: ADDITION, ONE_TIME 300, newly approved: the draft adds 300, no balance', () => {
    const adj = oneTime({ adjustmentType: 'ADDITION', amount: 300 })
    const app = application(adj, { approvalStatus: 'APPROVED', appliedAmount: 300 })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 300 })] })).toMatchObject({
      cell: 'APPLY',
      newAmount: 300,
      adjustmentType: 'ADDITION',
    })
  })

  it('row i: ADDITION, ONE_TIME 300 applied, the employee left out: given back (COMPLETED -> ACTIVE) and carried', () => {
    const adj = oneTime({ adjustmentType: 'ADDITION', amount: 300, status: 'COMPLETED' })
    const app = application(adj, { approvalStatus: 'APPROVED', employeeId: 'emp-9', appliedAmount: 300 })

    expect(single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 300 })] })).toMatchObject({
      cell: 'UNAPPLY_CARRY',
      originalAmount: 300,
      newAmount: 0,
      adjustmentType: 'ADDITION',
    })
  })

  it('row j: FIXED_WEEKS 200 over 3 (66.67 a week), the third week newly approved with 66.66 left: N = 66.66, so the total is never exceeded', () => {
    const adj = fixedWeeks(66.66, { amount: 66.67, totalBalance: 200 })
    const app = application(adj, { approvalStatus: 'APPROVED', appliedAmount: 66.67 })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 66.67 })] })).toMatchObject({ cell: 'APPLY', newAmount: 66.66 })
  })

  it('row k: ONE_TIME skipped in week W (carried to W+1) and again in W+1 (carried to W+2); approving W in a correction: a problem, CARRIED_FORWARD_HANDLED, because W+1 has no PENDING left', () => {
    const adj = oneTime()
    const app = application(adj, { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })

    const result = plan([app], { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })], nextPending: [] })

    expect(result.problems).toEqual([{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'CARRIED_FORWARD_HANDLED' }])
  })

  it('row k: a ONE_TIME carried to the next week where its PENDING still waits is no problem: approving it now takes that carry-forward back', () => {
    const adj = oneTime()
    const app = application(adj, { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })

    const result = plan([app], { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })], nextPending: ['adj-1'] })

    expect(result.problems).toEqual([])
    expect(result.plans[0]).toMatchObject({ cell: 'APPLY', newAmount: 500 })
  })

  it('row k only concerns ONE_TIME: a recurring adjustment carried forward whose next week is already handled can still be approved', () => {
    const adj = totalBalance(2000)
    const app = application(adj, { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })

    const result = plan([app], { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })], nextPending: [] })

    expect(result.problems).toEqual([])
    expect(result.plans[0]).toMatchObject({ cell: 'APPLY', newAmount: 500 })
  })

  it('row l: a linked SKIPPED application (carried, count 1) reset to PENDING and the employee left out again: SKIP_ONLY, not a second carry-forward', () => {
    const adj = totalBalance(2000, { skippedCarryForwardCount: 1 })
    const app = application(adj, { approvalStatus: 'PENDING', employeeId: 'emp-9', carriedForwardToPayrollWeekStartDate: NEXT })

    expect(single(app, { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })] })).toMatchObject({
      cell: 'SKIP_ONLY',
      newAmount: 0,
    })
  })
})

// ─── Problems ────────────────────────────────────────────────────────────────

describe('planSettlement problems: an application that is APPROVED but could not be applied', () => {
  it('an adjustment that is COMPLETED and was not applied: ADJUSTMENT_NOT_ACTIVE, with N = 0', () => {
    const app = application(oneTime({ status: 'COMPLETED' }), { approvalStatus: 'APPROVED' })

    const result = plan([app], { snapshot: [entry('app-1', 'PENDING')] })

    expect(result.problems).toEqual([{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
    expect(result.plans[0]).toMatchObject({ cell: 'APPLY', newAmount: 0 })
  })

  it('a CANCELLED adjustment that was not applied: ADJUSTMENT_NOT_ACTIVE', () => {
    const app = application(totalBalance(2000, { status: 'CANCELLED' }), { approvalStatus: 'APPROVED' })

    const result = plan([app], { snapshot: [entry('app-1', 'PENDING')] })

    expect(result.problems).toEqual([{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
    expect(result.plans[0]).toMatchObject({ cell: 'INERT', newAmount: 0 })
  })

  it('nothing left (0 left, still ACTIVE): NOTHING_LEFT, with N = 0', () => {
    const app = application(totalBalance(0), { approvalStatus: 'APPROVED' })

    const result = plan([app], { snapshot: [entry('app-1', 'PENDING')] })

    expect(result.problems).toEqual([{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'NOTHING_LEFT' }])
    expect(result.plans[0]).toMatchObject({ cell: 'APPLY', newAmount: 0 })
  })

  it('a balance of a fraction of a paisa is nothing left as well', () => {
    const app = application(totalBalance(0.004), { approvalStatus: 'APPROVED' })

    expect(plan([app], { snapshot: [entry('app-1', 'PENDING')] }).problems.map((p) => p.reason)).toEqual(['NOTHING_LEFT'])
  })

  it('a problem is only raised for an application that is approved and paid: a SKIPPED, PENDING or left-out one on a finished adjustment is not a problem', () => {
    const adj = oneTime({ status: 'COMPLETED' })
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'SKIPPED' }),
      application(adj, { id: 'app-b', approvalStatus: 'PENDING', employeeId: 'emp-2' }),
      application(adj, { id: 'app-c', approvalStatus: 'APPROVED', employeeId: 'emp-9' }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING')), paid: ['emp-1', 'emp-2'] })

    expect(result.problems).toEqual([])
  })

  it('a ONE_TIME adjustment approved twice in the same week: the second finds it COMPLETED (a problem), the first applies', () => {
    const adj = oneTime()
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'APPROVED' }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2' }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING')), paid: ['emp-1', 'emp-2'] })

    expect(result.plans.find((p) => p.applicationId === 'app-a')).toMatchObject({ cell: 'APPLY', newAmount: 500 })
    expect(result.problems).toEqual([{ applicationId: 'app-b', employeeId: 'emp-2', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
  })

  it('every problem has a message for the user', () => {
    expect(planProblemMessage('ADJUSTMENT_NOT_ACTIVE')).toBe('This adjustment is already completed or cancelled.')
    expect(planProblemMessage('NOTHING_LEFT')).toBe('Nothing is left to deduct for this adjustment.')
    expect(planProblemMessage('CARRIED_FORWARD_HANDLED')).toBe('This adjustment was carried to the next week and has been dealt with there.')
  })
})

// ─── Several applications of one adjustment ──────────────────────────────────

describe('planSettlement with several applications of one adjustment in the week', () => {
  it('two new approvals share the balance (TOTAL_BALANCE, 50 left at 70 a week): the first (by id) takes 50 and completes it, the second is refused', () => {
    const adj = totalBalance(50, { amount: 70, totalBalance: 120 })
    const apps = [
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2', appliedAmount: 70 }),
      application(adj, { id: 'app-a', approvalStatus: 'APPROVED', employeeId: 'emp-1', appliedAmount: 70 }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING', { appliedAmount: 70 })), paid: ['emp-1', 'emp-2'] })

    expect(result.plans.map((p) => [p.applicationId, p.newAmount])).toEqual([['app-a', 50], ['app-b', 0]])
    // the first approval took the last 50, which completes a TOTAL_BALANCE adjustment, so the second finds it completed
    expect(result.problems).toEqual([{ applicationId: 'app-b', employeeId: 'emp-2', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
  })

  it('two new approvals share the balance (FIXED_WEEKS, 50 left at 70 a week): the first takes 50, the second finds NOTHING_LEFT (a FIXED_WEEKS one is completed by its count, not its balance)', () => {
    const adj = fixedWeeks(50, { amount: 70, totalBalance: 210 })
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'APPROVED', employeeId: 'emp-1', appliedAmount: 70 }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2', appliedAmount: 70 }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING', { appliedAmount: 70 })), paid: ['emp-1', 'emp-2'] })

    expect(result.plans.map((p) => [p.applicationId, p.newAmount])).toEqual([['app-a', 50], ['app-b', 0]])
    expect(result.problems).toEqual([{ applicationId: 'app-b', employeeId: 'emp-2', reason: 'NOTHING_LEFT' }])
  })

  it('a TOTAL_BALANCE adjustment that the first approval empties is COMPLETED for the second: ADJUSTMENT_NOT_ACTIVE, not NOTHING_LEFT', () => {
    const adj = totalBalance(500)
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'APPROVED' }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2' }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING')), paid: ['emp-1', 'emp-2'] })

    expect(result.plans[0]).toMatchObject({ applicationId: 'app-a', newAmount: 500 })
    expect(result.problems).toEqual([{ applicationId: 'app-b', employeeId: 'emp-2', reason: 'ADJUSTMENT_NOT_ACTIVE' }])
  })

  it('the give-back of a COMPLETED adjustment makes it ACTIVE again for a second application in the same week', () => {
    const adj = totalBalance(0, { status: 'COMPLETED', totalBalance: 1000 })
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'SKIPPED' }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2' }),
    ]

    const result = plan(apps, {
      snapshot: [entry('app-a', 'APPROVED', { appliedAmount: 500 }), entry('app-b', 'PENDING')],
      paid: ['emp-1', 'emp-2'],
    })

    expect(result.problems).toEqual([])
    expect(result.plans.find((p) => p.applicationId === 'app-b')).toMatchObject({ cell: 'APPLY', newAmount: 500 })
  })

  it('plans are in step order within an adjustment (un-applications before applications), regardless of the order the applications come in', () => {
    const adj = totalBalance(1000)
    const apps = [
      application(adj, { id: 'app-1', approvalStatus: 'PENDING', employeeId: 'emp-5' }), // NONE
      application(adj, { id: 'app-2', approvalStatus: 'APPROVED', employeeId: 'emp-4' }), // APPLY
      application(adj, { id: 'app-3', approvalStatus: 'APPROVED', employeeId: 'emp-3' }), // KEEP
      application(adj, { id: 'app-4', approvalStatus: 'SKIPPED', employeeId: 'emp-2' }), // UNAPPLY_CARRY
    ]

    const result = plan(apps, {
      snapshot: [entry('app-1', 'PENDING'), entry('app-2', 'PENDING'), entry('app-3', 'APPROVED'), entry('app-4', 'APPROVED')],
      paid: ['emp-2', 'emp-3', 'emp-4', 'emp-5'],
    })

    expect(result.plans.map((p) => p.cell)).toEqual(['UNAPPLY_CARRY', 'KEEP', 'APPLY', 'NONE'])
  })

  it('adjustments are planned independently and in id order: one adjustment\'s balance never feeds another\'s', () => {
    const adjB = totalBalance(50, { id: 'adj-b', amount: 70, totalBalance: 120 })
    const adjA = totalBalance(2000, { id: 'adj-a' })
    const apps = [
      application(adjB, { id: 'app-b', approvalStatus: 'APPROVED', appliedAmount: 70 }),
      application(adjA, { id: 'app-a', approvalStatus: 'APPROVED' }),
    ]

    const result = plan(apps, { snapshot: [entry('app-a', 'PENDING'), entry('app-b', 'PENDING')] })

    expect(result.plans.map((p) => [p.adjustmentId, p.newAmount])).toEqual([['adj-a', 500], ['adj-b', 50]])
  })

  it('an adjustment that tracks no balance (END_WEEK) is not capped: both new approvals take the full amount', () => {
    const adj = endWeek()
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'APPROVED' }),
      application(adj, { id: 'app-b', approvalStatus: 'APPROVED', employeeId: 'emp-2' }),
    ]

    const result = plan(apps, { snapshot: apps.map((a) => entry(a.id, 'PENDING')), paid: ['emp-1', 'emp-2'] })

    expect(result.problems).toEqual([])
    expect(result.plans.map((p) => p.newAmount)).toEqual([500, 500])
  })

  it('a TOTAL_BALANCE adjustment whose remaining balance is not set tracks nothing: the full amount, no cap', () => {
    const adj = totalBalance(0, { remainingBalance: null })
    const app = application(adj, { approvalStatus: 'APPROVED' })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING')] })).toMatchObject({ cell: 'APPLY', newAmount: 500 })
  })
})

// ─── Where "applied before" and "amount" come from ───────────────────────────

describe('planSettlement: the snapshot', () => {
  it('an older snapshot entry without appliedAmount: O falls back to the application\'s own amount', () => {
    const adj = totalBalance(1500)
    const app = application(adj, { approvalStatus: 'SKIPPED', appliedAmount: 420 })

    const result = single(app, { snapshot: [{ applicationId: 'app-1', approvalStatus: 'APPROVED', isReversed: false, approvedAt: null, skippedAt: null, appliedAt: null }] })

    expect(result).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: 420 })
  })

  it('an entry that is APPROVED and isReversed still counts as applied: the reverse path never gave the balance back, so O = appliedAmount', () => {
    const adj = totalBalance(1500)
    const app = application(adj, { approvalStatus: 'APPROVED', isReversed: false })

    const result = single(app, { snapshot: [entry('app-1', 'APPROVED', { isReversed: true, appliedAmount: 500 })] })

    expect(result).toMatchObject({ cell: 'KEEP', originalAmount: 500, newAmount: 500 })
  })

  it('an application created after the correction opened (no entry) is not applied before: approving it is an APPLY', () => {
    const app = application(totalBalance(2000), { approvalStatus: 'APPROVED' })

    expect(single(app, { snapshot: [entry('some-other-app', 'APPROVED')] })).toMatchObject({ cell: 'APPLY', originalAmount: 0, newAmount: 500 })
  })

  it('an entry that is PENDING or SKIPPED is not applied before, whatever the application says now', () => {
    const app = application(totalBalance(2000), { approvalStatus: 'APPROVED', appliedAmount: 500 })

    expect(single(app, { snapshot: [entry('app-1', 'SKIPPED', { appliedAmount: 500 })] }).cell).toBe('APPLY')
    expect(single(app, { snapshot: [entry('app-1', 'PENDING', { appliedAmount: 500 })] }).cell).toBe('APPLY')
  })

  it('what the draft deducts for an application that was kept never comes from the current balance, only from O', () => {
    const app = application(totalBalance(0, { status: 'COMPLETED' }), { approvalStatus: 'APPROVED', appliedAmount: 123.45 })

    expect(single(app, { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 123.45 })] })).toMatchObject({ cell: 'KEEP', newAmount: 123.45 })
  })
})

describe('planSettlement with no snapshot (a draft made without a session): the application\'s own status says whether it was applied', () => {
  it('APPROVED and paid: KEEP at the amount it carries', () => {
    const app = application(totalBalance(1500), { approvalStatus: 'APPROVED', appliedAmount: 500 })

    expect(single(app, { snapshot: null })).toMatchObject({ cell: 'KEEP', originalAmount: 500, newAmount: 500 })
  })

  it('APPROVED and the employee left out: given back and carried', () => {
    const app = application(totalBalance(1500), { approvalStatus: 'APPROVED', employeeId: 'emp-9' })

    expect(single(app, { snapshot: null })).toMatchObject({ cell: 'UNAPPLY_CARRY', originalAmount: 500, newAmount: 0 })
  })

  it('PENDING and left out: carried, SKIPPED and left out: only the status', () => {
    const pending = application(totalBalance(2000), { id: 'app-p', approvalStatus: 'PENDING', employeeId: 'emp-9' })
    const skipped = application(totalBalance(2000), { id: 'app-s', approvalStatus: 'SKIPPED', employeeId: 'emp-9', carriedForwardToPayrollWeekStartDate: NEXT })

    expect(single(pending, { snapshot: null }).cell).toBe('CARRY')
    expect(single(skipped, { snapshot: null }).cell).toBe('SKIP_ONLY')
  })

  it('SKIPPED with no carry date recorded is still not carried again (it was SKIPPED before)', () => {
    const app = application(totalBalance(2000), { approvalStatus: 'SKIPPED' })

    expect(single(app, { snapshot: null }).cell).toBe('SKIP_ONLY')
  })

  it('a reversed APPROVED row is INERT with N = 0, even for a paid employee: the draft would not deduct it, so no balance is touched', () => {
    const app = application(totalBalance(1500), { approvalStatus: 'APPROVED', isReversed: true })

    expect(single(app, { snapshot: null })).toMatchObject({ cell: 'INERT', originalAmount: 500, newAmount: 0 })
  })

  it('PENDING and paid: nothing', () => {
    const app = application(totalBalance(2000), { approvalStatus: 'PENDING' })

    expect(single(app, { snapshot: null }).cell).toBe('NONE')
  })

  it('a week with no applications plans nothing', () => {
    expect(plan([], { snapshot: null })).toEqual({ plans: [], problems: [] })
  })
})

describe('parseAdjustmentSnapshot', () => {
  it('is empty for anything that is not an array (no snapshot)', () => {
    expect(parseAdjustmentSnapshot(null)).toEqual([])
    expect(parseAdjustmentSnapshot(undefined)).toEqual([])
    expect(parseAdjustmentSnapshot({ applicationId: 'x' })).toEqual([])
    expect(parseAdjustmentSnapshot('[]')).toEqual([])
  })

  it('keeps the entries that have an application id and drops the rest', () => {
    const good = entry('app-1', 'APPROVED')
    expect(parseAdjustmentSnapshot([good, null, 3, 'x', { approvalStatus: 'APPROVED' }, { applicationId: 7 }])).toEqual([good])
  })
})

describe('settlementScope', () => {
  it('is the run\'s week, on the run or not yet linked to any run', () => {
    expect(settlementScope({ id: 'run-1', payrollWeekStartDate: WEEK })).toEqual({
      payrollWeekStartDate: WEEK,
      OR: [{ payrollRunId: 'run-1' }, { payrollRunId: null }],
    })
  })
})

// ─── draftMatchesPlan ────────────────────────────────────────────────────────

describe('draftMatchesPlan: the draft is what the settlement will do, to the paisa', () => {
  const adj = totalBalance(2000)
  const approved = (over: Row = {}) => application(adj, { id: 'app-1', approvalStatus: 'APPROVED', appliedAmount: 500, ...over })

  function setup(over: { app?: Row; rows?: Array<{ employeeId: string; additions: any; deductions: any }>; adjustment?: Row } = {}) {
    const a = application(over.adjustment ?? adj, { id: 'app-1', approvalStatus: 'APPROVED', appliedAmount: 500, ...over.app })
    const result = plan([a], { snapshot: [entry('app-1', 'PENDING')] })
    return { result, a, rows: over.rows ?? [{ employeeId: 'emp-1', additions: 0, deductions: 500 }] }
  }
  const matches = (s: ReturnType<typeof setup>, rows = s.rows, problems: PlanProblem[] = s.result.problems, plans: ApplicationPlan[] = s.result.plans) =>
    draftMatchesPlan(plans, problems, [s.a], rows)

  it('equal: the frozen amount is N and the draft row deducts N', () => {
    expect(matches(setup())).toBe(true)
  })

  it('a frozen amount off by 0.01 is not a match', () => {
    const s = setup({ app: { appliedAmount: 500.01 } })

    expect(matches(s)).toBe(false)
  })

  it('a frozen amount off by 0.01 the other way is not a match either', () => {
    const s = setup({ app: { appliedAmount: 499.99 } })

    expect(matches(s)).toBe(false)
  })

  it('a draft row whose deductions are off by 0.01 is not a match', () => {
    const s = setup()

    expect(matches(s, [{ employeeId: 'emp-1', additions: 0, deductions: 500.01 }])).toBe(false)
    expect(matches(s, [{ employeeId: 'emp-1', additions: 0, deductions: 499.99 }])).toBe(false)
  })

  it('an addition counted as a deduction (or the other way round) is not a match', () => {
    const s = setup()

    expect(matches(s, [{ employeeId: 'emp-1', additions: 500, deductions: 0 }])).toBe(false)
    expect(matches(s, [{ employeeId: 'emp-1', additions: 500, deductions: 500 }])).toBe(false)

    const addition = setup({ adjustment: oneTime({ adjustmentType: 'ADDITION', amount: 300 }), app: { appliedAmount: 300 }, rows: [{ employeeId: 'emp-1', additions: 300, deductions: 0 }] })
    expect(matches(addition)).toBe(true)
    expect(matches(addition, [{ employeeId: 'emp-1', additions: 0, deductions: 300 }])).toBe(false)
  })

  it('a paid employee with no application and zero sums is a match', () => {
    const s = setup()

    expect(matches(s, [...s.rows, { employeeId: 'emp-7', additions: 0, deductions: 0 }])).toBe(true)
  })

  it('a paid employee with no application but a deduction on the row is not a match', () => {
    const s = setup()

    expect(matches(s, [...s.rows, { employeeId: 'emp-7', additions: 0, deductions: 1 }])).toBe(false)
  })

  it('something is deducted by the plan for an employee the draft does not pay: not a match', () => {
    const s = setup()

    expect(matches(s, [{ employeeId: 'emp-7', additions: 0, deductions: 0 }])).toBe(false)
    expect(matches(s, [])).toBe(false)
  })

  it('a problem in the plan is never a match, even when every number agrees', () => {
    const s = setup()

    expect(matches(s, s.rows, [{ applicationId: 'app-1', employeeId: 'emp-1', reason: 'NOTHING_LEFT' }])).toBe(false)
  })

  it('amounts are compared in whole paise: 0.1 + 0.2 equals 0.3, and Decimal-like values are read through Number()', () => {
    const adjA = adjustment({ amount: 0.3, recurrenceType: 'ONE_TIME' })
    const first = application(adjA, { id: 'app-1', approvalStatus: 'APPROVED', appliedAmount: 0.1 + 0.2 })
    const { plans, problems } = plan([first], { snapshot: [entry('app-1', 'PENDING')] })
    const decimal = { toString: () => '0.30', valueOf: () => 0.3 }

    expect(draftMatchesPlan(plans, problems, [first], [{ employeeId: 'emp-1', additions: 0, deductions: 0.1 + 0.2 }])).toBe(true)
    expect(draftMatchesPlan(plans, problems, [first], [{ employeeId: 'emp-1', additions: 0, deductions: decimal as any }])).toBe(true)
  })

  it('only APPLY plans check the stored amount: a kept application may carry any amount as long as the draft deducts what it did', () => {
    const a = application(adj, { id: 'app-1', approvalStatus: 'APPROVED', appliedAmount: 123 })
    const { plans, problems } = plan([a], { snapshot: [entry('app-1', 'APPROVED', { appliedAmount: 500 })] })

    expect(plans[0].cell).toBe('KEEP')
    expect(draftMatchesPlan(plans, problems, [a], [{ employeeId: 'emp-1', additions: 0, deductions: 500 }])).toBe(true)
  })

  it('sums are per employee: two applications of one employee add up, and the draft row must carry both', () => {
    const other = adjustment({ id: 'adj-2', amount: 250, recurrenceType: 'ONE_TIME' })
    const apps = [approved(), application(other, { id: 'app-2', approvalStatus: 'APPROVED', appliedAmount: 250 })]
    const { plans, problems } = plan(apps, { snapshot: [entry('app-1', 'PENDING'), entry('app-2', 'PENDING')] })

    expect(draftMatchesPlan(plans, problems, apps, [{ employeeId: 'emp-1', additions: 0, deductions: 750 }])).toBe(true)
    expect(draftMatchesPlan(plans, problems, apps, [{ employeeId: 'emp-1', additions: 0, deductions: 500 }])).toBe(false)
  })

  it('a week with nothing to deduct matches a draft of zero-sum rows only', () => {
    const none = application(adj, { id: 'app-1', approvalStatus: 'PENDING' })
    const { plans, problems } = plan([none], { snapshot: [entry('app-1', 'PENDING')] })

    expect(draftMatchesPlan(plans, problems, [none], [{ employeeId: 'emp-1', additions: 0, deductions: 0 }])).toBe(true)
    expect(draftMatchesPlan(plans, problems, [none], [{ employeeId: 'emp-1', additions: 0, deductions: 500 }])).toBe(false)
    expect(draftMatchesPlan([], [], [], [])).toBe(true)
  })
})

// ─── The invariants, over every combination ──────────────────────────────────

type Status = 'PENDING' | 'APPROVED' | 'SKIPPED'
const STATUSES: Status[] = ['PENDING', 'APPROVED', 'SKIPPED']

interface Combo {
  wasApplied: boolean
  /** The application's state before the correction when it was not applied. */
  before: 'PENDING' | 'SKIPPED' | 'NONE'
  final: Status
  paid: boolean
  carried: boolean
}

function* combos(): Generator<Combo> {
  for (const wasApplied of [true, false]) {
    for (const before of (wasApplied ? ['PENDING'] : ['PENDING', 'SKIPPED', 'NONE']) as Combo['before'][]) {
      for (const final of STATUSES) {
        for (const paid of [true, false]) {
          for (const carried of [true, false]) yield { wasApplied, before, final, paid, carried }
        }
      }
    }
  }
}

function build(combo: Combo, adj: Row, id = 'app-1', employeeId = 'emp-1') {
  const app = application(adj, {
    id,
    employeeId,
    approvalStatus: combo.final,
    appliedAmount: Number(adj.amount),
    carriedForwardToPayrollWeekStartDate: combo.carried ? NEXT : null,
  })
  const snapshot = combo.wasApplied
    ? entry(id, 'APPROVED', { appliedAmount: Number(adj.amount) })
    : combo.before === 'NONE'
      ? null
      : entry(id, combo.before, { carriedForwardToPayrollWeekStartDate: combo.carried ? NEXT.toISOString() : null })
  return { app, snapshot }
}

const ADJUSTMENTS_FOR_INVARIANTS: Array<[string, Row]> = [
  ['TOTAL_BALANCE', totalBalance(1500)],
  ['FIXED_WEEKS', fixedWeeks(1000)],
  ['ONE_TIME', oneTime()],
  ['END_WEEK', endWeek()],
]

describe('invariant: no double deduction', () => {
  it.each(ADJUSTMENTS_FOR_INVARIANTS)('%s: an application the balance had already absorbed is never an APPLY, and one it had not is never KEEP or UNAPPLY', (_name, adj) => {
    for (const combo of combos()) {
      const { app, snapshot } = build(combo, adj)
      const { plans } = plan([app], { snapshot: snapshot ? [snapshot] : [], paid: combo.paid ? ['emp-1'] : [] })
      const cell = plans[0].cell

      if (combo.wasApplied) {
        expect(['APPLY', 'CARRY', 'NONE'], JSON.stringify(combo)).not.toContain(cell)
        expect(plans[0].originalAmount, JSON.stringify(combo)).toBe(500)
      } else {
        expect(['KEEP', 'UNAPPLY_CARRY', 'UNAPPLY_SKIP', 'UNAPPLY_PENDING'], JSON.stringify(combo)).not.toContain(cell)
        expect(plans[0].originalAmount, JSON.stringify(combo)).toBe(0)
      }
    }
  })

  it.each(ADJUSTMENTS_FOR_INVARIANTS)('%s: what the draft deducts is O for a kept application, N for a new one and nothing for any other cell', (_name, adj) => {
    for (const combo of combos()) {
      const { app, snapshot } = build(combo, adj)
      const { plans, problems } = plan([app], { snapshot: snapshot ? [snapshot] : [], paid: combo.paid ? ['emp-1'] : [] })
      const { cell, newAmount, originalAmount } = plans[0]
      const label = JSON.stringify({ combo, cell })

      if (cell === 'KEEP') expect(newAmount, label).toBe(originalAmount)
      else if (cell === 'APPLY') expect(newAmount, label).toBe(problems.length === 0 ? 500 : 0)
      else expect(newAmount, label).toBe(0)
    }
  })

  it('the draft deducts for an employee only when the application is APPROVED and the draft pays the employee', () => {
    for (const [, adj] of ADJUSTMENTS_FOR_INVARIANTS) {
      for (const combo of combos()) {
        const { app, snapshot } = build(combo, adj)
        const { plans } = plan([app], { snapshot: snapshot ? [snapshot] : [], paid: combo.paid ? ['emp-1'] : [] })

        if (plans[0].newAmount > 0) expect(combo.paid && combo.final === 'APPROVED', JSON.stringify(combo)).toBe(true)
      }
    }
  })
})

describe('invariant: no double carry-forward', () => {
  it.each(ADJUSTMENTS_FOR_INVARIANTS)('%s: CARRY and UNAPPLY_CARRY only for an application that was never carried (no carry date, not SKIPPED before)', (_name, adj) => {
    let carries = 0
    for (const combo of combos()) {
      const { app, snapshot } = build(combo, adj)
      const { plans } = plan([app], { snapshot: snapshot ? [snapshot] : [], paid: combo.paid ? ['emp-1'] : [] })
      const cell = plans[0].cell

      if (cell === 'CARRY' || cell === 'UNAPPLY_CARRY') {
        carries += 1
        expect(combo.carried, JSON.stringify(combo)).toBe(false)
        expect(snapshot?.approvalStatus === 'SKIPPED', JSON.stringify(combo)).toBe(false)
      }
    }
    expect(carries).toBeGreaterThan(0)
  })

  it('an application whose carry date is set is never carried again, whatever its next-week application became', () => {
    const adj = totalBalance(2000)
    for (const nextPending of [[], ['adj-1']]) {
      for (const final of STATUSES) {
        const app = application(adj, { approvalStatus: final, carriedForwardToPayrollWeekStartDate: NEXT, employeeId: 'emp-9' })
        const { plans } = plan([app], { snapshot: [entry('app-1', 'PENDING')], nextPending })

        expect(['CARRY', 'UNAPPLY_CARRY']).not.toContain(plans[0].cell)
      }
    }
  })

  it('an application already SKIPPED before the correction is never carried again, even with no carry date', () => {
    const adj = totalBalance(2000)
    for (const final of STATUSES) {
      const app = application(adj, { approvalStatus: final, employeeId: 'emp-9' })
      const { plans } = plan([app], { snapshot: [entry('app-1', 'SKIPPED')] })

      expect(['CARRY', 'UNAPPLY_CARRY']).not.toContain(plans[0].cell)
    }
  })

  it('a ONE_TIME carried twice (W to W+1, W+1 to W+2): approving W is refused, so the PENDING at W+2 can never be deducted on top of W', () => {
    const app = application(oneTime(), { approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT })

    const { problems } = plan([app], { snapshot: [entry('app-1', 'SKIPPED', { carriedForwardToPayrollWeekStartDate: NEXT.toISOString() })], nextPending: [] })

    expect(problems.map((p) => p.reason)).toEqual(['CARRIED_FORWARD_HANDLED'])
  })
})

describe('invariant: the balance stays between 0 and the total', () => {
  /**
   * Apply the plans' effect on the balance the way applySettlement does: a give-back of O (capped at the total), an
   * APPLY of N. Everything else leaves it alone.
   */
  function settle(start: number, total: number, plans: ApplicationPlan[]) {
    let balance = start
    // plan order: the give-backs of an adjustment come before its applications
    for (const p of plans) {
      if (p.cell === 'UNAPPLY_CARRY' || p.cell === 'UNAPPLY_SKIP' || p.cell === 'UNAPPLY_PENDING') balance = Math.min(total, Math.round((balance + p.originalAmount) * 100) / 100)
      if (p.cell === 'APPLY') balance = Math.round((balance - p.newAmount) * 100) / 100
    }
    return balance
  }

  it('over every mix of up to three applications of a TOTAL_BALANCE 120 at 70 (applied amounts 70 or 50), and any consumption by other weeks, no settled balance is below 0 or above 120', () => {
    const total = 120
    const amount = 70
    const shapes: Array<{ wasApplied: boolean; appliedAt: number; final: Status }> = []
    for (const wasApplied of [true, false]) for (const final of STATUSES) shapes.push({ wasApplied, appliedAt: wasApplied ? 70 : 0, final })

    let checked = 0
    const pick = (n: number): typeof shapes[] => {
      if (n === 0) return [[]]
      const rest = pick(n - 1)
      return shapes.flatMap((s) => rest.map((r) => [s, ...r]))
    }
    for (const count of [1, 2, 3]) {
      for (const mix of pick(count)) {
        // the balance can be 0..120 minus what the applied ones absorbed (at 70 or the 50 left of the last instalment)
        const absorbed = mix.filter((m) => m.wasApplied).length === 0 ? 0 : mix.filter((m) => m.wasApplied).length * 40
        for (const otherWeeks of [0, 10, 30, 80]) {
          const start = total - absorbed - otherWeeks
          if (start < 0) continue
          const adj = totalBalance(start, { amount, totalBalance: total, status: start === 0 ? 'COMPLETED' : 'ACTIVE' })
          const apps = mix.map((m, i) => application(adj, { id: `app-${i}`, employeeId: `emp-${i}`, approvalStatus: m.final, appliedAmount: m.wasApplied ? 40 : amount }))
          const snapshot = mix.map((m, i) => entry(`app-${i}`, m.wasApplied ? 'APPROVED' : 'PENDING', { appliedAmount: m.wasApplied ? 40 : amount }))
          const paid = mix.map((_m, i) => `emp-${i}`)

          const { plans } = plan(apps, { snapshot, paid })
          const settled = settle(start, total, plans)

          expect(settled, JSON.stringify({ mix, otherWeeks })).toBeGreaterThanOrEqual(0)
          expect(settled, JSON.stringify({ mix, otherWeeks })).toBeLessThanOrEqual(total)
          // every APPLY took at most what was left when it ran: the running balance never went negative on the way
          let running = start
          for (const p of plans) {
            if (p.cell === 'UNAPPLY_CARRY' || p.cell === 'UNAPPLY_SKIP' || p.cell === 'UNAPPLY_PENDING') running = Math.min(total, running + p.originalAmount)
            if (p.cell === 'APPLY') {
              expect(p.newAmount, JSON.stringify({ mix, otherWeeks, p })).toBeLessThanOrEqual(running + 1e-9)
              running = Math.round((running - p.newAmount) * 100) / 100
              expect(running).toBeGreaterThanOrEqual(0)
            }
          }
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('a give-back is capped at the total even when the applied amounts add up to more than it', () => {
    const adj = totalBalance(110, { amount: 70, totalBalance: 120 })
    const apps = [
      application(adj, { id: 'app-a', approvalStatus: 'SKIPPED', employeeId: 'emp-1' }),
      application(adj, { id: 'app-b', approvalStatus: 'SKIPPED', employeeId: 'emp-2' }),
    ]
    const { plans } = plan(apps, { snapshot: [entry('app-a', 'APPROVED', { appliedAmount: 70 }), entry('app-b', 'APPROVED', { appliedAmount: 70 })], paid: ['emp-1', 'emp-2'] })

    expect(settle(110, 120, plans)).toBe(120)
  })

  it('an adjustment with no total (END_WEEK) never needs a cap: nothing is below zero', () => {
    const adj = endWeek()
    const app = application(adj, { approvalStatus: 'APPROVED' })

    expect(single(app, { snapshot: [entry('app-1', 'PENDING')] }).newAmount).toBe(500)
  })
})
