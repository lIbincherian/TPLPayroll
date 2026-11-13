import { describe, expect, it } from 'vitest'
import {
  computeStatusChanges,
  describeStatusChanges,
  type StatusEmployee,
} from '@/features/attendance-sync/lib/employee-status'
import type { PunchMatchStatus } from '@/features/attendance-sync/types/attendance-sync.types'
import { WEEK, utc } from './service-fixtures'

const TODAY = '2026-11-12'

function employee(overrides: Partial<StatusEmployee> = {}): StatusEmployee {
  return {
    id: 'emp-36',
    employeeId: 'TPLGOAHLP036',
    employeeName: 'Asha Rao',
    isActive: true,
    dateOfJoining: utc('2025-01-01'),
    dateOfResignation: null,
    ...overrides,
  }
}

function day(
  employeeId: string | null,
  date: string,
  times: string[],
  empCode = '0036',
  matchStatus: PunchMatchStatus = 'MATCHED',
) {
  return times.map((time, i) => ({
    employeeId,
    empCode,
    matchStatus,
    punchDate: utc(date),
    pairIndex: Math.floor(i / 2),
    position: (i % 2 === 0 ? 'IN' : 'OUT') as 'IN' | 'OUT',
    currentTime: time,
  }))
}

function run(
  employees: StatusEmployee[],
  rows: ReturnType<typeof day>,
  options: { today?: string; laterWeekSynced?: boolean } = {},
) {
  return computeStatusChanges({
    week: WEEK,
    today: options.today ?? TODAY,
    employees,
    rows,
    laterWeekSynced: options.laterWeekSynced ?? false,
  })
}

describe('computeStatusChanges', () => {
  it('zero punches deactivates an active employee', () => {
    const other = employee({ id: 'emp-7', employeeId: 'TPLGOAHLP007' })
    const changes = run([employee(), other], day('emp-7', '2026-11-05', ['08:00', '17:00'], '0007'))
    expect(changes).toEqual([
      {
        employeeDbId: 'emp-36',
        employeeId: 'TPLGOAHLP036',
        employeeName: 'Asha Rao',
        from: true,
        to: false,
        punchCount: 0,
        hours: 0,
      },
    ])
  })

  it('missing from data deactivates: only an unknown code came back', () => {
    const changes = run([employee()], day(null, '2026-11-05', ['08:00', '17:00'], '9999', 'UNKNOWN'))
    expect(changes.map((c) => c.to)).toEqual([false])
  })

  it('reactivation: an inactive employee with punches becomes active, hours from complete pairs', () => {
    const rows = [...day('emp-36', '2026-11-05', ['08:00', '17:00']), ...day('emp-36', '2026-11-06', ['08:00'])]
    const changes = run([employee({ isActive: false })], rows)
    expect(changes).toEqual([expect.objectContaining({ from: false, to: true, punchCount: 3, hours: 9 })])
  })

  it('resigned not reactivated: a resignation before today keeps them inactive', () => {
    const resigned = employee({ isActive: false, dateOfResignation: utc('2026-11-01') })
    expect(run([resigned], day('emp-36', '2026-11-05', ['08:00', '17:00']))).toEqual([])
  })

  it('a resignation dated today does not block reactivation', () => {
    const leaving = employee({ isActive: false, dateOfResignation: utc(TODAY) })
    expect(run([leaving], day('emp-36', '2026-11-05', ['08:00', '17:00'])).map((c) => c.to)).toEqual([true])
  })

  it('older week (later week synced) makes no change', () => {
    expect(run([employee()], [], { laterWeekSynced: true })).toEqual([])
  })

  it('incomplete week (ends today or later) makes no change', () => {
    expect(run([employee()], [], { today: WEEK.end })).toEqual([])
  })

  it('new joiner skipped: joined on or after the week start', () => {
    expect(run([employee({ dateOfJoining: utc(WEEK.start) })], [])).toEqual([])
  })

  it('null joining date not skipped', () => {
    expect(run([employee({ dateOfJoining: null })], []).map((c) => c.to)).toEqual([false])
  })

  it('duplicate-code candidate skipped', () => {
    const a = employee({ id: 'emp-a', employeeId: 'TPLGOAHLP036' })
    const b = employee({ id: 'emp-b', employeeId: 'TPLGOAKIT036' })
    expect(run([a, b], day(null, '2026-11-05', ['08:00', '17:00'], '0036', 'DUPLICATE'))).toEqual([])
  })
})

describe('describeStatusChanges', () => {
  const e = { id: 'x', employeeId: 'X1', employeeName: 'X' }

  it('pluralises and joins the counts, null when nothing changed', () => {
    expect(describeStatusChanges({ markedInactive: [e], reactivated: [e] })).toBe(
      '1 employee marked inactive, 1 reactivated',
    )
    expect(describeStatusChanges({ markedInactive: [e, e], reactivated: [] })).toBe('2 employees marked inactive')
    expect(describeStatusChanges({ markedInactive: [], reactivated: [e] })).toBe('1 employee reactivated')
    expect(describeStatusChanges({ markedInactive: [], reactivated: [] })).toBeNull()
  })
})
