import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { TRANSACTION_TIMEOUT_MS } from '../lib/constants'
import { buildDayView } from '../lib/hours'
import { matchEmployeeCode, needsEmployeeDecision } from '../lib/matching'
import { countEmployeeCheckIssues } from '../lib/review'
import { round2 } from '../lib/time'
import { getWeekDates, toISODate } from '../lib/week'
import {
  AttendanceSyncError,
  type CodeExceptionLite,
  type CodeMatch,
  type EmployeeCheck,
  type EmployeeDecisionValue,
  type EmployeeLite,
  type StoredPunchRow,
} from '../types/attendance-sync.types'
import { auditEntry } from './attendance-audit.service'
import { requireApiWeek } from './week-list.service'
import { assertNotSyncing, lockWeekRow } from './week-lock.service'

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

async function loadEmployees(db: Prisma.TransactionClient = prisma): Promise<EmployeeLite[]> {
  return db.employee.findMany({ select: EMPLOYEE_LITE_SELECT }) as Promise<EmployeeLite[]>
}

/** The saved code exceptions: all of them, or just the one for `empCode`. */
async function loadExceptions(db: Prisma.TransactionClient = prisma, empCode?: string): Promise<CodeExceptionLite[]> {
  return (await db.attendanceCodeException.findMany({
    where: empCode === undefined ? undefined : { empCode },
    select: { empCode: true, kind: true, employeeId: true },
  })) as CodeExceptionLite[]
}

/** True for the database's foreign-key refusal, e.g. a punch linked to an employee deleted a moment ago. */
function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003'
}

type WeekState = { status: string; syncLockedAt: Date | null }

/**
 * Codes change while the week is in review or failed, never once approved, never while a pull
 * holds it (the pull would discard the change). Called on the week row read before a transaction
 * (fast fail) and again on the locked row inside it.
 */
function assertCodesEditable(row: WeekState, now = new Date()): void {
  if (row.status === 'APPROVED') {
    throw new AttendanceSyncError('WEEK_LOCKED', 'This week is approved. Reopen it to change codes or decisions.')
  }
  assertNotSyncing(row, now)
}

/** Decisions change only while the week is in review, and not while a pull holds it. */
function assertDecisionsEditable(row: WeekState, now = new Date()): void {
  if (row.status !== 'REVIEW') {
    throw new AttendanceSyncError('WEEK_LOCKED', 'This week is locked. Reopen it to change decisions.')
  }
  assertNotSyncing(row, now)
}

/** The first statement of every writer's transaction: take the week row, then check its state. */
async function lockWeek(tx: Prisma.TransactionClient, uploadId: string) {
  const locked = await lockWeekRow(tx, { id: uploadId })
  if (!locked) throw new AttendanceSyncError('WEEK_NOT_READY', 'No attendance has been loaded for this week.')
  return locked
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
  const codeRows = await tx.attendancePunch.findMany({
    where: { attendanceUploadId: uploadId, correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
    select: { id: true, punchDate: true, pairIndex: true },
  })
  const existing = await tx.attendancePunch.findMany({
    where: { attendanceUploadId: uploadId, correctionId: null, employeeId },
    select: { punchDate: true, pairIndex: true },
  })

  const nextIndexByDay = new Map<string, number>()
  for (const row of existing) {
    const day = toISODate(row.punchDate)
    nextIndexByDay.set(day, Math.max(nextIndexByDay.get(day) ?? 0, row.pairIndex + 1))
  }

  // One updateMany per offset, however many days the code has punches on.
  const idsByOffset = new Map<number, string[]>()
  for (const row of codeRows) {
    const offset = nextIndexByDay.get(toISODate(row.punchDate)) ?? 0
    idsByOffset.set(offset, [...(idsByOffset.get(offset) ?? []), row.id])
  }
  for (const [offset, ids] of idsByOffset) {
    await tx.attendancePunch.updateMany({
      where: { id: { in: ids } },
      data:
        offset === 0
          ? { employeeId, matchStatus: 'MATCHED' }
          : { employeeId, matchStatus: 'MATCHED', pairIndex: { increment: offset } },
    })
  }

  return codeRows.length
}

/**
 * Re-run matching for the week's unresolved codes with the current employees and saved
 * exceptions. Call after the user adds or edits an employee.
 *
 * The codes are read and matched first, on the plain client, only to skip the codes that cannot
 * change. Each code that might then commits in its own transaction, which first locks the week's
 * row (so a pull or an approval cannot land in the middle of one code), skips the code if nothing
 * is left to link, and matches it again against the employees and the code's exception read under
 * the lock: an employee added, edited or deleted since the first read decides the outcome, and an
 * employee that vanished leaves the code unresolved (listed in `stillUnresolved`), never a foreign-key
 * error. An error (WEEK_LOCKED, SYNC_IN_PROGRESS, a database error) stops the loop and is thrown:
 * codes already linked stay linked and audited, the rest stay unresolved for the next run.
 */
export async function rematchWeekCodes(
  weekId: string,
): Promise<{ matched: Array<{ empCode: string; employeeId: string; employeeCode: string }>; stillUnresolved: string[] }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertCodesEditable(upload)

  const unresolvedWhere = (empCode: string) => ({
    attendanceUploadId: upload.id,
    correctionId: null,
    empCode,
    matchStatus: { in: UNRESOLVED },
  })
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

  for (const { empCode, matchStatus } of unresolved) {
    const match = matchEmployeeCode(empCode, employees, exceptions)
    if ((match.status === 'UNKNOWN' || match.status === 'DUPLICATE') && match.status === matchStatus) {
      stillUnresolved.push(empCode) // nothing to write
      continue
    }

    let applied: CodeMatch | null
    try {
      applied = await prisma.$transaction(
        async (tx) => {
          assertCodesEditable(await lockWeek(tx, upload.id))
          // A pull or another match may have resolved the code since it was read.
          if ((await tx.attendancePunch.count({ where: unresolvedWhere(empCode) })) === 0) return null

          // The employees and the code's exception were read before the lock. Match again on what the lock
          // sees, so a link is only written to an employee that exists now and that the code still resolves to.
          const lockedEmployees = await loadEmployees(tx)
          const lockedExceptions = await loadExceptions(tx, empCode)
          const current = matchEmployeeCode(empCode, lockedEmployees, lockedExceptions)

          if (current.status === 'MATCHED') {
            const linkedPunches = await linkCodeToEmployee(tx, upload.id, empCode, current.employee.id)
            await auditEntry(
              {
                actionType: 'UPDATE',
                entityType: 'ATTENDANCE_CODE',
                entityId: upload.id,
                details: {
                  summary: `Code ${empCode} linked to ${current.employee.employeeId}`,
                  weekStart: week.start,
                  empCode,
                  employeeId: current.employee.id,
                  employeeCode: current.employee.employeeId,
                  via: current.via,
                  linkedPunches,
                },
              },
              tx,
            )
          } else if (current.status === 'IGNORED') {
            await tx.attendancePunch.updateMany({
              where: unresolvedWhere(empCode),
              data: { employeeId: null, matchStatus: 'IGNORED' },
            })
            await auditEntry(
              {
                actionType: 'UPDATE',
                entityType: 'ATTENDANCE_CODE',
                entityId: upload.id,
                details: { summary: `Code ${empCode} ignored`, weekStart: week.start, empCode },
              },
              tx,
            )
          } else {
            // Still unresolved. A duplicate whose second ID was edited becomes unknown (and the reverse).
            await tx.attendancePunch.updateMany({ where: unresolvedWhere(empCode), data: { matchStatus: current.status } })
          }
          return current
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      )
    } catch (error) {
      // The employee was deleted after the locked read and before the link: the whole code rolled back.
      if (!isForeignKeyViolation(error)) throw error
      stillUnresolved.push(empCode)
      continue
    }
    if (!applied) continue

    if (applied.status === 'MATCHED') {
      matched.push({ empCode, employeeId: applied.employee.id, employeeCode: applied.employee.employeeId })
    } else if (applied.status !== 'IGNORED') {
      stillUnresolved.push(empCode)
    }
  }

  return { matched, stillUnresolved }
}

async function requireUnresolvedCode(
  uploadId: string,
  empCode: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  const count = await db.attendancePunch.count({
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
  assertCodesEditable(upload)
  await requireUnresolvedCode(upload.id, empCode)

  const employeeSelect = { id: true, employeeId: true, employeeName: true } as const
  // Fast fail only: the employee is read again under the lock, and that copy is the one written.
  const knownEmployee = await prisma.employee.findUnique({ where: { id: employeeId }, select: employeeSelect })
  if (!knownEmployee) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', 'That employee no longer exists.')

  return prisma.$transaction(
    async (tx) => {
      assertCodesEditable(await lockWeek(tx, upload.id))
      // A pull or another match may have resolved the code since the check above.
      await requireUnresolvedCode(upload.id, empCode, tx)
      // The employee may have been deleted outside the app since the check above.
      const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: employeeSelect })
      if (!employee) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', 'That employee no longer exists.')

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
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

/** Leave a code out of the review and payroll. Saved, so it carries over to later pulls. */
export async function ignoreCode(weekId: string, empCode: string): Promise<{ ignoredPunches: number }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertCodesEditable(upload)
  await requireUnresolvedCode(upload.id, empCode)

  return prisma.$transaction(
    async (tx) => {
      assertCodesEditable(await lockWeek(tx, upload.id))
      // A pull or a match may have resolved the code since the check above.
      await requireUnresolvedCode(upload.id, empCode, tx)

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
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

// ─── Decisions ────────────────────────────────────────────────────────────────

/** Approve or reject an inactive / resigned employee's punches for this week. */
export async function setEmployeeDecision(
  weekId: string,
  employeeId: string,
  decision: EmployeeDecisionValue,
): Promise<{ decision: EmployeeDecisionValue }> {
  const { upload, week } = await requireApiWeek(weekId)
  assertDecisionsEditable(upload)

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: EMPLOYEE_LITE_SELECT })
  if (!employee) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', 'That employee no longer exists.')

  const punchCount = await prisma.attendancePunch.count({
    where: { attendanceUploadId: upload.id, correctionId: null, employeeId },
  })
  const needed = needsEmployeeDecision(employee, punchCount, week)
  if (!needed.needed) {
    throw new AttendanceSyncError('VALIDATION_ERROR', 'This employee does not need a decision for this week.')
  }

  await prisma.$transaction(
    async (tx) => {
      assertDecisionsEditable(await lockWeek(tx, upload.id))
      // A pull may have removed the employee's punches since the count above: a decision exists
      // only while it is needed.
      const lockedCount = await tx.attendancePunch.count({
        where: { attendanceUploadId: upload.id, correctionId: null, employeeId },
      })
      if (!needsEmployeeDecision(employee, lockedCount, week).needed) {
        throw new AttendanceSyncError('VALIDATION_ERROR', 'This employee does not need a decision for this week.')
      }

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
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )

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
