import type { AttendanceUpload } from '@prisma/client'
import prisma from '@/lib/prisma'
import { round2 } from '../lib/time'
import { getWeekDates, toISODate } from '../lib/week'
import type { ExcelWeekData } from '../types/excel-week.types'
import type { WeekPayrollStatus } from '../types/attendance-sync.types'

/**
 * The hours of an Excel-era week, read from its attendance records. Weeks from that era have no
 * punches, so this shows hours only. Returns null when the row is missing or isn't an Excel week.
 */
export async function getExcelWeekData(upload: AttendanceUpload | null): Promise<ExcelWeekData | null> {
  if (!upload || upload.source !== 'EXCEL') return null

  const week = { start: toISODate(upload.payrollWeekStartDate), end: toISODate(upload.payrollWeekEndDate) }
  const dates = getWeekDates(week)

  const [records, run] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { attendanceUploadId: upload.id },
      select: {
        attendanceDate: true,
        regularHours: true,
        overtimeHours: true,
        employee: { select: { id: true, employeeId: true, employeeName: true } },
      },
    }),
    prisma.payrollRun.findFirst({
      where: { payrollWeekStartDate: upload.payrollWeekStartDate, status: { in: ['APPROVED', 'REVISED'] } },
      select: { id: true, status: true },
    }),
  ])

  const byEmployee = new Map<string, ExcelWeekData['employees'][number]>()
  for (const record of records) {
    const entry =
      byEmployee.get(record.employee.id) ??
      {
        employeeId: record.employee.id,
        employeeCode: record.employee.employeeId,
        employeeName: record.employee.employeeName,
        days: dates.map((date) => ({ date, regular: 0, overtime: 0 })),
        totalRegular: 0,
        totalOvertime: 0,
      }
    const day = entry.days.find((d) => d.date === toISODate(record.attendanceDate))
    if (day) {
      day.regular = round2(day.regular + Number(record.regularHours))
      day.overtime = round2(day.overtime + Number(record.overtimeHours))
    }
    byEmployee.set(record.employee.id, entry)
  }

  const employees = [...byEmployee.values()]
    .map((employee) => ({
      ...employee,
      totalRegular: round2(employee.days.reduce((sum, d) => sum + d.regular, 0)),
      totalOvertime: round2(employee.days.reduce((sum, d) => sum + d.overtime, 0)),
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName))

  const byDay = dates.map((date, index) => ({
    date,
    regular: round2(employees.reduce((sum, e) => sum + e.days[index].regular, 0)),
    overtime: round2(employees.reduce((sum, e) => sum + e.days[index].overtime, 0)),
  }))

  const payrollStatus: WeekPayrollStatus = run ? (run.status === 'REVISED' ? 'REVISED' : 'APPROVED') : 'NOT_GENERATED'

  return {
    weekId: week.start,
    week,
    fileName: upload.fileName,
    uploadedAt: upload.uploadedAt.toISOString(),
    dates,
    employees,
    totals: {
      byDay,
      regular: round2(byDay.reduce((sum, d) => sum + d.regular, 0)),
      overtime: round2(byDay.reduce((sum, d) => sum + d.overtime, 0)),
    },
    payroll: { status: payrollStatus, payrollRunId: run?.id ?? null },
  }
}
