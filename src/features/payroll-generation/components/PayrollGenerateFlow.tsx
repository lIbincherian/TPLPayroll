'use client'

import { useState, useEffect, useTransition } from 'react'
import { StepIndicator } from './StepIndicator'
import { AttendanceVerificationStep } from './AttendanceVerificationStep'
import { AdjustmentReviewStepWrapper } from './AdjustmentReviewStepWrapper'
import { PayrollSummaryStep } from './PayrollSummaryStep'
import { ApprovalConfirmationStep } from './ApprovalConfirmationStep'
import {
  checkAttendanceReadinessAction,
  getPendingAdjustmentsForWeekAction,
  calculatePayrollAction,
  approvePayrollAction,
} from '@/features/payroll-generation/actions/payroll.actions'
import type {
  AttendanceReadinessResult,
  PayrollSummary,
  ApprovePayrollResult,
} from '@/features/payroll-generation/types/payroll.types'
import type { WeeklyReviewItem } from '@/features/payroll-adjustments/types/adjustment.types'

// ─── Step definitions ─────────────────────────────────────────────────────────

const STEPS = [
  { label: 'Attendance' },
  { label: 'Adjustments' },
  { label: 'Summary' },
  { label: 'Approve' },
]

// ─── Week label helper ────────────────────────────────────────────────────────

function formatWeekLabel(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  return `${start.toLocaleDateString('en-IN', opts)} – ${end.toLocaleDateString('en-IN', opts)}`
}

// ─── PayrollGenerateFlow ──────────────────────────────────────────────────────

interface Props {
  weekStart: Date
  weekEnd: Date
}

export function PayrollGenerateFlow({ weekStart, weekEnd }: Props) {
  const [step, setStep] = useState(0)
  const [, startTransition] = useTransition()

  // Step 0 data
  const [readiness, setReadiness] = useState<AttendanceReadinessResult | null>(null)

  // Step 1 data
  const [adjustments, setAdjustments] = useState<WeeklyReviewItem[]>([])

  // Step 2 data
  const [summary, setSummary] = useState<PayrollSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  // Step 3 data
  const [approvalResult, setApprovalResult] = useState<ApprovePayrollResult | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)

  const weekLabel = formatWeekLabel(weekStart, weekEnd)

  // ── Load Step 0 data on mount ─────────────────────────────────────────────
  useEffect(() => {
    startTransition(async () => {
      const result = await checkAttendanceReadinessAction(weekStart, weekEnd)
      if (result.ok) setReadiness(result.data)
    })
  }, [weekStart, weekEnd])

  // ── Step 0 → 1: load pending adjustments ─────────────────────────────────
  const handleAttendanceContinue = () => {
    startTransition(async () => {
      const result = await getPendingAdjustmentsForWeekAction(weekStart, weekEnd)
      if (result.ok) {
        setAdjustments(result.data)
        setStep(1)
      }
    })
  }

  // ── Step 1 → 2: calculate payroll ────────────────────────────────────────
  const handleAdjustmentsContinue = () => {
    startTransition(async () => {
      setSummaryError(null)
      setApprovalError(null)
      const result = await calculatePayrollAction(weekStart, weekEnd)
      if (result.ok) {
        setSummary(result.data)
        setStep(2)
      } else {
        setSummaryError(result.error)
        setStep(2)
      }
    })
  }

  // ── Step 2 → 3: approve payroll ───────────────────────────────────────────
  const handleApprove = async () => {
    if (!summary) return
    setApprovalError(null)
    const result = await approvePayrollAction(summary)
    if (result.ok) {
      setApprovalResult(result.data)
      setStep(3)
    } else {
      setApprovalError(result.error)
      // The attendance changed (or was reopened) since this summary was calculated, so the
      // summary can't be approved. Send the user back to calculate it again.
      if (result.code === 'ATTENDANCE_CHANGED' || result.code === 'ATTENDANCE_NOT_APPROVED') {
        setSummary(null)
        setStep(1)
      }
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Step indicator ───────────────────────────────────────────── */}
      <div className="overflow-x-auto pb-2">
        <StepIndicator steps={STEPS} currentStep={step} />
      </div>

      {/* ── Step content ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-zinc-200/60 bg-white p-6 shadow-sm">
        {/* key={step} re-mounts on each step change → replays step-enter */}
        <div key={step} className="step-enter">
        {step === 0 && (
          readiness == null ? (
            <div className="space-y-4">
              <div className="h-6 w-48 rounded skeleton-shimmer" />
              <div className="h-4 w-32 rounded skeleton-shimmer" />
              <div className="h-20 rounded-xl skeleton-shimmer" />
            </div>
          ) : (
            <AttendanceVerificationStep
              weekId={weekStart.toISOString().slice(0, 10)}
              weekLabel={weekLabel}
              readiness={readiness}
              onContinue={handleAttendanceContinue}
            />
          )
        )}

        {step === 1 && (
          <>
            {approvalError && (
              <div
                role="alert"
                className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
              >
                {approvalError}
              </div>
            )}
            <AdjustmentReviewStepWrapper
              weekStart={weekStart}
              weekEnd={weekEnd}
              adjustments={adjustments}
              onContinue={handleAdjustmentsContinue}
            />
          </>
        )}

        {step === 2 && (
          summaryError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {summaryError}
            </div>
          ) : summary == null ? (
            <div className="space-y-4">
              <div className="h-6 w-48 rounded skeleton-shimmer" />
              <div className="h-64 rounded-xl skeleton-shimmer" />
            </div>
          ) : (
            <>
              {approvalError && (
                <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {approvalError}
                </div>
              )}
              <PayrollSummaryStep
                weekLabel={weekLabel}
                summary={summary}
                onBack={() => setStep(1)}
                onApprove={handleApprove}
              />
            </>
          )
        )}

        {step === 3 && approvalResult && (
          <ApprovalConfirmationStep weekLabel={weekLabel} result={approvalResult} />
        )}
        </div>
      </div>
    </div>
  )
}
