import { describe, it, expect } from 'vitest'
import {
  addDaysISO,
  formatWeekLabel,
  getCompletedPayrollWeek,
  getCurrentPayrollWeek,
  getWeekDates,
  hasWeekEnded,
  isFutureWeek,
  isThursdayISO,
  isoWeekOf,
  parseWeekId,
  paymentReference,
  todayInIST,
  toISODate,
  toUtcDate,
  weekFromStartISO,
} from '../lib/week'

describe('todayInIST', () => {
  it('returns the IST calendar date', () => {
    // 12 Nov 2026 06:00 IST == 00:30 UTC
    expect(todayInIST(new Date('2026-11-12T00:30:00Z'))).toBe('2026-11-12')
  })

  it('rolls to the next IST day at 18:30 UTC', () => {
    expect(todayInIST(new Date('2026-11-11T18:29:59Z'))).toBe('2026-11-11')
    expect(todayInIST(new Date('2026-11-11T18:30:00Z'))).toBe('2026-11-12')
  })

  it('rolls across a month and year boundary in IST', () => {
    expect(todayInIST(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01')
  })
})

describe('getCompletedPayrollWeek (US-12.1)', () => {
  it('returns the week ending the previous day at Thursday 06:00 IST', () => {
    // Thursday 12 Nov 2026, 06:00 IST
    const now = new Date('2026-11-12T00:30:00Z')
    expect(getCompletedPayrollWeek(now)).toEqual({ start: '2026-11-05', end: '2026-11-11' })
  })

  it('returns the same week across the Vercel firing window (00:00 and 00:59 UTC)', () => {
    expect(getCompletedPayrollWeek(new Date('2026-11-12T00:00:00Z'))).toEqual({
      start: '2026-11-05',
      end: '2026-11-11',
    })
    expect(getCompletedPayrollWeek(new Date('2026-11-12T00:59:00Z'))).toEqual({
      start: '2026-11-05',
      end: '2026-11-11',
    })
  })

  it('still targets the previous week on a Saturday, not the in-progress one', () => {
    expect(getCompletedPayrollWeek(new Date('2026-11-14T06:00:00Z'))).toEqual({
      start: '2026-11-05',
      end: '2026-11-11',
    })
  })

  it('uses the IST date, not the UTC date, around midnight', () => {
    // 11 Nov 18:29 UTC is still Wed 11 Nov IST -> yesterday Tue 10 -> week 29 Oct - 4 Nov
    expect(getCompletedPayrollWeek(new Date('2026-11-11T18:29:00Z'))).toEqual({
      start: '2026-10-29',
      end: '2026-11-04',
    })
    // 11 Nov 18:30 UTC is Thu 12 Nov IST -> week 5 - 11 Nov
    expect(getCompletedPayrollWeek(new Date('2026-11-11T18:30:00Z'))).toEqual({
      start: '2026-11-05',
      end: '2026-11-11',
    })
  })

  it('always returns a Thursday-to-Wednesday seven day range', () => {
    const week = getCompletedPayrollWeek(new Date('2027-03-03T10:00:00Z'))
    expect(isThursdayISO(week.start)).toBe(true)
    expect(addDaysISO(week.start, 6)).toBe(week.end)
  })
})

describe('getCurrentPayrollWeek', () => {
  it('returns the Thursday on/before today through the following Wednesday', () => {
    expect(getCurrentPayrollWeek('2026-11-12')).toEqual({ start: '2026-11-12', end: '2026-11-18' }) // Thursday
    expect(getCurrentPayrollWeek('2026-11-18')).toEqual({ start: '2026-11-12', end: '2026-11-18' }) // Wednesday
    expect(getCurrentPayrollWeek('2026-11-15')).toEqual({ start: '2026-11-12', end: '2026-11-18' }) // Sunday
  })
})

describe('weekFromStartISO / getWeekDates', () => {
  it('builds the end six days after the start', () => {
    expect(weekFromStartISO('2026-11-05')).toEqual({ start: '2026-11-05', end: '2026-11-11' })
  })

  it('lists seven dates, Thursday first', () => {
    expect(getWeekDates({ start: '2026-11-05', end: '2026-11-11' })).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ])
  })

  it('crosses a month boundary', () => {
    expect(weekFromStartISO('2026-10-29')).toEqual({ start: '2026-10-29', end: '2026-11-04' })
  })
})

describe('parseWeekId', () => {
  it('accepts a Thursday', () => {
    expect(parseWeekId('2026-11-05')).toEqual({ start: '2026-11-05', end: '2026-11-11' })
  })

  it.each([
    ['a Wednesday', '2026-11-04'],
    ['a Friday', '2026-11-06'],
    ['a non-existent date', '2026-02-30'],
    ['a month of 13', '2026-13-05'],
    ['a short year', '26-11-05'],
    ['a slash separated date', '2026/11/05'],
    ['an empty string', ''],
    ['garbage', 'not-a-date'],
    ['a timestamp', '2026-11-05T00:00:00Z'],
  ])('rejects %s', (_label, value) => {
    expect(parseWeekId(value)).toBeNull()
  })
})

describe('isThursdayISO', () => {
  it('is true only for a real Thursday', () => {
    expect(isThursdayISO('2026-11-05')).toBe(true)
    expect(isThursdayISO('2026-11-06')).toBe(false)
    expect(isThursdayISO('2026-02-29')).toBe(false)
  })
})

describe('hasWeekEnded / isFutureWeek', () => {
  const week = { start: '2026-11-05', end: '2026-11-11' }

  it('has not ended on the last day (C4: Approve waits until the week has ended)', () => {
    expect(hasWeekEnded(week, '2026-11-11')).toBe(false)
  })

  it('has ended the day after the last day', () => {
    expect(hasWeekEnded(week, '2026-11-12')).toBe(true)
  })

  it('has not ended mid-week', () => {
    expect(hasWeekEnded(week, '2026-11-08')).toBe(false)
  })

  it('is a future week only when the start is after today', () => {
    expect(isFutureWeek(week, '2026-11-04')).toBe(true)
    expect(isFutureWeek(week, '2026-11-05')).toBe(false)
    expect(isFutureWeek(week, '2026-11-20')).toBe(false)
  })
})

describe('date helpers', () => {
  it('toUtcDate and toISODate round-trip at UTC midnight', () => {
    const date = toUtcDate('2026-11-05')
    expect(date.toISOString()).toBe('2026-11-05T00:00:00.000Z')
    expect(toISODate(date)).toBe('2026-11-05')
  })

  it('addDaysISO handles negative days and month/year boundaries', () => {
    expect(addDaysISO('2026-11-05', -5)).toBe('2026-10-31')
    expect(addDaysISO('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('formatWeekLabel', () => {
  it('formats a same-year week without repeating the year at the start', () => {
    expect(formatWeekLabel({ start: '2026-11-05', end: '2026-11-11' })).toBe('5 Nov – 11 Nov 2026')
  })

  it('shows both years when the week spans New Year', () => {
    expect(formatWeekLabel({ start: '2026-12-31', end: '2027-01-06' })).toBe('31 Dec 2026 – 6 Jan 2027')
  })
})

describe('isoWeekOf / paymentReference', () => {
  it('builds YYYY-WW-<EMP ID> from the week start', () => {
    expect(paymentReference('2026-11-05', 'TPLGOASHT231')).toBe('2026-45-TPLGOASHT231')
  })

  it('keeps a payroll week crossing New Year in the old ISO year (2026 has 53 weeks)', () => {
    expect(isoWeekOf('2026-12-31')).toEqual({ year: 2026, week: 53 })
    expect(paymentReference('2026-12-31', 'E1')).toBe('2026-53-E1')
  })

  it('puts the first payroll week of 2027 in week 01', () => {
    expect(paymentReference('2027-01-07', 'E1')).toBe('2027-01-E1')
  })

  it('puts a Thursday 1 January in week 01 of that year', () => {
    expect(paymentReference('2026-01-01', 'E1')).toBe('2026-01-E1')
  })

  it('handles the 53-week year 2020', () => {
    expect(paymentReference('2020-12-31', 'E1')).toBe('2020-53-E1')
  })

  it('pads the week to two digits', () => {
    expect(paymentReference('2027-01-07', 'E1')).toContain('-01-')
    expect(paymentReference('2027-03-04', 'E1')).toBe('2027-09-E1')
  })

  it('assigns an early-January Sunday to the previous ISO year', () => {
    expect(isoWeekOf('2027-01-03')).toEqual({ year: 2026, week: 53 })
  })
})
