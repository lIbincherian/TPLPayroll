'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  AttendanceSyncError,
  type ActionResult,
  type ApprovalSummary,
  type StatusChangeSummary,
  type AttendanceWeekListItem,
  type DayValidation,
  type EmployeeCheck,
  type EmployeeDecisionValue,
  type IgnoreScope,
  type ISODate,
  type PunchReview,
  type ReviewMode,
  type SavePunchEditInput,
  type SavePunchEditResult,
  type SyncOutcome,
  type UnignoreCodeResult,
} from '../types/attendance-sync.types'
import {
  getEmployeeCheck,
  ignoreCode,
  matchCodeToEmployee,
  rematchWeekCodes,
  setEmployeeDecision,
  unignoreCode,
} from '../services/employee-check.service'
import { getPunchReview, savePunchEdit } from '../services/punch-review.service'
import { getPullWarning, pullNow } from '../services/sync.service'
import { approveWeek, getApprovalSummary, reopenWeek } from '../services/week-approval.service'
import { listAttendanceWeeks } from '../services/week-list.service'

// ─── Action result wrapper ────────────────────────────────────────────────────

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}

function err(error: string, code?: string, validation?: DayValidation): ActionResult<never> {
  return { ok: false, error, code, ...(validation ? { validation } : {}) }
}

function handleError(e: unknown): ActionResult<never> {
  if (e instanceof AttendanceSyncError) {
    const validation =
      e.code === 'VALIDATION_ERROR' && (e.details as DayValidation | undefined)?.valid === false
        ? (e.details as DayValidation)
        : undefined
    return err(e.message, e.code, validation)
  }
  console.error('[AttendanceSyncAction]', e)
  return err('An unexpected error occurred')
}

function revalidateAttendance(): void {
  revalidatePath('/attendance')
  revalidatePath('/payroll')
}

// ─── Input validation (server actions are public endpoints) ──────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const id = z.string().min(1).max(100)

const reviewModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LIVE') }),
  z.object({
    kind: z.literal('CORRECTION'),
    payrollRunId: id,
    correctionId: id,
    revisionNumber: z.number().int(),
  }),
])

const punchSideSchema = z.object({
  punchId: id.optional(),
  time: z.string().max(10).nullable(),
  note: z.string().max(1000).nullish(),
})

const savePunchEditSchema = z.object({
  weekId: isoDate,
  employeeId: id,
  date: isoDate,
  mode: reviewModeSchema,
  baseSignature: z.string().min(1).max(64),
  pairs: z
    .array(z.object({ pairIndex: z.number().int().min(0).max(1000), in: punchSideSchema, out: punchSideSchema }))
    .max(100),
})

const ignoreScopeSchema = z.enum(['WEEK', 'ALWAYS'])

const invalid = () => err('The request was not valid.', 'VALIDATION_ERROR')

// ─── Week list and pulling ────────────────────────────────────────────────────

export async function getAttendanceWeeksAction(): Promise<ActionResult<AttendanceWeekListItem[]>> {
  try {
    return ok(await listAttendanceWeeks())
  } catch (e) {
    return handleError(e)
  }
}

export async function getPullWarningAction(
  weekStart: ISODate,
): Promise<ActionResult<{ hasData: boolean; editedDays: number; decisions: number; ignoredCodes: number }>> {
  if (!isoDate.safeParse(weekStart).success) return invalid()
  try {
    return ok(await getPullWarning(weekStart))
  } catch (e) {
    return handleError(e)
  }
}

export async function pullWeekAction(weekStart: ISODate): Promise<ActionResult<SyncOutcome>> {
  if (!isoDate.safeParse(weekStart).success) return invalid()
  try {
    const outcome = await pullNow(weekStart)
    revalidateAttendance()
    return ok(outcome)
  } catch (e) {
    return handleError(e)
  }
}

// ─── Employee check ───────────────────────────────────────────────────────────

export async function getEmployeeCheckAction(weekId: ISODate): Promise<ActionResult<EmployeeCheck>> {
  if (!isoDate.safeParse(weekId).success) return invalid()
  try {
    return ok(await getEmployeeCheck(weekId))
  } catch (e) {
    return handleError(e)
  }
}

export async function rematchWeekCodesAction(
  weekId: ISODate,
): Promise<
  ActionResult<{ matched: Array<{ empCode: string; employeeId: string; employeeCode: string }>; stillUnresolved: string[] }>
> {
  if (!isoDate.safeParse(weekId).success) return invalid()
  try {
    return ok(await rematchWeekCodes(weekId))
  } catch (e) {
    return handleError(e)
  }
}

export async function matchCodeAction(
  weekId: ISODate,
  empCode: string,
  employeeId: string,
): Promise<ActionResult<{ linkedPunches: number }>> {
  if (!isoDate.safeParse(weekId).success || !id.safeParse(empCode).success || !id.safeParse(employeeId).success) {
    return invalid()
  }
  try {
    const result = await matchCodeToEmployee(weekId, empCode, employeeId)
    revalidateAttendance()
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

/** Ignore a code for this week only (`WEEK`) or for every week (`ALWAYS`, saved for future pulls). */
export async function ignoreCodeAction(
  weekId: ISODate,
  empCode: string,
  scope: IgnoreScope,
): Promise<ActionResult<{ ignoredPunches: number }>> {
  const parsedScope = ignoreScopeSchema.safeParse(scope)
  if (!isoDate.safeParse(weekId).success || !id.safeParse(empCode).success || !parsedScope.success) return invalid()
  try {
    const result = await ignoreCode(weekId, empCode, parsedScope.data)
    revalidateAttendance()
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

/** Stop ignoring a code in this week, and, if it was ignored for every week, in future pulls too. */
export async function unignoreCodeAction(
  weekId: ISODate,
  empCode: string,
): Promise<ActionResult<UnignoreCodeResult>> {
  if (!isoDate.safeParse(weekId).success || !id.safeParse(empCode).success) return invalid()
  try {
    const result = await unignoreCode(weekId, empCode)
    revalidateAttendance()
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

export async function setEmployeeDecisionAction(
  weekId: ISODate,
  employeeId: string,
  decision: EmployeeDecisionValue,
): Promise<ActionResult<{ decision: EmployeeDecisionValue }>> {
  if (
    !isoDate.safeParse(weekId).success ||
    !id.safeParse(employeeId).success ||
    (decision !== 'APPROVED' && decision !== 'REJECTED')
  ) {
    return invalid()
  }
  try {
    const result = await setEmployeeDecision(weekId, employeeId, decision)
    revalidateAttendance()
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── Punch review ─────────────────────────────────────────────────────────────

export async function getPunchReviewAction(
  weekId: ISODate,
  mode: ReviewMode = { kind: 'LIVE' },
): Promise<ActionResult<PunchReview>> {
  const parsedMode = reviewModeSchema.safeParse(mode)
  if (!isoDate.safeParse(weekId).success || !parsedMode.success) return invalid()
  try {
    return ok(await getPunchReview(weekId, parsedMode.data))
  } catch (e) {
    return handleError(e)
  }
}

export async function savePunchEditAction(input: SavePunchEditInput): Promise<ActionResult<SavePunchEditResult>> {
  const parsed = savePunchEditSchema.safeParse(input)
  if (!parsed.success) return invalid()
  try {
    return ok(await savePunchEdit(parsed.data))
  } catch (e) {
    return handleError(e)
  }
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export async function getApprovalSummaryAction(
  weekId: ISODate,
  mode: ReviewMode = { kind: 'LIVE' },
): Promise<ActionResult<ApprovalSummary>> {
  const parsedMode = reviewModeSchema.safeParse(mode)
  if (!isoDate.safeParse(weekId).success || !parsedMode.success) return invalid()
  try {
    return ok(await getApprovalSummary(weekId, parsedMode.data))
  } catch (e) {
    return handleError(e)
  }
}

export async function approveWeekAction(
  weekId: ISODate,
): Promise<ActionResult<{ approvedAt: string; summary: ApprovalSummary; statusChanges: StatusChangeSummary }>> {
  if (!isoDate.safeParse(weekId).success) return invalid()
  try {
    const { approvedAt, summary, statusChanges } = await approveWeek(weekId)
    revalidateAttendance()
    return ok({ approvedAt: approvedAt.toISOString(), summary, statusChanges })
  } catch (e) {
    return handleError(e)
  }
}

export async function reopenWeekAction(weekId: ISODate): Promise<ActionResult<{ reopenedAt: string }>> {
  if (!isoDate.safeParse(weekId).success) return invalid()
  try {
    const { reopenedAt } = await reopenWeek(weekId)
    revalidateAttendance()
    return ok({ reopenedAt: reopenedAt.toISOString() })
  } catch (e) {
    return handleError(e)
  }
}
