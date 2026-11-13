'use client'

import { useEffect, useState } from 'react'
import { CaretRight, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getApprovalSummaryAction } from '../actions/attendance-sync.actions'
import { describeStatusChanges } from '../lib/employee-status'
import { formatDayShort, formatHoursTotal, plural } from '../lib/format'
import type { ApprovalSummary, ISODate, ReviewMode, StatusChangedEmployee } from '../types/attendance-sync.types'

const LABEL = 'text-xs font-medium uppercase tracking-wider text-zinc-500'

export type ApproveResult = { ok: true } | { ok: false; error: string; code?: string }

type SummaryState =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: ApprovalSummary }
  | { kind: 'failed'; message: string }

const BLOCKED_CODES = new Set(['WEEK_NOT_READY', 'CORRECTION_HAS_INCOMPLETE_PAIRS'])

// ─── Summary strip ────────────────────────────────────────────────────────────

function SummaryStrip({ summary, correction }: { summary: ApprovalSummary | null; correction: boolean }) {
  const cells: Array<{ id: string; label: string; value: string | null }> = [
    { id: 'employees', label: 'Employees', value: summary ? String(summary.employeeCount) : null },
    { id: 'edited-days', label: 'Edited days', value: summary ? String(summary.editedDays) : null },
    { id: 'regular', label: 'Regular hours', value: summary ? formatHoursTotal(summary.totalRegularHours) : null },
    { id: 'overtime', label: 'Overtime hours', value: summary ? formatHoursTotal(summary.totalOvertimeHours) : null },
  ]

  return (
    <dl className="grid grid-cols-2 gap-4 border-b border-t border-zinc-200/60 py-4" data-testid="approval-summary">
      {cells.map((cell) => (
        <div key={cell.id}>
          <dt className={LABEL}>{cell.label}</dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900" data-testid={`approval-${cell.id}`}>
            {cell.value ?? <span className="skeleton-shimmer inline-block h-6 w-16 rounded align-middle" aria-hidden />}
          </dd>
        </div>
      ))}
      {correction && summary?.changedDaysInCorrection !== undefined && (
        <p className="col-span-2 text-sm text-zinc-600" data-testid="approval-changed-days">
          {plural(summary.changedDaysInCorrection, 'day')} changed in this correction
        </p>
      )}
    </dl>
  )
}

// ─── Employee status changes ──────────────────────────────────────────────────

function StatusChangesPreview({ summary }: { summary: ApprovalSummary }) {
  const changes = summary.statusChanges
  const sentence = changes ? describeStatusChanges(changes) : null
  if (!changes || sentence === null) return null

  const names = (list: StatusChangedEmployee[]) => list.map((e) => e.employeeName).join(', ')
  return (
    <section className="pt-4" data-testid="approval-status-changes">
      <h3 className="text-sm font-medium text-zinc-900">Approving also changes employee status</h3>
      <p className="mt-1 text-sm text-zinc-600">{sentence}.</p>
      <dl className="mt-2 max-h-32 space-y-1 overflow-y-auto text-sm">
        {changes.markedInactive.length > 0 && (
          <div>
            <dt className="inline font-medium text-zinc-700">Marked inactive (no punches): </dt>
            <dd className="inline text-zinc-600">{names(changes.markedInactive)}</dd>
          </div>
        )}
        {changes.reactivated.length > 0 && (
          <div>
            <dt className="inline font-medium text-zinc-700">Reactivated (has punches): </dt>
            <dd className="inline text-zinc-600">{names(changes.reactivated)}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}

// ─── Left out and edited days ─────────────────────────────────────────────────

function leftOutReason(item: ApprovalSummary['leftOut'][number], markedInactive: ReadonlySet<string>): string {
  if (item.reason === 'REJECTED') return 'Rejected in employee check'
  return markedInactive.has(item.employeeId) ? 'No punches, marked inactive' : 'Zero hours'
}

function LeftOutList({
  summary,
  onShowEmployee,
}: {
  summary: ApprovalSummary
  onShowEmployee: (employeeCode: string) => void
}) {
  const markedInactive = new Set(summary.statusChanges?.markedInactive.map((e) => e.id))
  if (summary.leftOut.length === 0) {
    return (
      <section className="pt-4" data-testid="approval-left-out">
        <p className="text-sm text-zinc-500">No employees left out.</p>
      </section>
    )
  }

  return (
    <section className="pt-4" data-testid="approval-left-out">
      <h3 className="text-sm font-medium text-zinc-900">{plural(summary.leftOut.length, 'employee')} left out, no payslip</h3>
      <ul className="mt-2 max-h-48 divide-y divide-zinc-100 overflow-y-auto">
        {summary.leftOut.map((item) => {
          const row = (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{item.employeeName}</span>
              <span className="font-mono text-xs text-zinc-500">{item.employeeCode}</span>
              <span className="w-40 text-right text-xs text-zinc-600">
                {leftOutReason(item, markedInactive)}
              </span>
            </>
          )
          return (
            <li key={`${item.employeeId}-${item.reason}`} data-testid={`left-out-${item.employeeCode}`}>
              {item.reason === 'ZERO_HOURS' ? (
                <button
                  type="button"
                  onClick={() => onShowEmployee(item.employeeCode)}
                  className="flex w-full items-center gap-3 px-1 py-2 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                >
                  {row}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-1 py-2">{row}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function EditedDays({ summary }: { summary: ApprovalSummary }) {
  if (summary.editedDays === 0) return null

  return (
    <Collapsible className="mt-4 border-t border-zinc-100 pt-3" data-testid="approval-edited-days">
      <CollapsibleTrigger>
        <CaretRight size={12} className="transition-transform group-data-[panel-open]/collapsible:rotate-90" />
        {plural(summary.editedDays, 'edited day')}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
          {summary.editedDayDetails.map((detail) => (
            <li key={`${detail.employeeName}-${detail.date}`} className="flex flex-wrap items-baseline gap-x-3 text-xs">
              <span className="text-zinc-900">{detail.employeeName}</span>
              <span className="text-zinc-500">{formatDayShort(detail.date)}</span>
              <span className="font-mono tabular-nums text-zinc-600">
                {detail.before} → {detail.after}
              </span>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  )
}

// ─── Dialog body: mounted fresh each time the dialog opens ────────────────────

interface ApproveBodyProps {
  weekId: ISODate
  weekLabel: string
  mode: ReviewMode
  pending: boolean
  setPending: (pending: boolean) => void
  onClose: () => void
  onConfirm: () => Promise<ApproveResult | undefined>
  onShowEmployee: (employeeCode: string) => void
  onShowNeedsFixing: () => void
}

function ApproveBody({
  weekId,
  weekLabel,
  mode,
  pending,
  setPending,
  onClose,
  onConfirm,
  onShowEmployee,
  onShowNeedsFixing,
}: ApproveBodyProps) {
  const isCorrection = mode.kind === 'CORRECTION'
  const [state, setState] = useState<SummaryState>({ kind: 'loading' })
  const [error, setError] = useState<{ message: string; blocked: boolean } | null>(null)

  const modeKey = mode.kind === 'CORRECTION' ? `${mode.kind}:${mode.correctionId}` : mode.kind
  useEffect(() => {
    let cancelled = false
    void getApprovalSummaryAction(weekId, mode)
      .then((res) => {
        if (cancelled) return
        setState(res.ok ? { kind: 'ready', summary: res.data } : { kind: 'failed', message: res.error })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'failed', message: "Couldn't load the summary." })
      })
    return () => {
      cancelled = true
    }
    // `mode` is identified by modeKey, so a new object with the same content doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekId, modeKey])

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      const result = await onConfirm()
      if (result && !result.ok) {
        setError({ message: result.error, blocked: Boolean(result.code && BLOCKED_CODES.has(result.code)) })
        setPending(false)
      } else if (result?.ok) {
        setPending(false)
      }
      // No result: the action redirected, so stay in the pending state while the page changes.
    } catch {
      setError({ message: "Couldn't reach the server. Nothing was changed.", blocked: false })
      setPending(false)
    }
  }

  const summary = state.kind === 'ready' ? state.summary : null
  const title = isCorrection ? 'Approve punches' : 'Approve week'

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="font-mono tabular-nums">{weekLabel}</DialogDescription>
      </DialogHeader>

      <SummaryStrip summary={summary} correction={isCorrection} />

      {state.kind === 'failed' && (
        <p role="alert" className="mt-4 text-sm text-rose-600" data-testid="approval-summary-error">
          {state.message}
        </p>
      )}

      {summary && (
        <>
          <LeftOutList summary={summary} onShowEmployee={onShowEmployee} />
          <StatusChangesPreview summary={summary} />
          <EditedDays summary={summary} />
        </>
      )}

      <p className="mt-4 text-sm text-zinc-500">
        {isCorrection
          ? 'Approving recalculates this week as a new revision. The current revision stays in effect until you approve the new one.'
          : 'Approving locks the week and makes it available to payroll.'}
      </p>

      {error && (
        <div
          role="alert"
          data-testid="approve-error"
          className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50 p-3"
        >
          <WarningCircle size={16} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex-1 text-sm text-rose-700">
            <p>{error.blocked ? error.message : `Couldn't approve. ${error.message}`}</p>
            {error.blocked && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 rounded-xl"
                onClick={onShowNeedsFixing}
                data-testid="show-needs-fixing"
              >
                Show days
              </Button>
            )}
          </div>
        </div>
      )}

      <DialogFooter className="max-md:sticky max-md:bottom-0 max-md:-mx-6 max-md:-mb-6 max-md:bg-white max-md:px-6 max-md:py-4">
        <Button variant="outline" className="rounded-xl" disabled={pending} onClick={onClose} data-testid="approve-cancel">
          Cancel
        </Button>
        <Button
          className="rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.98]"
          disabled={pending || state.kind !== 'ready'}
          onClick={() => void handleConfirm()}
          data-testid="approve-confirm"
        >
          {pending ? (
            <>
              <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />
              {isCorrection ? 'Recalculating…' : 'Approving…'}
            </>
          ) : (
            title
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

// ─── ApproveWeekDialog ────────────────────────────────────────────────────────

interface ApproveWeekDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  weekId: ISODate
  weekLabel: string
  mode: ReviewMode
  /**
   * Approves. Resolves to an error to show in the dialog. In correction mode a successful
   * approval navigates away, so the promise may never settle with `ok`.
   */
  onConfirm: () => Promise<ApproveResult | undefined>
  /** A left-out employee was clicked: close and show that employee in the grid. */
  onShowEmployee: (employeeCode: string) => void
  /** "Show days": close and show the days that need fixing. */
  onShowNeedsFixing: () => void
}

/**
 * The summary shown before approving: who is paid, who is left out, what was edited. It reads
 * the numbers fresh each time it opens, and the server re-checks everything on confirm.
 */
export function ApproveWeekDialog({ open, onOpenChange, ...body }: ApproveWeekDialogProps) {
  const [pending, setPending] = useState(false)

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        data-testid="approve-week-dialog"
        className="max-w-lg max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:max-h-[92dvh] max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none"
      >
        <ApproveBody {...body} pending={pending} setPending={setPending} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
