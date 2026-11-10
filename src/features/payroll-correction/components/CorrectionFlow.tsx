'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, CircleNotch } from '@phosphor-icons/react'
import type {
  InitiateCorrectionResult,
  CorrectionType,
  CorrectionSessionInfo,
} from '@/features/payroll-correction/types/correction.types'
import {
  recalculateAndCreateRevisionAction,
  startAttendanceCorrectionAction,
  abandonCorrectionAction,
  approveAdjustmentInCorrectionAction,
} from '@/features/payroll-correction/actions/correction.actions'

import { skipAdjustmentApplicationAction } from '@/features/payroll-adjustments/actions/adjustment.actions'

// ─── Props ────────────────────────────────────────────────────────────────────

interface CorrectionFlowProps {
  data: InitiateCorrectionResult
  weekLabel: string
  /** The correction in progress for this run. Prefills the reason and types when resuming. */
  activeSession?: CorrectionSessionInfo | null
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CorrectionFlow({ data, weekLabel, activeSession = null }: CorrectionFlowProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [correctionReason, setCorrectionReason] = useState(activeSession?.correctionReason ?? '')
  const [selectedTypes, setSelectedTypes] = useState<Set<CorrectionType>>(
    new Set(activeSession?.correctionTypes ?? []),
  )
  const [error, setError] = useState<string | null>(null)

  const runUrl = `/payroll/run/${data.payrollRunId}`
  const attendanceSelected = selectedTypes.has('ATTENDANCE')
  // An Excel-era run has no punches to edit, so only adjustments and employee data can be corrected.
  const attendanceDisabled = activeSession?.attendanceSource === 'EXCEL'

  const isContinueDisabled = isPending || selectedTypes.size === 0

  // Local override of application statuses based on live user actions
  const [appStatusOverrides, setAppStatusOverrides] = useState<Partial<Record<string, 'APPROVED' | 'SKIPPED'>>>({})

  const correctionOptions: { type: CorrectionType; label: string; description: string }[] = [
    { type: 'ADJUSTMENTS', label: 'Adjustments', description: 'Modify deductions or additions' },
    { type: 'ATTENDANCE', label: 'Attendance', description: attendanceDisabled
        ? "Attendance can't be corrected for an Excel-era week"
        : "Edit this week's punches" },
    { type: 'EMPLOYEE_DATA', label: 'Employee data updated', description: 'Recalculate with current employee directory data' },
  ]

  function toggleType(type: CorrectionType) {
    if (type === 'ATTENDANCE' && attendanceDisabled) return
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function handleApproveAdjustment(applicationId: string) {
    startTransition(async () => {
      // Not the weekly review's approve: this one knows the application was already applied once.
      const res = await approveAdjustmentInCorrectionAction(applicationId)
      if (res.ok) {
        setAppStatusOverrides((prev) => ({ ...prev, [applicationId]: 'APPROVED' }))
      }
    })
  }

  function handleSkipAdjustment(applicationId: string) {
    startTransition(async () => {
      const res = await skipAdjustmentApplicationAction(applicationId)
      if (res.ok) {
        setAppStatusOverrides((prev) => ({ ...prev, [applicationId]: 'SKIPPED' }))
      }
    })
  }

  function handleContinue() {
    if (selectedTypes.size === 0) {
      setError('Select at least one correction type')
      return
    }
    setError(null)

    startTransition(async () => {
      if (attendanceSelected) {
        // Copies the approved punches and opens the punches page (the action redirects).
        const res = await startAttendanceCorrectionAction(data.payrollRunId, {
          reason: correctionReason.trim() || null,
          types: [...selectedTypes],
        })
        if (res && !res.ok) setError(res.error)
        else if (res?.ok) router.push(`${runUrl}/correct/punches`)
        return
      }

      const res = await recalculateAndCreateRevisionAction({
        payrollRunId: data.payrollRunId,
        correctionReason: correctionReason.trim() || null,
        correctionTypes: [...selectedTypes],
        correctionSessionId: activeSession?.sessionId,
        // The backend handles applying logic automatically based on final approved statuses.
        // Passing empty array for backwards compatibility of shape, database is now the source of truth live.
        adjustmentChanges: {
          reversed: [],
          approved: [],
        },
      })

      if (res.ok) {
        router.push(`${runUrl}/correct/preview`)
      } else {
        setError(res.error)
      }
    })
  }

  // Cancelling discards the correction: the adjustment statuses go back to how they were.
  function handleCancel() {
    if (!activeSession) {
      router.push(runUrl)
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await abandonCorrectionAction(data.payrollRunId)
      if (res.ok) {
        router.push(runUrl)
      } else {
        setError(res.error)
      }
    })
  }

  // Compute effective listing including local changes
  const displayedAdjustments = data.adjustmentApplications.map((a) => ({
    ...a,
    effectiveStatus: appStatusOverrides[a.applicationId] ?? a.approvalStatus,
  }))

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      {/* Cancel */}
      <button
        onClick={handleCancel}
        disabled={isPending}
        className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-700 disabled:opacity-50"
      >
        <ArrowLeft size={16} />
        Cancel Correction
      </button>

      {/* Header */}
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Payroll Correction
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        {weekLabel} · Revision {data.revisionNumber} stays current until the new one is approved
      </p>

      {/* Error banner */}
      {error && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Reason section */}
      <section className="mt-8 border-t border-zinc-200/60 pt-8">
        <label
          htmlFor="correction-reason"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400"
        >
          Correction Reason (optional)
        </label>
        <input
          id="correction-reason"
          type="text"
          value={correctionReason}
          onChange={(e) => setCorrectionReason(e.target.value)}
          placeholder="e.g. Overtime hours were miscalculated for 2 employees"
          className="w-full rounded-xl border border-zinc-200/60 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-shadow"
        />
      </section>

      {/* Correction type section */}
      <section className="mt-8 border-t border-zinc-200/60 pt-8">
        <p className="mb-4 text-sm font-medium text-zinc-900">
          What do you want to correct?
        </p>

        <div className="space-y-3">
          {correctionOptions.map((opt) => (
            <label
              key={opt.type}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200/60 px-4 py-3 transition-colors hover:bg-zinc-50/50 has-[:checked]:border-emerald-300 has-[:checked]:bg-emerald-50/30 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <input
                type="checkbox"
                checked={selectedTypes.has(opt.type)}
                disabled={opt.type === 'ATTENDANCE' && attendanceDisabled}
                onChange={() => toggleType(opt.type)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600 accent-emerald-600 focus:ring-emerald-500"
              />
              <div>
                <span className="text-sm text-zinc-700">{opt.label}</span>
                <p className="text-xs text-zinc-400">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Adjustment changes section */}
      {selectedTypes.has('ADJUSTMENTS') && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8">
          <p className="mb-4 text-sm font-medium text-zinc-900">Adjustment Changes</p>

          {displayedAdjustments.length === 0 ? (
            <p className="text-sm text-zinc-400">No adjustments to modify for this week.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-zinc-200">
                    {['Employee', 'Type', 'Reason', 'Amount', 'Status', 'Action'].map((h) => (
                      <th
                        key={h}
                        className="pb-2 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {displayedAdjustments.map((adj) => {
                    const isApprove = adj.effectiveStatus === 'APPROVED'
                    const isSkip = adj.effectiveStatus === 'SKIPPED'
                    const isPendingRow = adj.effectiveStatus === 'PENDING'

                    return (
                      <tr key={adj.applicationId} className="hover:bg-zinc-50/50">
                        <td className="py-2.5 pr-4 font-sans text-zinc-900">{adj.employeeName}</td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${adj.adjustmentType === 'DEDUCTION' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}
                          >
                            {adj.adjustmentType === 'DEDUCTION' ? 'Deduction' : 'Addition'}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-sans text-zinc-600">{adj.reason}</td>
                        <td className="py-2.5 pr-4 text-right text-zinc-700">
                          {adj.adjustmentType === 'DEDUCTION' ? '-' : '+'}₹{formatCurrency(adj.appliedAmount)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {isApprove && (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Approved
                            </span>
                          )}
                          {isSkip && (
                            <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
                              Skipped
                            </span>
                          )}
                          {isPendingRow && (
                            <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex gap-2">
                            {(isPendingRow || isSkip) && (
                              <button
                                onClick={() => handleApproveAdjustment(adj.applicationId)}
                                disabled={isPending}
                                className="rounded-lg border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-50 active:scale-[0.98] disabled:opacity-50"
                              >
                                Approve
                              </button>
                            )}
                            {(isPendingRow || isApprove) && (
                              <button
                                onClick={() => handleSkipAdjustment(adj.applicationId)}
                                disabled={isPending}
                                className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-all hover:bg-zinc-50 active:scale-[0.98] disabled:opacity-50"
                              >
                                Skip
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          
          {/* Guidance message if any are pending */}
          {displayedAdjustments.some((a) => a.effectiveStatus === 'PENDING') && (
             <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
               Some adjustments are still Pending. Pending adjustments will not be applied during recalculation.
             </div>
          )}
        </section>
      )}

      {/* Employee data notice */}
      {selectedTypes.has('EMPLOYEE_DATA') && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8">
          <p className="mb-2 text-sm font-medium text-zinc-900">Employee Data Changes</p>
          <p className="text-sm text-zinc-500">
            The payroll will be recalculated using the current employee directory data, including any updated wage rates or matching changes.
          </p>
        </section>
      )}
 
      {/* Action bar */}
      <div className="mt-8 flex items-center justify-end gap-3 border-t border-zinc-200/60 pt-8">
        <button
          onClick={handleCancel}
          disabled={isPending}
          className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-[0.98] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleContinue}
          disabled={isContinueDisabled}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? (
            <>
              <CircleNotch size={16} className="animate-spin" />
              {attendanceSelected ? 'Opening punches...' : 'Recalculating...'}
            </>
          ) : attendanceSelected ? (
            <>
              Continue to punches
              <ArrowRight size={16} />
            </>
          ) : (
            <>
              Recalculate & Preview
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </main>
  )
}
