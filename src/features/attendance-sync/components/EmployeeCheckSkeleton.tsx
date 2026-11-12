/** Placeholder for the employee check: the summary strip, then rows shaped like the code table. */
export function EmployeeCheckSkeleton() {
  return (
    <div aria-busy="true" data-testid="employee-check-skeleton">
      <span className="sr-only" role="status">
        Loading employee check
      </span>
      <div className="skeleton-shimmer mb-6 h-4 w-36 rounded" />
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Employee check</h1>
      <div className="skeleton-shimmer mt-2 h-4 w-40 rounded" />

      <div className="mt-6 grid grid-cols-2 gap-4 border-b border-t border-zinc-200/60 py-4 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton-shimmer h-3 w-20 rounded" />
            <div className="skeleton-shimmer h-6 w-10 rounded" />
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 border-b border-zinc-100 pb-4">
            <div className="skeleton-shimmer h-4 w-14 rounded" />
            <div className="skeleton-shimmer h-4 w-36 rounded" />
            <div className="skeleton-shimmer h-4 w-24 rounded" />
            <div className="skeleton-shimmer h-8 w-64 max-w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}
