'use server'

import {
  initiateCorrection,
  reverseAdjustmentApplication,
  approveSkippedAdjustment,
  approveAdjustmentInCorrection,
  skipAdjustmentInCorrection,
  recalculateAndCreateRevision,
  approveRevision,
  getRevisionHistory,
  getRevisionEmployees,
  beginCorrection,
  startAttendanceCorrection,
  approveCorrectionPunches,
  abandonCorrection,
} from '@/features/payroll-correction/services/correction.service'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import type {
  InitiateCorrectionResult,
  CreateRevisionInput,
  CreateRevisionResult,
  RevisionHistoryItem,
  ApproveRevisionResult,
  RevisedEmployeeRow,
  StartAttendanceCorrectionInput,
  AbandonCorrectionResult,
} from '@/features/payroll-correction/types/correction.types'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'
import { AdjustmentServiceError } from '@/features/payroll-adjustments/types/adjustment.types'
import { redirect } from 'next/navigation'

// ─── Action result wrapper ────────────────────────────────────────────────────

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}

function err(error: string, code?: string): ActionResult<never> {
  return { ok: false, error, code }
}

function handleError(e: unknown): ActionResult<never> {
  if (e instanceof CorrectionServiceError) return err(e.message, e.code)
  if (e instanceof AttendanceSyncError) return err(e.message, e.code)
  if (e instanceof AdjustmentServiceError) return err(e.message, e.code)
  console.error('[CorrectionAction]', e)
  return err('An unexpected error occurred')
}

// ─── beginPayrollCorrectionAction ─────────────────────────────────────────────

export async function beginPayrollCorrectionAction(payrollRunId: string): Promise<void> {
  // Opens a correction session (or resumes the one in progress) and performs the reset mutation
  await beginCorrection(payrollRunId)

  // Trigger redirect to the interactive correction flow
  redirect(`/payroll/run/${payrollRunId}/correct`)
}

// ─── startAttendanceCorrectionAction ──────────────────────────────────────────

/** Saves the reason and types, copies the approved punches, then opens the punches page. */
export async function startAttendanceCorrectionAction(
  payrollRunId: string,
  input: StartAttendanceCorrectionInput,
): Promise<ActionResult<{ sessionId: string }>> {
  try {
    await startAttendanceCorrection(payrollRunId, input)
  } catch (e) {
    return handleError(e)
  }
  // Outside the try block: redirect() works by throwing.
  redirect(`/payroll/run/${payrollRunId}/correct/punches`)
}

// ─── approveCorrectionPunchesAction ───────────────────────────────────────────

/** "Approve punches": builds the draft revision from the corrected punches, then opens the preview. */
export async function approveCorrectionPunchesAction(
  payrollRunId: string,
): Promise<ActionResult<CreateRevisionResult>> {
  try {
    await approveCorrectionPunches(payrollRunId)
  } catch (e) {
    return handleError(e)
  }
  redirect(`/payroll/run/${payrollRunId}/correct/preview`)
}

// ─── abandonCorrectionAction ──────────────────────────────────────────────────

export async function abandonCorrectionAction(
  payrollRunId: string,
): Promise<ActionResult<AbandonCorrectionResult>> {
  try {
    const result = await abandonCorrection(payrollRunId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── initiateCorrectionAction ─────────────────────────────────────────────────

export async function initiateCorrectionAction(
  payrollRunId: string,
): Promise<ActionResult<InitiateCorrectionResult>> {
  try {
    const result = await initiateCorrection(payrollRunId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── reverseAdjustmentAction ──────────────────────────────────────────────────

export async function reverseAdjustmentAction(
  applicationId: string,
): Promise<ActionResult<{ applicationId: string; isReversed: true }>> {
  try {
    const result = await reverseAdjustmentApplication(applicationId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── approveSkippedAdjustmentAction ───────────────────────────────────────────

export async function approveSkippedAdjustmentAction(
  applicationId: string,
): Promise<ActionResult<{ applicationId: string; approvalStatus: 'APPROVED' }>> {
  try {
    const result = await approveSkippedAdjustment(applicationId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── approveAdjustmentInCorrectionAction ──────────────────────────────────────

export async function approveAdjustmentInCorrectionAction(
  applicationId: string,
): Promise<ActionResult<{ applicationId: string; approvalStatus: 'APPROVED' }>> {
  try {
    const result = await approveAdjustmentInCorrection(applicationId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── skipAdjustmentInCorrectionAction ─────────────────────────────────────────

export async function skipAdjustmentInCorrectionAction(
  applicationId: string,
): Promise<ActionResult<{ applicationId: string; approvalStatus: 'SKIPPED' }>> {
  try {
    const result = await skipAdjustmentInCorrection(applicationId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── recalculateAndCreateRevisionAction ───────────────────────────────────────

export async function recalculateAndCreateRevisionAction(
  input: CreateRevisionInput,
): Promise<ActionResult<CreateRevisionResult>> {
  try {
    const result = await recalculateAndCreateRevision(input)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── approveRevisionAction ────────────────────────────────────────────────────

export async function approveRevisionAction(
  revisionId: string,
): Promise<ActionResult<ApproveRevisionResult>> {
  try {
    const result = await approveRevision(revisionId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── getRevisionHistoryAction ─────────────────────────────────────────────────

export async function getRevisionHistoryAction(
  payrollRunId: string,
): Promise<ActionResult<RevisionHistoryItem[]>> {
  try {
    const result = await getRevisionHistory(payrollRunId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

// ─── getRevisionEmployeesAction ───────────────────────────────────────────────

export async function getRevisionEmployeesAction(
  revisionId: string,
  previousRevisionId?: string,
): Promise<ActionResult<RevisedEmployeeRow[]>> {
  try {
    const result = await getRevisionEmployees(revisionId, previousRevisionId)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}
