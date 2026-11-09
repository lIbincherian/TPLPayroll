import type { Prisma } from '@prisma/client'
import { formatPunchesCell } from './hours'
import { round2 } from './time'
import { toUtcDate } from './week'
import type {
  ApprovalDecisionInput,
  ApprovalSummary,
  ApproveBlocker,
  AttendanceSource,
  AttendanceWeekStatus,
  DayView,
  EmployeeDecisionValue,
  GridEmployee,
  ISODate,
  PairView,
  PunchReview,
  WeekPayrollStatus,
} from '../types/attendance-sync.types'

// ─── Grid helpers ─────────────────────────────────────────────────────────────

/** Days with an incomplete pair. These block approval. */
export function getNeedsFixingDays(employees: GridEmployee[]): Array<{ employeeId: string; date: ISODate }> {
  return employees.flatMap((employee) =>
    employee.days.filter((day) => day.incomplete).map((day) => ({ employeeId: employee.employeeId, date: day.date })),
  )
}

/** Grid employees with no punches this week. These never block approval. */
export function getNoPunchEmployees(employees: GridEmployee[]): GridEmployee[] {
  return employees.filter((employee) => !employee.hasAnyPunch)
}

export function countUnusualDays(employees: GridEmployee[]): number {
  return employees.reduce((sum, employee) => sum + employee.days.filter((day) => day.isUnusual).length, 0)
}

function employeeTotalHours(employee: GridEmployee): number {
  return employee.totalRegularHours + employee.totalOvertimeHours
}

// ─── Approval ─────────────────────────────────────────────────────────────────

/** Unusual days and no-punch employees never block. */
export function canApproveWeek(input: {
  status: AttendanceWeekStatus
  weekEndISO: ISODate
  todayISO: ISODate
  needsFixingCount: number
  unresolvedCodeCount: number
  pendingDecisionCount: number
}): { canApprove: boolean; blockers: ApproveBlocker[] } {
  const blockers: ApproveBlocker[] = []
  if (input.status !== 'REVIEW') blockers.push('NOT_IN_REVIEW')
  if (input.todayISO <= input.weekEndISO) blockers.push('WEEK_NOT_ENDED')
  if (input.needsFixingCount > 0) blockers.push('NEEDS_FIXING')
  if (input.unresolvedCodeCount > 0) blockers.push('UNRESOLVED_CODES')
  if (input.pendingDecisionCount > 0) blockers.push('PENDING_DECISIONS')
  return { canApprove: blockers.length === 0, blockers }
}

/** Grid employees with any hours this week. Rejected employees are not in the grid. */
export function getPayrollEmployees(review: Pick<PunchReview, 'employees'>): GridEmployee[] {
  return review.employees.filter((employee) => employeeTotalHours(employee) > 0)
}

function describeDay(pairs: PairView[], which: 'original' | 'current'): string {
  const parts: string[] = []
  for (const pair of pairs) {
    const inTime = which === 'original' ? pair.in?.original : pair.in?.time
    const outTime = which === 'original' ? pair.out?.original : pair.out?.time
    if (!inTime && !outTime) continue
    if (inTime && outTime) parts.push(formatPunchesCell([{ in: inTime, out: outTime }]))
    else parts.push(`${inTime ?? '?'}–${outTime ?? '?'}`)
  }
  return parts.length > 0 ? parts.join(', ') : '-'
}

export function buildApprovalSummary(
  review: Pick<PunchReview, 'employees'>,
  decisions: ApprovalDecisionInput[],
): ApprovalSummary {
  const included = getPayrollEmployees(review)

  const editedDayDetails: ApprovalSummary['editedDayDetails'] = []
  for (const employee of review.employees) {
    for (const day of employee.days) {
      if (!day.isEdited) continue
      editedDayDetails.push({
        employeeName: employee.employeeName,
        date: day.date,
        before: describeDay(day.pairs, 'original'),
        after: describeDay(day.pairs, 'current'),
      })
    }
  }

  const leftOut: ApprovalSummary['leftOut'] = [
    ...review.employees
      .filter((employee) => employeeTotalHours(employee) === 0)
      .map((employee) => ({
        employeeId: employee.employeeId,
        employeeCode: employee.employeeCode,
        employeeName: employee.employeeName,
        reason: 'ZERO_HOURS' as const,
      })),
    ...decisions
      .filter((d) => d.decision === 'REJECTED')
      .map((d) => ({
        employeeId: d.employeeId,
        employeeCode: d.employeeCode,
        employeeName: d.employeeName,
        reason: 'REJECTED' as const,
      })),
  ]

  return {
    employeeCount: included.length,
    totalRegularHours: round2(included.reduce((sum, e) => sum + e.totalRegularHours, 0)),
    totalOvertimeHours: round2(included.reduce((sum, e) => sum + e.totalOvertimeHours, 0)),
    editedDays: editedDayDetails.length,
    editedDayDetails,
    leftOut,
  }
}

/**
 * The seven `AttendanceRecord` rows per payroll employee (one per week date). Days with
 * no hours get 0.00. The six legacy slot columns stay null.
 */
export function buildAttendanceRecords(
  uploadId: string,
  review: Pick<PunchReview, 'employees'>,
  decisions: Array<{ employeeId: string; decision: EmployeeDecisionValue }>,
): Prisma.AttendanceRecordCreateManyInput[] {
  const decisionByEmployee = new Map(decisions.map((d) => [d.employeeId, d.decision]))

  return getPayrollEmployees(review).flatMap((employee) =>
    employee.days.map((day: DayView) => ({
      attendanceUploadId: uploadId,
      employeeId: employee.employeeId,
      attendanceDate: toUtcDate(day.date),
      regularHours: day.regularHours,
      overtimeHours: day.overtimeHours,
      beforeNoonIn: null,
      beforeNoonOut: null,
      afternoonIn: null,
      afternoonOut: null,
      overtimeIn: null,
      overtimeOut: null,
      sourceSheetName: null,
      sourceEmployeeBlockIndex: null,
      verificationDecision: decisionByEmployee.get(employee.employeeId) ?? null,
    })),
  )
}

// ─── Week-list rules ──────────────────────────────────────────────────────────

/**
 * Pull now works on any Thu–Wed week that is not approved, past or in progress, including
 * weeks that already have data. Not on Excel-era weeks, not once payroll is approved,
 * not on future weeks, and not while a sync holds the lock.
 */
export function canPullNow(
  week: {
    source: AttendanceSource | null
    status: AttendanceWeekStatus
    payrollStatus: WeekPayrollStatus
    isSyncing: boolean
    start: ISODate
  },
  today: ISODate,
): boolean {
  return (
    week.source !== 'EXCEL' &&
    week.status !== 'APPROVED' &&
    week.payrollStatus === 'NOT_GENERATED' &&
    !week.isSyncing &&
    week.start <= today
  )
}

/** Reopen is for approved API weeks whose payroll has not been generated. */
export function canReopenWeek(week: {
  source: AttendanceSource | null
  status: AttendanceWeekStatus
  payrollStatus: WeekPayrollStatus
}): boolean {
  return week.source === 'ETIMEOFFICE' && week.status === 'APPROVED' && week.payrollStatus === 'NOT_GENERATED'
}

/** A scheduled sync replaces an unapproved pull that has no edits or decisions. */
export function shouldScheduledSyncReplace(week: {
  hasEditsOrDecisions: boolean
  status: AttendanceWeekStatus
}): boolean {
  return week.status !== 'APPROVED' && !week.hasEditsOrDecisions
}

/** No row is NO_DATA; an Excel-era row (any legacy status) reads as APPROVED. */
export function getAttendanceWeekStatus(upload: { source: string; status: string } | null): AttendanceWeekStatus {
  if (!upload) return 'NO_DATA'
  if (upload.source === 'EXCEL') return 'APPROVED'
  if (upload.status === 'REVIEW' || upload.status === 'APPROVED' || upload.status === 'SYNC_FAILED') {
    return upload.status
  }
  return 'SYNC_FAILED'
}
