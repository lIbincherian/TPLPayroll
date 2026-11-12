import type { ReactNode } from 'react'

/** The /attendance title block. `actions` sits on the right of the title. */
export function AttendancePageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Attendance</h1>
        <p className="mt-1 text-sm text-zinc-500">Synced from eTimeOffice every Thursday morning.</p>
      </div>
      {actions}
    </div>
  )
}
