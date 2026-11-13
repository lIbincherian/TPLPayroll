'use client'

import { useState } from 'react'
import { ArrowLeft, WarningCircle } from '@phosphor-icons/react'
import type { PayrollSummary, EmployeePayrollRow } from '@/features/payroll-generation/types/payroll.types'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtHours(h: number) {
  return h.toFixed(2)
}

// ─── Table columns ────────────────────────────────────────────────────────────

const HEADERS = [
  'ID',
  'Name',
  'GPay',
  'Bank Acct.',
  'Net Payable',
]

function EmployeeRow({ row }: { row: EmployeePayrollRow }) {
  return (
    <tr className="transition-colors hover:bg-zinc-50/80">
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-zinc-500">{row.employeeCode}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm font-medium text-zinc-900">{row.employeeName}</span>
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-zinc-500">{row.gPay ?? '—'}</span>
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-zinc-500">{row.bankAccount ?? '—'}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="font-mono tabular-nums text-sm font-semibold text-zinc-900">
          ₹{formatNetPay(row.netPayable)}
        </span>
      </td>
    </tr>
  )
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  onConfirm,
  onCancel,
  loading,
}: {
  onConfirm: () => void
  onCancel: () => void
  loading: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <WarningCircle size={22} weight="fill" className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <h3 className="text-base font-semibold text-zinc-900">Approve this payroll run?</h3>
            <p className="mt-1 text-sm text-zinc-500">This action cannot be reversed.</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50"
          >
            {loading ? 'Approving…' : 'Confirm Approval'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── PayrollSummaryStep ───────────────────────────────────────────────────────

interface Props {
  weekLabel: string
  summary: PayrollSummary
  onBack: () => void
  onApprove: () => Promise<void>
}

export function PayrollSummaryStep({ weekLabel, summary, onBack, onApprove }: Props) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [approving, setApproving] = useState(false)

  const handleConfirm = async () => {
    setApproving(true)
    try {
      await onApprove()
    } finally {
      setApproving(false)
      setShowConfirm(false)
    }
  }

  const { totals } = summary

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
          loading={approving}
        />
      )}

      <div className="space-y-6">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">Payroll Summary</h2>
          <p className="mt-1 text-sm text-zinc-500">{weekLabel}</p>
        </div>

        {/* ── Summary table ───────────────────────────────────────────── */}
        <div className="overflow-x-auto">
          <table className="w-full divide-y divide-zinc-100 text-sm">
            <thead className="bg-zinc-50/50">
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    className={`whitespace-nowrap px-4 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 ${
                      ['Net Payable'].includes(h)
                        ? 'text-right'
                        : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {summary.employees.map((row) => (
                <EmployeeRow key={row.employeeId} row={row} />
              ))}
            </tbody>
            {/* ── Totals row ─────────────────────────────────────────── */}
            <tfoot>
              <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold">
                <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500" colSpan={4}>
                  Total
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-sm font-bold text-zinc-900">
                  ₹{formatNetPay(totals.totalNetPayable)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 active:scale-[0.98]"
          >
            <ArrowLeft size={16} weight="bold" />
            Back
          </button>
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 active:scale-[0.98]"
          >
            Approve Payroll
          </button>
        </div>
      </div>
    </>
  )
}
