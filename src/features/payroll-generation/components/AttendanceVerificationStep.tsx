'use client'

import Link from 'next/link'
import { CheckCircle, WarningCircle, ArrowRight } from '@phosphor-icons/react'
import type { AttendanceReadinessResult } from '@/features/payroll-generation/types/payroll.types'

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-6 first:pl-0">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-zinc-900">{value}</p>
    </div>
  )
}

interface Props {
  weekId: string
  weekLabel: string
  readiness: AttendanceReadinessResult
  onContinue: () => void
}

type NotReadyReason = Extract<AttendanceReadinessResult, { ready: false }>['reason']

function notReadyCopy(reason: NotReadyReason, weekId: string): { message: string; linkText: string; href: string } {
  switch (reason) {
    case 'SYNC_FAILED':
      return { message: 'The eTimeOffice sync failed for this week', linkText: 'Go to Attendance', href: '/attendance' }
    case 'NOT_APPROVED':
      return {
        message: "Attendance for this week isn't approved yet",
        linkText: 'Review punches',
        href: `/attendance/${weekId}/review`,
      }
    case 'EXCEL_ERA':
      return {
        message: "This week was imported from Excel and can't start payroll",
        linkText: 'Go to Attendance',
        href: '/attendance',
      }
    default:
      return { message: 'No attendance loaded for this week', linkText: 'Go to Attendance', href: '/attendance' }
  }
}

export function AttendanceVerificationStep({ weekId, weekLabel, readiness, onContinue }: Props) {
  return (
    <div className="space-y-6">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">Verify Attendance</h2>
        <p className="mt-1 text-sm text-zinc-500">{weekLabel}</p>
      </div>

      {/* ── Status alert ─────────────────────────────────────────────── */}
      {!readiness.ready ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200/60 bg-amber-50 p-4">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex flex-col gap-1">
            {(() => {
              const copy = notReadyCopy(readiness.reason, weekId)
              return (
                <>
                  <p className="text-sm font-medium text-amber-800">{copy.message}</p>
                  <Link
                    href={copy.href}
                    className="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
                  >
                    {copy.linkText} →
                  </Link>
                </>
              )
            })()}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-emerald-50 p-4">
            <CheckCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-emerald-500" />
            <p className="text-sm font-medium text-emerald-700">
              Attendance approved: {readiness.matchedEmployeeCount} employees, {readiness.leftOutCount} left out
            </p>
          </div>

          {/* ── Quick stats ──────────────────────────────────────────── */}
          <div className="flex divide-x divide-zinc-200/60 border-b border-t border-zinc-200/60 py-4">
            <StatBlock label="Total Employees" value={readiness.matchedEmployeeCount} />
            <StatBlock label="Total Regular Hrs" value={readiness.totalRegularHours.toFixed(2)} />
            <StatBlock label="Total Overtime Hrs" value={readiness.totalOvertimeHours.toFixed(2)} />
          </div>

          {/* ── Actions ──────────────────────────────────────────────── */}
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onContinue}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 active:scale-[0.98]"
            >
              Continue
              <ArrowRight size={16} weight="bold" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
