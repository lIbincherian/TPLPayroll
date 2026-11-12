import type { AttendanceWeekListItem, ISODate } from '../types/attendance-sync.types'

export interface PickerWeekState {
  disabled: boolean
  /** Why the week can't be chosen. */
  reason?: string
  /** Short note shown beside the week, e.g. "Has data". */
  hint?: string
}

/**
 * Whether the "Load a past week" picker lets the user choose a Thursday-start week. A week can
 * be pulled once it has started, unless it is approved, imported from Excel, or already used by
 * an approved payroll. In-progress weeks and weeks that already have data are allowed; pulling
 * over data asks for confirmation first.
 */
export function getPickerWeekState(
  weekStart: ISODate,
  item: AttendanceWeekListItem | undefined,
  todayISO: ISODate,
): PickerWeekState {
  if (weekStart > todayISO) return { disabled: true, reason: "This week hasn't started yet", hint: 'Not started' }
  if (!item) return { disabled: false }
  if (item.source === 'EXCEL') {
    return { disabled: true, reason: "This week was imported from Excel and can't be pulled", hint: 'Excel' }
  }
  if (item.payrollStatus !== 'NOT_GENERATED') {
    return { disabled: true, reason: 'Payroll for this week is approved', hint: 'Payroll approved' }
  }
  if (item.status === 'APPROVED') {
    return { disabled: true, reason: 'This week is approved. Reopen it to pull again.', hint: 'Approved' }
  }
  if (item.isSyncing) return { disabled: true, reason: 'A pull is already running for this week', hint: 'Pulling' }
  if (item.status === 'REVIEW') return { disabled: false, hint: 'Has data' }
  if (!item.hasEnded) return { disabled: false, hint: 'In progress' }
  return { disabled: false }
}
