import type { AttendanceUpload, Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { buildDayView } from '../lib/hours'
import { matchEmployeeCode, needsEmployeeDecision } from '../lib/matching'
import { countEmployeeCheckIssues } from '../lib/review'
import { round2 } from '../lib/time'
import { getWeekDates, toISODate } from '../lib/week'
import {
  AttendanceSyncError,
  type CodeExceptionLite,
  type EmployeeCheck,
  type EmployeeDecisionValue,
  type EmployeeLite,
  type StoredPunchRow,
} from '../types/attendance-sync.types'
import { auditEntry } from './attendance-audit.service'
import { requireApiWeek } from './week-list.service'
import { isSyncing } from './week-lock.service'

const EMPLOYEE_LITE_SELECT = {
  id: true,
  employeeId: true,
  employeeName: true,
  isActive: true,
  dateOfResignation: true,
} as const

const UNRESOLVED = ['UNKNOWN', 'DUPLICATE']

type LivePunch = StoredPunchRow & {
  employeeId: string | null
  empCode: string
  empName: string | null
  matchStatus: string
  punchDate: Date
}

const LIVE_PUNCH_SELECT = {
  id: true,
  employeeId: true,
  empCode: true,
  empName: true,
  matchStatus: true,
  punchDate: true,
  pairIndex: true,
  position: true,
  source: true,
  originalTime: true,
  currentTime: true,
  note: true,
} as const

async function loadLivePunches(uploadId: string): Promise<LivePunch[]> {
  return (await prisma.attendancePunch.findMany({
    where: { attendanceUploadId: uploadId, correctionId: null },
    select: LIVE_PUNCH_SELECT,
  })) as LivePunch[]
}

async function loadEmployees(): Promise<EmployeeLite[]> {
  return prisma.employee.findMany({ select: EMPLOYEE_LITE_SELECT }) as Promise<EmployeeLite[]>
}

async function loadExceptions(): Promise<CodeExceptionLite[]> {
  return (await prisma.attendanceCodeException.findMany({
    select: { empCode: true, kind: true, employeeId: true },
  })) as CodeExceptionLite[]
}

function syncInProgress(): AttendanceSyncError {
  return new AttendanceSyncError(
    'SYNC_IN_PROGRESS',
    'A pull is running for this week. Wait for it to finish, then try again.',
  )
}

/**
 * The week's codes and decisions can change while it is in review, but not once approved
 * and not while a pull is replacing the punches (the pull would discard the change).
 */
function assertEditable(upload: AttendanceUpload): void {
  if (upload.status === 'APPROVED') {
    throw new AttendanceSyncError('WEEK_LOCKED', 'This week is approved. Reopen it to change codes or decisions.')
  }
  if (isSyncing(upload)) throw syncInProgress()
}

// ─── getEmployeeCheck ─────────────────────────────────────────────────────────

/**
 * The employee check: codes that need fixing, ignored codes, and inactive/resigned
 * employees waiting on a decision. Reads only.
 */
export async function getEmployeeCheck(weekId: string): Promise<EmployeeCheck> {
  const { upload, week } = await requireApiWeek(weekId)
  const [punches, employees, exceptions, decisionRows] = await Promise.all([
    loadLivePunches(upload.id),
    loadEmployees(),
    loadExceptions(),
    prisma.attendanceEmployeeDecision.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true, decision: true },
    }),
  ])

  const dayKey = (p: LivePunch) => toISODate(p.punchDate)

  // Codes to fix and ignored codes, grouped by code.
  const byCode = new Map<string, LivePunch[]>()
  for (const punch of punches) {
    if (punch.matchStatus === 'MATCHED') continue
    byCode.set(punch.empCode, [...(byCode.get(punch.empCode) ?? []), punch])
  }

  const codes: EmployeeCheck['codes'] = []
  const ignoredCodes: EmployeeCheck['ignoredCodes'] = []
  for (const [empCode, rows] of byCode) {
    const empName = rows.find((r) => r.empName)?.empName ?? null
    if (rows[0].matchStatus === 'IGNORED') {
      ignoredCodes.push({ empCode, empName, punchCount: rows.length })
      continue
    }
    // Candidates are recomputed now, so an edited Employee ID shows up before the next pull.
    const match = matchEmployeeCode(empCode, employees, exceptions)
    codes.push({
      empCode,
      empName,
      status: rows[0].matchStatus === 'DUPLICATE' ? 'DUPLICATE' : 'UNKNOWN',
      punchCount: rows.length,
      dayCount: new Set(rows.map(dayKey)).size,
      candidates: match.status === 'DUPLICATE' ? match.employees : [],
    })
  }
  codes.sort((a, b) => a.empCode.localeCompare(b.empCode))
  ignoredCodes.sort((a, b) => a.empCode.localeCompare(b.empCode))

  // Decisions for inactive / resigned employees who have punches.
  const punchesByEmployee = new Map<string, LivePunch[]>()
  for (const punch of punches) {
    if (punch.matchStatus !== 'MATCHED' || !punch.employeeId) continue
    punchesByEmployee.set(punch.employeeId, [...(punchesByEmployee.get(punch.employeeId) ?? []), punch])
  }
  const decisionByEmployee = new Map(decisionRows.map((d) => [d.employeeId, d.decision as EmployeeDecisionValue]))
  const weekDates = getWeekDates(week)

  const decisions: EmployeeCheck['decisions'] = []
  for (const employee of employees) {
    const rows = punchesByEmployee.get(employee.id) ?? []
    const needed = needsEmployeeDecision(employee, rows.length, week)
    if (!needed.needed) continue

    // Hours from complete pairs only.
    const days = weekDates.map((date) => buildDayView(date, rows.filter((r) => dayKey(r) === date)))
    decisions.push({
      employeeId: employee.id,
      employeeCode: employee.employeeId,
      employeeName: employee.employeeName,
      reason: needed.reason,
      resignedOn: employee.dateOfResignation ? toISODate(employee.dateOfResignation) : null,
      dayCount: new Set(rows.map(dayKey)).size,
      regularHours: round2(days.reduce((sum, d) => sum + d.regularHours, 0)),
      overtimeHours: round2(days.reduce((sum, d) => sum + d.overtimeHours, 0)),
      decision: decisionByEmployee.get(employee.id) ?? null,
    })
  }
  decisions.sort((a, b) => a.employeeName.localeCompare(b.employeeName))

  const codeStatus = new Map<string, string>()
  for (const punch of punches) codeStatus.set(punch.empCode, punch.matchStatus)
  const countStatus = (status: string) => [...codeStatus.values()].filter((s) => s === status).length
  const counts = {
    codesInSync: codeStatus.size,
    matched: countStatus('MATCHED'),
    unknown: countStatus('UNKNOWN'),
    duplicate: countStatus('DUPLICATE'),
    decisionsLeft: decisions.filter((d) => d.decision === null).length,
  }

  return {
    weekId,
    week,
    codes,
    ignoredCodes,
    decisions,
    counts,
    allEmployees: employees
      .map((e) => ({ id: e.id, employeeId: e.employeeId, employeeName: e.employeeName }))
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    complete: counts.unknown === 0 && counts.duplicate === 0 && counts.decisionsLeft === 0,
  }
}

// ─── Linking codes to employees ───────────────────────────────────────────────

/**
 * Link a code's unresolved punches to an employee, inside the caller's transaction. If the
 * employee already has punches on a day, the code's pairs are appended after them with a
 * pair offset; existing punches are never re-paired.
 */
async function linkCodeToEmployee(
  tx: Prisma.TransactionClient,
  uploadId: string,
  empCode: string,
  employeeId: string,
): Promise<number> {
  const [codeRows, existing] = await Promise.all([
    tx.attendancePunch.findMany({
      where: { attendanceUploadId: uploadId, correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
      select: { id: true, punchDate: true, pairIndex: true },
    }),
    tx.attendancePunch.findMany({
      where: { attendanceUploadId: uploadId, correctionId: null, employeeId },
      select: { punchDate: true, pairIndex: true },
    }),
  ])

  const nextIndexByDay = new Map<string, number>()
  for (const row of existing) {
    const day = toISODate(row.punchDate)
    nextIndexByDay.set(day, Math.max(nextIndexByDay.get(day) ?? 0, row.pairIndex + 1))
  }

  const plainIds: string[] = []
  for (const row of codeRows) {
    const offset = nextIndexByDay.get(toISODate(row.punchDate)) ?? 0
    if (offset === 0) {
      plainIds.push(row.id)
    } else {
      await tx.attendancePunch.update({
        where: { id: row.id },
        data: { employeeId, matchStatus: 'MATCHED', pairIndex: row.pairIndex + offset },
      })
    }
  }
  if (plainIds.length > 0) {
    await tx.attendancePunch.updateMany({
      where: { id: { in: plainIds } },
      data: { employeeId, matchStatus: 'MATCHED' },
    })
  }

  return codeRows.length
}

/**
 * Re-run matching for the week's unresolved codes with the current employees and saved
 * exceptions. Call after the user adds or edits an employee.
 */
export async function rematchWeekCodes(
  weekId: string,
): Promise<{ matched: Array<{ empCode: string; employeeId: string; employeeCode: string }>; stillUnresolved: string[] }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertEditable(upload)

  const [unresolved, employees, exceptions] = await Promise.all([
    prisma.attendancePunch.findMany({
      where: { attendanceUploadId: upload.id, correctionId: null, matchStatus: { in: UNRESOLVED } },
      select: { empCode: true, matchStatus: true },
      distinct: ['empCode'],
    }),
    loadEmployees(),
    loadExceptions(),
  ])

  const matched: Array<{ empCode: string; employeeId: string; employeeCode: string }> = []
  const stillUnresolved: string[] = []
  const unresolvedWhere = (empCode: string) => ({
    attendanceUploadId: upload.id,
    correctionId: null,
    empCode,
    matchStatus: { in: UNRESOLVED },
  })

  for (const { empCode, matchStatus } of unresolved) {
    const match = matchEmployeeCode(empCode, employees, exceptions)

    if (match.status === 'MATCHED') {
      await prisma.$transaction(async (tx) => {
        const linkedPunches = await linkCodeToEmployee(tx, upload.id, empCode, match.employee.id)
        await auditEntry(
          {
            actionType: 'UPDATE',
            entityType: 'ATTENDANCE_CODE',
            entityId: upload.id,
            details: {
              summary: `Code ${empCode} linked to ${match.employee.employeeId}`,
              weekStart: week.start,
              empCode,
              employeeId: match.employee.id,
              employeeCode: match.employee.employeeId,
              via: match.via,
              linkedPunches,
            },
          },
          tx,
        )
      })
      matched.push({ empCode, employeeId: match.employee.id, employeeCode: match.employee.employeeId })
    } else if (match.status === 'IGNORED') {
      await prisma.$transaction([
        prisma.attendancePunch.updateMany({
          where: unresolvedWhere(empCode),
          data: { employeeId: null, matchStatus: 'IGNORED' },
        }),
        auditEntry({
          actionType: 'UPDATE',
          entityType: 'ATTENDANCE_CODE',
          entityId: upload.id,
          details: { summary: `Code ${empCode} ignored`, weekStart: week.start, empCode },
        }),
      ])
    } else {
      // A duplicate whose second ID was edited becomes unknown (and the reverse).
      if (match.status !== matchStatus) {
        await prisma.attendancePunch.updateMany({ where: unresolvedWhere(empCode), data: { matchStatus: match.status } })
      }
      stillUnresolved.push(empCode)
    }
  }

  return { matched, stillUnresolved }
}

async function requireUnresolvedCode(uploadId: string, empCode: string): Promise<void> {
  const count = await prisma.attendancePunch.count({
    where: { attendanceUploadId: uploadId, correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
  })
  if (count === 0) throw new AttendanceSyncError('CODE_NOT_FOUND', "That code doesn't need fixing in this week.")
}

/**
 * Match an unresolved code to an existing employee. The link is saved as an exception, so
 * it applies to this week now and to every later pull.
 */
export async function matchCodeToEmployee(
  weekId: string,
  empCode: string,
  employeeId: string,
): Promise<{ linkedPunches: number }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertEditable(upload)
  await requireUnresolvedCode(upload.id, empCode)

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, employeeId: true, employeeName: true },
  })
  if (!employee) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', 'That employee no longer exists.')

  return prisma.$transaction(async (tx) => {
    const previous = await tx.attendanceCodeException.findUnique({ where: { empCode }, select: { id: true } })
    const exception = await tx.attendanceCodeException.upsert({
      where: { empCode },
      create: { empCode, kind: 'MATCH', employeeId: employee.id },
      update: { kind: 'MATCH', employeeId: employee.id },
    })
    const linkedPunches = await linkCodeToEmployee(tx, upload.id, empCode, employee.id)

    await auditEntry(
      {
        actionType: previous ? 'UPDATE' : 'CREATE',
        entityType: 'ATTENDANCE_CODE',
        entityId: exception.id,
        details: {
          summary: `Code ${empCode} matched to ${employee.employeeName} (${employee.employeeId})`,
          weekStart: week.start,
          empCode,
          kind: 'MATCH',
          employeeId: employee.id,
          employeeCode: employee.employeeId,
          linkedPunches,
        },
      },
      tx,
    )
    return { linkedPunches }
  })
}

/** Leave a code out of the review and payroll. Saved, so it carries over to later pulls. */
export async function ignoreCode(weekId: string, empCode: string): Promise<{ ignoredPunches: number }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertEditable(upload)
  await requireUnresolvedCode(upload.id, empCode)

  return prisma.$transaction(async (tx) => {
    const previous = await tx.attendanceCodeException.findUnique({ where: { empCode }, select: { id: true } })
    const exception = await tx.attendanceCodeException.upsert({
      where: { empCode },
      create: { empCode, kind: 'IGNORE', employeeId: null },
      update: { kind: 'IGNORE', employeeId: null },
    })
    const updated = await tx.attendancePunch.updateMany({
      where: { attendanceUploadId: upload.id, correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
      data: { matchStatus: 'IGNORED', employeeId: null },
    })

    await auditEntry(
      {
        actionType: previous ? 'UPDATE' : 'CREATE',
        entityType: 'ATTENDANCE_CODE',
        entityId: exception.id,
        details: {
          summary: `Code ${empCode} ignored`,
          weekStart: week.start,
          empCode,
          kind: 'IGNORE',
          ignoredPunches: updated.count,
        },
      },
      tx,
    )
    return { ignoredPunches: updated.count }
  })
}

// ─── Decisions ────────────────────────────────────────────────────────────────

/** Approve or reject an inactive / resigned employee's punches for this week. */
export async function setEmployeeDecision(
  weekId: string,
  employeeId: string,
  decision: EmployeeDecisionValue,
): Promise<{ decision: EmployeeDecisionValue }> {
  const { upload, week } = await requireApiWeek(weekId)
  if (upload.status !== 'REVIEW') {
    throw new AttendanceSyncError('WEEK_LOCKED', 'This week is locked. Reopen it to change decisions.')
  }
  if (isSyncing(upload)) throw syncInProgress()

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_LITE_SELECT })
  if (!employee) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', 'That employee no longer exists.')

  const punchCount = await prisma.attendancePunch.count({
    where: { attendanceUploadId: upload.id, correctionId: null, employeeId },
  })
  const needed = needsEmployeeDecision(employee, punchCount, week)
  if (!needed.needed) {
    throw new AttendanceSyncError('VALIDATION_ERROR', 'This employee does not need a decision for this week.')
  }

  await prisma.$transaction(async (tx) => {
    const key = { attendanceUploadId_employeeId: { attendanceUploadId: upload.id, employeeId } }
    const existing = await tx.attendanceEmployeeDecision.findUnique({ where: key })
    const saved = existing
      ? await tx.attendanceEmployeeDecision.update({ where: key, data: { decision, reason: needed.reason } })
      : await tx.attendanceEmployeeDecision.create({
          data: { attendanceUploadId: upload.id, employeeId, reason: needed.reason, decision },
        })

    await auditEntry(
      {
        actionType: existing ? 'UPDATE' : 'CREATE',
        entityType: 'ATTENDANCE_DECISION',
        entityId: saved.id,
        details: {
          summary: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${employee.employeeName} (${employee.employeeId}): ${
            needed.reason === 'INACTIVE' ? 'inactive' : 'resigned before the week'
          }`,
          weekStart: week.start,
          employeeId,
          employeeCode: employee.employeeId,
          employeeName: employee.employeeName,
          reason: needed.reason,
          old: existing ? { decision: existing.decision } : null,
          new: { decision },
        },
      },
      tx,
    )
  })

  return { decision }
}

// ─── Issues ───────────────────────────────────────────────────────────────────

/** How many codes are unresolved and how many decisions are still pending. */
export async function getEmployeeCheckIssues(
  weekId: string,
): Promise<{ unresolvedCodes: number; pendingDecisions: number }> {
  const { upload, week } = await requireApiWeek(weekId)
  const [punches, employees, decisions] = await Promise.all([
    loadLivePunches(upload.id),
    loadEmployees(),
    prisma.attendanceEmployeeDecision.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true },
    }),
  ])
  return countEmployeeCheckIssues({ week, employees, punches, decisions })
}
