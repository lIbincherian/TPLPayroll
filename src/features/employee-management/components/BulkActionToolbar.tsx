'use client'

import { UserMinus, Prohibit, CurrencyCircleDollar, X } from '@phosphor-icons/react'

interface BulkActionToolbarProps {
  selectedCount: number
  onMarkResigned: () => void
  onMarkInactive: () => void
  onChangeHourlyRate: () => void
  onClear: () => void
}

export function BulkActionToolbar({
  selectedCount,
  onMarkResigned,
  onMarkInactive,
  onChangeHourlyRate,
  onClear,
}: BulkActionToolbarProps) {
  if (selectedCount === 0) return null

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-slideUp"
      id="bulk-action-toolbar"
    >
      <div className="flex items-center gap-2 bg-white rounded-2xl border border-zinc-200/60 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.12)] px-4 py-3">
        {/* Selection count */}
        <span className="text-sm font-medium text-zinc-700 mr-2 whitespace-nowrap">
          {selectedCount} selected
        </span>

        {/* Divider */}
        <div className="w-px h-5 bg-zinc-200" />

        {/* Mark Resigned */}
        <button
          type="button"
          onClick={onMarkResigned}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          id="bulk-mark-resigned-btn"
        >
          <UserMinus size={15} />
          Mark Resigned
        </button>

        {/* Mark Inactive */}
        <button
          type="button"
          onClick={onMarkInactive}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 rounded-lg transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          id="bulk-mark-inactive-btn"
        >
          <Prohibit size={15} />
          Mark Inactive
        </button>

        {/* Change Daily Wage */}
        <button
          type="button"
          onClick={onChangeHourlyRate}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          id="bulk-change-rate-btn"
        >
          <CurrencyCircleDollar size={15} />
          Change Daily Wage
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-zinc-200 ml-1" />

        {/* Clear */}
        <button
          type="button"
          onClick={onClear}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors duration-150"
          aria-label="Clear selection"
          id="bulk-clear-btn"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
