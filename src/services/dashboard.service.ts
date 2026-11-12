import prisma from '@/lib/prisma'

/**
 * Returns the count of currently active employees (isActive = true).
 */
export async function countActiveEmployees(): Promise<number> {
  return prisma.employee.count({
    where: { isActive: true },
  })
}

/**
 * Returns the totalNetPayable from the most recently approved payroll run's
 * current revision (isCurrent = true). Returns 0 if no approved run exists.
 */
export async function getLatestPayrollTotal(): Promise<number> {
  const revision = await prisma.payrollRevision.findFirst({
    where: {
      isCurrent: true,
      status: 'APPROVED',
      payrollRun: {
        status: { in: ['APPROVED', 'REVISED'] },
      },
    },
    orderBy: {
      approvedAt: 'desc',
    },
    select: {
      totalNetPayable: true,
    },
  })

  if (!revision) return 0

  return Number(revision.totalNetPayable)
}

/**
 * Returns the count of eTimeOffice attendance weeks that still need the owner's attention:
 * weeks whose sync failed, and weeks pulled but not yet approved. Excel-era weeks are
 * read-only and never counted.
 */
export async function countAttendanceWeeksAwaitingReview(): Promise<number> {
  return prisma.attendanceUpload.count({
    where: {
      isActiveForPayrollWeek: true,
      source: 'ETIMEOFFICE',
      status: { in: ['SYNC_FAILED', 'REVIEW'] },
    },
  })
}

/**
 * Returns the count of PayrollAdjustmentApplication records with
 * approvalStatus = 'PENDING'.
 */
export async function countPendingAdjustmentApprovals(): Promise<number> {
  return prisma.payrollAdjustmentApplication.count({
    where: {
      approvalStatus: 'PENDING',
    },
  })
}
