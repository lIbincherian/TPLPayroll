import { describe, it, expect } from 'vitest'
import {
  formatDate,
  formatDayHeader,
  formatDayLong,
  formatDayShort,
  formatHours,
  formatHoursTotal,
  formatIstDateTime,
  formatIstTime,
  plural,
} from '../lib/format'

describe('formatHours / formatHoursTotal', () => {
  it('always shows two decimals', () => {
    expect(formatHours(8)).toBe('8.00')
    expect(formatHours(1.25)).toBe('1.25')
    expect(formatHours(0)).toBe('0.00')
    expect(formatHours(0.05)).toBe('0.05')
  })

  it('adds thousands separators to totals', () => {
    expect(formatHoursTotal(4512.5)).toBe('4,512.50')
    expect(formatHoursTotal(0)).toBe('0.00')
    expect(formatHoursTotal(12)).toBe('12.00')
  })

  it('uses Indian digit grouping for large totals', () => {
    expect(formatHoursTotal(1234567.5)).toBe('12,34,567.50')
  })
})

describe('IST time formatting', () => {
  it('formatIstTime shows the IST clock time', () => {
    // 12 Nov 2026 00:30 UTC == 06:00 IST
    expect(formatIstTime('2026-11-12T00:30:00Z')).toBe('06:00')
  })

  it('formatIstTime never renders 24:00 at IST midnight', () => {
    expect(formatIstTime('2026-11-11T18:30:00Z')).toBe('00:00')
  })

  it('formatIstDateTime shows day, month and time in IST', () => {
    expect(formatIstDateTime('2026-11-12T00:30:00Z')).toBe('12 Nov, 06:00')
  })

  it('formatIstDateTime rolls the date forward when IST is past midnight', () => {
    expect(formatIstDateTime('2026-11-11T20:00:00Z')).toBe('12 Nov, 01:30')
  })

  it('formatIstDateTime can include the year', () => {
    expect(formatIstDateTime('2026-11-12T00:30:00Z', true)).toBe('12 Nov 2026, 06:00')
  })
})

describe('ISO date formatting (never shifts a day)', () => {
  it('formatDayShort', () => {
    expect(formatDayShort('2026-11-10')).toBe('Tue 10 Nov')
    expect(formatDayShort('2026-11-05')).toBe('Thu 5 Nov')
  })

  it('formatDayLong', () => {
    expect(formatDayLong('2026-11-10')).toBe('Tue 10 Nov 2026')
  })

  it('formatDate', () => {
    expect(formatDate('2026-10-28')).toBe('28 Oct 2026')
  })

  it('formatDayHeader splits the weekday and the day number', () => {
    expect(formatDayHeader('2026-11-05')).toEqual({ weekday: 'Thu', day: '5' })
    expect(formatDayHeader('2026-11-11')).toEqual({ weekday: 'Wed', day: '11' })
  })
})

describe('plural', () => {
  it('uses the singular for one', () => {
    expect(plural(1, 'day')).toBe('1 day')
  })

  it('uses the plural for zero and many', () => {
    expect(plural(0, 'code')).toBe('0 codes')
    expect(plural(2, 'day')).toBe('2 days')
  })

  it('accepts an irregular plural', () => {
    expect(plural(1, 'person', 'people')).toBe('1 person')
    expect(plural(3, 'person', 'people')).toBe('3 people')
  })
})
