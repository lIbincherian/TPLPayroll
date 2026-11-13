import { UserSwitch } from '@phosphor-icons/react/dist/ssr'
import { describeStatusChanges } from '../lib/employee-status'
import type { StatusChangeSummary, StatusChangedEmployee } from '../types/attendance-sync.types'

function NameGroup({ label, employees }: { label: string; employees: StatusChangedEmployee[] }) {
  if (employees.length === 0) return null
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
      <dt className="shrink-0 font-medium text-slate-700 sm:w-32">{label}</dt>
      <dd className="min-w-0 text-slate-600">
        {employees.map((e, i) => (
          <span key={e.id}>
            {e.employeeName} <span className="tabular-nums text-slate-500">({e.employeeId})</span>
            {i < employees.length - 1 ? ', ' : ''}
          </span>
        ))}
      </dd>
    </div>
  )
}

/** Who the week's latest pull marked inactive or reactivated. Renders nothing when nobody changed. */
export function StatusChangesNotice({ changes }: { changes: StatusChangeSummary }) {
  const sentence = describeStatusChanges(changes)
  if (sentence === null) return null

  return (
    <section
      data-testid="status-changes-notice"
      aria-label="Employee status changes"
      className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2 text-slate-900">
        <UserSwitch size={16} className="shrink-0 text-slate-500" aria-hidden />
        <span>
          <span className="font-medium">{sentence}</span> by this week&apos;s attendance.
        </span>
      </p>
      <dl className="mt-2 flex flex-col gap-1.5 pl-6">
        <NameGroup label="Marked inactive" employees={changes.markedInactive} />
        <NameGroup label="Reactivated" employees={changes.reactivated} />
      </dl>
    </section>
  )
}
