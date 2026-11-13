'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Circle,
  CurrencyInr,
  CalendarBlank,
  ArrowsClockwise,
  CheckCircle,
  XCircle,
  Clock,
  PencilSimple,
  Trash,
  Warning,
  SpinnerGap,
  Prohibit,
} from '@phosphor-icons/react'
import { cancelAdjustmentAction } from '@/features/payroll-adjustments/actions/adjustment.actions'
import type {
  AdjustmentDetailRecord,
  AdjustmentApplicationRecord,
  ApprovalStatus,
} from '@/features/payroll-adjustments/types/adjustment.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAmount(amount: number) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)
}

function formatDate(d: Date) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatWeek(start: Date, end: Date) {
  const s = new Date(start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  const e = new Date(end).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  return `${s} – ${e}`
}

// ─── Application status badge ─────────────────────────────────────────────────

function AppStatusBadge({
  status,
  carriedTo,
}: {
  status: ApprovalStatus
  carriedTo?: Date | null
}) {
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
        <CheckCircle size={15} weight="fill" className="text-emerald-500" />
        Approved
      </span>
    )
  }
  if (status === 'SKIPPED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-zinc-600">
        <XCircle size={15} weight="fill" className="text-zinc-400" />
        {carriedTo ? `Skipped, carried to week of ${formatDate(carriedTo)}` : 'Skipped'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600">
      <Clock size={15} weight="fill" className="text-amber-400" />
      Pending
    </span>
  )
}

// ─── Metadata row ─────────────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="text-sm text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-900 text-right">{value}</span>
    </div>
  )
}

// ─── AdjustmentDetail ─────────────────────────────────────────────────────────

interface Props {
  adjustment: AdjustmentDetailRecord
}

export function AdjustmentDetail({ adjustment: adj }: Props) {
  const router = useRouter()
  const [isCancelling, startCancelTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const hasApprovedApp = adj.applications.some((a) => a.approvalStatus === 'APPROVED')
  const canEdit = adj.status === 'ACTIVE' && !hasApprovedApp
  const canDelete = adj.status === 'ACTIVE'
  const isCancelled = adj.status === 'CANCELLED'
  const historyApps = isCancelled
    ? adj.applications.filter((a) => a.approvalStatus !== 'PENDING')
    : adj.applications

  function handleDelete() {
    setDeleteError(null)
    startCancelTransition(async () => {
      const result = await cancelAdjustmentAction(adj.id)
      if (result.ok) {
        router.push('/adjustments')
        router.refresh()
      } else {
        setDeleteError(result.error)
        setShowDeleteConfirm(false)
      }
    })
  }

  const endConditionLabel =
    adj.recurrenceEndType === 'END_WEEK'
      ? `Until ${adj.endPayrollWeekStartDate ? formatWeek(adj.endPayrollWeekStartDate, adj.endPayrollWeekEndDate!) : '—'}`
      : adj.recurrenceEndType === 'FIXED_WEEKS'
        ? `${adj.totalRecurrenceWeeks} weeks`
        : adj.recurrenceEndType === 'TOTAL_BALANCE'
          ? `Until ₹${formatAmount(adj.totalBalance ?? 0)} depleted`
          : '—'

  return (
    <div className="space-y-8">
      {/* ── Back link ─────────────────────────────────────────────────────── */}
      <Link
        href="/adjustments"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-900"
      >
        <ArrowLeft size={15} />
        Back to adjustments
      </Link>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Adjustment Detail
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {adj.employeeName}{' '}
            <span className="font-mono text-zinc-400">({adj.employeeCode})</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Status badge */}
          {adj.status === 'ACTIVE' ? (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              <Circle size={8} weight="fill" className="text-emerald-500" />
              Active
            </span>
          ) : adj.status === 'COMPLETED' ? (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-100 px-3 py-1.5 text-sm text-zinc-500">
              <Circle size={8} weight="fill" className="text-zinc-400" />
              Completed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-rose-50 px-3 py-1.5 text-sm text-rose-500">
              <Circle size={8} weight="fill" className="text-rose-400" />
              Cancelled
            </span>
          )}

          {/* Edit button — only for ACTIVE with no approved apps */}
          {canEdit && (
            <button
              id="edit-adjustment-btn"
              onClick={() => router.push(`/adjustments/${adj.id}/edit`)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:border-zinc-300 active:scale-[0.98]"
            >
              <PencilSimple size={14} />
              Edit
            </button>
          )}

          {/* Delete button — only for ACTIVE adjustments */}
          {canDelete && (
            <button
              id="delete-adjustment-btn"
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-100 active:scale-[0.98]"
            >
              <Trash size={14} />
              Delete
            </button>
          )}
        </div>
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────── */}
      {deleteError && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <Warning size={16} className="shrink-0 text-rose-500" />
          <p className="text-sm text-rose-700">{deleteError}</p>
        </div>
      )}

      {/* ── Delete confirmation dialog ────────────────────────────────────── */}
      {showDeleteConfirm && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <Warning size={20} weight="fill" className="mt-0.5 shrink-0 text-rose-500" />
            <div>
              <p className="text-sm font-semibold text-rose-800">Cancel this adjustment?</p>
              <p className="mt-1 text-sm text-rose-700">
                This will cancel the adjustment and remove any pending applications. Any already-approved
                applications will remain in the record for audit purposes.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button
              id="delete-cancel-btn"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isCancelling}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
            >
              Keep adjustment
            </button>
            <button
              id="delete-confirm-btn"
              onClick={handleDelete}
              disabled={isCancelling}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-700 active:scale-[0.98] disabled:opacity-60"
            >
              {isCancelling ? (
                <>
                  <SpinnerGap size={13} className="animate-spin" />
                  Cancelling…
                </>
              ) : (
                'Yes, cancel it'
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Metadata grid ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {/* Left card: adjustment info */}
        <div className="rounded-2xl border border-zinc-200/60 bg-white p-5">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
            <CurrencyInr size={14} />
            Adjustment Info
          </h2>
          <div className="divide-y divide-zinc-100">
            <MetaRow
              label="Type"
              value={
                adj.adjustmentType === 'DEDUCTION' ? (
                  <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600">
                    Deduction
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    Addition
                  </span>
                )
              }
            />
            <MetaRow
              label="Amount"
              value={
                adj.recurrenceEndType === 'FIXED_WEEKS' && adj.totalBalance != null ? (
                  <span className="text-right">
                    <span className="font-mono tabular-nums block">₹{formatAmount(adj.amount)} / week</span>
                    <span className="text-xs text-zinc-400">₹{formatAmount(adj.totalBalance)} total over {adj.totalRecurrenceWeeks} weeks</span>
                  </span>
                ) : (
                  <span className="font-mono tabular-nums">₹{formatAmount(adj.amount)}</span>
                )
              }
            />
            <MetaRow label="Reason" value={adj.reason} />
          </div>
        </div>

        {/* Right card: recurrence info */}
        <div className="rounded-2xl border border-zinc-200/60 bg-white p-5">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
            <ArrowsClockwise size={14} />
            Recurrence
          </h2>
          <div className="divide-y divide-zinc-100">
            <MetaRow
              label="Type"
              value={adj.recurrenceType === 'RECURRING' ? 'Recurring' : 'One-time'}
            />
            <MetaRow
              label="Start Week"
              value={
                <span className="flex items-center gap-1.5">
                  <CalendarBlank size={13} className="text-zinc-400" />
                  {formatWeek(adj.startPayrollWeekStartDate, adj.startPayrollWeekEndDate)}
                </span>
              }
            />
            {adj.recurrenceType === 'RECURRING' && (
              <MetaRow label="End Condition" value={endConditionLabel} />
            )}
            {(adj.recurrenceEndType === 'TOTAL_BALANCE' || adj.recurrenceEndType === 'FIXED_WEEKS') &&
              adj.remainingBalance != null && (
                <MetaRow
                  label="Remaining Balance"
                  value={
                    <span className="font-mono tabular-nums">
                      ₹{formatAmount(adj.remainingBalance)}
                      <span className="ml-1 text-xs text-zinc-400">
                        / ₹{formatAmount(adj.totalBalance ?? 0)}
                      </span>
                    </span>
                  }
                />
              )}
          </div>
        </div>
      </div>

      {/* ── Application timeline ───────────────────────────────────────────── */}
      <div>
        <h2 className="mb-4 text-sm font-semibold text-zinc-700">Application History</h2>

        {historyApps.length === 0 && !isCancelled ? (
          <p className="text-sm text-zinc-400">No applications yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-zinc-200/60">
            <table className="w-full divide-y divide-zinc-100">
              <thead className="bg-zinc-50/50">
                <tr>
                  {['Payroll Week', 'Applied Amount', 'Status', 'Applied At'].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 bg-white">
                {historyApps.map((app: AdjustmentApplicationRecord, i) => (
                  <tr
                    key={app.id}
                    style={{
                      opacity: app.approvalStatus === 'SKIPPED' ? undefined : 0,
                      animation:
                        app.approvalStatus !== 'SKIPPED'
                          ? 'fadeSlideIn 0.3s ease forwards'
                          : undefined,
                      animationDelay: `${i * 50}ms`,
                    }}
                  >
                    <td className="px-4 py-3">
                      <span className={`text-sm ${app.approvalStatus === 'SKIPPED' ? 'text-zinc-500' : 'text-zinc-700'}`}>
                        {formatWeek(app.payrollWeekStartDate, app.payrollWeekEndDate)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-mono tabular-nums text-sm ${
                          app.approvalStatus === 'SKIPPED' ? 'line-through text-zinc-400' : 'text-zinc-900'
                        }`}
                      >
                        ₹{formatAmount(app.appliedAmount)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <AppStatusBadge
                        status={app.approvalStatus}
                        carriedTo={app.carriedForwardToPayrollWeekStartDate}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-zinc-500">
                        {app.appliedAt
                          ? formatDate(app.appliedAt)
                          : app.skippedAt
                            ? formatDate(app.skippedAt)
                            : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
                {isCancelled && (
                  <tr data-testid="history-cancelled-entry">
                    <td className="px-4 py-3 text-sm text-zinc-400">—</td>
                    <td className="px-4 py-3 text-sm text-zinc-400">—</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-rose-600">
                        <Prohibit size={15} weight="bold" className="text-rose-500" />
                        Cancelled
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
