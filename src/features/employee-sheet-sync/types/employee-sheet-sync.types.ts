// F13: one-way sync of the Employee Master List tab of a Google Sheet into the app.

// ─── Sheet input ──────────────────────────────────────────────────────────────

/** The header row plus the value rows below it. The sheet row number of rows[i] is i + 2. */
export interface SheetValues {
  header: string[]
  rows: string[][]
}

// ─── Fields the sheet owns ────────────────────────────────────────────────────

export type SheetOwnedField =
  | 'employeeName'
  | 'designation'
  | 'designationShort'
  | 'dateOfJoining'
  | 'nationalId'
  | 'aadhaarId'
  | 'policeVerificationId'
  | 'phone'
  | 'dateOfBirth'
  | 'healthCardId'
  | 'gPay'
  | 'bankAccount'
  | 'dateOfResignation'
  | 'site'
  | 'photoUrl'
  | 'aadhaarPhotoUrl'
  | 'panNumber'
  | 'panPhotoUrl'
  | 'whatsappNumber'
  | 'gPayName'
  | 'gPayRelation'
  | 'bankName'
  | 'bankHolderName'
  | 'bankHolderRelation'
  | 'ifscCode'
  | 'passbookPhotoUrl'
  | 'height'
  | 'bloodGroup'
  | 'emergencyContactName'
  | 'emergencyContactNumber'
  | 'emergencyContactRelation'
  | 'homeAddress'
  | 'homeState'
  | 'language'
  | 'relativesOnSite'
  | 'roomNumber'
  | 'distinctiveFeatures'
  | 'otherSkills'
  | 'remarks'

/** Text, or 'YYYY-MM-DD' for dates. null = empty. */
export type FieldValue = string | null

export interface FieldWarning {
  field: string
  header: string
  raw: string
  reason: 'INVALID_DATE' | 'INVALID_ACTIVE' | 'INVALID_SALARY'
}

// ─── Parsed rows ──────────────────────────────────────────────────────────────

export type RequiredField = 'employeeName' | 'designation' | 'salary' | 'dateOfJoining'

export interface ParsedRow {
  rowNumber: number
  /** The Sr. value as a number; null when it is blank, XXX or not digits. */
  sr: number | null
  /** The Sr. cell as written (trimmed), kept for the zero-padded serial number. */
  srRaw: string
  /** The Employee ID cell; null when blank, X, Y or a formula error such as #N/A. */
  employeeIdRaw: string | null
  /** Only fields whose header exists and whose value could be read. An empty cell is null. */
  fields: Partial<Record<SheetOwnedField, FieldValue>>
  salary: { value: number | null; raw: string }
  active: { value: boolean | null; raw: string }
  activeInvalid: boolean
  requiredErrors: { field: RequiredField; raw: string }[]
  warnings: FieldWarning[]
}

export interface ParseResult {
  rows: ParsedRow[]
  /** Owned fields whose header is in the sheet. Missing optional headers are never written or cleared. */
  presentFields: SheetOwnedField[]
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type SheetSyncErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'SHEET_NOT_SHARED'
  | 'SHEET_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'MISSING_REQUIRED_HEADERS'
  | 'EMPTY_SHEET'
  | 'FETCH_FAILED'
  | 'SYNC_DISABLED'
  | 'STALE_PLAN'
  | 'FIXTURE_NOT_LOCAL'

export class SheetSyncError extends Error {
  constructor(
    public readonly code: SheetSyncErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'SheetSyncError'
  }
}

// ─── App snapshot and plan ────────────────────────────────────────────────────

export interface EmployeeSnapshot {
  id: string
  employeeId: string
  employeeName: string
  /** Trailing digits of the Employee ID; null when it has none. */
  number: number | null
  isActive: boolean
  /** Daily wage of the open wage row; null when the employee has none. */
  openWage: number | null
  fields: Record<SheetOwnedField, FieldValue>
}

export interface FieldChange {
  field: SheetOwnedField
  old: FieldValue
  new: FieldValue
}

export interface PlannedCreate {
  rowNumber: number
  number: number
  employeeId: string
  serialNumber: string
  fields: Partial<Record<SheetOwnedField, FieldValue>>
  salary: number
  isActive: boolean
  wageEffectiveFrom: string
  warnings: FieldWarning[]
}

export interface PlannedUpdate {
  rowNumber: number
  employeeDbId: string
  employeeId: string
  employeeName: string
  changes: FieldChange[]
  warnings: FieldWarning[]
}

export type SkipReason =
  | 'SR_INVALID'
  | 'SR_DUPLICATE'
  | 'AMBIGUOUS_APP_MATCH'
  | 'NEW_EMPLOYEE_ID_INVALID'
  | 'NEW_SR_ID_MISMATCH'
  | 'NEW_REQUIRED_INVALID'
  | 'EXISTING_REQUIRED_INVALID'
  | 'NEW_EMPLOYEE_ID_TAKEN'

export interface PlannedSkip {
  rowNumber: number
  srRaw: string
  employeeIdRaw: string | null
  name: string | null
  reason: SkipReason
  detail?: string
}

export type RowWarning =
  | { kind: 'SALARY_MISMATCH'; rowNumber: number; employeeId: string; sheet: number; app: number | null }
  | { kind: 'STATUS_MISMATCH'; rowNumber: number; employeeId: string; sheet: boolean; app: boolean }
  | { kind: 'FIELD'; rowNumber: number; employeeId: string | null; warning: FieldWarning }

export interface AppOnlyEmployee {
  employeeDbId: string
  employeeId: string
  employeeName: string
}

export interface SyncPlan {
  creates: PlannedCreate[]
  /** Only employees with at least one change. */
  updates: PlannedUpdate[]
  unchangedCount: number
  skips: PlannedSkip[]
  warnings: RowWarning[]
  appOnly: AppOnlyEmployee[]
}

export type SheetSourceMode = 'LIVE' | 'FIXTURE'

export interface SyncReport extends SyncPlan {
  tab: string
  mode: SheetSourceMode
  generatedAt: string
}

export type SyncTrigger = 'MANUAL' | 'SCHEDULED'

export interface LastSheetSync {
  runId: string
  at: string
  trigger: SyncTrigger
  status: 'APPLIED' | 'FAILED'
  created: number
  updated: number
  skipped: number
  warnings: number
  skips: PlannedSkip[]
  error?: string
}

// ─── Service results ──────────────────────────────────────────────────────────

export interface SheetSyncPreview {
  plan: SyncReport
  planHash: string
}

export type ApplySheetSyncResult =
  | { status: 'APPLIED'; runId: string; report: SyncReport }
  | { status: 'STALE'; plan: SyncReport; planHash: string }

export type ScheduledSheetSyncOutcome =
  | { skipped: 'DISABLED' | 'NOT_FIRST_APPLIED' }
  | { runId: string; created: number; updated: number; skipped: number }

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }
