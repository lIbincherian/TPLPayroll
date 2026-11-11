'use client'

import { useState, useTransition, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, CircleNotch } from '@phosphor-icons/react'
import type { InitiateCorrectionResult, CorrectionType } from '@/features/payroll-correction/types/correction.types'
import { recalculateAndCreateRevisionAction } from '@/features/payroll-correction/actions/correction.actions'

import {
  approveAdjustmentApplicationAction,
  skipAdjustmentApplicationAction,
} from '@/features/payroll-adjustments/actions/adjustment.actions'

import { AttendanceDropzone } from '@/features/attendance-upload/components/AttendanceDropzone'
import { WeekSelectionDialog } from '@/features/attendance-upload/components/WeekSelectionDialog'
import { EmployeeVerificationDialog } from '@/features/attendance-upload/components/EmployeeVerificationDialog'
import type { VerificationDialogState } from '@/features/attendance-upload/components/EmployeeVerificationDialog'
import type { InitialDialogState } from '@/features/attendance-upload/components/AttendanceUploadClient'
import {
  parseFromStorageWithDatesAction,
  finalizeAttendanceUploadAction,
  getEmployeesForMatchingAction,
} from '@/features/attendance-upload/actions/attendance.actions'
import type {
  MatchedAttendanceRecord,
  PayrollWeekSource,
  ImportSummary,
  VerificationDecision,
} from '@/features/attendance-upload/types/attendance.types'
import type { EmployeeOption } from '@/features/attendance-upload/actions/attendance.actions'

// ─── Types ────────────────────────────────────────────────────────────────────

type DialogState =
  | { type: 'none' }
  | {
      type: 'week_required'
      storageKey: string
      fileName: string
      fileType: string
    }
  | {
      type: 'verify_required'
      records: MatchedAttendanceRecord[]
      summary: ImportSummary
      payrollWeekStartDate: string
      payrollWeekEndDate: string
      payrollWeekSource: PayrollWeekSource
      storageKey: string
      fileName: string
      fileType: string
      initialState?: VerificationDialogState
      pendingOnboardBlockKeys?: string[]
    }

// ─── Props ────────────────────────────────────────────────────────────────────

interface CorrectionFlowProps {
  data: InitiateCorrectionResult
  weekLabel: string
  initialDialogState?: InitialDialogState | null
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CorrectionFlow({ data, weekLabel, initialDialogState }: CorrectionFlowProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [correctionReason, setCorrectionReason] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<Set<CorrectionType>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' })
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])

  const expectedWeekStartISO = new Date(data.weekStart).toISOString().slice(0, 10)
  const expectedWeekEndISO = new Date(data.weekEnd).toISOString().slice(0, 10)

  const hydratedFromSession = useRef(false)

  const loadEmployeeOptions = useCallback(async (records: MatchedAttendanceRecord[]) => {
    if (!records.some((r) => r.matchStatus === 'UNMATCHED')) return
    const result = await getEmployeesForMatchingAction()
    if (result.ok) setEmployeeOptions(result.data)
  }, [])

  // ── Hydrate from server-provided session resume ────────────────────────────
  useEffect(() => {
    if (hydratedFromSession.current) return
    if (!initialDialogState) return
    hydratedFromSession.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from server-provided session-resume props (guarded by hydratedFromSession)
    setSelectedTypes(new Set(['ATTENDANCE'])) // Auto-select Attendance option when resuming
    // initialDialogState is lean (no records[]) — records are fetched client-side
    // by the attendanceSession resume flow before CorrectionFlow mounts.
    // If records happen to be provided (legacy path), still use storageKey.
    setDialog({
      type: 'week_required',
      storageKey: initialDialogState.storageKey,
      fileName: initialDialogState.fileName,
      fileType: initialDialogState.fileType,
    })
    // Clear resume params from URL so a refresh doesn't re-trigger resume.
    const params = new URLSearchParams(window.location.search)
    if (params.has('resumeSession') || params.has('newEmployeeId')) {
      params.delete('resumeSession')
      params.delete('newEmployeeId')
      const qs = params.toString()
      router.replace(qs ? `/payroll/run/${data.payrollRunId}/correct?${qs}` : `/payroll/run/${data.payrollRunId}/correct`)
    }
  }, [initialDialogState, loadEmployeeOptions, router, data.payrollRunId])

  const handleWeekRequired = useCallback(
    (storageKey: string, fileName: string, fileType: string) => {
      setDialog({ type: 'week_required', storageKey, fileName, fileType })
    },
    []
  )

  const handleVerificationRequired = useCallback(
    (payload: {
      records: MatchedAttendanceRecord[]
      summary: ImportSummary
      payrollWeekStartDate: string
      payrollWeekEndDate: string
      payrollWeekSource: PayrollWeekSource
      storageKey: string
      fileName: string
      fileType: string
    }) => {
      loadEmployeeOptions(payload.records)
      setDialog({ type: 'verify_required', ...payload })
    },
    [loadEmployeeOptions]
  )

  const handleWeekConfirm = useCallback(
    async (startDate: string, endDate: string) => {
      if (dialog.type !== 'week_required') return
      const { storageKey, fileName, fileType } = dialog
      setDialog({ type: 'none' })
      setError(null)

      if (startDate !== expectedWeekStartISO || endDate !== expectedWeekEndISO) {
        setError('The uploaded attendance file is for a different week. Please upload the correct file for this payroll run.')
        return
      }

      const result = await parseFromStorageWithDatesAction(
        storageKey,
        startDate,
        endDate,
        fileName,
        fileType
      )

      if (!result.ok) {
        setError(result.error)
        return
      }

      const needsVerification = result.data.records.some(
        (r) =>
          r.matchStatus === 'UNMATCHED' ||
          r.matchStatus === 'INACTIVE' ||
          r.matchStatus === 'RESIGNED_BEFORE_WEEK'
      )

      if (needsVerification) {
        loadEmployeeOptions(result.data.records)
        setDialog({
          type: 'verify_required',
          records: result.data.records,
          summary: result.data.summary,
          payrollWeekStartDate: startDate,
          payrollWeekEndDate: endDate,
          payrollWeekSource: 'MANUAL',
          storageKey,
          fileName,
          fileType,
        })
        return
      }

      const finalResult = await finalizeAttendanceUploadAction({
        storageKey,
        fileName,
        fileType,
        payrollWeekStartDate: startDate,
        payrollWeekEndDate: endDate,
        payrollWeekSource: 'MANUAL',
      })

      if (!finalResult.ok) {
        setError(finalResult.error)
        return
      }

      setUploadedFileId(finalResult.data.uploadId)
    },
    [dialog, loadEmployeeOptions, expectedWeekStartISO, expectedWeekEndISO]
  )

  const handleVerificationConfirm = useCallback(
    async (
      decisions: Record<string, VerificationDecision>,
      manualMatchDecisions: Record<string, string>,
      rejectedBlockKeys: string[]
    ) => {
      if (dialog.type !== 'verify_required') return
      const { storageKey, fileName, fileType, payrollWeekStartDate, payrollWeekEndDate, payrollWeekSource } = dialog
      setDialog({ type: 'none' })
      setError(null)

      const finalResult = await finalizeAttendanceUploadAction({
        storageKey,
        fileName,
        fileType,
        payrollWeekStartDate,
        payrollWeekEndDate,
        payrollWeekSource,
        verificationDecisions: decisions,
        manualMatchDecisions,
        rejectedBlockKeys,
      })

      if (!finalResult.ok) {
        setError(finalResult.error)
        return
      }

      setUploadedFileId(finalResult.data.uploadId)
    },
    [dialog]
  )

  const handleOnboard = useCallback(
    async (record: MatchedAttendanceRecord, currentState: VerificationDialogState) => {
      if (dialog.type !== 'verify_required') return
      const { getBlockKey } = await import('@/features/attendance-upload/types/attendance.types')
      const { createAttendanceUploadSessionAction } = await import('@/features/attendance-upload/actions/attendance.actions')
      const blockKey = getBlockKey(record)

      const result = await createAttendanceUploadSessionAction({
        storageKey: dialog.storageKey,
        fileName: dialog.fileName,
        fileType: dialog.fileType,
        payrollWeekStartDate: dialog.payrollWeekStartDate,
        payrollWeekEndDate: dialog.payrollWeekEndDate,
        payrollWeekSource: dialog.payrollWeekSource,
        verificationDecisions: currentState.verificationDecisions,
        manualMatchDecisions: currentState.manualMatchDecisions,
        rejectedBlockKeys: currentState.rejectedBlockKeys,
        pendingBlockKey: blockKey,
        pendingSheetEmployeeName: record.employeeName,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      setDialog((prev) =>
        prev.type === 'verify_required'
          ? {
              ...prev,
              initialState: currentState,
              pendingOnboardBlockKeys: Array.from(
                new Set([...(prev.pendingOnboardBlockKeys ?? []), blockKey])
              ),
            }
          : prev
      )

      startTransition(() => {
        router.push(`/employees/new?attendanceSession=${result.data.sessionId}&returnTo=/payroll/run/${data.payrollRunId}/correct`)
      })
    },
    [dialog, router, startTransition, data.payrollRunId]
  )

  const isRecalculateDisabled =
    isPending ||
    selectedTypes.size === 0 ||
    (selectedTypes.has('ATTENDANCE') && !uploadedFileId)

  // Local override of application statuses based on live user actions
  const [appStatusOverrides, setAppStatusOverrides] = useState<Partial<Record<string, 'APPROVED' | 'SKIPPED'>>>({})

  const correctionOptions: { type: CorrectionType; label: string; description: string }[] = [
    { type: 'ADJUSTMENTS', label: 'Adjustments', description: 'Modify deductions or additions' },
    { type: 'ATTENDANCE', label: 'Attendance', description: 'Upload a corrected attendance file' },
    { type: 'EMPLOYEE_DATA', label: 'Employee data updated', description: 'Recalculate with current employee directory data' },
  ]

  function toggleType(type: CorrectionType) {
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function handleApproveAdjustment(applicationId: string) {
    startTransition(async () => {
      const res = await approveAdjustmentApplicationAction(applicationId)
      if (res.ok) {
        setAppStatusOverrides((prev) => ({ ...prev, [applicationId]: 'APPROVED' }))
      }
    })
  }

  function handleSkipAdjustment(applicationId: string) {
    startTransition(async () => {
      const res = await skipAdjustmentApplicationAction(applicationId)
      if (res.ok) {
        setAppStatusOverrides((prev) => ({ ...prev, [applicationId]: 'SKIPPED' }))
      }
    })
  }

  function handleRecalculate() {
    if (selectedTypes.size === 0) {
      setError('Select at least one correction type')
      return
    }
    setError(null)

    startTransition(async () => {
      const res = await recalculateAndCreateRevisionAction({
        payrollRunId: data.payrollRunId,
        correctionReason: correctionReason.trim() || null,
        correctionTypes: [...selectedTypes],
        // The backend handles applying logic automatically based on final approved statuses.
        // Passing empty array for backwards compatibility of shape, database is now the source of truth live.
        adjustmentChanges: {
          reversed: [],
          approved: [],
        },
      })

      if (res.ok) {
        // Hard navigate to bypass Next.js RSC cache
        window.location.href = `/payroll/run/${data.payrollRunId}`
      } else {
        setError(res.error)
      }
    })
  }

  // Compute effective listing including local changes
  const displayedAdjustments = data.adjustmentApplications.map((a) => ({
    ...a,
    effectiveStatus: appStatusOverrides[a.applicationId] ?? a.approvalStatus,
  }))

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      {/* Cancel */}
      <button
        onClick={() => router.back()}
        className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-700"
      >
        <ArrowLeft size={16} />
        Cancel Correction
      </button>

      {/* Header */}
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Payroll Correction
      </h1>
      <p className="mt-1 text-sm text-zinc-500">{weekLabel}</p>

      {/* Error banner */}
      {error && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Reason section */}
      <section className="mt-8 border-t border-zinc-200/60 pt-8">
        <label
          htmlFor="correction-reason"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400"
        >
          Correction Reason (optional)
        </label>
        <input
          id="correction-reason"
          type="text"
          value={correctionReason}
          onChange={(e) => setCorrectionReason(e.target.value)}
          placeholder="e.g. Overtime hours were miscalculated for 2 employees"
          className="w-full rounded-xl border border-zinc-200/60 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-shadow"
        />
      </section>

      {/* Correction type section */}
      <section className="mt-8 border-t border-zinc-200/60 pt-8">
        <p className="mb-4 text-sm font-medium text-zinc-900">
          What do you want to correct?
        </p>

        <div className="space-y-3">
          {correctionOptions.map((opt) => (
            <label
              key={opt.type}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200/60 px-4 py-3 transition-colors hover:bg-zinc-50/50 has-[:checked]:border-emerald-300 has-[:checked]:bg-emerald-50/30"
            >
              <input
                type="checkbox"
                checked={selectedTypes.has(opt.type)}
                onChange={() => toggleType(opt.type)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600 accent-emerald-600 focus:ring-emerald-500"
              />
              <div>
                <span className="text-sm text-zinc-700">{opt.label}</span>
                <p className="text-xs text-zinc-400">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Adjustment changes section */}
      {selectedTypes.has('ADJUSTMENTS') && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8">
          <p className="mb-4 text-sm font-medium text-zinc-900">Adjustment Changes</p>

          {displayedAdjustments.length === 0 ? (
            <p className="text-sm text-zinc-400">No adjustments to modify for this week.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-zinc-200">
                    {['Employee', 'Type', 'Reason', 'Amount', 'Status', 'Action'].map((h) => (
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
                  {displayedAdjustments.map((adj) => {
                    const isApprove = adj.effectiveStatus === 'APPROVED'
                    const isSkip = adj.effectiveStatus === 'SKIPPED'
                    const isPendingRow = adj.effectiveStatus === 'PENDING'

                    return (
                      <tr key={adj.applicationId} className="hover:bg-zinc-50/50">
                        <td className="py-2.5 pr-4 font-sans text-zinc-900">{adj.employeeName}</td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${adj.adjustmentType === 'DEDUCTION' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}
                          >
                            {adj.adjustmentType === 'DEDUCTION' ? 'Deduction' : 'Addition'}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-sans text-zinc-600">{adj.reason}</td>
                        <td className="py-2.5 pr-4 text-right text-zinc-700">
                          {adj.adjustmentType === 'DEDUCTION' ? '-' : '+'}₹{formatCurrency(adj.appliedAmount)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {isApprove && (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Approved
                            </span>
                          )}
                          {isSkip && (
                            <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
                              Skipped
                            </span>
                          )}
                          {isPendingRow && (
                            <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex gap-2">
                            {(isPendingRow || isSkip) && (
                              <button
                                onClick={() => handleApproveAdjustment(adj.applicationId)}
                                disabled={isPending}
                                className="rounded-lg border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-50 active:scale-[0.98] disabled:opacity-50"
                              >
                                Approve
                              </button>
                            )}
                            {(isPendingRow || isApprove) && (
                              <button
                                onClick={() => handleSkipAdjustment(adj.applicationId)}
                                disabled={isPending}
                                className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-all hover:bg-zinc-50 active:scale-[0.98] disabled:opacity-50"
                              >
                                Skip
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          
          {/* Guidance message if any are pending */}
          {displayedAdjustments.some((a) => a.effectiveStatus === 'PENDING') && (
             <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
               Some adjustments are still Pending. Pending adjustments will not be applied during recalculation.
             </div>
          )}
        </section>
      )}

      {/* Attendance re-upload */}
      {selectedTypes.has('ATTENDANCE') && (
        <AttendanceDropzone
          onWeekRequired={handleWeekRequired}
          onVerificationRequired={handleVerificationRequired}
          expectedWeekStart={expectedWeekStartISO}
          expectedWeekEnd={expectedWeekEndISO}
          onUploadSuccess={setUploadedFileId}
        />
      )}
 
      {/* Employee data notice */}
      {selectedTypes.has('EMPLOYEE_DATA') && (
        <section className="mt-8 border-t border-zinc-200/60 pt-8">
          <p className="mb-2 text-sm font-medium text-zinc-900">Employee Data Changes</p>
          <p className="text-sm text-zinc-500">
            The payroll will be recalculated using the current employee directory data, including any updated wage rates or matching changes.
          </p>
        </section>
      )}
 
      {/* Action bar */}
      <div className="mt-8 flex items-center justify-end gap-3 border-t border-zinc-200/60 pt-8">
        <button
          onClick={() => router.back()}
          className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 active:scale-[0.98]"
        >
          Cancel
        </button>
        <button
          onClick={handleRecalculate}
          disabled={isRecalculateDisabled}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? (
            <>
              <CircleNotch size={16} className="animate-spin" />
              Recalculating...
            </>
          ) : (
            <>
              Recalculate & Preview
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>

      {/* Dialogs */}
      {dialog.type === 'week_required' && (
        <WeekSelectionDialog
          onConfirm={handleWeekConfirm}
          onCancel={() => setDialog({ type: 'none' })}
        />
      )}

      {dialog.type === 'verify_required' && (
        <EmployeeVerificationDialog
          isOpen={dialog.type === 'verify_required'}
          employees={dialog.records.filter(
            (r) => r.matchStatus === 'INACTIVE' || r.matchStatus === 'RESIGNED_BEFORE_WEEK'
          )}
          unmatchedEmployees={dialog.records.filter((r) => r.matchStatus === 'UNMATCHED')}
          employeeOptions={employeeOptions}
          initialState={dialog.initialState}
          pendingOnboardBlockKeys={dialog.pendingOnboardBlockKeys}
          onConfirm={handleVerificationConfirm}
          onOnboard={handleOnboard}
          onCancel={() => setDialog({ type: 'none' })}
        />
      )}
    </main>
  )
}
