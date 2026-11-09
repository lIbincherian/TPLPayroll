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

function toAppSettings(payrollWeekStartDay: string): AppSettings {
  return {
    payrollWeekStartDay: payrollWeekStartDay as DayOfWeek,
    currency: 'INR',
    docExpiryThresholdDays: 7,
  }
}

// ─── getSettings ──────────────────────────────────────────────────────────────

// The payroll week start is locked to Thursday (F12). A stored value that is
// anything else is changed to Thursday the first time settings are read.
export async function getSettings(): Promise<AppSettings> {
  const record = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: { payrollWeekStartDay: LOCKED_PAYROLL_WEEK_START_DAY },
    create: { id: 'singleton' },
  })

  return toAppSettings(record.payrollWeekStartDay)
}

// ─── updateSettings ───────────────────────────────────────────────────────────

// The only editable setting was the week start day, and it is now locked. Any
// request to change it is rejected without a database write. A request for
// Thursday is a no-op that returns the current settings.
export async function updateSettings(input: UpdateSettingsInput): Promise<AppSettings> {
  const parsed = UpdateSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues?.[0]
    throw new SettingsServiceError('VALIDATION_ERROR', first?.message ?? 'Invalid settings data')
  }

  if (parsed.data.payrollWeekStartDay !== LOCKED_PAYROLL_WEEK_START_DAY) {
    throw new SettingsServiceError(
      'WEEK_START_LOCKED',
      'The payroll week start is locked to Thursday and cannot be changed.',
    )
  }

  return getSettings()
}
