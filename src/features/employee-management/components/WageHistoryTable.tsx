import type { WageHistoryEntry } from '@/features/employee-management/types/employee.types'

interface WageHistoryTableProps {
  entries: WageHistoryEntry[]
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount)
}

function SourceBadge({ source }: { source: string }) {
  const isManual = source.toUpperCase() === 'MANUAL'
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        isManual
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-zinc-100 text-zinc-500'
      }`}
    >
      {source}
    </span>
  )
}

export function WageHistoryTable({ entries }: WageHistoryTableProps) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-zinc-400 py-4">No wage history available.</p>
    )
  }

  return (
    <div className="overflow-x-auto -mx-0">
      <table className="w-full">
        <thead>
          <tr>
            <th className="pb-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Effective From
            </th>
            <th className="pb-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Effective To
            </th>
            <th className="pb-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Daily Wage
            </th>
            <th className="pb-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Hourly Rate
            </th>
            <th className="pb-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Source
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="py-3 pr-4 text-sm text-zinc-600">
                {formatDate(entry.effectiveFrom)}
              </td>
              <td className="py-3 pr-4 text-sm text-zinc-600">
                {entry.effectiveTo ? formatDate(entry.effectiveTo) : (
                  <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                    Current
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 font-mono tabular-nums text-sm text-zinc-800">
                {formatCurrency(entry.weeklySalary)}
              </td>
              <td className="py-3 pr-4 font-mono tabular-nums text-sm text-zinc-800">
                {formatCurrency(entry.hourlyRate)}
              </td>
              <td className="py-3">
                <SourceBadge source={entry.changeSource} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

    </div>
  )
}
