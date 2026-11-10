'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Info,
  Lock,
  SpinnerGap,
  UserPlus,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  getEmployeeCheckAction,
  ignoreCodeAction,
  matchCodeAction,
  rematchWeekCodesAction,
  setEmployeeDecisionAction,
} from '../actions/attendance-sync.actions'
import { formatDate, formatHours, plural } from '../lib/format'
import { formatWeekLabel } from '../lib/week'
import type {
  AttendanceWeekStatus,
  EmployeeCheck as EmployeeCheckData,
  EmployeeDecisionValue,
} from '../types/attendance-sync.types'
import { EmployeeCombobox } from './EmployeeCombobox'

type CheckCode = EmployeeCheckData['codes'][number]
type CheckDecision = EmployeeCheckData['decisions'][number]

const LABEL = 'text-xs font-medium uppercase tracking-wider text-zinc-500'
const OUTLINE_LINK =
  'inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkHref(weekId: string) {
  return `/attendance/${weekId}/employee-check`
}

function addNewHref(weekId: string, code: CheckCode): string {
  const params = new URLSearchParams({ returnTo: checkHref(weekId), code: code.empCode })
  if (code.empName) params.set('name', code.empName)
  return `/employees/new?${params.toString()}`
}

function editHref(weekId: string, employeeDbId: string): string {
  return `/employees/${employeeDbId}/edit?${new URLSearchParams({ returnTo: checkHref(weekId) }).toString()}`
}

/** "Needs an Employee ID ending in 999" for a numeric code. */
function unknownHint(empCode: string): string {
  return /^\d+$/.test(empCode)
    ? `Needs an Employee ID ending in ${parseInt(empCode, 10)}`
    : "This code isn't a number, so it can't match an Employee ID"
}

function remainingText(data: EmployeeCheckData): string {
  const codes = data.counts.unknown + data.counts.duplicate
  const parts: string[] = []
  if (codes > 0) parts.push(plural(codes, 'code'))
  if (data.counts.decisionsLeft > 0) parts.push(plural(data.counts.decisionsLeft, 'decision'))
  return parts.length > 0 ? `${parts.join(' and ')} left` : 'Everything is resolved'
}

/** Recompute the decision counts after a click, so the Continue gate reacts straight away. */
function withDecision(data: EmployeeCheckData, employeeId: string, decision: EmployeeDecisionValue | null): EmployeeCheckData {
  const decisions = data.decisions.map((d) => (d.employeeId === employeeId ? { ...d, decision } : d))
  const decisionsLeft = decisions.filter((d) => d.decision === null).length
  return {
    ...data,
    decisions,
    counts: { ...data.counts, decisionsLeft },
    complete: data.codes.length === 0 && decisionsLeft === 0,
  }
}

// ─── Summary strip ────────────────────────────────────────────────────────────

function SummaryStrip({ counts }: { counts: EmployeeCheckData['counts'] }) {
  const cells: Array<{ id: string; label: string; value: number; alert: boolean }> = [
    { id: 'codes-in-sync', label: 'Codes in sync', value: counts.codesInSync, alert: false },
    { id: 'matched', label: 'Matched', value: counts.matched, alert: false },
    { id: 'unknown', label: 'Unknown', value: counts.unknown, alert: counts.unknown > 0 },
    { id: 'duplicate', label: 'Duplicate', value: counts.duplicate, alert: counts.duplicate > 0 },
    { id: 'decisions-left', label: 'Decisions left', value: counts.decisionsLeft, alert: counts.decisionsLeft > 0 },
  ]

  return (
    <dl className="grid grid-cols-2 gap-y-4 border-b border-t border-zinc-200/60 py-4 sm:flex sm:gap-y-0 sm:divide-x sm:divide-zinc-200">
      {cells.map((cell) => (
        <div key={cell.id} className="sm:flex-1 sm:px-5 sm:first:pl-0">
          <dt className={LABEL}>{cell.label}</dt>
          <dd
            data-testid={`summary-${cell.id}`}
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${cell.alert ? 'text-rose-600' : 'text-zinc-900'}`}
          >
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ─── One code to fix ──────────────────────────────────────────────────────────

interface CodeRowProps {
  code: CheckCode
  weekId: string
  employees: EmployeeCheckData['allEmployees']
  disabled: boolean
  busy: boolean
  confirmingIgnore: boolean
  onMatch: (employeeDbId: string) => void
  onAskIgnore: () => void
  onCancelIgnore: () => void
  onIgnore: () => void
}

function CodeRow({
  code,
  weekId,
  employees,
  disabled,
  busy,
  confirmingIgnore,
  onMatch,
  onAskIgnore,
  onCancelIgnore,
  onIgnore,
}: CodeRowProps) {
  const isDuplicate = code.status === 'DUPLICATE'
  const lock = disabled || busy

  return (
    <li
      data-testid={`code-row-${code.empCode}`}
      data-status={code.status}
      className="grid gap-x-6 gap-y-3 border-b border-zinc-100 py-4 md:grid-cols-[5rem_11rem_8rem_1fr]"
    >
      <div>
        <p className={`${LABEL} md:hidden`}>Code</p>
        <p className="font-mono text-sm font-medium text-zinc-900">{code.empCode}</p>
      </div>
      <div>
        <p className={`${LABEL} md:hidden`}>Name in eTimeOffice</p>
        <p className="text-sm text-zinc-600">{code.empName ?? '—'}</p>
      </div>
      <div>
        <p className={`${LABEL} md:hidden`}>Punches</p>
        <p className="text-sm text-zinc-600">
          {plural(code.punchCount, 'punch', 'punches')}, {plural(code.dayCount, 'day')}
        </p>
      </div>

      <div className="min-w-0 space-y-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm text-rose-600">
            <XCircle size={14} weight="fill" className="shrink-0 text-rose-500" />
            {isDuplicate ? `Matches ${code.candidates.length} employees` : 'Matches no employee'}
          </p>
          {!isDuplicate && <p className="mt-0.5 text-xs text-zinc-500">{unknownHint(code.empCode)}</p>}
        </div>

        {isDuplicate && (
          <ul className="space-y-1.5">
            {code.candidates.map((candidate) => (
              <li key={candidate.id} className="flex items-center gap-3">
                <span className="font-mono text-xs text-zinc-700">{candidate.employeeId}</span>
                <span className="truncate text-sm text-zinc-600">{candidate.employeeName}</span>
                <Link
                  href={editHref(weekId, candidate.id)}
                  className={`${OUTLINE_LINK} ml-auto ${lock ? 'pointer-events-none opacity-50' : ''}`}
                  aria-disabled={lock}
                  tabIndex={lock ? -1 : undefined}
                  data-testid={`edit-id-${candidate.employeeId}`}
                >
                  Edit ID
                </Link>
              </li>
            ))}
          </ul>
        )}

        {confirmingIgnore ? (
          <div
            role="alertdialog"
            aria-label={`Ignore code ${code.empCode}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200/60 bg-amber-50 px-3 py-2"
          >
            <p className="text-xs text-amber-800">
              Leave {plural(code.punchCount, 'punch', 'punches')} out of payroll? The code stays ignored in future weeks.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="rounded-xl"
                onClick={onCancelIgnore}
                disabled={busy}
                data-testid={`cancel-ignore-${code.empCode}`}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="rounded-xl bg-zinc-900 text-white hover:bg-zinc-800"
                onClick={onIgnore}
                disabled={busy}
                data-testid={`confirm-ignore-${code.empCode}`}
              >
                {busy ? <SpinnerGap size={14} className="animate-spin" /> : null}
                Ignore code
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {!isDuplicate && (
              <Link
                href={addNewHref(weekId, code)}
                className={`${OUTLINE_LINK} ${lock ? 'pointer-events-none opacity-50' : ''}`}
                aria-disabled={lock}
                tabIndex={lock ? -1 : undefined}
                data-testid={`add-new-employee-${code.empCode}`}
              >
                <UserPlus size={14} weight="bold" />
                Add as new employee
              </Link>
            )}
            <EmployeeCombobox
              employees={employees}
              selectedId={null}
              onSelect={onMatch}
              disabled={lock}
              placeholder="Match to existing employee"
              aria-label={`Match code ${code.empCode} to an existing employee`}
              testId={`match-existing-${code.empCode}`}
              className="w-60"
            />
            <Button
              size="sm"
              variant="ghost"
              className="rounded-xl text-zinc-600"
              onClick={onAskIgnore}
              disabled={lock}
              data-testid={`ignore-code-${code.empCode}`}
            >
              Ignore this code
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

// ─── One decision ─────────────────────────────────────────────────────────────

function DecisionRow({
  decision,
  disabled,
  onDecide,
}: {
  decision: CheckDecision
  disabled: boolean
  onDecide: (value: EmployeeDecisionValue) => void
}) {
  const reason =
    decision.reason === 'INACTIVE'
      ? 'Inactive'
      : `Resigned${decision.resignedOn ? ` ${formatDate(decision.resignedOn)}` : ''}`

  return (
    <li
      data-testid={`decision-row-${decision.employeeCode}`}
      data-decision={decision.decision ?? 'NONE'}
      className="grid items-center gap-x-6 gap-y-2 border-b border-zinc-100 py-4 md:grid-cols-[1fr_12rem_1fr_11rem]"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-900">{decision.employeeName}</p>
        <p className="font-mono text-xs text-zinc-500">{decision.employeeCode}</p>
      </div>
      <p className="text-sm text-zinc-600">{reason}</p>
      <p className="text-sm text-zinc-600">
        {plural(decision.dayCount, 'day')},{' '}
        <span className="font-mono tabular-nums">{formatHours(decision.regularHours)}</span> reg,{' '}
        <span className="font-mono tabular-nums">{formatHours(decision.overtimeHours)}</span> OT
      </p>
      <div className="flex gap-2 md:justify-end" role="group" aria-label={`Decision for ${decision.employeeName}`}>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={decision.decision === 'APPROVED'}
          disabled={disabled}
          onClick={() => onDecide('APPROVED')}
          data-testid={`decision-approve-${decision.employeeCode}`}
          className={
            decision.decision === 'APPROVED'
              ? 'rounded-xl border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:text-white'
              : 'rounded-xl'
          }
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant={decision.decision === 'REJECTED' ? 'destructive' : 'outline'}
          aria-pressed={decision.decision === 'REJECTED'}
          disabled={disabled}
          onClick={() => onDecide('REJECTED')}
          data-testid={`decision-reject-${decision.employeeCode}`}
          className="rounded-xl"
        >
          Reject
        </Button>
      </div>
    </li>
  )
}

// ─── EmployeeCheck ────────────────────────────────────────────────────────────

interface EmployeeCheckProps {
  initial: EmployeeCheckData
  /** Decisions and codes can only change while the week is in review. */
  status: AttendanceWeekStatus
}

export function EmployeeCheck({ initial, status }: EmployeeCheckProps) {
  const { weekId } = initial
  const readOnly = status !== 'REVIEW'

  const [data, setData] = useState(initial)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmIgnore, setConfirmIgnore] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(initial.codes.length > 0 && !readOnly)

  const refresh = useCallback(async () => {
    const res = await getEmployeeCheckAction(weekId)
    if (res.ok) setData(res.data)
    return res.ok
  }, [weekId])

  // Coming back from fixing an Employee ID: re-match the open codes and say which ones cleared.
  const rematched = useRef(false)
  useEffect(() => {
    if (rematched.current || readOnly || initial.codes.length === 0) return
    rematched.current = true
    void (async () => {
      let res: Awaited<ReturnType<typeof rematchWeekCodesAction>> | null = null
      try {
        res = await rematchWeekCodesAction(weekId)
      } catch {
        // Reported below, after the reload.
      }

      // Always reload: a run that failed part-way may still have linked some codes (each commits on its
      // own), so the page cannot trust what it was rendered with.
      try {
        await refresh()
      } catch {
        // The page keeps what it has; the error below says the rematch did not finish.
      }

      if (!res) setError("Couldn't reach the server. Try again.")
      else if (!res.ok) setError(res.error)
      else {
        for (const match of res.data.matched) {
          toast.success(`Code ${match.empCode} matched to ${match.employeeCode}`)
        }
      }
      setRechecking(false)
    })()
  }, [weekId, readOnly, initial.codes.length, refresh])

  async function run(key: string, task: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusyKey(key)
    setError(null)
    try {
      const result = await task()
      if (!result.ok) setError(result.error)
      return result.ok
    } catch {
      setError("Couldn't reach the server. Try again.")
      return false
    } finally {
      setBusyKey(null)
    }
  }

  async function handleMatch(code: CheckCode, employeeDbId: string) {
    const target = data.allEmployees.find((e) => e.id === employeeDbId)
    const done = await run(code.empCode, async () => {
      const res = await matchCodeAction(weekId, code.empCode, employeeDbId)
      if (res.ok) toast.success(`Code ${code.empCode} matched to ${target?.employeeId ?? 'the employee'}`, {
        description: 'Saved for future weeks too.',
      })
      return res
    })
    if (done) await refresh()
  }

  async function handleIgnore(code: CheckCode) {
    const done = await run(code.empCode, async () => {
      const res = await ignoreCodeAction(weekId, code.empCode)
      if (res.ok) toast.success(`Code ${code.empCode} ignored`, { description: 'It stays ignored in future weeks.' })
      return res
    })
    setConfirmIgnore(null)
    if (done) await refresh()
  }

  async function handleDecide(decision: CheckDecision, value: EmployeeDecisionValue) {
    const previous = data
    setData((current) => withDecision(current, decision.employeeId, value))
    const done = await run(decision.employeeId, () => setEmployeeDecisionAction(weekId, decision.employeeId, value))
    if (!done) setData(previous)
    else await refresh()
  }

  const unresolved = data.codes.length > 0
  const hasDecisions = data.decisions.length > 0

  return (
    <div data-testid="employee-check">
      <Link
        href="/attendance"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-800"
      >
        <ArrowLeft size={14} />
        Back to attendance
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Employee check</h1>
      <p className="mt-1 text-sm text-zinc-500">{formatWeekLabel(data.week)}</p>

      <div className="mt-6">
        <SummaryStrip counts={data.counts} />
        {rechecking && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500" role="status">
            <SpinnerGap size={12} className="animate-spin motion-reduce:animate-none" />
            Rechecking codes…
          </p>
        )}
      </div>

      {readOnly && (
        <p className="mt-6 flex items-start gap-2.5 text-sm text-zinc-500" data-testid="employee-check-locked">
          <Lock size={16} className="mt-0.5 shrink-0 text-zinc-500" />
          This week is approved. Reopen it to change codes or decisions.
        </p>
      )}

      {error && (
        <div
          role="alert"
          data-testid="employee-check-error"
          className="mt-6 flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50 p-4"
        >
          <WarningCircle size={18} className="mt-0.5 shrink-0 text-rose-500" />
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      {data.complete && !readOnly && (
        <div
          role="status"
          data-testid="employee-check-resolved"
          className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50 p-4"
        >
          <CheckCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-emerald-500" />
          <p className="text-sm text-emerald-800">All codes matched and all decisions made.</p>
        </div>
      )}

      {unresolved && (
        <section className="mt-8" aria-labelledby="codes-heading">
          <h2 id="codes-heading" className="mb-3 text-sm font-medium text-zinc-900">
            Codes to fix
          </h2>
          <div className="hidden gap-x-6 border-b border-zinc-200/60 pb-2 md:grid md:grid-cols-[5rem_11rem_8rem_1fr]">
            <span className={LABEL}>Code</span>
            <span className={LABEL}>Name in eTimeOffice</span>
            <span className={LABEL}>Punches</span>
            <span className={LABEL}>Problem and fix</span>
          </div>
          <ul>
            {data.codes.map((code) => (
              <CodeRow
                key={code.empCode}
                code={code}
                weekId={weekId}
                employees={data.allEmployees}
                disabled={readOnly}
                busy={busyKey === code.empCode}
                confirmingIgnore={confirmIgnore === code.empCode}
                onMatch={(employeeDbId) => void handleMatch(code, employeeDbId)}
                onAskIgnore={() => setConfirmIgnore(code.empCode)}
                onCancelIgnore={() => setConfirmIgnore(null)}
                onIgnore={() => void handleIgnore(code)}
              />
            ))}
          </ul>
          <p className="mt-4 flex items-start gap-2 text-sm text-zinc-500">
            <Info size={16} className="mt-0.5 shrink-0 text-zinc-500" />
            Names are shown for reference only. Codes match on the digits at the end of the Employee ID. A match or an
            ignored code is saved and applies to future weeks.
          </p>
        </section>
      )}

      {data.ignoredCodes.length > 0 && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8" aria-labelledby="ignored-heading">
          <h2 id="ignored-heading" className="text-sm font-medium text-zinc-900">
            Ignored codes
          </h2>
          <p className="mt-1 text-sm text-zinc-500">Their punches are left out of payroll.</p>
          <ul className="mt-3">
            {data.ignoredCodes.map((code) => (
              <li
                key={code.empCode}
                data-testid={`ignored-code-${code.empCode}`}
                className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-zinc-100 py-3"
              >
                <span className="w-20 font-mono text-sm font-medium text-zinc-900">{code.empCode}</span>
                <span className="text-sm text-zinc-600">{code.empName ?? '—'}</span>
                <span className="text-sm text-zinc-500">{plural(code.punchCount, 'punch', 'punches')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasDecisions && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8" aria-labelledby="decisions-heading">
          <h2 id="decisions-heading" className="text-sm font-medium text-zinc-900">
            Inactive and resigned employees
          </h2>
          <p className="mt-1 text-sm text-zinc-500">Include or leave out of this week&apos;s payroll.</p>
          <div className="mt-3 hidden gap-x-6 border-b border-zinc-200/60 pb-2 md:grid md:grid-cols-[1fr_12rem_1fr_11rem]">
            <span className={LABEL}>Employee</span>
            <span className={LABEL}>Reason</span>
            <span className={LABEL}>Punches this week</span>
            <span className={`${LABEL} text-right`}>Decision</span>
          </div>
          <ul>
            {data.decisions.map((decision) => (
              <DecisionRow
                key={decision.employeeId}
                decision={decision}
                disabled={readOnly}
                onDecide={(value) => void handleDecide(decision, value)}
              />
            ))}
          </ul>
        </section>
      )}

      {!unresolved && !hasDecisions && data.ignoredCodes.length === 0 && (
        <p className="mt-8 text-sm text-zinc-500">No codes or employees need a decision this week.</p>
      )}

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200/60 pt-6">
        <p className="text-sm text-zinc-500" data-testid="employee-check-remaining">
          {remainingText(data)}
        </p>
        {data.complete ? (
          <Link
            href={`/attendance/${weekId}/review`}
            data-testid="employee-check-continue"
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]"
          >
            Continue to punch review
            <ArrowRight size={14} weight="bold" />
          </Link>
        ) : (
          <span
            aria-disabled="true"
            data-testid="employee-check-continue"
            title={remainingText(data)}
            className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-emerald-600/40 px-5 py-2.5 text-sm font-medium text-white"
          >
            Continue to punch review
            <ArrowRight size={14} weight="bold" />
          </span>
        )}
      </div>
    </div>
  )
}
