import { IST_TIME_ZONE, PAYROLL_WEEK_START_DOW } from './constants'
import type { ISODate, WeekRange } from '../types/attendance-sync.types'

// All "today" logic uses IST; all stored dates are UTC midnight built from ISO
// strings. Never use local-timezone getters for week math.

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const WEDNESDAY_DOW = (PAYROLL_WEEK_START_DOW + 6) % 7

const istFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function todayInIST(now: Date = new Date()): ISODate {
  const parts = istFormatter.formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function toUtcDate(iso: ISODate): Date {
  return new Date(`${iso}T00:00:00Z`)
}

export function toISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10)
}

export function addDaysISO(iso: ISODate, days: number): ISODate {
  const date = toUtcDate(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return toISODate(date)
}

function dayOfWeek(iso: ISODate): number {
  return toUtcDate(iso).getUTCDay()
}

function isValidISODate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && toISODate(date) === value
}

export function isThursdayISO(iso: ISODate): boolean {
  return isValidISODate(iso) && dayOfWeek(iso) === PAYROLL_WEEK_START_DOW
}

export function weekFromStartISO(start: ISODate): WeekRange {
  return { start, end: addDaysISO(start, 6) }
}

/** The Thu–Wed week that ended yesterday (IST). */
export function getCompletedPayrollWeek(now: Date): WeekRange {
  const yesterday = addDaysISO(todayInIST(now), -1)
  const daysSinceWednesday = (dayOfWeek(yesterday) - WEDNESDAY_DOW + 7) % 7
  const end = addDaysISO(yesterday, -daysSinceWednesday)
  return { start: addDaysISO(end, -6), end }
}

/** The Thu–Wed week that contains `today`. */
export function getCurrentPayrollWeek(today: ISODate): WeekRange {
  const daysSinceThursday = (dayOfWeek(today) - PAYROLL_WEEK_START_DOW + 7) % 7
  return weekFromStartISO(addDaysISO(today, -daysSinceThursday))
}

/** The `weekId` route param is the Thursday, `YYYY-MM-DD`. Anything else is null. */
export function parseWeekId(weekId: string): WeekRange | null {
  if (!isThursdayISO(weekId)) return null
  return weekFromStartISO(weekId)
}

export function hasWeekEnded(week: WeekRange, today: ISODate): boolean {
  return today > week.end
}

export function isFutureWeek(week: WeekRange, today: ISODate): boolean {
  return week.start > today
}

/** The seven dates of the week, Thursday first. */
export function getWeekDates(week: WeekRange): ISODate[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(week.start, i))
}

export function formatWeekLabel(week: WeekRange): string {
  const startYear = week.start.slice(0, 4)
  const endYear = week.end.slice(0, 4)
  const withYear: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }
  const withoutYear: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' }
  const start = toUtcDate(week.start).toLocaleDateString('en-GB', startYear === endYear ? withoutYear : withYear)
  const end = toUtcDate(week.end).toLocaleDateString('en-GB', withYear)
  return `${start} – ${end}`
}

/** ISO 8601 week-year and week number of a date (weeks start Monday; week 1 holds the first Thursday). */
export function isoWeekOf(iso: ISODate): { year: number; week: number } {
  const date = toUtcDate(iso)
  const isoDow = date.getUTCDay() || 7
  // The Thursday of the same ISO week decides its year.
  date.setUTCDate(date.getUTCDate() + 4 - isoDow)
  const year = date.getUTCFullYear()
  const dayOfYear = Math.round((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000)
  return { year, week: Math.floor(dayOfYear / 7) + 1 }
}

/** `YYYY-WW-<EMP ID>`: the ISO week of the payroll week start, then the Emp ID. */
export function paymentReference(weekStart: ISODate, employeeId: string): string {
  const { year, week } = isoWeekOf(weekStart)
  return `${year}-${String(week).padStart(2, '0')}-${employeeId}`
}
