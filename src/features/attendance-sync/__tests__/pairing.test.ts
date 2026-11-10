import { describe, it, expect } from 'vitest'
import { buildPunchRowsFromParsed, mergeScans, pairPunches } from '../lib/pairing'
import type {
  CodeExceptionLite,
  EmployeeLite,
  ParsedPunch,
} from '../types/attendance-sync.types'

describe('pairPunches (US-12.10)', () => {
  it('pairs four punches in order', () => {
    expect(pairPunches(['07:40', '13:04', '13:56', '17:47'])).toEqual({
      pairs: [
        { in: '07:40', out: '13:04' },
        { in: '13:56', out: '17:47' },
      ],
      incomplete: null,
    })
  })

  it('sorts before pairing', () => {
    expect(pairPunches(['13:04', '07:40'])).toEqual({
      pairs: [{ in: '07:40', out: '13:04' }],
      incomplete: null,
    })
  })

  it('leaves an incomplete pair on an odd count', () => {
    expect(pairPunches(['07:40', '13:04', '18:26'])).toEqual({
      pairs: [{ in: '07:40', out: '13:04' }],
      incomplete: '18:26',
    })
  })

  it('gives a single punch as incomplete', () => {
    expect(pairPunches(['18:26'])).toEqual({ pairs: [], incomplete: '18:26' })
  })

  it('does not treat 10:00 and 10:30 as special', () => {
    expect(pairPunches(['07:40', '10:00', '10:30', '17:47'])).toEqual({
      pairs: [
        { in: '07:40', out: '10:00' },
        { in: '10:30', out: '17:47' },
      ],
      incomplete: null,
    })
  })

  it('returns nothing for no punches', () => {
    expect(pairPunches([])).toEqual({ pairs: [], incomplete: null })
  })

  it('does not mutate the input', () => {
    const input = ['13:04', '07:40']
    pairPunches(input)
    expect(input).toEqual(['13:04', '07:40'])
  })
})

describe('mergeScans (US-12.11)', () => {
  it('merges scans in the window and keeps every original', () => {
    const result = mergeScans(['07:40', '07:41', '13:00', '13:50', '17:45', '17:46'])
    expect(result.punches).toEqual(['07:40', '13:00', '13:50', '17:45'])
    expect(result.merged).toBe(true)
    expect(result.originals).toEqual(['07:40', '07:41', '13:00', '13:50', '17:45', '17:46'])
    expect(result.originals).toHaveLength(6)
    expect(result.mergedInto).toEqual({ '07:40': ['07:41'], '17:45': ['17:46'] })
  })

  it('includes a scan at exactly 10 minutes', () => {
    const result = mergeScans(['07:40', '07:50'])
    expect(result.punches).toEqual(['07:40'])
    expect(result.merged).toBe(true)
    expect(result.mergedInto).toEqual({ '07:40': ['07:50'] })
  })

  it('keeps scans outside the window separate', () => {
    const result = mergeScans(['07:40', '07:51'])
    expect(result.punches).toEqual(['07:40', '07:51'])
    expect(result.merged).toBe(false)
    expect(result.mergedInto).toEqual({})
  })

  it('measures from the kept punch, not the previous scan', () => {
    // 07:55 is only 5 minutes after 07:50 but 15 after the kept 07:40, so it starts a new punch.
    const result = mergeScans(['07:40', '07:45', '07:50', '07:55'])
    expect(result.punches).toEqual(['07:40', '07:55'])
    expect(result.mergedInto).toEqual({ '07:40': ['07:45', '07:50'] })
  })

  it('merges identical scans', () => {
    const result = mergeScans(['07:40', '07:40'])
    expect(result.punches).toEqual(['07:40'])
    expect(result.merged).toBe(true)
    expect(result.originals).toEqual(['07:40', '07:40'])
  })

  it('sorts unsorted input before merging', () => {
    const result = mergeScans(['07:41', '07:40'])
    expect(result.punches).toEqual(['07:40'])
    expect(result.mergedInto).toEqual({ '07:40': ['07:41'] })
  })

  it('returns empty results for no scans', () => {
    expect(mergeScans([])).toEqual({ punches: [], merged: false, mergedInto: {}, originals: [] })
  })

  it('scans just outside the window form a short complete pair', () => {
    const { punches } = mergeScans(['07:40', '07:51'])
    expect(pairPunches(punches)).toEqual({ pairs: [{ in: '07:40', out: '07:51' }], incomplete: null })
  })

  it('merging happens before pairing: a double scan does not create a false pair', () => {
    const { punches } = mergeScans(['07:40', '07:41', '17:47'])
    expect(pairPunches(punches)).toEqual({ pairs: [{ in: '07:40', out: '17:47' }], incomplete: null })
  })
})

describe('buildPunchRowsFromParsed', () => {
  const week = { start: '2026-11-05', end: '2026-11-11' }

  const emp36: EmployeeLite = {
    id: 'e36',
    employeeId: 'TPLGOAHLP036',
    employeeName: 'Thirty Six',
    isActive: true,
    dateOfResignation: null,
  }
  const emp07a: EmployeeLite = { id: 'e07a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven A', isActive: true, dateOfResignation: null }
  const emp07b: EmployeeLite = { id: 'e07b', employeeId: 'TPLGOASUP007', employeeName: 'Seven B', isActive: true, dateOfResignation: null }

  function punch(overrides: Partial<ParsedPunch> & { time: string }): ParsedPunch {
    return { empCode: '0036', empName: 'Empname0036', date: '2026-11-05', mcid: '1', ...overrides }
  }

  it('pairs a full day into IN/OUT rows with pairIndex 0 and 1', () => {
    const rows = buildPunchRowsFromParsed(
      ['07:40', '13:04', '13:56', '17:47'].map((time) => punch({ time })),
      [emp36],
      [],
      week,
    )
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => [r.pairIndex, r.position, r.originalTime, r.currentTime])).toEqual([
      [0, 'IN', '07:40', '07:40'],
      [0, 'OUT', '13:04', '13:04'],
      [1, 'IN', '13:56', '13:56'],
      [1, 'OUT', '17:47', '17:47'],
    ])
    for (const row of rows) {
      expect(row).toMatchObject({
        employeeId: 'e36',
        empCode: '0036',
        empName: 'Empname0036',
        matchStatus: 'MATCHED',
        source: 'API',
        note: null,
        mergedScansJson: null,
        mcid: '1',
      })
      expect(row.punchDate.toISOString()).toBe('2026-11-05T00:00:00.000Z')
    }
  })

  it('emits a single IN row at pairIndex pairs.length for an incomplete punch', () => {
    const rows = buildPunchRowsFromParsed(
      ['07:40', '13:04', '18:26'].map((time) => punch({ time })),
      [emp36],
      [],
      week,
    )
    expect(rows.map((r) => [r.pairIndex, r.position, r.currentTime])).toEqual([
      [0, 'IN', '07:40'],
      [0, 'OUT', '13:04'],
      [1, 'IN', '18:26'],
    ])
  })

  it('a lone punch becomes one IN row at pairIndex 0', () => {
    const rows = buildPunchRowsFromParsed([punch({ time: '18:26', date: '2026-11-06' })], [emp36], [], week)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pairIndex: 0, position: 'IN', currentTime: '18:26', originalTime: '18:26' })
  })

  it('stores only absorbed scans in the kept row mergedScansJson', () => {
    const rows = buildPunchRowsFromParsed(
      ['07:40', '07:41', '13:00', '13:50', '17:45', '17:46'].map((time) => punch({ time })),
      [emp36],
      [],
      week,
    )
    expect(rows.map((r) => r.currentTime)).toEqual(['07:40', '13:00', '13:50', '17:45'])
    expect(rows[0].mergedScansJson).toEqual(['07:41'])
    expect(rows[1].mergedScansJson).toBeNull()
    expect(rows[2].mergedScansJson).toBeNull()
    expect(rows[3].mergedScansJson).toEqual(['17:46'])
  })

  it('keeps scans outside the merge window as separate punches', () => {
    const rows = buildPunchRowsFromParsed(
      ['07:40', '07:51'].map((time) => punch({ time })),
      [emp36],
      [],
      week,
    )
    expect(rows.map((r) => [r.pairIndex, r.position, r.currentTime, r.mergedScansJson])).toEqual([
      [0, 'IN', '07:40', null],
      [0, 'OUT', '07:51', null],
    ])
  })

  it('drops punches dated outside the week (either side)', () => {
    const rows = buildPunchRowsFromParsed(
      [
        punch({ time: '07:40', date: '2026-11-04' }),
        punch({ time: '08:00', date: '2026-11-05' }),
        punch({ time: '09:00', date: '2026-11-11' }),
        punch({ time: '07:40', date: '2026-11-12' }),
        punch({ time: '18:26', date: '2026-11-12' }),
      ],
      [emp36],
      [],
      week,
    )
    // Only the 5 Nov 08:00 and 11 Nov 09:00 punches are inside the week; each is a lone punch.
    expect(rows.map((r) => [r.punchDate.toISOString().slice(0, 10), r.currentTime]).sort()).toEqual([
      ['2026-11-05', '08:00'],
      ['2026-11-11', '09:00'],
    ])
  })

  it('groups per employee and per day', () => {
    const rows = buildPunchRowsFromParsed(
      [
        punch({ time: '08:00', date: '2026-11-05' }),
        punch({ time: '16:00', date: '2026-11-05' }),
        punch({ time: '08:00', date: '2026-11-06' }),
        punch({ time: '16:00', date: '2026-11-06' }),
      ],
      [emp36],
      [],
      week,
    )
    expect(rows).toHaveLength(4)
    // each day restarts at pairIndex 0
    expect(rows.filter((r) => r.pairIndex === 0)).toHaveLength(4)
  })

  it('merges two codes that map to one employee into one stream per day', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: 'e36' }]
    const rows = buildPunchRowsFromParsed(
      [
        punch({ time: '08:00', empCode: '0036' }),
        punch({ time: '12:00', empCode: '0999', empName: 'Alias' }),
      ],
      [emp36],
      exceptions,
      week,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r.pairIndex, r.position, r.currentTime, r.employeeId])).toEqual([
      [0, 'IN', '08:00', 'e36'],
      [0, 'OUT', '12:00', 'e36'],
    ])
  })

  it('marks an unknown code UNKNOWN with no employeeId, carrying the vendor name', () => {
    const rows = buildPunchRowsFromParsed(
      [punch({ time: '08:00', empCode: '0999', empName: 'Empname0999' }), punch({ time: '16:00', empCode: '0999', empName: 'Empname0999' })],
      [emp36],
      [],
      week,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({ employeeId: null, matchStatus: 'UNKNOWN', empCode: '0999', empName: 'Empname0999' })
    }
  })

  it('marks a duplicate code DUPLICATE with no employeeId', () => {
    const rows = buildPunchRowsFromParsed(
      [punch({ time: '08:00', empCode: '0007', empName: 'Empname0007' })],
      [emp07a, emp07b],
      [],
      week,
    )
    expect(rows[0]).toMatchObject({ employeeId: null, matchStatus: 'DUPLICATE', empCode: '0007' })
  })

  it('marks an ignored code IGNORED with no employeeId', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0036', kind: 'IGNORE', employeeId: null }]
    const rows = buildPunchRowsFromParsed([punch({ time: '08:00' }), punch({ time: '16:00' })], [emp36], exceptions, week)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ employeeId: null, matchStatus: 'IGNORED' })
  })

  it('applies a MATCH exception so the punches belong to the chosen employee', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: 'e36' }]
    const rows = buildPunchRowsFromParsed(
      [punch({ time: '08:00', empCode: '0999' }), punch({ time: '16:00', empCode: '0999' })],
      [emp36],
      exceptions,
      week,
    )
    for (const row of rows) expect(row).toMatchObject({ employeeId: 'e36', matchStatus: 'MATCHED', empCode: '0999' })
  })

  it('uses the first non-empty name seen for a code', () => {
    const rows = buildPunchRowsFromParsed(
      [
        punch({ time: '08:00', empName: null }),
        punch({ time: '16:00', empName: 'Later Name' }),
      ],
      [emp36],
      [],
      week,
    )
    for (const row of rows) expect(row.empName).toBe('Later Name')
  })

  it('keeps a null name when the vendor never sent one', () => {
    const rows = buildPunchRowsFromParsed([punch({ time: '08:00', empName: null })], [emp36], [], week)
    expect(rows[0].empName).toBeNull()
  })

  it('returns nothing when every punch is outside the week', () => {
    expect(buildPunchRowsFromParsed([punch({ time: '08:00', date: '2026-10-01' })], [emp36], [], week)).toEqual([])
  })

  it('returns nothing for no punches', () => {
    expect(buildPunchRowsFromParsed([], [emp36], [], week)).toEqual([])
  })
})
