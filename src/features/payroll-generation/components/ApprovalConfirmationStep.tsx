'use client'

import Link from 'next/link'
import { CheckCircle } from '@phosphor-icons/react'
import type { ApprovePayrollResult } from '@/features/payroll-generation/types/payroll.types'
import { ReportSection } from '@/features/payroll-reports/components/ReportSection'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

interface Props {
  weekLabel: string
  result: ApprovePayrollResult
}

export function ApprovalConfirmationStep({ weekLabel, result }: Props) {
  return (
    <div className="py-12 text-center">
      {/* ── Icon ─────────────────────────────────────────────────────── */}
      <CheckCircle
        size={48}
        weight="fill"
        className="mx-auto text-emerald-500"
        style={{ animation: 'scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards' }}
      />

      {/* ── Heading ──────────────────────────────────────────────────── */}
      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900">Payroll Approved</h2>

      {/* ── Stats ────────────────────────────────────────────────────── */}
      <div className="mx-auto mt-6 inline-flex flex-col items-center gap-1.5">
        <p className="text-sm text-zinc-500">{weekLabel}</p>
        <p className="font-mono text-sm tabular-nums text-zinc-600">
          {result.employeeCount} employees
        </p>
        <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900">
          ₹{formatNetPay(result.totalNetPayable)}
        </p>
      </div>

      {/* ── Reports section (F07) ──────────────────────────────── */}
      <div className="mt-8 mx-auto max-w-lg text-left">
        <ReportSection
          payrollRunId={result.payrollRunId}
          employeeCount={result.employeeCount}
        />
      </div>

      {/* ── Back link ────────────────────────────────────────────────── */}
      <div className="mt-4">
        <Link
          href="/payroll"
          className="text-sm text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-700 hover:underline"
        >
          Back to Payroll
        </Link>
      </div>

      <style>{`
        @keyframes scaleIn {
          from { transform: scale(0.8); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
