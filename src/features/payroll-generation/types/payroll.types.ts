// ─── Week/Attendance status ───────────────────────────────────────────────────

export type AttendanceWeekStatus = 'NO_DATA' | 'SYNC_FAILED' | 'REVIEW' | 'APPROVED'
export type PayrollRunStatus = 'NOT_GENERATED' | 'APPROVED' | 'REVISED'

export interface PayrollWeekItem {
  weekId: string // YYYY-MM-DD (ISO start date)
  weekStart: Date
  weekEnd: Date
  attendanceStatus: AttendanceWeekStatus
  source: 'EXCEL' | 'ETIMEOFFICE'
  matchedEmployeeCount: number
  totalRegularHours: number
  totalOvertimeHours: number
  payrollStatus: PayrollRunStatus
  payrollRunId: string | null
  /** Only an approved eTimeOffice week without a payroll run can start payroll. */
  canGenerate: boolean
}

// ─── Attendance readiness ─────────────────────────────────────────────────────

export type AttendanceReadinessResult =
  | {
      ready: true
      matchedEmployeeCount: number
      /** Employees the approval left out: zero hours, or rejected in the employee check. */
      leftOutCount: number
      totalRegularHours: number
      totalOvertimeHours: number
    }
  | { ready: false; reason: 'NO_DATA' | 'SYNC_FAILED' | 'NOT_APPROVED' | 'EXCEL_ERA' }

// ─── Payroll calculation ──────────────────────────────────────────────────────

export interface EmployeePayrollRow {
  employeeId: string
  employeeCode: string
  employeeName: string
  designation: string
  designationShort: string | null
  site: string | null
  gPay: string | null
  phone: string | null
  bankAccount: string | null
  weeklySalaryUsed: number
  hourlyRateUsed: number
  regularHours: number
  overtimeHours: number
  regularPay: number
  overtimePay: number
  grossPay: number
  additions: number
  deductions: number
  netPayable: number
}

export interface PayrollSummaryTotals {
  totalRegularHours: number
  totalOvertimeHours: number
  totalRegularPay: number
  totalOvertimePay: number
  totalAdditions: number
  totalDeductions: number
  totalNetPayable: number
}

export interface PayrollSummary {
  weekStart: Date
  weekEnd: Date
  /** When the week's attendance was approved; approvePayroll refuses a summary whose attendance has since changed. */
  attendanceApprovedAt: Date
  employees: EmployeePayrollRow[]
  totals: PayrollSummaryTotals
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovePayrollResult {
  payrollRunId: string
  payrollRevisionId: string
  revisionNumber: number
  approvedAt: Date
  totalNetPayable: number
  employeeCount: number
}

// ─── Service error ────────────────────────────────────────────────────────────

export class PayrollServiceError extends Error {
  constructor(
    public readonly code:
      | 'NO_ATTENDANCE_UPLOAD'
      | 'ATTENDANCE_NOT_APPROVED'
      | 'EXCEL_ERA_WEEK'
      | 'NO_EMPLOYEES'
      | 'PAYROLL_ALREADY_EXISTS'
      | 'ATTENDANCE_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'PayrollServiceError'
  }
}
