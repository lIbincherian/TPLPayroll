// The first wage-history row of a new employee (onboarding or import) starts on this date, so
// payroll for earlier weeks finds a wage. Stored dates are UTC midnight.

export const MAX_WAGE_EFFECTIVE_DAYS_AHEAD = 7
export const WAGE_EFFECTIVE_TOO_FAR_AHEAD = "Wage effective date can't be more than one week in the future."

const DAY_MS = 24 * 60 * 60 * 1000

export function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/** Explicit date, else the date of joining, else the 1st of the current month, at UTC midnight. */
export function resolveInitialWageEffectiveFrom(
  explicit?: Date | null,
  dateOfJoining?: Date | null,
  now: Date = new Date(),
): Date {
  if (explicit) return toUtcMidnight(explicit)
  if (dateOfJoining) return toUtcMidnight(dateOfJoining)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** True when the date is more than 7 days after today (compared as UTC dates). */
export function isWageEffectiveTooFarAhead(date: Date, now: Date = new Date()): boolean {
  const limit = toUtcMidnight(now).getTime() + MAX_WAGE_EFFECTIVE_DAYS_AHEAD * DAY_MS
  return toUtcMidnight(date).getTime() > limit
}
