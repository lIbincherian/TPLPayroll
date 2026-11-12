import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import type {
  AuditActionType,
  AuditEntityType,
} from '@/features/audit-logging/types/audit-log.types'

export interface AttendanceAuditEntry {
  actionType: AuditActionType
  entityType: AuditEntityType
  /** Upload id / punch id / decision id / exception id. */
  entityId: string
  /** Include `summary` for the audit viewer. Never include secrets. */
  details: Record<string, unknown>
}

/**
 * Builds a `prisma.auditLog.create` operation. Put it in a `prisma.$transaction([...])`
 * array, or pass the interactive transaction client as `client` so the audit row is
 * written inside that transaction. No user is recorded because logins are out of scope.
 */
export function auditEntry(
  entry: AttendanceAuditEntry,
  client: Pick<Prisma.TransactionClient, 'auditLog'> = prisma,
) {
  return client.auditLog.create({
    data: {
      actionType: entry.actionType,
      entityType: entry.entityType,
      entityId: entry.entityId,
      detailsJson: entry.details as Prisma.InputJsonValue,
    },
  })
}
