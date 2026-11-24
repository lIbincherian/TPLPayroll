import { z } from 'zod'

export const DAYS_OF_WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
export type DayOfWeek = typeof DAYS_OF_WEEK[number]

/** The payroll week always runs Thursday to Wednesday, matching the eTimeOffice sync. */
export const LOCKED_PAYROLL_WEEK_START_DAY: DayOfWeek = 'THURSDAY'

export const UpdateSettingsSchema = z.object({
  payrollWeekStartDay: z.enum(DAYS_OF_WEEK).optional(),
  /** F13: the temporary Employee Master sheet sync. */
  employeeSheetSyncEnabled: z.boolean().optional(),
}).refine((v) => v.payrollWeekStartDay !== undefined || v.employeeSheetSyncEnabled !== undefined, {
  message: 'No setting was given',
})

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>

export interface AppSettings {
  payrollWeekStartDay: DayOfWeek
  currency: 'INR'
  docExpiryThresholdDays: 7
  employeeSheetSyncEnabled: boolean
  /** ISO time of the first successful manual Apply, which unlocks the nightly sync; null until then. */
  employeeSheetSyncFirstAppliedAt: string | null
}

export class SettingsServiceError extends Error {
  constructor(
    public readonly code: 'VALIDATION_ERROR' | 'INVALID_DAY' | 'WEEK_START_LOCKED',
    message: string,
  ) {
    super(message)
    this.name = 'SettingsServiceError'
  }
}
