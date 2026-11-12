import { AttendancePageHeader } from './AttendancePageHeader'

const COLUMNS = ['Week', 'Status', 'Details', 'Payroll', 'Action']

/** Placeholder for the week list: the real heading, then rows shaped like the table. */
export function WeekListSkeleton() {
  return (
    <div data-testid="week-list-skeleton" aria-busy="true">
      <AttendancePageHeader
        actions={<div className="skeleton-shimmer h-8 w-36 rounded-xl" aria-hidden />}
      />
      <span className="sr-only" role="status">
        Loading attendance weeks
      </span>

      <div className="hidden md:block">
        <div className="grid grid-cols-[1.4fr_1fr_2.4fr_1fr_0.9fr] gap-4 border-b border-zinc-100 px-4 py-3">
          {COLUMNS.map((column) => (
            <span key={column} className="text-xs font-medium uppercase tracking-wider text-zinc-400">
              {column}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1.4fr_1fr_2.4fr_1fr_0.9fr] items-center gap-4 border-b border-zinc-100 px-4 py-4"
          >
            <div className="skeleton-shimmer h-4 w-40 rounded" />
            <div className="skeleton-shimmer h-5 w-28 rounded-full" />
            <div className="skeleton-shimmer h-4 w-64 max-w-full rounded" />
            <div className="skeleton-shimmer h-4 w-20 rounded" />
            <div className="skeleton-shimmer ml-auto h-7 w-20 rounded-xl" />
          </div>
        ))}
      </div>

      <div className="space-y-3 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 border-b border-zinc-100 pb-4">
            <div className="skeleton-shimmer h-4 w-44 rounded" />
            <div className="skeleton-shimmer h-4 w-60 max-w-full rounded" />
            <div className="skeleton-shimmer h-9 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}
