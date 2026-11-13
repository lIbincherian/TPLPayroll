import type { CSSProperties } from 'react'
import Link from 'next/link'
import { ArrowLeft, PencilSimple, ClockCounterClockwise } from '@phosphor-icons/react/dist/ssr'
import { StatusBadge } from './StatusBadge'
import { WageHistoryTable } from './WageHistoryTable'
import { DeactivateDialog } from './DeactivateDialog'
import type { EmployeeRecord, WageHistoryEntry } from '@/features/employee-management/types/employee.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Detail row ───────────────────────────────────────────────────────────────

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </dt>
      <dd className="text-sm text-zinc-900">
        {value || <span className="text-zinc-400">—</span>}
      </dd>
    </>
  )
}

// ─── Section divider ─────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-medium text-zinc-900 mb-4">{children}</p>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface EmployeeProfileProps {
  employee: EmployeeRecord
  wageHistory: WageHistoryEntry[]
}

// ─── Compute status ───────────────────────────────────────────────────────────

function computeStatus(employee: { isActive: boolean; dateOfResignation: Date | null }) {
  if (employee.dateOfResignation) return 'RESIGNED' as const
  if (!employee.isActive) return 'INACTIVE' as const
  return 'ACTIVE' as const
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmployeeProfile({ employee, wageHistory }: EmployeeProfileProps) {
  const status = computeStatus(employee)
  const currentWage = wageHistory[0]

  return (
    <div className="space-y-0">
      {/* ── Back link ─────────────────────────────────────────────────────── */}
      <Link
        href="/employees"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors duration-200 mb-6"
      >
        <ArrowLeft size={16} />
        Back to directory
      </Link>

      {/* ── Header row ────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-0">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
              {employee.employeeName}
            </h1>
            <StatusBadge status={status} />
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-400">{employee.employeeId}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 shrink-0">
          <Link
            href={`/history?search=${employee.employeeId}`}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200/60 rounded-xl hover:bg-zinc-50 transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          >
            <ClockCounterClockwise size={15} />
            Payroll History
          </Link>
          <Link
            href={`/employees/${employee.id}/edit`}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200/60 rounded-xl hover:bg-zinc-50 transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          >
            <PencilSimple size={15} />
            Edit
          </Link>

          <DeactivateDialog
            employeeId={employee.id}
            employeeName={employee.employeeName}
            isCurrentlyActive={employee.isActive}
          />
        </div>
      </div>

      {/* ── Main content grid ──────────────────────────────────────────────── */}
      <div className="card-reveal grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-8 pt-8 border-t border-zinc-200/60">
        {/* Left column — Personal Details */}
        <div>
          <SectionTitle>Personal Details</SectionTitle>
          <dl className="grid grid-cols-2 gap-y-4 gap-x-8">
            <Detail label="Designation" value={employee.designation} />
            <Detail
              label="Designation Short"
              value={employee.designationShort}
            />
            <Detail label="Site" value={employee.site} />
            <Detail label="Phone" value={employee.phone} />
            <Detail label="Date of Birth" value={formatDate(employee.dateOfBirth)} />
            <Detail label="Date Joined" value={formatDate(employee.dateOfJoining)} />
            <Detail label="National ID" value={employee.nationalId} />
            <Detail label="Aadhaar ID" value={employee.aadhaarId} />
            <Detail label="Police Verif. ID" value={employee.policeVerificationId} />
            <Detail label="Health Card ID" value={employee.healthCardId} />
            {employee.dateOfResignation && (
              <>
                <dt className="text-xs font-medium uppercase tracking-wider text-rose-400">
                  Date of Resignation
                </dt>
                <dd className="text-sm text-rose-600">
                  {formatDate(employee.dateOfResignation)}
                </dd>
              </>
            )}
          </dl>
        </div>

        {/* Right column — Compensation + Payment */}
        <div className="space-y-0">
          {/* Compensation */}
          <div>
            <SectionTitle>Compensation</SectionTitle>
            <dl className="grid grid-cols-2 gap-y-4 gap-x-6">
              <Detail
                label="Daily Wage"
                value={
                  currentWage ? (
                    <span className="font-mono tabular-nums">
                      {formatCurrency(currentWage.weeklySalary)}
                    </span>
                  ) : undefined
                }
              />
              <Detail
                label="Hourly Rate"
                value={
                  currentWage ? (
                    <span className="font-mono tabular-nums">
                      {formatCurrency(currentWage.hourlyRate)}
                    </span>
                  ) : undefined
                }
              />
            </dl>
          </div>

          {/* Payment */}
          <div className="border-t border-zinc-200/60 pt-6 mt-6">
            <SectionTitle>Payment</SectionTitle>
            <dl className="grid grid-cols-1 gap-y-4">
              <Detail label="GPay" value={employee.gPay} />
              <Detail label="Bank Account" value={employee.bankAccount} />
            </dl>
          </div>
        </div>
      </div>

      {/* ── Wage History ───────────────────────────────────────────────────── */}
      <div
        className="card-reveal border-t border-zinc-200/60 pt-8 mt-8"
        style={{ '--index': 1 } as CSSProperties}
      >
        <SectionTitle>Wage History</SectionTitle>
        <WageHistoryTable entries={wageHistory} />
      </div>

    </div>
  )
}
