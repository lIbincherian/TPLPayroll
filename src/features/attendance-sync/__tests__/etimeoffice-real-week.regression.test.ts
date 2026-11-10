import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { classifySyncResponse } from '../lib/etimeoffice/parser'
import { buildPunchRowsFromParsed, mergeScans, pairPunches } from '../lib/pairing'
import { calculateDailyHours, isUnusualDay } from '../lib/hours'
import { MERGE_WINDOW_MINUTES, UNUSUAL_SINGLE_PAIR_MAX_HOURS } from '../lib/constants'
import { diffMinutes, round2 } from '../lib/time'
import type { HHmm, ISODate, ParsedPunch } from '../types/attendance-sync.types'

/**
 * Regression pins over the REAL eTimeOffice payroll week 29 Oct to 4 Nov 2026 (956 punches, 51 codes),
 * saved with every Name replaced by `Employee <Empcode>`. Empcode, PunchDate, M_Flag and mcid are untouched.
 *
 * The aggregates below were taken from one run of the pipeline and then checked three ways:
 *   1. a separate implementation that shares no code with the product (plain minutes arithmetic) run over the
 *      original, un-anonymised response gave the same days, complete/incomplete split, merged days, unusual
 *      days and regular/overtime totals;
 *   2. the specific days further down are worked out by hand from the raw rows in the fixture;
 *   3. the invariants (nothing lost, every merge within the window, no unmerged neighbours inside it).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'etime-week-2026-10-29_2026-11-04.json')
const WEEK = { start: '2026-10-29', end: '2026-11-04' } as const

type DayResult = {
  code: string
  date: ISODate
  scans: HHmm[]
  punches: HHmm[]
  mergedInto: Record<HHmm, HHmm[]>
  pairs: Array<{ in: HHmm; out: HHmm }>
  incomplete: HHmm | null
  regularHours: number
  overtimeHours: number
  totalHours: number
  unusual: boolean
  reason: string | null
}

function loadFixtureText(): string {
  return fs.readFileSync(FIXTURE, 'utf8')
}

function loadPunches(): ParsedPunch[] {
  const result = classifySyncResponse({ status: 200, bodyText: loadFixtureText() })
  if (!result.ok) throw new Error(`fixture did not classify: ${result.code} ${result.message}`)
  return result.punches
}

/** Per employee code and day (one code is one person in this week): merge, pair, then hours and the unusual check. */
function runPipeline(punches: ParsedPunch[]): DayResult[] {
  const groups = new Map<string, { code: string; date: ISODate; scans: HHmm[] }>()
  for (const punch of punches) {
    const key = `${punch.empCode}|${punch.date}`
    const group = groups.get(key) ?? { code: punch.empCode, date: punch.date, scans: [] }
    group.scans.push(punch.time)
    groups.set(key, group)
  }

  return [...groups.values()]
    .sort((a, b) => (a.code + a.date).localeCompare(b.code + b.date))
    .map((group) => {
      const merged = mergeScans(group.scans)
      const { pairs, incomplete } = pairPunches(merged.punches)
      const hours = calculateDailyHours(pairs)
      // Same rule as buildDayView: only a complete day is highlighted; an incomplete one is under "Needs fixing".
      const unusual = incomplete === null ? isUnusualDay(pairs) : { unusual: false, reason: null }
      return {
        code: group.code,
        date: group.date,
        scans: [...group.scans].sort(),
        punches: merged.punches,
        mergedInto: merged.mergedInto,
        pairs,
        incomplete,
        ...hours,
        unusual: unusual.unusual,
        reason: unusual.reason,
      }
    })
}

const days = runPipeline(loadPunches())
const day = (code: string, date: ISODate): DayResult => {
  const found = days.find((d) => d.code === code && d.date === date)
  if (!found) throw new Error(`no ${code} on ${date}`)
  return found
}
const count = <T>(items: T[], key: (item: T) => string | number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const item of items) out[String(key(item))] = (out[String(key(item))] ?? 0) + 1
  return out
}
const complete = days.filter((d) => d.incomplete === null)
const incomplete = days.filter((d) => d.incomplete !== null)

describe('real eTimeOffice week fixture is anonymised', () => {
  it('has no Name that is not "Employee <Empcode>"', () => {
    const raw = JSON.parse(loadFixtureText()) as {
      PunchData: Array<{ Name: string; Empcode: string; PunchDate: string; M_Flag: unknown; mcid: string }>
    }
    const offenders = raw.PunchData.filter((row) => row.Name !== `Employee ${row.Empcode}`)
    expect(offenders).toEqual([])
    expect(raw.PunchData).toHaveLength(956)
  })

  it('has exactly 956 "Name" keys in the text and each value matches the pattern', () => {
    const text = loadFixtureText()
    const names = [...text.matchAll(/"Name":"([^"]*)"/g)].map((m) => m[1])
    expect(names).toHaveLength(956)
    expect(names.every((name) => /^Employee \d{4}$/.test(name))).toBe(true)
    // The only words in the file are the field names, the vendor's top-level keys and "Employee".
    const stripped = text.replace(/"(Error|Msg|IsAdmin|PunchData|Name|Empcode|PunchDate|M_Flag|mcid)"/g, '')
    const otherWords = (stripped.match(/[A-Za-z]{3,}/g) ?? []).filter(
      (word) => !['false', 'true', 'null', 'Success', 'Employee'].includes(word),
    )
    expect(otherWords).toEqual([])
  })

  it('keeps the original response envelope and each row shape (Empcode, PunchDate, M_Flag, mcid)', () => {
    const raw = JSON.parse(loadFixtureText()) as Record<string, unknown> & { PunchData: Array<Record<string, unknown>> }
    expect(Object.keys(raw)).toEqual(['Error', 'Msg', 'IsAdmin', 'PunchData'])
    expect(raw.Error).toBe(false)
    expect(raw.Msg).toBe('Success')
    expect(raw.IsAdmin).toBe(true)
    for (const row of raw.PunchData) {
      expect(Object.keys(row)).toEqual(['Name', 'Empcode', 'PunchDate', 'M_Flag', 'mcid'])
      expect(row.Empcode).toMatch(/^\d{4}$/)
      expect(row.PunchDate).toMatch(/^\d{2}\/\d{2}\/2026 \d{2}:\d{2}:00$/)
      expect(row.M_Flag).toBeNull()
      expect(row.mcid).toBe('1')
    }
  })

  it('reads back through the parser with the anonymised name', () => {
    const punches = loadPunches()
    expect(punches).toHaveLength(956)
    expect(new Set(punches.map((p) => p.empCode)).size).toBe(51)
    expect(punches.every((p) => p.empName === `Employee ${p.empCode}`)).toBe(true)
    expect(punches.every((p) => p.mcid === '1')).toBe(true)
  })

  it('is exactly the Thursday-to-Wednesday week 2026-10-29 to 2026-11-04', () => {
    const punches = loadPunches()
    const dates = punches.map((p) => p.date).sort()
    expect(dates[0]).toBe(WEEK.start)
    expect(dates[dates.length - 1]).toBe(WEEK.end)
    expect(count(punches, (p) => p.date)).toEqual({
      '2026-10-29': 140,
      '2026-10-30': 145,
      '2026-10-31': 141,
      '2026-11-01': 76,
      '2026-11-02': 128,
      '2026-11-03': 145,
      '2026-11-04': 181,
    })
  })
})

describe('real eTimeOffice week: pipeline aggregates (classify, merge, pair, hours, unusual)', () => {
  it('finds 270 employee-days: 251 complete and 19 incomplete', () => {
    expect(days).toHaveLength(270)
    expect(complete).toHaveLength(251)
    expect(incomplete).toHaveLength(19)
  })

  it('has the same employee-days per date', () => {
    expect(count(days, (d) => d.date)).toEqual({
      '2026-10-29': 36,
      '2026-10-30': 37,
      '2026-10-31': 36,
      '2026-11-01': 36,
      '2026-11-02': 33,
      '2026-11-03': 46,
      '2026-11-04': 46,
    })
  })

  it('splits complete and incomplete days per date', () => {
    const perDate = (list: DayResult[]) => count(list, (d) => d.date)
    expect(perDate(complete)).toEqual({
      '2026-10-29': 36,
      '2026-10-30': 36,
      '2026-10-31': 35,
      '2026-11-01': 34,
      '2026-11-02': 31,
      '2026-11-03': 33,
      '2026-11-04': 46,
    })
    expect(perDate(incomplete)).toEqual({
      '2026-10-30': 1,
      '2026-10-31': 1,
      '2026-11-01': 2,
      '2026-11-02': 2,
      '2026-11-03': 13,
    })
  })

  it('merges repeat scans on exactly 2 days, absorbing 3 scans (all on 2026-11-04)', () => {
    const mergedDays = days.filter((d) => Object.keys(d.mergedInto).length > 0)
    expect(mergedDays.map((d) => `${d.code}|${d.date}`)).toEqual(['0191|2026-11-04', '0272|2026-11-04'])
    const absorbed = days.reduce((sum, d) => sum + d.scans.length - d.punches.length, 0)
    expect(absorbed).toBe(3)
    expect(days.reduce((sum, d) => sum + d.scans.length, 0)).toBe(956)
    expect(days.reduce((sum, d) => sum + d.punches.length, 0)).toBe(953)
  })

  it('has the pairs-per-day distribution: 43 one-pair days and 208 two-pair days; no day has three or more', () => {
    expect(count(complete, (d) => d.pairs.length)).toEqual({ 1: 43, 2: 208 })
  })

  it('has 19 incomplete days: 12 with one stray punch, 6 with one pair plus a stray, 1 with two pairs plus a stray', () => {
    expect(count(incomplete, (d) => d.pairs.length)).toEqual({ 0: 12, 1: 6, 2: 1 })
    expect(count(days, (d) => d.punches.length)).toEqual({ 1: 12, 2: 43, 3: 6, 4: 208, 5: 1 })
    // Scans as received: the three repeat scans make two 5-scan days and one 6-scan day; merging brings the 6-scan day
    // and one 5-scan day down to four punches.
    expect(count(days, (d) => d.scans.length)).toEqual({ 1: 12, 2: 43, 3: 6, 4: 206, 5: 2, 6: 1 })
  })

  it('flags 41 complete days as unusual: 37 under four hours and 4 with a single pair over nine hours', () => {
    const unusual = complete.filter((d) => d.unusual)
    expect(unusual).toHaveLength(41)
    expect(unusual.filter((d) => d.reason?.startsWith('Under 4 hours'))).toHaveLength(37)
    expect(unusual.filter((d) => d.reason?.startsWith('One pair over 9 hours'))).toHaveLength(4)
    expect(count(unusual, (d) => d.date)).toEqual({
      '2026-10-29': 1,
      '2026-10-31': 1,
      '2026-11-01': 33,
      '2026-11-02': 1,
      '2026-11-03': 3,
      '2026-11-04': 2,
    })
  })

  it('never flags an incomplete day', () => {
    expect(incomplete.some((d) => d.unusual)).toBe(false)
  })

  it('totals 1744.71 regular and 375.01 overtime hours (2119.72 worked) across the 251 complete days', () => {
    expect(round2(complete.reduce((sum, d) => sum + d.regularHours, 0))).toBe(1744.71)
    expect(round2(complete.reduce((sum, d) => sum + d.overtimeHours, 0))).toBe(375.01)
    expect(round2(complete.reduce((sum, d) => sum + d.totalHours, 0))).toBe(2119.72)
  })

  it('does not treat a pair of up to nine hours as unusual: 26 pairs fall between 6 and 9 hours, so 16 days the 6-hour rule flagged are no longer', () => {
    const pairMinutes = (d: DayResult) => d.pairs.map((p) => diffMinutes(p.in, p.out))
    expect(complete.flatMap(pairMinutes).filter((m) => m > 6 * 60 && m <= 9 * 60)).toHaveLength(26)
    const onlyLongerThanSix = complete.filter(
      (d) => d.totalHours >= 4 && Math.max(...pairMinutes(d)) > 6 * 60 && Math.max(...pairMinutes(d)) <= 9 * 60,
    )
    expect(onlyLongerThanSix).toHaveLength(16)
    expect(onlyLongerThanSix.every((d) => !d.unusual)).toBe(true)
    // The longest pair in the week is 9h44m (04:58 to 14:42), flagged.
    expect(Math.max(...complete.flatMap(pairMinutes))).toBe(584)
  })
})

describe('real eTimeOffice week: invariants', () => {
  it('loses no scan: scans = kept punches + absorbed scans, on every day', () => {
    for (const d of days) {
      const absorbed = Object.values(d.mergedInto).reduce((sum, list) => sum + list.length, 0)
      expect(d.punches.length + absorbed, `${d.code} ${d.date}`).toBe(d.scans.length)
    }
  })

  it('every absorbed scan is within the merge window of its kept punch, and every kept neighbour is further apart', () => {
    const absorbedGaps: number[] = []
    for (const d of days) {
      for (const [kept, absorbed] of Object.entries(d.mergedInto)) {
        for (const scan of absorbed) absorbedGaps.push(diffMinutes(kept, scan))
      }
      for (let i = 1; i < d.punches.length; i++) {
        expect(diffMinutes(d.punches[i - 1], d.punches[i]), `${d.code} ${d.date}`).toBeGreaterThan(MERGE_WINDOW_MINUTES)
      }
    }
    expect(absorbedGaps.sort((a, b) => a - b)).toEqual([5, 5, 10])
    expect(Math.max(...absorbedGaps)).toBeLessThanOrEqual(MERGE_WINDOW_MINUTES)
  })

  it('a two-minute window would have merged nothing here: the three repeat scans are 5, 5 and 10 minutes apart', () => {
    let adjacentWithinTwoMinutes = 0
    for (const d of days) {
      for (let i = 1; i < d.scans.length; i++) {
        if (diffMinutes(d.scans[i - 1], d.scans[i]) <= 2) adjacentWithinTwoMinutes++
      }
    }
    expect(adjacentWithinTwoMinutes).toBe(0)
  })

  it('regular + overtime = worked, regular never exceeds 8 and overtime is never negative, on every complete day', () => {
    for (const d of complete) {
      expect(d.regularHours, `${d.code} ${d.date}`).toBeLessThanOrEqual(8)
      expect(d.overtimeHours).toBeGreaterThanOrEqual(0)
      expect(round2(d.regularHours + d.overtimeHours)).toBe(d.totalHours)
    }
  })

  it('an unusual day always carries its reason and a usual day carries none', () => {
    for (const d of days) {
      expect(d.reason === null, `${d.code} ${d.date}`).toBe(!d.unusual)
    }
  })

  it('buildPunchRowsFromParsed stores one row per kept punch (953) with the merged scans on the kept punch', () => {
    const rows = buildPunchRowsFromParsed(loadPunches(), [], [], WEEK)
    expect(rows).toHaveLength(953)
    expect(rows.filter((row) => row.mergedScansJson !== null)).toHaveLength(3)
    expect(rows.every((row) => row.matchStatus === 'UNKNOWN' && row.employeeId === null)).toBe(true)
    expect(rows.every((row) => row.empName === `Employee ${row.empCode}`)).toBe(true)

    const rowsOf = (code: string, iso: string) =>
      rows
        .filter((row) => row.empCode === code && row.punchDate.toISOString().startsWith(iso))
        .map((row) => [row.pairIndex, row.position, row.originalTime, row.mergedScansJson])
    expect(rowsOf('0272', '2026-11-04')).toEqual([
      [0, 'IN', '07:44', ['07:49']],
      [0, 'OUT', '13:03', null],
      [1, 'IN', '13:56', null],
      [1, 'OUT', '18:05', null],
    ])
  })
})

describe('real eTimeOffice week: specific days, worked out by hand from the raw rows', () => {
  it('0272 on 2026-11-04: 07:44, 07:49, 13:03, 13:56, 18:05 merges 07:49 into 07:44 and becomes a complete day', () => {
    const d = day('0272', '2026-11-04')
    expect(d.scans).toEqual(['07:44', '07:49', '13:03', '13:56', '18:05'])
    expect(d.punches).toEqual(['07:44', '13:03', '13:56', '18:05'])
    expect(d.mergedInto).toEqual({ '07:44': ['07:49'] })
    expect(d.pairs).toEqual([
      { in: '07:44', out: '13:03' },
      { in: '13:56', out: '18:05' },
    ])
    expect(d.incomplete).toBeNull()
    // 07:44 to 13:03 is 5h19 (319 min); 13:56 to 18:05 is 4h09 (249 min); 568 min is 9h28, so 9.4667 rounds to 9.47.
    expect(d.totalHours).toBe(9.47)
    expect(d.regularHours).toBe(8)
    expect(d.overtimeHours).toBe(1.47)
    expect(d.unusual).toBe(false)
  })

  it('0191 on 2026-11-04: 07:35/07:45 (exactly 10 minutes, inclusive) and 13:24/13:29 merge; 14:02 is 38 minutes after 13:24 so it stays', () => {
    const d = day('0191', '2026-11-04')
    expect(d.scans).toEqual(['07:35', '07:45', '13:24', '13:29', '14:02', '18:06'])
    expect(d.mergedInto).toEqual({ '07:35': ['07:45'], '13:24': ['13:29'] })
    expect(d.punches).toEqual(['07:35', '13:24', '14:02', '18:06'])
    expect(diffMinutes('07:35', '07:45')).toBe(MERGE_WINDOW_MINUTES)
    expect(d.pairs).toEqual([
      { in: '07:35', out: '13:24' },
      { in: '14:02', out: '18:06' },
    ])
    // 349 min + 244 min = 593 min = 9h53, so 9.8833 rounds to 9.88; overtime 9.88 - 8 = 1.88.
    expect(d.totalHours).toBe(9.88)
    expect(d.regularHours).toBe(8)
    expect(d.overtimeHours).toBe(1.88)
    expect(d.unusual).toBe(false)
  })

  it('0272 on 2026-11-03: a single 10:00 punch is an incomplete day with no hours and is not flagged', () => {
    const d = day('0272', '2026-11-03')
    expect(d.scans).toEqual(['10:00'])
    expect(d.pairs).toEqual([])
    expect(d.incomplete).toBe('10:00')
    expect(d.totalHours).toBe(0)
    expect(d.unusual).toBe(false)
  })

  it('0121 on 2026-10-29: a 05:28 to 13:01 pair (7h33) is usual now that only a pair over nine hours is flagged', () => {
    const d = day('0121', '2026-10-29')
    expect(d.pairs).toEqual([
      { in: '05:28', out: '13:01' },
      { in: '14:00', out: '19:01' },
    ])
    // 453 min + 301 min = 754 min = 12h34, so 12.5667 rounds to 12.57; overtime 4.57.
    expect(d.totalHours).toBe(12.57)
    expect(d.overtimeHours).toBe(4.57)
    expect(d.unusual).toBe(false)
    expect(UNUSUAL_SINGLE_PAIR_MAX_HOURS).toBe(9)
  })

  it('0159 on 2026-11-03: a 04:31 to 13:36 pair is 9h05, just over nine hours, so the day is flagged', () => {
    const d = day('0159', '2026-11-03')
    expect(d.pairs).toEqual([
      { in: '04:31', out: '13:36' },
      { in: '14:33', out: '21:20' },
    ])
    expect(diffMinutes('04:31', '13:36')).toBe(545)
    // 545 min + 407 min = 952 min = 15h52, so 15.8667 rounds to 15.87; overtime 7.87.
    expect(d.totalHours).toBe(15.87)
    expect(d.overtimeHours).toBe(7.87)
    expect(d.unusual).toBe(true)
    expect(d.reason).toBe('One pair over 9 hours (04:31–13:36)')
  })

  it('0264 on 2026-11-04: a single 16:12 to 18:48 pair is 2.60 hours, under four, so the day is flagged', () => {
    const d = day('0264', '2026-11-04')
    expect(d.pairs).toEqual([{ in: '16:12', out: '18:48' }])
    expect(d.totalHours).toBe(2.6)
    expect(d.regularHours).toBe(2.6)
    expect(d.overtimeHours).toBe(0)
    expect(d.unusual).toBe(true)
    expect(d.reason).toBe('Under 4 hours (2.60)')
  })
})
