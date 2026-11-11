'use client'

import { useState, useRef, useEffect } from 'react'
import { Spinner, UserPlus, Prohibit } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { MatchedAttendanceRecord, VerificationDecision } from '@/features/attendance-upload/types/attendance.types'
import { getBlockKey } from '@/features/attendance-upload/types/attendance.types'
import type { EmployeeOption } from '@/features/attendance-upload/actions/attendance.actions'

// ─── EmployeeCombobox ─────────────────────────────────────────────────────────

interface EmployeeComboboxProps {
  employees: EmployeeOption[]
  selectedId: string | null
  onSelect: (id: string) => void
  disabled?: boolean
}

function EmployeeCombobox({ employees, selectedId, onSelect, disabled }: EmployeeComboboxProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = employees.find((e) => e.id === selectedId) ?? null

  const filtered = query
    ? employees.filter(
        (e) =>
          e.employeeName.toLowerCase().includes(query.toLowerCase()) ||
          e.employeeId.toLowerCase().includes(query.toLowerCase())
      )
    : employees

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <input
        type="text"
        className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 bg-white disabled:bg-zinc-50 disabled:text-zinc-400 disabled:cursor-not-allowed"
        placeholder={selected ? selected.employeeName : 'Search employee…'}
        value={open ? query : (selected?.employeeName ?? '')}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true) }}
        onFocus={() => { setOpen(true); setQuery('') }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={disabled}
      />
      {open && !disabled && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-zinc-200 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-400">No employees found</p>
          ) : (
            filtered.slice(0, 30).map((emp) => (
              <button
                key={emp.id}
                className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50 flex items-center justify-between gap-2"
                onMouseDown={() => { onSelect(emp.id); setQuery(''); setOpen(false) }}
              >
                <span className="font-medium truncate">{emp.employeeName}</span>
                <span className="text-xs text-zinc-400 flex-shrink-0">{emp.employeeId}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ─── EmployeeVerificationDialog ───────────────────────────────────────────────

type UnmatchedDecision =
  | { type: 'matched'; employeeDbId: string }
  | { type: 'rejected' }

export interface VerificationDialogState {
  verificationDecisions: Record<string, VerificationDecision>
  manualMatchDecisions: Record<string, string>     // blockKey → employeeDbId
  rejectedBlockKeys: string[]                       // blockKeys explicitly rejected
}

interface EmployeeVerificationDialogProps {
  isOpen: boolean
  employees: MatchedAttendanceRecord[]          // INACTIVE / RESIGNED_BEFORE_WEEK
  unmatchedEmployees: MatchedAttendanceRecord[] // UNMATCHED
  employeeOptions: EmployeeOption[]
  /** blockKeys of rows sent to /employees/new but not yet returned. */
  pendingOnboardBlockKeys?: string[]
  /** Optional initial state — used when resuming a saved session. */
  initialState?: VerificationDialogState
  onConfirm: (
    decisions: Record<string, VerificationDecision>,
    manualMatchDecisions: Record<string, string>,
    rejectedBlockKeys: string[]
  ) => void
  onOnboard: (record: MatchedAttendanceRecord, currentState: VerificationDialogState) => void
  onCancel: () => void
}

export function EmployeeVerificationDialog({
  isOpen,
  employees,
  unmatchedEmployees,
  employeeOptions,
  pendingOnboardBlockKeys,
  initialState,
  onConfirm,
  onOnboard,
  onCancel,
}: EmployeeVerificationDialogProps) {
  const pendingSet = new Set(pendingOnboardBlockKeys ?? [])
  const [decisions, setDecisions] = useState<Record<string, VerificationDecision>>(
    () => initialState?.verificationDecisions ?? {}
  )
  const [unmatchedDecisions, setUnmatchedDecisions] = useState<Record<string, UnmatchedDecision>>(() => {
    if (!initialState) return {}
    const out: Record<string, UnmatchedDecision> = {}
    for (const [key, id] of Object.entries(initialState.manualMatchDecisions)) {
      out[key] = { type: 'matched', employeeDbId: id }
    }
    for (const key of initialState.rejectedBlockKeys) {
      out[key] = { type: 'rejected' }
    }
    return out
  })

  // When parent provides a fresh initialState (session resume), re-sync.
  useEffect(() => {
    if (!initialState) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync local decision state when the parent hands over a fresh initialState (session resume)
    setDecisions(initialState.verificationDecisions ?? {})
    const next: Record<string, UnmatchedDecision> = {}
    for (const [key, id] of Object.entries(initialState.manualMatchDecisions ?? {})) {
      next[key] = { type: 'matched', employeeDbId: id }
    }
    for (const key of initialState.rejectedBlockKeys ?? []) {
      next[key] = { type: 'rejected' }
    }
    setUnmatchedDecisions(next)
  }, [initialState])

  const handleDecision = (employeeDbId: string, decision: VerificationDecision) => {
    setDecisions((prev) => ({ ...prev, [employeeDbId]: decision }))
  }

  const handleManualMatch = (record: MatchedAttendanceRecord, employeeDbId: string) => {
    const key = getBlockKey(record)
    setUnmatchedDecisions((prev) => ({ ...prev, [key]: { type: 'matched', employeeDbId } }))
  }

  const handleReject = (record: MatchedAttendanceRecord) => {
    const key = getBlockKey(record)
    setUnmatchedDecisions((prev) => ({ ...prev, [key]: { type: 'rejected' } }))
  }

  const buildState = (): VerificationDialogState => {
    const manualMatches: Record<string, string> = {}
    const rejectedKeys: string[] = []
    for (const [key, decision] of Object.entries(unmatchedDecisions)) {
      if (decision.type === 'matched') manualMatches[key] = decision.employeeDbId
      else if (decision.type === 'rejected') rejectedKeys.push(key)
    }
    return {
      verificationDecisions: decisions,
      manualMatchDecisions: manualMatches,
      rejectedBlockKeys: rejectedKeys,
    }
  }

  const allVerifiableDecided = employees.every((e) => e.employeeDbId && decisions[e.employeeDbId])
  const allUnmatchedDecided = unmatchedEmployees.every(
    (e) => unmatchedDecisions[getBlockKey(e)] !== undefined
  )
  const hasPendingOnboard = unmatchedEmployees.some((e) => pendingSet.has(getBlockKey(e)))
  const allDecided = allVerifiableDecided && allUnmatchedDecided && !hasPendingOnboard

  const handleConfirm = () => {
    if (!allDecided) return
    const state = buildState()
    onConfirm(state.verificationDecisions, state.manualMatchDecisions, state.rejectedBlockKeys)
  }

  const handleOnboardClick = (record: MatchedAttendanceRecord) => {
    onOnboard(record, buildState())
  }

  const getReasonText = (record: MatchedAttendanceRecord): string => {
    if (record.matchStatus === 'INACTIVE') return 'Inactive employee'
    if (record.matchStatus === 'RESIGNED_BEFORE_WEEK') return 'Resigned before payroll week'
    return 'Requires verification'
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manual Verification Required</DialogTitle>
          <DialogDescription>
            Review each flagged employee before confirming the upload.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 max-h-[28rem] overflow-y-auto pr-1">

          {/* ── Unmatched section ──────────────────────────────────────────── */}
          {unmatchedEmployees.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Unmatched — match, onboard as new, or reject
              </p>
              {unmatchedEmployees.map((record) => {
                const key = getBlockKey(record)
                const decision = unmatchedDecisions[key]
                const selectedId = decision?.type === 'matched' ? decision.employeeDbId : null
                const isRejected = decision?.type === 'rejected'
                const isPendingOnboard = pendingSet.has(key)
                return (
                  <div
                    key={key}
                    className={[
                      'flex flex-col gap-2 p-3 border rounded-lg transition-colors',
                      isPendingOnboard ? 'border-amber-300 bg-amber-50/40' : 'border-zinc-200',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 w-36 flex-shrink-0">
                        <p className="font-medium text-sm truncate">{record.employeeName}</p>
                        <p className="text-xs text-muted-foreground">
                          Reg: {record.totalRegularHours}h | OT: {record.totalOvertimeHours}h
                        </p>
                      </div>

                      <EmployeeCombobox
                        employees={employeeOptions}
                        selectedId={selectedId}
                        onSelect={(id) => handleManualMatch(record, id)}
                        disabled={isPendingOnboard}
                      />

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleOnboardClick(record)}
                        disabled={isPendingOnboard}
                        className="flex-shrink-0 gap-1.5"
                        aria-label={`Onboard ${record.employeeName} as new employee`}
                      >
                        <UserPlus size={14} weight="bold" />
                        Onboard
                      </Button>

                      <Button
                        size="sm"
                        variant={isRejected ? 'destructive' : 'outline'}
                        onClick={() => handleReject(record)}
                        disabled={isPendingOnboard}
                        className="flex-shrink-0 gap-1.5"
                        aria-label={`Reject ${record.employeeName}`}
                      >
                        <Prohibit size={14} weight="bold" />
                        Reject
                      </Button>
                    </div>

                    {isPendingOnboard && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-700 ml-[9.5rem]">
                        <Spinner size={12} className="animate-spin" />
                        Onboard in progress — complete the Add Employee form to continue
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Inactive / resigned section ────────────────────────────────── */}
          {employees.length > 0 && (
            <div className="space-y-2">
              {unmatchedEmployees.length > 0 && (
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Inactive / Resigned — include or exclude from payroll
                </p>
              )}
              {employees.map((record) => (
                <div
                  key={record.employeeDbId}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="flex-1">
                    <p className="font-medium text-sm">{record.employeeName}</p>
                    <p className="text-xs text-muted-foreground">{getReasonText(record)}</p>
                    <p className="text-xs text-muted-foreground">
                      Reg: {record.totalRegularHours}h | OT: {record.totalOvertimeHours}h
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={decisions[record.employeeDbId!] === 'APPROVED' ? 'default' : 'outline'}
                      onClick={() => handleDecision(record.employeeDbId!, 'APPROVED')}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant={decisions[record.employeeDbId!] === 'REJECTED' ? 'destructive' : 'outline'}
                      onClick={() => handleDecision(record.employeeDbId!, 'REJECTED')}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!allDecided}>
            Confirm Selections
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
