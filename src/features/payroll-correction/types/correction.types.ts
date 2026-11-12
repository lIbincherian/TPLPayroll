import type { EmployeePayrollRow, PayrollSummaryTotals } from '@/features/payroll-generation/types/payroll.types'

// ─── Correction types ─────────────────────────────────────────────────────────

export type CorrectionType = 'ADJUSTMENTS' | 'ATTENDANCE' | 'EMPLOYEE_DATA'

// ─── Initiation result ────────────────────────────────────────────────────────

export interface InitiateCorrectionResult {
  payrollRunId: string
  revisionId: string
  revisionNumber: number
  weekStart: Date
  weekEnd: Date
  totals: PayrollSummaryTotals
  employees: {
    employeeId: string
    employeeCode: string
    employeeName: string
    netPayable: number
  }[]
  adjustmentApplications: CorrectionAdjustmentItem[]
}

export interface CorrectionAdjustmentItem {
  applicationId: string
  adjustmentId: string
  employeeId: string
  employeeName: string
  employeeCode: string
  adjustmentType: 'DEDUCTION' | 'ADDITION'
  amount: number
  appliedAmount: number
  reason: string
  approvalStatus: 'PENDING' | 'APPROVED' | 'SKIPPED'
  isReversed: boolean
}

// ─── Correction session ───────────────────────────────────────────────────────

/** An in-progress correction of an approved payroll run. */
export interface CorrectionSessionInfo {
  sessionId: string
  payrollRunId: string
  attendanceUploadId: string
  /** Thursday that starts the run's week (YYYY-MM-DD); the `weekId` of the attendance pages. */
  weekId: string
  /** Excel-era runs can only be corrected for adjustments and employee data, not attendance. */
  attendanceSource: 'EXCEL' | 'ETIMEOFFICE'
  correctionReason: string | null
  correctionTypes: CorrectionType[]
  /** True once the approved punches were copied for editing (an Attendance correction was started). */
  hasPunchClone: boolean
  draftRevisionId: string | null
}

export interface BeginCorrectionResult {
  sessionId: string
  /** True when an in-progress correction was found and reused. */
  resumed: boolean
  correctionTypes: CorrectionType[]
}

export interface StartAttendanceCorrectionInput {
  reason: string | null
  types: CorrectionType[]
}

export interface AbandonCorrectionResult {
  sessionId: string
  /** Punch edits that were thrown away (they stay in the audit log). */
  discardedEdits: number
}

// ─── Create revision input ────────────────────────────────────────────────────

export interface CreateRevisionInput {
  payrollRunId: string
  correctionReason: string | null
  correctionTypes: CorrectionType[]
  /** When set and the session has copied punches, hours come from them instead of the approved records. */
  correctionSessionId?: string
}

// ─── Create revision result ───────────────────────────────────────────────────

export interface CreateRevisionResult {
  payrollRunId: string
  revisionId: string
  revisionNumber: number
  totals: PayrollSummaryTotals
  employeeCount: number
}

// ─── Revised employee row (with diff) ─────────────────────────────────────────

export interface RevisedEmployeeRow extends EmployeePayrollRow {
  previousNetPayable: number | null
  previousRegularPay: number | null
  previousOvertimePay: number | null
  previousAdditions: number | null
  previousDeductions: number | null
  /** Paid in this revision but not in the current one. */
  isNew: boolean
  /** Paid in the current revision but not in this one. Values are zero; `previous*` hold what they were paid. */
  isLeftOut: boolean
}

// ─── Revision history ─────────────────────────────────────────────────────────

export interface RevisionHistoryItem {
  revisionId: string
  revisionNumber: number
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'
  correctionReason: string | null
  isCurrent: boolean
  totalNetPayable: number
  totalRegularPay: number
  totalOvertimePay: number
  totalAdditions: number
  totalDeductions: number
  approvedAt: Date | null
  generatedAt: Date
}

// ─── Approve revision result ──────────────────────────────────────────────────

export interface ApproveRevisionResult {
  revisionId: string
  revisionNumber: number
  status: 'APPROVED'
  approvedAt: Date
}

// ─── Service error ────────────────────────────────────────────────────────────

export type CorrectionErrorCode =
  | 'CANNOT_CORRECT_UNAPPROVED_PAYROLL'
  | 'PAYROLL_RUN_NOT_FOUND'
  | 'NO_CORRECTION_TYPE_SELECTED'
  | 'REVISION_NOT_FOUND'
  | 'APPLICATION_NOT_FOUND'
  | 'NO_DRAFT_REVISION'
  | 'CORRECTION_NOT_ACTIVE'
  | 'CORRECTION_HAS_INCOMPLETE_PAIRS'
  | 'EXCEL_ERA_ATTENDANCE_CORRECTION'
  | 'REVISION_NOT_DRAFT'
  | 'REVISION_STALE'
  | 'ADJUSTMENT_NOT_APPLICABLE'

export class CorrectionServiceError extends Error {
  constructor(
    public readonly code: CorrectionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CorrectionServiceError'
  }
}
