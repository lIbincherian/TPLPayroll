'use client'

import { useState, useCallback, useTransition, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  CheckCircle,
  WarningCircle,
  CalendarBlank,
  Eye,
  ArrowsClockwise,
  SpinnerGap,
} from '@phosphor-icons/react'
import { AttendanceDropzone } from './AttendanceDropzone'
import { WeekSelectionDialog } from './WeekSelectionDialog'
import { EmployeeVerificationDialog } from './EmployeeVerificationDialog'
import type { VerificationDialogState } from './EmployeeVerificationDialog'
import {
  parseFromStorageWithDatesAction,
  finalizeAttendanceUploadAction,
  getEmployeesForMatchingAction,
  getRecordsFromStorageAction,
} from '@/features/attendance-upload/actions/attendance.actions'
import {
  createAttendanceUploadSessionAction,
} from '@/features/attendance-upload/actions/session.actions'
import type { AttendanceUploadRow, EmployeeOption } from '@/features/attendance-upload/actions/attendance.actions'
import type {
  MatchedAttendanceRecord,
  PayrollWeekSource,
  ImportSummary,
  VerificationDecision,
} from '@/features/attendance-upload/types/attendance.types'
import { getBlockKey } from '@/features/attendance-upload/types/attendance.types'

// ─── Helper ───────────────────────────────────────────────────────────────────

function fmtWeek(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    })
  return `${fmt(start)} – ${fmt(end)}`
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const isReady = status === 'READY'
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full text-xs px-2 py-0.5',
        isReady ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
      ].join(' ')}
    >
      {isReady ? (
        <CheckCircle size={14} className="text-emerald-500" />
      ) : (
        <WarningCircle size={14} className="text-amber-500" />
      )}
      {isReady ? 'Ready' : 'Errors'}
    </span>
  )
}

// ─── Dialog state ─────────────────────────────────────────────────────────────

type DialogState =
  | { type: 'none' }
  | {
      // Transitional: records are being fetched from Storage after session resume.
      // Shows a loading overlay instead of immediately opening the dialog.
      type: 'resuming'
      storageKey: string
      fileName: string
      fileType: string
      payrollWeekStartDate: string
      payrollWeekEndDate: string
      payrollWeekSource: PayrollWeekSource
      initialState: VerificationDialogState
    }
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

// ─── InitialDialogState ───────────────────────────────────────────────────────
// Lean struct passed as an RSC prop — deliberately has NO records[] array.
// Records are fetched client-side via getRecordsFromStorageAction to avoid
// the Vercel 4.5 MB RSC payload limit on large spreadsheets.

export interface InitialDialogState {
  storageKey: string
  fileName: string
  fileType: string
  payrollWeekStartDate: string
  payrollWeekEndDate: string
  payrollWeekSource: PayrollWeekSource
  dialogState: VerificationDialogState
}

// ─── AttendanceUploadClient ───────────────────────────────────────────────────

interface AttendanceUploadClientProps {
  initialUploads: AttendanceUploadRow[]
  /** When set, the verification dialog resumes after returning from the
   *  "Add Employee" onboarding flow. Contains only lean metadata — no records[]. */
  initialDialogState?: InitialDialogState | null
}

export function AttendanceUploadClient({
  initialUploads,
  initialDialogState,
}: AttendanceUploadClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [uploads] = useState(initialUploads)
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' })
  const [processingError, setProcessingError] = useState<string | null>(null)
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])
  const hydratedFromSession = useRef(false)

  const loadEmployeeOptions = useCallback(async (records: MatchedAttendanceRecord[]) => {
    if (!records.some((r) => r.matchStatus === 'UNMATCHED')) return
    const result = await getEmployeesForMatchingAction()
    if (result.ok) setEmployeeOptions(result.data)
  }, [])

  // ── Hydrate from server-provided session resume ────────────────────────────
  // initialDialogState is LEAN (no records[]). We set a 'resuming' state that
  // shows a spinner, fetch records via a Server Action, then open the dialog.
  useEffect(() => {
    if (hydratedFromSession.current) return
    if (!initialDialogState) return
    hydratedFromSession.current = true

    const {
      storageKey,
      fileName,
      fileType,
      payrollWeekStartDate,
      payrollWeekEndDate,
      payrollWeekSource,
      dialogState,
    } = initialDialogState

    // Show loading overlay immediately
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from server-provided session-resume props (guarded by hydratedFromSession); shows the overlay before the async fetch below
    setDialog({
      type: 'resuming',
      storageKey,
      fileName,
      fileType,
      payrollWeekStartDate,
      payrollWeekEndDate,
      payrollWeekSource,
      initialState: dialogState,
    })

    // Clear resume params from URL so a refresh doesn't re-trigger resume
    const params = new URLSearchParams(searchParams.toString())
    if (params.has('resumeSession') || params.has('newEmployeeId')) {
      params.delete('resumeSession')
      params.delete('newEmployeeId')
      const qs = params.toString()
      router.replace(qs ? `/attendance?${qs}` : '/attendance')
    }

    // Fetch records from Storage (Server Action response — no 4.5 MB cap on response)
    getRecordsFromStorageAction(
      storageKey,
      payrollWeekStartDate,
      payrollWeekEndDate,
      fileName,
      fileType
    ).then((result) => {
      if (!result.ok) {
        setProcessingError(result.error ?? 'Failed to resume upload session.')
        setDialog({ type: 'none' })
        return
      }
      const { records, summary } = result.data
      const unmatched = records.filter((r) => r.matchStatus !== 'MATCHED')
      loadEmployeeOptions(records)
      setDialog({
        type: 'verify_required',
        records: unmatched,
        summary,
        payrollWeekStartDate,
        payrollWeekEndDate,
        payrollWeekSource,
        storageKey,
        fileName,
        fileType,
        initialState: dialogState,
        pendingOnboardBlockKeys: [],
      })
    })
  }, [initialDialogState, loadEmployeeOptions, router, searchParams])

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
      setProcessingError(null)

      const result = await parseFromStorageWithDatesAction(
        storageKey,
        startDate,
        endDate,
        fileName,
        fileType
      )

      if (!result.ok) {
        setProcessingError(result.error)
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
        setProcessingError(finalResult.error)
        return
      }

      startTransition(() => {
        router.push(`/attendance/${finalResult.data.uploadId}/preview`)
      })
    },
    [dialog, loadEmployeeOptions, router, startTransition]
  )

  const handleVerificationConfirm = useCallback(
    async (
      decisions: Record<string, VerificationDecision>,
      manualMatchDecisions: Record<string, string>,
      rejectedBlockKeys: string[]
    ) => {
      if (dialog.type !== 'verify_required') return
      const {
        storageKey,
        fileName,
        fileType,
        payrollWeekStartDate,
        payrollWeekEndDate,
        payrollWeekSource,
      } = dialog
      setDialog({ type: 'none' })
      setProcessingError(null)

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
        setProcessingError(finalResult.error)
        return
      }

      startTransition(() => {
        router.push(`/attendance/${finalResult.data.uploadId}/preview`)
      })
    },
    [dialog, router, startTransition]
  )

  const handleOnboard = useCallback(
    async (record: MatchedAttendanceRecord, currentState: VerificationDialogState) => {
      if (dialog.type !== 'verify_required') return
      setProcessingError(null)
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
        setProcessingError(result.error)
        return
      }

      // Mark the row as pending while we navigate away
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
        router.push(`/employees/new?attendanceSession=${result.data.sessionId}`)
      })
    },
    [dialog, router, startTransition]
  )

  const handleNavigateToPreview = useCallback(
    (uploadId: string) => startTransition(() => router.push(`/attendance/${uploadId}/preview`)),
    [router, startTransition]
  )

  return (
    <>
      {/* ── Resuming overlay ──────────────────────────────────────────────── */}
      {dialog.type === 'resuming' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 p-8 rounded-2xl bg-white border border-zinc-100 shadow-xl">
            <SpinnerGap size={32} className="text-emerald-500 animate-spin" />
            <p className="text-sm font-medium text-zinc-700">Resuming your upload session…</p>
            <p className="text-xs text-zinc-400">Re-matching employees from your spreadsheet</p>
          </div>
        </div>
      )}

      {/* ── Recent uploads table ─────────────────────────────────────────── */}
      <div className="mb-2">
        <p className="text-sm font-medium text-zinc-900 mb-4">Recent Uploads</p>

        {uploads.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <CalendarBlank size={48} className="text-zinc-200" />
            <p className="text-sm text-zinc-400">
              No attendance files uploaded yet. Upload your first file below.
            </p>
          </div>
        ) : (
          <table className="w-full divide-y divide-zinc-100">
            <thead>
              <tr>
                {['Week', 'File', 'Status', 'Actions'].map((h) => (
                  <th
                    key={h}
                    className="pb-3 text-left text-xs uppercase tracking-wider text-zinc-400 font-medium"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {uploads.map((u) => (
                <tr key={u.id} className="hover:bg-zinc-50/80 transition-colors">
                  <td className="py-3 pr-4 text-sm text-zinc-900">
                    {fmtWeek(u.payrollWeekStartDate, u.payrollWeekEndDate)}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-zinc-500">{u.fileName}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleNavigateToPreview(u.id)}
                        disabled={isPending}
                        className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50"
                      >
                        <Eye size={14} />
                        View
                      </button>
                      <button
                        onClick={() =>
                          document.getElementById('attendance-dropzone-trigger')?.click()
                        }
                        className="inline-flex items-center gap-1.5 text-sm text-zinc-600 border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 rounded-lg px-2.5 py-1.5 transition-colors"
                      >
                        <ArrowsClockwise size={14} />
                        Replace
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Processing error ──────────────────────────────────────────────── */}
      {processingError && (
        <div className="mb-4 flex items-center gap-2 text-sm text-rose-600 bg-rose-50 border border-rose-200/60 rounded-xl px-4 py-3">
          <WarningCircle size={16} className="flex-shrink-0" />
          <span>{processingError}</span>
        </div>
      )}

      {/* ── Dropzone ─────────────────────────────────────────────────────── */}
      <AttendanceDropzone
        onWeekRequired={handleWeekRequired}
        onVerificationRequired={handleVerificationRequired}
      />

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
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
    </>
  )
}
