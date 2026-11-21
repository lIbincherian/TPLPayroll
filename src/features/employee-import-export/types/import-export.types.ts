import { z } from 'zod'

// ─── Constants ────────────────────────────────────────────────────────────────

export const IMPORT_SHEET_NAME = 'Employee Master List'

export const IMPORT_COLUMNS = {
  serialNumber: 'SL. NO',
  employeeId: 'Employee ID',
  employeeName: 'Employee Name',
  nationalId: 'National ID',
  designation: 'Designation',
  dateOfJoining: 'Date of Joining',
  aadhaarId: 'Aadhaar ID',
  policeVerificationId: 'Police Verification ID',
  salary: 'Daily Wage',
  legacySalary: 'Salary', // read when an older file has no 'Daily Wage' column
  hourlyRate: 'Hourly Rate', // exported for reference; ignored on import
  phone: 'Phone',
  dateOfBirth: 'D.O.B',
  healthCardId: 'Health Card ID',
  gPay: 'GPay',
  bankAccount: 'Bank Account',
  dateOfResignation: 'Date of Resignation',
  site: 'Site',
  active: 'Active',
  designationShort: 'Designation Short',
} as const

// ─── Error codes ──────────────────────────────────────────────────────────────

export type ImportFileErrorCode = 'UNSUPPORTED_FILE_TYPE' | 'SHEET_NOT_FOUND'

export type ImportRowErrorCode =
  | 'MISSING_EMPLOYEE_ID'
  | 'MISSING_EMPLOYEE_NAME'
  | 'MISSING_DESIGNATION'
  | 'MISSING_SALARY'
  | 'MISSING_ACTIVE'
  | 'INVALID_SALARY'
  | 'INVALID_ACTIVE_VALUE'

// ─── Row-level types ──────────────────────────────────────────────────────────

export interface ImportRowData {
  serialNumber: string | null
  employeeId: string
  employeeName: string
  nationalId: string | null
  designation: string
  dateOfJoining: Date | null
  aadhaarId: string | null
  policeVerificationId: string | null
  salary: number
  phone: string | null
  dateOfBirth: Date | null
  healthCardId: string | null
  gPay: string | null
  bankAccount: string | null
  dateOfResignation: Date | null
  site: string | null
  isActive: boolean
  designationShort: string | null
}

export type ImportRowAction = 'CREATE' | 'UPDATE'

export interface ValidImportRow {
  rowNumber: number
  action: ImportRowAction
  data: ImportRowData
  source?: 'fixed'  // present only for user-fixed rows; absent for originally-valid rows
}

export interface InvalidImportRow {
  rowNumber: number
  employeeId: string | null
  employeeName: string | null
  errors: ImportRowErrorCode[]
  partialData: Partial<ImportRowData>  // whatever fields were successfully parsed from the source row
}

export interface FixRowFormValues {
  employeeId?: string
  employeeName?: string
  designation?: string
  salary?: string       // string from input, parsed to number in applyRowFix
  isActive?: 'true' | 'false'  // radio button value
}

export interface DuplicateImportRow {
  rowNumber: number
  employeeId: string
  action: ImportRowAction
  data: ImportRowData
}

// ─── Parse result ─────────────────────────────────────────────────────────────

export interface ParseImportResult {
  totalRows: number
  validRows: ValidImportRow[]
  invalidRows: InvalidImportRow[]
  duplicateIdRows: DuplicateImportRow[]
}

// ─── Execute result ───────────────────────────────────────────────────────────

export interface ExecuteImportResult {
  batchId: string
  importedRowCount: number
  createdEmployeeCount: number
  updatedEmployeeCount: number
  rejectedRowCount: number
  duplicateEmployeeIdRowCount: number
}

// ─── Zod schema for parsed row validation ─────────────────────────────────────

export const ImportRowSchema = z.object({
  employeeId: z.string().min(1),
  employeeName: z.string().min(1),
  designation: z.string().min(1),
  salary: z.number().min(0),
  isActive: z.boolean(),
})

// ─── Service error ────────────────────────────────────────────────────────────

export class ImportExportServiceError extends Error {
  constructor(
    public readonly code: ImportFileErrorCode | 'IMPORT_FAILED' | 'EXPORT_FAILED',
    message: string
  ) {
    super(message)
    this.name = 'ImportExportServiceError'
  }
}
