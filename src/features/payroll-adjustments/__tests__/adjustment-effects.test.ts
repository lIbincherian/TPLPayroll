/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '@/features/payroll-adjustments/__tests__/support/memory-db'

// The weekly review's approve and skip, and the helpers a correction's settle step shares with them
// (amountToApply, applyApprovalToAdjustment, undoApprovalOnAdjustment, carryApplicationForward,
// removeCarryForward). These run the REAL service against an in-memory database and assert the balances,
// so the refactor that split the effects out of approve/skip is pinned to the numbers it must keep:
// the weekly path behaves exactly as it did.

vi.mock('@/lib/prisma', async () => {
  const { createMemoryDb } = await import('@/features/payroll-adjustments/__tests__/support/memory-db')
  return { default: createMemoryDb() }
})
// The adjustment's row lock needs a real database; the memory database has no raw queries.
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', () => ({ lockAdjustmentRows: vi.fn() }))

import prismaImport from '@/lib/prisma'
import {
  amountToApply,
  applyApprovalToAdjustment,
  approveAdjustmentApplication,
  carryApplicationForward,
  removeCarryForward,
  skipAdjustmentApplication,
  undoApprovalOnAdjustment,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { createMemoryDb } from '@/features/payroll-adjustments/__tests__/support/memory-db'
import { AdjustmentServiceError } from '@/features/payroll-adjustments/types/adjustment.types'

const db = prismaImport as unknown as MemoryDb

// July 2025: no daylight-saving change near these dates in any zone.
const PREV_START = new Date('2025-07-03T00:00:00.000Z')
const PREV_END = new Date('2025-07-09T00:00:00.000Z')
const WEEK_START = new Date('2025-07-10T00:00:00.000Z')
const WEEK_END = new Date('2025-07-16T00:00:00.000Z')
const NEXT_START = new Date('2025-07-17T00:00:00.000Z')
const NEXT_END = new Date('2025-07-23T00:00:00.000Z')

type Row = Record<string, any>

const adj = (over: Row = {}): Row => ({
  id: 'adj-1',
  employeeId: 'emp-1',
  adjustmentType: 'DEDUCTION',
  recurrenceType: 'RECURRING',
  amount: 500,
  reason: 'Advance recovery',
  startPayrollWeekStartDate: WEEK_START,
  startPayrollWeekEndDate: WEEK_END,
  endPayrollWeekStartDate: null,
  totalRecurrenceWeeks: null,
  totalBalance: null,
  remainingBalance: null,
  recurrenceEndType: null,
  status: 'ACTIVE',
  skippedCarryForwardCount: 0,
  ...over,
})
const totalBalance = (remaining: number, over: Row = {}) =>
  adj({ recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 2000, remainingBalance: remaining, ...over })
const fixedWeeks = (remaining: number, over: Row = {}) =>
  adj({ recurrenceEndType: 'FIXED_WEEKS', totalRecurrenceWeeks: 3, totalBalance: 1500, remainingBalance: remaining, ...over })

const app = (over: Row = {}): Row => ({
  id: 'app-1',
  payrollAdjustmentId: 'adj-1',
  employeeId: 'emp-1',
  payrollWeekStartDate: WEEK_START,
  payrollWeekEndDate: WEEK_END,
  appliedAmount: 500,
  approvalStatus: 'PENDING',
  ...over,
})
const next = (over: Row = {}) =>
  app({ id: 'app-next', payrollWeekStartDate: NEXT_START, payrollWeekEndDate: NEXT_END, approvalStatus: 'PENDING', ...over })
const earlier = (id: string, start: Date, end: Date) => app({ id, payrollWeekStartDate: start, payrollWeekEndDate: end, approvalStatus: 'APPROVED' })

function seed(adjustment: Row, applications: Row[], target: MemoryDb = db) {
  target.seed('payrollAdjustment', [adjustment])
  target.seed('payrollAdjustmentApplication', applications)
}

const adjRow = (target: MemoryDb = db) => target.rows('payrollAdjustment')[0]
const appRow = (id = 'app-1', target: MemoryDb = db) => target.rows('payrollAdjustmentApplication').find((r) => r.id === id)!
const nextWeek = (target: MemoryDb = db) =>
  target.rows('payrollAdjustmentApplication').filter((r) => r.payrollWeekStartDate.getTime() === NEXT_START.getTime())

beforeEach(() => {
  db.reset()
})

// ─── amountToApply ────────────────────────────────────────────────────────────

describe('amountToApply', () => {
  it('is the instalment, capped at what is left of a TOTAL_BALANCE adjustment', () => {
    expect(amountToApply(totalBalance(2000) as never)).toBe(500)
    expect(amountToApply(totalBalance(500) as never)).toBe(500)
    expect(amountToApply(totalBalance(50, { amount: 70 }) as never)).toBe(50)
    expect(amountToApply(totalBalance(0) as never)).toBe(0)
  })

  it('is the instalment for every other kind of adjustment, whatever its balance says', () => {
    expect(amountToApply(fixedWeeks(100) as never)).toBe(500) // FIXED_WEEKS is not capped
    expect(amountToApply(adj({ recurrenceEndType: 'END_WEEK' }) as never)).toBe(500)
    expect(amountToApply(adj({ recurrenceType: 'ONE_TIME' }) as never)).toBe(500)
    expect(amountToApply(adj({ recurrenceEndType: 'TOTAL_BALANCE', remainingBalance: null }) as never)).toBe(500)
  })

  it('reads decimals the way the database returns them (strings)', () => {
    expect(amountToApply(totalBalance(0, { amount: '70.00', remainingBalance: '49.50' }) as never)).toBe(49.5)
  })
})

// ─── The weekly review: approve ──────────────────────────────────────────────

describe('approveAdjustmentApplication (the weekly review)', () => {
  it('TOTAL_BALANCE 2000 at 500: applied 500, 1500 left, ACTIVE, no next application', async () => {
    seed(totalBalance(2000), [app()])

    const result = await approveAdjustmentApplication('app-1')

    expect(result).toMatchObject({ id: 'app-1', approvalStatus: 'APPROVED', appliedAmount: 500 })
    expect(result.appliedAt).toBeInstanceOf(Date)
    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', appliedAmount: 500, carriedForwardToPayrollWeekStartDate: null })
    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE' })
    expect(db.rows('payrollAdjustmentApplication')).toHaveLength(1)
  })

  it('the 70/50 cap: 50 left at 70 a week applies 50, nothing left, COMPLETED', async () => {
    seed(totalBalance(50, { amount: 70, totalBalance: 120 }), [app({ appliedAmount: 70 })])

    const result = await approveAdjustmentApplication('app-1')

    expect(result.appliedAmount).toBe(50)
    expect(appRow().appliedAmount).toBe(50)
    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
  })

  it('FIXED_WEEKS 1500 over 3: week 1 leaves 1000, ACTIVE, and schedules a PENDING 500 for the next week', async () => {
    seed(fixedWeeks(1500), [app()])

    await approveAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' })
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500, employeeId: 'emp-1', payrollWeekEndDate: NEXT_END })
  })

  it('FIXED_WEEKS week 3 of 3: nothing left, COMPLETED, nothing scheduled', async () => {
    seed(fixedWeeks(500), [earlier('wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')), earlier('wk2', PREV_START, PREV_END), app()])

    await approveAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
    expect(nextWeek()).toHaveLength(0)
  })

  it('does not schedule a second application when one is already waiting for the next week', async () => {
    seed(fixedWeeks(1500), [app(), next()])

    await approveAdjustmentApplication('app-1')

    expect(nextWeek()).toHaveLength(1)
  })

  it('END_WEEK: ACTIVE with a next application before the end week, COMPLETED on it', async () => {
    seed(adj({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: NEXT_START }), [app()])
    await approveAdjustmentApplication('app-1')
    expect(adjRow().status).toBe('ACTIVE')
    expect(nextWeek()).toHaveLength(1)

    db.reset()
    seed(adj({ recurrenceEndType: 'END_WEEK', endPayrollWeekStartDate: WEEK_START }), [app()])
    await approveAdjustmentApplication('app-1')
    expect(adjRow().status).toBe('COMPLETED')
    expect(nextWeek()).toHaveLength(0)
  })

  it('ONE_TIME: COMPLETED', async () => {
    seed(adj({ recurrenceType: 'ONE_TIME' }), [app()])

    await approveAdjustmentApplication('app-1')

    expect(adjRow().status).toBe('COMPLETED')
  })

  it('approving a SKIPPED application takes its carry-forward back and applies it: 2000 -> 1500, the count is not changed', async () => {
    seed(totalBalance(2000, { skippedCarryForwardCount: 1 }), [
      app({ approvalStatus: 'SKIPPED', skippedAt: new Date(), carriedForwardToPayrollWeekStartDate: NEXT_START }),
      next(),
    ])

    await approveAdjustmentApplication('app-1')

    expect(appRow()).toMatchObject({ approvalStatus: 'APPROVED', carriedForwardToPayrollWeekStartDate: null, appliedAmount: 500 })
    expect(nextWeek()).toHaveLength(0)
    expect(adjRow()).toMatchObject({ remainingBalance: 1500, skippedCarryForwardCount: 1 })
  })

  it('refuses an application that is already approved, and one that does not exist; writes nothing', async () => {
    seed(totalBalance(1500), [app({ approvalStatus: 'APPROVED' })])

    await expect(approveAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already approved' })
    await expect(approveAdjustmentApplication('nope')).rejects.toBeInstanceOf(AdjustmentServiceError)
    await expect(approveAdjustmentApplication('nope')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' })

    expect(db.log).toEqual([])
    expect(adjRow().remainingBalance).toBe(1500)
  })
})

// ─── The weekly review: skip ─────────────────────────────────────────────────

describe('skipAdjustmentApplication (the weekly review)', () => {
  it('PENDING TOTAL_BALANCE: SKIPPED with a time, carried to the next week as a PENDING 500, counted once, balance untouched', async () => {
    seed(totalBalance(2000), [app()])

    const result = await skipAdjustmentApplication('app-1')

    expect(result).toMatchObject({ id: 'app-1', approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(appRow().skippedAt).toBeInstanceOf(Date)
    expect(nextWeek()).toHaveLength(1)
    expect(nextWeek()[0]).toMatchObject({ approvalStatus: 'PENDING', appliedAmount: 500, payrollWeekEndDate: NEXT_END, employeeId: 'emp-1' })
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
  })

  it('APPROVED TOTAL_BALANCE (1500 left after 500 applied): the 500 goes back, 2000 left, carried, counted', async () => {
    seed(totalBalance(1500), [app({ approvalStatus: 'APPROVED' })])

    await skipAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE', skippedCarryForwardCount: 1 })
    expect(nextWeek()).toHaveLength(1)
  })

  it('APPROVED TOTAL_BALANCE that was completed: ACTIVE again with the balance back', async () => {
    seed(totalBalance(0, { totalBalance: 1000, status: 'COMPLETED' }), [app({ approvalStatus: 'APPROVED' })])

    await skipAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ remainingBalance: 500, status: 'ACTIVE' })
  })

  it('APPROVED ONE_TIME (COMPLETED): ACTIVE again', async () => {
    seed(adj({ recurrenceType: 'ONE_TIME', status: 'COMPLETED' }), [app({ approvalStatus: 'APPROVED' })])

    await skipAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ status: 'ACTIVE', skippedCarryForwardCount: 1 })
  })

  it('the restored balance never exceeds the total (100 + 50 would be 150; the total is 120)', async () => {
    seed(totalBalance(100, { amount: 70, totalBalance: 120 }), [app({ approvalStatus: 'APPROVED', appliedAmount: 50 })])

    await skipAdjustmentApplication('app-1')

    expect(adjRow().remainingBalance).toBe(120)
  })

  it('does not create a second PENDING when one already waits for the next week', async () => {
    seed(totalBalance(2000), [app(), next()])

    await skipAdjustmentApplication('app-1')

    expect(nextWeek()).toHaveLength(1)
    expect(adjRow().skippedCarryForwardCount).toBe(1)
  })

  it('a skipped application can be approved again: approve then skip then approve returns to the same balance as one approval', async () => {
    seed(totalBalance(2000), [app()])

    await approveAdjustmentApplication('app-1')
    expect(adjRow().remainingBalance).toBe(1500)
    await skipAdjustmentApplication('app-1')
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, status: 'ACTIVE' })
    await approveAdjustmentApplication('app-1')

    expect(adjRow()).toMatchObject({ remainingBalance: 1500, status: 'ACTIVE' })
    expect(nextWeek()).toHaveLength(0) // the approval took the carry-forward back
  })

  it('refuses an application that is already skipped, and one that does not exist', async () => {
    seed(totalBalance(2000), [app({ approvalStatus: 'SKIPPED' })])

    await expect(skipAdjustmentApplication('app-1')).rejects.toMatchObject({ code: 'INVALID_APPROVAL_STATUS', message: 'Application is already skipped' })
    await expect(skipAdjustmentApplication('nope')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' })
    expect(db.log).toEqual([])
  })

  it('given a transaction client it reads and writes only through it (payroll approval carries a left-out employee forward inside its transaction)', async () => {
    const tx = createMemoryDb()
    seed(totalBalance(1500), [app({ approvalStatus: 'APPROVED' })], tx)

    await skipAdjustmentApplication('app-1', tx as never)

    expect(adjRow(tx)).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
    expect(appRow('app-1', tx).approvalStatus).toBe('SKIPPED')
    expect(nextWeek(tx)).toHaveLength(1)
    expect(db.log).toEqual([]) // the default client was never used
    expect(db.rows('payrollAdjustment')).toEqual([])
  })
})

// ─── The helpers a correction shares ─────────────────────────────────────────

describe('applyApprovalToAdjustment', () => {
  it('takes the stored amount off, not the instalment (TOTAL_BALANCE 1000 left, 300 stored: 700 left)', async () => {
    seed(totalBalance(1000), [app({ approvalStatus: 'APPROVED', appliedAmount: 300 })])

    await applyApprovalToAdjustment(db as never, appRow() as never, adjRow() as never, 300)

    expect(adjRow()).toMatchObject({ remainingBalance: 700, status: 'ACTIVE' })
  })

  it('never goes below zero and completes at zero (200 left, 300 applied)', async () => {
    seed(totalBalance(200), [app({ approvalStatus: 'APPROVED' })])

    await applyApprovalToAdjustment(db as never, appRow() as never, adjRow() as never, 300)

    expect(adjRow()).toMatchObject({ remainingBalance: 0, status: 'COMPLETED' })
  })

  it('FIXED_WEEKS counts the approved applications including this one, so the application must be approved first', async () => {
    seed(fixedWeeks(500), [earlier('wk1', new Date('2025-06-26T00:00:00.000Z'), new Date('2025-07-02T00:00:00.000Z')), earlier('wk2', PREV_START, PREV_END), app({ approvalStatus: 'PENDING' })])

    await applyApprovalToAdjustment(db as never, appRow() as never, adjRow() as never, 500)
    expect(adjRow().status).toBe('ACTIVE') // only 2 approved: not done

    await db.payrollAdjustmentApplication.update({ where: { id: 'app-1' }, data: { approvalStatus: 'APPROVED' } })
    await applyApprovalToAdjustment(db as never, appRow() as never, adjRow() as never, 500)
    expect(adjRow()).toMatchObject({ status: 'COMPLETED', remainingBalance: 0 })
  })
})

describe('undoApprovalOnAdjustment', () => {
  it('gives the applied amount back and re-activates a completed adjustment, in one write', async () => {
    seed(totalBalance(0, { totalBalance: 1000, status: 'COMPLETED' }), [app({ approvalStatus: 'APPROVED' })])
    const update = vi.spyOn(db.payrollAdjustment, 'update')

    await undoApprovalOnAdjustment(db as never, appRow() as never, adjRow() as never)

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ where: { id: 'adj-1' }, data: { remainingBalance: 500, status: 'ACTIVE' } })
  })

  it('FIXED_WEEKS is handled like TOTAL_BALANCE (500 left + 500 applied = 1000)', async () => {
    seed(fixedWeeks(500), [app({ approvalStatus: 'APPROVED' })])

    await undoApprovalOnAdjustment(db as never, appRow() as never, adjRow() as never)

    expect(adjRow()).toMatchObject({ remainingBalance: 1000, status: 'ACTIVE' })
  })

  it('an adjustment with no balance and not completed (END_WEEK, ACTIVE) is not written at all', async () => {
    seed(adj({ recurrenceEndType: 'END_WEEK' }), [app({ approvalStatus: 'APPROVED' })])

    await undoApprovalOnAdjustment(db as never, appRow() as never, adjRow() as never)

    expect(db.log).toEqual([])
  })

  it('a completed ONE_TIME changes its status only (there is no balance to restore)', async () => {
    seed(adj({ recurrenceType: 'ONE_TIME', status: 'COMPLETED' }), [app({ approvalStatus: 'APPROVED' })])
    const update = vi.spyOn(db.payrollAdjustment, 'update')

    await undoApprovalOnAdjustment(db as never, appRow() as never, adjRow() as never)

    expect(update).toHaveBeenCalledWith({ where: { id: 'adj-1' }, data: { status: 'ACTIVE' } })
  })

  it('the restored balance is capped at the total', async () => {
    seed(totalBalance(1900), [app({ approvalStatus: 'APPROVED' })])

    await undoApprovalOnAdjustment(db as never, appRow() as never, adjRow() as never)

    expect(adjRow().remainingBalance).toBe(2000)
  })
})

describe('carryApplicationForward', () => {
  it('marks the application skipped, creates next week\'s PENDING and counts it; undoApproval also restores the balance', async () => {
    seed(totalBalance(1500), [app({ approvalStatus: 'APPROVED' })])

    await carryApplicationForward(db as never, appRow() as never, adjRow() as never, { undoApproval: true })

    expect(appRow()).toMatchObject({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START })
    expect(nextWeek()).toHaveLength(1)
    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
  })

  it('without undoApproval the balance is left alone', async () => {
    seed(totalBalance(2000), [app()])

    await carryApplicationForward(db as never, appRow() as never, adjRow() as never, { undoApproval: false })

    expect(adjRow()).toMatchObject({ remainingBalance: 2000, skippedCarryForwardCount: 1 })
  })

  it('does not duplicate a PENDING that already waits', async () => {
    seed(totalBalance(2000), [app(), next()])

    await carryApplicationForward(db as never, appRow() as never, adjRow() as never, { undoApproval: false })

    expect(nextWeek()).toHaveLength(1)
  })
})

describe('removeCarryForward', () => {
  it('deletes the PENDING application that waits at the carried-to week, and only that one', async () => {
    seed(totalBalance(2000), [
      app({ approvalStatus: 'SKIPPED', carriedForwardToPayrollWeekStartDate: NEXT_START }),
      next(),
      next({ id: 'app-next-approved', approvalStatus: 'APPROVED' }),
      next({ id: 'other-adjustment', payrollAdjustmentId: 'adj-2' }),
    ])

    await removeCarryForward(db as never, appRow() as never, adjRow() as never)

    expect(nextWeek().map((r) => r.id).sort()).toEqual(['app-next-approved', 'other-adjustment'])
  })

  it('does nothing when the application was never carried forward', async () => {
    seed(totalBalance(2000), [app(), next()])

    await removeCarryForward(db as never, appRow() as never, adjRow() as never)

    expect(db.log).toEqual([])
    expect(nextWeek()).toHaveLength(1)
  })
})
