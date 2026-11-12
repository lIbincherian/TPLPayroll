'use client'

import { useState } from 'react'
import { ArrowCounterClockwise, SpinnerGap } from '@phosphor-icons/react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

interface ReopenWeekDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Reopens the week. Resolves to an error message when it can't. */
  onConfirm: () => Promise<{ ok: true } | { ok: false; error: string }>
}

export function ReopenWeekDialog({ open, onOpenChange, onConfirm }: ReopenWeekDialogProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      const result = await onConfirm()
      if (!result.ok) setError(result.error)
    } catch {
      setError("Couldn't reach the server. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="reopen-week-dialog">
        <AlertDialogTitle>Reopen this week?</AlertDialogTitle>
        <AlertDialogDescription>
          Payroll can&apos;t use this week until you approve it again. No revision is created, and eTimeOffice
          isn&apos;t pulled again.
        </AlertDialogDescription>

        {error && (
          <p
            role="alert"
            data-testid="reopen-error"
            className="mt-4 rounded-xl border border-rose-200/60 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <Button
            variant="outline"
            className="rounded-xl"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            data-testid="reopen-cancel"
          >
            Cancel
          </Button>
          <Button
            className="rounded-xl bg-zinc-900 text-white hover:bg-zinc-800"
            disabled={pending}
            onClick={() => void handleConfirm()}
            data-testid="reopen-confirm"
          >
            {pending ? (
              <>
                <SpinnerGap size={14} className="animate-spin motion-reduce:animate-none" />
                Reopening…
              </>
            ) : (
              <>
                <ArrowCounterClockwise size={14} />
                Reopen
              </>
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
