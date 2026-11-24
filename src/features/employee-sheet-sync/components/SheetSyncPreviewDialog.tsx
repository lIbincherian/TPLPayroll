'use client'

import { useEffect, useState } from 'react'
import { CaretRight, CheckCircle, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { applySheetSyncAction, previewSheetSyncAction } from '../actions/employee-sheet-sync.actions'
import {
  FIELD_LABELS,
  MASKED_IN_PREVIEW,
  describeSkip,
  describeWarning,
  plural,
} from '../lib/labels'
import type { FieldValue, SheetOwnedField, SyncReport } from '../types/employee-sheet-sync.types'

const LABEL = 'text-xs font-medium uppercase tracking-wider text-zinc-500'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; plan: SyncReport; planHash: string; stale: boolean }
  | { kind: 'applied'; report: SyncReport }

function hasChanges(plan: SyncReport): boolean {
  return plan.creates.length > 0 || plan.updates.length > 0
}

function showValue(field: SheetOwnedField, value: FieldValue): string {
  if (value === null) return '(empty)'
  return MASKED_IN_PREVIEW.has(field) ? 'set' : value
}

// ─── Summary strip ────────────────────────────────────────────────────────────

function Summary({ plan }: { plan: SyncReport }) {
  const cells = [
    { id: 'created', label: 'New', value: plan.creates.length },
    { id: 'updated', label: 'Changed', value: plan.updates.length },
    { id: 'unchanged', label: 'Unchanged', value: plan.unchangedCount },
    { id: 'skipped', label: 'Skipped', value: plan.skips.length },
    { id: 'warnings', label: 'Warnings', value: plan.warnings.length },
  ]
  return (
    <dl className="grid grid-cols-5 gap-3 border-b border-t border-zinc-200/60 py-4" data-testid="sheet-sync-summary">
      {cells.map((cell) => (
        <div key={cell.id}>
          <dt className={LABEL}>{cell.label}</dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900" data-testid={`sheet-sync-${cell.id}`}>
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function Section({
  id,
  title,
  count,
  defaultOpen,
  children,
}: {
  id: string
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b border-zinc-100 py-3" data-testid={`sheet-sync-section-${id}`}>
      <CollapsibleTrigger>
        <CaretRight size={12} className="transition-transform group-data-[panel-open]/collapsible:rotate-90 motion-reduce:transition-none" aria-hidden />
        {title} <span className="font-mono tabular-nums text-zinc-500">({count})</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 max-h-56 overflow-y-auto">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

function PlanSections({ plan }: { plan: SyncReport }) {
  return (
    <div>
      <Section id="creates" title="New employees" count={plan.creates.length} defaultOpen>
        <ul className="divide-y divide-zinc-100">
          {plan.creates.map((c) => (
            <li key={c.rowNumber} className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-zinc-900">{c.fields.employeeName}</span>
              <span className="font-mono text-xs text-zinc-500">{c.employeeId}</span>
              <span className="font-mono text-xs tabular-nums text-zinc-600">₹{c.salary}</span>
              <span className="w-16 text-right text-xs text-zinc-500">{c.isActive ? 'Active' : 'Inactive'}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="updates" title="Field changes" count={plan.updates.length} defaultOpen={plan.creates.length === 0}>
        <ul className="space-y-3">
          {plan.updates.map((u) => (
            <li key={u.employeeDbId} className="px-1 text-sm">
              <p className="text-zinc-900">
                {u.employeeName} <span className="font-mono text-xs text-zinc-500">{u.employeeId}</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                {u.changes.map((change) => (
                  <li key={change.field} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="w-40 shrink-0 text-zinc-500">{FIELD_LABELS[change.field]}</span>
                    <span className="break-all text-zinc-600">
                      {showValue(change.field, change.old)} <span aria-label="changes to">→</span>{' '}
                      <span className="font-medium text-zinc-900">{showValue(change.field, change.new)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="skips" title="Skipped rows" count={plan.skips.length}>
        <ul className="divide-y divide-zinc-100">
          {plan.skips.map((s) => (
            <li key={s.rowNumber} className="flex gap-3 px-1 py-1.5 text-sm">
              <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-zinc-500">Row {s.rowNumber}</span>
              <span className="min-w-0 flex-1">
                {s.name && <span className="text-zinc-900">{s.name} </span>}
                <span className="text-zinc-600">{describeSkip(s)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="warnings" title="Warnings" count={plan.warnings.length}>
        <ul className="divide-y divide-zinc-100">
          {plan.warnings.map((w, i) => (
            <li key={`${w.kind}-${w.rowNumber}-${i}`} className="flex gap-3 px-1 py-1.5 text-sm">
              <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-zinc-500">Row {w.rowNumber}</span>
              <span className="min-w-0 flex-1 text-zinc-600">
                {w.employeeId && <span className="font-mono text-xs text-zinc-900">{w.employeeId} </span>}
                {describeWarning(w)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="app-only" title="In the app but not in the sheet" count={plan.appOnly.length}>
        <p className="mb-1 px-1 text-xs text-zinc-500">These employees are never changed by the sync.</p>
        <ul className="divide-y divide-zinc-100">
          {plan.appOnly.map((e) => (
            <li key={e.employeeDbId} className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-zinc-900">{e.employeeName}</span>
              <span className="font-mono text-xs text-zinc-500">{e.employeeId}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

// ─── Dialog body: mounted fresh each time the dialog opens ────────────────────

function Body({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void previewSheetSyncAction()
      .then((res) => {
        if (cancelled) return
        setState(
          res.ok
            ? { kind: 'ready', plan: res.data.plan, planHash: res.data.planHash, stale: false }
            : { kind: 'failed', message: res.error },
        )
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'failed', message: "Couldn't reach the server. Nothing was changed." })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleApply() {
    if (state.kind !== 'ready') return
    setApplying(true)
    setApplyError(null)
    try {
      const res = await applySheetSyncAction({ planHash: state.planHash })
      if (!res.ok) {
        setApplyError(res.error)
      } else if (res.data.status === 'STALE') {
        setState({ kind: 'ready', plan: res.data.plan, planHash: res.data.planHash, stale: true })
      } else {
        setState({ kind: 'applied', report: res.data.report })
        onApplied()
      }
    } catch {
      setApplyError("Couldn't reach the server. Nothing was changed.")
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync from sheet</DialogTitle>
        <DialogDescription>
          {state.kind === 'applied'
            ? 'The sheet was applied.'
            : 'Review what the Employee Master sheet will change. Nothing is written until you apply.'}
        </DialogDescription>
      </DialogHeader>

      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-sm text-zinc-500" role="status" data-testid="sheet-sync-loading">
          <SpinnerGap size={16} className="animate-spin motion-reduce:animate-none" aria-hidden />
          Reading the sheet…
        </div>
      )}

      {state.kind === 'failed' && (
        <div role="alert" data-testid="sheet-sync-error" className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50 p-3">
          <WarningCircle size={16} className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
          <p className="text-sm text-rose-700">{state.message} Nothing was changed.</p>
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          {state.stale && (
            <div role="status" data-testid="sheet-sync-stale" className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200/60 bg-amber-50 p-3">
              <WarningCircle size={16} className="mt-0.5 shrink-0 text-amber-600" aria-hidden />
              <p className="text-sm text-amber-800">
                The sheet or the app changed since you opened this preview. Nothing was written. Review the new changes and apply again.
              </p>
            </div>
          )}
          {state.plan.mode === 'FIXTURE' && (
            <div role="note" data-testid="sheet-sync-fixture" className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200/60 bg-amber-50 p-3">
              <WarningCircle size={16} className="mt-0.5 shrink-0 text-amber-600" aria-hidden />
              <p className="text-sm text-amber-800">
                Sample data: Google Sheets isn&apos;t configured, so this preview uses the built-in sample sheet (local database only).
              </p>
            </div>
          )}
          <Summary plan={state.plan} />
          {!hasChanges(state.plan) && (
            <p className="pt-3 text-sm text-zinc-600" data-testid="sheet-sync-nothing">
              No employees to add or change.
            </p>
          )}
          <PlanSections plan={state.plan} />
        </>
      )}

      {state.kind === 'applied' && (
        <div data-testid="sheet-sync-success">
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50 p-3">
            <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
            <p className="text-sm text-emerald-800">
              {plural(state.report.creates.length, 'employee')} added, {plural(state.report.updates.length, 'employee')} updated
              {state.report.skips.length > 0 ? `, ${plural(state.report.skips.length, 'row')} skipped` : ''}.
            </p>
          </div>
          <p className="mt-3 text-sm text-zinc-500">The nightly sync now runs automatically while the sync stays on in Settings.</p>
        </div>
      )}

      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-4 border-t border-zinc-100 bg-white px-6 py-4">
        {applyError && (
          <div role="alert" data-testid="sheet-sync-apply-error" className="mb-4 flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50 p-3">
            <WarningCircle size={16} className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
            <p className="text-sm text-rose-700">Couldn&apos;t apply. {applyError} Nothing was changed.</p>
          </div>
        )}
        <DialogFooter>
          {state.kind === 'applied' ? (
            <Button className="rounded-xl" onClick={onClose} data-testid="sheet-sync-done">
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" className="rounded-xl" disabled={applying} onClick={onClose} data-testid="sheet-sync-cancel">
                Cancel
              </Button>
              <Button
                className="rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.98]"
                disabled={applying || state.kind !== 'ready' || !hasChanges(state.plan)}
                onClick={() => void handleApply()}
                data-testid="sheet-sync-apply"
              >
                {applying ? (
                  <>
                    <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    Applying…
                  </>
                ) : (
                  'Apply'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </div>
    </>
  )
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export function SheetSyncPreviewDialog({
  open,
  onClose,
  onApplied,
}: {
  open: boolean
  onClose: () => void
  onApplied: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">{open && <Body onClose={onClose} onApplied={onApplied} />}</DialogContent>
    </Dialog>
  )
}
