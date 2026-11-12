'use client'

import { useRouter } from 'next/navigation'
import { WarningCircle } from '@phosphor-icons/react'

/** The rose banner for a page that failed to load, with a Try again that re-runs the server render. */
export function LoadErrorBanner({ message }: { message: string }) {
  const router = useRouter()

  return (
    <div
      role="alert"
      data-testid="load-error"
      className="flex items-start gap-3 rounded-xl border border-rose-200/60 bg-rose-50 p-4"
    >
      <WarningCircle size={18} className="mt-0.5 shrink-0 text-rose-500" />
      <p className="flex-1 text-sm text-rose-700">{message}</p>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 outline-none transition-colors hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-500/40"
      >
        Try again
      </button>
    </div>
  )
}
