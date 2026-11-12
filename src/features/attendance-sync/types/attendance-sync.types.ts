// ─── Primitives ───────────────────────────────────────────────────────────────

export type ISODate = string // 'YYYY-MM-DD'
export type HHmm = string // '07:40'

export interface WeekRange {
  start: ISODate
  end: ISODate
}

export type AttendanceSource = 'EXCEL' | 'ETIMEOFFICE'
export type AttendanceWeekStatus = 'NO_DATA' | 'SYNC_FAILED' | 'REVIEW' | 'APPROVED'
export type WeekPayrollStatus = 'NOT_GENERATED' | 'APPROVED' | 'REVISED'
export type SyncTrigger = 'SCHEDULED' | 'MANUAL'

// SYNC_FAILED covers a database failure while saving a pulled week.
export type SyncFailureCode =
  | 'HTTP_STATUS'
  | 'API_ERROR'
  | 'UNPARSEABLE'
  | 'EMPTY'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CONFIG_MISSING'
  | 'SYNC_FAILED'
  | 'WEEK_CHANGED'

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface ParsedPunch {
  empCode: string
  empName: string | null
  date: ISODate
  time: HHmm
  mcid: string | null
}

export type SyncClassification =
  | { ok: true; punches: ParsedPunch[] }
  | { ok: false; code: SyncFailureCode; message: string } // message = user-facing copy

export interface DiscardedEdit {
  punchId: string
  employeeCode: string | null
  date: ISODate
  position: 'IN' | 'OUT'
  original: HHmm | null
  current: HHmm | null
  note: string | null
}

export interface DiscardSummary {
  editedDays: number
  decisions: number
  /** Codes ignored for this week only: a new pull asks about them again. */
  ignoredCodes: number
  edits: DiscardedEdit[]
}

export type SyncOutcome =
  | { outcome: 'LOADED'; punchCount: number; discarded: DiscardSummary | null }
  | { outcome: 'FAILED'; code: SyncFailureCode; message: string }
  | { outcome: 'SKIPPED_HAS_EDITS' }
  | { outcome: 'SKIPPED_APPROVED' }
  | { outcome: 'SKIPPED_PAYROLL_APPROVED' }
  | { outcome: 'SKIPPED_EXCEL_ERA' }

// ─── Matching ─────────────────────────────────────────────────────────────────

export interface EmployeeLite {
  id: string
  employeeId: string
  employeeName: string
  isActive: boolean
  dateOfResignation: Date | null
}

export type CodeMatch =
  | { status: 'MATCHED'; employee: EmployeeLite; via: 'NUMBER' | 'EXCEPTION' }
  | { status: 'DUPLICATE'; employees: EmployeeLite[] }
  | { status: 'UNKNOWN' }
  | { status: 'IGNORED' }

export type PunchMatchStatus = 'MATCHED' | 'UNKNOWN' | 'DUPLICATE' | 'IGNORED'

/** How long an ignored code stays ignored: this week's punches only, or every week (a saved exception). */
export type IgnoreScope = 'WEEK' | 'ALWAYS'

/** Where a code went when it stopped being ignored: matched to an employee, or back under "Codes to fix". */
export interface UnignoreCodeResult {
  restoredPunches: number
  outcome: { status: 'MATCHED'; employeeCode: string } | { status: 'UNKNOWN' | 'DUPLICATE' }
}

export interface CodeExceptionLite {
  empCode: string
  kind: 'MATCH' | 'IGNORE'
  employeeId: string | null
}

export type GridEmployeeTag = 'ACTIVE' | 'INACTIVE_APPROVED' | 'RESIGNED_APPROVED'

export type DecisionReason = 'INACTIVE' | 'RESIGNED_BEFORE_WEEK'

export type EmployeeDecisionValue = 'APPROVED' | 'REJECTED'

// ─── Stored punch rows ────────────────────────────────────────────────────────

/** A row ready for `attendancePunch.createMany` (minus attendanceUploadId and correctionId). */
export interface AttendancePunchCreate {
  attendanceUploadId: string
  employeeId: string | null
  empCode: string
  empName: string | null
  matchStatus: PunchMatchStatus
  punchDate: Date
  pairIndex: number
  position: 'IN' | 'OUT'
  source: 'API' | 'MANUAL'
  originalTime: HHmm | null
  currentTime: HHmm | null
  note: string | null
  /** Scans that were merged into this (kept) punch; null when nothing was merged. */
  mergedScansJson: HHmm[] | null
  mcid: string | null
}

/** The shape the pure day-building code needs from a stored `AttendancePunch`. */
export interface StoredPunchRow {
  id: string
  pairIndex: number
  position: string
  source: string
  originalTime: HHmm | null
  currentTime: HHmm | null
  note: string | null
  mergedScansJson?: unknown
}

// ─── Review views ─────────────────────────────────────────────────────────────

export interface PunchView {
  id: string
  time: HHmm | null
  original: HHmm | null
  note: string | null
  source: 'API' | 'MANUAL'
  mergedScans: HHmm[]
}

export interface PairView {
  pairIndex: number
  in: PunchView | null
  out: PunchView | null
  hours: number // 0 if incomplete
}

export interface DayChange {
  punchId: string
  original: HHmm | null
  current: HHmm | null
  note: string | null
  kind: 'EDITED' | 'ADDED' | 'DELETED'
}

export interface DayView {
  date: ISODate
  pairs: PairView[]
  incomplete: boolean
  regularHours: number
  overtimeHours: number
  totalHours: number
  isEdited: boolean
  isMerged: boolean
  isUnusual: boolean
  unusualReason: string | null
  changes: DayChange[]
  /** Version of the stored punches this view was built from; sent back with a save. */
  signature: string
}

export interface GridEmployee {
  employeeId: string
  employeeCode: string
  employeeName: string
  tag: GridEmployeeTag
  days: DayView[] // 7, Thu..Wed
  totalRegularHours: number
  totalOvertimeHours: number
  hasAnyPunch: boolean
}

export type ReviewMode =
  | { kind: 'LIVE' }
  | { kind: 'CORRECTION'; payrollRunId: string; correctionId: string; revisionNumber: number }

export type ApproveBlocker =
  | 'WEEK_NOT_ENDED'
  | 'NEEDS_FIXING'
  | 'UNRESOLVED_CODES'
  | 'PENDING_DECISIONS'
  | 'NOT_IN_REVIEW'

export interface PunchReviewCounts {
  needsFixingDays: number
  noPunchEmployees: number
  unusualDays: number
  unresolvedCodes: number
  pendingDecisions: number
  editedDays: number
}

export interface PunchReviewTotals {
  byDay: Array<{ date: ISODate; regular: number; overtime: number }>
  regular: number
  overtime: number
}

export interface PunchReview {
  weekId: ISODate
  week: WeekRange
  status: AttendanceWeekStatus
  mode: ReviewMode
  locked: boolean
  employees: GridEmployee[]
  dates: ISODate[]
  counts: PunchReviewCounts
  totals: PunchReviewTotals
  approval: { canApprove: boolean; blockers: ApproveBlocker[]; weekHasEnded: boolean }
  payroll: {
    status: WeekPayrollStatus
    payrollRunId: string | null
    activeCorrectionId: string | null
  }
  lastSavedAt: string | null
  approvedAt: string | null
}

/** A review of the live week. */
export type LiveReview = PunchReview & { mode: { kind: 'LIVE' } }
/** A review of a correction's draft clone. */
export type CorrectionReview = PunchReview & { mode: Extract<ReviewMode, { kind: 'CORRECTION' }> }

/** A recorded employee decision, with the employee's display fields. */
export interface ApprovalDecisionInput {
  employeeId: string
  employeeCode: string
  employeeName: string
  decision: EmployeeDecisionValue
}

export interface ApprovalSummary {
  employeeCount: number
  totalRegularHours: number
  totalOvertimeHours: number
  editedDays: number
  editedDayDetails: Array<{ employeeName: string; date: ISODate; before: string; after: string }>
  leftOut: Array<{
    employeeId: string
    employeeCode: string
    employeeName: string
    reason: 'ZERO_HOURS' | 'REJECTED'
  }>
  changedDaysInCorrection?: number
}

// ─── Week list ────────────────────────────────────────────────────────────────

export interface AttendanceWeekListItem {
  weekId: ISODate
  week: WeekRange
  source: AttendanceSource | null // null = virtual, no row
  status: AttendanceWeekStatus
  isSyncing: boolean
  uploadId: string | null
  employeeCount: number
  totalRegularHours: number
  totalOvertimeHours: number
  unresolvedCodes: number
  pendingDecisions: number
  needsFixingDays: number
  lastSyncError: string | null
  lastSyncAttemptAt: string | null
  lastSyncedAt: string | null
  staleNoticeAt: string | null
  fileName: string | null
  payrollStatus: WeekPayrollStatus
  payrollRunId: string | null
  canPullNow: boolean
  canReopen: boolean
  hasEnded: boolean
}

// ─── Employee check ───────────────────────────────────────────────────────────

export interface EmployeeCheck {
  weekId: ISODate
  week: WeekRange
  codes: Array<{
    empCode: string
    empName: string | null
    status: 'UNKNOWN' | 'DUPLICATE'
    punchCount: number
    dayCount: number
    candidates: EmployeeLite[] // DUPLICATE only
  }>
  ignoredCodes: Array<{ empCode: string; empName: string | null; punchCount: number; scope: IgnoreScope }>
  decisions: Array<{
    employeeId: string
    employeeCode: string
    employeeName: string
    reason: DecisionReason
    resignedOn: ISODate | null
    dayCount: number
    regularHours: number
    overtimeHours: number
    decision: EmployeeDecisionValue | null
  }>
  counts: {
    codesInSync: number
    matched: number
    unknown: number
    duplicate: number
    decisionsLeft: number
  }
  allEmployees: Array<{ id: string; employeeId: string; employeeName: string }> // for the combobox
  complete: boolean
}

// ─── Editing ──────────────────────────────────────────────────────────────────

export type SavePair = {
  pairIndex: number
  in: { punchId?: string; time: HHmm | null; note?: string | null }
  out: { punchId?: string; time: HHmm | null; note?: string | null }
}

export interface SavePunchEditInput {
  weekId: ISODate
  employeeId: string
  date: ISODate
  mode: ReviewMode
  /** The `DayView.signature` the editor was opened on. A save is refused (DAY_CHANGED) if the day has moved on. */
  baseSignature: string
  pairs: SavePair[]
}

export interface SavePunchEditResult {
  day: DayView
  employeeTotals: { regular: number; overtime: number; hasAnyPunch: boolean }
  counts: PunchReview['counts']
  totals: PunchReview['totals']
  approval: PunchReview['approval']
  savedAt: string
}

export type DayValidation =
  | { valid: true }
  | {
      valid: false
      code: 'INVALID_TIME' | 'OUT_NOT_AFTER_IN' | 'PAIRS_OVERLAP'
      pairIndex: number
      field: 'in' | 'out'
      message: string
    }

// ─── Errors and action results ────────────────────────────────────────────────

export type AttendanceSyncErrorCode =
  | 'WEEK_LOCKED'
  | 'WEEK_NOT_READY'
  | 'WEEK_NOT_IN_REVIEW'
  | 'WEEK_NOT_ENDED'
  | 'WEEK_APPROVED'
  | 'PAYROLL_ALREADY_APPROVED'
  | 'EXCEL_ERA_WEEK'
  | 'SYNC_IN_PROGRESS'
  | 'INVALID_WEEK'
  | 'FUTURE_WEEK'
  | 'VALIDATION_ERROR'
  | 'EMPLOYEE_NOT_FOUND'
  | 'CODE_NOT_FOUND'
  | 'CORRECTION_NOT_ACTIVE'
  | 'DAY_CHANGED'
  | 'CONFIG_MISSING'
  | 'SYNC_FAILED'

export class AttendanceSyncError extends Error {
  constructor(
    public readonly code: AttendanceSyncErrorCode,
    message: string,
    /** Extra payload for the caller, e.g. the DayValidation for VALIDATION_ERROR. */
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AttendanceSyncError'
  }
}

export type ActionResult<T> =
  | { ok: true; data: T }
  // `validation` accompanies VALIDATION_ERROR from savePunchEditAction so the editor can mark the field.
  | { ok: false; error: string; code?: string; validation?: DayValidation }
