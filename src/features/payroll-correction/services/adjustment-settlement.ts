import type { Prisma } from '@prisma/client'
import {
  applyApprovalToAdjustment,
  carryApplicationForward,
  removeCarryForward,
  undoApprovalOnAdjustment,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'

// How a correction settles the week's adjustment applications against their adjustments' balances.
//
// A correction resets the week's applications to PENDING and lets the user approve or skip them again. What
// the revision finally deducts is the draft's employee rows; what the balances must show is "the amounts the
// revisions deduct". `planSettlement` works both out from the same inputs, once, so that the draft (made by the
// recalculation) and the settlement (made by approveRevision) cannot disagree: approveRevision recomputes the
// plan under the locks and refuses a draft whose rows or frozen amounts differ from it.
//
// Per application: `wasApplied` (the balance absorbed it before this correction, from the session's snapshot),
// `final` (what it ends as: its status for an employee the draft pays, SKIPPED for one it leaves out), and from
// the two the cell of the table below, with the amount the draft deducts (N) and the amount the balance had
// already absorbed (O).
//
//   cell            before \ after                                  balance          application / carry-forward
//   KEEP            applied, APPROVED paid                          none (N = O)     unchanged
//   APPLY           not applied, APPROVED paid                      R - N            amount = N; a carry-forward is taken back
//   UNAPPLY_CARRY   applied, SKIPPED or left out, not carried       R + O (cap)      SKIPPED, carried to the next week, counted
//   UNAPPLY_SKIP    applied, SKIPPED, already carried               R + O (cap)      SKIPPED, nothing carried
//   UNAPPLY_PENDING applied, PENDING paid                           R + O (cap)      stays PENDING
//   CARRY           not applied, SKIPPED or left out, not carried   none             SKIPPED, carried, counted
//   SKIP_ONLY       not applied, SKIPPED, already carried (or it    none             SKIPPED, nothing carried
//                   was SKIPPED before this correction), or the
//                   adjustment is not active
//   NONE            not applied, PENDING paid                       none             unchanged
//   INERT           adjustment cancelled, or a reversed approved    none             unchanged
//                   row with no snapshot

/** What an adjustment application looked like before the correction reset it. */
export interface AdjustmentSnapshotEntry {
  applicationId: string
  approvalStatus: string
  isReversed: boolean
  approvedAt: string | null
  skippedAt: string | null
  appliedAt: string | null
  /** What the application was applied at; absent in sessions opened before this was recorded. */
  appliedAmount?: number
  /** Where the application was carried to; absent in sessions opened before this was recorded. */
  carriedForwardToPayrollWeekStartDate?: string | null
}

export function parseAdjustmentSnapshot(value: unknown): AdjustmentSnapshotEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is AdjustmentSnapshotEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as AdjustmentSnapshotEntry).applicationId === 'string',
  )
}

export type SettlementApplication = Prisma.PayrollAdjustmentApplicationGetPayload<{
  include: { payrollAdjustment: true }
}>

export type SettlementCell =
  | 'KEEP'
  | 'APPLY'
  | 'UNAPPLY_CARRY'
  | 'UNAPPLY_SKIP'
  | 'UNAPPLY_PENDING'
  | 'CARRY'
  | 'SKIP_ONLY'
  | 'NONE'
  | 'INERT'

export interface ApplicationPlan {
  applicationId: string
  adjustmentId: string
  employeeId: string
  adjustmentType: 'ADDITION' | 'DEDUCTION'
  cell: SettlementCell
  /** O: what the balance had absorbed before this correction. */
  originalAmount: number
  /** N: what the draft deducts (or adds) for this application. */
  newAmount: number
}

export interface PlanProblem {
  applicationId: string
  employeeId: string
  reason: 'ADJUSTMENT_NOT_ACTIVE' | 'NOTHING_LEFT' | 'CARRIED_FORWARD_HANDLED'
}

const round2 = (value: number): number => Math.round(value * 100) / 100
const toPaise = (value: number): number => Math.round(value * 100)

/** Same arithmetic as the adjustment service's carry-forward, so "the week after" means the same week in both. */
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

type Final = 'PENDING' | 'APPROVED' | 'SKIPPED'

interface Context {
  app: SettlementApplication
  wasApplied: boolean
  original: number
  final: Final
  carried: boolean
  /** It was SKIPPED before this correction (by the weekly review or an earlier correction), which carried it. */
  skippedBefore: boolean
}

interface Running {
  /** Null when the adjustment tracks no balance. */
  remaining: number | null
  status: string
}

/** TOTAL_BALANCE and FIXED_WEEKS adjustments carry a running balance (when it is set). */
function tracksBalance(adj: SettlementApplication['payrollAdjustment']): boolean {
  return (adj.recurrenceEndType === 'TOTAL_BALANCE' || adj.recurrenceEndType === 'FIXED_WEEKS') && adj.remainingBalance !== null
}

/** The step of the algorithm an application belongs to (1 to 6; see `planSettlement`). */
function stepOf(ctx: Context, hasSnapshot: boolean): 1 | 2 | 3 | 4 | 5 | 6 {
  const { app } = ctx
  if (app.payrollAdjustment.status === 'CANCELLED') return 1
  if (!hasSnapshot && app.approvalStatus === 'APPROVED' && app.isReversed) return 1
  if (ctx.wasApplied) return ctx.final === 'APPROVED' ? 3 : 2
  if (ctx.final === 'APPROVED') return 4
  return ctx.final === 'SKIPPED' ? 5 : 6
}

/**
 * Pure. No I/O. The plan for every application of the week, and the applications that cannot be settled.
 *
 * Applications are grouped by adjustment (in adjustment id order) and each adjustment keeps a running
 * `{ remaining, status }` that starts at the row's values. Its applications go through these steps in this
 * order (by id inside each step), so a give-back feeds the cap of an approval of the same adjustment:
 *
 *   1. INERT: the adjustment is CANCELLED, or there is no snapshot and the row is APPROVED and reversed.
 *   2. applied before, not APPROVED now: the balance goes back (capped at the total).
 *   3. applied before, APPROVED now: KEEP, N = O.
 *   4. not applied before, APPROVED now: APPLY, capped at what is left; a problem when it cannot be.
 *   5. not applied before, SKIPPED now: CARRY, or SKIP_ONLY when already carried, skipped before this correction,
 *      or the adjustment is not active.
 *   6. not applied before, PENDING now: NONE.
 *
 * A plan with a problem is still returned, with N = 0. The returned plans keep this order.
 */
export function planSettlement(input: {
  applications: SettlementApplication[]
  snapshot: AdjustmentSnapshotEntry[] | null
  paidEmployeeIds: ReadonlySet<string>
  /** Adjustment ids that have a PENDING application in the week after this one. */
  adjustmentsWithNextWeekPending: ReadonlySet<string>
}): { plans: ApplicationPlan[]; problems: PlanProblem[] } {
  const { applications, snapshot, paidEmployeeIds, adjustmentsWithNextWeekPending } = input
  const entries = new Map((snapshot ?? []).map((entry) => [entry.applicationId, entry]))

  const byAdjustment = new Map<string, Context[]>()
  for (const app of applications) {
    const entry = entries.get(app.id)
    const wasApplied = snapshot ? entry?.approvalStatus === 'APPROVED' : app.approvalStatus === 'APPROVED'
    const context: Context = {
      app,
      wasApplied,
      original: wasApplied ? (entry?.appliedAmount ?? Number(app.appliedAmount)) : 0,
      final: (paidEmployeeIds.has(app.employeeId) ? app.approvalStatus : 'SKIPPED') as Final,
      carried: app.carriedForwardToPayrollWeekStartDate !== null,
      skippedBefore: snapshot ? entry?.approvalStatus === 'SKIPPED' : app.approvalStatus === 'SKIPPED',
    }
    const group = byAdjustment.get(app.payrollAdjustmentId)
    if (group) group.push(context)
    else byAdjustment.set(app.payrollAdjustmentId, [context])
  }

  const plans: ApplicationPlan[] = []
  const problems: PlanProblem[] = []

  for (const adjustmentId of [...byAdjustment.keys()].sort()) {
    const contexts = byAdjustment.get(adjustmentId)!
    const adj = contexts[0].app.payrollAdjustment
    const running: Running = {
      remaining: tracksBalance(adj) ? Number(adj.remainingBalance) : null,
      status: adj.status,
    }
    const total = adj.totalBalance === null ? Infinity : Number(adj.totalBalance)
    const amount = Number(adj.amount)

    const steps = new Map<number, Context[]>()
    for (const context of contexts) {
      const step = stepOf(context, snapshot !== null)
      steps.set(step, [...(steps.get(step) ?? []), context])
    }

    for (let step = 1; step <= 6; step++) {
      const inStep = (steps.get(step) ?? []).sort((a, b) => (a.app.id < b.app.id ? -1 : a.app.id > b.app.id ? 1 : 0))
      for (const context of inStep) {
        const { app } = context
        const plan: ApplicationPlan = {
          applicationId: app.id,
          adjustmentId,
          employeeId: app.employeeId,
          adjustmentType: adj.adjustmentType === 'ADDITION' ? 'ADDITION' : 'DEDUCTION',
          cell: 'NONE',
          originalAmount: context.original,
          newAmount: 0,
        }
        const problem = (reason: PlanProblem['reason']) => problems.push({ applicationId: app.id, employeeId: app.employeeId, reason })

        if (step === 1) {
          plan.cell = 'INERT'
          const cancelled = adj.status === 'CANCELLED'
          if (cancelled && context.final === 'APPROVED') {
            // An applied row that is approved again deducts what it did (today's behaviour for a cancelled adjustment).
            if (context.wasApplied) plan.newAmount = context.original
            else problem('ADJUSTMENT_NOT_ACTIVE')
          }
        } else if (step === 2) {
          if (running.remaining !== null) running.remaining = round2(Math.min(total, running.remaining + context.original))
          if (running.status === 'COMPLETED') running.status = 'ACTIVE'
          plan.cell = context.final === 'SKIPPED' ? (context.carried ? 'UNAPPLY_SKIP' : 'UNAPPLY_CARRY') : 'UNAPPLY_PENDING'
        } else if (step === 3) {
          plan.cell = 'KEEP'
          plan.newAmount = context.original
        } else if (step === 4) {
          plan.cell = 'APPLY'
          if (running.status !== 'ACTIVE') {
            problem('ADJUSTMENT_NOT_ACTIVE')
          } else if (adj.recurrenceType === 'ONE_TIME' && context.carried && !adjustmentsWithNextWeekPending.has(adjustmentId)) {
            problem('CARRIED_FORWARD_HANDLED')
          } else if (running.remaining !== null) {
            const capped = round2(Math.min(amount, running.remaining))
            if (capped <= 0) {
              problem('NOTHING_LEFT')
            } else {
              plan.newAmount = capped
              running.remaining = round2(running.remaining - capped)
              if (adj.recurrenceEndType === 'TOTAL_BALANCE' && running.remaining <= 0) running.status = 'COMPLETED'
            }
          } else {
            plan.newAmount = amount
            if (adj.recurrenceType === 'ONE_TIME') running.status = 'COMPLETED'
          }
        } else if (step === 5) {
          // Carried at most once: by the field, or because it was already SKIPPED before this correction (whatever
          // recorded that, such a row was carried then).
          plan.cell = context.carried || context.skippedBefore || running.status !== 'ACTIVE' ? 'SKIP_ONLY' : 'CARRY'
        } else {
          plan.cell = 'NONE'
        }
        plans.push(plan)
      }
    }
  }

  return { plans, problems }
}

/** What each employee's draft row must carry, in whole paise: the plan's N summed by adjustment type. */
function sumsInPaise(plans: ApplicationPlan[]): Map<string, { additions: number; deductions: number }> {
  const sums = new Map<string, { additions: number; deductions: number }>()
  for (const plan of plans) {
    if (plan.newAmount <= 0) continue
    const sum = sums.get(plan.employeeId) ?? { additions: 0, deductions: 0 }
    if (plan.adjustmentType === 'ADDITION') sum.additions += toPaise(plan.newAmount)
    else sum.deductions += toPaise(plan.newAmount)
    sums.set(plan.employeeId, sum)
  }
  return sums
}

/**
 * Pure. False when the plan has a problem, an APPLY plan's stored `appliedAmount` differs from its N, or any
 * draft row's additions or deductions differ from the plan's sums for that employee. Amounts are compared in
 * whole paise: Math.round(x * 100).
 */
export function draftMatchesPlan(
  plans: ApplicationPlan[],
  problems: PlanProblem[],
  applications: SettlementApplication[],
  draftRows: Array<{ employeeId: string; additions: Prisma.Decimal | number; deductions: Prisma.Decimal | number }>,
): boolean {
  if (problems.length > 0) return false

  const stored = new Map(applications.map((app) => [app.id, toPaise(Number(app.appliedAmount))]))
  for (const plan of plans) {
    if (plan.cell === 'APPLY' && stored.get(plan.applicationId) !== toPaise(plan.newAmount)) return false
  }
  const sums = sumsInPaise(plans)

  const inDraft = new Set<string>()
  for (const row of draftRows) {
    inDraft.add(row.employeeId)
    const sum = sums.get(row.employeeId) ?? { additions: 0, deductions: 0 }
    if (toPaise(Number(row.additions)) !== sum.additions || toPaise(Number(row.deductions)) !== sum.deductions) return false
  }
  // Something is deducted for an employee the draft does not pay.
  for (const employeeId of sums.keys()) if (!inDraft.has(employeeId)) return false
  return true
}

/** The applications a correction of this run settles: the run's week, on the run or not yet linked to any. */
export function settlementScope(run: { id: string; payrollWeekStartDate: Date }): Prisma.PayrollAdjustmentApplicationWhereInput {
  return {
    payrollWeekStartDate: run.payrollWeekStartDate,
    OR: [{ payrollRunId: run.id }, { payrollRunId: null }],
  }
}

/**
 * The applications of `settlementScope` with their adjustments, and the adjustments that have a PENDING
 * application in the week after, which is where a skip carried them to: two queries.
 */
export async function loadSettlementInput(
  tx: Prisma.TransactionClient,
  run: { id: string; payrollWeekStartDate: Date },
): Promise<{ applications: SettlementApplication[]; adjustmentsWithNextWeekPending: Set<string> }> {
  const applications = await tx.payrollAdjustmentApplication.findMany({
    where: settlementScope(run),
    include: { payrollAdjustment: true },
  })
  const waiting = await tx.payrollAdjustmentApplication.findMany({
    where: {
      payrollAdjustmentId: { in: [...new Set(applications.map((app) => app.payrollAdjustmentId))] },
      payrollWeekStartDate: addDays(run.payrollWeekStartDate, 7),
      approvalStatus: 'PENDING',
    },
    select: { payrollAdjustmentId: true },
  })
  return { applications, adjustmentsWithNextWeekPending: new Set(waiting.map((row) => row.payrollAdjustmentId)) }
}

const NOT_APPLICABLE_MESSAGES: Record<PlanProblem['reason'], string> = {
  ADJUSTMENT_NOT_ACTIVE: 'This adjustment is already completed or cancelled.',
  NOTHING_LEFT: 'Nothing is left to deduct for this adjustment.',
  CARRIED_FORWARD_HANDLED: 'This adjustment was carried to the next week and has been dealt with there.',
}

/** The user-facing message for a problem the plan found (the click's refusal and the recalculation's). */
export function planProblemMessage(reason: PlanProblem['reason']): string {
  return NOT_APPLICABLE_MESSAGES[reason]
}

/**
 * Called by the recalculation, inside its transaction and under the week lock. Plans the week's settlement
 * for the employees the draft pays and freezes what the draft deducts: writes `appliedAmount` = N for every
 * APPLY plan whose stored amount differs, so the amount is part of the application and not recomputed later.
 * Throws ADJUSTMENT_NOT_APPLICABLE when an approved application cannot be applied (nothing left, adjustment
 * completed or cancelled, a ONE_TIME carried forward and handled there). Returns the per-employee sums the
 * draft rows must carry.
 */
export async function freezeDraftAdjustmentAmounts(
  tx: Prisma.TransactionClient,
  run: { id: string; payrollWeekStartDate: Date },
  snapshot: AdjustmentSnapshotEntry[] | null,
  paidEmployeeIds: ReadonlySet<string>,
): Promise<Map<string, { additions: number; deductions: number }>> {
  const { applications, adjustmentsWithNextWeekPending } = await loadSettlementInput(tx, run)
  const { plans, problems } = planSettlement({ applications, snapshot, paidEmployeeIds, adjustmentsWithNextWeekPending })
  if (problems.length > 0) {
    throw new CorrectionServiceError('ADJUSTMENT_NOT_APPLICABLE', planProblemMessage(problems[0].reason))
  }

  const byId = new Map(applications.map((app) => [app.id, app]))
  for (const plan of plans) {
    if (plan.cell !== 'APPLY') continue
    if (toPaise(Number(byId.get(plan.applicationId)!.appliedAmount)) === toPaise(plan.newAmount)) continue
    await tx.payrollAdjustmentApplication.update({
      where: { id: plan.applicationId },
      data: { appliedAmount: plan.newAmount },
    })
  }
  return new Map(
    [...sumsInPaise(plans)].map(([employeeId, sum]) => [employeeId, { additions: sum.additions / 100, deductions: sum.deductions / 100 }]),
  )
}

/**
 * Writes the effects of the table above. Runs in approveRevision's transaction, under the week lock and the
 * adjustment row locks, with the plan that was just checked against the draft.
 *
 * Plans go in plan order, so the give-backs of an adjustment come before its applications. An adjustment that
 * an earlier plan wrote is read again before the next plan uses it (the effect helpers take the balance from
 * the row they are given); one that was not is the row loaded with the applications, so unchanged applications
 * cost no query.
 */
export async function applySettlement(
  tx: Prisma.TransactionClient,
  plans: ApplicationPlan[],
  applications: SettlementApplication[],
  snapshot: AdjustmentSnapshotEntry[] | null,
): Promise<void> {
  const byId = new Map(applications.map((app) => [app.id, app]))
  const entries = new Map((snapshot ?? []).map((entry) => [entry.applicationId, entry]))
  const written = new Set<string>()

  for (const plan of plans) {
    if (plan.cell === 'KEEP' || plan.cell === 'NONE' || plan.cell === 'INERT') continue
    const app = byId.get(plan.applicationId)!

    if (plan.cell === 'SKIP_ONLY') {
      // Already carried (or the adjustment is not active): the status is all there is to put right.
      if (app.approvalStatus !== 'SKIPPED') {
        const skippedAt = entries.get(app.id)?.skippedAt
        await tx.payrollAdjustmentApplication.update({
          where: { id: app.id },
          data: { approvalStatus: 'SKIPPED', skippedAt: skippedAt ? new Date(skippedAt) : new Date() },
        })
      }
      continue
    }

    const adj = written.has(plan.adjustmentId)
      ? await tx.payrollAdjustment.findUniqueOrThrow({ where: { id: plan.adjustmentId } })
      : app.payrollAdjustment

    switch (plan.cell) {
      case 'APPLY':
        // A carry-forward made when it was skipped before this correction is taken back; the application is applied now.
        if (app.carriedForwardToPayrollWeekStartDate) {
          await removeCarryForward(tx, app, adj)
          await tx.payrollAdjustmentApplication.update({
            where: { id: app.id },
            data: { carriedForwardToPayrollWeekStartDate: null },
          })
        }
        await applyApprovalToAdjustment(tx, app, adj, plan.newAmount)
        break
      case 'UNAPPLY_CARRY':
        await carryApplicationForward(tx, { ...app, appliedAmount: plan.originalAmount }, adj, { undoApproval: true })
        break
      case 'UNAPPLY_SKIP':
        // Applied before, skipped now, and it was carried before it was applied: no second carry-forward.
        await tx.payrollAdjustmentApplication.update({
          where: { id: app.id },
          data: { approvalStatus: 'SKIPPED', skippedAt: new Date() },
        })
        await undoApprovalOnAdjustment(tx, { appliedAmount: plan.originalAmount }, adj)
        break
      case 'UNAPPLY_PENDING':
        await undoApprovalOnAdjustment(tx, { appliedAmount: plan.originalAmount }, adj)
        break
      case 'CARRY':
        await carryApplicationForward(tx, app, adj, { undoApproval: false })
        break
    }
    written.add(plan.adjustmentId)
  }
}
