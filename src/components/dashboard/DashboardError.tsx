import { WarningCircle } from '@phosphor-icons/react/dist/ssr'

/**
 * DashboardError — displayed when dashboard data fetch fails.
 * Provides a clear recovery path with a "Try again" button.
 */
export function DashboardError() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20">
      <WarningCircle size={32} className="text-rose-400" weight="regular" />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-lg font-medium text-zinc-700">Something went wrong</p>
        <p className="text-sm text-zinc-400">We couldn&apos;t load your dashboard data</p>
      </div>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate hard reload: this is the error fallback for "/" itself, so a full navigation re-runs the failed server fetch (a <Link> would soft-navigate to the same URL) */}
      <a
        href="/"
        className={[
          'inline-flex items-center px-4 py-2 rounded-xl text-sm font-medium',
          'bg-emerald-600 text-white',
          'hover:bg-emerald-700',
          'transition-colors duration-200',
          'active:scale-[0.98]',
        ].join(' ')}
      >
        Try again
      </a>
    </div>
  )
}
