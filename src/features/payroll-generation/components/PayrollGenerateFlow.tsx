'use client'

import { useCallback, useState, useEffect, useTransition } from 'react'
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
  const [readinessError, setReadinessError] = useState<string | null>(null)

  // Step 1 data
  const [adjustments, setAdjustments] = useState<WeeklyReviewItem[]>([])

  // Step 2 data
  const [summary, setSummary] = useState<PayrollSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  // Step 3 data
  const [approvalResult, setApprovalResult] = useState<ApprovePayrollResult | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)

  const weekLabel = formatWeekLabel(weekStart, weekEnd)

  // ── Load Step 0 data ──────────────────────────────────────────────────────
  // Clears what step 0 holds first, so it shows the loading state and never the numbers of an earlier
  // attendance; a failed load is shown with a way to try again.
  const loadReadiness = useCallback(async () => {
    setReadiness(null)
    setReadinessError(null)
    try {
      const result = await checkAttendanceReadinessAction(weekStart, weekEnd)
      if (result.ok) setReadiness(result.data)
      else setReadinessError(result.error)
    } catch {
      setReadinessError("Couldn't load attendance. Try again.")
    }
  }, [weekStart, weekEnd])

  useEffect(() => {
    startTransition(async () => {
      await loadReadiness()
    })
  }, [loadReadiness])

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
      // summary can't be approved. What steps 0 and 1 hold was loaded from the old attendance, so it is
      // loaded again: the user reviews the adjustments of the attendance as it is now, or, when it is no
      // longer approved, goes back to the first step, which says why.
      if (result.code === 'ATTENDANCE_CHANGED' || result.code === 'ATTENDANCE_NOT_APPROVED') {
        setSummary(null)
        try {
          const [current, pending] = await Promise.all([
            checkAttendanceReadinessAction(weekStart, weekEnd),
            getPendingAdjustmentsForWeekAction(weekStart, weekEnd),
          ])
          if (!current.ok) {
            // The readiness did not come back: what step 0 holds is the old attendance, so it is loaded again
            // (and shows its own error with a way to try again if that fails too).
            setStep(0)
            void loadReadiness()
            return
          }
          setReadiness(current.data)
          if (pending.ok) setAdjustments(pending.data)
          setStep(current.data.ready && pending.ok ? 1 : 0)
        } catch {
          // The reload itself failed (e.g. a network error): never leave the user on the dead summary, and
          // never show the old attendance there. The first step loads it again and shows the approval error above it.
          setStep(0)
          void loadReadiness()
        }
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
        {step === 0 && approvalError && (
          <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {approvalError}
          </div>
        )}

        {step === 0 && (
          readinessError ? (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              <p>{readinessError}</p>
              <button
                type="button"
                onClick={() => startTransition(async () => { await loadReadiness() })}
                className="mt-3 inline-flex items-center rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-100 active:scale-[0.98]"
              >
                Try again
              </button>
            </div>
          ) : readiness == null ? (
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
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
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
                <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
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
