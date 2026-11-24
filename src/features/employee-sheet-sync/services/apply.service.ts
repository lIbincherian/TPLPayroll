import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { computeHourlyRate } from '@/features/employee-management/utils/wage'
import { DATE_FIELDS } from '../lib/columns'
import { parseSheet } from '../lib/parser'
import { hashPlan, planSync } from '../lib/planner'
import {
  SheetSyncError,
  type ApplySheetSyncResult,
  type FieldValue,
  type SheetOwnedField,
  type SheetSourceMode,
  type SheetValues,
  type SyncPlan,
  type SyncReport,
  type SyncTrigger,
} from '../types/employee-sheet-sync.types'
import { loadEmployeeSnapshot } from './snapshot.service'

export const APPLY_TRANSACTION_TIMEOUT_MS = 60_000
export const APPLY_MAX_WAIT_MS = 20_000
const LOCK_KEY = 'employee-sheet-sync'

export interface ApplySyncInput {
  values: SheetValues
  tab: string
  mode: SheetSourceMode
  trigger: SyncTrigger
  /** The hash the person confirmed in the preview. null (scheduled runs) skips the check. */
  expectedHash: string | null
  /** UTC midnight of the run date. */
  today: Date
}

function toDbValue(field: SheetOwnedField, value: FieldValue | undefined): string | Date | null {
  if (value === null || value === undefined) return null
  return DATE_FIELDS.has(field) ? new Date(`${value}T00:00:00.000Z`) : value
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

/**
 * Writes the plan in one transaction. The transaction takes an advisory lock first, so a manual Apply and the
 * nightly run never overlap, then re-reads the app and re-plans: when a manual Apply no longer matches the
 * previewed plan, nothing is written and the new plan comes back as STALE. The sheet is fetched before this
 * is called, never inside the transaction.
 */
export async function applySyncPlan(input: ApplySyncInput): Promise<ApplySheetSyncResult> {
  // Pure and throws before any lock: a missing required header or an empty sheet fails the run here.
  const parsed = parseSheet(input.values)

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`

      const settings = await tx.settings.findUnique({ where: { id: 'singleton' } })
      if (!settings?.employeeSheetSyncEnabled) {
        throw new SheetSyncError('SYNC_DISABLED', 'The Employee Master sheet sync is turned off in Settings.')
      }

      const snapshot = await loadEmployeeSnapshot(tx)
      const plan = planSync(parsed, snapshot, input.today)
      const planHash = hashPlan(plan)
      const report = toReport(plan, input)

      if (input.expectedHash !== null && input.expectedHash !== planHash) {
        return { status: 'STALE', plan: report, planHash } as const
      }

      const run = await tx.employeeImportBatch.create({
        data: {
          fileName: input.tab,
          fileType: 'GOOGLE_SHEET',
          status: 'APPLIED',
          source: 'SHEET_SYNC',
          trigger: input.trigger,
          importedRowCount: plan.creates.length + plan.updates.length,
          createdEmployeeCount: plan.creates.length,
          updatedEmployeeCount: plan.updates.length,
          rejectedRowCount: plan.skips.length,
          report: toJson(report),
        },
      })

      await writeCreates(tx, plan, run.id)
      await writeUpdates(tx, plan, run.id)

      if (input.trigger === 'MANUAL' && settings.employeeSheetSyncFirstAppliedAt === null) {
        await tx.settings.update({
          where: { id: 'singleton' },
          data: { employeeSheetSyncFirstAppliedAt: new Date() },
        })
      }

      return { status: 'APPLIED', runId: run.id, report } as const
    },
    { timeout: APPLY_TRANSACTION_TIMEOUT_MS, maxWait: APPLY_MAX_WAIT_MS },
  )
}

export function toReport(
  plan: SyncPlan,
  context: { tab: string; mode: SheetSourceMode },
): SyncReport {
  return { ...plan, tab: context.tab, mode: context.mode, generatedAt: new Date().toISOString() }
}

async function writeCreates(tx: Prisma.TransactionClient, plan: SyncPlan, runId: string): Promise<void> {
  if (plan.creates.length === 0) return

  const prepared = plan.creates.map((create) => {
    const data: Record<string, unknown> = {
      id: randomUUID(),
      employeeId: create.employeeId,
      serialNumber: create.serialNumber,
      isActive: create.isActive,
      employeeImportBatchId: runId,
    }
    for (const [field, value] of Object.entries(create.fields) as Array<[SheetOwnedField, FieldValue]>) {
      data[field] = toDbValue(field, value)
    }
    return { create, data, hourlyRate: computeHourlyRate(create.salary) }
  })

  await tx.employee.createMany({ data: prepared.map((p) => p.data) as Prisma.EmployeeCreateManyInput[] })

  await tx.employeeWageHistory.createMany({
    data: prepared.map((p) => ({
      employeeId: p.data.id as string,
      weeklySalary: p.create.salary,
      hourlyRate: p.hourlyRate,
      effectiveFrom: new Date(`${p.create.wageEffectiveFrom}T00:00:00.000Z`),
      effectiveTo: null,
      changeSource: 'SHEET_SYNC',
      employeeImportBatchId: runId,
    })),
  })

  await tx.auditLog.createMany({
    data: prepared.map((p) => ({
      actionType: 'CREATE',
      entityType: 'EMPLOYEE',
      entityId: p.data.id as string,
      detailsJson: toJson({
        changeSource: 'SHEET_SYNC',
        runId,
        employeeId: p.create.employeeId,
        fields: p.create.fields,
        salary: p.create.salary,
        hourlyRate: p.hourlyRate,
      }),
    })),
  })
}

async function writeUpdates(tx: Prisma.TransactionClient, plan: SyncPlan, runId: string): Promise<void> {
  if (plan.updates.length === 0) return

  for (const update of plan.updates) {
    const data: Record<string, unknown> = {}
    for (const change of update.changes) data[change.field] = toDbValue(change.field, change.new)
    await tx.employee.update({ where: { id: update.employeeDbId }, data: data as Prisma.EmployeeUpdateInput })
  }

  await tx.auditLog.createMany({
    data: plan.updates.map((update) => ({
      actionType: 'UPDATE',
      entityType: 'EMPLOYEE',
      entityId: update.employeeDbId,
      detailsJson: toJson({ changeSource: 'SHEET_SYNC', runId, changes: update.changes }),
    })),
  })
}
