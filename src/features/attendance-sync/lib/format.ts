import { IST_TIME_ZONE } from './constants'
import type { ISODate } from '../types/attendance-sync.types'

// Display formatting shared by the attendance screens. Times shown to the user are IST;
// dates built from ISO strings are formatted in UTC so they never shift a day.

const timeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dateTimeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dateTimeYearParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dayParts = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const groupedHours = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? ''
}

/** Hours always show two decimals. */
export function formatHours(hours: number): string {
  return hours.toFixed(2)
}

/** Two decimals with thousands separators, for totals ("4,512.50"). */
export function formatHoursTotal(hours: number): string {
  return groupedHours.format(hours)
}

/** "10:42" in IST. */
export function formatIstTime(iso: string): string {
  const parts = timeParts.formatToParts(new Date(iso))
  return `${part(parts, 'hour')}:${part(parts, 'minute')}`
}

/** "5 Nov, 06:12" in IST; with `withYear`, "5 Nov 2026, 06:12". */
export function formatIstDateTime(iso: string, withYear = false): string {
  const parts = (withYear ? dateTimeYearParts : dateTimeParts).formatToParts(new Date(iso))
  const date = `${part(parts, 'day')} ${part(parts, 'month')}${withYear ? ` ${part(parts, 'year')}` : ''}`
  return `${date}, ${part(parts, 'hour')}:${part(parts, 'minute')}`
}

function dayFields(date: ISODate) {
  const parts = dayParts.formatToParts(new Date(`${date}T00:00:00Z`))
  return {
    weekday: part(parts, 'weekday'),
    day: part(parts, 'day'),
    month: part(parts, 'month'),
    year: part(parts, 'year'),
  }
}

/** "Tue 10 Nov". */
export function formatDayShort(date: ISODate): string {
  const f = dayFields(date)
  return `${f.weekday} ${f.day} ${f.month}`
}

/** "Tue 10 Nov 2026". */
export function formatDayLong(date: ISODate): string {
  const f = dayFields(date)
  return `${f.weekday} ${f.day} ${f.month} ${f.year}`
}

/** "28 Oct 2026". */
export function formatDate(date: ISODate): string {
  const f = dayFields(date)
  return `${f.day} ${f.month} ${f.year}`
}

/** Column heading parts: { weekday: 'Thu', day: '5' }. */
export function formatDayHeader(date: ISODate): { weekday: string; day: string } {
  const f = dayFields(date)
  return { weekday: f.weekday, day: f.day }
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
