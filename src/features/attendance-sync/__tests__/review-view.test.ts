import { describe, it, expect } from 'vitest'
import {
  applySaveResult,
  dayAriaLabel,
  describeBlockers,
  describeDay,
  findStepTarget,
  getCellPairs,
  getShownPairs,
  isIncompletePair,
  matchesFilter,
  matchesSearch,
  pairText,
} from '../lib/review-view'
import { buildDayView } from '../lib/hours'
import { getWeekDates } from '../lib/week'
import type {
  GridEmployee,
  PunchReview,
  SavePunchEditResult,
  StoredPunchRow,
} from '../types/attendance-sync.types'

const week = { start: '2026-11-05', end: '2026-11-11' }
const dates = getWeekDates(week)

function row(
  id: string,
  pairIndex: number,
  position: 'IN' | 'OUT',
  original: string | null,
  current: string | null,
  extra: Partial<StoredPunchRow> = {},
): StoredPunchRow {
  return { id, pairIndex, position, source: 'API', originalTime: original, currentTime: current, note: null, ...extra }
}

const pairRows = (prefix: string, pairIndex: number, inTime: string, outTime: string): StoredPunchRow[] => [
  row(`${prefix}i`, pairIndex, 'IN', inTime, inTime),
  row(`${prefix}o`, pairIndex, 'OUT', outTime, outTime),
]

function employee(id: string, name: string, byDate: Record<string, StoredPunchRow[]> = {}): GridEmployee {
  const days = dates.map((date) => buildDayView(date, byDate[date] ?? []))
  return {
    employeeId: id,
    employeeCode: `TPLGOAHLP${id.padStart(3, '0')}`,
    employeeName: name,
    tag: 'ACTIVE',
    days,
    totalRegularHours: days.reduce((s, d) => s + d.regularHours, 0),
    totalOvertimeHours: days.reduce((s, d) => s + d.overtimeHours, 0),
    hasAnyPunch: days.some((d) => d.pairs.length > 0),
  }
}

const incompleteRows = [row('x', 0, 'IN', '18:26', '18:26')]
const unusualRows = pairRows('u', 0, '08:00', '11:10')
const fullRows = [...pairRows('f1', 0, '07:40', '13:04'), ...pairRows('f2', 1, '13:56', '17:47')]

describe('matchesFilter', () => {
  const clean = employee('1', 'Clean', { '2026-11-05': fullRows })
  const needs = employee('2', 'Needs', { '2026-11-06': incompleteRows })
  const none = employee('3', 'None')
  const unusual = employee('4', 'Unusual', { '2026-11-05': unusualRows })

  it('"all" matches everyone', () => {
    for (const e of [clean, needs, none, unusual]) expect(matchesFilter(e, 'all')).toBe(true)
  })

  it('"needs" matches employees with an incomplete day', () => {
    expect([clean, needs, none, unusual].filter((e) => matchesFilter(e, 'needs')).map((e) => e.employeeName)).toEqual(['Needs'])
  })

  it('"nopunch" matches employees with no punches', () => {
    expect([clean, needs, none, unusual].filter((e) => matchesFilter(e, 'nopunch')).map((e) => e.employeeName)).toEqual(['None'])
  })

  it('"unusual" matches employees with an unusual complete day', () => {
    expect([clean, needs, none, unusual].filter((e) => matchesFilter(e, 'unusual')).map((e) => e.employeeName)).toEqual(['Unusual'])
  })
})

describe('matchesSearch', () => {
  const e = employee('36', 'Anand Kumar')

  it('matches everything on a blank query', () => {
    expect(matchesSearch(e, '')).toBe(true)
    expect(matchesSearch(e, '   ')).toBe(true)
  })

  it('matches name or code, case-insensitively', () => {
    expect(matchesSearch(e, 'anand')).toBe(true)
    expect(matchesSearch(e, 'KUMAR')).toBe(true)
    expect(matchesSearch(e, 'hlp036')).toBe(true)
  })

  it('does not match something else', () => {
    expect(matchesSearch(e, 'zzz')).toBe(false)
  })
})

describe('pair text and incomplete detection', () => {
  const day = buildDayView('2026-11-05', [...pairRows('a', 0, '07:40', '13:04'), row('b', 1, 'IN', '18:26', '18:26')])

  it('pairText joins with an en dash and shows --:-- for the missing side', () => {
    expect(pairText(day.pairs[0])).toBe('07:40–13:04')
    expect(pairText(day.pairs[1])).toBe('18:26–--:--')
  })

  it('isIncompletePair is true only when exactly one side has a time', () => {
    expect(isIncompletePair(day.pairs[0])).toBe(false)
    expect(isIncompletePair(day.pairs[1])).toBe(true)
  })

  it('getShownPairs drops pairs with no times left', () => {
    const deleted = buildDayView('2026-11-05', [row('a', 0, 'IN', '08:00', null), row('b', 0, 'OUT', '09:00', null)])
    expect(deleted.pairs).toHaveLength(0)
    expect(getShownPairs(deleted)).toEqual([])
  })

  it('describeDay lists one line per shown pair', () => {
    expect(describeDay(day)).toEqual(['07:40–13:04', '18:26–--:--'])
  })
})

describe('getCellPairs', () => {
  const pair = (i: number) => pairRows(`p${i}`, i, `0${i + 1}:00`, `0${i + 1}:30`)

  it('shows up to two pairs with nothing hidden', () => {
    const day = buildDayView('2026-11-05', [...pair(0), ...pair(1)])
    expect(getCellPairs(day)).toEqual({ pairs: day.pairs, hiddenCount: 0 })
    expect(getCellPairs(buildDayView('2026-11-05', pair(0))).hiddenCount).toBe(0)
  })

  it('hides the rest behind a count past two pairs', () => {
    const day = buildDayView('2026-11-05', [...pair(0), ...pair(1), ...pair(2), ...pair(3)])
    const cell = getCellPairs(day)
    expect(cell.pairs.map((p) => p.pairIndex)).toEqual([0, 1])
    expect(cell.hiddenCount).toBe(2)
  })

  it('never hides an incomplete pair', () => {
    const day = buildDayView('2026-11-05', [...pair(0), ...pair(1), ...pair(2), row('z', 3, 'IN', '09:00', '09:00')])
    const cell = getCellPairs(day)
    expect(cell.pairs.map((p) => p.pairIndex)).toEqual([0, 3])
    expect(cell.hiddenCount).toBe(2)
  })

  it('keeps the first pair when the incomplete pair is the first one', () => {
    const day = buildDayView('2026-11-05', [row('z', 0, 'IN', '06:00', '06:00'), ...pair(1), ...pair(2)])
    const cell = getCellPairs(day)
    expect(cell.pairs.map((p) => p.pairIndex)).toEqual([0, 1])
    expect(cell.hiddenCount).toBe(1)
  })
})

describe('dayAriaLabel', () => {
  const e = employee('1', 'Anand')

  it('describes a normal day with its hours', () => {
    const day = buildDayView('2026-11-05', fullRows)
    expect(dayAriaLabel(e, day)).toBe('Anand, Thu 5 Nov. 07:40–13:04, 13:56–17:47. 8.00 regular, 1.25 overtime')
  })

  it('says "no punches" for an empty day', () => {
    expect(dayAriaLabel(e, buildDayView('2026-11-05', []))).toBe('Anand, Thu 5 Nov. no punches')
  })

  it('adds needs fixing, unusual, merged and edited flags', () => {
    const incomplete = buildDayView('2026-11-06', incompleteRows)
    expect(dayAriaLabel(e, incomplete)).toContain('needs fixing')

    const unusual = buildDayView('2026-11-06', unusualRows)
    expect(dayAriaLabel(e, unusual)).toContain('unusual: Under 4 hours (3.17)')

    const merged = buildDayView('2026-11-06', [
      row('a', 0, 'IN', '07:40', '07:40', { mergedScansJson: ['07:41'] }),
      row('b', 0, 'OUT', '17:47', '17:47'),
    ])
    expect(dayAriaLabel(e, merged)).toContain('merged scans')

    const edited = buildDayView('2026-11-06', [row('a', 0, 'IN', '07:40', '07:40'), row('b', 0, 'OUT', '17:47', '18:00')])
    expect(dayAriaLabel(e, edited)).toContain('edited')
  })
})

describe('findStepTarget', () => {
  const a = employee('1', 'A', { '2026-11-06': incompleteRows })
  const b = employee('2', 'B', { '2026-11-08': [row('y', 0, 'OUT', '09:00', '09:00')] })
  const employees = [a, b]

  it('steps through the same employee’s days with the "all" filter', () => {
    expect(findStepTarget(employees, 'all', { employeeId: '1', date: '2026-11-05' }, 'next')).toEqual({
      employeeId: '1',
      date: '2026-11-06',
    })
    expect(findStepTarget(employees, 'all', { employeeId: '1', date: '2026-11-06' }, 'previous')).toEqual({
      employeeId: '1',
      date: '2026-11-05',
    })
  })

  it('stops at the ends of the week with the "all" filter', () => {
    expect(findStepTarget(employees, 'all', { employeeId: '1', date: '2026-11-05' }, 'previous')).toBeNull()
    expect(findStepTarget(employees, 'all', { employeeId: '1', date: '2026-11-11' }, 'next')).toBeNull()
    expect(findStepTarget(employees, 'nopunch', { employeeId: '1', date: '2026-11-11' }, 'next')).toBeNull()
  })

  it('steps across employees through days that need fixing', () => {
    expect(findStepTarget(employees, 'needs', { employeeId: '1', date: '2026-11-06' }, 'next')).toEqual({
      employeeId: '2',
      date: '2026-11-08',
    })
    expect(findStepTarget(employees, 'needs', { employeeId: '2', date: '2026-11-08' }, 'previous')).toEqual({
      employeeId: '1',
      date: '2026-11-06',
    })
  })

  it('returns null past the last matching day', () => {
    expect(findStepTarget(employees, 'needs', { employeeId: '2', date: '2026-11-08' }, 'next')).toBeNull()
    expect(findStepTarget(employees, 'needs', { employeeId: '1', date: '2026-11-06' }, 'previous')).toBeNull()
  })

  it('a day that was just fixed (no longer matching) still marks the current position', () => {
    expect(findStepTarget(employees, 'needs', { employeeId: '1', date: '2026-11-07' }, 'next')).toEqual({
      employeeId: '2',
      date: '2026-11-08',
    })
  })

  it('steps through unusual days with the "unusual" filter', () => {
    const u = employee('3', 'U', { '2026-11-09': unusualRows })
    expect(findStepTarget([a, u], 'unusual', { employeeId: '1', date: '2026-11-05' }, 'next')).toEqual({
      employeeId: '3',
      date: '2026-11-09',
    })
  })

  it('returns null for an unknown employee or date', () => {
    expect(findStepTarget(employees, 'all', { employeeId: 'nope', date: '2026-11-05' }, 'next')).toBeNull()
    expect(findStepTarget(employees, 'needs', { employeeId: '1', date: '2030-01-01' }, 'next')).toBeNull()
  })
})

// ─── applySaveResult / describeBlockers ───────────────────────────────────────

function reviewFixture(overrides: Partial<PunchReview> = {}): PunchReview {
  return {
    weekId: '2026-11-05',
    week,
    status: 'REVIEW',
    mode: { kind: 'LIVE' },
    locked: false,
    employees: [employee('1', 'A', { '2026-11-05': incompleteRows }), employee('2', 'B')],
    dates,
    counts: { needsFixingDays: 1, noPunchEmployees: 1, unusualDays: 0, unresolvedCodes: 0, pendingDecisions: 0, editedDays: 0 },
    totals: { byDay: [], regular: 0, overtime: 0 },
    approval: { canApprove: false, blockers: ['NEEDS_FIXING'], weekHasEnded: true },
    payroll: { status: 'NOT_GENERATED', payrollRunId: null, activeCorrectionId: null },
    lastSavedAt: null,
    approvedAt: null,
    ...overrides,
  }
}

describe('applySaveResult', () => {
  const fixedDay = buildDayView('2026-11-05', pairRows('x', 0, '08:00', '16:00'))
  const result: SavePunchEditResult = {
    day: fixedDay,
    employeeTotals: { regular: 8, overtime: 0, hasAnyPunch: true },
    counts: { needsFixingDays: 0, noPunchEmployees: 1, unusualDays: 0, unresolvedCodes: 0, pendingDecisions: 0, editedDays: 1 },
    totals: { byDay: [{ date: '2026-11-05', regular: 8, overtime: 0 }], regular: 8, overtime: 0 },
    approval: { canApprove: true, blockers: [], weekHasEnded: true },
    savedAt: '2026-11-12T01:00:00.000Z',
  }

  it('replaces the saved day, the employee totals and the review-level counts', () => {
    const next = applySaveResult(reviewFixture(), '1', '2026-11-05', result)
    const a = next.employees.find((e) => e.employeeId === '1')!
    expect(a.days[0]).toBe(fixedDay)
    expect(a.totalRegularHours).toBe(8)
    expect(a.hasAnyPunch).toBe(true)
    expect(next.counts.needsFixingDays).toBe(0)
    expect(next.totals.regular).toBe(8)
    expect(next.approval.canApprove).toBe(true)
    expect(next.lastSavedAt).toBe('2026-11-12T01:00:00.000Z')
  })

  it('leaves other employees and other days untouched', () => {
    const before = reviewFixture()
    const next = applySaveResult(before, '1', '2026-11-05', result)
    expect(next.employees.find((e) => e.employeeId === '2')).toBe(before.employees[1])
    expect(next.employees[0].days.slice(1)).toEqual(before.employees[0].days.slice(1))
  })

  it('does not mutate the original review', () => {
    const before = reviewFixture()
    applySaveResult(before, '1', '2026-11-05', result)
    expect(before.counts.needsFixingDays).toBe(1)
    expect(before.lastSavedAt).toBeNull()
  })
})

describe('describeBlockers', () => {
  const base = reviewFixture()

  it('explains a week that has not ended with the first approvable day', () => {
    const lines = describeBlockers({ ...base, approval: { canApprove: false, blockers: ['WEEK_NOT_ENDED'], weekHasEnded: false } })
    expect(lines).toEqual(["This week hasn't ended yet. You can approve it from Thu 12 Nov."])
  })

  it('pluralizes days that need fixing', () => {
    const one = describeBlockers({ ...base, counts: { ...base.counts, needsFixingDays: 1 }, approval: { ...base.approval, blockers: ['NEEDS_FIXING'] } })
    expect(one).toEqual(['1 day needs fixing first.'])
    const two = describeBlockers({ ...base, counts: { ...base.counts, needsFixingDays: 2 }, approval: { ...base.approval, blockers: ['NEEDS_FIXING'] } })
    expect(two).toEqual(['2 days need fixing first.'])
  })

  it('describes unresolved codes and pending decisions', () => {
    const lines = describeBlockers({
      ...base,
      counts: { ...base.counts, unresolvedCodes: 2, pendingDecisions: 1 },
      approval: { ...base.approval, blockers: ['UNRESOLVED_CODES', 'PENDING_DECISIONS'] },
    })
    expect(lines).toEqual(['2 codes to fix in the employee check.', '1 decision left in the employee check.'])
  })

  it('has no line when nothing blocks, or only the status blocks', () => {
    expect(describeBlockers({ ...base, approval: { canApprove: true, blockers: [], weekHasEnded: true } })).toEqual([])
    expect(describeBlockers({ ...base, approval: { canApprove: false, blockers: ['NOT_IN_REVIEW'], weekHasEnded: true } })).toEqual([])
  })
})
