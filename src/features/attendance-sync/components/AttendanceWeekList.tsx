'use client'

import { useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowsClockwise, CalendarBlank, CheckCircle, Eye, SpinnerGap } from '@phosphor-icons/react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { getPullWarningAction, pullWeekAction } from '../actions/attendance-sync.actions'
import { formatHoursTotal, formatIstDateTime, formatDayShort, plural } from '../lib/format'
import { addDaysISO, formatWeekLabel } from '../lib/week'
import type { AttendanceWeekListItem, ISODate, SyncOutcome } from '../types/attendance-sync.types'
import { AttendancePageHeader } from './AttendancePageHeader'
import { LoadPastWeekPicker } from './LoadPastWeekPicker'
import { WeekStatusBadge } from './WeekStatusBadge'

// ─── Payroll badge ────────────────────────────────────────────────────────────

function PayrollStatusBadge({ status }: { status: AttendanceWeekListItem['payrollStatus'] }) {
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <CheckCircle size={13} weight="fill" className="text-emerald-500" />
        Approved
      </span>
    )
  }
  if (status === 'REVISED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
        <CheckCircle size={13} weight="fill" className="text-sky-500" />
        Revised
      </span>
    )
  }
  return <span className="text-xs text-zinc-500">Not generated</span>
}

// ─── Details column ───────────────────────────────────────────────────────────

function reviewRemaining(week: AttendanceWeekListItem): string {
  const parts: string[] = []
  if (week.unresolvedCodes > 0) parts.push(`${plural(week.unresolvedCodes, 'code')} to fix`)
  if (week.pendingDecisions > 0) parts.push(`${plural(week.pendingDecisions, 'decision')} left`)
  if (week.needsFixingDays > 0) parts.push(`${plural(week.needsFixingDays, 'day')} Needs fixing`)
  if (parts.length > 0) return parts.join(' · ')
  return week.hasEnded ? 'Ready to approve' : 'Week in progress'
}

function WeekDetails({ week }: { week: AttendanceWeekListItem }) {
  if (week.source === 'EXCEL') {
    return (
      <span className="font-mono text-xs text-zinc-500">
        Excel upload{week.fileName ? ` · ${week.fileName}` : ''}
      </span>
    )
  }

  if (week.status === 'APPROVED') {
    return (
      <span className="text-sm text-zinc-500">
        {plural(week.employeeCount, 'employee')} · <span className="font-mono tabular-nums">{formatHoursTotal(week.totalRegularHours)}</span>{' '}
        reg · <span className="font-mono tabular-nums">{formatHoursTotal(week.totalOvertimeHours)}</span> OT
      </span>
    )
  }

  if (week.status === 'REVIEW') {
    return (
      <>
        <span className="text-sm text-zinc-500">{reviewRemaining(week)}</span>
        {!week.hasEnded && (
          <span className="block text-xs text-zinc-500">
            Can be approved from {formatDayShort(addDaysISO(week.week.end, 1))}
          </span>
        )}
      </>
    )
  }

  if (week.status === 'SYNC_FAILED') {
    return (
      <>
        <span className="block text-sm text-rose-600" data-testid="week-error">
          {week.lastSyncError ?? "Couldn't load this week."}
        </span>
        {week.lastSyncAttemptAt && (
          <span className="block text-xs text-zinc-500">Last tried {formatIstDateTime(week.lastSyncAttemptAt)}</span>
        )}
      </>
    )
  }

  return (
    <span className="text-sm text-zinc-500">
      {week.hasEnded ? 'No sync has run for this week' : 'Week in progress. Nothing loaded yet.'}
    </span>
  )
}

/** Notices under the details: a failed pull on a week that has data, and newer data waiting. */
function WeekNotices({ week }: { week: AttendanceWeekListItem }) {
  const failedPull = week.status === 'REVIEW' && week.lastSyncError
  // "Pull now" is what the notice tells the user to do, so it shows only where a pull is possible:
  // never on an approved week or one whose payroll is approved.
  const staleNotice = Boolean(week.staleNoticeAt) && week.canPullNow && (week.status === 'REVIEW' || week.status === 'SYNC_FAILED')
  if (!failedPull && !staleNotice) return null

  return (
    <div className="mt-1 space-y-0.5">
      {failedPull && (
        <span className="block text-xs text-rose-600" data-testid="week-error">
          Last pull failed: {week.lastSyncError}
          {week.lastSyncAttemptAt ? ` (${formatIstDateTime(week.lastSyncAttemptAt)})` : ''}
        </span>
      )}
      {staleNotice && (
        <span className="block text-xs text-amber-700" data-testid="week-stale-notice">
          Newer data may be available. Pull now to replace this week, discarding your edits.
        </span>
      )}
    </div>
  )
}

// ─── Row actions ──────────────────────────────────────────────────────────────

const LINK_BASE =
  'inline-flex items-center gap-1 rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]'

interface RowActionsProps {
  week: AttendanceWeekListItem
  isPulling: boolean
  isBusy: boolean
  onPull: (weekId: ISODate) => void
}

// ─── Discard warning ──────────────────────────────────────────────────────────

interface PullWarning {
  weekId: ISODate
  editedDays: number
  decisions: number
  ignoredCodes: number
}

/**
 * "12 edited days, your employee decisions and 1 code ignored for this week"; empty when nothing
 * would be lost. Two items read "A and B", three "A, B and C".
 */
function describeDiscard(editedDays: number, decisions: number, ignoredCodes: number): string {
  const parts: string[] = []
  if (editedDays > 0) parts.push(plural(editedDays, 'edited day'))
  if (decisions > 0) parts.push('your employee decisions')
  if (ignoredCodes > 0) parts.push(`${plural(ignoredCodes, 'code')} ignored for this week`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('')
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyWeeks() {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center" data-testid="week-list-empty">
      <CalendarBlank size={48} className="text-zinc-300" />
      <p className="mt-4 max-w-sm text-sm text-zinc-500">
        No attendance weeks yet. The next sync runs Thursday between 06:00 and 07:00 IST.
      </p>
    </div>
  )
}

// ─── AttendanceWeekList ───────────────────────────────────────────────────────

interface AttendanceWeekListProps {
  weeks: AttendanceWeekListItem[]
  /** Today in IST, for the week picker. */
  todayISO: ISODate
}

export function AttendanceWeekList({ weeks, todayISO }: AttendanceWeekListProps) {
  const router = useRouter()
  const [pullingWeek, setPullingWeek] = useState<ISODate | null>(null)
  const [checkingWeek, setCheckingWeek] = useState<ISODate | null>(null)
  const [warning, setWarning] = useState<PullWarning | null>(null)

  const isBusy = pullingWeek !== null || checkingWeek !== null

  async function runPull(weekId: ISODate) {
    const label = formatWeekLabel({ start: weekId, end: addDaysISO(weekId, 6) })
    setPullingWeek(weekId)
    try {
      const res = await pullWeekAction(weekId)
      if (!res.ok) {
        if (res.code === 'SYNC_IN_PROGRESS') toast.info('A pull for this week is already running.')
        else toast.error(res.error)
        router.refresh()
        return
      }
      reportOutcome(res.data, label)
    } catch {
      toast.error("Couldn't reach the server. Try again.")
    } finally {
      setPullingWeek(null)
    }
  }

  function reportOutcome(outcome: SyncOutcome, label: string) {
    if (outcome.outcome === 'LOADED') {
      const discarded = outcome.discarded
      toast.success(`Loaded ${label}`, {
        description:
          discarded && (discarded.editedDays > 0 || discarded.decisions > 0 || discarded.ignoredCodes > 0)
            ? `Discarded ${describeDiscard(discarded.editedDays, discarded.decisions, discarded.ignoredCodes)}.`
            : undefined,
      })
    } else if (outcome.outcome === 'FAILED') {
      toast.error(`Couldn't load ${label}`, { description: outcome.message })
    } else {
      toast.info('This week was not changed.')
    }
  }

  async function requestPull(weekId: ISODate) {
    setCheckingWeek(weekId)
    try {
      const check = await getPullWarningAction(weekId)
      if (!check.ok) {
        toast.error(check.error)
        return
      }
      const { editedDays, decisions, ignoredCodes } = check.data
      if (editedDays > 0 || decisions > 0 || ignoredCodes > 0) {
        setWarning({ weekId, editedDays, decisions, ignoredCodes })
        return
      }
    } catch {
      toast.error("Couldn't reach the server. Try again.")
      return
    } finally {
      setCheckingWeek(null)
    }
    await runPull(weekId)
  }

  function confirmWarning() {
    if (!warning) return
    const { weekId } = warning
    setWarning(null)
    void runPull(weekId)
  }

  return (
    <div data-testid="attendance-week-list">
      <AttendancePageHeader
        actions={<LoadPastWeekPicker weeks={weeks} todayISO={todayISO} disabled={isBusy} onPull={requestPull} />}
      />

      {weeks.length === 0 ? (
        <EmptyWeeks />
      ) : (
        <table role="table" className="block w-full md:table md:divide-y md:divide-zinc-100">
          <thead role="rowgroup" className="hidden md:table-header-group">
            <tr role="row" className="bg-zinc-50/50">
              {['Week', 'Status', 'Details', 'Payroll', 'Action'].map((heading) => (
                <th
                  key={heading}
                  role="columnheader"
                  scope="col"
                  className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-zinc-500 ${
                    heading === 'Action' ? 'text-right' : 'text-left'
                  }`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className="block divide-y divide-zinc-100 md:table-row-group">
            {weeks.map((week, index) => (
              <tr
                key={week.weekId}
                role="row"
                style={{ '--index': index } as CSSProperties}
                data-testid={`week-row-${week.weekId}`}
                data-status={week.status}
                data-source={week.source ?? 'NONE'}
                className="card-reveal block space-y-2 px-1 py-4 transition-colors hover:bg-zinc-50/80 md:table-row md:space-y-0 md:px-0 md:py-0"
              >
                <td role="cell" className="block md:table-cell md:px-4 md:py-3 md:align-top">
                  <span className="whitespace-nowrap text-sm font-medium text-zinc-900" data-testid="week-label">
                    {formatWeekLabel(week.week)}
                  </span>
                </td>
                <td role="cell" className="block md:table-cell md:whitespace-nowrap md:px-4 md:py-3 md:align-top">
                  <WeekStatusBadge
                    status={week.status}
                    isSyncing={week.isSyncing || pullingWeek === week.weekId}
                    emptyLabel={week.hasEnded ? 'No data' : 'In progress'}
                  />
                </td>
                <td role="cell" className="block md:table-cell md:px-4 md:py-3 md:align-top" data-testid="week-details">
                  <WeekDetails week={week} />
                  <WeekNotices week={week} />
                </td>
                <td role="cell" className="block md:table-cell md:px-4 md:py-3 md:align-top">
                  <PayrollStatusBadge status={week.payrollStatus} />
                </td>
                <td role="cell" className="block md:table-cell md:px-4 md:py-3 md:align-top md:text-right">
                  <RowActions
                    week={week}
                    isPulling={pullingWeek === week.weekId}
                    isBusy={isBusy}
                    onPull={requestPull}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AlertDialog open={warning !== null} onOpenChange={(open) => !open && setWarning(null)}>
        <AlertDialogContent data-testid="pull-warning-dialog">
          <AlertDialogTitle>Pull this week again?</AlertDialogTitle>
          <AlertDialogDescription>
            <span data-testid="pull-warning-text">{warning ? `This will discard ${describeDiscard(warning.editedDays, warning.decisions, warning.ignoredCodes)}.` : ''}</span>{' '}
            The week is replaced with a fresh pull from eTimeOffice. The discarded edits stay in the audit log.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setWarning(null)} data-testid="pull-warning-cancel">
              Cancel
            </Button>
            <Button
              className="rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={confirmWarning}
              data-testid="pull-warning-confirm"
            >
              Discard and pull
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The row's links and Pull now. Both are disabled while this week is being pulled. */
function RowActions({ week, isPulling, isBusy, onPull }: RowActionsProps) {
  const { weekId } = week
  const rowDisabled = isPulling || week.isSyncing
  const linkState = rowDisabled ? 'pointer-events-none opacity-50' : ''
  const needsCheck = week.unresolvedCodes > 0 || week.pendingDecisions > 0

  return (
    <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:justify-end">
      {week.status === 'REVIEW' && (
        <Link
          href={needsCheck ? `/attendance/${weekId}/employee-check` : `/attendance/${weekId}/review`}
          className={`${LINK_BASE} ${linkState}`}
          aria-disabled={rowDisabled}
          tabIndex={rowDisabled ? -1 : undefined}
          data-testid={`review-link-${weekId}`}
        >
          <Eye size={14} />
          Review
        </Link>
      )}
      {(week.source === 'EXCEL' || week.status === 'APPROVED') && (
        <Link
          href={`/attendance/${weekId}/review`}
          className={`${LINK_BASE} ${linkState}`}
          data-testid={`view-link-${weekId}`}
        >
          <Eye size={14} />
          View
        </Link>
      )}
      <PullButton week={week} isPulling={isPulling} isBusy={isBusy} onPull={onPull} />
    </div>
  )
}

function PullButton({ week, isPulling, isBusy, onPull }: RowActionsProps) {
  if (week.isSyncing && !isPulling) {
    return (
      <Button size="sm" variant="outline" disabled className="rounded-xl">
        <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />
        Pulling…
      </Button>
    )
  }
  if (!week.canPullNow) return null

  const hasData = week.status === 'REVIEW'
  return (
    <Button
      size="sm"
      variant={hasData ? 'outline' : 'default'}
      disabled={isBusy}
      onClick={() => onPull(week.weekId)}
      data-testid={`pull-now-${week.weekId}`}
      className={
        hasData
          ? 'rounded-xl'
          : 'rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.98] disabled:bg-emerald-600/40 disabled:opacity-100'
      }
    >
      {isPulling ? (
        <>
          <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />
          Pulling…
        </>
      ) : (
        <>
          <ArrowsClockwise size={14} />
          Pull now
        </>
      )}
    </Button>
  )
}
