import prisma from '@/lib/prisma'
import type { StatusChangeSummary, StatusChangedEmployee } from '../types/attendance-sync.types'

function asEmployees(value: unknown): StatusChangedEmployee[] {
  return Array.isArray(value) ? (value as StatusChangedEmployee[]) : []
}

/** The employee status changes the week's latest approval made. Empty lists when none. */
export async function getLatestStatusChanges(uploadId: string): Promise<StatusChangeSummary> {
  const entry = await prisma.auditLog.findFirst({
    where: {
      entityType: 'ATTENDANCE_WEEK',
      entityId: uploadId,
      actionType: 'APPROVE',
    },
    orderBy: { createdAt: 'desc' },
    select: { detailsJson: true },
  })
  const changes = (entry?.detailsJson as { statusChanges?: Partial<StatusChangeSummary> } | null)?.statusChanges
  return { markedInactive: asEmployees(changes?.markedInactive), reactivated: asEmployees(changes?.reactivated) }
}
