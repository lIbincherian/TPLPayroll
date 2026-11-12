import type { CSSProperties } from 'react'
import Link from 'next/link'
import { CheckCircle, ListChecks, XCircle } from '@phosphor-icons/react/dist/ssr'
import { getAvailablePayrollWeeks } from '@/features/payroll-generation/services/payroll.service'
import type { PayrollWeekItem } from '@/features/payroll-generation/types/payroll.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatWeekRange(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
  return `${start.toLocaleDateString('en-IN', opts)} – ${end.toLocaleDateString('en-IN', opts)}`
}

const LINK_CLASS = 'underline-offset-2 hover:underline'

// ─── Attendance badge ─────────────────────────────────────────────────────────

function AttendanceBadge({ week }: { week: PayrollWeekItem }) {
  // Review and approved weeks open their punch grid; weeks with nothing to review open the list.
  const href =
    week.attendanceStatus === 'REVIEW' || week.attendanceStatus === 'APPROVED'
      ? `/attendance/${week.weekId}/review`
      : '/attendance'

  if (week.attendanceStatus === 'APPROVED') {
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ${LINK_CLASS}`}
      >
        <CheckCircle size={13} weight="fill" className="text-emerald-500" />
        Approved
      </Link>
    )
  }
  if (week.attendanceStatus === 'REVIEW') {
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ${LINK_CLASS}`}
      >
        <ListChecks size={13} className="text-amber-500" />
        Ready for review
      </Link>
    )
  }
  if (week.attendanceStatus === 'SYNC_FAILED') {
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ${LINK_CLASS}`}
      >
        <XCircle size={13} weight="fill" className="text-rose-500" />
        Sync failed
      </Link>
    )
  }
  return (
    <Link href={href} className={`text-xs text-zinc-400 hover:text-zinc-600 ${LINK_CLASS}`}>
      No data
    </Link>
  )
}

// ─── Payroll badge ────────────────────────────────────────────────────────────

function PayrollBadge({ status }: { status: PayrollWeekItem['payrollStatus'] }) {
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <CheckCircle size={13} weight="fill" className="text-emerald-500" />
        Approved
      </span>
    )
  }
  if (status === 'REVISED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
        <CheckCircle size={13} weight="fill" className="text-sky-500" />
        Revised
      </span>
    )
  }
  return <span className="text-xs text-zinc-400">Not generated</span>
}

// ─── Action cell ─────────────────────────────────────────────────────────────

function disabledGenerateTitle(week: PayrollWeekItem): string {
  if (week.source === 'EXCEL') return "Excel-era weeks can't start payroll"
  if (week.attendanceStatus === 'REVIEW') return "Approve this week's attendance first"
  return "Load this week's attendance first"
}

function ActionCell({ week }: { week: PayrollWeekItem }) {
  if ((week.payrollStatus === 'APPROVED' || week.payrollStatus === 'REVISED') && week.payrollRunId) {
    return (
      <Link
        href={`/payroll/run/${week.payrollRunId}`}
        className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 active:scale-[0.98]"
      >
        View
      </Link>
    )
  }

  if (week.canGenerate) {
    return (
      <Link
        href={`/payroll/generate/${week.weekId}`}
        className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-emerald-700 active:scale-[0.98]"
      >
        Generate
      </Link>
    )
  }

  // Attendance not approved, or an Excel-era week — disabled
  return (
    <span
      className="cursor-not-allowed rounded-xl bg-emerald-600/40 px-3 py-1.5 text-xs font-medium text-white"
      title={disabledGenerateTitle(week)}
    >
      Generate
    </span>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-zinc-200/60 bg-zinc-50/50 px-6 py-14 text-center">
      <p className="text-sm font-medium text-zinc-500">No attendance weeks found.</p>
      <p className="mt-1 text-xs text-zinc-400">
        Go to{' '}
        <Link href="/attendance" className="underline underline-offset-2 hover:text-zinc-600">
          Attendance
        </Link>{' '}
        to load a week and begin payroll.
      </p>
    </div>
  )
}

// ─── PayrollWeekList (server component) ───────────────────────────────────────

export async function PayrollWeekList() {
  const weeks = await getAvailablePayrollWeeks()

  if (weeks.length === 0) return <EmptyState />

  return (
    <div className="overflow-x-auto">
      <table className="w-full divide-y divide-zinc-100">
        <thead className="bg-zinc-50/50">
          <tr>
            {['Week', 'Attendance', 'Payroll', 'Action'].map((h) => (
              <th
                key={h}
                className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 ${
                  h === 'Action' ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {weeks.map((week, i) => (
            <tr
              key={week.weekId}
              style={{ '--index': i } as CSSProperties}
              className="card-reveal transition-colors hover:bg-zinc-50/80"
            >
              <td className="px-4 py-3">
                <span className="text-sm font-medium text-zinc-900">
                  {formatWeekRange(week.weekStart, week.weekEnd)}
                </span>
              </td>
              <td className="px-4 py-3">
                <AttendanceBadge week={week} />
              </td>
              <td className="px-4 py-3">
                <PayrollBadge status={week.payrollStatus} />
              </td>
              <td className="px-4 py-3 text-right">
                <ActionCell week={week} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
