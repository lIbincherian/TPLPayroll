import { describe, expect, it, vi } from 'vitest'

// The only thing that moves an adjustment application's status inside a correction is the approve and skip click,
// and the only thing that moves a balance is approving the revision. The reverse and approve-skipped paths (which
// set a flag or a status with no balance move, no lock and no draft invalidation) and the `adjustmentChanges` input
// of the recalculation are gone; this pins that they stay gone.

vi.mock('@/lib/prisma', () => ({ default: {} }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))

describe('removed paths', () => {
  it('the correction service no longer exports reverseAdjustmentApplication or approveSkippedAdjustment, and nothing that settles by itself', async () => {
    const service = await import('@/features/payroll-correction/services/correction.service')

    expect(Object.keys(service)).not.toContain('reverseAdjustmentApplication')
    expect(Object.keys(service)).not.toContain('approveSkippedAdjustment')
    expect(Object.keys(service)).not.toContain('settleAdjustmentBalances')
    // what is left is what the UI calls
    expect(Object.keys(service)).toEqual(expect.arrayContaining(['approveAdjustmentInCorrection', 'skipAdjustmentInCorrection', 'recalculateAndCreateRevision', 'approveRevision', 'abandonCorrection']))
  })

  it('the server actions no longer expose them either', async () => {
    const actions = await import('@/features/payroll-correction/actions/correction.actions')

    expect(Object.keys(actions)).not.toContain('reverseAdjustmentAction')
    expect(Object.keys(actions)).not.toContain('approveSkippedAdjustmentAction')
    expect(Object.keys(actions)).toEqual(expect.arrayContaining(['approveAdjustmentInCorrectionAction', 'skipAdjustmentInCorrectionAction', 'recalculateAndCreateRevisionAction']))
  })

  it('the settlement module exports exactly the plan, the freeze, the check and the writer, and the snapshot parser', async () => {
    const settlement = await import('@/features/payroll-correction/services/adjustment-settlement')

    expect(Object.keys(settlement).sort()).toEqual(
      ['applySettlement', 'draftMatchesPlan', 'freezeDraftAdjustmentAmounts', 'loadSettlementInput', 'parseAdjustmentSnapshot', 'planProblemMessage', 'planSettlement', 'settlementScope'].sort(),
    )
  })

  it('the lock service exports only lockAdjustmentRows', async () => {
    const lock = await import('@/features/payroll-adjustments/services/adjustment-lock.service')

    expect(Object.keys(lock)).toEqual(['lockAdjustmentRows'])
  })

  it('an empty list of ids is a no-op (no query is sent)', async () => {
    const { lockAdjustmentRows } = await import('@/features/payroll-adjustments/services/adjustment-lock.service')
    const tx = { $queryRaw: vi.fn() }

    await lockAdjustmentRows(tx as never, [])

    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('the ids are locked in one statement, ordered by id, with each id once', async () => {
    const { lockAdjustmentRows } = await import('@/features/payroll-adjustments/services/adjustment-lock.service')
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) }

    await lockAdjustmentRows(tx as never, ['adj-b', 'adj-a', 'adj-b'])

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sql = strings.join('?')
    expect(sql).toContain('FROM "PayrollAdjustment"')
    expect(sql).toMatch(/ORDER BY id FOR UPDATE/)
    expect(JSON.stringify(values)).toContain('adj-b')
    expect(JSON.stringify(values)).toContain('adj-a')
    // each id appears once among the bound values
    expect(JSON.stringify(values).match(/adj-b/g)).toHaveLength(1)
  })
})
