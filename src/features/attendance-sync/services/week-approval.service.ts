import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { buildApprovalSummary, buildAttendanceRecords, canReopenWeek, getAttendanceWeekStatus } from '../lib/review'
import { toISODate, toUtcDate } from '../lib/week'
import {
  AttendanceSyncError,
  type ApprovalDecisionInput,
  type ApprovalSummary,
  type EmployeeDecisionValue,
  type PunchReview,
  type ReviewMode,
} from '../types/attendance-sync.types'
import { auditEntry } from './attendance-audit.service'
import { getPunchReview } from './punch-review.service'
import { requireApiWeek } from './week-list.service'
import { assertNotSyncing, lockWeekRow } from './week-lock.service'

const TRANSACTION_TIMEOUT_MS = 30000

async function loadDecisionInputs(
  uploadId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<ApprovalDecisionInput[]> {
  const rows = await db.attendanceEmployeeDecision.findMany({
    where: { attendanceUploadId: uploadId },
    select: {
      employeeId: true,
      decision: true,
      employee: { select: { employeeId: true, employeeName: true } },
    },
  })
  return rows.map((row) => ({
    employeeId: row.employeeId,
    employeeCode: row.employee.employeeId,
    employeeName: row.employee.employeeName,
    decision: row.decision as EmployeeDecisionValue,
  }))
}

/** For a correction: how many employee-days differ from the approved punches. */
async function countChangedDays(uploadId: string, correctionId: string): Promise<number> {
  const rows = await prisma.attendancePunch.findMany({
    where: { attendanceUploadId: uploadId, OR: [{ correctionId: null }, { correctionId }] },
    select: { correctionId: true, employeeId: true, punchDate: true, pairIndex: true, position: true, currentTime: true },
  })

  const daySignature = (set: string | null) => {
    const days = new Map<string, string[]>()
    for (const row of rows) {
      if (row.correctionId !== set || !row.employeeId || row.currentTime === null) continue
      const key = `${row.employeeId}|${toISODate(row.punchDate)}`
      days.set(key, [...(days.get(key) ?? []), `${row.pairIndex}${row.position}=${row.currentTime}`])
    }
    return new Map([...days].map(([key, slots]) => [key, slots.sort().join(',')]))
  }

  const live = daySignature(null)
  const clone = daySignature(correctionId)
  let changed = 0
  for (const key of new Set([...live.keys(), ...clone.keys()])) {
    if (live.get(key) !== clone.get(key)) changed++
  }
  return changed
}

/** The numbers shown before approving: employee count, hours, edited days, who is left out. */
export async function getApprovalSummary(weekId: string, mode: ReviewMode = { kind: 'LIVE' }): Promise<ApprovalSummary> {
  const review = await getPunchReview(weekId, mode)
  const { upload } = await requireApiWeek(weekId)
  const summary = buildApprovalSummary(review, await loadDecisionInputs(upload.id))

  if (mode.kind === 'CORRECTION') {
    summary.changedDaysInCorrection = await countChangedDays(upload.id, mode.correctionId)
  }
  return summary
}

function describeBlockers(review: PunchReview): string {
  const { counts, approval } = review
  const parts: string[] = []
  if (approval.blockers.includes('NEEDS_FIXING')) parts.push(`${counts.needsFixingDays} day(s) need fixing`)
  if (approval.blockers.includes('UNRESOLVED_CODES')) parts.push(`${counts.unresolvedCodes} code(s) to fix`)
  if (approval.blockers.includes('PENDING_DECISIONS')) parts.push(`${counts.pendingDecisions} decision(s) left`)
  return parts.join(', ')
}

/**
 * Approve the week: lock it and write one `AttendanceRecord` per payroll employee per day
 * from the review grid. No API call, no PayrollRevision.
 *
 * One transaction: it locks the week's row, then reads the grid and checks every blocker
 * from that same snapshot, so a punch edit, a decision or a pull cannot slip in between the
 * check and the write. Nothing is written if any check fails.
 */
export async function approveWeek(weekId: string): Promise<{ approvedAt: Date; summary: ApprovalSummary }> {
  const { upload, week } = await requireApiWeek(weekId)
  const approvedAt = new Date()

  return prisma.$transaction(
    async (tx) => {
      const locked = await lockWeekRow(tx, { id: upload.id })
      if (!locked || locked.status !== 'REVIEW') {
        throw new AttendanceSyncError('WEEK_NOT_IN_REVIEW', "This week isn't in review.")
      }
      assertNotSyncing(locked, approvedAt)

      const review = await getPunchReview(weekId, { kind: 'LIVE' }, tx)

      if (review.approval.blockers.includes('NOT_IN_REVIEW')) {
        throw new AttendanceSyncError('WEEK_NOT_IN_REVIEW', "This week isn't in review.")
      }
      const contentBlockers = review.approval.blockers.filter((b) => b !== 'WEEK_NOT_ENDED')
      if (contentBlockers.length > 0) {
        throw new AttendanceSyncError('WEEK_NOT_READY', `This week can't be approved yet: ${describeBlockers(review)}.`, {
          blockers: review.approval.blockers,
        })
      }
      if (review.approval.blockers.includes('WEEK_NOT_ENDED')) {
        throw new AttendanceSyncError('WEEK_NOT_ENDED', "This week hasn't ended yet.")
      }

      const decisions = await loadDecisionInputs(upload.id, tx)
      const summary = buildApprovalSummary(review, decisions)
      const records = buildAttendanceRecords(upload.id, review, decisions)

      // Only one caller can move the week out of review (guards a double approve). An approval is a
      // fresh start: a pull error from before it is no longer actionable.
      const moved = await tx.attendanceUpload.updateMany({
        where: { id: upload.id, status: 'REVIEW' },
        data: { status: 'APPROVED', approvedAt, lastSyncError: null },
      })
      if (moved.count === 0) throw new AttendanceSyncError('WEEK_NOT_IN_REVIEW', "This week isn't in review.")

      await tx.attendanceRecord.deleteMany({ where: { attendanceUploadId: upload.id } })
      if (records.length > 0) await tx.attendanceRecord.createMany({ data: records })

      await auditEntry(
        {
          actionType: 'APPROVE',
          entityType: 'ATTENDANCE_WEEK',
          entityId: upload.id,
          details: {
            summary: `Approved: ${summary.employeeCount} employees, ${summary.totalRegularHours.toFixed(2)} regular, ${summary.totalOvertimeHours.toFixed(2)} overtime`,
            weekStart: week.start,
            weekEnd: week.end,
            employeeCount: summary.employeeCount,
            totalRegularHours: summary.totalRegularHours,
            totalOvertimeHours: summary.totalOvertimeHours,
            editedDays: summary.editedDays,
            leftOut: summary.leftOut,
          },
        },
        tx,
      )

      return { approvedAt, summary }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

/**
 * Reopen an approved week before its payroll is approved. Removes the attendance records
 * and unlocks editing. No API call, no PayrollRevision.
 */
export async function reopenWeek(weekId: string): Promise<{ reopenedAt: Date }> {
  const { upload, week } = await requireApiWeek(weekId)

  const approvedRun = await prisma.payrollRun.findFirst({
    where: { payrollWeekStartDate: toUtcDate(week.start), status: { in: ['APPROVED', 'REVISED'] } },
    select: { id: true, status: true },
  })
  const payrollStatus = approvedRun ? (approvedRun.status === 'REVISED' ? 'REVISED' : 'APPROVED') : 'NOT_GENERATED'
  if (payrollStatus !== 'NOT_GENERATED') {
    throw new AttendanceSyncError(
      'PAYROLL_ALREADY_APPROVED',
      'Payroll for this week is approved. Use Correct on the payroll run to change attendance.',
    )
  }
  if (!canReopenWeek({ source: 'ETIMEOFFICE', status: getAttendanceWeekStatus(upload), payrollStatus })) {
    throw new AttendanceSyncError('WEEK_NOT_IN_REVIEW', "This week isn't approved, so there is nothing to reopen.")
  }

  const reopenedAt = new Date()
  await prisma.$transaction(
    async (tx) => {
      // The payroll run was checked above without a lock. Payroll approval takes the same row
      // lock, so once it is held this check sees any run that committed in the meantime.
      await lockWeekRow(tx, { id: upload.id })
      const racedRun = await tx.payrollRun.findFirst({
        where: { payrollWeekStartDate: toUtcDate(week.start), status: { in: ['APPROVED', 'REVISED'] } },
        select: { id: true },
      })
      if (racedRun) {
        throw new AttendanceSyncError(
          'PAYROLL_ALREADY_APPROVED',
          'Payroll for this week is approved. Use Correct on the payroll run to change attendance.',
        )
      }

      // A reopen is a fresh start too: a pull error from before it (a pull that lost the race to the
      // approval records WEEK_CHANGED on the then-approved row) would otherwise show as "Last pull failed".
      const moved = await tx.attendanceUpload.updateMany({
        where: { id: upload.id, status: 'APPROVED' },
        data: { status: 'REVIEW', approvedAt: null, lastSyncError: null },
      })
      if (moved.count === 0) {
        throw new AttendanceSyncError('WEEK_NOT_IN_REVIEW', "This week isn't approved, so there is nothing to reopen.")
      }

      await tx.attendanceRecord.deleteMany({ where: { attendanceUploadId: upload.id } })

      await auditEntry(
        {
          actionType: 'REOPEN',
          entityType: 'ATTENDANCE_WEEK',
          entityId: upload.id,
          details: { summary: 'Reopened for editing', weekStart: week.start, weekEnd: week.end },
        },
        tx,
      )
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )

  return { reopenedAt }
}
