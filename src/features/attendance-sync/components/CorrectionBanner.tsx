'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilSimple, SpinnerGap } from '@phosphor-icons/react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { abandonCorrectionAction } from '@/features/payroll-correction/actions/correction.actions'
import { plural } from '../lib/format'

interface CorrectionBannerProps {
  payrollRunId: string
  /** The revision that stays in effect until the correction is approved. */
  revisionNumber: number
  reason: string | null
  /** Days that differ from the approved punches; null while it is being worked out. */
  changedDays: number | null
}

/** One line above the grid while a payroll correction is open, with Cancel correction. */
export function CorrectionBanner({ payrollRunId, revisionNumber, reason, changedDays }: CorrectionBannerProps) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function discard() {
    setPending(true)
    setError(null)
    try {
      const res = await abandonCorrectionAction(payrollRunId)
      if (res.ok) {
        toast.success('Correction discarded')
        router.push(`/payroll/run/${payrollRunId}`)
        return
      }
      setError(res.error)
    } catch {
      setError("Couldn't reach the server. Try again.")
    }
    setPending(false)
  }

  function handleCancelClick() {
    // With no edits there is nothing to lose, so skip the question.
    if (changedDays === 0) void discard()
    else setConfirming(true)
  }

  const changed =
    changedDays === null ? '' : changedDays === 0 ? ' No days changed yet.' : ` ${plural(changedDays, 'day')} changed.`

  return (
    <>
      <div
        data-testid="correction-banner"
        className="flex items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50 px-4 py-2 text-sm text-amber-900"
      >
        <PencilSimple size={16} className="shrink-0 text-amber-600" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">Correction in progress.</span>
          {changed} Revision {revisionNumber} stays in effect until the new one is approved.
          {reason ? <span data-testid="correction-reason"> Reason: {reason}</span> : null}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 rounded-xl border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
          onClick={handleCancelClick}
          disabled={pending}
          data-testid="cancel-correction"
        >
          Cancel correction
        </Button>
      </div>

      {error && !confirming && (
        <p role="alert" className="mt-2 text-sm text-rose-600" data-testid="correction-error">
          {error}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent data-testid="discard-correction-dialog">
          <AlertDialogTitle>Discard this correction?</AlertDialogTitle>
          <AlertDialogDescription>
            Punch edits on {plural(changedDays ?? 0, 'day')} will be discarded. The approved hours and Revision{' '}
            {revisionNumber} stay as they are.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="mt-3 text-sm text-rose-600">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="rounded-xl"
              disabled={pending}
              onClick={() => setConfirming(false)}
              data-testid="keep-editing"
            >
              Keep editing
            </Button>
            <Button
              className="rounded-xl bg-rose-600 text-white hover:bg-rose-700"
              disabled={pending}
              onClick={() => void discard()}
              data-testid="discard-correction"
            >
              {pending ? (
                <>
                  <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />
                  Discarding…
                </>
              ) : (
                'Discard correction'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
