import { CaretRight, UserSwitch } from '@phosphor-icons/react/dist/ssr'
import { describeStatusChanges } from '../lib/employee-status'
import type { StatusChangeSummary, StatusChangedEmployee } from '../types/attendance-sync.types'

function renderGroup(label: string, employees: StatusChangedEmployee[]) {
  if (employees.length === 0) return null
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
      <dt className="shrink-0 font-medium text-zinc-700 sm:w-32">{label}</dt>
      <dd className="min-w-0 text-zinc-600">
        {employees.map((e, i) => (
          <span key={e.id}>
            {e.employeeName} <span className="tabular-nums text-zinc-500">({e.employeeId})</span>
            {i < employees.length - 1 ? ', ' : ''}
          </span>
        ))}
      </dd>
    </div>
  )
}

/**
 * Who the week's latest approval marked inactive or reactivated, as one line above the grid. The names
 * stay folded away so a long list never pushes the grid down. Renders nothing when nobody changed.
 */
export function StatusChangesNotice({ changes }: { changes: StatusChangeSummary }) {
  const sentence = describeStatusChanges(changes)
  if (sentence === null) return null

  return (
    <details
      data-testid="status-changes-notice"
      aria-label="Employee status changes"
      className="group shrink-0 rounded-xl border border-zinc-200 bg-white px-4 py-1 text-sm"
    >
      <summary className="-mx-2 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 md:min-h-8 [&::-webkit-details-marker]:hidden">
        <UserSwitch size={16} className="shrink-0 text-zinc-500" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{sentence}</span>{' '}when this week was approved.
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-zinc-500">
          <span className="group-open:hidden">Show names</span>
          <span className="hidden group-open:inline">Hide names</span>
          <CaretRight size={12} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        </span>
      </summary>
      <dl className="mt-2 flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-lg pb-1 pl-6 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
        tabIndex={0}>
        {renderGroup('Marked inactive', changes.markedInactive)}
        {renderGroup('Reactivated', changes.reactivated)}
      </dl>
    </details>
  )
}
