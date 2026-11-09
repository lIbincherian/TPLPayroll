import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
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

// ─── approveAdjustmentApplication ────────────────────────────────────────────

export async function approveAdjustmentApplication(applicationId: string) {
  const app = await prisma.payrollAdjustmentApplication.findUnique({
    where: { id: applicationId },
    include: { payrollAdjustment: true },
  })

  if (!app) {
    throw new AdjustmentServiceError('APPLICATION_NOT_FOUND', `Application "${applicationId}" not found`)
  }
  if (app.approvalStatus !== 'PENDING' && app.approvalStatus !== 'SKIPPED') {
    throw new AdjustmentServiceError(
      'INVALID_APPROVAL_STATUS',
      `Application is already ${app.approvalStatus.toLowerCase()}`,
    )
  }

  const adj = app.payrollAdjustment
  const isTotalBalance = adj.recurrenceEndType === 'TOTAL_BALANCE'
  const isFixedWeeks = adj.recurrenceEndType === 'FIXED_WEEKS'
  const isEndWeek = adj.recurrenceEndType === 'END_WEEK'

  let appliedAmount = Number(adj.amount)
  let newRemainingBalance: number | null = null
  let adjustmentCompleted = false

  if (isTotalBalance && adj.remainingBalance != null) {
    // Cap the applied amount at whatever balance remains
    const remaining = Number(adj.remainingBalance)
    appliedAmount = Math.min(appliedAmount, remaining)
    newRemainingBalance = remaining - appliedAmount
    adjustmentCompleted = newRemainingBalance <= 0
  }

  if (isFixedWeeks && adj.remainingBalance != null) {
    // Deplete the running balance so we can track total paid out
    const remaining = Number(adj.remainingBalance)
    newRemainingBalance = Math.max(0, remaining - appliedAmount)
  }

  const now = new Date()

  // If we are approving a skipped application, delete its carry-forward application if it exists
  if (app.approvalStatus === 'SKIPPED' && app.carriedForwardToPayrollWeekStartDate) {
    await prisma.payrollAdjustmentApplication.deleteMany({
      where: {
        payrollAdjustmentId: adj.id,
        payrollWeekStartDate: app.carriedForwardToPayrollWeekStartDate,
        approvalStatus: 'PENDING',
      },
    })
  }

  // Mark current application as approved
  const updated = await prisma.payrollAdjustmentApplication.update({
    where: { id: applicationId },
    data: {
      approvalStatus: 'APPROVED',
      appliedAt: now,
      appliedAmount,
      carriedForwardToPayrollWeekStartDate: null,
    },
  })

  // ── TOTAL_BALANCE: update remaining balance and possibly complete ─────────
  if (isTotalBalance) {
    await prisma.payrollAdjustment.update({
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
    const approvedCount = await prisma.payrollAdjustmentApplication.count({
      where: {
        payrollAdjustmentId: adj.id,
        approvalStatus: 'APPROVED',
      },
    })

    if (approvedCount >= adj.totalRecurrenceWeeks) {
      // All weeks have been applied — mark the adjustment done
      await prisma.payrollAdjustment.update({
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
      const existingNextPending = await prisma.payrollAdjustmentApplication.findFirst({
        where: {
          payrollAdjustmentId: adj.id,
          payrollWeekStartDate: nextWeekStart,
          approvalStatus: 'PENDING',
        },
      })

      if (!existingNextPending) {
        await prisma.payrollAdjustmentApplication.create({
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
        await prisma.payrollAdjustment.update({
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
      await prisma.payrollAdjustment.update({
        where: { id: adj.id },
        data: { status: 'COMPLETED' },
      })
    } else {
      // Schedule the next instalment
      const nextWeekStart = addDays(app.payrollWeekStartDate, 7)
      const nextWeekEnd = addDays(app.payrollWeekEndDate, 7)

      // Guard: only create if no PENDING application already exists for this week
      const existingNextPending = await prisma.payrollAdjustmentApplication.findFirst({
        where: {
          payrollAdjustmentId: adj.id,
          payrollWeekStartDate: nextWeekStart,
          approvalStatus: 'PENDING',
        },
      })

      if (!existingNextPending) {
        await prisma.payrollAdjustmentApplication.create({
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
    await prisma.payrollAdjustment.update({
      where: { id: adj.id },
      data: { status: 'COMPLETED' },
    })
  }

  return {
    ...updated,
    appliedAmount: Number(updated.appliedAmount),
    approvalStatus: updated.approvalStatus as 'APPROVED',
    appliedAt: updated.appliedAt,
  }
}

// ─── skipAdjustmentApplication ───────────────────────────────────────────────

/**
 * Skip an application and carry it to the next payroll week. Pass a transaction client
 * as `db` to run the writes inside the caller's transaction (payroll approval does this
 * so a left-out employee's carry-forward commits or rolls back with the approval).
 */
export async function skipAdjustmentApplication(
  applicationId: string,
  db: Pick<Prisma.TransactionClient, 'payrollAdjustmentApplication' | 'payrollAdjustment'> = prisma,
) {
  const app = await db.payrollAdjustmentApplication.findUnique({
    where: { id: applicationId },
    include: { payrollAdjustment: true },
  })

  if (!app) {
    throw new AdjustmentServiceError('APPLICATION_NOT_FOUND', `Application "${applicationId}" not found`)
  }
  if (app.approvalStatus !== 'PENDING' && app.approvalStatus !== 'APPROVED') {
    throw new AdjustmentServiceError(
      'INVALID_APPROVAL_STATUS',
      `Application is already ${app.approvalStatus.toLowerCase()}`,
    )
  }

  const adj = app.payrollAdjustment
  const now = new Date()

  // ── Undo effects if skipping an already approved application ────────────
  let restoredRemainingBalance: number | null = null
  let revertStatusToActive = false

  if (app.approvalStatus === 'APPROVED') {
    const isTotalBalance = adj.recurrenceEndType === 'TOTAL_BALANCE'
    const isFixedWeeks = adj.recurrenceEndType === 'FIXED_WEEKS'
    const appliedAmount = Number(app.appliedAmount)

    if ((isTotalBalance || isFixedWeeks) && adj.remainingBalance !== null) {
      const currentRemaining = Number(adj.remainingBalance)
      restoredRemainingBalance = currentRemaining + appliedAmount

      // Cap the restored balance at the original total if known
      if (adj.totalBalance !== null) {
         restoredRemainingBalance = Math.min(restoredRemainingBalance, Number(adj.totalBalance))
      }
    }

    // If the adjustment was completed, revert it to ACTIVE since we are skipping an application
    // and thus creating a carry-forward (meaning it's not done yet).
    if (adj.status === 'COMPLETED') {
      revertStatusToActive = true
    }
  }

  const nextWeekStart = addDays(app.payrollWeekStartDate, 7)
  const nextWeekEnd = addDays(app.payrollWeekEndDate, 7)

  const updated = await db.payrollAdjustmentApplication.update({
    where: { id: applicationId },
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
      ...(restoredRemainingBalance !== null ? { remainingBalance: restoredRemainingBalance } : {}),
      ...(revertStatusToActive ? { status: 'ACTIVE' } : {}),
    },
  })

  return {
    ...updated,
    approvalStatus: updated.approvalStatus as 'SKIPPED',
    skippedAt: updated.skippedAt,
    appliedAmount: Number(updated.appliedAmount),
  }
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
