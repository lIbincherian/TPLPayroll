import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import {
  computeStatusChanges,
  summarizeStatusChanges,
  type EmployeeStatusChange,
  type StatusEmployee,
} from '../lib/employee-status'
import { plural } from '../lib/format'
import { formatWeekLabel, toUtcDate } from '../lib/week'
import type { ISODate, PunchMatchStatus, StatusChangeSummary, WeekRange } from '../types/attendance-sync.types'

type ApprovalStatusInput = { uploadId: string; week: WeekRange; today: ISODate; rejectedIds: ReadonlySet<string> }

/**
 * The status changes approving this week would make, read through `db`. Older weeks never change
 * status: nothing changes when a later eTimeOffice week is already approved.
 */
async function readStatusChanges(
  db: Prisma.TransactionClient,
  { uploadId, week, today, rejectedIds }: ApprovalStatusInput,
): Promise<EmployeeStatusChange[]> {
  const laterWeeks = await db.attendanceUpload.count({
    where: { source: 'ETIMEOFFICE', payrollWeekStartDate: { gt: toUtcDate(week.start) }, status: 'APPROVED' },
  })
  const employees: StatusEmployee[] = await db.employee.findMany({
    select: {
      id: true,
      employeeId: true,
      employeeName: true,
      isActive: true,
      dateOfJoining: true,
      dateOfResignation: true,
    },
  })
  const rows = await db.attendancePunch.findMany({
    where: { attendanceUploadId: uploadId, correctionId: null },
    select: {
      employeeId: true,
      empCode: true,
      matchStatus: true,
      punchDate: true,
      pairIndex: true,
      position: true,
      currentTime: true,
    },
  })

  return computeStatusChanges({
    week,
    today,
    employees,
    rows: rows.map((r) => ({
      ...r,
      matchStatus: r.matchStatus as PunchMatchStatus,
      position: r.position === 'OUT' ? 'OUT' : 'IN',
    })),
    laterWeekApproved: laterWeeks > 0,
    rejectedIds,
  })
}

/** What the approval dialog shows before approving: the same rule, read-only. */
export async function previewApprovalStatusChanges(input: ApprovalStatusInput): Promise<StatusChangeSummary> {
  return summarizeStatusChanges(await readStatusChanges(prisma, input))
}

/**
 * Set employee status from an approved week. Runs inside the approval transaction (`tx`), after the
 * week row is locked, so the punches read here are the ones being approved.
 */
export async function applyApprovalStatusChanges(
  tx: Prisma.TransactionClient,
  input: ApprovalStatusInput,
): Promise<StatusChangeSummary> {
  const { week } = input
  const changes = await readStatusChanges(tx, input)

  for (const to of [false, true]) {
    const ids = changes.filter((c) => c.to === to).map((c) => c.employeeDbId)
    if (ids.length > 0) await tx.employee.updateMany({ where: { id: { in: ids } }, data: { isActive: to } })
  }
  if (changes.length > 0) {
    const weekLabel = formatWeekLabel(week)
    await tx.auditLog.createMany({
      data: changes.map((change) => {
        const who = `${change.employeeName} (${change.employeeId})`
        const details = {
          summary: change.to
            ? `Reactivated on approval: ${who} has ${plural(change.punchCount, 'punch', 'punches')} in ${weekLabel}`
            : `Marked inactive on approval: ${who} had no punches in ${weekLabel}`,
          changeSource: 'AUTO_ATTENDANCE',
          employeeId: change.employeeId,
          employeeName: change.employeeName,
          isActive: { from: change.from, to: change.to },
          weekStart: week.start,
          weekEnd: week.end,
          punchCount: change.punchCount,
          hours: change.hours,
        }
        return { actionType: 'UPDATE', entityType: 'EMPLOYEE', entityId: change.employeeDbId, detailsJson: details }
      }),
    })
  }
  return summarizeStatusChanges(changes)
}
