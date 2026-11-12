/** Placeholder for the punch review: header, filters, then ten rows at the grid's real 48px height. */
export function ReviewGridSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="review-grid-skeleton">
      <span className="sr-only" role="status">
        Loading punch review
      </span>
      <div className="flex min-h-12 items-center gap-4">
        <div className="skeleton-shimmer h-4 w-20 rounded" />
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Punch review</h1>
        <div className="skeleton-shimmer h-4 w-32 rounded" />
        <div className="skeleton-shimmer h-5 w-28 rounded-full" />
        <div className="skeleton-shimmer ml-auto h-9 w-28 rounded-xl" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[64, 112, 160, 120].map((width) => (
          <div key={width} className="skeleton-shimmer h-7 rounded-full" style={{ width }} />
        ))}
        <div className="skeleton-shimmer h-8 w-52 rounded-full" />
      </div>

      <div className="overflow-hidden border-t border-zinc-200/60">
        <div className="h-8 border-b border-zinc-200" />
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex h-12 items-center gap-3 border-b border-zinc-200/60">
            <div className="w-[168px] shrink-0 space-y-1.5 px-3">
              <div className="skeleton-shimmer h-3 w-28 rounded" />
              <div className="skeleton-shimmer h-2.5 w-20 rounded" />
            </div>
            {Array.from({ length: 7 }, (_, j) => (
              <div key={j} className="hidden flex-1 space-y-1 md:block">
                <div className="skeleton-shimmer h-3 w-16 rounded" />
                <div className="skeleton-shimmer h-3 w-16 rounded" />
              </div>
            ))}
            <div className="skeleton-shimmer ml-auto mr-2 h-6 w-14 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
