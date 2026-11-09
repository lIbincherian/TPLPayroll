import { describe, it, expect } from 'vitest'
import {
  buildDayView,
  calculateDailyHours,
  formatPunchesCell,
  isEditedDay,
  isUnusualDay,
  pairsFromStoredPunches,
  validateDayPairs,
} from '../lib/hours'
import type { StoredPunchRow } from '../types/attendance-sync.types'

const pair = (inTime: string, outTime: string) => ({ in: inTime, out: outTime })

describe('calculateDailyHours (US-12.12)', () => {
  it('full day with overtime', () => {
    const result = calculateDailyHours([pair('07:40', '13:04'), pair('13:56', '17:47')])
    expect(result.regularHours).toBe(8)
    expect(result.overtimeHours).toBe(1.25)
    expect(result.totalHours).toBe(9.25)
  })

  it('under 8 hours has no overtime', () => {
    const result = calculateDailyHours([pair('08:00', '12:00')])
    expect(result.regularHours).toBe(4)
    expect(result.overtimeHours).toBe(0)
  })

  it('exactly 8 hours has no overtime', () => {
    const result = calculateDailyHours([pair('08:00', '16:00')])
    expect(result.regularHours).toBe(8)
    expect(result.overtimeHours).toBe(0)
  })

  it('does not deduct a break', () => {
    const result = calculateDailyHours([pair('08:00', '16:30')])
    expect(result.regularHours).toBe(8)
    expect(result.overtimeHours).toBe(0.5)
  })

  it('rounds to two decimals', () => {
    expect(calculateDailyHours([pair('08:00', '08:03')]).regularHours).toBe(0.05)
    expect(calculateDailyHours([pair('08:00', '11:10')]).regularHours).toBe(3.17)
  })

  it('is zero with no pairs', () => {
    expect(calculateDailyHours([])).toEqual({ regularHours: 0, overtimeHours: 0, totalHours: 0 })
  })

  it('weekly totals do not change the daily split', () => {
    for (let day = 0; day < 6; day++) {
      expect(calculateDailyHours([pair('08:00', '16:00')]).overtimeHours).toBe(0)
    }
  })

  it('counts time inside pairs only: the gap between pairs is unpaid', () => {
    const result = calculateDailyHours([pair('08:00', '12:00'), pair('13:00', '17:00')])
    expect(result.totalHours).toBe(8)
  })

  it('1.47 overtime when the last punch moves from 17:47 to 18:00 (US-12.17)', () => {
    const result = calculateDailyHours([pair('07:40', '13:04'), pair('13:56', '18:00')])
    expect(result.regularHours).toBe(8)
    expect(result.overtimeHours).toBe(1.47)
  })

  it('adding a pair recalculates (US-12.17)', () => {
    expect(calculateDailyHours([pair('08:00', '12:00'), pair('13:00', '14:00')]).regularHours).toBe(5)
  })

  it('deleting a pair recalculates (US-12.17)', () => {
    expect(calculateDailyHours([pair('08:00', '12:00')]).regularHours).toBe(4)
  })
})

describe('isUnusualDay (US-12.16)', () => {
  it('flags a day under 4 hours', () => {
    const result = isUnusualDay([pair('08:00', '11:10')])
    expect(result.unusual).toBe(true)
    expect(result.reason).toBe('Under 4 hours (3.17)')
  })

  it('does not flag exactly 4 hours', () => {
    expect(isUnusualDay([pair('08:00', '12:00')])).toEqual({ unusual: false, reason: null })
  })

  it('flags a single pair over 6 hours', () => {
    const result = isUnusualDay([pair('08:00', '14:01')])
    expect(result.unusual).toBe(true)
    expect(result.reason).toBe('One pair over 6 hours (08:00–14:01)')
  })

  it('does not flag a pair of exactly 6 hours', () => {
    expect(isUnusualDay([pair('08:00', '14:00')])).toEqual({ unusual: false, reason: null })
  })

  it('does not flag a normal two-pair day', () => {
    expect(isUnusualDay([pair('07:40', '13:04'), pair('13:56', '17:47')])).toEqual({ unusual: false, reason: null })
  })

  it('does not flag a day with no pairs', () => {
    expect(isUnusualDay([])).toEqual({ unusual: false, reason: null })
  })

  it('flags a multi-pair day whose total is under 4 hours', () => {
    expect(isUnusualDay([pair('08:00', '09:00'), pair('10:00', '11:00')]).unusual).toBe(true)
  })

  it('does not flag two 3-hour pairs (total 6 h, no single pair over 6 h)', () => {
    expect(isUnusualDay([pair('08:00', '11:00'), pair('12:00', '15:00')]).unusual).toBe(false)
  })
})

describe('validateDayPairs (US-12.18)', () => {
  it('rejects an invalid time', () => {
    const result = validateDayPairs([{ in: '25:00', out: '26:00' }])
    expect(result).toMatchObject({ valid: false, code: 'INVALID_TIME', pairIndex: 0, field: 'in' })
  })

  it('reports the OUT field when only the OUT time is invalid', () => {
    const result = validateDayPairs([{ in: '08:00', out: 'abc' }])
    expect(result).toMatchObject({ valid: false, code: 'INVALID_TIME', field: 'out' })
  })

  it('rejects OUT before IN', () => {
    const result = validateDayPairs([{ in: '17:00', out: '08:00' }])
    expect(result).toMatchObject({ valid: false, code: 'OUT_NOT_AFTER_IN', pairIndex: 0, field: 'out' })
  })

  it('rejects OUT equal to IN', () => {
    expect(validateDayPairs([{ in: '08:00', out: '08:00' }])).toMatchObject({ valid: false, code: 'OUT_NOT_AFTER_IN' })
  })

  it('rejects overlapping pairs and points at the later pair', () => {
    const result = validateDayPairs([
      { in: '08:00', out: '12:00' },
      { in: '11:30', out: '14:00' },
    ])
    expect(result).toMatchObject({ valid: false, code: 'PAIRS_OVERLAP', pairIndex: 1, field: 'in' })
  })

  it('detects overlap regardless of the order pairs are given in', () => {
    const result = validateDayPairs([
      { in: '11:30', out: '14:00' },
      { in: '08:00', out: '12:00' },
    ])
    expect(result).toMatchObject({ valid: false, code: 'PAIRS_OVERLAP' })
  })

  it('accepts valid pairs', () => {
    expect(
      validateDayPairs([
        { in: '08:00', out: '12:00' },
        { in: '13:00', out: '17:00' },
      ]),
    ).toEqual({ valid: true })
  })

  it('accepts pairs that touch (next IN equals previous OUT)', () => {
    expect(
      validateDayPairs([
        { in: '08:00', out: '12:00' },
        { in: '12:00', out: '14:00' },
      ]),
    ).toEqual({ valid: true })
  })

  it('accepts times typed without a colon or zero pad', () => {
    expect(validateDayPairs([{ in: '800', out: '1700' }])).toEqual({ valid: true })
  })

  it('ignores a pair with both times blank', () => {
    expect(validateDayPairs([{ in: null, out: null }, { in: '08:00', out: '09:00' }])).toEqual({ valid: true })
  })

  it('accepts no pairs', () => {
    expect(validateDayPairs([])).toEqual({ valid: true })
  })

  it('uses the given pairIndex in errors', () => {
    const result = validateDayPairs([{ in: '17:00', out: '08:00', pairIndex: 4 }])
    expect(result).toMatchObject({ valid: false, pairIndex: 4 })
  })

  it('accepts an incomplete pair on its own', () => {
    expect(validateDayPairs([{ in: '18:26', out: null }])).toEqual({ valid: true })
  })

  it('rejects the lone time of an incomplete pair that falls strictly inside a complete pair', () => {
    const result = validateDayPairs([
      { in: '08:00', out: '12:00' },
      { in: '10:00', out: null },
    ])
    expect(result).toMatchObject({ valid: false, code: 'PAIRS_OVERLAP', field: 'in' })
  })

  it('accepts a lone time at the edge of a complete pair', () => {
    expect(
      validateDayPairs([
        { in: '08:00', out: '12:00' },
        { in: '12:00', out: null },
      ]),
    ).toEqual({ valid: true })
  })

  it('accepts a lone time outside every complete pair', () => {
    expect(
      validateDayPairs([
        { in: '08:00', out: '12:00' },
        { in: null, out: '18:26' },
      ]),
    ).toEqual({ valid: true })
  })

  it('returns an error message string for the UI', () => {
    const result = validateDayPairs([{ in: '17:00', out: '08:00' }])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.message.length).toBeGreaterThan(0)
  })
})

describe('isEditedDay (US-12.20, C9)', () => {
  it('is true after an edit', () => {
    expect(isEditedDay([{ original: '17:47', current: '18:00', source: 'API' }])).toBe(true)
  })

  it('is false for an untouched day', () => {
    expect(
      isEditedDay([
        { original: '07:40', current: '07:40', source: 'API' },
        { original: '17:47', current: '17:47', source: 'API' },
      ]),
    ).toBe(false)
  })

  it('is true for a hand-added punch (original null)', () => {
    expect(isEditedDay([{ original: null, current: '08:00', source: 'MANUAL' }])).toBe(true)
  })

  it('is true for a deleted API punch (current null)', () => {
    expect(isEditedDay([{ original: '18:26', current: null, source: 'API' }])).toBe(true)
  })

  it('is false for no punches', () => {
    expect(isEditedDay([])).toBe(false)
  })
})

describe('formatPunchesCell (US-12.32)', () => {
  it('joins pairs with an en dash and a comma', () => {
    expect(formatPunchesCell([pair('07:40', '13:04'), pair('13:56', '17:47')])).toBe('07:40–13:04, 13:56–17:47')
  })

  it('handles a single pair', () => {
    expect(formatPunchesCell([pair('08:00', '16:00')])).toBe('08:00–16:00')
  })

  it('has no edit marker', () => {
    expect(formatPunchesCell([pair('07:40', '18:00')])).toBe('07:40–18:00')
  })

  it('uses U+2013 not a hyphen', () => {
    expect(formatPunchesCell([pair('08:00', '16:00')])).toContain('–')
    expect(formatPunchesCell([pair('08:00', '16:00')])).not.toContain('-')
  })

  it('is an empty string with no pairs (callers show "-")', () => {
    expect(formatPunchesCell([])).toBe('')
  })
})

// ─── Stored punches → views ───────────────────────────────────────────────────

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

const fullDay = (): StoredPunchRow[] => [
  row('a', 0, 'IN', '07:40', '07:40'),
  row('b', 0, 'OUT', '13:04', '13:04'),
  row('c', 1, 'IN', '13:56', '13:56'),
  row('d', 1, 'OUT', '17:47', '17:47'),
]

describe('pairsFromStoredPunches', () => {
  it('groups IN/OUT rows by pairIndex and computes hours', () => {
    const pairs = pairsFromStoredPunches(fullDay())
    expect(pairs).toHaveLength(2)
    expect(pairs[0]).toMatchObject({ pairIndex: 0, hours: 5.4 })
    expect(pairs[0].in?.time).toBe('07:40')
    expect(pairs[0].out?.time).toBe('13:04')
    expect(pairs[1]).toMatchObject({ pairIndex: 1, hours: 3.85 })
  })

  it('orders by pairIndex regardless of input order and allows gaps', () => {
    const pairs = pairsFromStoredPunches([
      row('c', 5, 'IN', null, '13:00', { source: 'MANUAL' }),
      row('d', 5, 'OUT', null, '14:00', { source: 'MANUAL' }),
      row('a', 0, 'IN', '08:00', '08:00'),
      row('b', 0, 'OUT', '12:00', '12:00'),
    ])
    expect(pairs.map((p) => p.pairIndex)).toEqual([0, 5])
  })

  it('gives 0 hours to an incomplete pair', () => {
    const pairs = pairsFromStoredPunches([row('a', 0, 'IN', '18:26', '18:26')])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].out).toBeNull()
    expect(pairs[0].hours).toBe(0)
  })

  it('gives 0 hours when one side was deleted (current null)', () => {
    const pairs = pairsFromStoredPunches([row('a', 0, 'IN', '08:00', '08:00'), row('b', 0, 'OUT', '12:00', null)])
    expect(pairs[0].hours).toBe(0)
    expect(pairs[0].out?.time).toBeNull()
    expect(pairs[0].out?.original).toBe('12:00')
  })

  it('exposes the note, source and merged scans on the punch view', () => {
    const [p] = pairsFromStoredPunches([
      row('a', 0, 'IN', '07:40', '07:40', { note: 'ok', mergedScansJson: ['07:41'] }),
      row('b', 0, 'OUT', '13:04', '13:04'),
    ])
    expect(p.in).toMatchObject({ id: 'a', note: 'ok', source: 'API', mergedScans: ['07:41'] })
  })

  it('returns an empty list for no rows', () => {
    expect(pairsFromStoredPunches([])).toEqual([])
  })
})

describe('buildDayView', () => {
  it('builds a normal full day (US-12.10 / 12.12)', () => {
    const day = buildDayView('2026-11-05', fullDay())
    expect(day.date).toBe('2026-11-05')
    expect(day.pairs).toHaveLength(2)
    expect(day.incomplete).toBe(false)
    expect(day.regularHours).toBe(8)
    expect(day.overtimeHours).toBe(1.25)
    expect(day.totalHours).toBe(9.25)
    expect(day.isEdited).toBe(false)
    expect(day.isMerged).toBe(false)
    expect(day.isUnusual).toBe(false)
    expect(day.unusualReason).toBeNull()
    expect(day.changes).toEqual([])
  })

  it('marks an edit with original and current times, and recalculates (E2E-18)', () => {
    const rows = fullDay()
    rows[3] = row('d', 1, 'OUT', '17:47', '18:00')
    const day = buildDayView('2026-11-05', rows)
    expect(day.isEdited).toBe(true)
    expect(day.regularHours).toBe(8)
    expect(day.overtimeHours).toBe(1.47)
    expect(day.changes).toEqual([
      { punchId: 'd', original: '17:47', current: '18:00', note: null, kind: 'EDITED' },
    ])
    // The original API time is kept on the punch view
    expect(day.pairs[1].out).toMatchObject({ time: '18:00', original: '17:47' })
  })

  it('typing the original time back clears the Edited marker (C9) but keeps the note', () => {
    const rows = fullDay()
    rows[3] = row('d', 1, 'OUT', '17:47', '17:47', { note: 'Forgot to scan out' })
    const day = buildDayView('2026-11-05', rows)
    expect(day.isEdited).toBe(false)
    expect(day.changes).toEqual([])
    expect(day.pairs[1].out?.note).toBe('Forgot to scan out')
  })

  it('stores a note when given and shows it on the change', () => {
    const rows = fullDay()
    rows[3] = row('d', 1, 'OUT', '17:47', '18:00', { note: 'Forgot to scan out' })
    expect(buildDayView('2026-11-05', rows).changes[0].note).toBe('Forgot to scan out')
  })

  it('an edit does not need a note', () => {
    const rows = fullDay()
    rows[3] = row('d', 1, 'OUT', '17:47', '18:00')
    expect(buildDayView('2026-11-05', rows).changes[0].note).toBeNull()
  })

  it('a lone punch is an incomplete day with zero hours and is not flagged unusual (US-12.14)', () => {
    const day = buildDayView('2026-11-06', [row('a', 0, 'IN', '18:26', '18:26')])
    expect(day.incomplete).toBe(true)
    expect(day.regularHours).toBe(0)
    expect(day.overtimeHours).toBe(0)
    expect(day.isUnusual).toBe(false)
  })

  it('an incomplete day is never unusual even when its complete pair alone would be', () => {
    const day = buildDayView('2026-11-06', [
      row('a', 0, 'IN', '08:00', '08:00'),
      row('b', 0, 'OUT', '09:00', '09:00'),
      row('c', 1, 'IN', '18:26', '18:26'),
    ])
    expect(day.incomplete).toBe(true)
    expect(day.isUnusual).toBe(false)
    expect(day.totalHours).toBe(1)
  })

  it('deleting the only punch leaves zero hours and no incomplete pair (US-12.17)', () => {
    const day = buildDayView('2026-11-06', [row('a', 0, 'IN', '18:26', null)])
    expect(day.incomplete).toBe(false)
    expect(day.pairs).toEqual([])
    expect(day.regularHours).toBe(0)
    expect(day.changes).toEqual([{ punchId: 'a', original: '18:26', current: null, note: null, kind: 'DELETED' }])
    expect(day.isEdited).toBe(true)
  })

  it('deleting one punch of a complete pair makes the day incomplete', () => {
    const day = buildDayView('2026-11-05', [row('a', 0, 'IN', '08:00', '08:00'), row('b', 0, 'OUT', '16:00', null)])
    expect(day.incomplete).toBe(true)
    expect(day.regularHours).toBe(0)
  })

  it('hand-added pairs are listed as ADDED and calculate hours (US-12.15)', () => {
    const day = buildDayView('2026-11-05', [
      row('m1', 0, 'IN', null, '08:00', { source: 'MANUAL' }),
      row('m2', 0, 'OUT', null, '16:00', { source: 'MANUAL' }),
    ])
    expect(day.regularHours).toBe(8)
    expect(day.isEdited).toBe(true)
    expect(day.changes.map((c) => c.kind)).toEqual(['ADDED', 'ADDED'])
    expect(day.pairs[0].in?.source).toBe('MANUAL')
  })

  it('flags a merged day from mergedScansJson', () => {
    const rows = fullDay()
    rows[0] = row('a', 0, 'IN', '07:40', '07:40', { mergedScansJson: ['07:41'] })
    expect(buildDayView('2026-11-05', rows).isMerged).toBe(true)
  })

  it('ignores a malformed mergedScansJson', () => {
    const rows = fullDay()
    rows[0] = row('a', 0, 'IN', '07:40', '07:40', { mergedScansJson: { not: 'an array' } })
    expect(buildDayView('2026-11-05', rows).isMerged).toBe(false)
    rows[0] = row('a', 0, 'IN', '07:40', '07:40', { mergedScansJson: [] })
    expect(buildDayView('2026-11-05', rows).isMerged).toBe(false)
  })

  it('highlights a short complete day as unusual with a reason', () => {
    const day = buildDayView('2026-11-05', [row('a', 0, 'IN', '08:00', '08:00'), row('b', 0, 'OUT', '11:10', '11:10')])
    expect(day.isUnusual).toBe(true)
    expect(day.unusualReason).toBe('Under 4 hours (3.17)')
    expect(day.incomplete).toBe(false)
  })

  it('an empty day has no pairs, no hours and is not flagged', () => {
    const day = buildDayView('2026-11-07', [])
    expect(day).toMatchObject({
      pairs: [],
      incomplete: false,
      regularHours: 0,
      overtimeHours: 0,
      totalHours: 0,
      isEdited: false,
      isMerged: false,
      isUnusual: false,
      changes: [],
    })
  })
})
