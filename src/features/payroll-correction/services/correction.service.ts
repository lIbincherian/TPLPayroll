import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import {
  CorrectionServiceError,
  type AbandonCorrectionResult,
  type ApproveRevisionResult,
  type BeginCorrectionResult,
  type CorrectionSessionInfo,
  type CorrectionType,
  type CreateRevisionInput,
  type CreateRevisionResult,
  type InitiateCorrectionResult,
  type RevisedEmployeeRow,
  type RevisionHistoryItem,
  type StartAttendanceCorrectionInput,
} from '@/features/payroll-correction/types/correction.types'
import {
  calculateRegularPay,
  calculateOvertimePay,
  calculateNetPayable,
} from '@/features/payroll-generation/services/payroll.service'
import { skipAdjustmentApplication } from '@/features/payroll-adjustments/services/adjustment.service'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { buildAttendanceRecords, getPayrollEmployees } from '@/features/attendance-sync/lib/review'
import { TRANSACTION_TIMEOUT_MS } from '@/features/attendance-sync/lib/constants'
import { toISODate } from '@/features/attendance-sync/lib/week'
import type { DiscardedEdit } from '@/features/attendance-sync/types/attendance-sync.types'

const CREATE_MANY_CHUNK_SIZE = 1000
const MAX_AUDITED_EDITS = 500

// ─── Shared helpers ───────────────────────────────────────────────────────────

function parseCorrectionTypes(value: unknown): CorrectionType[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is CorrectionType => v === 'ADJUSTMENTS' || v === 'ATTENDANCE' || v === 'EMPLOYEE_DATA',
  )
}

/** What an adjustment application looked like before the correction reset it. */
interface AdjustmentSnapshotEntry {
  applicationId: string
  approvalStatus: string
  isReversed: boolean
  approvedAt: string | null
  skippedAt: string | null
  appliedAt: string | null
}

function parseAdjustmentSnapshot(value: unknown): AdjustmentSnapshotEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is AdjustmentSnapshotEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as AdjustmentSnapshotEntry).applicationId === 'string',
  )
}

/** The employee fields payroll needs, with the wage in effect for the week. */
function employeePaySelect(weekStart: Date, weekEnd: Date) {
  return {
    id: true,
    employeeId: true,
    employeeName: true,
    designation: true,
    designationShort: true,
    site: true,
    gPay: true,
    bankAccount: true,
    wageHistory: {
      where: {
        effectiveFrom: { lte: weekEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: weekStart } }],
      },
      orderBy: { effectiveFrom: 'desc' as const },
      take: 1,
    },
  } satisfies Prisma.EmployeeSelect
}

type PayEmployee = Prisma.EmployeeGetPayload<{ select: ReturnType<typeof employeePaySelect> }>

/** One day of hours for an employee, from either the approved records or a correction's punches. */
interface HoursRecord {
  employeeId: string
  regularHours: Prisma.Decimal | number
  overtimeHours: Prisma.Decimal | number
  employee: PayEmployee
}

async function requireActiveSession(payrollRunId: string) {
  const session = await prisma.payrollCorrectionSession.findFirst({
    where: { payrollRunId, status: 'IN_PROGRESS' },
    orderBy: { createdAt: 'desc' },
    include: { attendanceUpload: { select: { id: true, source: true, payrollWeekStartDate: true } } },
  })
  if (!session) {
    throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'No correction is in progress for this payroll run')
  }
  return session
}

// ─── prepareAdjustmentsForCorrection ───────────────────────────────────────────

type AdjustmentWriter = Pick<Prisma.TransactionClient, 'payrollRun' | 'payrollAdjustmentApplication'>

/** Pass a transaction client as `db` to run the reset inside the caller's transaction. */
export async function prepareAdjustmentsForCorrection(
  payrollRunId: string,
  db: AdjustmentWriter = prisma,
): Promise<void> {
  // Look up the run's week so we can also target unlinked applications
  const run = await db.payrollRun.findUnique({
    where: { id: payrollRunId },
    select: { payrollWeekStartDate: true },
  })

  await db.payrollAdjustmentApplication.updateMany({
    where: {
      OR: [
        // Applications already linked to this payroll run
        { payrollRunId },
        // New applications created after approval (payrollRunId is null)
        ...(run
          ? [{
              payrollWeekStartDate: run.payrollWeekStartDate,
              payrollRunId: null,
              approvalStatus: 'PENDING' as const,
            }]
          : []),
      ],
    },
    data: {
      approvalStatus: 'PENDING',
      isReversed: false,
      approvedAt: null,
      skippedAt: null,
      // Note: We do NOT clear payrollRunId or payrollRevisionId as they track origin,
      // but resetting approvalStatus guarantees they show up for re-evaluation.
    },
  })
}

// ─── beginCorrection ──────────────────────────────────────────────────────────

/**
 * Open a correction session for an approved run, or resume the one already open.
 * A new session remembers how the week's adjustment applications looked (so abandoning
 * can put them back) and then resets them for re-evaluation, in one transaction that first
 * locks the week's row. Two requests for the same run (a double click) therefore serialize:
 * the second finds the first one's session and resumes it, instead of opening another and
 * snapshotting the adjustments the first one had already reset.
 */
export async function beginCorrection(payrollRunId: string): Promise<BeginCorrectionResult> {
  const run = await prisma.payrollRun.findUnique({ where: { id: payrollRunId } })
  if (!run) {
    throw new CorrectionServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run "${payrollRunId}" not found`)
  }
  if (run.status !== 'APPROVED' && run.status !== 'REVISED') {
    throw new CorrectionServiceError(
      'CANNOT_CORRECT_UNAPPROVED_PAYROLL',
      `Cannot correct payroll with status "${run.status}"`,
    )
  }

  const existing = await prisma.payrollCorrectionSession.findFirst({
    where: { payrollRunId, status: 'IN_PROGRESS' },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return {
      sessionId: existing.id,
      resumed: true,
      correctionTypes: parseCorrectionTypes(existing.correctionTypesJson),
    }
  }

  const upload = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: run.payrollWeekStartDate,
      payrollWeekEndDate: run.payrollWeekEndDate,
      isActiveForPayrollWeek: true,
    },
    select: { id: true },
  })
  if (!upload) {
    throw new CorrectionServiceError('PAYROLL_RUN_NOT_FOUND', 'No attendance was found for this payroll run\'s week')
  }

  return prisma.$transaction(
    async (tx) => {
      await lockWeekRow(tx, { id: upload.id })

      // The check above ran without the lock; another request may have opened a session since.
      const open = await tx.payrollCorrectionSession.findFirst({
        where: { payrollRunId, status: 'IN_PROGRESS' },
        orderBy: { createdAt: 'desc' },
      })
      if (open) {
        return {
          sessionId: open.id,
          resumed: true,
          correctionTypes: parseCorrectionTypes(open.correctionTypesJson),
        }
      }

      // Read under the lock, so the snapshot is the state the reset below is about to change.
      const applications = await tx.payrollAdjustmentApplication.findMany({
        where: {
          OR: [
            { payrollRunId },
            { payrollWeekStartDate: run.payrollWeekStartDate, payrollRunId: null },
          ],
        },
        select: {
          id: true,
          approvalStatus: true,
          isReversed: true,
          approvedAt: true,
          skippedAt: true,
          appliedAt: true,
        },
      })
      const adjustmentSnapshot: AdjustmentSnapshotEntry[] = applications.map((app) => ({
        applicationId: app.id,
        approvalStatus: app.approvalStatus,
        isReversed: app.isReversed,
        approvedAt: app.approvedAt?.toISOString() ?? null,
        skippedAt: app.skippedAt?.toISOString() ?? null,
        appliedAt: app.appliedAt?.toISOString() ?? null,
      }))

      const created = await tx.payrollCorrectionSession.create({
        data: {
          payrollRunId,
          attendanceUploadId: upload.id,
          status: 'IN_PROGRESS',
          correctionTypesJson: [],
          adjustmentSnapshotJson: adjustmentSnapshot as unknown as Prisma.InputJsonValue,
        },
      })
      await prepareAdjustmentsForCorrection(payrollRunId, tx)
      return { sessionId: created.id, resumed: false, correctionTypes: [] }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

// ─── getActiveCorrection ──────────────────────────────────────────────────────

export async function getActiveCorrection(payrollRunId: string): Promise<CorrectionSessionInfo | null> {
  const session = await prisma.payrollCorrectionSession.findFirst({
    where: { payrollRunId, status: 'IN_PROGRESS' },
    orderBy: { createdAt: 'desc' },
    include: { attendanceUpload: { select: { source: true, payrollWeekStartDate: true } } },
  })
  if (!session) return null

  const clonedPunches = await prisma.attendancePunch.count({ where: { correctionId: session.id } })

  return {
    sessionId: session.id,
    payrollRunId: session.payrollRunId,
    attendanceUploadId: session.attendanceUploadId,
    weekId: toISODate(session.attendanceUpload.payrollWeekStartDate),
    attendanceSource: session.attendanceUpload.source === 'ETIMEOFFICE' ? 'ETIMEOFFICE' : 'EXCEL',
    correctionReason: session.correctionReason,
    correctionTypes: parseCorrectionTypes(session.correctionTypesJson),
    hasPunchClone: clonedPunches > 0,
    draftRevisionId: session.draftRevisionId,
  }
}

// ─── startAttendanceCorrection ────────────────────────────────────────────────

/**
 * Save the reason and types, and copy the week's approved punches so they can be edited
 * apart from the live set. The live punches and attendance records stay untouched until
 * the revision is approved. Excel-era runs have no punches to copy.
 *
 * The transaction locks the week's row first and then checks whether the copy exists, so two
 * concurrent calls cannot both copy (the clone set would hold every punch twice).
 */
export async function startAttendanceCorrection(
  payrollRunId: string,
  input: StartAttendanceCorrectionInput,
): Promise<{ sessionId: string; weekId: string }> {
  const types = parseCorrectionTypes(input.types)
  if (types.length === 0) {
    throw new CorrectionServiceError('NO_CORRECTION_TYPE_SELECTED', 'At least one correction type must be selected')
  }

  const session = await requireActiveSession(payrollRunId)
  const upload = session.attendanceUpload
  const wantsAttendance = types.includes('ATTENDANCE')

  if (wantsAttendance && upload.source !== 'ETIMEOFFICE') {
    throw new CorrectionServiceError(
      'EXCEL_ERA_ATTENDANCE_CORRECTION',
      "Attendance can't be corrected for an Excel-era week",
    )
  }

  await prisma.$transaction(
    async (tx) => {
      await lockWeekRow(tx, { id: upload.id })
      // The session was read before the lock; it may have been abandoned or applied since.
      const current = await tx.payrollCorrectionSession.findUnique({ where: { id: session.id } })
      if (!current || current.status !== 'IN_PROGRESS') {
        throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress.')
      }

      await tx.payrollCorrectionSession.update({
        where: { id: session.id },
        data: { correctionReason: input.reason, correctionTypesJson: types },
      })
      if (!wantsAttendance) return

      // Copy once. Coming back to the punches keeps the edits made so far.
      const alreadyCopied = await tx.attendancePunch.count({ where: { correctionId: session.id } })
      if (alreadyCopied > 0) return

      const live = await tx.attendancePunch.findMany({
        where: { attendanceUploadId: upload.id, correctionId: null },
      })
      for (let i = 0; i < live.length; i += CREATE_MANY_CHUNK_SIZE) {
        await tx.attendancePunch.createMany({
          data: live.slice(i, i + CREATE_MANY_CHUNK_SIZE).map((row) => ({
            attendanceUploadId: row.attendanceUploadId,
            correctionId: session.id,
            clonedFromPunchId: row.id,
            employeeId: row.employeeId,
            empCode: row.empCode,
            empName: row.empName,
            matchStatus: row.matchStatus,
            punchDate: row.punchDate,
            pairIndex: row.pairIndex,
            position: row.position,
            source: row.source,
            originalTime: row.originalTime,
            currentTime: row.currentTime,
            note: row.note,
            mergedScansJson:
              row.mergedScansJson === null ? Prisma.DbNull : (row.mergedScansJson as Prisma.InputJsonValue),
            mcid: row.mcid,
          })),
        })
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )

  return { sessionId: session.id, weekId: toISODate(upload.payrollWeekStartDate) }
}

// ─── initiateCorrection ───────────────────────────────────────────────────────

export async function initiateCorrection(
  payrollRunId: string,
): Promise<InitiateCorrectionResult> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: {
        where: { isCurrent: true },
        take: 1,
      },
    },
  })

  if (!run) {
    throw new CorrectionServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run "${payrollRunId}" not found`)
  }

  if (run.status !== 'APPROVED' && run.status !== 'REVISED') {
    throw new CorrectionServiceError(
      'CANNOT_CORRECT_UNAPPROVED_PAYROLL',
      `Cannot correct payroll with status "${run.status}"`,
    )
  }

  const currentRevision = run.revisions[0]
  if (!currentRevision) {
    throw new CorrectionServiceError('REVISION_NOT_FOUND', 'No current revision found for this payroll run')
  }

  // Load employee records for this revision
  const runEmployees = await prisma.payrollRunEmployee.findMany({
    where: { payrollRevisionId: currentRevision.id },
    include: {
      employee: {
        select: { employeeId: true, employeeName: true },
      },
    },
  })

  // Load adjustment applications for this week — includes both previously-linked
  // applications AND new ones created after the payroll was approved (payrollRunId=null)
  const adjustmentApps = await prisma.payrollAdjustmentApplication.findMany({
    where: {
      payrollWeekStartDate: run.payrollWeekStartDate,
      OR: [
        { payrollRunId: run.id },
        { payrollRunId: null, approvalStatus: 'PENDING' },
      ],
    },
    include: {
      payrollAdjustment: { select: { adjustmentType: true, amount: true, reason: true } },
      employee: { select: { employeeName: true, employeeId: true } },
    },
  })

  return {
    payrollRunId: run.id,
    revisionId: currentRevision.id,
    revisionNumber: currentRevision.revisionNumber,
    weekStart: run.payrollWeekStartDate,
    weekEnd: run.payrollWeekEndDate,
    totals: {
      totalRegularHours: runEmployees.reduce((s, r) => s + Number(r.regularHours), 0),
      totalOvertimeHours: runEmployees.reduce((s, r) => s + Number(r.overtimeHours), 0),
      totalRegularPay: Number(currentRevision.totalRegularPay),
      totalOvertimePay: Number(currentRevision.totalOvertimePay),
      totalAdditions: Number(currentRevision.totalAdditions),
      totalDeductions: Number(currentRevision.totalDeductions),
      totalNetPayable: Number(currentRevision.totalNetPayable),
    },
    employees: runEmployees.map((re) => ({
      employeeId: re.employeeId,
      employeeCode: re.employee.employeeId,
      employeeName: re.employee.employeeName,
      netPayable: Number(re.netPayable),
    })),
    adjustmentApplications: adjustmentApps.map((app) => ({
      applicationId: app.id,
      adjustmentId: app.payrollAdjustmentId,
      employeeId: app.employeeId,
      employeeName: app.employee.employeeName,
      employeeCode: app.employee.employeeId,
      adjustmentType: app.payrollAdjustment.adjustmentType as 'DEDUCTION' | 'ADDITION',
      amount: Number(app.payrollAdjustment.amount),
      appliedAmount: Number(app.appliedAmount),
      reason: app.payrollAdjustment.reason,
      approvalStatus: app.approvalStatus as 'PENDING' | 'APPROVED' | 'SKIPPED',
      isReversed: app.isReversed,
    })),
  }
}

// ─── reverseAdjustmentApplication ─────────────────────────────────────────────

export async function reverseAdjustmentApplication(
  applicationId: string,
): Promise<{ applicationId: string; isReversed: true }> {
  const app = await prisma.payrollAdjustmentApplication.findUnique({
    where: { id: applicationId },
  })

  if (!app) {
    throw new CorrectionServiceError('APPLICATION_NOT_FOUND', `Application "${applicationId}" not found`)
  }

  if (app.isReversed) {
    throw new CorrectionServiceError('ALREADY_REVERSED', 'Application is already reversed')
  }

  await prisma.payrollAdjustmentApplication.update({
    where: { id: applicationId },
    data: { isReversed: true },
  })

  return { applicationId, isReversed: true }
}

// ─── approveSkippedAdjustment ─────────────────────────────────────────────────

export async function approveSkippedAdjustment(
  applicationId: string,
): Promise<{ applicationId: string; approvalStatus: 'APPROVED' }> {
  const app = await prisma.payrollAdjustmentApplication.findUnique({
    where: { id: applicationId },
  })

  if (!app) {
    throw new CorrectionServiceError('APPLICATION_NOT_FOUND', `Application "${applicationId}" not found`)
  }

  if (app.approvalStatus !== 'SKIPPED') {
    throw new CorrectionServiceError(
      'CANNOT_APPROVE_NON_SKIPPED',
      `Cannot approve application with status "${app.approvalStatus}"`,
    )
  }

  await prisma.payrollAdjustmentApplication.update({
    where: { id: applicationId },
    data: {
      approvalStatus: 'APPROVED',
      appliedAt: new Date(),
    },
  })

  return { applicationId, approvalStatus: 'APPROVED' }
}

// ─── recalculateAndCreateRevision ─────────────────────────────────────────────

/**
 * Hours for a correction that edits punches: one row per employee per day from the
 * session's copied punches. The employee set is everyone with hours in the corrected week.
 * Pass the transaction client as `db` to read inside the caller's transaction.
 *
 * An incomplete pair contributes no hours, so a draft built over one would be wrong for every
 * caller; it is refused here.
 */
async function loadCorrectionHours(
  weekStart: Date,
  weekEnd: Date,
  run: { id: string },
  currentRevisionNumber: number,
  correctionId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<HoursRecord[]> {
  const review = await getPunchReview(
    toISODate(weekStart),
    {
      kind: 'CORRECTION',
      payrollRunId: run.id,
      correctionId,
      revisionNumber: currentRevisionNumber,
    },
    db,
  )
  if (review.counts.needsFixingDays > 0) {
    throw new CorrectionServiceError(
      'CORRECTION_HAS_INCOMPLETE_PAIRS',
      `${review.counts.needsFixingDays} day(s) still have an incomplete pair. Fix or delete them first.`,
    )
  }
  const payrollEmployees = getPayrollEmployees(review)

  const employees = await db.employee.findMany({
    where: { id: { in: payrollEmployees.map((e) => e.employeeId) } },
    select: employeePaySelect(weekStart, weekEnd),
  })
  const employeeById = new Map(employees.map((e) => [e.id, e]))

  return payrollEmployees.flatMap((payrollEmployee) => {
    const employee = employeeById.get(payrollEmployee.employeeId)
    if (!employee) return []
    return payrollEmployee.days.map((day) => ({
      employeeId: payrollEmployee.employeeId,
      regularHours: day.regularHours,
      overtimeHours: day.overtimeHours,
      employee,
    }))
  })
}

/**
 * Work out the corrected payroll and save it as a DRAFT revision. The current revision stays
 * current and the PayrollRun is untouched until `approveRevision`. Recalculating again
 * replaces the draft.
 *
 * The calculation and the writes are one transaction that first locks the week's row (with or
 * without a correction session), and the punches and the current revision are read inside it, so
 * the draft always matches the punches at commit and is numbered and diffed against the revision
 * that is current at that moment. A punch edit that lands after it clears the session's draft
 * pointer (savePunchEdit takes the same lock); one that landed before it is included. Adjustment
 * changes are written in the same transaction, so a failed draft leaves them as they were.
 */
export async function recalculateAndCreateRevision(
  input: CreateRevisionInput,
): Promise<CreateRevisionResult> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: input.payrollRunId },
    include: {
      revisions: {
        where: { isCurrent: true },
        take: 1,
      },
    },
  })

  if (!run) {
    throw new CorrectionServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run "${input.payrollRunId}" not found`)
  }

  if (input.correctionTypes.length === 0) {
    throw new CorrectionServiceError('NO_CORRECTION_TYPE_SELECTED', 'At least one correction type must be selected')
  }

  // Fast fail only: the current revision is read again under the lock, and that one is used.
  if (!run.revisions[0]) {
    throw new CorrectionServiceError('REVISION_NOT_FOUND', 'No current revision found')
  }

  const weekStart = run.payrollWeekStartDate
  const weekEnd = run.payrollWeekEndDate

  // Checked here to fail fast; the transaction below checks it again once the week is locked.
  let found: { id: string; attendanceUploadId: string } | null = null
  if (input.correctionSessionId) {
    const row = await prisma.payrollCorrectionSession.findUnique({ where: { id: input.correctionSessionId } })
    if (!row || row.status !== 'IN_PROGRESS' || row.payrollRunId !== run.id) {
      throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress')
    }
    found = row
  }
  const session = found

  return prisma.$transaction(
    async (tx) => {
      // Every draft takes the week lock first, with a session or without one.
      if (session) {
        await lockWeekRow(tx, { id: session.attendanceUploadId })
        // The session was read before the lock; it may have been abandoned or applied since.
        const current = await tx.payrollCorrectionSession.findUnique({ where: { id: session.id } })
        if (!current || current.status !== 'IN_PROGRESS' || current.payrollRunId !== run.id) {
          throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress')
        }
      } else {
        // Without a session the week is found by its start date. No active row for it is not an error.
        await lockWeekRow(tx, { weekStart })
      }

      // A revision may have been approved since the read above; draft against the one that is current now.
      const currentRevision = await tx.payrollRevision.findFirst({ where: { payrollRunId: run.id, isCurrent: true } })
      if (!currentRevision) {
        throw new CorrectionServiceError('REVISION_NOT_FOUND', 'No current revision found')
      }

      const editsPunches = session
        ? (await tx.attendancePunch.count({ where: { correctionId: session.id } })) > 0
        : false

      // Hours come from the correction's edited punches when it has them, otherwise from the
      // approved attendance records.
      let attendanceRecords: HoursRecord[]
      if (session && editsPunches) {
        attendanceRecords = await loadCorrectionHours(weekStart, weekEnd, run, currentRevision.revisionNumber, session.id, tx)
      } else {
        // Fetch the active attendance upload for this week
        const upload = await tx.attendanceUpload.findFirst({
          where: {
            payrollWeekStartDate: weekStart,
            payrollWeekEndDate: weekEnd,
            isActiveForPayrollWeek: true,
          },
        })

        attendanceRecords = await tx.attendanceRecord.findMany({
          where: { attendanceUploadId: upload?.id ?? '' },
          include: { employee: { select: employeePaySelect(weekStart, weekEnd) } },
          orderBy: [{ employeeId: 'asc' }, { attendanceDate: 'asc' }],
        })
      }

      // Group attendance by employee
      type EmployeeGroup = {
        employee: PayEmployee
        records: HoursRecord[]
      }

      const employeeMap = new Map<string, EmployeeGroup>()
      for (const record of attendanceRecords) {
        const key = record.employeeId
        if (!employeeMap.has(key)) {
          employeeMap.set(key, { employee: record.employee, records: [] })
        }
        employeeMap.get(key)!.records.push(record)
      }

      // Get previous revision's employee data for diff tracking
      const previousEmployees = await tx.payrollRunEmployee.findMany({
        where: { payrollRevisionId: currentRevision.id },
      })
      const prevByEmployee = new Map(previousEmployees.map((pe) => [pe.employeeId, pe]))

      // Apply adjustment changes (reversals)
      if (input.adjustmentChanges?.reversed?.length) {
        await tx.payrollAdjustmentApplication.updateMany({
          where: { id: { in: input.adjustmentChanges.reversed } },
          data: { isReversed: true },
        })
      }

      // Apply adjustment changes (re-approvals)
      if (input.adjustmentChanges?.approved?.length) {
        await tx.payrollAdjustmentApplication.updateMany({
          where: { id: { in: input.adjustmentChanges.approved } },
          data: { approvalStatus: 'APPROVED', appliedAt: new Date() },
        })
      }

      // Get approved, non-reversed adjustment applications for this week
      const approvedApplications = await tx.payrollAdjustmentApplication.findMany({
        where: {
          payrollWeekStartDate: weekStart,
          approvalStatus: 'APPROVED',
          isReversed: false,
          employeeId: { in: [...employeeMap.keys()] },
        },
        include: {
          payrollAdjustment: { select: { adjustmentType: true } },
        },
      })

      type AdjGroup = { additions: number; deductions: number }
      const adjByEmployee = new Map<string, AdjGroup>()
      for (const app of approvedApplications) {
        if (!adjByEmployee.has(app.employeeId)) {
          adjByEmployee.set(app.employeeId, { additions: 0, deductions: 0 })
        }
        const group = adjByEmployee.get(app.employeeId)!
        const amount = Number(app.appliedAmount)
        if (app.payrollAdjustment.adjustmentType === 'ADDITION') {
          group.additions += amount
        } else {
          group.deductions += amount
        }
      }

      // Calculate payroll for each employee
      const employeeRows: RevisedEmployeeRow[] = []

      for (const [, group] of employeeMap) {
        const { employee, records } = group
        const wage = employee.wageHistory[0]
        if (!wage) continue

        const hourlyRate = Number(wage.hourlyRate)
        const weeklySalary = Number(wage.weeklySalary)

        const dailyRegular = records.map((r) => Number(r.regularHours))
        const dailyOT = records.map((r) => Number(r.overtimeHours))

        const { regularHours, regularPay } = calculateRegularPay(dailyRegular, hourlyRate)
        const { overtimeHours, overtimePay } = calculateOvertimePay(dailyOT, hourlyRate)
        const grossPay = regularPay + overtimePay

        const adjs = adjByEmployee.get(employee.id) ?? { additions: 0, deductions: 0 }
        const netPayable = calculateNetPayable(grossPay, adjs.additions, adjs.deductions)

        const prev = prevByEmployee.get(employee.id)

        employeeRows.push({
          employeeId: employee.id,
          employeeCode: employee.employeeId,
          employeeName: employee.employeeName,
          designation: employee.designation,
          designationShort: employee.designationShort,
          site: employee.site,
          gPay: employee.gPay,
          bankAccount: employee.bankAccount,
          weeklySalaryUsed: weeklySalary,
          hourlyRateUsed: hourlyRate,
          regularHours,
          overtimeHours,
          regularPay,
          overtimePay,
          grossPay,
          additions: adjs.additions,
          deductions: adjs.deductions,
          netPayable,
          previousNetPayable: prev ? Number(prev.netPayable) : null,
          previousRegularPay: prev ? Number(prev.regularPay) : null,
          previousOvertimePay: prev ? Number(prev.overtimePay) : null,
          previousAdditions: prev ? Number(prev.additions) : null,
          previousDeductions: prev ? Number(prev.deductions) : null,
          isNew: !prev,
          isLeftOut: false,
        })
      }

      // Calculate totals
      const totals = {
        totalRegularHours: employeeRows.reduce((s, r) => s + r.regularHours, 0),
        totalOvertimeHours: employeeRows.reduce((s, r) => s + r.overtimeHours, 0),
        totalRegularPay: employeeRows.reduce((s, r) => s + r.regularPay, 0),
        totalOvertimePay: employeeRows.reduce((s, r) => s + r.overtimePay, 0),
        totalAdditions: employeeRows.reduce((s, r) => s + r.additions, 0),
        totalDeductions: employeeRows.reduce((s, r) => s + r.deductions, 0),
        totalNetPayable: employeeRows.reduce((s, r) => s + r.netPayable, 0),
      }

      const newRevisionNumber = currentRevision.revisionNumber + 1
      const now = new Date()

      const newRevisionId = randomUUID()

      // Replace any earlier draft with this one. The current revision, the PayrollRun and the
      // adjustment applications' revision links are not touched here.
      await tx.payrollRunEmployee.deleteMany({
        where: { payrollRunId: run.id, payrollRevision: { status: 'DRAFT' } },
      })
      await tx.payrollRevision.deleteMany({
        where: { payrollRunId: run.id, status: 'DRAFT' },
      })

      // Create the draft revision
      await tx.payrollRevision.create({
        data: {
          id: newRevisionId,
          payrollRunId: run.id,
          revisionNumber: newRevisionNumber,
          status: 'DRAFT',
          isCurrent: false,
          correctionReason: input.correctionReason,
          totalRegularPay: totals.totalRegularPay,
          totalOvertimePay: totals.totalOvertimePay,
          totalAdditions: totals.totalAdditions,
          totalDeductions: totals.totalDeductions,
          totalNetPayable: totals.totalNetPayable,
          generatedAt: now,
          approvedAt: null,
        },
      })

      // Create the draft's employee records
      await tx.payrollRunEmployee.createMany({
        data: employeeRows.map((emp) => ({
          payrollRunId: run.id,
          payrollRevisionId: newRevisionId,
          employeeId: emp.employeeId,
          weeklySalaryUsed: emp.weeklySalaryUsed,
          hourlyRateUsed: emp.hourlyRateUsed,
          regularHours: emp.regularHours,
          overtimeHours: emp.overtimeHours,
          regularPay: emp.regularPay,
          overtimePay: emp.overtimePay,
          additions: emp.additions,
          deductions: emp.deductions,
          netPayable: emp.netPayable,
        })),
      })

      if (session) {
        await tx.payrollCorrectionSession.update({
          where: { id: session.id },
          data: {
            draftRevisionId: newRevisionId,
            correctionReason: input.correctionReason,
            correctionTypesJson: input.correctionTypes,
          },
        })
      }

      return {
        payrollRunId: run.id,
        revisionId: newRevisionId,
        revisionNumber: newRevisionNumber,
        totals,
        employeeCount: employeeRows.length,
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

// ─── approveCorrectionPunches ─────────────────────────────────────────────────

/**
 * The "Approve punches" step: the corrected hours are turned into the draft revision shown on
 * the preview. Every incomplete pair must be fixed first; that check runs inside the
 * recalculation's transaction (CORRECTION_HAS_INCOMPLETE_PAIRS), against the same punches the
 * draft is built from.
 */
export async function approveCorrectionPunches(payrollRunId: string): Promise<CreateRevisionResult> {
  const session = await requireActiveSession(payrollRunId)
  const run = await prisma.payrollRun.findUnique({ where: { id: payrollRunId }, select: { id: true } })
  if (!run) {
    throw new CorrectionServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run "${payrollRunId}" not found`)
  }

  return recalculateAndCreateRevision({
    payrollRunId,
    correctionReason: session.correctionReason,
    correctionTypes: parseCorrectionTypes(session.correctionTypesJson),
    correctionSessionId: session.id,
  })
}

// ─── approveRevision ──────────────────────────────────────────────────────────

function staleRevisionError(): CorrectionServiceError {
  return new CorrectionServiceError(
    'REVISION_STALE',
    'This preview is out of date: the punches changed after it was calculated. Approve the punches again.',
  )
}

/**
 * Make the draft revision current. One transaction: the draft becomes the current approved
 * revision, the one it replaces is superseded, the run takes the new totals, the week's
 * adjustment applications move to the new revision (those of employees the revision leaves out
 * are carried forward instead), and, for an attendance correction, the corrected punches and
 * attendance records replace the live ones. If anything fails the current revision stays
 * exactly as it was.
 *
 * A correction session approves only the draft its punches produced: editing punches clears
 * the session's draft pointer, so a preview calculated from earlier punches is REVISION_STALE.
 * The week's row lock is taken first and the punches are read inside the transaction, so no
 * edit can land between the check and the write.
 */
export async function approveRevision(
  revisionId: string,
): Promise<ApproveRevisionResult> {
  const revision = await prisma.payrollRevision.findUnique({
    where: { id: revisionId },
    include: { payrollRun: true },
  })

  if (!revision) {
    throw new CorrectionServiceError('REVISION_NOT_FOUND', `Revision "${revisionId}" not found`)
  }
  if (revision.status !== 'DRAFT') {
    throw new CorrectionServiceError('REVISION_NOT_DRAFT', 'Only a draft revision can be approved')
  }

  const run = revision.payrollRun
  // No session means a draft made without one (adjustments only, or older data): it approves as before.
  const session = await prisma.payrollCorrectionSession.findFirst({
    where: { payrollRunId: run.id, status: 'IN_PROGRESS' },
    include: { attendanceUpload: { select: { id: true, payrollWeekStartDate: true } } },
  })
  if (session && session.draftRevisionId !== revisionId) throw staleRevisionError()

  const now = new Date()

  await prisma.$transaction(
    async (tx) => {
      // Corrected punches and records, read inside the transaction once the week is locked.
      let clonedPunches = 0
      let correctedRecords: Prisma.AttendanceRecordCreateManyInput[] = []
      if (session) {
        await lockWeekRow(tx, { id: session.attendanceUploadId })

        const current = await tx.payrollCorrectionSession.findUnique({ where: { id: session.id } })
        if (!current || current.status !== 'IN_PROGRESS') {
          throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress.')
        }
        if (current.draftRevisionId !== revisionId) throw staleRevisionError()

        clonedPunches = await tx.attendancePunch.count({ where: { correctionId: session.id } })
        if (clonedPunches > 0) {
          const review = await getPunchReview(
            toISODate(session.attendanceUpload.payrollWeekStartDate),
            {
              kind: 'CORRECTION',
              payrollRunId: run.id,
              correctionId: session.id,
              revisionNumber: run.currentRevisionNumber,
            },
            tx,
          )
          const decisions = await tx.attendanceEmployeeDecision.findMany({
            where: { attendanceUploadId: session.attendanceUploadId },
            select: { employeeId: true, decision: true },
          })
          correctedRecords = buildAttendanceRecords(
            session.attendanceUploadId,
            review,
            decisions.map((d) => ({ employeeId: d.employeeId, decision: d.decision as 'APPROVED' | 'REJECTED' })),
          )
        }
      } else {
        // A draft made without a session still promotes under the week lock, so it cannot interleave
        // with a draft being written or with another promotion.
        await lockWeekRow(tx, { weekStart: run.payrollWeekStartDate })
      }

      // Only one caller can promote the draft (guards a double approve).
      const promoted = await tx.payrollRevision.updateMany({
        where: { id: revisionId, status: 'DRAFT' },
        data: { status: 'APPROVED', isCurrent: true, approvedAt: now },
      })
      if (promoted.count === 0) {
        throw new CorrectionServiceError('REVISION_NOT_DRAFT', 'Only a draft revision can be approved')
      }

      await tx.payrollRevision.updateMany({
        where: { payrollRunId: run.id, isCurrent: true, id: { not: revisionId } },
        data: { isCurrent: false, status: 'SUPERSEDED' },
      })

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          currentRevisionNumber: revision.revisionNumber,
          status: 'REVISED',
          totalRegularPay: revision.totalRegularPay,
          totalOvertimePay: revision.totalOvertimePay,
          totalAdditions: revision.totalAdditions,
          totalDeductions: revision.totalDeductions,
          totalNetPayable: revision.totalNetPayable,
        },
      })

      // An employee the new revision leaves out is not paid this week, so their adjustments move
      // to the next week instead of staying attached to this run. Skip them before the link step
      // below, which would otherwise point them at the new revision.
      const paid = await tx.payrollRunEmployee.findMany({
        where: { payrollRevisionId: revisionId },
        select: { employeeId: true },
      })
      const includedIds = paid.map((p) => p.employeeId)
      const leftOut = await tx.payrollAdjustmentApplication.findMany({
        where: {
          payrollWeekStartDate: run.payrollWeekStartDate,
          approvalStatus: { in: ['PENDING', 'APPROVED'] },
          employeeId: { notIn: includedIds },
          OR: [{ payrollRunId: run.id }, { payrollRunId: null }],
          payrollAdjustment: { status: { not: 'CANCELLED' } },
        },
        select: { id: true },
      })
      for (const application of leftOut) await skipAdjustmentApplication(application.id, tx)

      // Update adjustment applications to point to the new revision ID.
      // Also link any newly approved applications that weren't previously attached.
      await tx.payrollAdjustmentApplication.updateMany({
        where: {
          OR: [
            { payrollRunId: run.id },
            {
              payrollWeekStartDate: run.payrollWeekStartDate,
              approvalStatus: 'APPROVED',
              isReversed: false,
              payrollRunId: null,
            },
          ],
        },
        data: { payrollRunId: run.id, payrollRevisionId: revisionId },
      })

      if (session) {
        if (clonedPunches > 0) {
          // The corrected punches become the live set, and the attendance records follow them.
          await tx.attendanceRecord.deleteMany({ where: { attendanceUploadId: session.attendanceUploadId } })
          if (correctedRecords.length > 0) await tx.attendanceRecord.createMany({ data: correctedRecords })
          await tx.attendancePunch.deleteMany({
            where: { attendanceUploadId: session.attendanceUploadId, correctionId: null },
          })
          await tx.attendancePunch.updateMany({
            where: { correctionId: session.id },
            data: { correctionId: null, clonedFromPunchId: null },
          })
        }

        await tx.payrollCorrectionSession.update({
          where: { id: session.id },
          data: { status: 'APPLIED', appliedAt: now },
        })

        if (clonedPunches > 0) {
          await auditEntry(
            {
              actionType: 'UPDATE',
              entityType: 'ATTENDANCE_WEEK',
              entityId: session.attendanceUploadId,
              details: {
                summary: `Correction applied as revision ${revision.revisionNumber}`,
                correctionId: session.id,
                payrollRunId: run.id,
                revisionNumber: revision.revisionNumber,
                weekStart: toISODate(run.payrollWeekStartDate),
                weekEnd: toISODate(run.payrollWeekEndDate),
              },
            },
            tx,
          )
        }
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )

  return {
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    status: 'APPROVED',
    approvedAt: now,
  }
}

// ─── abandonCorrection ────────────────────────────────────────────────────────

/**
 * Punch edits in the copied set, compared with the approved punches they were copied from.
 * Pass the transaction client as `db` to read inside the caller's transaction.
 */
async function findDiscardedEdits(
  attendanceUploadId: string,
  correctionId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<DiscardedEdit[]> {
  const select = {
    id: true,
    clonedFromPunchId: true,
    punchDate: true,
    position: true,
    source: true,
    originalTime: true,
    currentTime: true,
    note: true,
    employee: { select: { employeeId: true } },
  } as const

  const clones = await db.attendancePunch.findMany({ where: { correctionId }, select })
  const live = await db.attendancePunch.findMany({ where: { attendanceUploadId, correctionId: null }, select })
  const liveById = new Map(live.map((row) => [row.id, row]))
  const copiedLiveIds = new Set(clones.map((row) => row.clonedFromPunchId).filter((id): id is string => !!id))

  const asPosition = (position: string): 'IN' | 'OUT' => (position === 'OUT' ? 'OUT' : 'IN')
  const edits: DiscardedEdit[] = []

  for (const clone of clones) {
    const source = clone.clonedFromPunchId ? liveById.get(clone.clonedFromPunchId) : undefined
    // Same time and note as the approved punch: not an edit.
    if (source && source.currentTime === clone.currentTime && source.note === clone.note) continue
    // A punch added in the correction and then deleted again leaves nothing to discard.
    if (!source && clone.currentTime === null) continue
    edits.push({
      punchId: clone.id,
      employeeCode: clone.employee?.employeeId ?? null,
      date: toISODate(clone.punchDate),
      position: asPosition(clone.position),
      original: source ? source.currentTime : null,
      current: clone.currentTime,
      note: clone.note,
    })
  }

  // A hand-entered approved punch that the correction removed is gone from the copy.
  for (const row of live) {
    if (copiedLiveIds.has(row.id)) continue
    edits.push({
      punchId: row.id,
      employeeCode: row.employee?.employeeId ?? null,
      date: toISODate(row.punchDate),
      position: asPosition(row.position),
      original: row.currentTime,
      current: null,
      note: row.note,
    })
  }

  return edits
}

/**
 * Throw the correction away: delete its copied punches and its draft revision, and put the
 * adjustment applications back as they were. The approved hours and the current revision are
 * never touched. The discarded punch edits stay in the audit log, marked by a DISCARD entry.
 *
 * Everything runs in one transaction that first locks the week's row and re-reads the session, so
 * an abandon cannot interleave with `approveRevision` (which promotes these copied punches) or a
 * punch edit: exactly one of the two ends the session.
 */
export async function abandonCorrection(payrollRunId: string): Promise<AbandonCorrectionResult> {
  const session = await requireActiveSession(payrollRunId)
  const now = new Date()

  return prisma.$transaction(
    async (tx) => {
      await lockWeekRow(tx, { id: session.attendanceUploadId })
      // The session was read before the lock; an approval may have applied it since.
      const current = await tx.payrollCorrectionSession.findUnique({ where: { id: session.id } })
      if (!current || current.status !== 'IN_PROGRESS') {
        throw new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress.')
      }

      // What is about to be thrown away, read after the lock so it matches what is deleted.
      const hadCopy = (await tx.attendancePunch.count({ where: { correctionId: session.id } })) > 0
      const edits = hadCopy ? await findDiscardedEdits(session.attendanceUploadId, session.id, tx) : []
      const snapshot = parseAdjustmentSnapshot(current.adjustmentSnapshotJson)

      await tx.attendancePunch.deleteMany({ where: { correctionId: session.id } })

      await tx.payrollRunEmployee.deleteMany({
        where: { payrollRunId, payrollRevision: { status: 'DRAFT' } },
      })
      await tx.payrollRevision.deleteMany({ where: { payrollRunId, status: 'DRAFT' } })

      for (const entry of snapshot) {
        await tx.payrollAdjustmentApplication.updateMany({
          where: { id: entry.applicationId },
          data: {
            approvalStatus: entry.approvalStatus,
            isReversed: entry.isReversed,
            approvedAt: entry.approvedAt ? new Date(entry.approvedAt) : null,
            skippedAt: entry.skippedAt ? new Date(entry.skippedAt) : null,
            appliedAt: entry.appliedAt ? new Date(entry.appliedAt) : null,
          },
        })
      }

      await tx.payrollCorrectionSession.update({
        where: { id: session.id },
        data: { status: 'ABANDONED', abandonedAt: now },
      })

      if (hadCopy) {
        await auditEntry(
          {
            actionType: 'DISCARD',
            entityType: 'ATTENDANCE_WEEK',
            entityId: session.attendanceUploadId,
            details: {
              summary: `Discarded correction: ${edits.length} punch edit(s)`,
              correctionId: session.id,
              payrollRunId,
              weekStart: toISODate(session.attendanceUpload.payrollWeekStartDate),
              discarded: { edits: edits.slice(0, MAX_AUDITED_EDITS) },
              edits: edits.slice(0, MAX_AUDITED_EDITS),
            },
          },
          tx,
        )
      }

      return { sessionId: session.id, discardedEdits: edits.length }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  )
}

// ─── getRevisionHistory ───────────────────────────────────────────────────────

export async function getRevisionHistory(
  payrollRunId: string,
): Promise<RevisionHistoryItem[]> {
  // A draft is work in progress, not history.
  const revisions = await prisma.payrollRevision.findMany({
    where: { payrollRunId, status: { not: 'DRAFT' } },
    orderBy: { revisionNumber: 'desc' },
  })

  return revisions.map((r) => ({
    revisionId: r.id,
    revisionNumber: r.revisionNumber,
    status: r.status as 'APPROVED' | 'SUPERSEDED',
    correctionReason: r.correctionReason,
    isCurrent: r.isCurrent,
    totalNetPayable: Number(r.totalNetPayable),
    totalRegularPay: Number(r.totalRegularPay),
    totalOvertimePay: Number(r.totalOvertimePay),
    totalAdditions: Number(r.totalAdditions),
    totalDeductions: Number(r.totalDeductions),
    approvedAt: r.approvedAt,
    generatedAt: r.generatedAt,
  }))
}

// ─── getRevisionEmployees ─────────────────────────────────────────────────────

const REVISION_EMPLOYEE_SELECT = {
  employeeId: true,
  employeeName: true,
  designation: true,
  designationShort: true,
  site: true,
  gPay: true,
  bankAccount: true,
} as const

/**
 * The employees of a revision, each with what they were paid in `previousRevisionId`.
 * Employees paid only in the previous revision are added as left-out rows (zero now),
 * and employees paid only in this one are marked new.
 */
export async function getRevisionEmployees(
  revisionId: string,
  previousRevisionId?: string,
): Promise<RevisedEmployeeRow[]> {
  const employees = await prisma.payrollRunEmployee.findMany({
    where: { payrollRevisionId: revisionId },
    include: { employee: { select: REVISION_EMPLOYEE_SELECT } },
    orderBy: { employee: { employeeId: 'asc' } },
  })

  // Load previous revision employees for diff if provided
  const prevEmployees = previousRevisionId
    ? await prisma.payrollRunEmployee.findMany({
        where: { payrollRevisionId: previousRevisionId },
        include: { employee: { select: REVISION_EMPLOYEE_SELECT } },
      })
    : []
  const prevByEmployee = new Map(prevEmployees.map((pe) => [pe.employeeId, pe]))

  const rows = employees.map((re): RevisedEmployeeRow => {
    const prev = prevByEmployee.get(re.employeeId)
    return {
      employeeId: re.employeeId,
      employeeCode: re.employee.employeeId,
      employeeName: re.employee.employeeName,
      designation: re.employee.designation,
      designationShort: re.employee.designationShort,
      site: re.employee.site,
      gPay: re.employee.gPay,
      bankAccount: re.employee.bankAccount,
      weeklySalaryUsed: Number(re.weeklySalaryUsed),
      hourlyRateUsed: Number(re.hourlyRateUsed),
      regularHours: Number(re.regularHours),
      overtimeHours: Number(re.overtimeHours),
      regularPay: Number(re.regularPay),
      overtimePay: Number(re.overtimePay),
      grossPay: Number(re.regularPay) + Number(re.overtimePay),
      additions: Number(re.additions),
      deductions: Number(re.deductions),
      netPayable: Number(re.netPayable),
      previousNetPayable: prev ? Number(prev.netPayable) : null,
      previousRegularPay: prev ? Number(prev.regularPay) : null,
      previousOvertimePay: prev ? Number(prev.overtimePay) : null,
      previousAdditions: prev ? Number(prev.additions) : null,
      previousDeductions: prev ? Number(prev.deductions) : null,
      isNew: !!previousRevisionId && !prev,
      isLeftOut: false,
    }
  })

  const present = new Set(employees.map((re) => re.employeeId))
  const leftOut = prevEmployees
    .filter((pe) => !present.has(pe.employeeId))
    .map((pe): RevisedEmployeeRow => ({
      employeeId: pe.employeeId,
      employeeCode: pe.employee.employeeId,
      employeeName: pe.employee.employeeName,
      designation: pe.employee.designation,
      designationShort: pe.employee.designationShort,
      site: pe.employee.site,
      gPay: pe.employee.gPay,
      bankAccount: pe.employee.bankAccount,
      weeklySalaryUsed: Number(pe.weeklySalaryUsed),
      hourlyRateUsed: Number(pe.hourlyRateUsed),
      regularHours: 0,
      overtimeHours: 0,
      regularPay: 0,
      overtimePay: 0,
      grossPay: 0,
      additions: 0,
      deductions: 0,
      netPayable: 0,
      previousNetPayable: Number(pe.netPayable),
      previousRegularPay: Number(pe.regularPay),
      previousOvertimePay: Number(pe.overtimePay),
      previousAdditions: Number(pe.additions),
      previousDeductions: Number(pe.deductions),
      isNew: false,
      isLeftOut: true,
    }))

  return [...rows, ...leftOut].sort((a, b) => (a.employeeCode < b.employeeCode ? -1 : a.employeeCode > b.employeeCode ? 1 : 0))
}
