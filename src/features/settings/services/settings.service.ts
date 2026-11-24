import prisma from '@/lib/prisma'
import {
  UpdateSettingsSchema,
  SettingsServiceError,
  LOCKED_PAYROLL_WEEK_START_DAY,
  type AppSettings,
  type UpdateSettingsInput,
  type DayOfWeek,
} from '@/features/settings/types/settings.types'

// ─── Helper ───────────────────────────────────────────────────────────────────

function toAppSettings(record: {
  payrollWeekStartDay: string
  employeeSheetSyncEnabled?: boolean | null
  employeeSheetSyncFirstAppliedAt?: Date | null
}): AppSettings {
  return {
    payrollWeekStartDay: record.payrollWeekStartDay as DayOfWeek,
    currency: 'INR',
    docExpiryThresholdDays: 7,
    employeeSheetSyncEnabled: record.employeeSheetSyncEnabled === true,
    employeeSheetSyncFirstAppliedAt: record.employeeSheetSyncFirstAppliedAt?.toISOString() ?? null,
  }
}

// ─── getSettings ──────────────────────────────────────────────────────────────

// The payroll week start is locked to Thursday (F12). A stored value that is
// anything else is changed to Thursday the first time settings are read. A read that
// finds Thursday writes nothing (the row's updatedAt stays as it was).
export async function getSettings(): Promise<AppSettings> {
  const stored = await prisma.settings.findUnique({ where: { id: 'singleton' } })
  if (stored?.payrollWeekStartDay === LOCKED_PAYROLL_WEEK_START_DAY) {
    return toAppSettings(stored)
  }

  // No row yet, or one that is not Thursday: create it, or change it to Thursday.
  const record = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: { payrollWeekStartDay: LOCKED_PAYROLL_WEEK_START_DAY },
    create: { id: 'singleton' },
  })

  return toAppSettings(record)
}

// ─── isEmployeeSheetSyncEnabled ───────────────────────────────────────────────

/** Read-only: never creates the settings row. No row means the sync is off. */
export async function isEmployeeSheetSyncEnabled(): Promise<boolean> {
  const stored = await prisma.settings.findUnique({ where: { id: 'singleton' } })
  return stored?.employeeSheetSyncEnabled === true
}

/** Read-only: the sheet sync switch and whether the first manual Apply has happened. */
export async function getEmployeeSheetSyncState(): Promise<{ enabled: boolean; firstApplied: boolean }> {
  const stored = await prisma.settings.findUnique({ where: { id: 'singleton' } })
  return {
    enabled: stored?.employeeSheetSyncEnabled === true,
    firstApplied: stored?.employeeSheetSyncFirstAppliedAt != null,
  }
}

// ─── updateSettings ───────────────────────────────────────────────────────────

// The payroll week start is locked to Thursday, so any request to change it is rejected without a
// database write. The one editable setting is the Employee Master sheet sync switch (F13).
export async function updateSettings(input: UpdateSettingsInput): Promise<AppSettings> {
  const parsed = UpdateSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues?.[0]
    throw new SettingsServiceError('VALIDATION_ERROR', first?.message ?? 'Invalid settings data')
  }

  if (
    parsed.data.payrollWeekStartDay !== undefined &&
    parsed.data.payrollWeekStartDay !== LOCKED_PAYROLL_WEEK_START_DAY
  ) {
    throw new SettingsServiceError(
      'WEEK_START_LOCKED',
      'The payroll week start is locked to Thursday and cannot be changed.',
    )
  }

  if (parsed.data.employeeSheetSyncEnabled !== undefined) {
    const record = await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {
        payrollWeekStartDay: LOCKED_PAYROLL_WEEK_START_DAY,
        employeeSheetSyncEnabled: parsed.data.employeeSheetSyncEnabled,
      },
      create: { id: 'singleton', employeeSheetSyncEnabled: parsed.data.employeeSheetSyncEnabled },
    })
    return toAppSettings(record)
  }

  return getSettings()
}
