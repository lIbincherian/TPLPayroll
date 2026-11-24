// ─── Constants ────────────────────────────────────────────────────────────────
// The Excel import was removed in F13 (employees are synced from the Employee Master sheet).
// These names are what the Excel export still writes.

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
  hourlyRate: 'Hourly Rate', // exported for reference
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

// ─── Service error ────────────────────────────────────────────────────────────

export class ImportExportServiceError extends Error {
  constructor(
    public readonly code: 'EXPORT_FAILED',
    message: string
  ) {
    super(message)
    this.name = 'ImportExportServiceError'
  }
}
