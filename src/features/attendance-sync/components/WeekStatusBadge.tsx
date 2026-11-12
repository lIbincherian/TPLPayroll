import { CheckCircle, ListChecks, SpinnerGap, XCircle } from '@phosphor-icons/react/dist/ssr'
import type { AttendanceWeekStatus } from '../types/attendance-sync.types'

const BADGE = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium'

interface WeekStatusBadgeProps {
  status: AttendanceWeekStatus
  /** A pull is running for this week. Shown in place of the stored status. */
  isSyncing?: boolean
  /** Replaces "No data" when a week hasn't started or is still in progress. */
  emptyLabel?: string
}

/** The week's attendance status. Works in server and client components. */
export function WeekStatusBadge({ status, isSyncing = false, emptyLabel = 'No data' }: WeekStatusBadgeProps) {
  if (isSyncing) {
    return (
      <span className={`${BADGE} bg-zinc-100 text-zinc-600`} data-testid="week-status-badge" data-status="SYNCING">
        <SpinnerGap size={13} className="animate-spin motion-reduce:animate-none" />
        Pulling…
      </span>
    )
  }

  if (status === 'APPROVED') {
    return (
      <span className={`${BADGE} bg-emerald-50 text-emerald-700`} data-testid="week-status-badge" data-status={status}>
        <CheckCircle size={13} weight="fill" className="text-emerald-500" />
        Approved
      </span>
    )
  }

  if (status === 'REVIEW') {
    return (
      <span className={`${BADGE} bg-amber-50 text-amber-700`} data-testid="week-status-badge" data-status={status}>
        <ListChecks size={13} className="text-amber-500" />
        Ready for review
      </span>
    )
  }

  if (status === 'SYNC_FAILED') {
    return (
      <span className={`${BADGE} bg-rose-50 text-rose-700`} data-testid="week-status-badge" data-status={status}>
        <XCircle size={13} weight="fill" className="text-rose-500" />
        Sync failed
      </span>
    )
  }

  return (
    <span className="text-xs text-zinc-500" data-testid="week-status-badge" data-status={status}>
      {emptyLabel}
    </span>
  )
}
