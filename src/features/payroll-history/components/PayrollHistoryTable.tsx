'use client'

import Link from 'next/link'
import { PayrollHistoryRow } from '../types/payroll-history.types'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

interface PayrollHistoryTableProps {
  rows: PayrollHistoryRow[]
}

export function PayrollHistoryTable({ rows }: PayrollHistoryTableProps) {
  const formatWeek = (start: Date, end: Date) => {
    return `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(amount)
  }

  const formatHours = (hours: number) => {
    return hours.toFixed(2)
  }

  if (rows.length === 0) {
    return (
      <div className="py-12 flex flex-col items-center justify-center text-center">
        <svg className="w-12 h-12 text-zinc-200 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-lg font-medium text-zinc-600">No payroll history found</p>
        <p className="text-sm text-zinc-400 mt-1">Approved payroll runs will appear here</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto w-full">
      <table className="w-full text-left divide-y divide-zinc-100">
        <thead>
          <tr className="bg-zinc-50/50">
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Week</th>
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Employee</th>
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right">Reg Hrs</th>
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right">OT Hrs</th>
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right">Gross</th>
            <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 bg-white">
          {rows.map((row, index) => (
            <tr 
              key={row.recordId} 
              className="hover:bg-zinc-50/80 transition-colors group cursor-pointer"
              style={{ animationDelay: `calc(${index} * 60ms)` }}
            >
              <td className="px-6 py-4 whitespace-nowrap">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <span className="text-sm text-zinc-900">
                    {formatWeek(row.weekStart, row.weekEnd)}
                  </span>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-zinc-900">{row.employeeName}</span>
                    <span className="text-xs text-zinc-400 font-mono">{row.employeeIdString}</span>
                  </div>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <span className="font-mono tabular-nums text-sm text-zinc-800">{formatHours(row.regularHours)}</span>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <span className="font-mono tabular-nums text-sm text-zinc-800">{formatHours(row.overtimeHours)}</span>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <span className="font-mono tabular-nums text-sm text-zinc-800">{formatCurrency(row.grossPay)}</span>
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <Link href={`/history/${row.recordId}`} className="block w-full">
                  <span className="font-mono tabular-nums text-sm font-medium text-emerald-600">₹{formatNetPay(row.netPayable)}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
