import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import {
  PayrollHistoryRow,
  PayrollRecordDetail,
  PayrollHistoryDailyAttendance,
  PayrollHistoryAdjustment
} from '../types/payroll-history.types'

export async function searchPayrollHistory(params: { employeeName?: string; employeeId?: string }): Promise<PayrollHistoryRow[]> {
  if (!params.employeeName && !params.employeeId) {
    return []
  }

  const whereClause: Prisma.PayrollRunEmployeeWhereInput = {
    payrollRun: { status: { in: ['APPROVED', 'REVISED'] } },
    payrollRevision: { isCurrent: true }
  }

  if (params.employeeName) {
    whereClause.employee = { employeeName: { contains: params.employeeName, mode: 'insensitive' } }
  } else if (params.employeeId) {
    whereClause.employee = { employeeId: { contains: params.employeeId, mode: 'insensitive' } }
  }

  const rows = await prisma.payrollRunEmployee.findMany({
    where: whereClause,
    include: {
      employee: true,
      payrollRun: true,
      payrollRevision: true
    },
    orderBy: {
      payrollRun: { payrollWeekStartDate: 'desc' }
    }
  })

  return rows.map(r => ({
    recordId: r.id,
    payrollRunId: r.payrollRunId,
    payrollRevisionId: r.payrollRevisionId,
    employeeId: r.employeeId,
    employeeName: r.employee.employeeName,
    employeeIdString: r.employee.employeeId,
    weekStart: r.payrollRun.payrollWeekStartDate,
    weekEnd: r.payrollRun.payrollWeekEndDate,
    regularHours: r.regularHours.toNumber(),
    overtimeHours: r.overtimeHours.toNumber(),
    grossPay: r.regularPay.toNumber() + r.overtimePay.toNumber(),
    netPayable: r.netPayable.toNumber(),
    revisionNumber: r.payrollRevision.revisionNumber,
    isCurrent: r.payrollRevision.isCurrent
  }))
}

export async function getPayrollHistoryByWeek(weekStart: string, weekEnd: string): Promise<PayrollHistoryRow[]> {
  const rows = await prisma.payrollRunEmployee.findMany({
    where: {
      payrollRun: {
        payrollWeekStartDate: new Date(weekStart),
        payrollWeekEndDate: new Date(weekEnd),
        status: { in: ['APPROVED', 'REVISED'] }
      },
      payrollRevision: { isCurrent: true }
    },
    include: {
      employee: true,
      payrollRun: true,
      payrollRevision: true
    },
    orderBy: {
      employee: { employeeName: 'asc' }
    }
  })

  return rows.map(r => ({
    recordId: r.id,
    payrollRunId: r.payrollRunId,
    payrollRevisionId: r.payrollRevisionId,
    employeeId: r.employeeId,
    employeeName: r.employee.employeeName,
    employeeIdString: r.employee.employeeId,
    weekStart: r.payrollRun.payrollWeekStartDate,
    weekEnd: r.payrollRun.payrollWeekEndDate,
    regularHours: r.regularHours.toNumber(),
    overtimeHours: r.overtimeHours.toNumber(),
    grossPay: r.regularPay.toNumber() + r.overtimePay.toNumber(),
    netPayable: r.netPayable.toNumber(),
    revisionNumber: r.payrollRevision.revisionNumber,
    isCurrent: r.payrollRevision.isCurrent
  }))
}

export async function getApprovedPayrollWeeks(): Promise<{ weekStart: string; weekEnd: string }[]> {
  const weeks = await prisma.payrollRun.findMany({
    where: { status: { in: ['APPROVED', 'REVISED'] } },
    select: { payrollWeekStartDate: true, payrollWeekEndDate: true },
    distinct: ['payrollWeekStartDate', 'payrollWeekEndDate'],
    orderBy: { payrollWeekStartDate: 'desc' }
  })

  return weeks.map(w => ({
    weekStart: w.payrollWeekStartDate.toISOString(),
    weekEnd: w.payrollWeekEndDate.toISOString()
  }))
}

export async function getPayrollRecordDetail(recordId: string): Promise<PayrollRecordDetail> {
  const record = await prisma.payrollRunEmployee.findUnique({
    where: { id: recordId },
    include: {
      employee: {
        include: {
          attendanceRecords: true
        }
      },
      payrollRun: {
        include: {
          adjustmentApplications: {
            include: {
              payrollAdjustment: true
            }
          }
        }
      },
      payrollRevision: true
    }
  })

  if (!record) {
    throw new Error('Payroll record not found')
  }

  // Filter attendance records to match the specific payroll week and employee
  const attendance = record.employee.attendanceRecords
    .filter(a => 
      a.attendanceDate >= record.payrollRun.payrollWeekStartDate && 
      a.attendanceDate <= record.payrollRun.payrollWeekEndDate
    )
    .sort((a, b) => a.attendanceDate.getTime() - b.attendanceDate.getTime())
    .map(a => ({
      date: a.attendanceDate,
      regularHours: a.regularHours.toNumber(),
      overtimeHours: a.overtimeHours.toNumber()
    }))

  // Filter adjustment applications for this employee
  const adjustments = record.payrollRun.adjustmentApplications
    .filter(a => a.employeeId === record.employeeId)
    .map(a => ({
      type: a.payrollAdjustment.adjustmentType as 'ADDITION' | 'DEDUCTION',
      amount: a.appliedAmount.toNumber(),
      reason: a.payrollAdjustment.reason
    }))

  return {
    recordId: record.id,
    employeeId: record.employeeId,
    employeeName: record.employee.employeeName,
    employeeIdString: record.employee.employeeId,
    designation: record.employee.designation,
    hourlyRate: record.hourlyRateUsed.toNumber(),
    weekStart: record.payrollRun.payrollWeekStartDate,
    weekEnd: record.payrollRun.payrollWeekEndDate,
    revisionNumber: record.payrollRevision.revisionNumber,
    isCurrent: record.payrollRevision.isCurrent,
    attendance,
    totalRegularHours: record.regularHours.toNumber(),
    totalOvertimeHours: record.overtimeHours.toNumber(),
    regularPay: record.regularPay.toNumber(),
    overtimePay: record.overtimePay.toNumber(),
    grossPay: record.regularPay.toNumber() + record.overtimePay.toNumber(),
    adjustments,
    netPayable: record.netPayable.toNumber()
  }
}
