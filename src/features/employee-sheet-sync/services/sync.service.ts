import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { isEmployeeSheetSyncEnabled } from '@/features/settings/services/settings.service'
import { toUtcMidnight } from '@/features/employee-management/lib/wage-effective-from'
import { parseSheet } from '../lib/parser'
import { hashPlan, planSync } from '../lib/planner'
import {
  SheetSyncError,
  type ApplySheetSyncResult,
  type LastSheetSync,
  type PlannedSkip,
  type ScheduledSheetSyncOutcome,
  type SheetSyncPreview,
  type SyncReport,
  type SyncTrigger,
} from '../types/employee-sheet-sync.types'
import { applySyncPlan, toReport } from './apply.service'
import { loadEmployeeSnapshot } from './snapshot.service'
import { fetchEmployeeSheet, getSheetSourceConfig } from './sheet.client'

const UNEXPECTED_MESSAGE = 'The sync failed and nothing was changed.'

async function readSettings() {
  return prisma.settings.findUnique({ where: { id: 'singleton' } })
}

// ─── Failed runs ──────────────────────────────────────────────────────────────

/** Saves a FAILED run outside any transaction. Never throws: the original error is the one that matters. */
export async function recordFailedRun(trigger: SyncTrigger, error: unknown): Promise<void> {
  const code = error instanceof SheetSyncError ? error.code : 'UNEXPECTED'
  const message = error instanceof SheetSyncError ? error.message : UNEXPECTED_MESSAGE
  try {
    await prisma.employeeImportBatch.create({
      data: {
        fileName: getSheetSourceConfig().tab,
        fileType: 'GOOGLE_SHEET',
        status: 'FAILED',
        source: 'SHEET_SYNC',
        trigger,
        report: { error: code, message } as Prisma.InputJsonValue,
      },
    })
  } catch (saveError) {
    console.error('[EmployeeSheetSync] Could not save the failed run:', saveError)
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/** Reads the sheet and the app and returns the plan Apply would write. Writes nothing and saves no run. */
export async function previewSheetSync(): Promise<SheetSyncPreview> {
  if (!(await isEmployeeSheetSyncEnabled())) {
    throw new SheetSyncError('SYNC_DISABLED', 'The Employee Master sheet sync is turned off in Settings.')
  }

  // A failed preview is shown to the person and not saved: only Apply and the nightly run leave a record.
  const sheet = await fetchEmployeeSheet()
  const parsed = parseSheet(sheet.values)
  const snapshot = await loadEmployeeSnapshot()
  const plan = planSync(parsed, snapshot, toUtcMidnight(new Date()))
  const report: SyncReport = toReport(plan, { tab: sheet.tab, mode: sheet.mode })
  return { plan: report, planHash: hashPlan(plan) }
}

// ─── Apply ────────────────────────────────────────────────────────────────────

async function fetchAndApply(trigger: SyncTrigger, expectedHash: string | null): Promise<ApplySheetSyncResult> {
  try {
    const sheet = await fetchEmployeeSheet()
    return await applySyncPlan({
      values: sheet.values,
      tab: sheet.tab,
      mode: sheet.mode,
      trigger,
      expectedHash,
      today: toUtcMidnight(new Date()),
    })
  } catch (error) {
    // A turned-off sync is not a failed run: nothing was attempted.
    if (!(error instanceof SheetSyncError && error.code === 'SYNC_DISABLED')) {
      await recordFailedRun(trigger, error)
    }
    throw error
  }
}

/** Manual Apply. A STALE result means the sheet or the app changed since the preview and nothing was written. */
export async function applySheetSync(planHash: string): Promise<ApplySheetSyncResult> {
  return fetchAndApply('MANUAL', planHash)
}

// ─── Scheduled run ────────────────────────────────────────────────────────────

/** Nightly run: does nothing until the sync is on and the first manual Apply has succeeded. */
export async function runScheduledSheetSync(): Promise<ScheduledSheetSyncOutcome> {
  const settings = await readSettings()
  if (!settings?.employeeSheetSyncEnabled) return { skipped: 'DISABLED' }
  if (!settings.employeeSheetSyncFirstAppliedAt) return { skipped: 'NOT_FIRST_APPLIED' }

  const result = await fetchAndApply('SCHEDULED', null)
  if (result.status === 'STALE') {
    // Unreachable without a hash to compare, but fail closed rather than report a write that did not happen.
    throw new SheetSyncError('STALE_PLAN', 'The sync plan changed while it ran. Nothing was written.')
  }
  return {
    runId: result.runId,
    created: result.report.creates.length,
    updated: result.report.updates.length,
    skipped: result.report.skips.length,
  }
}

// ─── Last run ─────────────────────────────────────────────────────────────────

function reportOf(value: unknown): Partial<SyncReport> & { error?: string; message?: string } {
  return value && typeof value === 'object' ? (value as Partial<SyncReport> & { error?: string; message?: string }) : {}
}

export async function getLastSheetSync(): Promise<LastSheetSync | null> {
  const run = await prisma.employeeImportBatch.findFirst({
    where: { source: 'SHEET_SYNC' },
    orderBy: { importedAt: 'desc' },
  })
  if (!run) return null

  const report = reportOf(run.report)
  const failed = run.status === 'FAILED'
  const skips: PlannedSkip[] = failed ? [] : (report.skips ?? [])
  return {
    runId: run.id,
    at: run.importedAt.toISOString(),
    trigger: run.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL',
    status: failed ? 'FAILED' : 'APPLIED',
    created: run.createdEmployeeCount,
    updated: run.updatedEmployeeCount,
    skipped: run.rejectedRowCount,
    warnings: failed ? 0 : (report.warnings?.length ?? 0),
    skips,
    ...(failed ? { error: report.message ?? 'The sync failed.' } : {}),
  }
}
