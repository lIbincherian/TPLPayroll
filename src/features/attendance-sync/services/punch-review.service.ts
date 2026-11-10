import { randomUUID } from 'crypto'
import type { AttendanceUpload, PayrollCorrectionSession, PayrollRun, Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { validateDayPairs } from '../lib/hours'
import { getReviewGridEmployees } from '../lib/matching'
import {
  buildGridEmployees,
  canApproveWeek,
  countEmployeeCheckIssues,
  countUnusualDays,
  getAttendanceWeekStatus,
  getNeedsFixingDays,
  getNoPunchEmployees,
  punchSetSignature,
} from '../lib/review'
import { normalizeTimeInput, round2 } from '../lib/time'
import { getWeekDates, hasWeekEnded, toUtcDate, todayInIST } from '../lib/week'
import {
  AttendanceSyncError,
  type DayView,
  type EmployeeDecisionValue,
  type EmployeeLite,
  type GridEmployee,
  type HHmm,
  type PunchReview,
  type ReviewMode,
  type SavePair,
  type SavePunchEditInput,
  type SavePunchEditResult,
  type StoredPunchRow,
  type WeekPayrollStatus,
  type WeekRange,
} from '../types/attendance-sync.types'
import { auditEntry } from './attendance-audit.service'
import { requireApiWeek } from './week-list.service'
import { assertNotSyncing, lockWeekRow } from './week-lock.service'

const MAX_NOTE_LENGTH = 500
const TRANSACTION_TIMEOUT_MS = 30000

const EMPLOYEE_LITE_SELECT = {
  id: true,
  employeeId: true,
  employeeName: true,
  isActive: true,
  dateOfResignation: true,
} as const

const PUNCH_SELECT = {
  id: true,
  attendanceUploadId: true,
  correctionId: true,
  employeeId: true,
  empCode: true,
  matchStatus: true,
  punchDate: true,
  pairIndex: true,
  position: true,
  source: true,
  originalTime: true,
  currentTime: true,
  note: true,
  mergedScansJson: true,
  updatedAt: true,
} as const

type PunchRecord = StoredPunchRow & {
  attendanceUploadId: string
  correctionId: string | null
  employeeId: string | null
  empCode: string
  matchStatus: string
  punchDate: Date
  updatedAt: Date
}

export interface ReviewContext {
  upload: AttendanceUpload
  week: WeekRange
  employees: EmployeeLite[]
  decisions: Array<{ employeeId: string; decision: EmployeeDecisionValue }>
  punches: PunchRecord[]
  payrollRun: PayrollRun | null
  session: PayrollCorrectionSession | null
  /**
   * Correction mode only: employees with approved attendance records for the week. They stay
   * in the grid even if they have been deactivated or resigned since the week was approved.
   */
  approvedEmployeeIds: ReadonlySet<string>
}

async function requireActiveSession(
  mode: Extract<ReviewMode, { kind: 'CORRECTION' }>,
  upload: AttendanceUpload,
  db: Prisma.TransactionClient = prisma,
): Promise<PayrollCorrectionSession> {
  const session = await db.payrollCorrectionSession.findUnique({ where: { id: mode.correctionId } })
  if (
    !session ||
    session.status !== 'IN_PROGRESS' ||
    session.payrollRunId !== mode.payrollRunId ||
    session.attendanceUploadId !== upload.id
  ) {
    throw new AttendanceSyncError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress.')
  }
  return session
}

/**
 * Everything the review needs, read-only. In correction mode the punch set is the
 * session's draft clone; otherwise it is the live set. Never calls the eTimeOffice API.
 *
 * Pass the interactive transaction client as `db` to read inside the caller's transaction.
 * On the plain client the independent reads run together; on a transaction client they run one
 * after another, since a transaction never needs a second connection.
 */
export async function loadReviewContext(
  weekId: string,
  mode: ReviewMode = { kind: 'LIVE' },
  db: Prisma.TransactionClient = prisma,
): Promise<ReviewContext> {
  const { upload, week } = await requireApiWeek(weekId, db)

  let session: PayrollCorrectionSession | null = null
  if (mode.kind === 'CORRECTION') session = await requireActiveSession(mode, upload, db)

  const readEmployees = () => db.employee.findMany({ select: EMPLOYEE_LITE_SELECT }) as Promise<EmployeeLite[]>
  const readDecisions = () =>
    db.attendanceEmployeeDecision.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true, decision: true },
    })
  const readPunches = () =>
    db.attendancePunch.findMany({
      where: { attendanceUploadId: upload.id, correctionId: mode.kind === 'CORRECTION' ? mode.correctionId : null },
      select: PUNCH_SELECT,
    }) as Promise<PunchRecord[]>
  const readPayrollRun = () =>
    db.payrollRun.findFirst({
      where: { payrollWeekStartDate: toUtcDate(week.start), status: { in: ['APPROVED', 'REVISED'] } },
    })
  // Inside a transaction every query must stay on the transaction's one connection (the pool holds
  // two), so they run one after another; on the plain client they can run together.
  const [employees, decisions, punches, payrollRun] =
    db === prisma
      ? await Promise.all([readEmployees(), readDecisions(), readPunches(), readPayrollRun()])
      : [await readEmployees(), await readDecisions(), await readPunches(), await readPayrollRun()]

  if (mode.kind === 'LIVE' && payrollRun) {
    session = await db.payrollCorrectionSession.findFirst({
      where: { payrollRunId: payrollRun.id, status: 'IN_PROGRESS' },
    })
  }

  let approvedEmployeeIds: ReadonlySet<string> = new Set()
  if (mode.kind === 'CORRECTION') {
    const recorded = await db.attendanceRecord.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true },
      distinct: ['employeeId'],
    })
    approvedEmployeeIds = new Set(recorded.map((r) => r.employeeId))
  }

  return {
    upload,
    week,
    employees,
    decisions: decisions.map((d) => ({ employeeId: d.employeeId, decision: d.decision as EmployeeDecisionValue })),
    punches,
    payrollRun,
    session,
    approvedEmployeeIds,
  }
}

function buildReview<M extends ReviewMode>(
  weekId: string,
  mode: M,
  ctx: ReviewContext,
  today = todayInIST(),
): PunchReview & { mode: M } {
  const { upload, week, employees, decisions, punches, payrollRun, session, approvedEmployeeIds } = ctx
  const status = getAttendanceWeekStatus(upload)
  const dates = getWeekDates(week)

  const eligible = getReviewGridEmployees(employees, decisions, week, approvedEmployeeIds)
  const grid: GridEmployee[] = buildGridEmployees(eligible, punches, dates)
  // In a correction everyone with approved records counts as decided, so a since-deactivated
  // employee can never raise a pending decision that the correction has no way to resolve.
  const issueDecisions =
    mode.kind === 'CORRECTION'
      ? [...decisions, ...[...approvedEmployeeIds].map((employeeId) => ({ employeeId }))]
      : decisions
  const issues = countEmployeeCheckIssues({ week, employees, punches, decisions: issueDecisions })
  const needsFixingDays = getNeedsFixingDays(grid).length

  // A correction edits a draft clone of an approved week, so it is always editable and ended.
  const approval = canApproveWeek({
    status: mode.kind === 'CORRECTION' ? 'REVIEW' : status,
    weekEndISO: week.end,
    todayISO: today,
    needsFixingCount: needsFixingDays,
    unresolvedCodeCount: issues.unresolvedCodes,
    pendingDecisionCount: issues.pendingDecisions,
  })

  const byDay = dates.map((date, index) => ({
    date,
    regular: round2(grid.reduce((sum, e) => sum + e.days[index].regularHours, 0)),
    overtime: round2(grid.reduce((sum, e) => sum + e.days[index].overtimeHours, 0)),
  }))

  const editedAt = punches
    .filter((p) => p.source === 'MANUAL' || p.originalTime !== p.currentTime)
    .map((p) => p.updatedAt.getTime())
  const payrollStatus: WeekPayrollStatus = payrollRun
    ? payrollRun.status === 'REVISED'
      ? 'REVISED'
      : 'APPROVED'
    : 'NOT_GENERATED'

  return {
    weekId,
    week,
    status,
    mode,
    locked: status === 'APPROVED' && mode.kind === 'LIVE',
    employees: grid,
    dates,
    counts: {
      needsFixingDays,
      noPunchEmployees: getNoPunchEmployees(grid).length,
      unusualDays: countUnusualDays(grid),
      unresolvedCodes: issues.unresolvedCodes,
      pendingDecisions: issues.pendingDecisions,
      editedDays: grid.reduce((sum, e) => sum + e.days.filter((d) => d.isEdited).length, 0),
    },
    totals: {
      byDay,
      regular: round2(byDay.reduce((sum, d) => sum + d.regular, 0)),
      overtime: round2(byDay.reduce((sum, d) => sum + d.overtime, 0)),
    },
    approval: { ...approval, weekHasEnded: hasWeekEnded(week, today) },
    payroll: {
      status: payrollStatus,
      payrollRunId: payrollRun?.id ?? null,
      activeCorrectionId: session?.status === 'IN_PROGRESS' ? session.id : null,
    },
    lastSavedAt: editedAt.length > 0 ? new Date(Math.max(...editedAt)).toISOString() : null,
    approvedAt: upload.approvedAt?.toISOString() ?? null,
  }
}

/**
 * The review grid, counts, totals and approval state. Reads only; never calls the API.
 * Pass the interactive transaction client as `db` to read inside the caller's transaction.
 */
export async function getPunchReview<M extends ReviewMode = { kind: 'LIVE' }>(
  weekId: string,
  mode: M = { kind: 'LIVE' } as M,
  db: Prisma.TransactionClient = prisma,
): Promise<PunchReview & { mode: M }> {
  return buildReview(weekId, mode, await loadReviewContext(weekId, mode, db))
}

// ─── savePunchEdit ────────────────────────────────────────────────────────────

type PunchValue = { time: HHmm | null; note: string | null }
type Position = 'IN' | 'OUT'

interface ResolvedSlot {
  pairIndex: number
  position: Position
  /** The stored punch this slot edits, or null when it is a new hand-entered punch. */
  stored: StoredPunchRow | null
  time: HHmm | null
  /** undefined = keep the stored note */
  note: string | null | undefined
}

function cleanNote(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed.slice(0, MAX_NOTE_LENGTH)
}

/**
 * Match each submitted in/out slot to a stored punch (by id, else by its slot) or mark it
 * new. A stored punch keeps its own pair index and position, so pair indices stay stable.
 */
function resolveSlots(pairs: SavePair[], stored: StoredPunchRow[]): ResolvedSlot[] {
  const byId = new Map(stored.map((row) => [row.id, row]))
  const bySlot = new Map(stored.map((row) => [`${row.pairIndex}|${row.position}`, row]))
  const seenPairs = new Set<number>()
  const seenRows = new Set<string>()
  const slots: ResolvedSlot[] = []

  for (const pair of pairs) {
    if (seenPairs.has(pair.pairIndex)) {
      throw new AttendanceSyncError('VALIDATION_ERROR', `Pair ${pair.pairIndex} appears twice.`)
    }
    seenPairs.add(pair.pairIndex)

    for (const position of ['IN', 'OUT'] as const) {
      const side = position === 'IN' ? pair.in : pair.out
      let row: StoredPunchRow | null
      if (side.punchId) {
        row = byId.get(side.punchId) ?? null
        if (!row) {
          throw new AttendanceSyncError('VALIDATION_ERROR', 'A punch in this day no longer exists. Reload and try again.')
        }
      } else {
        row = bySlot.get(`${pair.pairIndex}|${position}`) ?? null
      }
      if (row) {
        if (seenRows.has(row.id)) throw new AttendanceSyncError('VALIDATION_ERROR', 'A punch appears twice.')
        seenRows.add(row.id)
      }

      const raw = side.time && side.time.trim() !== '' ? side.time : null
      slots.push({
        pairIndex: row ? row.pairIndex : pair.pairIndex,
        position: row ? (row.position === 'OUT' ? 'OUT' : 'IN') : position,
        stored: row,
        // An unreadable time is passed on as typed so validateDayPairs reports it.
        time: raw === null ? null : (normalizeTimeInput(raw) ?? raw),
        note: cleanNote(side.note),
      })
    }
  }

  return slots
}

/** The employee's trailing digits, kept as written ("TPLGOAHLP036" → "036"). */
function codeFor(employeeCode: string): string {
  return /(\d+)$/.exec(employeeCode)?.[1] ?? employeeCode
}

type WriteOp = (db: Prisma.TransactionClient) => Promise<unknown>

/**
 * Membership re-check under the lock: the employee must still be in this review's grid (the
 * decision or the employee's status may have changed since the snapshot was read).
 */
async function assertStillInGrid(
  tx: Prisma.TransactionClient,
  upload: AttendanceUpload,
  week: WeekRange,
  employeeId: string,
  mode: ReviewMode,
): Promise<void> {
  const employee = (await tx.employee.findUnique({
    where: { id: employeeId },
    select: EMPLOYEE_LITE_SELECT,
  })) as EmployeeLite | null
  const decisionRow = await tx.attendanceEmployeeDecision.findUnique({
    where: { attendanceUploadId_employeeId: { attendanceUploadId: upload.id, employeeId } },
    select: { decision: true },
  })
  const hasApprovedRecords =
    mode.kind === 'CORRECTION' &&
    (await tx.attendanceRecord.count({ where: { attendanceUploadId: upload.id, employeeId } })) > 0

  const inGrid = employee
    ? getReviewGridEmployees(
        [employee],
        decisionRow ? [{ employeeId, decision: decisionRow.decision as EmployeeDecisionValue }] : [],
        week,
        hasApprovedRecords ? new Set([employeeId]) : undefined,
      ).length > 0
    : false
  if (!inGrid) throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', "That employee isn't in this week's review.")
}

/**
 * Save one employee-day. The submitted pairs are the whole day: a stored punch that is not
 * referenced, or whose time is cleared, is deleted (an API punch keeps its original time).
 * Validation failures write nothing and no audit entry.
 *
 * The writes run in one interactive transaction that first locks the week's row, so an
 * edit cannot interleave with an approve, a reopen, a pull or a revision approval. The writes
 * are built from a snapshot read before the lock, so the transaction re-reads the day and the
 * employee's place in the grid under the lock; if either changed (another save, a pull) it
 * throws DAY_CHANGED or EMPLOYEE_NOT_FOUND instead of applying stale operations. In a
 * correction, a saved change also clears the session's draft revision: the preview built
 * from the earlier punches is then stale and can no longer be approved.
 */
export async function savePunchEdit(input: SavePunchEditInput): Promise<SavePunchEditResult> {
  const { upload, week } = await requireApiWeek(input.weekId)
  const { mode } = input

  if (mode.kind === 'CORRECTION') {
    await requireActiveSession(mode, upload)
  } else if (upload.status !== 'REVIEW') {
    throw new AttendanceSyncError('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.')
  }

  if (!getWeekDates(week).includes(input.date)) {
    throw new AttendanceSyncError('VALIDATION_ERROR', 'That date is not in this payroll week.')
  }

  const [employees, decisions] = await Promise.all([
    prisma.employee.findMany({ select: EMPLOYEE_LITE_SELECT }) as Promise<EmployeeLite[]>,
    prisma.attendanceEmployeeDecision.findMany({
      where: { attendanceUploadId: upload.id },
      select: { employeeId: true, decision: true },
    }),
  ])
  // A correction keeps everyone with approved records in the grid, even if deactivated since.
  const hasApprovedRecords =
    mode.kind === 'CORRECTION' &&
    (await prisma.attendanceRecord.count({
      where: { attendanceUploadId: upload.id, employeeId: input.employeeId },
    })) > 0
  const employee = getReviewGridEmployees(
    employees,
    decisions.map((d) => ({ employeeId: d.employeeId, decision: d.decision as EmployeeDecisionValue })),
    week,
    hasApprovedRecords ? new Set([input.employeeId]) : undefined,
  ).find((e) => e.id === input.employeeId)
  if (!employee) {
    throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', "That employee isn't in this week's review.")
  }

  const correctionId = mode.kind === 'CORRECTION' ? mode.correctionId : null
  const punchDate = toUtcDate(input.date)
  const stored = (await prisma.attendancePunch.findMany({
    where: { attendanceUploadId: upload.id, correctionId, employeeId: input.employeeId, punchDate },
    select: PUNCH_SELECT,
  })) as PunchRecord[]

  const slots = resolveSlots(input.pairs, stored)

  // Validate the day as it will be stored. Unreferenced punches are deleted, so they add no time.
  const effective = new Map<number, { in: HHmm | null; out: HHmm | null }>()
  for (const slot of slots) {
    const pair = effective.get(slot.pairIndex) ?? { in: null, out: null }
    pair[slot.position === 'IN' ? 'in' : 'out'] = slot.time
    effective.set(slot.pairIndex, pair)
  }
  const validation = validateDayPairs([...effective.entries()].map(([pairIndex, pair]) => ({ pairIndex, ...pair })))
  if (!validation.valid) {
    throw new AttendanceSyncError('VALIDATION_ERROR', validation.message, validation)
  }

  const who = `${employee.employeeName} (${employee.employeeId}) on ${input.date}`
  const audit =
    (
      actionType: 'CREATE' | 'UPDATE' | 'DELETE',
      punchId: string,
      summary: string,
      pairIndex: number,
      position: string,
      oldValue: PunchValue | null,
      newValue: PunchValue | null,
    ): WriteOp =>
    (db) =>
      auditEntry(
        {
          actionType,
          entityType: 'ATTENDANCE_PUNCH',
          entityId: punchId,
          details: {
            summary,
            weekStart: week.start,
            employeeId: employee.id,
            employeeCode: employee.employeeId,
            employeeName: employee.employeeName,
            date: input.date,
            pairIndex,
            position,
            old: oldValue,
            new: newValue,
            ...(correctionId ? { correctionId } : {}),
          },
        },
        db,
      )

  // A hand-entered punch has no original to preserve, so it is removed; an API punch keeps its original.
  const deleteOps = (row: StoredPunchRow): WriteOp[] => {
    if (row.source !== 'MANUAL' && row.currentTime === null) return []
    return [
      row.source === 'MANUAL'
        ? (db) => db.attendancePunch.delete({ where: { id: row.id } })
        : (db) => db.attendancePunch.update({ where: { id: row.id }, data: { currentTime: null } }),
      audit('DELETE', row.id, `Deleted ${row.position} ${row.currentTime ?? 'none'} for ${who}`, row.pairIndex, row.position, {
        time: row.currentTime,
        note: row.note,
      }, null),
    ]
  }

  const ops: WriteOp[] = []
  const referenced = new Set(slots.map((s) => s.stored?.id).filter((id): id is string => !!id))
  for (const row of stored) {
    if (!referenced.has(row.id)) ops.push(...deleteOps(row))
  }

  for (const slot of slots) {
    const row = slot.stored
    if (!row) {
      if (slot.time === null) continue
      const id = randomUUID()
      const note = slot.note ?? null
      ops.push(
        (db) =>
          db.attendancePunch.create({
            data: {
              id,
              attendanceUploadId: upload.id,
              correctionId,
              employeeId: input.employeeId,
              empCode: codeFor(employee.employeeId),
              empName: null,
              matchStatus: 'MATCHED',
              punchDate,
              pairIndex: slot.pairIndex,
              position: slot.position,
              source: 'MANUAL',
              originalTime: null,
              currentTime: slot.time,
              note,
            },
          }),
        audit('CREATE', id, `Added ${slot.position} ${slot.time} for ${who}`, slot.pairIndex, slot.position, null, {
          time: slot.time,
          note,
        }),
      )
    } else if (slot.time === null) {
      ops.push(...deleteOps(row))
    } else {
      const nextNote = slot.note === undefined ? row.note : slot.note
      if (row.currentTime === slot.time && row.note === nextNote) continue
      ops.push(
        (db) => db.attendancePunch.update({ where: { id: row.id }, data: { currentTime: slot.time, note: nextNote } }),
        audit(
          'UPDATE',
          row.id,
          `Changed ${row.position} ${row.currentTime ?? 'none'} to ${slot.time} for ${who}`,
          row.pairIndex,
          row.position,
          { time: row.currentTime, note: row.note },
          { time: slot.time, note: nextNote },
        ),
      )
    }
  }

  if (ops.length > 0) {
    await prisma.$transaction(
      async (tx) => {
        const locked = await lockWeekRow(tx, { id: upload.id })
        if (!locked) throw new AttendanceSyncError('WEEK_NOT_READY', 'No attendance has been loaded for this week.')

        let session: PayrollCorrectionSession | null = null
        if (mode.kind === 'CORRECTION') {
          session = await requireActiveSession(mode, upload, tx)
        } else {
          if (locked.status !== 'REVIEW') {
            throw new AttendanceSyncError('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.')
          }
          assertNotSyncing(locked)
        }

        // The ops were built from a snapshot taken before the lock. Another save or a pull may have
        // changed the day since; apply the ops only to the day they were built for.
        const current = (await tx.attendancePunch.findMany({
          where: { attendanceUploadId: upload.id, correctionId, employeeId: input.employeeId, punchDate },
          select: PUNCH_SELECT,
        })) as PunchRecord[]
        if (punchSetSignature(current) !== punchSetSignature(stored)) {
          throw new AttendanceSyncError(
            'DAY_CHANGED',
            'This day changed since you opened it (another save or a pull). Close the editor, reopen the day and try again.',
          )
        }
        await assertStillInGrid(tx, upload, week, input.employeeId, mode)

        for (const op of ops) await op(tx)

        // The punches changed, so a draft revision calculated from the earlier ones is stale.
        if (session) {
          await tx.payrollCorrectionSession.update({ where: { id: session.id }, data: { draftRevisionId: null } })
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    )
  }

  const review = await getPunchReview(input.weekId, mode)
  const gridEmployee = review.employees.find((e) => e.employeeId === input.employeeId)
  const day: DayView | undefined = gridEmployee?.days.find((d) => d.date === input.date)
  if (!gridEmployee || !day) {
    throw new AttendanceSyncError('EMPLOYEE_NOT_FOUND', "That employee isn't in this week's review.")
  }

  return {
    day,
    employeeTotals: {
      regular: gridEmployee.totalRegularHours,
      overtime: gridEmployee.totalOvertimeHours,
      hasAnyPunch: gridEmployee.hasAnyPunch,
    },
    counts: review.counts,
    totals: review.totals,
    approval: review.approval,
    savedAt: new Date().toISOString(),
  }
}
