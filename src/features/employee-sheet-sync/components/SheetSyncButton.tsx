'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowsClockwise } from '@phosphor-icons/react'
import { SheetSyncPreviewDialog } from './SheetSyncPreviewDialog'

/** Opens the sync preview. The page renders it only while the sync is turned on in Settings. */
export function SheetSyncButton({ onApplied }: { onApplied?: () => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="sheet-sync-button"
        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-700 transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 active:scale-[0.98]"
      >
        <ArrowsClockwise size={15} aria-hidden />
        Sync from sheet
      </button>
      <SheetSyncPreviewDialog
        open={open}
        onClose={() => setOpen(false)}
        onApplied={() => {
          router.refresh()
          onApplied?.()
        }}
      />
    </>
  )
}
