/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '@/features/payroll-adjustments/__tests__/support/memory-db'

// The correction's money path, run end to end against an in-memory database (the REAL adjustment and
// correction services; only the week lock, the adjustment row lock, the punch review and the audit writer are
// stubbed):
//
//   beginCorrection        snapshots how each of the week's applications is (status, amount, carry-forward),
//                          then resets them to PENDING
//   approve/skip in it     change a status only (never an adjustment's balance)
//   the draft              plans the settlement for the employees it pays and freezes what it deducts into the
//                          applications; its rows carry those amounts (`draft()` below does what the
//                          recalculation does)
//   approveRevision        plans again under the locks, refuses a draft that differs from the plan
//                          (REVISION_STALE), then settles every application's net effect on its adjustment's
//                          balance, once:
//
//     before \ after | APPROVED, paid | SKIPPED, or employee left out | PENDING, paid
//     applied        | nothing        | balance back, carry forward    | balance back, stays PENDING
//     not applied    | apply it now   | carry forward, no balance      | nothing
//
//   abandonCorrection      only puts the statuses back
//
// Every number below is worked out by hand in the test that uses it.

vi.mock('@/lib/prisma', async () => {
  const { createMemoryDb } = await import('@/features/payroll-adjustments/__tests__/support/memory-db')
  return { default: createMemoryDb() }
})
vi.mock('@/features/attendance-sync/services/week-lock.service', () => ({ lockWeekRow: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', () => ({ lockAdjustmentRows: vi.fn() }))
vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))
vi.mock('@/features/attendance-sync/services/attendance-audit.service', () => ({ auditEntry: vi.fn() }))

import prismaImport from '@/lib/prisma'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { lockAdjustmentRows } from '@/features/payroll-adjustments/services/adjustment-lock.service'
import { freezeDraftAdjustmentAmounts, parseAdjustmentSnapshot } from '@/features/payroll-correction/services/adjustment-settlement'
import {
  abandonCorrection,
  approveAdjustmentInCorrection,
  approveRevision,
  beginCorrection,
  skipAdjustmentInCorrection,
} from '@/features/payroll-correction/services/correction.service'
import { amountToApply } from '@/features/payroll-adjustments/services/adjustment.service'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import { AdjustmentServiceError } from '@/features/payroll-adjustments/types/adjustment.types'

const db = prismaImport as unknown as MemoryDb

// July 2025: no daylight-saving change near these dates in any zone, so "+7 days" is the same everywhere.
const RUN = 'run-1'
const UPLOAD = 'upload-1'
const REV1 = 'rev-1'
const DRAFT = 'rev-2'
const PREV_START = new Date('2025-07-03T00:00:00.000Z')
const PREV_END = new Date('2025-07-09T00:00:00.000Z')
const WEEK_START = new Date('2025-07-10T00:00:00.000Z')
const WEEK_END = new Date('2025-07-16T00:00:00.000Z')
const NEXT_START = new Date('2025-07-17T00:00:00.000Z')
const NEXT_END = new Date('2025-07-23T00:00:00.000Z')
const T0 = new Date('2025-07-17T08:00:00.000Z') // when the original approval applied things

const PAID = ['emp-1', 'emp-2']
const LEFT_OUT = 'emp-9'

type Row = Record<string, any>

function adj(over: Row = {}): Row {
  return {
    id: 'adj-1',
    employeeId: 'emp-1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'RECURRING',
    amount: 500,
    reason: 'Advance recovery',
    startPayrollWeekStartDate: WEEK_START,
    startPayrollWeekEndDate: WEEK_END,
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

/** A TOTAL_BALANCE adjustment: `amount` a week until `totalBalance` is paid back; `remainingBalance` is what is left. */
const totalBalance = (remainingBalance: number, over: Row = {}) =>
  adj({ recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 2000, remainingBalance, ...over })

/** FIXED_WEEKS: 1500 in 3 weeks, so 500 a week; `remainingBalance` is what is still to pay. */
const fixedWeeks = (remainingBalance: number, over: Row = {}) =>
  adj({ recurrenceEndType: 'FIXED_WEEKS', totalRecurrenceWeeks: 3, totalBalance: 1500, remainingBalance, ...over })

const oneTime = (over: Row = {}) => adj({ recurrenceType: 'ONE_TIME', ...over })

function app(over: Row = {}): Row {
  return {
    id: 'app-1',
    payrollAdjustmentId: 'adj-1',
    employeeId: 'emp-1',
    payrollRunId: RUN,
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    appliedAmount: 500,
    approvalStatus: 'APPROVED',
    appliedAt: T0,
    approvedAt: null,
    skippedAt: null,
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
    ...over,
  }
}

/** An application the original approval applied to the week. */
const applied = (over: Row = {}) => app({ approvalStatus: 'APPROVED', ...over })
/** An application nobody approved (left PENDING when the payroll was approved). */
const pending = (over: Row = {}) => app({ approvalStatus: 'PENDING', payrollRunId: null, appliedAt: null, ...over })
/** An application the weekly review skipped: it is carried to NEXT_START, where a PENDING one waits. */
const skippedBefore = (over: Row = {}) =>
  app({ approvalStatus: 'SKIPPED', payrollRunId: null, appliedAt: null, skippedAt: T0, carriedForwardToPayrollWeekStartDate: NEXT_START, ...over })
/** The PENDING application a skip created for the following week. */
const waiting = (over: Row = {}) =>
  app({
    id: 'app-next',
    approvalStatus: 'PENDING',
    payrollRunId: null,
    payrollWeekStartDate: NEXT_START,
    payrollWeekEndDate: NEXT_END,
    appliedAt: null,
    ...over,
  })
/** An application of an earlier week of the same adjustment, applied by an earlier payroll. */
const earlier = (id: string, start = PREV_START, end = PREV_END) =>
  app({ id, payrollRunId: 'run-0', payrollWeekStartDate: start, payrollWeekEndDate: end, approvalStatus: 'APPROVED' })

function seedWorld(paidInRevision1 = [...PAID, LEFT_OUT]) {
  db.reset()
  db.seed('payrollRun', [
    {
      id: RUN,
      payrollWeekStartDate: WEEK_START,
      payrollWeekEndDate: WEEK_END,
      status: 'APPROVED',
      currentRevisionNumber: 1,
      totalDeductions: 500,
      totalNetPayable: 9000,
    },
  ])
  db.seed('payrollRevision', [
    { id: REV1, payrollRunId: RUN, revisionNumber: 1, status: 'APPROVED', isCurrent: true, totalDeductions: 500, totalNetPayable: 9000 },
  ])
  db.seed(
    'payrollRunEmployee',
    paidInRevision1.map((employeeId) => ({ payrollRunId: RUN, payrollRevisionId: REV1, employeeId, netPayable: 3000 })),
  )
  db.seed('attendanceUpload', [
    { id: UPLOAD, payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, isActiveForPayrollWeek: true, source: 'ETIMEOFFICE', status: 'APPROVED' },
  ])
}

function seedAdjustment(adjustment: Row, applications: Row[]) {
  db.seed('payrollAdjustment', [adjustment])
  db.seed('payrollAdjustmentApplication', applications)
}

type Sums = Map<string, { additions: number; deductions: number }>

/** The draft revision a correction's "recalculate" would have saved, paying `paid`; `sums` are what its rows deduct and add. */
function seedDraft(paid: string[] = PAID, sums: Sums = new Map()) {
  db.seed('payrollRevision', [{ id: DRAFT, payrollRunId: RUN, revisionNumber: 2, status: 'DRAFT', isCurrent: false, totalDeductions: 0, totalNetPayable: 9000 }])
  db.seed(
    'payrollRunEmployee',
    paid.map((employeeId) => ({
      payrollRunId: RUN,
      payrollRevisionId: DRAFT,
      employeeId,
      netPayable: 3000,
      additions: sums.get(employeeId)?.additions ?? 0,
      deductions: sums.get(employeeId)?.deductions ?? 0,
    })),
  )
}

async function pointSessionAtDraft() {
  await db.payrollCorrectionSession.updateMany({ where: { payrollRunId: RUN, status: 'IN_PROGRESS' }, data: { draftRevisionId: DRAFT } })
}

/**
 * What recalculateAndCreateRevision does for the adjustments, inside its transaction: plan the settlement for the
 * employees the draft pays, freeze what it deducts into the applications, and save the draft whose rows carry
 * those sums (replacing an earlier draft). Then the session points at it.
 */
async function draft(paid: string[] = PAID) {
  const session = await db.payrollCorrectionSession.findFirst({ where: { payrollRunId: RUN, status: 'IN_PROGRESS' } })
  const snapshot = session && Array.isArray(session.adjustmentSnapshotJson) ? parseAdjustmentSnapshot(session.adjustmentSnapshotJson) : null
  const sums = await freezeDraftAdjustmentAmounts(db as never, db.rows('payrollRun')[0] as never, snapshot, new Set(paid))
  await db.payrollRunEmployee.deleteMany({ where: { payrollRevisionId: DRAFT } })
  await db.payrollRevision.deleteMany({ where: { id: DRAFT } })
  seedDraft(paid, sums)
  await pointSessionAtDraft()
}

interface Correction {
  skip?: string[]
  approve?: string[]
  paid?: string[]
}

/** Open a correction, do what the user does in it, save the draft and approve it. */
async function correct({ skip = [], approve = [], paid = PAID }: Correction = {}) {
  await beginCorrection(RUN)
  for (const id of skip) await skipAdjustmentInCorrection(id)
  for (const id of approve) await approveAdjustmentInCorrection(id)
  await draft(paid)
  const result = await approveRevision(DRAFT)
  expectApproved(true)
  return result
}

/** Every scenario also proves the approval itself went through (or, for `false`, that it did not). */
function expectApproved(approved: boolean, session = true) {
  expect(db.rows('payrollRevision').find((r) => r.id === DRAFT)).toMatchObject(
    approved ? { status: 'APPROVED', isCurrent: true } : { status: 'DRAFT', isCurrent: false },
  )
  expect(db.rows('payrollRun')[0]).toMatchObject(
    approved ? { status: 'REVISED', currentRevisionNumber: 2 } : { status: 'APPROVED', currentRevisionNumber: 1 },
  )
  if (session) expect(db.rows('payrollCorrectionSession').at(-1)).toMatchObject({ status: approved ? 'APPLIED' : 'IN_PROGRESS' })
}

const adjRow = (id = 'adj-1') => db.rows('payrollAdjustment').find((r) => r.id === id)!
const appRow = (id = 'app-1') => db.rows('payrollAdjustmentApplication').find((r) => r.id === id)!
const appsOf = (adjustmentId = 'adj-1') => db.rows('payrollAdjustmentApplication').filter((r) => r.payrollAdjustmentId === adjustmentId)
const nextWeek = (adjustmentId = 'adj-1') =>
  appsOf(adjustmentId).filter((r) => r.payrollWeekStartDate.getTime() === NEXT_START.getTime())
const adjustmentWrites = () => db.log.filter((op) => op.startsWith('payrollAdjustment.'))

beforeEach(() => {
  seedWorld()
  vi.clearAllMocks()
  vi.mocked(lockWeekRow).mockImplementation((async () => {
    db.log.push('lock')
    return { id: UPLOAD, source: 'ETIMEOFFICE', status: 'APPROVED', syncLockedAt: null, approvedAt: T0, payrollWeekStartDate: WEEK_START }
  }) as never)
  vi.mocked(lockAdjustmentRows).mockImplementation((async () => {
    db.log.push('lock-adjustments')
  }) as never)
})

// ─── Row 1: applied before, approved again ────────────────────────────────────

describe('approveRevision, applied before and APPROVED again: nothing moves', () => {
  it('TOTAL_BALANCE 2000, 500 a week, 1500 left: still 1500, still ACTIVE, nothing created', async () => {
    seedAdjustment(totalBalance(1500), [applied()])

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
    expect(appsOf()).toHaveLength(1)
    expect(adjustmentWrites()).toEqual([])
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
    expect(db.log).not.toContain('payrollAdjustmentApplication.deleteMany')
  })

  it('FIXED_WEEKS 1500 over 3, week 2 applied, 500 left and week 3 waiting: still 500, still one waiting', async () => {
    seedAdjustment(fixedWeeks(500), [earlier('app-wk1'), applied(), waiting({ appliedAmount: 500 })])

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appsOf()).toHaveLength(3)
    expect(nextWeek()).toHaveLength(1)
    expect(adjustmentWrites()).toEqual([])
  })

  it('ONE_TIME already COMPLETED: stays COMPLETED', async () => {
    seedAdjustment(oneTime({ status: 'COMPLETED' }), [applied()])

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ status: 'COMPLETED', skippedCarryForwardCount: 0 })
    expect(appsOf()).toHaveLength(1)
  })

  it('the 70/50 cap: total 120 at 70 a week, the last 50 applied (nothing left, COMPLETED). Approved again it keeps 50, not a fresh min(70, 0) = 0', async () => {
    seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [applied({ appliedAmount: 50 })])

    await correct({ approve: ['app-1'] })

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
  })
})

// ─── Row 2: applied before, now SKIPPED (or the employee is left out) ─────────

describe('approveRevision, applied before and now SKIPPED or left out: the balance goes back and the instalment is carried forward', () => {
  it('TOTAL_BALANCE 2000, 1500 left after the 500 applied: skipped, 2000 left again, a PENDING 500 waits next week, counted once', async () => {
    seedAdjustment(totalBalance(1500), [applied()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({
      approvalStatus: 'PENDING',
      appliedAmount: 500,
      employeeId: 'emp-1',
      payrollWeekEndDate: NEXT_END,
      payrollAdjustmentId: 'adj-1',
    })
  })

  it('TOTAL_BALANCE 1000 paid off by this week (0 left, COMPLETED): skipped, 500 left again and ACTIVE', async () => {
    seedAdjustment(totalBalance(0, { totalBalance: 1000, status: 'COMPLETED' }), [applied()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 500, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
  })

  it('FIXED_WEEKS week 2 (500 left, week 3 already waiting): skipped, 1000 left, no second waiting application', async () => {
    seedAdjustment(fixedWeeks(500), [earlier('app-wk1'), applied(), waiting({ appliedAmount: 500 })])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1) // the one that was already waiting
  })

  it('FIXED_WEEKS week 3, the last (nothing left, COMPLETED): skipped, 500 left, ACTIVE, and a PENDING 500 is created for next week', async () => {
    seedAdjustment(fixedWeeks(0, { status: 'COMPLETED' }), [earlier('app-wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')), earlier('app-wk2'), applied()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 500, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500 })
  })

  it('ONE_TIME 500 (COMPLETED): skipped, ACTIVE again, a PENDING 500 waits next week', async () => {
    seedAdjustment(oneTime({ status: 'COMPLETED' }), [applied()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500 })
  })

  it('END_WEEK (no balance): skipped, only the status and the carry-forward change', async () => {
    seedAdjustment(adj({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: NEXT_START, status: 'ACTIVE' }), [applied()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: null, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
  })

  it('the 70/50 cap: total 120 at 70 a week, the last 50 applied. Skipped, it gives back the 50 it took (50 left), not 70 and not the whole 120', async () => {
    seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [applied({ appliedAmount: 50 })])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    // The carried instalment is the adjustment's 70; approving it later applies what is left: 50.
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 70 })
    expect(amountToApply(adjRow() as never)).toBe(50)
  })

  it('the balance cannot go back above the total: 100 left + 50 applied would be 150, the total is 120', async () => {
    seedAdjustment(totalBalance(100, { amount: 70, totalBalance: 120 }), [applied({ appliedAmount: 50 })])

    await correct({ skip: ['app-1'] })

    expect(adjRow().remainingBalance).toBe(120)
  })

  it('an employee the revision leaves out, application untouched in the correction (PENDING): same as skipped. 1500 left -> 2000, carried, counted', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT })])

    await correct({ paid: PAID }) // LEFT_OUT is not paid in the draft

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
  })

  it('an employee the revision leaves out whose application was approved again in the correction: still 2000 (applied before), carried', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT })])

    await correct({ approve: ['app-1'], paid: PAID })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('SKIPPED')
  })

  it('an employee left out with a ONE_TIME COMPLETED application: ACTIVE again and carried', async () => {
    seedAdjustment(oneTime({ employeeId: LEFT_OUT, status: 'COMPLETED' }), [applied({ employeeId: LEFT_OUT })])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
  })
})

// ─── Row 3: applied before, left PENDING for an employee who is paid ─────────

describe('approveRevision, applied before and left PENDING for a paid employee: the balance goes back, nothing is carried', () => {
  it('TOTAL_BALANCE 1500 left -> 2000, the application stays PENDING, nothing is created, nothing counted', async () => {
    seedAdjustment(totalBalance(1500), [applied()])

    await correct() // no approve, no skip: PENDING

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow()).toMatchObject({ approvalStatus: 'PENDING', carriedForwardToPayrollWeekStartDate: null, skippedAt: null })
    expect(appsOf()).toHaveLength(1)
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
  })

  it('ONE_TIME COMPLETED -> ACTIVE, still PENDING, not carried', async () => {
    seedAdjustment(oneTime({ status: 'COMPLETED' }), [applied()])

    await correct()

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow().approvalStatus).toBe('PENDING')
    expect(appsOf()).toHaveLength(1)
  })

  it('FIXED_WEEKS last week (COMPLETED, 0 left) -> 500 left, ACTIVE, PENDING', async () => {
    seedAdjustment(fixedWeeks(0, { status: 'COMPLETED' }), [earlier('app-wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')), earlier('app-wk2'), applied()])

    await correct()

    expect(adjRow()).toMatchObject({ remainingBalance: 500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow().approvalStatus).toBe('PENDING')
    expect(nextWeek()).toHaveLength(0)
  })
})

// ─── Row 4: not applied before, now APPROVED ─────────────────────────────────

describe('approveRevision, not applied before and now APPROVED: it is applied now, at the amount stored when it was approved', () => {
  it('TOTAL_BALANCE 2000, nothing applied yet (PENDING): approved, 500 taken off, 1500 left, ACTIVE, no instalment scheduled', async () => {
    seedAdjustment(totalBalance(2000), [pending()])

    await correct({ approve: ['app-1'] })

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appsOf()).toHaveLength(1)
  })

  it('the 70/50 cap: 50 left at 70 a week. It is stored as 50, takes 50 off, 0 left, COMPLETED', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])

    await correct({ approve: ['app-1'] })

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
  })

  it('row d: a balance that moved after the draft froze 50 makes the draft stale (nothing written); recalculated, it takes 70 off: 120 -> 50', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    await draft() // freezes 50: the draft deducts 50
    expect(appRow().appliedAmount).toBe(50)
    // another week's application of the same adjustment is skipped meanwhile, which gives balance back
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 120 } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
    expectApproved(false)

    await draft() // recalculated: the plan now says 70
    expect(appRow().appliedAmount).toBe(70)
    await approveRevision(DRAFT)

    expectApproved(true)
    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
  })

  it('FIXED_WEEKS week 1 of 3 (1500 left): 500 taken off, 1000 left, ACTIVE, a PENDING 500 is scheduled for the next week', async () => {
    seedAdjustment(fixedWeeks(1500), [pending()])

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500, employeeId: 'emp-1', payrollWeekEndDate: NEXT_END })
  })

  it('FIXED_WEEKS week 3 of 3 (500 left, two weeks already approved): 0 left, COMPLETED, nothing scheduled', async () => {
    seedAdjustment(fixedWeeks(500), [earlier('app-wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')), earlier('app-wk2'), pending()])

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
    expect(nextWeek()).toHaveLength(0)
  })

  it('ONE_TIME 500: COMPLETED', async () => {
    seedAdjustment(oneTime(), [pending()])

    await correct({ approve: ['app-1'] })

    expect(adjRow().status).toBe('COMPLETED')
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
  })

  it('END_WEEK ending next week: ACTIVE, a PENDING is scheduled for next week; ending this week: COMPLETED, nothing scheduled', async () => {
    seedAdjustment(adj({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: NEXT_START }), [pending()])
    await correct({ approve: ['app-1'] })
    expect(adjRow().status).toBe('ACTIVE')
    expect(nextWeek()).toHaveLength(1)

    seedWorld()
    seedAdjustment(adj({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: WEEK_START }), [pending()])
    await correct({ approve: ['app-1'] })
    expect(adjRow().status).toBe('COMPLETED')
    expect(nextWeek()).toHaveLength(0)
  })

  it('an application the weekly review had SKIPPED: the carry-forward it made is taken back and the balance is taken off. 2000 -> 1500', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore(), waiting()])

    await correct({ approve: ['app-1'] })

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: null, appliedAmount: 500 })
    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE' })
    expect(nextWeek()).toHaveLength(0) // the PENDING that waited for next week is gone
  })

  it('an application created after the correction opened (not in the snapshot) and approved: applied now', async () => {
    await beginCorrection(RUN)
    seedAdjustment(totalBalance(2000), [pending()])
    await approveAdjustmentInCorrection('app-1')
    await draft()

    await approveRevision(DRAFT)

    expectApproved(true)
    expect(appRow().approvalStatus).toBe('APPROVED')
    expect(adjRow().remainingBalance).toBe(1500)
  })

  it('does not touch the balance when the application is approved in the correction: only approveRevision does', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)

    await approveAdjustmentInCorrection('app-1')

    expect(adjRow().remainingBalance).toBe(2000)
    expect(adjustmentWrites()).toEqual([])
  })
})

// ─── Row 5: not applied before, now SKIPPED (or left out) ────────────────────

describe('approveRevision, not applied before and now SKIPPED or left out: carried forward and counted, the balance is not touched', () => {
  it('TOTAL_BALANCE 2000 (PENDING, skipped in the correction): still 2000, carried, counted once', async () => {
    seedAdjustment(totalBalance(2000), [pending()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500 })
  })

  it('an employee the revision leaves out whose application was never applied: still 2000, carried, counted', async () => {
    seedAdjustment(totalBalance(2000, { employeeId: LEFT_OUT }), [pending({ employeeId: LEFT_OUT })])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(nextWeek()).toHaveLength(1)
  })

  it('ONE_TIME never applied and left out: stays ACTIVE (not completed), carried', async () => {
    seedAdjustment(oneTime({ employeeId: LEFT_OUT }), [pending({ employeeId: LEFT_OUT })])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
  })

  it('a PENDING application of a paid employee is left as it is: not carried, not counted, nothing created', async () => {
    seedAdjustment(totalBalance(2000), [pending()])

    await correct()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow()).toMatchObject({ approvalStatus: 'PENDING', skippedAt: null, carriedForwardToPayrollWeekStartDate: null })
    expect(appsOf()).toHaveLength(1)
    expect(adjustmentWrites()).toEqual([])
  })

  it('skipped by the weekly review (never linked to the run, so the correction does not reset it) and left alone: still SKIPPED, carried once, counted once', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore(), waiting()])
    await beginCorrection(RUN)
    expect(appRow().approvalStatus).toBe('SKIPPED') // not reset: it is not on the run

    await correct()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
  })

  it('skipped by an earlier correction (linked to the run, so this correction resets it to PENDING) and skipped again: nothing more is carried or counted', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore({ payrollRunId: RUN }), waiting()])

    await correct({ skip: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(nextWeek()).toHaveLength(1)
  })

  it('skipped by an earlier correction and left PENDING for a paid employee: nothing happens (the earlier carry-forward is not repeated)', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore({ payrollRunId: RUN }), waiting()])

    await correct()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('PENDING')
    expect(nextWeek()).toHaveLength(1)
  })
})

// ─── No snapshot: a draft made without a session ──────────────────────────────

describe('approveRevision with no snapshot (a draft made without a session): the application\'s own status says whether it was applied', () => {
  async function approveWithoutSession(paid: string[] = PAID) {
    // No session, so no snapshot: the plan reads each application's own status.
    const sums = await freezeDraftAdjustmentAmounts(db as never, db.rows('payrollRun')[0] as never, null, new Set(paid))
    seedDraft(paid, sums)
    const result = await approveRevision(DRAFT)
    expectApproved(true, false)
    return result
  }

  it('APPROVED and paid: nothing (1500 stays 1500)', async () => {
    seedAdjustment(totalBalance(1500), [applied()])

    await approveWithoutSession()

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE', skippedCarryForwardCount: 0 })
    expect(appRow().approvalStatus).toBe('APPROVED')
    expect(adjustmentWrites()).toEqual([])
  })

  it('APPROVED and left out: the balance goes back (1500 -> 2000) and it is carried and counted', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT })])

    await approveWithoutSession()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
  })

  it('PENDING and left out: carried and counted, balance untouched (2000)', async () => {
    seedAdjustment(totalBalance(2000, { employeeId: LEFT_OUT }), [pending({ employeeId: LEFT_OUT })])

    await approveWithoutSession()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('SKIPPED')
  })

  it('PENDING and paid: nothing', async () => {
    seedAdjustment(totalBalance(2000), [pending()])

    await approveWithoutSession()

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 0 })
    expect(appRow().approvalStatus).toBe('PENDING')
  })

  it('SKIPPED already (paid or left out): nothing more, counted once', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore(), waiting()])
    await approveWithoutSession()
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })

    seedWorld()
    seedAdjustment(totalBalance(2000, { employeeId: LEFT_OUT, skippedCarryForwardCount: 1 }), [skippedBefore({ employeeId: LEFT_OUT }), waiting({ employeeId: LEFT_OUT })])
    await approveWithoutSession()
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
  })

  it('a CANCELLED adjustment is not settled, even for a left-out employee', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT, status: 'CANCELLED' }), [applied({ employeeId: LEFT_OUT })])

    await approveWithoutSession()

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'CANCELLED', skippedCarryForwardCount: 0 })
    expect(appRow().approvalStatus).toBe('APPROVED')
  })

  it('a session whose snapshot is null (an older session) is treated the same way: the status of the application decides', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT })])
    await beginCorrection(RUN)
    await db.payrollCorrectionSession.updateMany({ where: { status: 'IN_PROGRESS' }, data: { adjustmentSnapshotJson: null } })
    // beginCorrection reset the application to PENDING; an older session never reset it, so put it back as it was
    await db.payrollAdjustmentApplication.updateMany({ where: { id: 'app-1' }, data: { approvalStatus: 'APPROVED' } })
    await draft(PAID)

    await approveRevision(DRAFT)

    expectApproved(true)
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
  })

  it('a week with no adjustments at all approves and writes nothing to adjustments', async () => {
    await expect(approveWithoutSession()).resolves.toMatchObject({ status: 'APPROVED', revisionNumber: 2 })

    expect(adjustmentWrites()).toEqual([])
  })
})

// ─── Settled once, and all or nothing ────────────────────────────────────────

describe('approveRevision settles once and either does everything or nothing', () => {
  it('approving the same draft again is refused (REVISION_NOT_DRAFT) and moves no balance a second time', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await correct({ approve: ['app-1'] })
    expect(adjRow().remainingBalance).toBe(1500)

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 0 })
  })

  it('a settle that throws aborts the approval with nothing written: revision still a draft, run and adjustments as they were', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    await draft()
    const before = db.snapshot()
    db.failOn('payrollAdjustment.update', new Error('balance write failed'))

    await expect(approveRevision(DRAFT)).rejects.toThrow('balance write failed')

    expect(db.snapshot()).toEqual(before)
    expect(db.rows('payrollRevision').find((r) => r.id === DRAFT)).toMatchObject({ status: 'DRAFT', isCurrent: false })
    expect(db.rows('payrollRevision').find((r) => r.id === REV1)).toMatchObject({ status: 'APPROVED', isCurrent: true })
    expect(db.rows('payrollRun')[0]).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
    expect(db.rows('payrollCorrectionSession')[0]).toMatchObject({ status: 'IN_PROGRESS', appliedAt: null })
    expect(adjRow().remainingBalance).toBe(2000)
  })

  it('a failure on the second of two applications rolls back the first one\'s balance too', async () => {
    seedAdjustment(totalBalance(2000, { id: 'adj-a' }), [pending({ id: 'app-a', payrollAdjustmentId: 'adj-a' })])
    seedAdjustment(totalBalance(2000, { id: 'adj-b', employeeId: 'emp-2' }), [pending({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2' })])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-a')
    await approveAdjustmentInCorrection('app-b')
    await draft()
    const before = db.snapshot()
    db.failOn('payrollAdjustment.update', new Error('second balance write failed'), 1)
    db.log.length = 0

    await expect(approveRevision(DRAFT)).rejects.toThrow('second balance write failed')

    expect(adjustmentWrites()).toEqual(['payrollAdjustment.update', 'payrollAdjustment.update']) // the first went through ...
    expect(db.snapshot()).toEqual(before) // ... and was rolled back
    expect(adjRow('adj-a').remainingBalance).toBe(2000)
    expect(adjRow('adj-b').remainingBalance).toBe(2000)
  })

  it('a failing carry-forward insert aborts the same way: nothing written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-1')
    await draft()
    const before = db.snapshot()
    db.failOn('payrollAdjustmentApplication.create', new Error('insert failed'))

    await expect(approveRevision(DRAFT)).rejects.toThrow('insert failed')

    expect(db.snapshot()).toEqual(before)
  })

  it('takes the week lock before it settles anything', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    await draft()
    db.log.length = 0

    await approveRevision(DRAFT)

    expect(db.log[0]).toBe('lock')
    expect(db.log.indexOf('lock')).toBeLessThan(db.log.indexOf('payrollAdjustment.update'))
  })
})

// ─── Approve and skip inside a correction: status only ────────────────────────

/** What a click writes besides the application: it deletes the draft and clears the session's pointer to it. */
const INVALIDATES_THE_DRAFT = ['payrollRunEmployee.deleteMany', 'payrollRevision.deleteMany', 'payrollCorrectionSession.update']

describe('approveAdjustmentInCorrection / skipAdjustmentInCorrection change a status and nothing else', () => {
  it('skip: PENDING -> SKIPPED with a time; the adjustment is not written and no application is created or deleted', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    const before = db.rows('payrollAdjustment')
    await beginCorrection(RUN)
    db.log.length = 0

    await expect(skipAdjustmentInCorrection('app-1')).resolves.toEqual({ applicationId: 'app-1', approvalStatus: 'SKIPPED' })

    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: null })
    expect(appRow().skippedAt).toBeInstanceOf(Date)
    expect(db.rows('payrollAdjustment')).toEqual(before)
    expect(appsOf()).toHaveLength(1)
    expect(db.log).toEqual(['lock', 'payrollAdjustmentApplication.update', ...INVALIDATES_THE_DRAFT])
  })

  it('approve of an application that was not applied: the click does not write the amount (the 70/50 cap: 70 stays), the recalculation freezes 50, balance untouched', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await beginCorrection(RUN)
    db.log.length = 0

    await expect(approveAdjustmentInCorrection('app-1')).resolves.toEqual({ applicationId: 'app-1', approvalStatus: 'APPROVED' })

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 70 })
    expect(appRow().appliedAt).toBeInstanceOf(Date)
    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
    expect(db.log).toEqual(['lock', 'payrollAdjustmentApplication.update', ...INVALIDATES_THE_DRAFT])

    await draft()

    expect(appRow().appliedAmount).toBe(50)
    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
  })

  it('approve of an application that was applied: keeps the amount it was applied at (50), not a fresh min(70, 0) = 0', async () => {
    seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [applied({ appliedAmount: 50 })])
    await beginCorrection(RUN)

    await approveAdjustmentInCorrection('app-1')

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
  })

  it('approving an application the weekly review skipped leaves its carry-forward alone until the revision is approved', async () => {
    seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore(), waiting()])
    await beginCorrection(RUN)

    await approveAdjustmentInCorrection('app-1')

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
  })

  it('skip, approve and skip again follow the status and never write an adjustment', async () => {
    seedAdjustment(totalBalance(1500), [applied()])
    const before = db.rows('payrollAdjustment')
    await beginCorrection(RUN)

    await skipAdjustmentInCorrection('app-1')
    expect(appRow().approvalStatus).toBe('SKIPPED')
    await approveAdjustmentInCorrection('app-1')
    expect(appRow().approvalStatus).toBe('APPROVED')
    await skipAdjustmentInCorrection('app-1')
    expect(appRow().approvalStatus).toBe('SKIPPED')

    expect(db.rows('payrollAdjustment')).toEqual(before)
    expect(adjustmentWrites()).toEqual([])
    expect(appsOf()).toHaveLength(1)
  })

  it('approving an APPROVED application and skipping a SKIPPED one are refused (INVALID_APPROVAL_STATUS) and write nothing', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    db.log.length = 0

    const again = await approveAdjustmentInCorrection('app-1').catch((e) => e)
    expect(again).toBeInstanceOf(AdjustmentServiceError)
    expect(again).toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already approved' })

    await skipAdjustmentInCorrection('app-1')
    const twice = await skipAdjustmentInCorrection('app-1').catch((e) => e)
    expect(twice).toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already skipped' })
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(db.log.filter((op) => op === 'payrollAdjustmentApplication.update')).toHaveLength(1) // only the one skip above
  })

  it('an application that does not exist is APPLICATION_NOT_FOUND', async () => {
    await expect(approveAdjustmentInCorrection('nope')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' })
    await expect(skipAdjustmentInCorrection('nope')).rejects.toBeInstanceOf(CorrectionServiceError)
  })

  it('with no correction open for the application\'s week it is CORRECTION_NOT_ACTIVE and nothing is written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    // no beginCorrection

    await expect(approveAdjustmentInCorrection('app-1')).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    await expect(skipAdjustmentInCorrection('app-1')).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(appRow().approvalStatus).toBe('PENDING')
    expect(db.log).toEqual([])
  })

  it('a correction open for another week does not count', async () => {
    seedAdjustment(totalBalance(2000), [pending({ payrollWeekStartDate: PREV_START, payrollWeekEndDate: PREV_END })])
    await beginCorrection(RUN) // the run is for WEEK_START

    await expect(approveAdjustmentInCorrection('app-1')).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('the session ending while the click waits for the week lock (abandoned or applied) is CORRECTION_NOT_ACTIVE and nothing is written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    vi.mocked(lockWeekRow).mockImplementationOnce((async () => {
      await db.payrollCorrectionSession.updateMany({ where: { status: 'IN_PROGRESS' }, data: { status: 'ABANDONED' } })
      db.log.length = 0
      return null
    }) as never)

    await expect(approveAdjustmentInCorrection('app-1')).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(appRow().approvalStatus).toBe('PENDING')
    expect(db.log).toEqual([])
  })

  it('a write that fails leaves the application as it was', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    const before = db.snapshot()
    db.failOn('payrollAdjustmentApplication.update', new Error('update failed'))

    await expect(skipAdjustmentInCorrection('app-1')).rejects.toThrow('update failed')

    expect(db.snapshot()).toEqual(before)
  })
})

// ─── Abandon: only statuses ──────────────────────────────────────────────────

describe('abandonCorrection puts statuses back and moves no balance', () => {
  const TA = new Date('2025-07-17T08:00:00.000Z')
  const TB = new Date('2025-07-17T09:30:00.000Z')
  const TC = new Date('2025-07-17T10:45:00.000Z')

  function seedMixedWeek() {
    seedAdjustment(totalBalance(1500, { id: 'adj-a' }), [applied({ id: 'app-a', payrollAdjustmentId: 'adj-a', approvedAt: TA, appliedAt: TB })])
    seedAdjustment(totalBalance(2000, { id: 'adj-b', employeeId: 'emp-2', skippedCarryForwardCount: 1 }), [
      skippedBefore({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2', skippedAt: TC }),
      waiting({ id: 'app-b-next', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2' }),
    ])
    seedAdjustment(oneTime({ id: 'adj-c', status: 'COMPLETED' }), [applied({ id: 'app-c', payrollAdjustmentId: 'adj-c' })])
    seedAdjustment(totalBalance(2000, { id: 'adj-d' }), [pending({ id: 'app-d', payrollAdjustmentId: 'adj-d' })])
    seedAdjustment(oneTime({ id: 'adj-e', status: 'COMPLETED' }), [applied({ id: 'app-e', payrollAdjustmentId: 'adj-e', isReversed: true })])
  }

  it('after approving, skipping and drafting: every application is back as it was (status, reversed, times), the adjustments are exactly as before, and nothing was created', async () => {
    seedMixedWeek()
    const adjustmentsBefore = db.rows('payrollAdjustment')
    const applicationsBefore = db.rows('payrollAdjustmentApplication')
    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-a') // applied -> skipped
    await approveAdjustmentInCorrection('app-b') // skipped -> approved
    await skipAdjustmentInCorrection('app-d') // pending -> skipped
    await approveAdjustmentInCorrection('app-c') // applied -> approved again
    seedDraft()
    await pointSessionAtDraft()
    db.log.length = 0

    const result = await abandonCorrection(RUN)

    expect(result).toMatchObject({ discardedEdits: 0 })
    expect(db.rows('payrollAdjustmentApplication')).toEqual(applicationsBefore)
    expect(db.rows('payrollAdjustment')).toEqual(adjustmentsBefore)
    expect(adjustmentWrites()).toEqual([])
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
    expect(db.log).not.toContain('payrollAdjustmentApplication.deleteMany')
    // the draft and the session
    expect(db.rows('payrollRevision').map((r) => r.id)).toEqual([REV1])
    expect(db.rows('payrollRunEmployee').every((r) => r.payrollRevisionId === REV1)).toBe(true)
    expect(db.rows('payrollCorrectionSession')[0]).toMatchObject({ status: 'ABANDONED', appliedAt: null })
    expect(db.rows('payrollCorrectionSession')[0].abandonedAt).toBeInstanceOf(Date)
  })

  it('a correction opened and abandoned with no change at all gives every application its status back (the reset to PENDING is undone)', async () => {
    seedMixedWeek()
    const applicationsBefore = db.rows('payrollAdjustmentApplication')
    await beginCorrection(RUN)
    expect(appRow('app-a').approvalStatus).toBe('PENDING') // the reset (it is on the run)
    expect(appRow('app-e').approvalStatus).toBe('PENDING')
    expect(appRow('app-e').isReversed).toBe(false)
    expect(appRow('app-b').approvalStatus).toBe('SKIPPED') // not on the run: not reset

    await abandonCorrection(RUN)

    expect(db.rows('payrollAdjustmentApplication')).toEqual(applicationsBefore)
    expect(adjRow('adj-a').remainingBalance).toBe(1500)
  })

  it('the run and the current revision are untouched', async () => {
    seedMixedWeek()
    await beginCorrection(RUN)
    seedDraft()
    await pointSessionAtDraft()
    const runBefore = db.rows('payrollRun')[0]
    const rev1Before = db.rows('payrollRevision').find((r) => r.id === REV1)

    await abandonCorrection(RUN)

    expect(db.rows('payrollRun')[0]).toEqual(runBefore)
    expect(db.rows('payrollRevision').find((r) => r.id === REV1)).toEqual(rev1Before)
  })

  it('a failure while putting the statuses back rolls everything back: the session stays open and the draft stays', async () => {
    seedMixedWeek()
    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-a')
    seedDraft()
    await pointSessionAtDraft()
    const before = db.snapshot()
    db.failOn('payrollAdjustmentApplication.updateMany', new Error('restore failed'), 1)

    await expect(abandonCorrection(RUN)).rejects.toThrow('restore failed')

    expect(db.snapshot()).toEqual(before)
    expect(db.rows('payrollCorrectionSession')[0].status).toBe('IN_PROGRESS')
    expect(db.rows('payrollRevision').map((r) => r.id)).toContain(DRAFT)
  })

  it('abandoning twice: the second finds no open correction', async () => {
    seedMixedWeek()
    await beginCorrection(RUN)
    await abandonCorrection(RUN)

    await expect(abandonCorrection(RUN)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('an abandoned correction can be followed by a new one that snapshots the restored state', async () => {
    seedAdjustment(totalBalance(1500), [applied()])
    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-1')
    await abandonCorrection(RUN)

    await correct({ approve: ['app-1'] }) // a fresh correction: applied before, approved again -> nothing moves

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 0 })
    expect(auditEntry).not.toHaveBeenCalled() // no punch copy, so no audit rows either
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The settlement redesign: the draft, the plan, the locks and the abandon, end to end against state
// ═════════════════════════════════════════════════════════════════════════════

const STALE_ADJUSTMENTS = 'This preview is out of date: an adjustment or its balance changed after it was calculated. Go back and recalculate.'

const draftRow = (employeeId = 'emp-1') => db.rows('payrollRunEmployee').find((r) => r.payrollRevisionId === DRAFT && r.employeeId === employeeId)!
const draftIds = () => db.rows('payrollRevision').filter((r) => r.status === 'DRAFT').map((r) => r.id)
const pointer = () => db.rows('payrollCorrectionSession').at(-1)!.draftRevisionId
/** The draft's employee rows only (the revision is already there): `sums` are what each row deducts and adds. */
function seedDraftRows(paid: string[] = PAID, sums: Sums = new Map()) {
  db.seed(
    'payrollRunEmployee',
    paid.map((employeeId) => ({
      payrollRunId: RUN,
      payrollRevisionId: DRAFT,
      employeeId,
      netPayable: 3000,
      additions: sums.get(employeeId)?.additions ?? 0,
      deductions: sums.get(employeeId)?.deductions ?? 0,
    })),
  )
}
/** Opens the correction and leaves a draft behind: what the user has once they have recalculated. */
async function openWithDraft(approve: string[] = [], skip: string[] = []) {
  await beginCorrection(RUN)
  for (const id of skip) await skipAdjustmentInCorrection(id)
  for (const id of approve) await approveAdjustmentInCorrection(id)
  await draft()
}

// ─── A click invalidates the draft ───────────────────────────────────────────

describe('approving or skipping in a correction invalidates the draft, in the same transaction', () => {
  it.each([
    ['approve', approveAdjustmentInCorrection],
    ['skip', skipAdjustmentInCorrection],
  ])('%s after a draft: the draft revision and its employee rows are deleted, the session pointer is cleared, and the old draft id can no longer be approved', async (_name, click) => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft()
    expect(pointer()).toBe(DRAFT)
    expect(draftIds()).toEqual([DRAFT])

    await click('app-1')

    expect(pointer()).toBeNull()
    expect(draftIds()).toEqual([])
    expect(db.rows('payrollRunEmployee').every((r) => r.payrollRevisionId === REV1)).toBe(true)
    const before = db.snapshot()
    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' })
    expect(db.snapshot()).toEqual(before)
    // the run, the current revision and the session are as they were
    expect(db.rows('payrollRun')[0]).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
    expect(db.rows('payrollRevision').find((r) => r.id === REV1)).toMatchObject({ status: 'APPROVED', isCurrent: true })
    expect(db.rows('payrollCorrectionSession').at(-1)).toMatchObject({ status: 'IN_PROGRESS' })
  })

  it('a status change that did not invalidate the draft (the removed reverse and approve-skipped paths, or any future one) is still caught by the plan: REVISION_STALE, nothing written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    await draft() // the draft deducts 500
    await db.payrollAdjustmentApplication.updateMany({ where: { id: 'app-1' }, data: { approvalStatus: 'SKIPPED', skippedAt: new Date() } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expect(db.snapshot()).toEqual(before)
    expectApproved(false)
  })

  it('the same for an application approved behind the draft\'s back: the draft deducted nothing, the plan says 500', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft()
    expect(draftRow().deductions).toBe(0)
    await db.payrollAdjustmentApplication.updateMany({ where: { id: 'app-1' }, data: { approvalStatus: 'APPROVED', appliedAt: new Date() } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expect(db.snapshot()).toEqual(before)
    expect(adjRow().remainingBalance).toBe(2000)
  })

  it.each([
    ['approve', 'payrollCorrectionSession.update', approveAdjustmentInCorrection],
    ['approve', 'payrollRevision.deleteMany', approveAdjustmentInCorrection],
    ['skip', 'payrollCorrectionSession.update', skipAdjustmentInCorrection],
    ['skip', 'payrollRunEmployee.deleteMany', skipAdjustmentInCorrection],
  ])('%s: when %s fails the click is rolled back whole: the status, the draft and the pointer are as they were', async (_name, failing, click) => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft()
    const before = db.snapshot()
    db.failOn(failing, new Error('write failed'))

    await expect(click('app-1')).rejects.toThrow('write failed')

    expect(db.snapshot()).toEqual(before)
    expect(appRow().approvalStatus).toBe('PENDING')
    expect(pointer()).toBe(DRAFT)
    expect(draftIds()).toEqual([DRAFT])
  })

  it('a refused approval leaves the application, the draft and the pointer exactly as they were', async () => {
    seedAdjustment(oneTime({ status: 'COMPLETED' }), [pending()])
    await openWithDraft()
    const before = db.snapshot()
    db.log.length = 0

    await expect(approveAdjustmentInCorrection('app-1')).rejects.toBeInstanceOf(AdjustmentServiceError)

    expect(db.snapshot()).toEqual(before)
    expect(db.log.filter((op) => op !== 'lock')).toEqual([])
    expect(pointer()).toBe(DRAFT)
  })

  it('a click on a correction with no draft yet has nothing to clear and clears nothing else', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)

    await approveAdjustmentInCorrection('app-1')

    expect(pointer()).toBeNull()
    expect(draftIds()).toEqual([])
    expect(db.rows('payrollRevision').map((r) => r.id)).toEqual([REV1])
  })
})

// ─── The click is refused when the approval could not be applied ─────────────

describe('approving in a correction is refused (ADJUSTMENT_NOT_APPLICABLE) when it could not be applied', () => {
  async function refused(message: string) {
    await openWithDraft()
    const before = db.snapshot()
    const error = await approveAdjustmentInCorrection('app-1').catch((e) => e)
    expect(error).toBeInstanceOf(AdjustmentServiceError)
    expect(error).toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message })
    // the application, the draft and the pointer are untouched, and no balance moved
    expect(db.snapshot()).toEqual(before)
    expect(appRow().approvalStatus).toBe('PENDING')
    expect(pointer()).toBe(DRAFT)
    expect(draftIds()).toEqual([DRAFT])
  }

  it('the adjustment is COMPLETED (another week took the last instalment)', async () => {
    seedAdjustment(totalBalance(0, { status: 'COMPLETED', totalBalance: 1000 }), [pending()])

    await refused('This adjustment is already completed or cancelled.')
  })

  it('the adjustment is CANCELLED', async () => {
    seedAdjustment(totalBalance(2000, { status: 'CANCELLED' }), [pending()])

    await refused('This adjustment is already completed or cancelled.')
  })

  it('nothing is left to deduct (0 left, still ACTIVE)', async () => {
    seedAdjustment(totalBalance(0), [pending()])

    await refused('Nothing is left to deduct for this adjustment.')
  })

  it('row k: ONE_TIME skipped in week W (carried to W+1) and skipped again there (carried to W+2): approving W is refused', async () => {
    const W2 = new Date('2025-07-24T00:00:00.000Z')
    seedAdjustment(oneTime(), [
      skippedBefore({ payrollRunId: RUN }),
      waiting({ approvalStatus: 'SKIPPED', skippedAt: T0, carriedForwardToPayrollWeekStartDate: W2 }),
      app({ id: 'app-w2', approvalStatus: 'PENDING', payrollRunId: null, payrollWeekStartDate: W2, payrollWeekEndDate: new Date('2025-07-30T00:00:00.000Z'), appliedAt: null }),
    ])

    await refused('This adjustment was carried to the next week and has been dealt with there.')
  })

  it('row k, the contrast: with the PENDING at W+1 still waiting, approving W is allowed, and approving the revision takes the carry-forward back (no second deduction later)', async () => {
    seedAdjustment(oneTime(), [skippedBefore({ payrollRunId: RUN }), waiting()])
    await beginCorrection(RUN)

    await expect(approveAdjustmentInCorrection('app-1')).resolves.toEqual({ applicationId: 'app-1', approvalStatus: 'APPROVED' })
    await draft()
    await approveRevision(DRAFT)

    expect(adjRow().status).toBe('COMPLETED')
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: null, appliedAmount: 500 })
    expect(nextWeek()).toHaveLength(0)
  })

  it('two ONE_TIME applications of one adjustment: the second approval (by id) is refused at the click; approved the other way round both clicks pass and the draft refuses the pair', async () => {
    seedAdjustment(oneTime(), [pending({ id: 'app-a' }), pending({ id: 'app-b', employeeId: 'emp-2' })])
    await beginCorrection(RUN)

    await approveAdjustmentInCorrection('app-a')
    await expect(approveAdjustmentInCorrection('app-b')).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE' })
    expect(appRow('app-b').approvalStatus).toBe('PENDING')

    // the other way round: the click only reports a problem found for the row it is on, and the draft is checked as a whole
    await skipAdjustmentInCorrection('app-a')
    await approveAdjustmentInCorrection('app-b')
    await approveAdjustmentInCorrection('app-a')
    const before = db.snapshot()
    await expect(draft()).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE' })
    expect(db.snapshot()).toEqual(before)
    expect(adjRow().status).toBe('ACTIVE')
  })
})

// ─── The amount: frozen by the draft, not by the click ───────────────────────

describe('the amount an application is applied at', () => {
  it('skipping after a draft froze 50 puts the 70 back (the adjustment\'s own amount: it is not applied)', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    expect(appRow().appliedAmount).toBe(50)

    await skipAdjustmentInCorrection('app-1')

    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', appliedAmount: 70 })
    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
  })

  it('skipping an application that was applied keeps the amount it was applied at (50), it is not reset to the adjustment\'s 70', async () => {
    seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [applied({ appliedAmount: 50 })])
    await beginCorrection(RUN)

    await skipAdjustmentInCorrection('app-1')

    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', appliedAmount: 50 })
  })

  it('approving again after skipping goes through the freeze again: 70 stored after the click, 50 after the new draft', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    await skipAdjustmentInCorrection('app-1')
    await approveAdjustmentInCorrection('app-1')
    expect(appRow().appliedAmount).toBe(70)

    await draft()

    expect(appRow().appliedAmount).toBe(50)
    expect(draftRow().deductions).toBe(50)
  })

  it('a draft that fails its freeze (nothing left) writes no amount and leaves the earlier draft in place', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 0, status: 'COMPLETED' } })
    const before = db.snapshot()

    await expect(draft()).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE' })

    expect(db.snapshot()).toEqual(before)
    expect(appRow().appliedAmount).toBe(50)
  })
})

// ─── approveRevision plans again and refuses a draft that differs ────────────

describe('approveRevision refuses a draft that is not what the plan says now (REVISION_STALE), and writes nothing', () => {
  const capped = (remaining: number, over: Row = {}) => totalBalance(remaining, { amount: 70, totalBalance: 120, ...over })

  it('row c: another week takes 30 after the draft froze 50 (20 left): stale; after recalculating the draft deducts 20, and approving takes the balance to 0, never below', async () => {
    seedAdjustment(capped(50), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    expect(draftRow().deductions).toBe(50)
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 20 } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expect(db.snapshot()).toEqual(before)
    expectApproved(false)
    expect(adjRow()).toMatchObject({ remainingBalance: 20, status: 'ACTIVE' })

    await draft()
    expect(appRow().appliedAmount).toBe(20)
    expect(draftRow().deductions).toBe(20)
    await approveRevision(DRAFT)

    expectApproved(true)
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 20 })
  })

  it('row b: another week takes the rest (0 left, COMPLETED): stale; the next recalculation fails with ADJUSTMENT_NOT_APPLICABLE and changes nothing', async () => {
    seedAdjustment(capped(50), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 0, status: 'COMPLETED' } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })
    expect(db.snapshot()).toEqual(before)

    await expect(draft()).rejects.toMatchObject({ code: 'ADJUSTMENT_NOT_APPLICABLE', message: 'This adjustment is already completed or cancelled.' })
    expect(db.snapshot()).toEqual(before)
    expectApproved(false)
  })

  it('row b, the way out: the user skips the row; the new draft carries nothing for a COMPLETED adjustment and the approval goes through', async () => {
    seedAdjustment(capped(50), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 0, status: 'COMPLETED' } })

    await skipAdjustmentInCorrection('app-1')
    await draft()
    await approveRevision(DRAFT)

    expectApproved(true)
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED', skippedCarryForwardCount: 0 })
    expect(nextWeek()).toHaveLength(0)
  })

  it('row d: the balance grew: stale, and the draft that follows deducts the larger amount: 120 -> 50', async () => {
    seedAdjustment(capped(50), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 120 } })

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })
    await draft()
    expect(draftRow().deductions).toBe(70)
    await approveRevision(DRAFT)

    expect(adjRow()).toMatchObject({ remainingBalance: 50, status: 'ACTIVE' })
  })

  it('an adjustment cancelled after the draft: stale, nothing written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft(['app-1'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { status: 'CANCELLED' } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
  })

  it.each([
    ['the deduction is 0.01 short', { additions: 0, deductions: 499.99 }],
    ['the deduction is 0.01 over', { additions: 0, deductions: 500.01 }],
    ['the deduction is missing', { additions: 0, deductions: 0 }],
    ['it is on the additions side', { additions: 500, deductions: 0 }],
    ['it is on both sides', { additions: 500, deductions: 500 }],
  ])('a draft row whose amounts differ from the plan (%s): stale, nothing written', async (_why, wrong) => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft(['app-1'])
    await db.payrollRunEmployee.deleteMany({ where: { payrollRevisionId: DRAFT } })
    seedDraftRows(PAID, new Map([['emp-1', wrong]]))
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expect(db.snapshot()).toEqual(before)
    expectApproved(false)
  })

  it('a draft that deducts for an employee the plan has no application for: stale', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft(['app-1'])
    await db.payrollRunEmployee.deleteMany({ where: { payrollRevisionId: DRAFT } })
    seedDraftRows(PAID, new Map([['emp-1', { additions: 0, deductions: 500 }], ['emp-2', { additions: 0, deductions: 100 }]]))
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
  })

  it('who the draft pays is what its own rows say: one that leaves the employee out is consistent, and the approved application is carried, not deducted', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft(['app-1'])
    await db.payrollRunEmployee.deleteMany({ where: { payrollRevisionId: DRAFT } })
    seedDraftRows(['emp-2'])

    await approveRevision(DRAFT)

    expectApproved(true)
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(nextWeek()).toHaveLength(1)
  })

  it('a frozen amount that is not the plan\'s (the draft rows agree with it, the application does not): stale', async () => {
    seedAdjustment(capped(50), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1'])
    // the stored amount changed behind the draft (it was frozen at 50): the rows still say 50
    await db.payrollAdjustmentApplication.updateMany({ where: { id: 'app-1' }, data: { appliedAmount: 70 } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
  })

  it('a draft made without a session: a weekly approval between the draft and the approval makes it stale, and nothing is written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    const sums = await freezeDraftAdjustmentAmounts(db as never, db.rows('payrollRun')[0] as never, null, new Set(PAID))
    seedDraft(PAID, sums)
    expect(draftRow().deductions).toBe(0) // PENDING: not deducted
    // the weekly review approves it (and moves the balance) meanwhile
    await db.payrollAdjustmentApplication.updateMany({ where: { id: 'app-1' }, data: { approvalStatus: 'APPROVED', appliedAt: new Date() } })
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 1500 } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expect(db.snapshot()).toEqual(before)
    expectApproved(false, false)
  })

  it('a draft made without a session: a weekly skip between them is stale too', async () => {
    seedAdjustment(totalBalance(1500), [applied()])
    const sums = await freezeDraftAdjustmentAmounts(db as never, db.rows('payrollRun')[0] as never, null, new Set(PAID))
    seedDraft(PAID, sums)
    expect(draftRow().deductions).toBe(500)
    await db.payrollAdjustmentApplication.updateMany({
      where: { id: 'app-1' },
      data: { approvalStatus: 'SKIPPED', skippedAt: new Date(), carriedForwardToPayrollWeekStartDate: NEXT_START },
    })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
  })

  it('a stale refusal is all or nothing across adjustments: one stale adjustment stops the other from being applied', async () => {
    seedAdjustment(totalBalance(2000, { id: 'adj-a' }), [pending({ id: 'app-a', payrollAdjustmentId: 'adj-a' })])
    seedAdjustment(capped(50, { id: 'adj-b', employeeId: 'emp-2' }), [pending({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2', appliedAmount: 70 })])
    await openWithDraft(['app-a', 'app-b'])
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-b' }, data: { remainingBalance: 20 } })
    const before = db.snapshot()
    db.log.length = 0

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(db.snapshot()).toEqual(before)
    expect(adjRow('adj-a').remainingBalance).toBe(2000)
    expect(adjustmentWrites()).toEqual([])
  })
})

// ─── Table rows end to end ───────────────────────────────────────────────────

describe('decision table rows, through draft and approval', () => {
  it('row e: applied 50 (the 70/50 cap) and kept while the balance moved on to 20: the draft deducts 50 and approving writes no adjustment (20 stays 20)', async () => {
    seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [applied({ appliedAmount: 50 })])
    await beginCorrection(RUN)
    await approveAdjustmentInCorrection('app-1')
    await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 20, status: 'ACTIVE' } }) // a skip elsewhere gave 20 back
    await draft()
    expect(draftRow().deductions).toBe(50)
    db.log.length = 0

    await approveRevision(DRAFT)

    expect(adjRow()).toMatchObject({ remainingBalance: 20, status: 'ACTIVE' })
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 50 })
    expect(adjustmentWrites()).toEqual([])
  })

  it('row f: applied 50, skipped now, with 20 left: 70 left, ACTIVE, carried once at the adjustment\'s 70; the draft deducts 0', async () => {
    seedAdjustment(totalBalance(20, { amount: 70, totalBalance: 120 }), [applied({ appliedAmount: 50 })])
    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-1')
    await draft()
    expect(draftRow().deductions).toBe(0)

    await approveRevision(DRAFT)

    expect(adjRow()).toMatchObject({ remainingBalance: 70, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 70 })
  })

  it('row h: ADDITION, ONE_TIME 300, newly approved: the draft adds 300, COMPLETED, no balance', async () => {
    seedAdjustment(oneTime({ adjustmentType: 'ADDITION', amount: 300 }), [pending({ appliedAmount: 300 })])
    await openWithDraft(['app-1'])
    expect(draftRow()).toMatchObject({ additions: 300, deductions: 0 })

    await approveRevision(DRAFT)

    expect(adjRow()).toMatchObject({ status: 'COMPLETED', remainingBalance: null })
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 300 })
  })

  it('row i: ADDITION, ONE_TIME 300 applied, the employee left out: COMPLETED -> ACTIVE, a PENDING 300 next week, counted once', async () => {
    seedAdjustment(oneTime({ adjustmentType: 'ADDITION', amount: 300, status: 'COMPLETED', employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT, appliedAmount: 300 })])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 300, employeeId: LEFT_OUT })
  })

  it('row j: FIXED_WEEKS 200 over 3 (66.67 a week), the third week newly approved with 66.66 left: the draft deducts 66.66, 0 left, COMPLETED by count, nothing scheduled', async () => {
    seedAdjustment(fixedWeeks(66.66, { amount: 66.67, totalBalance: 200 }), [
      earlier('app-wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')),
      earlier('app-wk2'),
      pending({ appliedAmount: 66.67 }),
    ])
    await openWithDraft(['app-1'])
    expect(draftRow().deductions).toBe(66.66)

    await approveRevision(DRAFT)

    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
    expect(appRow().appliedAmount).toBe(66.66)
    expect(nextWeek()).toHaveLength(0)
  })

  it('row l: a linked SKIPPED application (carried, count 1), reset to PENDING, the employee left out again: SKIPPED again, count stays 1, still one next-week row', async () => {
    seedAdjustment(totalBalance(2000, { employeeId: LEFT_OUT, skippedCarryForwardCount: 1 }), [skippedBefore({ employeeId: LEFT_OUT, payrollRunId: RUN }), waiting({ employeeId: LEFT_OUT })])

    await correct({ paid: PAID })

    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(adjustmentWrites()).toEqual([])
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
  })

  it('row l, the next week\'s application already approved meanwhile: still no new row, and the approved one is not touched', async () => {
    seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT, skippedCarryForwardCount: 1 }), [
      skippedBefore({ employeeId: LEFT_OUT, payrollRunId: RUN }),
      waiting({ employeeId: LEFT_OUT, approvalStatus: 'APPROVED', appliedAt: T0 }),
    ])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'APPROVED' })
    expect(appRow().approvalStatus).toBe('SKIPPED')
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
  })

  it('a SKIPPED application with no carry date recorded (old data), left out in the correction: SKIPPED before still means carried, so it is not carried again', async () => {
    seedAdjustment(totalBalance(2000, { employeeId: LEFT_OUT, skippedCarryForwardCount: 1 }), [
      skippedBefore({ employeeId: LEFT_OUT, payrollRunId: RUN, carriedForwardToPayrollWeekStartDate: null }),
    ])

    await correct({ paid: PAID })

    expect(adjRow()).toMatchObject({ skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(0)
    expect(appRow().approvalStatus).toBe('SKIPPED')
  })
})

// ─── The locks ───────────────────────────────────────────────────────────────

describe('approveRevision takes the adjustment rows after the week row and reads them after the lock', () => {
  it('locks the scope\'s adjustments after the week lock and before the first adjustment write', async () => {
    seedAdjustment(totalBalance(2000, { id: 'adj-a' }), [
      pending({ id: 'app-a', payrollAdjustmentId: 'adj-a' }),
      pending({ id: 'app-a2', payrollAdjustmentId: 'adj-a', employeeId: 'emp-2' }),
    ])
    seedAdjustment(totalBalance(2000, { id: 'adj-b', employeeId: 'emp-2' }), [pending({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2' })])
    await openWithDraft(['app-a', 'app-b'])
    db.log.length = 0
    vi.mocked(lockAdjustmentRows).mockClear()

    await approveRevision(DRAFT)

    expect(lockAdjustmentRows).toHaveBeenCalledTimes(1)
    const [, ids] = vi.mocked(lockAdjustmentRows).mock.calls[0]
    expect(new Set(ids)).toEqual(new Set(['adj-a', 'adj-b']))
    expect(db.log.indexOf('lock')).toBeGreaterThanOrEqual(0)
    expect(db.log.indexOf('lock-adjustments')).toBeGreaterThan(db.log.indexOf('lock'))
    expect(db.log.indexOf('payrollAdjustment.update')).toBeGreaterThan(db.log.indexOf('lock-adjustments'))
  })

  it('a week with no applications asks with an empty list (a no-op in the lock service)', async () => {
    await beginCorrection(RUN)
    await draft()
    vi.mocked(lockAdjustmentRows).mockClear()

    await approveRevision(DRAFT)

    expect(lockAdjustmentRows).toHaveBeenCalledTimes(1)
    expect(vi.mocked(lockAdjustmentRows).mock.calls[0][1]).toEqual([])
  })

  it('the balance the plan uses is read after the lock: one that changed while the lock was awaited makes the draft stale instead of overdrawing', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await openWithDraft(['app-1']) // freezes 50
    // another transaction commits a 30 deduction while this one waits for the row lock
    vi.mocked(lockAdjustmentRows).mockImplementationOnce((async () => {
      db.log.push('lock-adjustments')
      await db.payrollAdjustment.updateMany({ where: { id: 'adj-1' }, data: { remainingBalance: 20 } })
    }) as never)

    // had the balance been read before the lock the plan would still say 50 (what the draft froze) and the approval would have
    // gone through, taking 50 off the 20 that is left
    await expect(approveRevision(DRAFT)).rejects.toMatchObject({ code: 'REVISION_STALE', message: STALE_ADJUSTMENTS })

    expectApproved(false)
    expect(appRow().appliedAmount).toBe(50)
  })

  it('a click never takes an adjustment lock: it writes no adjustment', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await beginCorrection(RUN)
    vi.mocked(lockAdjustmentRows).mockClear()

    await approveAdjustmentInCorrection('app-1')
    await skipAdjustmentInCorrection('app-1')

    expect(lockAdjustmentRows).not.toHaveBeenCalled()
  })

  it('a failing lock stops the approval before anything is promoted or written', async () => {
    seedAdjustment(totalBalance(2000), [pending()])
    await openWithDraft(['app-1'])
    const before = db.snapshot()
    vi.mocked(lockAdjustmentRows).mockRejectedValueOnce(new Error('lock timeout'))

    await expect(approveRevision(DRAFT)).rejects.toThrow('lock timeout')

    expect(db.snapshot()).toEqual(before)
    expectApproved(false)
  })
})

// ─── Abandon ─────────────────────────────────────────────────────────────────

describe('abandonCorrection after the settlement redesign', () => {
  it('puts back the amount a draft froze: 70 stored, 50 frozen, 70 again after the abandon, and no balance moved', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    const adjustmentsBefore = db.rows('payrollAdjustment')
    await openWithDraft(['app-1'])
    expect(appRow().appliedAmount).toBe(50)

    await abandonCorrection(RUN)

    expect(appRow()).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 70 })
    expect(db.rows('payrollAdjustment')).toEqual(adjustmentsBefore)
    expect(draftIds()).toEqual([])
  })

  it('an application created after the correction opened and approved in it is PENDING again, at the adjustment\'s amount, with no times; one that was skipped likewise', async () => {
    await beginCorrection(RUN)
    // created after the correction opened (a skip in the week before carries a PENDING into this week)
    seedAdjustment(totalBalance(2000, { id: 'adj-a' }), [pending({ id: 'app-a', payrollAdjustmentId: 'adj-a', appliedAmount: 500 })])
    seedAdjustment(totalBalance(2000, { id: 'adj-b', amount: 300, employeeId: 'emp-2' }), [pending({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2', appliedAmount: 300 })])
    const adjustmentsBefore = db.rows('payrollAdjustment')
    await approveAdjustmentInCorrection('app-a')
    await skipAdjustmentInCorrection('app-b')
    await draft()
    expect(appRow('app-a')).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
    expect(appRow('app-a').appliedAt).toBeInstanceOf(Date)

    await abandonCorrection(RUN)

    expect(appRow('app-a')).toMatchObject({ approvalStatus: 'PENDING', appliedAt: null, skippedAt: null, appliedAmount: 500 })
    expect(appRow('app-b')).toMatchObject({ approvalStatus: 'PENDING', appliedAt: null, skippedAt: null, appliedAmount: 300 })
    expect(db.rows('payrollAdjustment')).toEqual(adjustmentsBefore)
  })

  it('a created application whose frozen amount was capped goes back to the adjustment\'s own amount (70), not the 50 the draft froze', async () => {
    await beginCorrection(RUN)
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await approveAdjustmentInCorrection('app-1')
    await draft()
    expect(appRow().appliedAmount).toBe(50)

    await abandonCorrection(RUN)

    expect(appRow()).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 70 })
  })

  it('writes no adjustment from the day the correction opens to the day it is abandoned, whatever was clicked and drafted in between', async () => {
    seedAdjustment(totalBalance(1500, { id: 'adj-a' }), [applied({ id: 'app-a', payrollAdjustmentId: 'adj-a' })])
    seedAdjustment(totalBalance(50, { id: 'adj-b', amount: 70, totalBalance: 120, employeeId: 'emp-2' }), [pending({ id: 'app-b', payrollAdjustmentId: 'adj-b', employeeId: 'emp-2', appliedAmount: 70 })])
    seedAdjustment(oneTime({ id: 'adj-c', status: 'COMPLETED' }), [applied({ id: 'app-c', payrollAdjustmentId: 'adj-c' })])
    const adjustmentsBefore = db.rows('payrollAdjustment')
    const applicationsBefore = db.rows('payrollAdjustmentApplication')
    db.log.length = 0

    await beginCorrection(RUN)
    await skipAdjustmentInCorrection('app-a')
    await approveAdjustmentInCorrection('app-b')
    await draft()
    await approveAdjustmentInCorrection('app-a') // another click after the draft
    await skipAdjustmentInCorrection('app-c')
    await draft()
    await abandonCorrection(RUN)

    expect(adjustmentWrites()).toEqual([])
    expect(db.rows('payrollAdjustment')).toEqual(adjustmentsBefore)
    expect(db.rows('payrollAdjustmentApplication')).toEqual(applicationsBefore)
    expect(db.log).not.toContain('payrollAdjustmentApplication.create')
    expect(db.log).not.toContain('payrollAdjustmentApplication.deleteMany')
  })

  it('a session opened before the amount was recorded (snapshot entries without appliedAmount) gets its statuses back, and its amount is left alone', async () => {
    seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [pending({ appliedAmount: 70 })])
    await beginCorrection(RUN)
    const session = db.rows('payrollCorrectionSession')[0]
    const older = (session.adjustmentSnapshotJson as Row[]).map((entry) => {
      const rest = { ...entry }
      delete rest.appliedAmount
      delete rest.carriedForwardToPayrollWeekStartDate
      return rest
    })
    await db.payrollCorrectionSession.updateMany({ where: { id: session.id }, data: { adjustmentSnapshotJson: older } })
    await approveAdjustmentInCorrection('app-1')
    await draft()
    expect(appRow().appliedAmount).toBe(50)

    await abandonCorrection(RUN)

    expect(appRow().approvalStatus).toBe('PENDING')
    expect(appRow().appliedAmount).toBe(50) // there is no recorded amount to put back
    expect(adjRow().remainingBalance).toBe(50)
  })

  it('a session with no snapshot at all cannot tell a new row from an old one: it resets none and moves no balance', async () => {
    await beginCorrection(RUN)
    seedAdjustment(totalBalance(2000), [pending()])
    await db.payrollCorrectionSession.updateMany({ where: { status: 'IN_PROGRESS' }, data: { adjustmentSnapshotJson: null } })
    await approveAdjustmentInCorrection('app-1')

    await abandonCorrection(RUN)

    expect(appRow().approvalStatus).toBe('APPROVED') // left as it is, by design (see abandonCorrection)
    expect(adjRow().remainingBalance).toBe(2000)
    expect(db.rows('payrollCorrectionSession')[0]).toMatchObject({ status: 'ABANDONED' })
  })

  it('a failure resetting a created application rolls the whole abandon back', async () => {
    await beginCorrection(RUN)
    seedAdjustment(totalBalance(2000), [pending()])
    await approveAdjustmentInCorrection('app-1')
    await draft()
    const before = db.snapshot()
    db.failOn('payrollAdjustmentApplication.update', new Error('reset failed'))

    await expect(abandonCorrection(RUN)).rejects.toThrow('reset failed')

    expect(db.snapshot()).toEqual(before)
    expect(db.rows('payrollCorrectionSession')[0].status).toBe('IN_PROGRESS')
    expect(draftIds()).toEqual([DRAFT])
  })

  it('after abandoning an approved new application, a fresh correction approves it as a plain APPLY: 2000 -> 1500', async () => {
    await beginCorrection(RUN)
    seedAdjustment(totalBalance(2000), [pending()])
    await approveAdjustmentInCorrection('app-1')
    await draft()
    await abandonCorrection(RUN)

    await correct({ approve: ['app-1'] })

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE' })
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500 })
  })
})

// ─── Invariants, across the scenarios ────────────────────────────────────────

describe('invariants after a correction is approved', () => {
  /** total - remaining = what the APPROVED applications absorbed, for a balance-tracking adjustment; 0 <= remaining <= total. */
  function expectBalanceConsistent(id = 'adj-1') {
    const adjustment = adjRow(id)
    expect(adjustment.remainingBalance).toBeGreaterThanOrEqual(0)
    expect(adjustment.remainingBalance).toBeLessThanOrEqual(adjustment.totalBalance)
    const absorbed = appsOf(id).filter((a) => a.approvalStatus === 'APPROVED').reduce((sum, a) => sum + a.appliedAmount, 0)
    expect(Math.round((adjustment.totalBalance - adjustment.remainingBalance) * 100)).toBe(Math.round(absorbed * 100))
  }
  /** At most one instalment waits in the week after, and the count rose by exactly one per application newly carried. */
  function expectCarriedOnce(count: number, id = 'adj-1') {
    expect(nextWeek(id).filter((a) => a.approvalStatus === 'PENDING').length).toBeLessThanOrEqual(1)
    expect(adjRow(id).skippedCarryForwardCount).toBe(count)
  }
  /** The 70 an earlier week took off a 120 balance. */
  const earlierWeekTook70 = () => app({ ...earlier('app-wk1'), appliedAmount: 70 })

  const scenarios: Array<[string, number, () => Promise<void>]> = [
    ['a pending one approved', 0, async () => { seedAdjustment(totalBalance(2000), [pending()]); await correct({ approve: ['app-1'] }) }],
    ['an applied one kept', 0, async () => { seedAdjustment(totalBalance(1500), [applied()]); await correct({ approve: ['app-1'] }) }],
    ['an applied one skipped', 1, async () => { seedAdjustment(totalBalance(1500), [applied()]); await correct({ skip: ['app-1'] }) }],
    ['an applied one left PENDING', 0, async () => { seedAdjustment(totalBalance(1500), [applied()]); await correct() }],
    ['an applied one for an employee left out', 1, async () => { seedAdjustment(totalBalance(1500, { employeeId: LEFT_OUT }), [applied({ employeeId: LEFT_OUT })]); await correct({ paid: PAID }) }],
    ['the 70/50 cap approved', 0, async () => { seedAdjustment(totalBalance(50, { amount: 70, totalBalance: 120 }), [earlierWeekTook70(), pending({ appliedAmount: 70 })]); await correct({ approve: ['app-1'] }) }],
    ['the 70/50 cap applied and skipped', 1, async () => { seedAdjustment(totalBalance(0, { amount: 70, totalBalance: 120, status: 'COMPLETED' }), [earlierWeekTook70(), applied({ appliedAmount: 50 })]); await correct({ skip: ['app-1'] }) }],
    ['a give-back capped at the total', 1, async () => { seedAdjustment(totalBalance(100, { amount: 70, totalBalance: 120 }), [applied({ appliedAmount: 50 })]); await correct({ skip: ['app-1'] }) }],
    ['one skipped before, skipped again', 1, async () => { seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore({ payrollRunId: RUN }), waiting()]); await correct({ skip: ['app-1'] }) }],
    ['one skipped before, approved now (the count is not taken back, as in the weekly flow)', 1, async () => { seedAdjustment(totalBalance(2000, { skippedCarryForwardCount: 1 }), [skippedBefore({ payrollRunId: RUN }), waiting()]); await correct({ approve: ['app-1'] }) }],
    ['two applied ones, one skipped and one kept', 1, async () => {
      seedAdjustment(totalBalance(1000, { id: 'adj-1' }), [applied({ id: 'app-1' }), applied({ id: 'app-2', employeeId: 'emp-2' })])
      await correct({ skip: ['app-1'], approve: ['app-2'] })
    }],
  ]

  it.each(scenarios)('%s: the balance is in range, equals what the approved applications absorbed, and the carry-forward count is %s', async (_name, count, run) => {
    await run()

    expectBalanceConsistent()
    expectCarriedOnce(count)
  })
})
