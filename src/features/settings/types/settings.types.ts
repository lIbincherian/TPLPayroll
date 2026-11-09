import { z } from 'zod'

export const DAYS_OF_WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
export type DayOfWeek = typeof DAYS_OF_WEEK[number]

/** The payroll week always runs Thursday to Wednesday, matching the eTimeOffice sync. */
export const LOCKED_PAYROLL_WEEK_START_DAY: DayOfWeek = 'THURSDAY'

export const UpdateSettingsSchema = z.object({
  payrollWeekStartDay: z.enum(DAYS_OF_WEEK),
})

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>

export interface AppSettings {
  payrollWeekStartDay: DayOfWeek
  currency: 'INR'
  docExpiryThresholdDays: 7
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
