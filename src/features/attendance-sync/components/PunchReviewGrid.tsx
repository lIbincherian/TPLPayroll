'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsMerge,
  CheckCircle,
  Lock,
  MagnifyingGlass,
  PencilSimple,
  Warning,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  approveWeekAction,
  getApprovalSummaryAction,
  getPunchReviewAction,
  reopenWeekAction,
} from '../actions/attendance-sync.actions'
import { formatHoursTotal, formatIstDateTime, formatIstTime, plural } from '../lib/format'
import { useMediaQuery } from '../hooks/useMediaQuery'
import {
  applySaveResult,
  describeBlockers,
  findStepTarget,
  matchesFilter,
  matchesSearch,
  type DayTarget,
  type GridFilter,
} from '../lib/review-view'
import { formatWeekLabel } from '../lib/week'
import type {
  ActionResult,
  ApprovalSummary,
  CorrectionReview,
  ISODate,
  LiveReview,
  PunchReview,
  SavePunchEditResult,
} from '../types/attendance-sync.types'
import { ApproveWeekDialog, type ApproveResult } from './ApproveWeekDialog'
import { CorrectionBanner } from './CorrectionBanner'
import { DayEditorSheet, type DayReload } from './DayEditorSheet'
import { cellKey, PunchGridTable } from './PunchGridTable'
import { PunchMobileList } from './PunchMobileList'
import { ReopenWeekDialog } from './ReopenWeekDialog'
import { WeekStatusBadge } from './WeekStatusBadge'

const EDITOR_WIDTH = 460

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface FilterBarProps {
  review: PunchReview
  filter: GridFilter
  search: string
  showNeedsFixing: boolean
  showEmployeeCheck: boolean
  onFilter: (filter: GridFilter) => void
  onSearch: (value: string) => void
}

function FilterBar({ review, filter, search, showNeedsFixing, showEmployeeCheck, onFilter, onSearch }: FilterBarProps) {
  const { counts } = review
  const count = (value: number) => <span className="font-mono tabular-nums">{value}</span>

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="filter-bar">
      <ToggleGroup<GridFilter> value={filter} onValueChange={onFilter} aria-label="Show employees">
        <ToggleGroupItem value="all" data-testid="filter-all">
          All {count(review.employees.length)}
        </ToggleGroupItem>
        {showNeedsFixing && (
          <ToggleGroupItem
            value="needs"
            data-testid="filter-needs"
            className={cn(counts.needsFixingDays > 0 && 'bg-rose-50 font-medium text-rose-700 hover:bg-rose-100')}
          >
            Needs fixing {count(counts.needsFixingDays)}
          </ToggleGroupItem>
        )}
        <ToggleGroupItem value="nopunch" data-testid="filter-nopunch">
          No punches this week {count(counts.noPunchEmployees)}
        </ToggleGroupItem>
        <ToggleGroupItem value="unusual" data-testid="filter-unusual">
          Unusual days {count(counts.unusualDays)}
        </ToggleGroupItem>
      </ToggleGroup>

      <label className="relative">
        <span className="sr-only">Search name or ID</span>
        <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search name or ID"
          data-testid="grid-search"
          className="h-8 w-52 rounded-full border border-zinc-200 bg-white pl-8 pr-3 text-xs text-zinc-900 outline-none transition-colors placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
        />
      </label>

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
        <ul className="hidden items-center gap-3 text-[11px] text-zinc-500 xl:flex" aria-label="Legend">
          <li className="flex items-center gap-1">
            <Warning size={12} weight="fill" className="text-amber-600" />
            Unusual
          </li>
          <li className="flex items-center gap-1">
            <span className="font-mono text-rose-600">--:--</span>
            Needs fixing
          </li>
          <li className="flex items-center gap-1">
            <ArrowsMerge size={12} />
            Merged
          </li>
          <li className="flex items-center gap-1">
            <PencilSimple size={12} className="text-sky-600" />
            Edited
          </li>
        </ul>
        {showEmployeeCheck && (
          <Link
            href={`/attendance/${review.weekId}/employee-check`}
            data-testid="employee-check-link"
            className="text-xs text-zinc-600 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
          >
            Employee check
            {review.counts.pendingDecisions > 0 ? ` (${plural(review.counts.pendingDecisions, 'decision')})` : ''}
          </Link>
        )}
      </div>
    </div>
  )
}

// ─── Empty states ─────────────────────────────────────────────────────────────

function EmptyResult({
  filter,
  search,
  onShowAll,
  onClearSearch,
}: {
  filter: GridFilter
  search: string
  onShowAll: () => void
  onClearSearch: () => void
}) {
  const message =
    search.trim() !== ''
      ? `No employee matches "${search.trim()}".`
      : filter === 'needs'
        ? 'Nothing needs fixing.'
        : filter === 'nopunch'
          ? 'Every employee has at least one punch this week.'
          : filter === 'unusual'
            ? 'No unusual days this week.'
            : 'No employees to show.'

  return (
    <div className="flex flex-col items-center px-6 py-16 text-center" data-testid="grid-empty">
      <CheckCircle size={48} className="text-zinc-300" />
      <p className="mt-4 text-sm text-zinc-600">{message}</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4 rounded-xl"
        onClick={search.trim() !== '' ? onClearSearch : onShowAll}
        data-testid="grid-empty-action"
      >
        {search.trim() !== '' ? 'Clear search' : 'Show all employees'}
      </Button>
    </div>
  )
}

// ─── PunchReviewGrid ──────────────────────────────────────────────────────────

/** What a payroll correction needs from outside this feature. */
export interface CorrectionGridActions {
  /** The reason entered on the first step. */
  reason: string | null
  /**
   * "Approve punches". Injected by the page so this feature does not import payroll-correction.
   * On success it redirects to the revised preview, so nothing comes back.
   */
  onApprove: (payrollRunId: string) => Promise<ActionResult<unknown> | undefined>
  /** "Cancel correction", passed on to the banner. */
  onAbandon: (payrollRunId: string) => Promise<ActionResult<unknown>>
}

interface GridBaseProps {
  backHref: string
  backLabel: string
  title: string
}

/** A correction review must come with its actions; a live one must not. */
export type PunchReviewGridProps =
  | (GridBaseProps & { initialReview: LiveReview; correction?: undefined })
  | (GridBaseProps & { initialReview: CorrectionReview; correction: CorrectionGridActions })

/**
 * The punch review screen: the week as a grid you scan, with filters for the exceptions, the day
 * editor beside it, and the approve / reopen actions. The same component serves the live week
 * (editable, or locked once approved) and a payroll correction.
 */
export function PunchReviewGrid(props: PunchReviewGridProps) {
  const { initialReview, backHref, backLabel, title } = props
  const correction = props.correction ?? null
  const router = useRouter()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastFocusKey = useRef<string | null>(null)

  // A correction starts from copied punches, so their edit times aren't saves made in this session.
  const [review, setReview] = useState<PunchReview>(() =>
    initialReview.mode.kind === 'CORRECTION' ? { ...initialReview, lastSavedAt: null } : initialReview,
  )
  const [filter, setFilter] = useState<GridFilter>('all')
  const [search, setSearch] = useState('')
  const [openCell, setOpenCell] = useState<DayTarget | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set())
  const [saveFailed, setSaveFailed] = useState(false)
  const [approveOpen, setApproveOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [changedDays, setChangedDays] = useState<number | null>(null)
  const [lockedFetched, setLockedFetched] = useState<{ key: string; summary: ApprovalSummary } | null>(null)

  const { mode, weekId } = review
  const isCorrection = mode.kind === 'CORRECTION'
  const locked = review.locked
  const effectiveFilter: GridFilter = locked && filter === 'needs' ? 'all' : filter

  // ── Derived rows ────────────────────────────────────────────────────────────

  const visibleEmployees = useMemo(
    () =>
      review.employees.filter(
        (employee) =>
          (matchesFilter(employee, effectiveFilter) && matchesSearch(employee, search)) ||
          pinnedIds.has(employee.employeeId),
      ),
    [review.employees, effectiveFilter, search, pinnedIds],
  )

  const openEmployee = openCell ? review.employees.find((e) => e.employeeId === openCell.employeeId) ?? null : null
  const openDay = openEmployee && openCell ? openEmployee.days.find((d) => d.date === openCell.date) ?? null : null
  const canStepPrevious = openCell ? findStepTarget(visibleEmployees, effectiveFilter, openCell, 'previous') !== null : false
  const canStepNext = openCell ? findStepTarget(visibleEmployees, effectiveFilter, openCell, 'next') !== null : false

  // ── Reloading from the server ───────────────────────────────────────────────

  const reload = useCallback(async () => {
    const res = await getPunchReviewAction(weekId, mode)
    if (res.ok) setReview(res.data)
    return res.ok
  }, [weekId, mode])

  const changedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshChangedDays = useCallback(
    (delay = 0) => {
      if (mode.kind !== 'CORRECTION') return
      if (changedTimer.current) clearTimeout(changedTimer.current)
      changedTimer.current = setTimeout(() => {
        void getApprovalSummaryAction(weekId, mode).then((res) => {
          if (res.ok) setChangedDays(res.data.changedDaysInCorrection ?? 0)
        })
      }, delay)
    },
    [weekId, mode],
  )

  useEffect(() => {
    refreshChangedDays()
    return () => {
      if (changedTimer.current) clearTimeout(changedTimer.current)
    }
  }, [refreshChangedDays])

  // A locked week shows who was left out; that needs the approval summary, which counts rejected employees too.
  const lockedKey = `${weekId}|${review.approvedAt}`
  useEffect(() => {
    if (!locked) return
    let cancelled = false
    void getApprovalSummaryAction(weekId, { kind: 'LIVE' }).then((res) => {
      if (!cancelled && res.ok) setLockedFetched({ key: lockedKey, summary: res.data })
    })
    return () => {
      cancelled = true
    }
  }, [locked, weekId, lockedKey])
  const lockedSummary = locked && lockedFetched?.key === lockedKey ? lockedFetched.summary : null

  // ── The editor ──────────────────────────────────────────────────────────────

  const focusCell = useCallback((key: string | null) => {
    if (!key) return
    requestAnimationFrame(() => cellRefs.current.get(key)?.focus())
  }, [])

  function openDayEditor(employeeId: string, date: ISODate) {
    lastFocusKey.current = cellKey(employeeId, date)
    setOpenCell({ employeeId, date })
    setPinnedIds((previous) => new Set(previous).add(employeeId))
  }

  const closeEditor = useCallback(() => {
    setOpenCell(null)
    setPinnedIds(new Set())
    setSaveFailed(false)
    if (isDesktop) focusCell(lastFocusKey.current)
  }, [focusCell, isDesktop])

  // The editor's save was refused because the day moved on: reload the review and hand back the latest view,
  // null if the reload failed, or 'gone' (after closing the editor) if the employee left the review.
  const reloadDay = useCallback(
    async (employeeId: string, date: ISODate): Promise<DayReload> => {
      const res = await getPunchReviewAction(weekId, mode)
      if (!res.ok) return null
      setReview(res.data)
      const day = res.data.employees.find((e) => e.employeeId === employeeId)?.days.find((d) => d.date === date) ?? null
      if (!day) {
        closeEditor()
        toast.error("That employee is no longer in this week's review.")
        return 'gone'
      }
      return day
    },
    [weekId, mode, closeEditor],
  )

  function stepEditor(direction: 'previous' | 'next') {
    if (!openCell) return
    const target = findStepTarget(visibleEmployees, effectiveFilter, openCell, direction)
    if (target) openDayEditor(target.employeeId, target.date)
  }

  // Keep the open cell in view beside the editor.
  useEffect(() => {
    if (!openCell) return
    cellRefs.current.get(cellKey(openCell.employeeId, openCell.date))?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [openCell])

  function handleSaved(employeeId: string, date: ISODate, result: SavePunchEditResult) {
    setReview((current) => applySaveResult(current, employeeId, date, result))
    refreshChangedDays(600)
  }

  // ── Approve and reopen ──────────────────────────────────────────────────────

  async function confirmApprove(): Promise<ApproveResult | undefined> {
    if (mode.kind === 'CORRECTION') {
      // A correction review never falls through to the live approval, even if the actions are missing.
      if (!correction) return { ok: false, error: "This correction can't be approved from this page. Reload and try again." }
      // On success the action redirects to the revised preview, so nothing comes back.
      const res = await correction.onApprove(mode.payrollRunId)
      if (!res) return undefined
      return res.ok ? { ok: true } : { ok: false, error: res.error, code: res.code }
    }

    const res = await approveWeekAction(weekId)
    if (!res.ok) return { ok: false, error: res.error, code: res.code }
    toast.success('Week approved', {
      action: { label: 'Go to payroll', onClick: () => router.push(`/payroll/generate/${weekId}`) },
    })
    await reload()
    setApproveOpen(false)
    return { ok: true }
  }

  async function confirmReopen(): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await reopenWeekAction(weekId)
    if (!res.ok) {
      if (res.code === 'PAYROLL_ALREADY_APPROVED') {
        await reload()
        return { ok: false, error: 'Payroll for this week was approved. Reopen is no longer available.' }
      }
      return { ok: false, error: res.error }
    }
    toast.success('Week reopened')
    await reload()
    setReopenOpen(false)
    return { ok: true }
  }

  function showNeedsFixing() {
    setApproveOpen(false)
    setSearch('')
    setFilter('needs')
    void reload()
  }

  function showEmployee(employeeCode: string) {
    setApproveOpen(false)
    setFilter('all')
    setSearch(employeeCode)
  }

  // ── Header pieces ───────────────────────────────────────────────────────────

  const blockerLines = describeBlockers(review)
  const approveLabel = isCorrection ? 'Approve punches' : 'Approve week'
  const approveDisabled = !review.approval.canApprove

  const approveButton = (
    <button
      type="button"
      disabled={approveDisabled}
      onClick={() => setApproveOpen(true)}
      data-testid="approve-week-button"
      className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-emerald-600/40 disabled:active:scale-100"
    >
      {approveLabel}
    </button>
  )

  const savedText = saveFailed ? (
    <span className="text-xs text-rose-600" data-testid="saved-status">
      Not saved
    </span>
  ) : review.lastSavedAt ? (
    <span className="text-xs text-zinc-500" data-testid="saved-status">
      Saved {formatIstTime(review.lastSavedAt)}
    </span>
  ) : null

  const payrollApproved = review.payroll.status !== 'NOT_GENERATED'
  const leftOutCount = lockedSummary ? lockedSummary.leftOut.length : null
  const includedCount = review.employees.filter((e) => e.totalRegularHours + e.totalOvertimeHours > 0).length

  return (
    <div
      className="flex flex-col gap-3 max-md:pb-20 md:max-lg:h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-3rem)]"
      data-testid="punch-review"
      data-status={review.status}
      data-mode={mode.kind}
      data-locked={locked || undefined}
    >
      {/* Header: one row, so the grid keeps its height */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 md:min-h-12">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-800"
            data-testid="back-link"
          >
            <ArrowLeft size={14} />
            {backLabel}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          <span className="font-mono text-sm tabular-nums text-zinc-500" data-testid="week-label">
            {formatWeekLabel(review.week)}
          </span>
          {isCorrection ? (
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Revision {mode.revisionNumber} current
            </span>
          ) : (
            <WeekStatusBadge status={review.status} />
          )}
        </div>

        <div
          className="flex items-center gap-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:justify-end max-md:border-t max-md:border-zinc-200 max-md:bg-white max-md:p-3"
          data-testid="review-actions"
        >
          {!locked && savedText}
          {!locked && !isCorrection && review.status === 'REVIEW' && review.counts.needsFixingDays > 0 && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setFilter('needs')
              }}
              className="text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
              data-testid="needs-fixing-link"
            >
              {plural(review.counts.needsFixingDays, 'day')} Needs fixing
            </button>
          )}
          {!locked && (isCorrection || review.status === 'REVIEW') && (
            <Tooltip
              content={
                approveDisabled && blockerLines.length > 0 ? (
                  <span className="block space-y-0.5" data-testid="approve-blockers">
                    {blockerLines.map((line) => (
                      <span key={line} className="block">
                        {line}
                      </span>
                    ))}
                  </span>
                ) : undefined
              }
              side="bottom"
              align="end"
            >
              <span tabIndex={approveDisabled ? 0 : undefined} className="inline-block rounded-xl">
                {approveButton}
              </span>
            </Tooltip>
          )}
          {locked && !payrollApproved && (
            <>
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={() => setReopenOpen(true)}
                data-testid="reopen-week-button"
              >
                <ArrowCounterClockwise size={14} />
                Reopen
              </Button>
              <Link
                href={`/payroll/generate/${weekId}`}
                data-testid="go-to-payroll"
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]"
              >
                Go to payroll
                <ArrowRight size={14} weight="bold" />
              </Link>
            </>
          )}
          {locked && payrollApproved && review.payroll.payrollRunId && (
            <Link
              href={`/payroll/run/${review.payroll.payrollRunId}`}
              data-testid="open-payroll-run"
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]"
            >
              Open payroll run
              <ArrowRight size={14} weight="bold" />
            </Link>
          )}
        </div>
      </header>

      {mode.kind === 'CORRECTION' && correction && (
        <CorrectionBanner
          payrollRunId={mode.payrollRunId}
          onAbandon={correction.onAbandon}
          revisionNumber={mode.revisionNumber}
          reason={correction.reason}
          changedDays={changedDays}
        />
      )}

      {locked && (
        <div className="shrink-0 space-y-1.5" data-testid="locked-info">
          <p className="text-xs text-zinc-500" data-testid="approved-summary">
            {review.approvedAt ? `Approved ${formatIstDateTime(review.approvedAt)}` : 'Approved'} ·{' '}
            {plural(lockedSummary ? lockedSummary.employeeCount : includedCount, 'employee')} ·{' '}
            <span className="font-mono tabular-nums">{formatHoursTotal(review.totals.regular)}</span> regular ·{' '}
            <span className="font-mono tabular-nums">{formatHoursTotal(review.totals.overtime)}</span> overtime
            {leftOutCount !== null ? ` · ${leftOutCount} left out` : ''}
          </p>
          {payrollApproved && (
            <p className="flex items-start gap-2.5 text-sm text-zinc-500" data-testid="payroll-lock-note">
              <Lock size={16} className="mt-0.5 shrink-0 text-zinc-500" />
              <span>
                Payroll for this week is approved. To change punches, use Correct on the payroll run.
                {review.payroll.activeCorrectionId && review.payroll.payrollRunId && (
                  <>
                    {' '}
                    A correction is in progress.{' '}
                    <Link
                      href={`/payroll/run/${review.payroll.payrollRunId}/correct`}
                      className="font-medium text-zinc-700 underline underline-offset-2"
                      data-testid="correction-in-progress-link"
                    >
                      Open it
                    </Link>
                    .
                  </>
                )}
              </span>
            </p>
          )}
        </div>
      )}

      <div className="shrink-0">
        <FilterBar
          review={review}
          filter={effectiveFilter}
          search={search}
          showNeedsFixing={!locked}
          showEmployeeCheck={!locked && !isCorrection}
          onFilter={setFilter}
          onSearch={setSearch}
        />
      </div>

      {visibleEmployees.length === 0 ? (
        <EmptyResult
          filter={effectiveFilter}
          search={search}
          onShowAll={() => setFilter('all')}
          onClearSearch={() => setSearch('')}
        />
      ) : isDesktop ? (
        <div
          className="relative min-h-0 flex-1 overflow-auto border-t border-zinc-200/60 max-md:hidden"
          style={{
            scrollPaddingLeft: 168,
            scrollPaddingRight: openCell ? EDITOR_WIDTH : 88,
            scrollPaddingTop: 32,
            scrollPaddingBottom: 40,
          }}
          data-testid="grid-scroller"
        >
          <PunchGridTable
            review={review}
            employees={visibleEmployees}
            filter={effectiveFilter}
            openCell={openCell}
            cellRefs={cellRefs}
            onOpenDay={openDayEditor}
          />
        </div>
      ) : (
        <PunchMobileList employees={visibleEmployees} onOpenDay={openDayEditor} />
      )}

      <DayEditorSheet
        open={openCell !== null}
        onClose={closeEditor}
        weekId={weekId}
        mode={mode}
        employee={openEmployee}
        day={openDay}
        readOnly={locked}
        canStepPrevious={canStepPrevious}
        canStepNext={canStepNext}
        onStep={stepEditor}
        onSaved={handleSaved}
        onSaveFailed={setSaveFailed}
        onDayChanged={reloadDay}
      />

      <ApproveWeekDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        weekId={weekId}
        weekLabel={formatWeekLabel(review.week)}
        mode={mode}
        onConfirm={confirmApprove}
        onShowEmployee={showEmployee}
        onShowNeedsFixing={showNeedsFixing}
      />

      <ReopenWeekDialog open={reopenOpen} onOpenChange={setReopenOpen} onConfirm={confirmReopen} />
    </div>
  )
}
