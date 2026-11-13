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
  'Bank Acct.',
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

const CELL = 'whitespace-nowrap border-b border-zinc-100 px-3 py-3'
// Emp Name stays in view while the wide table scrolls sideways; sticky cells need an opaque background.
const STICKY_NAME = 'sticky left-0 z-10'
const HEADER_CELL =
  'sticky top-0 z-10 whitespace-nowrap border-b border-zinc-200 bg-zinc-50 px-3 py-3 text-xs font-medium uppercase tracking-wider text-zinc-500'
const FOOTER_CELL = 'sticky bottom-0 z-10 whitespace-nowrap border-t-2 border-zinc-300 bg-zinc-50 px-3 py-3'

// Same order as the summary Excel (Emp ID ascending), so Sl No. matches in both.
function byEmployeeCode(a: EmployeePayrollRow, b: EmployeePayrollRow) {
  if (a.employeeCode < b.employeeCode) return -1
  if (a.employeeCode > b.employeeCode) return 1
  return 0
}
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
    <tr className="group bg-white transition-colors hover:bg-zinc-50">
      <td className={`${CELL} text-right`}>
        <span className="font-mono tabular-nums text-xs text-zinc-500">{slNo}</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.employeeCode}</span>
      </td>
      <td className={`${CELL} ${STICKY_NAME} bg-white transition-colors group-hover:bg-zinc-50`}>
        <span className="text-sm font-medium text-zinc-900">{row.employeeName}</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.gPay?.trim() || '—'}</span>
      </td>
      <td className={CELL}>
        {/* WhatsApp numbers aren't stored yet */}
        <span className={CODE}>—</span>
      </td>
      <td className={CELL}>
        <span className={CODE}>{row.bankAccount?.trim() || '—'}</span>
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
  const rows = [...summary.employees].sort(byEmployeeCode)

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
        <div
          role="region"
          aria-label="Payroll summary, scrolls sideways"
          tabIndex={0}
          className="max-h-[calc(100vh-16rem)] overflow-auto rounded-lg border border-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        >
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className={`${HEADER_CELL} ${h === 'Emp Name' ? 'left-0 z-20' : ''} ${
                      RIGHT_ALIGNED.includes(h) ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
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
              <tr>
                <td className={FOOTER_CELL} colSpan={2} />
                <td
                  className={`${FOOTER_CELL} left-0 z-20 text-xs font-semibold uppercase tracking-wider text-zinc-500`}
                >
                  Total
                </td>
                <td className={FOOTER_CELL} colSpan={6} />
                {[
                  totals.totalRegularPay,
                  totals.totalOvertimePay,
                  totals.totalAdditions,
                  totals.totalDeductions,
                ].map((amount, i) => (
                  <td key={i} className={`${FOOTER_CELL} text-right font-mono tabular-nums text-sm font-semibold text-zinc-900`}>
                    ₹{fmt(amount)}
                  </td>
                ))}
                <td className={`${FOOTER_CELL} text-right font-mono tabular-nums text-sm font-bold text-zinc-900`}>
                  ₹{fmt(totals.totalNetPayable)}
                </td>
                <td className={FOOTER_CELL} colSpan={2} />
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
