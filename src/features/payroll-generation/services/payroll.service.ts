import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import {
  PayrollServiceError,
  type PayrollWeekItem,
  type AttendanceReadinessResult,
  type EmployeePayrollRow,
  type PayrollSummary,
  type PayrollSummaryTotals,
  type ApprovePayrollResult,
} from '@/features/payroll-generation/types/payroll.types'
import type { WeeklyReviewItem } from '@/features/payroll-adjustments/types/adjustment.types'
import {
  getAdjustmentsForWeekReview,
  skipAdjustmentApplication,
} from '@/features/payroll-adjustments/services/adjustment.service'
import { listAttendanceWeeks } from '@/features/attendance-sync/services/week-list.service'
import { getApprovalSummary } from '@/features/attendance-sync/services/week-approval.service'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { toISODate } from '@/features/attendance-sync/lib/week'

// ─── Pure calculation helpers (exported for unit testing) ────────────────────

export function calculateRegularPay(
  dailyRegularHours: number[],
  hourlyRate: number,
): { regularHours: number; regularPay: number } {
  const regularHours = dailyRegularHours.reduce((sum, h) => sum + h, 0)
  const regularPay = regularHours * hourlyRate
  return { regularHours, regularPay }
}

export function calculateOvertimePay(
  dailyOvertimeHours: number[],
  hourlyRate: number,
): { overtimeHours: number; overtimePay: number } {
  const overtimeHours = dailyOvertimeHours.reduce((sum, h) => sum + h, 0)
  const overtimePay = overtimeHours * hourlyRate
  return { overtimeHours, overtimePay }
}

export function calculateNetPayable(
  grossPay: number,
  additions: number,
  deductions: number,
): number {
  return grossPay + additions - deductions
}

// ─── getAvailablePayrollWeeks ─────────────────────────────────────────────────

/**
 * The payroll week list, built on the attendance week list so both pages show the same
 * statuses. Only an approved eTimeOffice week without a payroll run can be generated.
 */
export async function getAvailablePayrollWeeks(): Promise<PayrollWeekItem[]> {
  const weeks = await listAttendanceWeeks()

  return weeks.map((week): PayrollWeekItem => {
    const source = week.source === 'EXCEL' ? 'EXCEL' : 'ETIMEOFFICE'
    return {
      weekId: week.weekId,
      weekStart: new Date(`${week.week.start}T00:00:00.000Z`),
      weekEnd: new Date(`${week.week.end}T00:00:00.000Z`),
      attendanceStatus: week.status,
      source,
      matchedEmployeeCount: week.employeeCount,
      totalRegularHours: week.totalRegularHours,
      totalOvertimeHours: week.totalOvertimeHours,
      payrollStatus: week.payrollStatus,
      payrollRunId: week.payrollRunId,
      canGenerate: source === 'ETIMEOFFICE' && week.status === 'APPROVED' && week.payrollStatus === 'NOT_GENERATED',
    }
  })
}

// ─── checkAttendanceReadiness ─────────────────────────────────────────────────

export async function checkAttendanceReadiness(
  weekStart: Date,
  weekEnd: Date,
): Promise<AttendanceReadinessResult> {
  const upload = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      isActiveForPayrollWeek: true,
    },
  })

  if (!upload) return { ready: false, reason: 'NO_DATA' }
  if (upload.source === 'EXCEL') return { ready: false, reason: 'EXCEL_ERA' }
  if (upload.status === 'SYNC_FAILED') return { ready: false, reason: 'SYNC_FAILED' }
  if (upload.status !== 'APPROVED') return { ready: false, reason: 'NOT_APPROVED' }

  const records = await prisma.attendanceRecord.findMany({
    where: { attendanceUploadId: upload.id },
    select: { employeeId: true, regularHours: true, overtimeHours: true },
  })

  const employeeIds = new Set(records.map((r) => r.employeeId))
  const totalRegularHours = records.reduce((sum, r) => sum + Number(r.regularHours), 0)
  const totalOvertimeHours = records.reduce((sum, r) => sum + Number(r.overtimeHours), 0)

  // "Left out" is what the approval summary showed: zero-hour employees plus rejected ones.
  const summary = await getApprovalSummary(toISODate(weekStart))

  return {
    ready: true,
    matchedEmployeeCount: employeeIds.size,
    leftOutCount: summary.leftOut.length,
    totalRegularHours,
    totalOvertimeHours,
  }
}

// ─── getPendingAdjustmentsForWeek ─────────────────────────────────────────────

/**
 * Pending adjustments for the employees who are in this week's approved attendance.
 * A left-out employee's adjustments are not reviewed here; approvePayroll carries them
 * forward instead.
 */
export async function getPendingAdjustmentsForWeek(
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyReviewItem[]> {
  const upload = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      isActiveForPayrollWeek: true,
    },
    select: { id: true },
  })
  if (!upload) return []

  const [items, included] = await Promise.all([
    getAdjustmentsForWeekReview(weekStart),
    prisma.attendanceRecord.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true },
      distinct: ['employeeId'],
    }),
  ])

  const includedIds = new Set(included.map((r) => r.employeeId))
  return items.filter((item) => includedIds.has(item.employeeId))
}

// ─── calculatePayroll ─────────────────────────────────────────────────────────

export async function calculatePayroll(
  weekStart: Date,
  weekEnd: Date,
): Promise<PayrollSummary> {
  const upload = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      isActiveForPayrollWeek: true,
    },
  })

  if (!upload) {
    throw new PayrollServiceError('NO_ATTENDANCE_UPLOAD', 'No attendance has been loaded for this week')
  }
  if (upload.source === 'EXCEL') {
    throw new PayrollServiceError('EXCEL_ERA_WEEK', "Excel-era weeks can't start payroll")
  }
  if (upload.status !== 'APPROVED' || !upload.approvedAt) {
    throw new PayrollServiceError('ATTENDANCE_NOT_APPROVED', "Attendance for this week isn't approved yet")
  }
  const attendanceApprovedAt = upload.approvedAt

  const attendanceRecords = await prisma.attendanceRecord.findMany({
    where: { attendanceUploadId: upload.id },
    include: {
      employee: {
        select: {
          id: true,
          employeeId: true,
          employeeName: true,
          designation: true,
          designationShort: true,
          site: true,
          gPay: true,
          bankAccount: true,
          wageHistory: {
            where: {
              effectiveFrom: { lte: weekEnd },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: weekStart } }],
            },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ employeeId: 'asc' }, { attendanceDate: 'asc' }],
  })

  if (attendanceRecords.length === 0) {
    throw new PayrollServiceError('NO_EMPLOYEES', 'No attendance records found for this week')
  }

  type EmployeeGroup = {
    employee: (typeof attendanceRecords)[0]['employee']
    records: (typeof attendanceRecords)[0][]
  }

  const employeeMap = new Map<string, EmployeeGroup>()
  for (const record of attendanceRecords) {
    const key = record.employeeId
    if (!employeeMap.has(key)) {
      employeeMap.set(key, { employee: record.employee, records: [] })
    }
    employeeMap.get(key)!.records.push(record)
  }

  const approvedApplications = await prisma.payrollAdjustmentApplication.findMany({
    where: {
      payrollWeekStartDate: weekStart,
      approvalStatus: 'APPROVED',
      employeeId: { in: [...employeeMap.keys()] },
      payrollAdjustment: { status: { not: 'CANCELLED' } },
    },
    include: {
      payrollAdjustment: { select: { adjustmentType: true } },
    },
  })

  type AdjGroup = { additions: number; deductions: number }
  const adjByEmployee = new Map<string, AdjGroup>()
  for (const app of approvedApplications) {
    if (!adjByEmployee.has(app.employeeId)) {
      adjByEmployee.set(app.employeeId, { additions: 0, deductions: 0 })
    }
    const group = adjByEmployee.get(app.employeeId)!
    const amount = Number(app.appliedAmount)
    if (app.payrollAdjustment.adjustmentType === 'ADDITION') {
      group.additions += amount
    } else {
      group.deductions += amount
    }
  }

  const employeeRows: EmployeePayrollRow[] = []

  for (const [, group] of employeeMap) {
    const { employee, records } = group
    const wage = employee.wageHistory[0]
    if (!wage) continue

    const hourlyRate = Number(wage.hourlyRate)
    const weeklySalary = Number(wage.weeklySalary)

    const dailyRegular = records.map((r) => Number(r.regularHours))
    const dailyOT = records.map((r) => Number(r.overtimeHours))

    const { regularHours, regularPay } = calculateRegularPay(dailyRegular, hourlyRate)
    const { overtimeHours, overtimePay } = calculateOvertimePay(dailyOT, hourlyRate)
    const grossPay = regularPay + overtimePay

    const adjs = adjByEmployee.get(employee.id) ?? { additions: 0, deductions: 0 }
    const netPayable = calculateNetPayable(grossPay, adjs.additions, adjs.deductions)

    employeeRows.push({
      employeeId: employee.id,
      employeeCode: employee.employeeId,
      employeeName: employee.employeeName,
      designation: employee.designation,
      designationShort: employee.designationShort,
      site: employee.site,
      gPay: employee.gPay,
      bankAccount: employee.bankAccount,
      weeklySalaryUsed: weeklySalary,
      hourlyRateUsed: hourlyRate,
      regularHours,
      overtimeHours,
      regularPay,
      overtimePay,
      grossPay,
      additions: adjs.additions,
      deductions: adjs.deductions,
      netPayable,
    })
  }

  if (employeeRows.length === 0) {
    throw new PayrollServiceError('NO_EMPLOYEES', 'No employees with valid wage history for this week')
  }

  const totals: PayrollSummaryTotals = {
    totalRegularHours: employeeRows.reduce((s, r) => s + r.regularHours, 0),
    totalOvertimeHours: employeeRows.reduce((s, r) => s + r.overtimeHours, 0),
    totalRegularPay: employeeRows.reduce((s, r) => s + r.regularPay, 0),
    totalOvertimePay: employeeRows.reduce((s, r) => s + r.overtimePay, 0),
    totalAdditions: employeeRows.reduce((s, r) => s + r.additions, 0),
    totalDeductions: employeeRows.reduce((s, r) => s + r.deductions, 0),
    totalNetPayable: employeeRows.reduce((s, r) => s + r.netPayable, 0),
  }

  return { weekStart, weekEnd, attendanceApprovedAt, employees: employeeRows, totals }
}

// ─── approvePayroll ───────────────────────────────────────────────────────────

/**
 * Approve the payroll: create the run, revision 1 and the employee rows, link the week's
 * approved adjustments, and carry forward the adjustments of employees who were left out
 * of this payroll. All of it is one transaction, so a carry-forward can never be applied
 * without the approval (or the approval without the carry-forward).
 *
 * The week's attendance is re-checked inside that transaction, under the week's row lock. The
 * summary was calculated earlier, so if the week was reopened (and approved again, possibly with
 * different hours) in the meantime the approval must not go through: the summary carries the
 * attendance's approval time, and it must still match.
 */
export async function approvePayroll(summary: PayrollSummary): Promise<ApprovePayrollResult> {
  const existing = await prisma.payrollRun.findFirst({
    where: {
      payrollWeekStartDate: summary.weekStart,
      payrollWeekEndDate: summary.weekEnd,
      status: { in: ['APPROVED', 'REVISED'] },
    },
  })

  if (existing) {
    throw new PayrollServiceError('PAYROLL_ALREADY_EXISTS', 'Payroll for this week is already approved')
  }

  const { totals, weekStart, weekEnd, employees } = summary
  const now = new Date()

  const runId = randomUUID()
  const revisionId = randomUUID()
  const includedIds = employees.map((emp) => emp.employeeId)

  await prisma.$transaction(
    async (tx) => {
      // The attendance must still be the approved eTimeOffice week the summary was built from.
      // Reopening the week changes its status back to REVIEW and removes its records; approving
      // it again stamps a new approval time.
      const upload = await lockWeekRow(tx, { weekStart })
      if (!upload || upload.source !== 'ETIMEOFFICE' || upload.status !== 'APPROVED') {
        throw new PayrollServiceError('ATTENDANCE_NOT_APPROVED', "Attendance for this week isn't approved yet")
      }
      if (!upload.approvedAt || upload.approvedAt.getTime() !== new Date(summary.attendanceApprovedAt).getTime()) {
        throw new PayrollServiceError(
          'ATTENDANCE_CHANGED',
          'Attendance for this week changed after this summary was calculated. Go back and recalculate.',
        )
      }

      // Carry forward first. Skipping moves a left-out employee's pending or approved
      // application to the next week, so the link step below can never attach it to this run.
      const leftOutApplications = await tx.payrollAdjustmentApplication.findMany({
        where: {
          payrollWeekStartDate: weekStart,
          payrollRunId: null,
          approvalStatus: { in: ['PENDING', 'APPROVED'] },
          employeeId: { notIn: includedIds },
          payrollAdjustment: { status: { not: 'CANCELLED' } },
        },
        select: { id: true },
      })
      for (const application of leftOutApplications) {
        await skipAdjustmentApplication(application.id, tx)
      }

      await tx.payrollRun.create({
        data: {
          id: runId,
          payrollWeekStartDate: weekStart,
          payrollWeekEndDate: weekEnd,
          status: 'APPROVED',
          currentRevisionNumber: 1,
          totalRegularPay: totals.totalRegularPay,
          totalOvertimePay: totals.totalOvertimePay,
          totalAdditions: totals.totalAdditions,
          totalDeductions: totals.totalDeductions,
          totalNetPayable: totals.totalNetPayable,
          approvedAt: now,
        },
      })

      await tx.payrollRevision.create({
        data: {
          id: revisionId,
          payrollRunId: runId,
          revisionNumber: 1,
          status: 'APPROVED',
          isCurrent: true,
          totalRegularPay: totals.totalRegularPay,
          totalOvertimePay: totals.totalOvertimePay,
          totalAdditions: totals.totalAdditions,
          totalDeductions: totals.totalDeductions,
          totalNetPayable: totals.totalNetPayable,
          approvedAt: now,
        },
      })

      await tx.payrollRunEmployee.createMany({
        data: employees.map((emp) => ({
          payrollRunId: runId,
          payrollRevisionId: revisionId,
          employeeId: emp.employeeId,
          weeklySalaryUsed: emp.weeklySalaryUsed,
          hourlyRateUsed: emp.hourlyRateUsed,
          regularHours: emp.regularHours,
          overtimeHours: emp.overtimeHours,
          regularPay: emp.regularPay,
          overtimePay: emp.overtimePay,
          additions: emp.additions,
          deductions: emp.deductions,
          netPayable: emp.netPayable,
        })),
      })

      await tx.payrollAdjustmentApplication.updateMany({
        where: {
          payrollWeekStartDate: weekStart,
          approvalStatus: 'APPROVED',
          payrollRunId: null,
        },
        data: {
          payrollRunId: runId,
          payrollRevisionId: revisionId,
        },
      })
    },
    { timeout: 30000 },
  )

  return {
    payrollRunId: runId,
    payrollRevisionId: revisionId,
    revisionNumber: 1,
    approvedAt: now,
    totalNetPayable: Number(totals.totalNetPayable),
    employeeCount: employees.length,
  }
}
