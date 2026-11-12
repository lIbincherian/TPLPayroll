'use client'

import { useState } from 'react'
import { ArrowLeft, WarningCircle } from '@phosphor-icons/react'
import type { PayrollSummary, EmployeePayrollRow } from '@/features/payroll-generation/types/payroll.types'
import { paymentReference, toISODate } from '@/features/attendance-sync/lib/week'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

// ─── Table columns ────────────────────────────────────────────────────────────

// Salary dates are stored at UTC midnight, so format them in UTC.
function fmtDate(date: Date) {
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const HEADERS = [
  'Sl No.',
  'Emp ID',
  'Emp Name',
  'GPay No.',
  'WhatsApp No.',
  'Paid Name (if diff.)',
  'Salary from',
  'Salary to',
  'Reg. Hrs Pay',
  'Overtime Hrs Pay',
  'Additions',
  'Deductions',
  'Net Pay',
  'Payment Date',
  'Payment Reference',
]

const AMOUNT_HEADERS = ['Reg. Hrs Pay', 'Overtime Hrs Pay', 'Additions', 'Deductions', 'Net Pay']
const RIGHT_ALIGNED = ['Sl No.', ...AMOUNT_HEADERS]

const CELL = 'whitespace-nowrap px-3 py-3'
const CODE = 'font-mono text-xs text-zinc-500'
const AMOUNT = 'font-mono tabular-nums text-sm text-zinc-700'

function EmployeeRow({
  row,
  slNo,
  salaryFrom,
  salaryTo,
  weekStartISO,
}: {
  row: EmployeePayrollRow
  slNo: number
  salaryFrom: string
  salaryTo: string
  weekStartISO: string
}) {
  return (
    <tr className="transition-colors hover:bg-zinc-50/80">
      <td className={`${CELL} text-right`}>
        <span className="font-mono tabular-nums text-xs text-zinc-500">{slNo}</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.employeeCode}</span>
      </td>
      <td className={CELL}>
        <span className="text-sm font-medium text-zinc-900">{row.employeeName}</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.gPay?.trim() || '—'}</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.phone?.trim() || '—'}</span>
      </td>
      <td className={CELL} />
      <td className={CELL}>
        <span className="text-sm text-zinc-700">{salaryFrom}</span>
      </td>
      <td className={CELL}>
        <span className="text-sm text-zinc-700">{salaryTo}</span>
      </td>
      <td className={`${CELL} text-right`}>
        <span className={AMOUNT}>₹{fmt(row.regularPay)}</span>
      </td>
      <td className={`${CELL} text-right`}>
        <span className={AMOUNT}>₹{fmt(row.overtimePay)}</span>
      </td>
      <td className={`${CELL} text-right`}>
        <span className={AMOUNT}>₹{fmt(row.additions)}</span>
      </td>
      <td className={`${CELL} text-right`}>
        <span className={AMOUNT}>₹{fmt(row.deductions)}</span>
      </td>
      <td className={`${CELL} text-right`}>
        <span className="font-mono tabular-nums text-sm font-semibold text-zinc-900">
          ₹{fmt(row.netPayable)}
        </span>
      </td>
      <td className={CELL} />
      <td className={CELL}>
        <span className={CODE}>{paymentReference(weekStartISO, row.employeeCode)}</span>
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
  const salaryFrom = fmtDate(summary.weekStart)
  const salaryTo = fmtDate(summary.weekEnd)
  const weekStartISO = toISODate(new Date(summary.weekStart))

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
                    className={`whitespace-nowrap px-3 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400 ${
                      RIGHT_ALIGNED.includes(h) ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {summary.employees.map((row, i) => (
                <EmployeeRow
                  key={row.employeeId}
                  row={row}
                  slNo={i + 1}
                  salaryFrom={salaryFrom}
                  salaryTo={salaryTo}
                  weekStartISO={weekStartISO}
                />
              ))}
            </tbody>
            {/* ── Totals row ─────────────────────────────────────────── */}
            <tfoot>
              <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold">
                <td className={`${CELL} text-xs font-semibold uppercase tracking-wider text-zinc-500`} colSpan={8}>
                  Total
                </td>
                {[
                  totals.totalRegularPay,
                  totals.totalOvertimePay,
                  totals.totalAdditions,
                  totals.totalDeductions,
                ].map((amount, i) => (
                  <td key={i} className={`${CELL} text-right font-mono tabular-nums text-sm text-zinc-900`}>
                    ₹{fmt(amount)}
                  </td>
                ))}
                <td className={`${CELL} text-right font-mono tabular-nums text-sm font-bold text-zinc-900`}>
                  ₹{fmt(totals.totalNetPayable)}
                </td>
                <td className={CELL} colSpan={2} />
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
