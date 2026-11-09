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

const TRANSACTION_TIMEOUT_MS = 30000

async function loadDecisionInputs(uploadId: string): Promise<ApprovalDecisionInput[]> {
  const rows = await prisma.attendanceEmployeeDecision.findMany({
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
 * from the review grid. Re-checks everything server-side. No API call, no PayrollRevision.
 */
export async function approveWeek(weekId: string): Promise<{ approvedAt: Date; summary: ApprovalSummary }> {
  const { upload, week } = await requireApiWeek(weekId)
  const review = await getPunchReview(weekId)

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

  const decisions = await loadDecisionInputs(upload.id)
  const summary = buildApprovalSummary(review, decisions)
  const records = buildAttendanceRecords(upload.id, review, decisions)
  const approvedAt = new Date()

  await prisma.$transaction(
    async (tx) => {
      // Only one caller can move the week out of review (guards a double approve).
      const moved = await tx.attendanceUpload.updateMany({
        where: { id: upload.id, status: 'REVIEW' },
        data: { status: 'APPROVED', approvedAt },
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
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )

  return { approvedAt, summary }
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
      const moved = await tx.attendanceUpload.updateMany({
        where: { id: upload.id, status: 'APPROVED' },
        data: { status: 'REVIEW', approvedAt: null },
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
