import { describe, it, expect } from 'vitest'
import {
  draftFromDay,
  hasUnsavedChanges,
  isEmptyDraftPair,
  nextPairIndex,
  normalizeDraft,
  normalizeSide,
  reconcileDraft,
  toSavePairs,
  toValidationPairs,
  type DraftPair,
} from '../lib/day-draft'
import { buildDayView } from '../lib/hours'
import type { StoredPunchRow } from '../types/attendance-sync.types'

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

const fullDay = () =>
  buildDayView('2026-11-05', [
    row('a', 0, 'IN', '07:40', '07:40'),
    row('b', 0, 'OUT', '13:04', '13:04'),
    row('c', 1, 'IN', '13:56', '13:56'),
    row('d', 1, 'OUT', '17:47', '17:47'),
  ])

const emptyDay = () => buildDayView('2026-11-07', [])

const blankPair = (pairIndex: number): DraftPair => ({ pairIndex, in: { value: '' }, out: { value: '' } })

describe('isEmptyDraftPair', () => {
  it('is true for two blank sides with no stored punch', () => {
    expect(isEmptyDraftPair(blankPair(0))).toBe(true)
    expect(isEmptyDraftPair({ pairIndex: 0, in: { value: '  ' }, out: { value: '' } })).toBe(true)
  })

  it('is false when a side has text', () => {
    expect(isEmptyDraftPair({ pairIndex: 0, in: { value: '08:00' }, out: { value: '' } })).toBe(false)
  })

  it('is false when a stored punch is being cleared (deletion must still be sent)', () => {
    expect(isEmptyDraftPair({ pairIndex: 0, in: { punchId: 'a', value: '' }, out: { value: '' } })).toBe(false)
  })
})

describe('nextPairIndex', () => {
  it('is 0 for an empty day', () => {
    expect(nextPairIndex(emptyDay())).toBe(0)
  })

  it('is one past the highest saved pair', () => {
    expect(nextPairIndex(fullDay())).toBe(2)
  })

  it('also counts pairs in the draft', () => {
    expect(nextPairIndex(fullDay(), [blankPair(5)])).toBe(6)
  })
})

describe('draftFromDay', () => {
  it('gives an empty day one blank pair, ready to type in', () => {
    expect(draftFromDay(emptyDay())).toEqual([blankPair(0)])
  })

  it('turns a saved day into pairs carrying punch ids and times', () => {
    expect(draftFromDay(fullDay())).toEqual([
      { pairIndex: 0, in: { punchId: 'a', value: '07:40' }, out: { punchId: 'b', value: '13:04' } },
      { pairIndex: 1, in: { punchId: 'c', value: '13:56' }, out: { punchId: 'd', value: '17:47' } },
    ])
  })

  it('shows a deleted punch as a blank field that still carries its id', () => {
    const day = buildDayView('2026-11-05', [row('a', 0, 'IN', '08:00', '08:00'), row('b', 0, 'OUT', '16:00', null)])
    expect(draftFromDay(day)).toEqual([
      { pairIndex: 0, in: { punchId: 'a', value: '08:00' }, out: { punchId: 'b', value: '' } },
    ])
  })
})

describe('reconcileDraft', () => {
  it('rebuilds the draft from the saved day when nothing changed during the save', () => {
    const day = fullDay()
    const sent = draftFromDay(day)
    expect(reconcileDraft(day, sent, sent)).toEqual(draftFromDay(day))
  })

  it('keeps text typed into a field while the request was in flight', () => {
    const day = fullDay()
    const sent = draftFromDay(day)
    const current = sent.map((p) => (p.pairIndex === 1 ? { ...p, out: { ...p.out, value: '18:30' } } : p))
    const result = reconcileDraft(day, current, sent)
    expect(result[1].out).toEqual({ punchId: 'd', value: '18:30' })
    expect(result[0]).toEqual(draftFromDay(day)[0])
  })

  it('keeps a blank row the user added meanwhile', () => {
    const day = fullDay()
    const sent = draftFromDay(day)
    const current = [...sent, blankPair(2)]
    const result = reconcileDraft(day, current, sent)
    expect(result).toHaveLength(3)
    expect(result[2]).toEqual(blankPair(2))
  })

  it('keeps a pair added meanwhile that was not part of the request', () => {
    const day = fullDay()
    const sent = draftFromDay(day)
    const added: DraftPair = { pairIndex: 2, in: { value: '19:00' }, out: { value: '' } }
    const result = reconcileDraft(day, [...sent, added], sent)
    expect(result.map((p) => p.pairIndex)).toEqual([0, 1, 2])
    expect(result[2].in.value).toBe('19:00')
  })

  it('drops a sent new pair once the saved day returns it (no duplicate)', () => {
    // The user typed a new pair at index 2, saved it; the saved day now contains it.
    const saved = buildDayView('2026-11-05', [
      row('a', 0, 'IN', '08:00', '08:00'),
      row('b', 0, 'OUT', '12:00', '12:00'),
      row('n1', 2, 'IN', null, '13:00', { source: 'MANUAL' }),
      row('n2', 2, 'OUT', null, '14:00', { source: 'MANUAL' }),
    ])
    const sent: DraftPair[] = [
      { pairIndex: 0, in: { punchId: 'a', value: '08:00' }, out: { punchId: 'b', value: '12:00' } },
      { pairIndex: 2, in: { value: '13:00' }, out: { value: '14:00' } },
    ]
    const result = reconcileDraft(saved, sent, sent)
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({ pairIndex: 2, in: { punchId: 'n1', value: '13:00' }, out: { punchId: 'n2', value: '14:00' } })
  })

  it('falls back to a single blank pair when everything was deleted', () => {
    const emptied = buildDayView('2026-11-06', [row('a', 0, 'IN', '18:26', null)])
    const sent: DraftPair[] = [{ pairIndex: 0, in: { punchId: 'a', value: '' }, out: { value: '' } }]
    const result = reconcileDraft(emptied, sent, sent)
    expect(result).toEqual([blankPair(0)])
  })
})

describe('normalizeSide / normalizeDraft', () => {
  it('fixes 1747 to 17:47', () => {
    expect(normalizeSide({ value: '1747' })).toEqual({ value: '17:47' })
  })

  it('pads a single digit hour', () => {
    expect(normalizeSide({ value: '8:05' })).toEqual({ value: '08:05' })
  })

  it('blank text becomes an empty string and keeps the punch id', () => {
    expect(normalizeSide({ punchId: 'a', value: '   ' })).toEqual({ punchId: 'a', value: '' })
  })

  it('leaves unreadable text alone, trimmed, for validation to report', () => {
    expect(normalizeSide({ value: ' 25:00 ' })).toEqual({ value: '25:00' })
    expect(normalizeSide({ value: 'abc' })).toEqual({ value: 'abc' })
  })

  it('normalizeDraft normalizes both sides of every pair', () => {
    expect(
      normalizeDraft([{ pairIndex: 0, in: { value: '800' }, out: { value: '1700' } }]),
    ).toEqual([{ pairIndex: 0, in: { value: '08:00' }, out: { value: '17:00' } }])
  })
})

describe('toValidationPairs', () => {
  it('maps blanks to null and trims the rest', () => {
    expect(
      toValidationPairs([
        { pairIndex: 0, in: { value: ' 08:00 ' }, out: { value: '' } },
        { pairIndex: 3, in: { value: '' }, out: { value: '17:00' } },
        blankPair(4),
      ]),
    ).toEqual([
      { pairIndex: 0, in: '08:00', out: null },
      { pairIndex: 3, in: null, out: '17:00' },
      { pairIndex: 4, in: null, out: null },
    ])
  })
})

describe('toSavePairs', () => {
  it('sends the whole day, normalizing the times', () => {
    const result = toSavePairs(
      [{ pairIndex: 0, in: { punchId: 'a', value: '800' }, out: { punchId: 'b', value: '1700' } }],
      {},
    )
    expect(result).toEqual([
      {
        pairIndex: 0,
        in: { punchId: 'a', time: '08:00', note: undefined },
        out: { punchId: 'b', time: '17:00', note: undefined },
      },
    ])
  })

  it('leaves out a pair with no times and no stored punch', () => {
    expect(toSavePairs([blankPair(0), { pairIndex: 1, in: { value: '09:00' }, out: { value: '10:00' } }], {})).toHaveLength(1)
  })

  it('sends a cleared stored punch as time null so it is deleted', () => {
    const [saved] = toSavePairs([{ pairIndex: 0, in: { punchId: 'a', value: '' }, out: { punchId: 'b', value: '16:00' } }], {})
    expect(saved.in).toMatchObject({ punchId: 'a', time: null })
    expect(saved.out).toMatchObject({ punchId: 'b', time: '16:00' })
  })

  it('maps notes by punch id and leaves other notes undefined', () => {
    const [saved] = toSavePairs(
      [{ pairIndex: 0, in: { punchId: 'a', value: '08:00' }, out: { punchId: 'b', value: '16:00' } }],
      { b: 'Forgot to scan out' },
    )
    expect(saved.in.note).toBeUndefined()
    expect(saved.out.note).toBe('Forgot to scan out')
  })

  it('keeps unreadable text as typed so the server can reject it', () => {
    const [saved] = toSavePairs([{ pairIndex: 0, in: { value: '25:00' }, out: { value: '26:00' } }], {})
    expect(saved.in.time).toBe('25:00')
  })
})

describe('hasUnsavedChanges', () => {
  it('is false for an untouched draft', () => {
    const day = fullDay()
    expect(hasUnsavedChanges(day, draftFromDay(day), {})).toBe(false)
  })

  it('is false for a blank draft of an empty day', () => {
    const day = emptyDay()
    expect(hasUnsavedChanges(day, draftFromDay(day), {})).toBe(false)
  })

  it('is true when a time changed', () => {
    const day = fullDay()
    const draft = draftFromDay(day)
    draft[1].out.value = '18:00'
    expect(hasUnsavedChanges(day, draft, {})).toBe(true)
  })

  it('treats 1747 as the saved 17:47 (normalized before comparing)', () => {
    const day = fullDay()
    const draft = draftFromDay(day)
    draft[1].out.value = '1747'
    expect(hasUnsavedChanges(day, draft, {})).toBe(false)
  })

  it('is true when a pair is added', () => {
    const day = fullDay()
    const draft = [...draftFromDay(day), { pairIndex: 2, in: { value: '19:00' }, out: { value: '20:00' } }]
    expect(hasUnsavedChanges(day, draft, {})).toBe(true)
  })

  it('is true when a time is cleared', () => {
    const day = fullDay()
    const draft = draftFromDay(day)
    draft[0].in.value = ''
    expect(hasUnsavedChanges(day, draft, {})).toBe(true)
  })

  it('is true when a note changed', () => {
    const day = fullDay()
    expect(hasUnsavedChanges(day, draftFromDay(day), { d: 'a new note' })).toBe(true)
  })

  it('is false when the note equals the saved note (ignoring surrounding spaces)', () => {
    const day = buildDayView('2026-11-05', [
      row('a', 0, 'IN', '08:00', '08:00', { note: 'kept' }),
      row('b', 0, 'OUT', '16:00', '16:00'),
    ])
    expect(hasUnsavedChanges(day, draftFromDay(day), { a: ' kept ' })).toBe(false)
  })
})
