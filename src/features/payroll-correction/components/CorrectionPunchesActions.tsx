'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, CircleNotch, PencilSimple } from '@phosphor-icons/react'
import {
  approveCorrectionPunchesAction,
  abandonCorrectionAction,
} from '@/features/payroll-correction/actions/correction.actions'

// Interim header actions for the correction punches page. The review grid (PunchReviewGrid
// with CorrectionBanner) takes over these controls; the actions they call stay the same.

interface Props {
  payrollRunId: string
  currentRevisionNumber: number
  needsFixingDays: number
  reason: string | null
}

export function CorrectionPunchesActions({ payrollRunId, currentRevisionNumber, needsFixingDays, reason }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showDiscard, setShowDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runUrl = `/payroll/run/${payrollRunId}`
  const blocked = needsFixingDays > 0

  function handleApprovePunches() {
    setError(null)
    startTransition(async () => {
      // On success the action redirects to the revised preview.
      const res = await approveCorrectionPunchesAction(payrollRunId)
      if (res && !res.ok) setError(res.error)
    })
  }

  function handleDiscard() {
    setError(null)
    startTransition(async () => {
      const res = await abandonCorrectionAction(payrollRunId)
      if (res.ok) {
        router.push(runUrl)
      } else {
        setError(res.error)
        setShowDiscard(false)
      }
    })
  }

  return (
    <div className="space-y-4" data-testid="correction-punches-actions">
      <div className="flex items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50 px-4 py-2 text-sm text-amber-800">
        <PencilSimple size={16} className="shrink-0 text-amber-500" />
        <span className="flex-1">
          Correction in progress. Revision {currentRevisionNumber} stays in effect until the new one is approved.
          {reason ? ` Reason: ${reason}` : ''}
        </span>
        <button
          type="button"
          onClick={() => setShowDiscard(true)}
          disabled={isPending}
          className="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 disabled:opacity-50"
        >
          Cancel correction
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <div className="flex items-center justify-end gap-3">
        {blocked && (
          <span className="text-xs text-zinc-500">
            {needsFixingDays} day(s) need fixing before the punches can be approved.
          </span>
        )}
        <button
          type="button"
          onClick={handleApprovePunches}
          disabled={isPending || blocked}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <>
              <CircleNotch size={16} className="animate-spin" />
              Recalculating...
            </>
          ) : (
            <>
              <CheckCircle size={16} weight="bold" />
              Approve punches
            </>
          )}
        </button>
      </div>

      {showDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-2xl bg-white p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.15)]">
            <h3 className="text-base font-semibold text-zinc-900">Discard this correction?</h3>
            <p className="mt-2 text-sm text-zinc-500">
              The punch edits will be discarded. The approved hours and Revision {currentRevisionNumber} stay as they are.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDiscard(false)}
                disabled={isPending}
                className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={handleDiscard}
                disabled={isPending}
                className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-rose-700 active:scale-[0.98] disabled:opacity-50"
              >
                {isPending ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    Discarding...
                  </>
                ) : (
                  'Discard correction'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
