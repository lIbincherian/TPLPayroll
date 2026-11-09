import { Prisma, type AttendanceUpload } from '@prisma/client'
import prisma from '@/lib/prisma'
import { SYNC_LOCK_TTL_MS } from '../lib/constants'
import { buildPunchRowsFromParsed } from '../lib/pairing'
import { shouldScheduledSyncReplace } from '../lib/review'
import { SYNC_FAILURE_COPY } from '../lib/etimeoffice/parser'
import {
  addDaysISO,
  getCompletedPayrollWeek,
  isFutureWeek,
  isThursdayISO,
  parseWeekId,
  toISODate,
  toUtcDate,
  todayInIST,
} from '../lib/week'
import {
  AttendanceSyncError,
  type CodeExceptionLite,
  type DiscardedEdit,
  type DiscardSummary,
  type EmployeeLite,
  type ISODate,
  type SyncFailureCode,
  type SyncOutcome,
  type SyncTrigger,
  type WeekRange,
} from '../types/attendance-sync.types'
import { auditEntry } from './attendance-audit.service'
import { fetchPunchData } from './etimeoffice.client'
import { getOrCreateApiWeekRow, getWeekByStart } from './week-list.service'

const CREATE_MANY_CHUNK_SIZE = 1000
const TRANSACTION_TIMEOUT_MS = 30000
const MAX_AUDITED_EDITS = 500

// ─── Edits and decisions ──────────────────────────────────────────────────────

/** Live punches that were edited or entered by hand, plus the week's employee decisions. */
export async function weekHasEditsOrDecisions(
  uploadId: string,
): Promise<{ hasEdits: boolean; editedDays: number; decisions: number; edits: DiscardedEdit[] }> {
  const [punches, decisions] = await Promise.all([
    prisma.attendancePunch.findMany({
      where: { attendanceUploadId: uploadId, correctionId: null },
      select: {
        id: true,
        employeeId: true,
        empCode: true,
        punchDate: true,
        position: true,
        source: true,
        originalTime: true,
        currentTime: true,
        note: true,
        employee: { select: { employeeId: true } },
      },
    }),
    prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: uploadId } }),
  ])

  // originalTime IS DISTINCT FROM currentTime, or a hand-entered punch.
  const edited = punches.filter((p) => p.source === 'MANUAL' || p.originalTime !== p.currentTime)

  const days = new Set(edited.map((p) => `${p.employeeId ?? `code:${p.empCode}`}|${toISODate(p.punchDate)}`))
  const edits: DiscardedEdit[] = edited.map((p) => ({
    punchId: p.id,
    employeeCode: p.employee?.employeeId ?? null,
    date: toISODate(p.punchDate),
    position: p.position === 'OUT' ? 'OUT' : 'IN',
    original: p.originalTime,
    current: p.currentTime,
    note: p.note,
  }))

  return { hasEdits: edited.length > 0, editedDays: days.size, decisions, edits }
}

export async function getPullWarning(
  weekStart: ISODate,
): Promise<{ hasData: boolean; editedDays: number; decisions: number }> {
  const row = await getWeekByStart(toUtcDate(weekStart))
  if (!row || row.source === 'EXCEL') return { hasData: false, editedDays: 0, decisions: 0 }

  const [punchCount, edits] = await Promise.all([
    prisma.attendancePunch.count({ where: { attendanceUploadId: row.id, correctionId: null } }),
    weekHasEditsOrDecisions(row.id),
  ])
  return { hasData: punchCount > 0, editedDays: edits.editedDays, decisions: edits.decisions }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

function auditActionFor(trigger: SyncTrigger): 'SYNC' | 'PULL' {
  return trigger === 'MANUAL' ? 'PULL' : 'SYNC'
}

function triggerLabel(trigger: SyncTrigger): string {
  return trigger === 'MANUAL' ? 'Pull' : 'Sync'
}

async function recordScheduledSkip(
  entityId: string,
  week: WeekRange,
  outcome: SyncOutcome['outcome'],
  summary: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await auditEntry({
    actionType: 'SYNC',
    entityType: 'ATTENDANCE_WEEK',
    entityId,
    details: { summary, outcome, trigger: 'SCHEDULED', weekStart: week.start, weekEnd: week.end, ...extra },
  })
}

/**
 * Load one Thursday–Wednesday week from eTimeOffice and replace what was there.
 * Nothing is written unless the whole response loads. A failure leaves earlier
 * punches, edits and decisions in place and only records the error.
 */
export async function syncWeek(input: {
  week: WeekRange
  trigger: SyncTrigger
  now?: Date
}): Promise<SyncOutcome> {
  const { week, trigger } = input
  const now = input.now ?? new Date()
  const today = todayInIST(now)

  if (!isThursdayISO(week.start) || week.end !== addDaysISO(week.start, 6)) {
    throw new AttendanceSyncError('INVALID_WEEK', 'A payroll week runs Thursday to Wednesday.')
  }
  if (isFutureWeek(week, today)) {
    throw new AttendanceSyncError('FUTURE_WEEK', "This week hasn't started yet.")
  }

  let row: AttendanceUpload
  try {
    row = await getOrCreateApiWeekRow(week)
  } catch (error) {
    if (trigger === 'SCHEDULED' && error instanceof AttendanceSyncError && error.code === 'EXCEL_ERA_WEEK') {
      const excelRow = await getWeekByStart(toUtcDate(week.start))
      await recordScheduledSkip(
        excelRow?.id ?? week.start,
        week,
        'SKIPPED_EXCEL_ERA',
        'Scheduled sync skipped: week was imported from Excel',
      )
      return { outcome: 'SKIPPED_EXCEL_ERA' }
    }
    throw error
  }

  if (row.status === 'APPROVED') {
    if (trigger === 'MANUAL') {
      throw new AttendanceSyncError('WEEK_APPROVED', 'This week is approved. Reopen it before pulling.')
    }
    await recordScheduledSkip(row.id, week, 'SKIPPED_APPROVED', 'Scheduled sync skipped: week is approved')
    return { outcome: 'SKIPPED_APPROVED' }
  }

  const approvedRun = await prisma.payrollRun.findFirst({
    where: { payrollWeekStartDate: toUtcDate(week.start), status: { in: ['APPROVED', 'REVISED'] } },
    select: { id: true },
  })
  if (approvedRun) {
    if (trigger === 'MANUAL') {
      throw new AttendanceSyncError(
        'PAYROLL_ALREADY_APPROVED',
        "Payroll for this week is approved. Use Correct on the payroll run to change attendance.",
      )
    }
    await recordScheduledSkip(row.id, week, 'SKIPPED_PAYROLL_APPROVED', 'Scheduled sync skipped: payroll is approved')
    return { outcome: 'SKIPPED_PAYROLL_APPROVED' }
  }

  if (trigger === 'SCHEDULED') {
    const edits = await weekHasEditsOrDecisions(row.id)
    const hasEditsOrDecisions = edits.hasEdits || edits.decisions > 0
    if (!shouldScheduledSyncReplace({ hasEditsOrDecisions, status: 'REVIEW' })) {
      await prisma.attendanceUpload.update({ where: { id: row.id }, data: { staleNoticeAt: now } })
      await recordScheduledSkip(row.id, week, 'SKIPPED_HAS_EDITS', 'Scheduled sync skipped: week has edits', {
        editedDays: edits.editedDays,
        decisions: edits.decisions,
      })
      return { outcome: 'SKIPPED_HAS_EDITS' }
    }
  }

  // Take the sync lock. A second caller (cron vs manual) is turned away; a stale lock expires.
  const lock = await prisma.attendanceUpload.updateMany({
    where: {
      id: row.id,
      OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: new Date(now.getTime() - SYNC_LOCK_TTL_MS) } }],
    },
    data: { syncLockedAt: now, lastSyncAttemptAt: now, lastSyncTrigger: trigger },
  })
  if (lock.count === 0) {
    throw new AttendanceSyncError('SYNC_IN_PROGRESS', 'A pull for this week is already running.')
  }

  let lockReleased = false
  const recordFailure = async (code: SyncFailureCode, message: string): Promise<SyncOutcome> => {
    // Status is left as it is: REVIEW if punches exist, SYNC_FAILED otherwise.
    await prisma.$transaction([
      prisma.attendanceUpload.update({
        where: { id: row.id },
        data: { lastSyncError: message, syncLockedAt: null },
      }),
      auditEntry({
        actionType: auditActionFor(trigger),
        entityType: 'ATTENDANCE_WEEK',
        entityId: row.id,
        details: {
          summary: `${triggerLabel(trigger)} failed: ${message}`,
          outcome: 'FAILED',
          code,
          message,
          trigger,
          weekStart: week.start,
          weekEnd: week.end,
        },
      }),
    ])
    lockReleased = true
    return { outcome: 'FAILED', code, message }
  }

  try {
    const result = await fetchPunchData(week)
    if (!result.ok) return await recordFailure(result.code, result.message)

    const [employees, exceptions] = await Promise.all([
      prisma.employee.findMany({
        select: { id: true, employeeId: true, employeeName: true, isActive: true, dateOfResignation: true },
      }) as Promise<EmployeeLite[]>,
      prisma.attendanceCodeException.findMany({
        select: { empCode: true, kind: true, employeeId: true },
      }) as Promise<CodeExceptionLite[]>,
    ])

    // Built fully in memory so a partial response can never be half-saved.
    const rows = buildPunchRowsFromParsed(result.punches, employees, exceptions, week)
    if (rows.length === 0) return await recordFailure('EMPTY', SYNC_FAILURE_COPY.EMPTY)

    const discard = await weekHasEditsOrDecisions(row.id)
    const codeStatus = new Map(rows.map((r) => [r.empCode, r.matchStatus]))
    const codesWith = (status: string) => [...codeStatus.entries()].filter(([, s]) => s === status).map(([code]) => code)
    const discarded: DiscardSummary | null =
      discard.editedDays > 0 || discard.decisions > 0
        ? {
            editedDays: discard.editedDays,
            decisions: discard.decisions,
            edits: discard.edits.slice(0, MAX_AUDITED_EDITS),
          }
        : null

    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.attendancePunch.deleteMany({ where: { attendanceUploadId: row.id, correctionId: null } })
          await tx.attendanceEmployeeDecision.deleteMany({ where: { attendanceUploadId: row.id } })
          // Defensive: a week in review has no attendance records.
          await tx.attendanceRecord.deleteMany({ where: { attendanceUploadId: row.id } })

          for (let i = 0; i < rows.length; i += CREATE_MANY_CHUNK_SIZE) {
            await tx.attendancePunch.createMany({
              data: rows.slice(i, i + CREATE_MANY_CHUNK_SIZE).map((r) => ({
                ...r,
                attendanceUploadId: row.id,
                mergedScansJson: r.mergedScansJson ?? Prisma.DbNull,
              })),
            })
          }

          await tx.attendanceUpload.update({
            where: { id: row.id },
            data: {
              status: 'REVIEW',
              lastSyncedAt: now,
              lastSyncError: null,
              staleNoticeAt: null,
              syncLockedAt: null,
              approvedAt: null,
            },
          })

          await auditEntry(
            {
              actionType: auditActionFor(trigger),
              entityType: 'ATTENDANCE_WEEK',
              entityId: row.id,
              details: {
                summary: `${triggerLabel(trigger)} loaded ${rows.length} punches`,
                outcome: 'LOADED',
                trigger,
                weekStart: week.start,
                weekEnd: week.end,
                punchCount: rows.length,
                scanCount: result.punches.length,
                codes: codeStatus.size,
                unknownCodes: codesWith('UNKNOWN'),
                duplicateCodes: codesWith('DUPLICATE'),
                ignoredCodes: codesWith('IGNORED'),
                discarded: { editedDays: discard.editedDays, decisions: discard.decisions, edits: discarded?.edits ?? [] },
              },
            },
            tx,
          )
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      )
      lockReleased = true
    } catch (error) {
      console.error('[AttendanceSync] Saving the pulled punches failed:', error instanceof Error ? error.message : error)
      return await recordFailure('SYNC_FAILED', SYNC_FAILURE_COPY.SYNC_FAILED)
    }

    return { outcome: 'LOADED', punchCount: rows.length, discarded }
  } finally {
    if (!lockReleased) {
      await prisma.attendanceUpload
        .update({ where: { id: row.id }, data: { syncLockedAt: null } })
        .catch(() => undefined)
    }
  }
}

export async function runScheduledSync(now: Date = new Date()): Promise<SyncOutcome> {
  return syncWeek({ week: getCompletedPayrollWeek(now), trigger: 'SCHEDULED', now })
}

export async function pullNow(weekStart: ISODate): Promise<SyncOutcome> {
  const week = parseWeekId(weekStart)
  if (!week) throw new AttendanceSyncError('INVALID_WEEK', 'A payroll week starts on a Thursday.')
  return syncWeek({ week, trigger: 'MANUAL' })
}
