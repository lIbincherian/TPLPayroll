export interface DailyAttendanceRow {
  day: string       // "Thursday"
  date: string      // "6 Mar"
  beforeNoonIn: string | null
  beforeNoonOut: string | null
  afternoonIn: string | null
  afternoonOut: string | null
  overtimeIn: string | null
  overtimeOut: string | null
  regularHours: number
  overtimeHours: number
  /** API weeks: "07:40–13:04, 13:56–17:47", or "-" when the day has no punches. Absent on Excel-era slips. */
  punches?: string | null
}

export type SlipAttendanceSource = 'EXCEL' | 'ETIMEOFFICE'

export interface PayrollSlipData {
  employeeCode: string
  employeeName: string
  designation: string
  site: string | null
  gPay: string | null
  bankAccount: string | null
  weekStart: string          // ISO string
  weekEnd: string            // ISO string
  payrollRunId: string
  payrollRevisionId: string
  employeeDbId: string
  /** Which layout the slip uses. Absent on snapshots from before F12, which keep the six-column layout. */
  attendanceSource?: SlipAttendanceSource
  dailyAttendance: DailyAttendanceRow[]
  regularHours: number
  overtimeHours: number
  hourlyRateUsed: number
  regularPay: number
  overtimePay: number
  grossPay: number
  additions: number
  deductions: number
  netPayable: number
  generatedAt: string        // ISO string
}

export class ReportServiceError extends Error {
  constructor(
    public readonly code: 'PAYROLL_RUN_NOT_FOUND' | 'PAYROLL_NOT_APPROVED' | 'NO_EMPLOYEES',
    message: string,
  ) {
    super(message)
    this.name = 'ReportServiceError'
  }
}
