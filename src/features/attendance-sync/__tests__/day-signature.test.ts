// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { punchSetSignature } from '../lib/day-signature'
import { buildGridEmployees, punchSetSignature as reExported } from '../lib/review'
import { buildDayView } from '../lib/hours'
import { getWeekDates, weekFromStartISO } from '../lib/week'
import type { StoredPunchRow } from '../types/attendance-sync.types'

// Round 4, item 1: the version token of one employee-day. A conflict token, not a security boundary: it
// has to tell every change of the stored rows apart, stay small enough for the review payload, and be
// safe to import in the client bundle.

const row = (over: Partial<StoredPunchRow> = {}): StoredPunchRow => ({
  id: 'a',
  pairIndex: 0,
  position: 'IN',
  source: 'API',
  originalTime: '07:40',
  currentTime: '07:40',
  note: null,
  ...over,
})

const fullDay = (): StoredPunchRow[] => [
  row({ id: 'p-0', pairIndex: 0, position: 'IN', originalTime: '07:40', currentTime: '07:40' }),
  row({ id: 'p-1', pairIndex: 0, position: 'OUT', originalTime: '13:04', currentTime: '13:04' }),
  row({ id: 'p-2', pairIndex: 1, position: 'IN', originalTime: '13:56', currentTime: '13:56' }),
  row({ id: 'p-3', pairIndex: 1, position: 'OUT', originalTime: '17:47', currentTime: '17:47' }),
]

describe('punchSetSignature: shape of the token', () => {
  it('is "<row count>.<base36 hash>"', () => {
    expect(punchSetSignature(fullDay())).toMatch(/^4\.[0-9a-z]+$/)
    expect(punchSetSignature([row()])).toMatch(/^1\.[0-9a-z]+$/)
  })

  it('an empty day is "0.<hash>", never an empty string, and always the same token', () => {
    expect(punchSetSignature([])).toMatch(/^0\.[0-9a-z]+$/)
    expect(punchSetSignature([])).toBe(punchSetSignature([]))
  })

  it('stays within the 64 characters the action accepts, even for a thousand rows', () => {
    const many = Array.from({ length: 1000 }, (_, i) => row({ id: `row-${i}`, pairIndex: i }))

    expect(punchSetSignature(many).length).toBeLessThanOrEqual(64)
    expect(punchSetSignature(fullDay()).length).toBeLessThanOrEqual(64)
    expect(punchSetSignature([]).length).toBeLessThanOrEqual(64)
    expect(punchSetSignature(many).startsWith('1000.')).toBe(true)
  })

  it('does not carry the rows themselves (no time, id or note can be read from the token)', () => {
    const token = punchSetSignature([row({ id: 'secret-id', note: 'private words', currentTime: '07:41' })])

    expect(token).not.toContain('secret-id')
    expect(token).not.toContain('private')
    expect(token).not.toContain('07:41')
  })

  it('the review module still exports the same function (existing imports keep working)', () => {
    expect(reExported).toBe(punchSetSignature)
  })

  it('is pure: it does not reorder or change the rows it is given', () => {
    const rows = [row({ id: 'z' }), row({ id: 'b' }), row({ id: 'm' })]
    const before = JSON.stringify(rows)

    punchSetSignature(rows)

    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('punchSetSignature: separators and quotes in a note cannot fake another row', () => {
  it('a note containing "|" does not collide with the same text spread over the neighbouring fields', () => {
    // Joined with "|" these two would both read: 07:40|07:40|a|b
    const inNote = [row({ originalTime: '07:40', currentTime: '07:40', note: 'a|b' })]
    const spread = [row({ originalTime: '07:40', currentTime: '07:40|a', note: 'b' })]

    expect(punchSetSignature(inNote)).not.toBe(punchSetSignature(spread))
  })

  it('a note ending in "|" differs from the next field starting the same way', () => {
    expect(punchSetSignature([row({ note: 'x|' })])).not.toBe(punchSetSignature([row({ note: 'x', currentTime: '|07:40' })]))
  })

  it('a note containing a double quote or a comma does not collide with a neighbouring field', () => {
    const inNote = [row({ currentTime: '07:40', note: 'a","b' })]
    const spread = [row({ currentTime: '07:40","a', note: 'b' })]

    expect(punchSetSignature(inNote)).not.toBe(punchSetSignature(spread))
  })

  it('a note with a backslash, a newline and a quote is a stable token, different from the plain note', () => {
    const odd = row({ note: 'line1\nline2 \\ "quoted"' })

    expect(punchSetSignature([odd])).toBe(punchSetSignature([{ ...odd }]))
    expect(punchSetSignature([odd])).not.toBe(punchSetSignature([row({ note: 'line1 line2' })]))
  })

  it('an id containing "|" cannot be mistaken for another id and pair index', () => {
    expect(punchSetSignature([row({ id: 'a|1', pairIndex: 0 })])).not.toBe(punchSetSignature([row({ id: 'a', pairIndex: 1 })]))
  })

  it('moving a note from one row to the other row is a change', () => {
    const first = row({ id: 'a', note: 'why' })
    const second = row({ id: 'b', position: 'OUT', originalTime: '13:04', currentTime: '13:04' })
    const noteMoved = [{ ...first, note: null }, { ...second, note: 'why' }]

    expect(punchSetSignature([first, second])).not.toBe(punchSetSignature(noteMoved))
  })

  it('text outside ASCII (Devanagari, an emoji) gives a stable token that differs from an ASCII note', () => {
    const hindi = row({ note: 'देर से आया' })
    const emoji = row({ note: 'late 😴' })

    expect(punchSetSignature([hindi])).toBe(punchSetSignature([{ ...hindi }]))
    expect(punchSetSignature([hindi])).not.toBe(punchSetSignature([emoji]))
    expect(punchSetSignature([emoji])).not.toBe(punchSetSignature([row({ note: 'late' })]))
  })
})

describe('punchSetSignature: null and the empty string are different values', () => {
  it.each(['note', 'currentTime', 'originalTime'] as const)('%s: null differs from the empty string', (field) => {
    const withNull = row({ [field]: null } as Partial<StoredPunchRow>)
    const withEmpty = row({ [field]: '' } as unknown as Partial<StoredPunchRow>)

    expect(punchSetSignature([withNull])).not.toBe(punchSetSignature([withEmpty]))
  })

  it.each(['note', 'currentTime', 'originalTime'] as const)('%s: null differs from a real value, and the empty string from a real value', (field) => {
    const real = row({ [field]: field === 'note' ? 'x' : '07:41' } as Partial<StoredPunchRow>)

    expect(punchSetSignature([row({ [field]: null } as Partial<StoredPunchRow>)])).not.toBe(punchSetSignature([real]))
    expect(punchSetSignature([row({ [field]: '' } as unknown as Partial<StoredPunchRow>)])).not.toBe(punchSetSignature([real]))
  })
})

describe('punchSetSignature: what it follows and what it ignores', () => {
  it('is the same whatever order the rows come in (every permutation of a full day)', () => {
    const rows = fullDay()
    const permutations: StoredPunchRow[][] = []
    const permute = (rest: StoredPunchRow[], chosen: StoredPunchRow[]) => {
      if (rest.length === 0) permutations.push(chosen)
      rest.forEach((r, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, r]))
    }
    permute(rows, [])

    expect(permutations).toHaveLength(24)
    expect(new Set(permutations.map((p) => punchSetSignature(p))).size).toBe(1)
  })

  it('orders ids as text, so "p-10" and "p-9" are signed the same in either order', () => {
    const a = row({ id: 'p-10' })
    const b = row({ id: 'p-9', position: 'OUT' })

    expect(punchSetSignature([a, b])).toBe(punchSetSignature([b, a]))
  })

  it('ignores updatedAt and mergedScansJson', () => {
    const plain = punchSetSignature([row()])

    expect(punchSetSignature([{ ...row(), mergedScansJson: [{ time: '07:40' }] }])).toBe(plain)
    expect(punchSetSignature([{ ...row(), mergedScansJson: null }])).toBe(plain)
    expect(punchSetSignature([{ ...row(), updatedAt: new Date('2031-01-01T00:00:00Z') } as StoredPunchRow])).toBe(plain)
  })

  it('is told apart from a day with the same row twice (the count is part of the token)', () => {
    expect(punchSetSignature([row(), row()])).not.toBe(punchSetSignature([row()]))
  })

  it('tells all 1440 times of a day apart (no two minutes share a token)', () => {
    const tokens = new Set<string>()
    for (let minutes = 0; minutes < 1440; minutes++) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      tokens.add(punchSetSignature([row({ currentTime: time as StoredPunchRow['currentTime'] })]))
    }

    expect(tokens.size).toBe(1440)
  })

  it('tells 5000 different days of one row each apart (hash quality, no collision in a realistic sample)', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 5000; i++) tokens.add(punchSetSignature([row({ id: `id-${i}`, pairIndex: i % 7, note: `n${i}` })]))

    expect(tokens.size).toBe(5000)
  })
})

describe('punchSetSignature is safe for the client bundle', () => {
  const source = readFileSync(path.resolve(__dirname, '../lib/day-signature.ts'), 'utf8')

  it('imports nothing but types', () => {
    const imports = source.match(/^import .*$/gm) ?? []

    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toMatch(/^import type /)
  })

  it('does not use node:crypto or the crypto module', () => {
    expect(source).not.toMatch(/node:crypto|from ['"]crypto['"]|require\(['"]crypto['"]\)|createHash/)
  })
})

// ─── DayView.signature ────────────────────────────────────────────────────────

describe('buildDayView carries the signature of the rows it was built from', () => {
  it('signature equals punchSetSignature(rows) for a full day', () => {
    const rows = fullDay()

    expect(buildDayView('2026-11-05', rows).signature).toBe(punchSetSignature(rows))
  })

  it('an empty day has a signature too, and it is not an empty string', () => {
    const day = buildDayView('2026-11-07', [])

    expect(day.signature).toBe(punchSetSignature([]))
    expect(day.signature).not.toBe('')
  })

  it('a day whose only rows are deleted API punches has no pairs but is not signed as an empty day', () => {
    const deleted = [
      row({ id: 'd-0', position: 'IN', originalTime: '08:00', currentTime: null }),
      row({ id: 'd-1', position: 'OUT', originalTime: '16:00', currentTime: null }),
    ]

    const day = buildDayView('2026-11-05', deleted)

    expect(day.pairs).toHaveLength(0) // the deleted pair is filtered out of the view...
    expect(day.signature).toBe(punchSetSignature(deleted)) // ...but not out of the version
    expect(day.signature).not.toBe(buildDayView('2026-11-05', []).signature)
  })

  it('changes when a time, a note, or the set of rows changes; not when only the order or merged scans change', () => {
    const base = buildDayView('2026-11-05', fullDay()).signature

    const timeChanged = fullDay()
    timeChanged[3] = { ...timeChanged[3], currentTime: '18:00' }
    const noteChanged = fullDay()
    noteChanged[0] = { ...noteChanged[0], note: 'came early' }
    const added = [...fullDay(), row({ id: 'm-0', source: 'MANUAL', pairIndex: 2, originalTime: null, currentTime: '19:00' })]
    const reordered = [...fullDay()].reverse()
    const merged = fullDay().map((r) => ({ ...r, mergedScansJson: [{ time: r.currentTime }] }))

    expect(buildDayView('2026-11-05', timeChanged).signature).not.toBe(base)
    expect(buildDayView('2026-11-05', noteChanged).signature).not.toBe(base)
    expect(buildDayView('2026-11-05', added).signature).not.toBe(base)
    expect(buildDayView('2026-11-05', reordered).signature).toBe(base)
    expect(buildDayView('2026-11-05', merged).signature).toBe(base)
  })

  it('the date of the view is not part of the signature (it signs the rows)', () => {
    expect(buildDayView('2026-11-05', fullDay()).signature).toBe(buildDayView('2026-11-06', fullDay()).signature)
  })
})

describe('buildGridEmployees gives every day its own signature', () => {
  const dates = getWeekDates(weekFromStartISO('2026-11-05'))
  const employee = { id: 'emp-1', employeeId: 'TPL001', employeeName: 'Asha Rao', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const }
  const day = (date: string) => new Date(`${date}T00:00:00Z`)

  it('each day signs the rows of that employee on that date, and empty days share the empty token', () => {
    const punches = [
      ...fullDay().map((r) => ({ ...r, employeeId: 'emp-1', punchDate: day('2026-11-05') })),
      { ...row({ id: 'x-0' }), employeeId: 'emp-1', punchDate: day('2026-11-06') },
      { ...row({ id: 'o-0' }), employeeId: 'emp-2', punchDate: day('2026-11-05') }, // someone else's punch
    ]

    const [grid] = buildGridEmployees([employee], punches, dates)

    expect(grid.days[0].signature).toBe(punchSetSignature(fullDay()))
    expect(grid.days[1].signature).toBe(punchSetSignature([row({ id: 'x-0' })]))
    for (const empty of grid.days.slice(2)) expect(empty.signature).toBe(punchSetSignature([]))
    expect(new Set(grid.days.map((d) => d.signature)).size).toBe(3)
  })
})
