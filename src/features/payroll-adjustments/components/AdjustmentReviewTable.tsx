'use client'

import { Fragment, useState, useTransition } from 'react'
import { Check, X, Info, Prohibit, Warning } from '@phosphor-icons/react'
import {
  approveAdjustmentApplicationAction,
  cancelAdjustmentAction,
  skipAdjustmentApplicationAction,
} from '@/features/payroll-adjustments/actions/adjustment.actions'
import type { WeeklyReviewItem } from '@/features/payroll-adjustments/types/adjustment.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAmount(amount: number) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)
}

function formatWeek(start: Date) {
  return new Date(start).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// ─── Row action state ─────────────────────────────────────────────────────────

type RowAction = 'APPROVED' | 'SKIPPED' | 'CANCELLED' | null

const DECISION_LABEL: Record<NonNullable<RowAction>, { label: string; className: string }> = {
  APPROVED: { label: 'Approved', className: 'text-emerald-600' },
  SKIPPED: { label: 'Skipped', className: 'text-zinc-400' },
  CANCELLED: { label: 'Cancelled', className: 'text-rose-600' },
}

// ─── AdjustmentReviewTable ────────────────────────────────────────────────────

interface Props {
  items: WeeklyReviewItem[]
  weekStartDate: Date
  weekEndDate: Date
  onComplete?: (decisions: Record<string, RowAction>) => void
}

export function AdjustmentReviewTable({ items, weekStartDate, weekEndDate, onComplete }: Props) {
  const [, startTransition] = useTransition()
  const [decisions, setDecisions] = useState<Record<string, RowAction>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const allActioned = items.length > 0 && items.every((item) => decisions[item.applicationId] != null)

  const handleApprove = (applicationId: string) => {
    setPending((p) => ({ ...p, [applicationId]: true }))
    startTransition(async () => {
      const result = await approveAdjustmentApplicationAction(applicationId)
      setPending((p) => ({ ...p, [applicationId]: false }))
      if (result.ok) {
        setDecisions((d) => ({ ...d, [applicationId]: 'APPROVED' }))
      }
    })
  }

  const handleSkip = (applicationId: string) => {
    setPending((p) => ({ ...p, [applicationId]: true }))
    startTransition(async () => {
      const result = await skipAdjustmentApplicationAction(applicationId)
      setPending((p) => ({ ...p, [applicationId]: false }))
      if (result.ok) {
        setDecisions((d) => ({ ...d, [applicationId]: 'SKIPPED' }))
      }
    })
  }

  const handleCancel = (applicationId: string, adjustmentId: string) => {
    setPending((p) => ({ ...p, [applicationId]: true }))
    setErrors((e) => ({ ...e, [applicationId]: '' }))
    startTransition(async () => {
      const result = await cancelAdjustmentAction(adjustmentId)
      setPending((p) => ({ ...p, [applicationId]: false }))
      setConfirmingCancel(null)
      if (result.ok) {
        setDecisions((d) => ({ ...d, [applicationId]: 'CANCELLED' }))
      } else {
        setErrors((e) => ({ ...e, [applicationId]: result.error }))
      }
    })
  }

  const handleApproveAll = () => {
    items
      .filter((item) => decisions[item.applicationId] == null)
      .forEach((item) => handleApprove(item.applicationId))
  }

  const handleSkipAll = () => {
    items
      .filter((item) => decisions[item.applicationId] == null)
      .forEach((item) => handleSkip(item.applicationId))
  }

  return (
    <div className="space-y-6">
      {/* ── Step header ───────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Review Adjustments
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          {formatWeek(weekStartDate)} – {formatWeek(weekEndDate)}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200/60 bg-zinc-50/50 px-6 py-10 text-center">
          <p className="text-sm text-zinc-500">No pending adjustments for this week.</p>
        </div>
      ) : (
        <>
          {/* ── Bulk actions ───────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleApproveAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
            >
              <Check size={14} weight="bold" />
              Approve All
            </button>
            <button
              type="button"
              onClick={handleSkipAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
            >
              <X size={14} weight="bold" />
              Skip All
            </button>
          </div>

          {/* ── Table ─────────────────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full divide-y divide-zinc-100">
              <thead className="bg-zinc-50/50">
                <tr>
                  {['Employee', 'Type', 'Amount', 'Reason', 'Action'].map((h) => (
                    <th
                      key={h}
                      className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 ${
                        h === 'Action' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {items.map((item) => {
                  const decision = decisions[item.applicationId]
                  const isLoading = pending[item.applicationId]
                  const isApproved = decision === 'APPROVED'
                  const isSkipped = decision === 'SKIPPED'
                  const isCancelled = decision === 'CANCELLED'
                  const isMuted = isSkipped || isCancelled
                  const isConfirming = confirmingCancel === item.applicationId && decision == null
                  const error = errors[item.applicationId]

                  return (
                    <Fragment key={item.applicationId}>
                    <tr
                      className={[
                        'transition-colors',
                        isApproved ? 'bg-emerald-50/50' : '',
                        isMuted ? 'bg-zinc-50' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {/* Employee */}
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={`text-sm font-medium ${isMuted ? 'text-zinc-400' : 'text-zinc-900'}`}
                          >
                            {item.employeeName}
                          </span>
                          <span className="font-mono text-xs text-zinc-400">{item.employeeCode}</span>
                        </div>
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3">
                        {item.adjustmentType === 'DEDUCTION' ? (
                          <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600">
                            Deduction
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            Addition
                          </span>
                        )}
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-3">
                        <span
                          className={`font-mono tabular-nums text-sm ${
                            isMuted ? 'text-zinc-400 line-through' : 'text-zinc-900'
                          }`}
                        >
                          ₹{formatAmount(item.appliedAmount)}
                        </span>
                      </td>

                      {/* Reason */}
                      <td className="px-4 py-3">
                        <span className={`text-sm ${isMuted ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          {item.reason}
                        </span>
                      </td>

                      {/* Action buttons */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {decision == null ? (
                            <>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => handleApprove(item.applicationId)}
                                aria-label="Approve"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600 active:scale-[0.98] disabled:opacity-40"
                              >
                                <Check size={16} weight="bold" />
                              </button>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => handleSkip(item.applicationId)}
                                aria-label="Skip"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 active:scale-[0.98] disabled:opacity-40"
                              >
                                <X size={16} weight="bold" />
                              </button>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => setConfirmingCancel(item.applicationId)}
                                aria-label="Cancel adjustment"
                                title="Cancel adjustment"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 active:scale-[0.98] disabled:opacity-40"
                              >
                                <Prohibit size={16} weight="bold" />
                              </button>
                            </>
                          ) : (
                            <span className={`text-xs font-medium ${DECISION_LABEL[decision].className}`}>
                              {DECISION_LABEL[decision].label}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isConfirming && (
                      <tr>
                        <td colSpan={5} className="px-4 pb-3">
                          <div className="space-y-3 rounded-2xl border border-rose-200 bg-rose-50 p-4">
                            <div className="flex items-start gap-3">
                              <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-rose-500" />
                              <div>
                                <p className="text-sm font-semibold text-rose-800">
                                  Cancel this adjustment for good?
                                </p>
                                <p className="mt-1 text-sm text-rose-700">
                                  This will cancel the adjustment and remove any pending applications, so it
                                  won&apos;t be offered again. Any already-approved applications will remain in
                                  the record for audit purposes.
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setConfirmingCancel(null)}
                                disabled={isLoading}
                                className="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                              >
                                Keep adjustment
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCancel(item.applicationId, item.adjustmentId)}
                                disabled={isLoading}
                                className="rounded-xl bg-rose-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-700 active:scale-[0.98] disabled:opacity-60"
                              >
                                {isLoading ? 'Cancelling…' : 'Yes, cancel it'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {error && decision == null && (
                      <tr>
                        <td colSpan={5} className="px-4 pb-3">
                          <div
                            role="alert"
                            className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2"
                          >
                            <Warning size={15} className="shrink-0 text-rose-500" />
                            <p className="text-sm text-rose-700">{error}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* ── Info alert ────────────────────────────────────────────────── */}
          <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200/60 bg-zinc-50 p-3">
            <Info size={16} className="mt-0.5 shrink-0 text-zinc-400" />
            <p className="text-sm text-zinc-500">
              Skipped adjustments will carry forward to the next week. Cancelled adjustments stop and won&apos;t be offered again.
            </p>
          </div>

          {/* ── Continue button ───────────────────────────────────────────── */}
          {onComplete && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!allActioned}
                onClick={() => onComplete(decisions)}
                className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue to Payroll Summary
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
