import Link from 'next/link'
import { ArrowLeft, ArrowRight, Lock } from '@phosphor-icons/react/dist/ssr'
import { formatDayHeader, formatHours, formatHoursTotal, formatIstDateTime, plural } from '../lib/format'
import { formatWeekLabel } from '../lib/week'
import type { ExcelWeekData } from '../types/excel-week.types'
import { WeekStatusBadge } from './WeekStatusBadge'

const HEADER = 'text-xs font-medium uppercase tracking-wider text-zinc-500'

function Hours({ regular, overtime }: { regular: number; overtime: number }) {
  if (regular + overtime === 0) return <span className="text-zinc-400">—</span>
  return (
    <>
      <span className="block text-zinc-800">{formatHours(regular)}</span>
      {overtime > 0 && <span className="block font-medium text-zinc-900">+{formatHours(overtime)}</span>}
    </>
  )
}

/**
 * A week imported from an Excel file, before the eTimeOffice sync. Read-only: it has hours per
 * day but no punches, and it can't be pulled, reopened or edited.
 */
export function ExcelWeekView({ data }: { data: ExcelWeekData }) {
  const summary: Array<[string, string, string]> = [
    ['employees', 'Employees', String(data.employees.length)],
    ['regular', 'Regular hours', formatHoursTotal(data.totals.regular)],
    ['overtime', 'Overtime hours', formatHoursTotal(data.totals.overtime)],
  ]

  return (
    <div data-testid="excel-week-view">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            href="/attendance"
            className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-800"
          >
            <ArrowLeft size={14} />
            Attendance
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Punch review</h1>
          <span className="font-mono text-sm tabular-nums text-zinc-500" data-testid="week-label">
            {formatWeekLabel(data.week)}
          </span>
          <WeekStatusBadge status="APPROVED" />
        </div>
        {data.payroll.payrollRunId && (
          <Link
            href={`/payroll/run/${data.payroll.payrollRunId}`}
            data-testid="open-payroll-run"
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 active:scale-[0.98]"
          >
            Open payroll run
            <ArrowRight size={14} weight="bold" />
          </Link>
        )}
      </header>

      <p className="mt-3 text-xs text-zinc-500" data-testid="excel-source">
        Excel upload
        {data.fileName ? (
          <>
            {' · '}
            <span className="font-mono">{data.fileName}</span>
          </>
        ) : null}{' '}
        · uploaded {formatIstDateTime(data.uploadedAt, true)}
      </p>
      <p className="mt-2 flex items-start gap-2.5 text-sm text-zinc-500" data-testid="excel-read-only-note">
        <Lock size={16} className="mt-0.5 shrink-0 text-zinc-500" />
        <span>
          This week was imported from an Excel file before attendance was synced from eTimeOffice. It is read-only: it
          has hours for each day but no punches, and it can&apos;t be pulled again, reopened or edited.
        </span>
      </p>

      <dl className="mt-6 flex divide-x divide-zinc-200 border-b border-t border-zinc-200/60 py-4">
        {summary.map(([id, label, value]) => (
          <div key={id} className="flex-1 px-5 first:pl-0">
            <dt className={HEADER}>{label}</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900" data-testid={`excel-${id}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {data.employees.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500" data-testid="excel-empty">
          No attendance records were kept for this week.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table
            className="w-full min-w-[820px] border-separate border-spacing-0 font-mono text-[11px] leading-[14px] tabular-nums"
            data-testid="excel-grid"
          >
            <thead>
              <tr>
                <th scope="col" className={`${HEADER} h-8 border-b border-zinc-200 px-3 text-left font-sans`}>
                  Employee
                </th>
                {data.dates.map((date) => {
                  const { weekday, day } = formatDayHeader(date)
                  return (
                    <th key={date} scope="col" className={`${HEADER} border-b border-zinc-200 px-2 text-left font-sans`}>
                      {weekday} {day}
                    </th>
                  )
                })}
                <th scope="col" className={`${HEADER} border-b border-l border-zinc-200 px-2 text-right font-sans`}>
                  Week
                </th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((employee) => (
                <tr key={employee.employeeId} data-testid={`excel-row-${employee.employeeCode}`}>
                  <th scope="row" className="h-12 border-b border-zinc-200/60 px-3 text-left align-middle font-sans">
                    <span className="block truncate text-xs font-medium text-zinc-900">{employee.employeeName}</span>
                    <span className="font-mono text-[10px] text-zinc-500">{employee.employeeCode}</span>
                  </th>
                  {employee.days.map((day) => (
                    <td key={day.date} className="border-b border-zinc-200/60 px-2 align-middle">
                      <Hours regular={day.regular} overtime={day.overtime} />
                    </td>
                  ))}
                  <td className="border-b border-l border-zinc-200/60 px-2 text-right align-middle font-medium text-zinc-700">
                    <span className="block">{formatHoursTotal(employee.totalRegular)}</span>
                    <span className="block text-zinc-500">+{formatHoursTotal(employee.totalOvertime)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th
                  scope="row"
                  className={`${HEADER} h-10 border-t border-zinc-200 px-3 text-left font-sans normal-case tracking-normal`}
                >
                  {plural(data.employees.length, 'employee')}
                </th>
                {data.totals.byDay.map((total) => (
                  <td key={total.date} className="border-t border-zinc-200 px-2 font-medium text-zinc-700">
                    <span className="block">{formatHoursTotal(total.regular)}</span>
                    <span className="block text-zinc-500">+{formatHoursTotal(total.overtime)}</span>
                  </td>
                ))}
                <td className="border-l border-t border-zinc-200 px-2 text-right font-medium text-zinc-900">
                  <span className="block">{formatHoursTotal(data.totals.regular)}</span>
                  <span className="block text-zinc-500">+{formatHoursTotal(data.totals.overtime)}</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
