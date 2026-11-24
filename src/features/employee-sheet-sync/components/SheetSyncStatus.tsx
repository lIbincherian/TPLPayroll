import { CaretRight, CheckCircle, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { describeSkip, formatRunTime, plural } from '../lib/labels'
import type { LastSheetSync } from '../types/employee-sheet-sync.types'

/**
 * The last sync run as one line above the list, with the skipped rows folded away. Before the first
 * Apply it says the nightly sync has not started.
 */
export function SheetSyncStatus({ last, firstApplied }: { last: LastSheetSync | null; firstApplied: boolean }) {
  return (
    <div data-testid="sheet-sync-status" className="text-sm">
      {last ? <LastRun last={last} /> : <p className="text-zinc-500">The sheet has not been synced yet.</p>}
      {!firstApplied && (
        <p className="mt-1 text-zinc-500" data-testid="sheet-sync-first-note">
          The nightly sync starts after the first Apply.
        </p>
      )}
    </div>
  )
}

function LastRun({ last }: { last: LastSheetSync }) {
  const failed = last.status === 'FAILED'
  const when = `${formatRunTime(last.at)} (${last.trigger === 'SCHEDULED' ? 'nightly' : 'manual'})`

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 text-zinc-700">
        {failed ? (
          <WarningCircle size={16} className="shrink-0 text-rose-500" aria-hidden />
        ) : (
          <CheckCircle size={16} weight="fill" className="shrink-0 text-emerald-600" aria-hidden />
        )}
        <span className="font-medium text-zinc-900">{failed ? 'Last sync failed' : 'Last synced'}</span>
        <span className="tabular-nums text-zinc-600">{when}</span>
        {failed ? (
          <span className="text-rose-700" data-testid="sheet-sync-last-error">{last.error}</span>
        ) : (
          <span className="text-zinc-600" data-testid="sheet-sync-last-counts">
            {last.created} added, {last.updated} updated, {last.skipped} skipped
            {last.warnings > 0 ? `, ${plural(last.warnings, 'warning')}` : ''}
          </span>
        )}
      </p>
      {last.skips.length > 0 && (
        <details className="group mt-1" data-testid="sheet-sync-skips">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-xs text-zinc-500 outline-none hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500/50 [&::-webkit-details-marker]:hidden">
            <CaretRight size={12} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            Skipped rows ({last.skips.length})
          </summary>
          <ul className="mt-1 max-h-40 divide-y divide-zinc-100 overflow-y-auto pl-4">
            {last.skips.map((s) => (
              <li key={s.rowNumber} className="flex gap-3 py-1 text-xs">
                <span className="w-14 shrink-0 font-mono tabular-nums text-zinc-500">Row {s.rowNumber}</span>
                <span className="text-zinc-600">
                  {s.name && <span className="text-zinc-900">{s.name} </span>}
                  {describeSkip(s)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
