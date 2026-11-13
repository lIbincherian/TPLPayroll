import prisma from '@/lib/prisma'
import type { ISODate, StatusChangeSummary, StatusChangedEmployee } from '../types/attendance-sync.types'

type StatusAuditDetails = { employeeId?: string; employeeName?: string; isActive?: { to?: boolean } }

/**
 * Every employee status change this week's approvals made, read from the `AUTO_ATTENDANCE` audit rows
 * so a later re-approval that changes nobody keeps the list. An employee changed twice counts once,
 * by their latest change. Empty lists when none.
 */
export async function getWeekStatusChanges(weekStart: ISODate): Promise<StatusChangeSummary> {
  const entries = await prisma.auditLog.findMany({
    where: {
      entityType: 'EMPLOYEE',
      AND: [
        { detailsJson: { path: ['changeSource'], equals: 'AUTO_ATTENDANCE' } },
        { detailsJson: { path: ['weekStart'], equals: weekStart } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { entityId: true, detailsJson: true },
  })

  const latest = new Map<string, { employee: StatusChangedEmployee; active: boolean }>()
  for (const entry of entries) {
    const details = entry.detailsJson as StatusAuditDetails | null
    if (typeof details?.isActive?.to !== 'boolean') continue
    latest.set(entry.entityId, {
      employee: { id: entry.entityId, employeeId: details.employeeId ?? '', employeeName: details.employeeName ?? '' },
      active: details.isActive.to,
    })
  }
  const changed = [...latest.values()]
  return {
    markedInactive: changed.filter((c) => !c.active).map((c) => c.employee),
    reactivated: changed.filter((c) => c.active).map((c) => c.employee),
  }
}
