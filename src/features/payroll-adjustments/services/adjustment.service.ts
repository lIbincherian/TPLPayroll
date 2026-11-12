import { randomUUID } from 'crypto'
import type { PayrollAdjustment, Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { TRANSACTION_TIMEOUT_MS } from '@/features/attendance-sync/lib/constants'
import { lockAdjustmentRows } from '@/features/payroll-adjustments/services/adjustment-lock.service'
import {
  CreateAdjustmentSchema,
  UpdateAdjustmentSchema,
  AdjustmentServiceError,
  type CreateAdjustmentInput,
  type UpdateAdjustmentInput,
  type AdjustmentListOptions,
  type PaginatedAdjustmentList,
  type AdjustmentListItem,
  type AdjustmentDetailRecord,
  type AdjustmentApplicationRecord,
  type WeeklyReviewItem,
} from '@/features/payroll-adjustments/types/adjustment.types'

// ─── Helper: add 7 days ───────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// ─── Helper: build where clause ───────────────────────────────────────────────

function buildWhereClause(options: AdjustmentListOptions) {
  const where: Record<string, unknown> = {}

  if (options.status && options.status !== 'ALL') {
    where.status = options.status
  }
  if (options.type && options.type !== 'ALL') {
    where.adjustmentType = options.type
  }
  if (options.search?.trim()) {
    where.employee = {
      employeeName: { contains: options.search.trim(), mode: 'insensitive' },
    }
  }

  return where
}

// ─── createAdjustment ─────────────────────────────────────────────────────────

export async function createAdjustment(input: CreateAdjustmentInput) {
  const parsed = CreateAdjustmentSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues?.[0]
    throw new AdjustmentServiceError('VALIDATION_ERROR', first?.message ?? 'Invalid adjustment data')
  }

  const employee = await prisma.employee.findUnique({ where: { id: parsed.data.employeeId } })
  if (!employee) {
    throw new AdjustmentServiceError('EMPLOYEE_NOT_FOUND', 'Employee not found')
  }

  const d = parsed.data

  const isTotalBalance = d.recurrenceType === 'RECURRING' && d.recurrenceEndType === 'TOTAL_BALANCE'
  const isFixedWeeks = d.recurrenceType === 'RECURRING' && d.recurrenceEndType === 'FIXED_WEEKS'

  // For FIXED_WEEKS: the user enters the *total* amount to recover over N weeks.
  // We store the per-week instalment in `amount` and the grand total in `totalBalance`.
  const weeklyAmount: number =
    isFixedWeeks && d.totalRecurrenceWeeks && d.totalRecurrenceWeeks > 0
      ? Math.round((d.amount / d.totalRecurrenceWeeks) * 100) / 100
      : d.amount

  const storedTotalBalance: number | null = isFixedWeeks
    ? d.amount                            // original entered total
    : isTotalBalance
    ? (d.totalBalance ?? null)
    : null

  const storedRemainingBalance: number | null = isFixedWeeks
    ? d.amount                            // starts equal to total; depletes as weeks are approved
    : isTotalBalance
    ? (d.totalBalance ?? null)
    : null

  const adjustmentId = randomUUID()

  const [result] = await prisma.$transaction([
    prisma.payrollAdjustment.create({
      data: {
        id: adjustmentId,
        employeeId: d.employeeId,
        adjustmentType: d.adjustmentType,
        recurrenceType: d.recurrenceType,
        amount: weeklyAmount,             // per-week instalment stored here
        reason: d.reason,
        startPayrollWeekStartDate: d.startPayrollWeekStartDate,
        startPayrollWeekEndDate: d.startPayrollWeekEndDate,
        recurrenceEndType: d.recurrenceEndType ?? null,
        endPayrollWeekStartDate: d.endPayrollWeekStartDate ?? null,
        endPayrollWeekEndDate: d.endPayrollWeekEndDate ?? null,
        totalRecurrenceWeeks: d.totalRecurrenceWeeks ?? null,
        totalBalance: storedTotalBalance,
        remainingBalance: storedRemainingBalance,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    }),

    prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adjustmentId,
        employeeId: d.employeeId,
        payrollWeekStartDate: d.startPayrollWeekStartDate,
        payrollWeekEndDate: d.startPayrollWeekEndDate,
        appliedAmount: weeklyAmount,      // first week uses the computed per-week slice
        approvalStatus: 'PENDING',
      },
    }),
  ], { timeout: 30000 })

  return {
    ...result,
    amount: Number(result.amount),
    totalBalance: result.totalBalance != null ? Number(result.totalBalance) : null,
    remainingBalance: result.remainingBalance != null ? Number(result.remainingBalance) : null,
  }
}

// ─── getAdjustmentList ────────────────────────────────────────────────────────

export async function getAdjustmentList(options: AdjustmentListOptions): Promise<PaginatedAdjustmentList> {
  const page = options.page ?? 1
  const limit = options.limit ?? 10
  const skip = (page - 1) * limit
  const where = buildWhereClause(options)

  const [totalCount, rows] = await Promise.all([
    prisma.payrollAdjustment.count({ where }),
    prisma.payrollAdjustment.findMany({
      where,
      include: {
        employee: { select: { employeeName: true, employeeId: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ])

  const adjustments: AdjustmentListItem[] = rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee.employeeName,
    employeeCode: row.employee.employeeId,
    adjustmentType: row.adjustmentType as AdjustmentListItem['adjustmentType'],
    recurrenceType: row.recurrenceType as AdjustmentListItem['recurrenceType'],
    amount: Number(row.amount),
    reason: row.reason,
    status: row.status as AdjustmentListItem['status'],
    skippedCarryForwardCount: row.skippedCarryForwardCount,
    startPayrollWeekStartDate: row.startPayrollWeekStartDate,
    startPayrollWeekEndDate: row.startPayrollWeekEndDate,
    createdAt: row.createdAt,
  }))

  return { adjustments, totalCount, page, limit }
}

// ─── getAdjustmentDetail ──────────────────────────────────────────────────────

export async function getAdjustmentDetail(id: string): Promise<AdjustmentDetailRecord> {
  const adj = await prisma.payrollAdjustment.findUnique({
    where: { id },
    include: {
      employee: { select: { employeeName: true, employeeId: true } },
      adjustmentApplications: { orderBy: { payrollWeekStartDate: 'asc' } },
    },
  })

  if (!adj) {
    throw new AdjustmentServiceError('ADJUSTMENT_NOT_FOUND', `Adjustment "${id}" not found`)
  }

  const applications: AdjustmentApplicationRecord[] = adj.adjustmentApplications.map((a) => ({
    id: a.id,
    payrollAdjustmentId: a.payrollAdjustmentId,
    employeeId: a.employeeId,
    payrollWeekStartDate: a.payrollWeekStartDate,
    payrollWeekEndDate: a.payrollWeekEndDate,
    appliedAmount: Number(a.appliedAmount),
    approvalStatus: a.approvalStatus as AdjustmentApplicationRecord['approvalStatus'],
    approvedAt: a.approvedAt,
    appliedAt: a.appliedAt,
    skippedAt: a.skippedAt,
    carriedForwardToPayrollWeekStartDate: a.carriedForwardToPayrollWeekStartDate,
    isReversed: a.isReversed,
  }))

  return {
    id: adj.id,
    employeeId: adj.employeeId,
    employeeName: adj.employee.employeeName,
    employeeCode: adj.employee.employeeId,
    adjustmentType: adj.adjustmentType as AdjustmentDetailRecord['adjustmentType'],
    recurrenceType: adj.recurrenceType as AdjustmentDetailRecord['recurrenceType'],
    amount: Number(adj.amount),
    reason: adj.reason,
    status: adj.status as AdjustmentDetailRecord['status'],
    startPayrollWeekStartDate: adj.startPayrollWeekStartDate,
    startPayrollWeekEndDate: adj.startPayrollWeekEndDate,
    endPayrollWeekStartDate: adj.endPayrollWeekStartDate,
    endPayrollWeekEndDate: adj.endPayrollWeekEndDate,
    totalRecurrenceWeeks: adj.totalRecurrenceWeeks,
    totalBalance: adj.totalBalance != null ? Number(adj.totalBalance) : null,
    remainingBalance: adj.remainingBalance != null ? Number(adj.remainingBalance) : null,
    recurrenceEndType: adj.recurrenceEndType as AdjustmentDetailRecord['recurrenceEndType'],
    skippedCarryForwardCount: adj.skippedCarryForwardCount,
    createdAt: adj.createdAt,
    applications,
  }
}

// ─── Adjustment effects (shared by the weekly review and a correction's apply step) ───────────────

type AdjustmentDb = Pick<Prisma.TransactionClient, 'payrollAdjustmentApplication' | 'payrollAdjustment'>

/** An `AdjustmentDb` that can also take the adjustment row lock (a transaction client, or the default client). */
type LockableAdjustmentDb = AdjustmentDb & Pick<Prisma.TransactionClient, '$queryRaw'>

/** The amount an approval applies now: the instalment, capped at what is left of a TOTAL_BALANCE adjustment. */
export function amountToApply(adj: PayrollAdjustment): number {
  const amount = Number(adj.amount)
  if (adj.recurrenceEndType === 'TOTAL_BALANCE' && adj.remainingBalance != null) {
    return Math.min(amount, Number(adj.remainingBalance))
  }
  return amount
}

/**
 * What approving an application does to its adjustment: take `appliedAmount` off the balance, schedule
 * the next instalment, complete the adjustment when it is done. The application itself is marked
 * approved by the caller (and must be, before this runs: the FIXED_WEEKS count includes it).
 */
export async function applyApprovalToAdjustment(
  db: AdjustmentDb,
  app: { payrollWeekStartDate: Date; payrollWeekEndDate: Date; employeeId: string },
  adj: PayrollAdjustment,
  appliedAmount: number,
): Promise<void> {
  const isTotalBalance = adj.recurrenceEndType === 'TOTAL_BALANCE'
  const isFixedWeeks = adj.recurrenceEndType === 'FIXED_WEEKS'
  const isEndWeek = adj.recurrenceEndType === 'END_WEEK'

  let newRemainingBalance: number | null = null
  let adjustmentCompleted = false

  if (isTotalBalance && adj.remainingBalance != null) {
    newRemainingBalance = Math.max(0, Number(adj.remainingBalance) - appliedAmount)
    adjustmentCompleted = newRemainingBalance <= 0
  }

  if (isFixedWeeks && adj.remainingBalance != null) {
    // Deplete the running balance so we can track total paid out
    newRemainingBalance = Math.max(0, Number(adj.remainingBalance) - appliedAmount)
  }

  // ── TOTAL_BALANCE: update remaining balance and possibly complete ─────────
  if (isTotalBalance) {
    await db.payrollAdjustment.update({
      where: { id: adj.id },
      data: {
        remainingBalance: newRemainingBalance ?? 0,
        ...(adjustmentCompleted ? { status: 'COMPLETED' } : {}),
      },
    })
  }

  // ── FIXED_WEEKS: count approved applications; schedule next or complete ───
  if (isFixedWeeks && adj.totalRecurrenceWeeks != null) {
    // Count how many applications have been approved for this adjustment
    // (including the one we just approved)
    const approvedCount = await db.payrollAdjustmentApplication.count({
      where: {
        payrollAdjustmentId: adj.id,
        approvalStatus: 'APPROVED',
      },
    })

    if (approvedCount >= adj.totalRecurrenceWeeks) {
      // All weeks have been applied — mark the adjustment done
      await db.payrollAdjustment.update({
        where: { id: adj.id },
        data: {
          status: 'COMPLETED',
          remainingBalance: newRemainingBalance ?? 0,
        },
      })
    } else {
      // Schedule the next instalment for the following payroll week
      const nextWeekStart = addDays(app.payrollWeekStartDate, 7)
      const nextWeekEnd = addDays(app.payrollWeekEndDate, 7)

      // Guard: only create if no PENDING application already exists for this week
      const existingNextPending = await db.payrollAdjustmentApplication.findFirst({
        where: {
          payrollAdjustmentId: adj.id,
          payrollWeekStartDate: nextWeekStart,
          approvalStatus: 'PENDING',
        },
      })

      if (!existingNextPending) {
        await db.payrollAdjustmentApplication.create({
          data: {
            payrollAdjustmentId: adj.id,
            employeeId: app.employeeId,
            payrollWeekStartDate: nextWeekStart,
            payrollWeekEndDate: nextWeekEnd,
            appliedAmount: Number(adj.amount), // per-week instalment
            approvalStatus: 'PENDING',
          },
        })
      }

      if (newRemainingBalance !== null) {
        await db.payrollAdjustment.update({
          where: { id: adj.id },
          data: { remainingBalance: newRemainingBalance },
        })
      }
    }
  }

  // ── END_WEEK: schedule next week or complete when end week is reached ─────
  if (isEndWeek && adj.endPayrollWeekStartDate != null) {
    const currentWeekStart = app.payrollWeekStartDate
    const endWeekStart = adj.endPayrollWeekStartDate

    if (currentWeekStart >= endWeekStart) {
      // This was the last week — complete the adjustment
      await db.payrollAdjustment.update({
        where: { id: adj.id },
        data: { status: 'COMPLETED' },
      })
    } else {
      // Schedule the next instalment
      const nextWeekStart = addDays(app.payrollWeekStartDate, 7)
      const nextWeekEnd = addDays(app.payrollWeekEndDate, 7)

      // Guard: only create if no PENDING application already exists for this week
      const existingNextPending = await db.payrollAdjustmentApplication.findFirst({
        where: {
          payrollAdjustmentId: adj.id,
          payrollWeekStartDate: nextWeekStart,
          approvalStatus: 'PENDING',
        },
      })

      if (!existingNextPending) {
        await db.payrollAdjustmentApplication.create({
          data: {
            payrollAdjustmentId: adj.id,
            employeeId: app.employeeId,
            payrollWeekStartDate: nextWeekStart,
            payrollWeekEndDate: nextWeekEnd,
            appliedAmount: Number(adj.amount),
            approvalStatus: 'PENDING',
          },
        })
      }
    }
  }

  // ── ONE_TIME: complete the adjustment immediately ───────────────────────
  if (adj.recurrenceType === 'ONE_TIME') {
    await db.payrollAdjustment.update({
      where: { id: adj.id },
      data: { status: 'COMPLETED' },
    })
  }
}

/**
 * What an application's approval did to its adjustment, undone: the balance goes back (capped at the
 * total) and a completed adjustment is active again. Empty when the approval changed neither.
 */
function approvalUndoData(
  adj: PayrollAdjustment,
  appliedAmount: number,
): { remainingBalance?: number; status?: 'ACTIVE' } {
  const data: { remainingBalance?: number; status?: 'ACTIVE' } = {}
  const isTotalBalance = adj.recurrenceEndType === 'TOTAL_BALANCE'
  const isFixedWeeks = adj.recurrenceEndType === 'FIXED_WEEKS'

  if ((isTotalBalance || isFixedWeeks) && adj.remainingBalance !== null) {
    let restored = Number(adj.remainingBalance) + appliedAmount

    // Cap the restored balance at the original total if known
    if (adj.totalBalance !== null) {
      restored = Math.min(restored, Number(adj.totalBalance))
    }
    data.remainingBalance = restored
  }

  // If the adjustment was completed, revert it to ACTIVE: its instalment is not paid after all.
  if (adj.status === 'COMPLETED') data.status = 'ACTIVE'
  return data
}

/** Give back an application's approval to its adjustment without touching the application (see `approvalUndoData`). */
export async function undoApprovalOnAdjustment(
  db: AdjustmentDb,
  app: { appliedAmount: Prisma.Decimal | number },
  adj: PayrollAdjustment,
): Promise<void> {
  const data = approvalUndoData(adj, Number(app.appliedAmount))
  if (Object.keys(data).length === 0) return
  await db.payrollAdjustment.update({ where: { id: adj.id }, data })
}

/**
 * Mark an application skipped and carry it to the next payroll week: a PENDING application for that
 * week unless one exists, and the carry-forward count. `undoApproval` also gives back what the
 * application's approval did to the adjustment; pass it when that approval had been applied.
 */
export async function carryApplicationForward(
  db: AdjustmentDb,
  app: {
    id: string
    employeeId: string
    payrollWeekStartDate: Date
    payrollWeekEndDate: Date
    appliedAmount: Prisma.Decimal | number
  },
  adj: PayrollAdjustment,
  options: { undoApproval: boolean },
) {
  const now = new Date()
  const nextWeekStart = addDays(app.payrollWeekStartDate, 7)
  const nextWeekEnd = addDays(app.payrollWeekEndDate, 7)

  const updated = await db.payrollAdjustmentApplication.update({
    where: { id: app.id },
    data: {
      approvalStatus: 'SKIPPED',
      skippedAt: now,
      carriedForwardToPayrollWeekStartDate: nextWeekStart,
    },
  })

  // Guard: only create carry-forward if no PENDING application already exists for next week
  const existingNextPending = await db.payrollAdjustmentApplication.findFirst({
    where: {
      payrollAdjustmentId: adj.id,
      payrollWeekStartDate: nextWeekStart,
      approvalStatus: 'PENDING',
    },
  })

  if (!existingNextPending) {
    await db.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj.id,
        employeeId: app.employeeId,
        payrollWeekStartDate: nextWeekStart,
        payrollWeekEndDate: nextWeekEnd,
        appliedAmount: Number(adj.amount),
        approvalStatus: 'PENDING',
      },
    })
  }

  await db.payrollAdjustment.update({
    where: { id: adj.id },
    data: {
      skippedCarryForwardCount: adj.skippedCarryForwardCount + 1,
      ...(options.undoApproval ? approvalUndoData(adj, Number(app.appliedAmount)) : {}),
    },
  })

  return updated
}

/** Delete the PENDING application a skip carried to the next week; approving the skipped application takes it back. */
export async function removeCarryForward(
  db: AdjustmentDb,
  app: { carriedForwardToPayrollWeekStartDate: Date | null },
  adj: PayrollAdjustment,
): Promise<void> {
  if (!app.carriedForwardToPayrollWeekStartDate) return
  await db.payrollAdjustmentApplication.deleteMany({
    where: {
      payrollAdjustmentId: adj.id,
      payrollWeekStartDate: app.carriedForwardToPayrollWeekStartDate,
      approvalStatus: 'PENDING',
    },
  })
}

// ─── Guards: a week under correction is the correction's ─────────────────────

const CORRECTION_OPEN_MESSAGE = 'A payroll correction is open for this week. Finish or cancel it first.'

/**
 * While a correction is open for a week its applications are the correction's: it reset them to PENDING and
 * settles every balance once, when its revision is approved, from the status each ends with. A weekly approve,
 * skip, edit or cancel in the meantime would move the same balance for a row the correction settles again.
 * Throws CORRECTION_IN_PROGRESS when an IN_PROGRESS correction session exists for a run of this week.
 */
async function assertWeekNotUnderCorrection(weekStart: Date): Promise<void> {
  const open = await prisma.payrollCorrectionSession.findFirst({
    where: { status: 'IN_PROGRESS', payrollRun: { payrollWeekStartDate: weekStart } },
    select: { id: true },
  })
  if (open) throw new AdjustmentServiceError('CORRECTION_IN_PROGRESS', CORRECTION_OPEN_MESSAGE)
}

/** The same, for any week one of the adjustment's applications is in. */
async function assertAdjustmentNotUnderCorrection(adjustmentId: string): Promise<void> {
  const applications = await prisma.payrollAdjustmentApplication.findMany({
    where: { payrollAdjustmentId: adjustmentId },
    select: { payrollWeekStartDate: true },
  })
  if (applications.length === 0) return
  const open = await prisma.payrollCorrectionSession.findFirst({
    where: {
      status: 'IN_PROGRESS',
      payrollRun: { payrollWeekStartDate: { in: applications.map((application) => application.payrollWeekStartDate) } },
    },
    select: { id: true },
  })
  if (open) throw new AdjustmentServiceError('CORRECTION_IN_PROGRESS', CORRECTION_OPEN_MESSAGE)
}

// ─── approveAdjustmentApplication ────────────────────────────────────────────

/** The application with its adjustment, or the refusal the weekly approve and skip share. */
async function loadApplicationFor(db: AdjustmentDb, applicationId: string, allowed: readonly string[]) {
  const app = await db.payrollAdjustmentApplication.findUnique({
    where: { id: applicationId },
    include: { payrollAdjustment: true },
  })

  if (!app) {
    throw new AdjustmentServiceError('APPLICATION_NOT_FOUND', `Application "${applicationId}" not found`)
  }
  if (!allowed.includes(app.approvalStatus)) {
    throw new AdjustmentServiceError(
      'INVALID_APPROVAL_STATUS',
      `Application is already ${app.approvalStatus.toLowerCase()}`,
    )
  }
  return app
}

/**
 * Approve an application. The balance is read, changed and written back under the adjustment's row lock,
 * inside one transaction: the balance is shared by every week the adjustment has applications in, so a
 * read-modify-write outside a lock lets a concurrent approval or skip (of another week), or a correction's
 * settlement, be overwritten. The application is read again after the lock, so a second approval of the same
 * application finds it approved and is refused instead of deducting twice.
 */
export async function approveAdjustmentApplication(applicationId: string) {
  const found = await loadApplicationFor(prisma, applicationId, ['PENDING', 'SKIPPED'])
  await assertWeekNotUnderCorrection(found.payrollWeekStartDate)

  return prisma.$transaction(
    async (tx) => {
      await lockAdjustmentRows(tx, [found.payrollAdjustmentId])
      const app = await loadApplicationFor(tx, applicationId, ['PENDING', 'SKIPPED'])

      const adj = app.payrollAdjustment
      // Cap the applied amount at whatever balance remains
      const appliedAmount = amountToApply(adj)
      const now = new Date()

      // If we are approving a skipped application, delete its carry-forward application if it exists
      if (app.approvalStatus === 'SKIPPED') await removeCarryForward(tx, app, adj)

      // Mark current application as approved
      const updated = await tx.payrollAdjustmentApplication.update({
        where: { id: applicationId },
        data: {
          approvalStatus: 'APPROVED',
          appliedAt: now,
          appliedAmount,
          carriedForwardToPayrollWeekStartDate: null,
        },
      })

      await applyApprovalToAdjustment(tx, app, adj, appliedAmount)

      return {
        ...updated,
        appliedAmount: Number(updated.appliedAmount),
        approvalStatus: updated.approvalStatus as 'APPROVED',
        appliedAt: updated.appliedAt,
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

// ─── skipAdjustmentApplication ───────────────────────────────────────────────

/**
 * Skip an application and carry it to the next payroll week. Pass a transaction client
 * as `db` to run the writes inside the caller's transaction (payroll approval does this
 * so a left-out employee's carry-forward commits or rolls back with the approval).
 * Skipping an approved application undoes what its approval did to the adjustment.
 *
 * Like the approval it reads the balance under the adjustment's row lock: in its own transaction with the
 * default client, in the caller's with a transaction client (which already holds the week's row; the
 * adjustment rows come after it).
 */
export async function skipAdjustmentApplication(applicationId: string, db: LockableAdjustmentDb = prisma) {
  const found = await loadApplicationFor(db, applicationId, ['PENDING', 'APPROVED'])
  // approvePayroll passes its transaction, for a week that has no run yet and so cannot have a correction.
  if (db === prisma) await assertWeekNotUnderCorrection(found.payrollWeekStartDate)

  const skipUnderLock = async (client: LockableAdjustmentDb) => {
    await lockAdjustmentRows(client, [found.payrollAdjustmentId])
    const app = await loadApplicationFor(client, applicationId, ['PENDING', 'APPROVED'])

    const updated = await carryApplicationForward(client, app, app.payrollAdjustment, {
      undoApproval: app.approvalStatus === 'APPROVED',
    })

    return {
      ...updated,
      approvalStatus: updated.approvalStatus as 'SKIPPED',
      skippedAt: updated.skippedAt,
      appliedAmount: Number(updated.appliedAmount),
    }
  }

  if (db !== prisma) return skipUnderLock(db)
  return prisma.$transaction((tx) => skipUnderLock(tx), { timeout: TRANSACTION_TIMEOUT_MS })
}

// ─── getAdjustmentsForWeekReview (used by F06) ────────────────────────────────

export async function getAdjustmentsForWeekReview(
  weekStartDate: Date,
): Promise<WeeklyReviewItem[]> {
  const rows = await prisma.payrollAdjustmentApplication.findMany({
    where: {
      payrollWeekStartDate: weekStartDate,
      approvalStatus: 'PENDING',
    },
    include: {
      payrollAdjustment: true,
      employee: { select: { employeeName: true, employeeId: true } },
    },
  })

  // Defense-in-depth: deduplicate so only one PENDING per adjustment is shown
  const seen = new Set<string>()
  const deduped = rows.filter((row) => {
    if (seen.has(row.payrollAdjustmentId)) return false
    seen.add(row.payrollAdjustmentId)
    return true
  })

  return deduped.map((row) => {
    const adjAmount = Number(row.payrollAdjustment.amount)
    const remaining =
      row.payrollAdjustment.recurrenceEndType === 'TOTAL_BALANCE' &&
      row.payrollAdjustment.remainingBalance != null
        ? Number(row.payrollAdjustment.remainingBalance)
        : null
    const appliedAmount = remaining != null ? Math.min(adjAmount, remaining) : adjAmount

    return {
      applicationId: row.id,
      adjustmentId: row.payrollAdjustmentId,
      employeeId: row.employeeId,
      employeeName: row.employee.employeeName,
      employeeCode: row.employee.employeeId,
      adjustmentType: row.payrollAdjustment.adjustmentType as WeeklyReviewItem['adjustmentType'],
      amount: adjAmount,
      appliedAmount,
      reason: row.payrollAdjustment.reason,
      recurrenceType: row.payrollAdjustment.recurrenceType as WeeklyReviewItem['recurrenceType'],
      approvalStatus: row.approvalStatus as WeeklyReviewItem['approvalStatus'],
      payrollWeekStartDate: row.payrollWeekStartDate,
      payrollWeekEndDate: row.payrollWeekEndDate,
    }
  })
}

// ─── updateAdjustment ─────────────────────────────────────────────────────────

export async function updateAdjustment(id: string, input: UpdateAdjustmentInput) {
  const parsed = UpdateAdjustmentSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues?.[0]
    throw new AdjustmentServiceError('VALIDATION_ERROR', first?.message ?? 'Invalid adjustment data')
  }

  const adj = await prisma.payrollAdjustment.findUnique({
    where: { id },
    include: { adjustmentApplications: { select: { approvalStatus: true } } },
  })

  if (!adj) {
    throw new AdjustmentServiceError('ADJUSTMENT_NOT_FOUND', `Adjustment "${id}" not found`)
  }
  await assertAdjustmentNotUnderCorrection(id)

  const hasApproved = adj.adjustmentApplications.some((a) => a.approvalStatus === 'APPROVED')
  if (hasApproved) {
    throw new AdjustmentServiceError(
      'EDIT_NOT_ALLOWED',
      'Cannot edit an adjustment that has already been applied to payroll',
    )
  }

  const d = parsed.data
  const isTotalBalance = d.recurrenceType === 'RECURRING' && d.recurrenceEndType === 'TOTAL_BALANCE'
  const isFixedWeeks = d.recurrenceType === 'RECURRING' && d.recurrenceEndType === 'FIXED_WEEKS'

  // For FIXED_WEEKS: user enters total; compute per-week instalment
  const weeklyAmount: number =
    isFixedWeeks && d.totalRecurrenceWeeks && d.totalRecurrenceWeeks > 0
      ? Math.round((d.amount / d.totalRecurrenceWeeks) * 100) / 100
      : d.amount

  const storedTotalBalance: number | null = isFixedWeeks
    ? d.amount
    : isTotalBalance
    ? (d.totalBalance ?? null)
    : null

  // Sum up already approved amounts for this adjustment to prevent balance resets on edits
  const approvedTotal = await prisma.payrollAdjustmentApplication.aggregate({
    where: {
      payrollAdjustmentId: id,
      approvalStatus: 'APPROVED',
    },
    _sum: {
      appliedAmount: true,
    },
  })
  const approvedSum = Number(approvedTotal._sum.appliedAmount ?? 0)

  const storedRemainingBalance: number | null = isFixedWeeks
    ? Math.max(0, d.amount - approvedSum)
    : isTotalBalance
    ? Math.max(0, (d.totalBalance ?? 0) - approvedSum)
    : null

  const updated = await prisma.payrollAdjustment.update({
    where: { id },
    data: {
      adjustmentType: d.adjustmentType,
      amount: weeklyAmount,
      reason: d.reason,
      recurrenceType: d.recurrenceType,
      startPayrollWeekStartDate: d.startPayrollWeekStartDate,
      startPayrollWeekEndDate: d.startPayrollWeekEndDate,
      recurrenceEndType: d.recurrenceEndType ?? null,
      endPayrollWeekStartDate: d.endPayrollWeekStartDate ?? null,
      endPayrollWeekEndDate: d.endPayrollWeekEndDate ?? null,
      totalRecurrenceWeeks: d.totalRecurrenceWeeks ?? null,
      totalBalance: storedTotalBalance,
      remainingBalance: storedRemainingBalance,
    },
  })

  // Keep PENDING applications in sync with new per-week amount and start week
  await prisma.payrollAdjustmentApplication.updateMany({
    where: { payrollAdjustmentId: id, approvalStatus: 'PENDING' },
    data: {
      appliedAmount: weeklyAmount,
      payrollWeekStartDate: d.startPayrollWeekStartDate,
      payrollWeekEndDate: d.startPayrollWeekEndDate,
    },
  })

  return {
    ...updated,
    amount: Number(updated.amount),
    totalBalance: updated.totalBalance != null ? Number(updated.totalBalance) : null,
    remainingBalance: updated.remainingBalance != null ? Number(updated.remainingBalance) : null,
  }
}

// ─── cancelAdjustment ─────────────────────────────────────────────────────────

export async function cancelAdjustment(id: string) {
  const adj = await prisma.payrollAdjustment.findUnique({ where: { id } })

  if (!adj) {
    throw new AdjustmentServiceError('ADJUSTMENT_NOT_FOUND', `Adjustment "${id}" not found`)
  }
  await assertAdjustmentNotUnderCorrection(id)

  if (adj.status === 'COMPLETED' || adj.status === 'CANCELLED') {
    throw new AdjustmentServiceError(
      'CANCEL_NOT_ALLOWED',
      `Adjustment is already ${adj.status.toLowerCase()} and cannot be cancelled`,
    )
  }

  // Remove unprocessed applications only — approved ones stay for audit trail
  await prisma.payrollAdjustmentApplication.deleteMany({
    where: { payrollAdjustmentId: id, approvalStatus: 'PENDING' },
  })

  const cancelled = await prisma.payrollAdjustment.update({
    where: { id },
    data: { status: 'CANCELLED' },
  })

  return cancelled
}
