'use client'

import type { RevisionHistoryItem } from '@/features/payroll-correction/types/correction.types'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

interface RevisionHistoryTableProps {
  revisions: RevisionHistoryItem[]
}

function formatDate(date: Date | null) {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}

export function RevisionHistoryTable({ revisions }: RevisionHistoryTableProps) {
  if (revisions.length === 0) return null

  return (
    <section className="border-t border-zinc-200/60 pt-8 mt-8">
      <p className="text-sm font-medium text-zinc-900 mb-4">Revision History</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono tabular-nums">
          <thead>
            <tr className="border-b border-zinc-200">
              {['Rev', 'Status', 'Correction Reason', 'Total', 'Date'].map((h) => (
                <th
                  key={h}
                  className="pb-2 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {revisions.map((rev) => (
              <tr key={rev.revisionId} className="hover:bg-zinc-50/50">
                <td className="py-2.5 pr-4 font-mono text-sm font-medium text-zinc-900">
                  {rev.revisionNumber}
                </td>
                <td className="py-2.5 pr-4">
                  {rev.isCurrent ? (
                    <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      Current
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-400 line-through">
                      Superseded
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-4 font-sans text-sm text-zinc-500">
                  {rev.correctionReason ?? '—'}
                </td>
                <td className="py-2.5 pr-4 font-mono tabular-nums text-zinc-800">
                  ₹{formatNetPay(rev.totalNetPayable)}
                </td>
                <td className="py-2.5 text-sm text-zinc-500">
                  {formatDate(rev.approvedAt ?? rev.generatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
