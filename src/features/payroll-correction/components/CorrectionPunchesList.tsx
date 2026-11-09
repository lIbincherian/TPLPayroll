import type { DayView, PunchReview } from '@/features/attendance-sync/types/attendance-sync.types'

// Interim read-only list for the correction punches page. The editable review grid
// (PunchReviewGrid in correction mode) replaces it.

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

function dayHeading(isoDate: string): string {
  return DAY_FORMAT.format(new Date(`${isoDate}T00:00:00Z`))
}

/** "07:40–13:04, 13:56–17:47"; an incomplete pair shows "?" for the missing time. */
function dayText(day: DayView): string {
  const parts = day.pairs
    .filter((pair) => pair.in?.time || pair.out?.time)
    .map((pair) => `${pair.in?.time ?? '?'}–${pair.out?.time ?? '?'}`)
  return parts.length > 0 ? parts.join(', ') : '—'
}

export function CorrectionPunchesList({ review }: { review: PunchReview }) {
  return (
    <div className="overflow-x-auto" data-testid="correction-punches-list">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="pb-2 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">Employee</th>
            {review.dates.map((date) => (
              <th key={date} className="pb-2 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
                {dayHeading(date)}
              </th>
            ))}
            <th className="pb-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-400">Reg / OT</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {review.employees.map((employee) => (
            <tr key={employee.employeeId} className="align-top hover:bg-zinc-50/50">
              <td className="py-2 pr-4 text-zinc-900">
                <span className="font-mono text-zinc-500">{employee.employeeCode}</span>{' '}
                <span>{employee.employeeName}</span>
              </td>
              {employee.days.map((day) => (
                <td
                  key={day.date}
                  className={`py-2 pr-4 font-mono tabular-nums ${day.incomplete ? 'text-rose-600' : 'text-zinc-700'}`}
                >
                  {dayText(day)}
                  {day.incomplete && <span className="ml-1 font-sans text-rose-600">Needs fixing</span>}
                  {day.isEdited && <span className="ml-1 font-sans text-amber-600">Edited</span>}
                </td>
              ))}
              <td className="py-2 text-right font-mono tabular-nums text-zinc-900">
                {employee.totalRegularHours.toFixed(2)} / {employee.totalOvertimeHours.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
