import type { ISODate, WeekPayrollStatus, WeekRange } from './attendance-sync.types'

/** A read-only view of a week imported from Excel before the eTimeOffice sync existed. */
export interface ExcelWeekData {
  weekId: ISODate
  week: WeekRange
  fileName: string | null
  uploadedAt: string
  dates: ISODate[]
  employees: Array<{
    employeeId: string
    employeeCode: string
    employeeName: string
    days: Array<{ date: ISODate; regular: number; overtime: number }>
    totalRegular: number
    totalOvertime: number
  }>
  totals: { byDay: Array<{ date: ISODate; regular: number; overtime: number }>; regular: number; overtime: number }
  payroll: { status: WeekPayrollStatus; payrollRunId: string | null }
}
