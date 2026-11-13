import Link from 'next/link'
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr'
import { PayrollRecordDetail } from '../types/payroll-history.types'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

interface PayrollRecordDetailViewProps {
  record: PayrollRecordDetail
}

export function PayrollRecordDetailView({ record }: PayrollRecordDetailViewProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount)
  }

  const formatHours = (hours: number) => hours.toFixed(2)

  const formatWeek = (start: Date, end: Date) => {
    return `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
  }

  return (
    <div className="w-full max-w-[1400px] mx-auto space-y-8 pb-16">
      <Link
        href="/history"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors duration-200"
      >
        <ArrowLeft size={16} />
        Back to history
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
          {record.employeeName}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-zinc-500">
            Week {formatWeek(record.weekStart, record.weekEnd)}
          </p>
          <span className="bg-emerald-50 text-emerald-700 rounded-full text-xs px-2.5 py-0.5 font-medium border border-emerald-100">
            Revision {record.revisionNumber} {record.isCurrent && '(Current)'}
          </span>
        </div>
      </div>

      {/* Employee Info Header */}
      <div className="flex flex-wrap items-center gap-6 border-t border-zinc-200/60 pt-6">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400">ID</dt>
          <dd className="text-sm font-mono text-zinc-900">{record.employeeIdString}</dd>
        </div>
        <div className="w-px h-8 bg-zinc-200 hidden sm:block"></div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400">Designation</dt>
          <dd className="text-sm text-zinc-900">{record.designation}</dd>
        </div>
        <div className="w-px h-8 bg-zinc-200 hidden sm:block"></div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400">Hourly Rate</dt>
          <dd className="text-sm font-mono tabular-nums text-zinc-900">{formatCurrency(record.hourlyRate)}</dd>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-8 xl:gap-12 pt-4">
        {/* Left Column - Attendance */}
        <div>
          <h2 className="text-sm font-medium text-zinc-900 mb-4 border-t border-zinc-200/60 pt-6">Attendance</h2>
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left divide-y divide-zinc-100">
              <thead>
                <tr>
                  <th className="py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Day</th>
                  <th className="py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Date</th>
                  <th className="py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right pr-4">Reg Hrs</th>
                  <th className="py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right pr-4">OT Hrs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {record.attendance.map((day, i) => (
                  <tr key={i}>
                    <td className="py-3 text-sm text-zinc-600">
                      {day.date.toLocaleDateString('en-IN', { weekday: 'long' })}
                    </td>
                    <td className="py-3 text-sm text-zinc-500">
                      {day.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </td>
                    <td className="py-3 text-sm font-mono tabular-nums text-zinc-800 text-right pr-4">
                      {formatHours(day.regularHours)}
                    </td>
                    <td className="py-3 text-sm font-mono tabular-nums text-zinc-800 text-right pr-4">
                      {formatHours(day.overtimeHours)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-zinc-300 bg-zinc-50/50">
                <tr>
                  <td colSpan={2} className="py-3 text-sm font-semibold text-zinc-900 px-4">TOTAL</td>
                  <td className="py-3 text-sm font-mono tabular-nums font-semibold text-zinc-900 text-right pr-4">
                    {formatHours(record.totalRegularHours)}
                  </td>
                  <td className="py-3 text-sm font-mono tabular-nums font-semibold text-zinc-900 text-right pr-4">
                    {formatHours(record.totalOvertimeHours)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Right Column - Earnings */}
        <div className="space-y-8">
          <div>
            <h2 className="text-sm font-medium text-zinc-900 mb-4 border-t border-zinc-200/60 pt-6">Earnings</h2>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-xs text-zinc-400">Regular Pay</dt>
                <dd className="text-sm font-mono tabular-nums text-zinc-800">{formatCurrency(record.regularPay)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-xs text-zinc-400">Overtime Pay</dt>
                <dd className="text-sm font-mono tabular-nums text-zinc-800">{formatCurrency(record.overtimePay)}</dd>
              </div>
              <div className="flex justify-between border-t border-zinc-100 pt-3 mt-1">
                <dt className="text-xs font-medium text-zinc-500">Gross Pay</dt>
                <dd className="text-sm font-mono tabular-nums font-semibold text-zinc-900">{formatCurrency(record.grossPay)}</dd>
              </div>
            </dl>
          </div>

          <div>
            <h2 className="text-sm font-medium text-zinc-900 mb-4 border-t border-zinc-200/60 pt-6">Adjustments</h2>
            {record.adjustments.length > 0 ? (
              <table className="w-full text-left divide-y divide-zinc-100">
                <thead>
                  <tr>
                    <th className="py-2 text-xs font-medium uppercase tracking-wider text-zinc-400">Type</th>
                    <th className="py-2 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right pr-4">Amount</th>
                    <th className="py-2 text-xs font-medium uppercase tracking-wider text-zinc-400 pl-4">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {record.adjustments.map((adj, i) => (
                    <tr key={i}>
                      <td className={`py-3 text-xs font-medium uppercase tracking-wider ${adj.type === 'ADDITION' ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {adj.type === 'ADDITION' ? 'Addition' : 'Deduction'}
                      </td>
                      <td className={`py-3 text-sm font-mono tabular-nums text-right pr-4 ${adj.type === 'ADDITION' ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {adj.type === 'ADDITION' ? '+' : '-'}{formatCurrency(adj.amount)}
                      </td>
                      <td className="py-3 text-sm text-zinc-600 pl-4">
                        {adj.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-zinc-400">No adjustments for this period.</p>
            )}
          </div>

          <div className="border-t-2 border-zinc-300 pt-6 mt-8">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-2">Net Payable</h2>
            <p className="text-3xl font-mono tabular-nums font-semibold text-zinc-900">
              ₹{formatNetPay(record.netPayable)}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
