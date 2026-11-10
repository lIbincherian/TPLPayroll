import type { Prisma } from '@prisma/client'
import { SYNC_LOCK_TTL_MS } from '../lib/constants'
import { AttendanceSyncError } from '../types/attendance-sync.types'

export const SYNC_IN_PROGRESS_MESSAGE = 'A pull is running for this week. Wait for it to finish, then try again.'

export interface LockedWeekRow {
  id: string
  source: string
  status: string
  syncLockedAt: Date | null
  approvedAt: Date | null
  payrollWeekStartDate: Date
}

type RawWeekRow = Omit<LockedWeekRow, 'syncLockedAt' | 'approvedAt' | 'payrollWeekStartDate'> & {
  syncLockedAt: Date | string | null
  approvedAt: Date | string | null
  payrollWeekStartDate: Date | string
}

function toLockedRow(row: RawWeekRow): LockedWeekRow {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    syncLockedAt: row.syncLockedAt === null ? null : new Date(row.syncLockedAt),
    approvedAt: row.approvedAt === null ? null : new Date(row.approvedAt),
    payrollWeekStartDate: new Date(row.payrollWeekStartDate),
  }
}

/**
 * SELECT ... FOR UPDATE on the week's AttendanceUpload row. Every writer of a week (punch
 * edit, approve, reopen, pull-replace, payroll approve, revision approve) takes this first
 * inside its interactive transaction, so they serialize per week and each one re-reads the
 * week's status after the previous writer has committed. Returns null when there is no
 * active row.
 *
 * Only call it inside `prisma.$transaction(async (tx) => ...)`, with that `tx`. Lock order:
 * this row first, then its children.
 */
export async function lockWeekRow(
  tx: Prisma.TransactionClient,
  where: { id: string } | { weekStart: Date },
): Promise<LockedWeekRow | null> {
  const rows =
    'id' in where
      ? await tx.$queryRaw<RawWeekRow[]>`
          SELECT id, source, status, "syncLockedAt", "approvedAt", "payrollWeekStartDate"
          FROM "AttendanceUpload"
          WHERE id = ${where.id}
          FOR UPDATE`
      : await tx.$queryRaw<RawWeekRow[]>`
          SELECT id, source, status, "syncLockedAt", "approvedAt", "payrollWeekStartDate"
          FROM "AttendanceUpload"
          WHERE "payrollWeekStartDate" = ${where.weekStart} AND "isActiveForPayrollWeek" = true
          ORDER BY "uploadedAt" DESC
          LIMIT 1
          FOR UPDATE`

  return rows.length > 0 ? toLockedRow(rows[0]) : null
}

/** True while a pull holds the week: its sync lock is set and younger than SYNC_LOCK_TTL_MS. */
export function isSyncing(row: { syncLockedAt?: Date | null }, now: Date = new Date()): boolean {
  if (row.syncLockedAt === null || row.syncLockedAt === undefined) return false
  return now.getTime() - row.syncLockedAt.getTime() < SYNC_LOCK_TTL_MS
}

/** Throws SYNC_IN_PROGRESS while a pull holds the week (see isSyncing). */
export function assertNotSyncing(row: { syncLockedAt?: Date | null }, now: Date = new Date()): void {
  if (isSyncing(row, now)) throw new AttendanceSyncError('SYNC_IN_PROGRESS', SYNC_IN_PROGRESS_MESSAGE)
}
