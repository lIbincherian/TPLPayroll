import { describe, it, expect } from 'vitest'
import {
  getReviewGridEmployees,
  matchEmployeeCode,
  needsEmployeeDecision,
  trailingNumber,
} from '../lib/matching'
import type { CodeExceptionLite, EmployeeLite } from '../types/attendance-sync.types'

function employee(overrides: Partial<EmployeeLite> & { employeeId: string }): EmployeeLite {
  return {
    id: `id-${overrides.employeeId}`,
    employeeName: `Name ${overrides.employeeId}`,
    isActive: true,
    dateOfResignation: null,
    ...overrides,
  }
}

const week = { start: '2026-11-05', end: '2026-11-11' }

describe('trailingNumber', () => {
  it('reads all trailing digits', () => {
    expect(trailingNumber('TPLGOAHLP036')).toBe(36)
    expect(trailingNumber('TPLGOAHLP1000')).toBe(1000)
    expect(trailingNumber('TPLGOAHLP007')).toBe(7)
  })

  it('is null when there are no trailing digits', () => {
    expect(trailingNumber('TPLGOAHLP')).toBeNull()
    expect(trailingNumber('')).toBeNull()
    expect(trailingNumber('12ABC')).toBeNull()
  })
})

describe('matchEmployeeCode (US-12.7)', () => {
  it('ignores leading zeros', () => {
    const e = employee({ employeeId: 'TPLGOAHLP036' })
    const result = matchEmployeeCode('0036', [e])
    expect(result).toEqual({ status: 'MATCHED', employee: e, via: 'NUMBER' })
  })

  it('reads four-digit codes in full', () => {
    const e = employee({ employeeId: 'TPLGOAHLP1000' })
    const result = matchEmployeeCode('1000', [e])
    expect(result).toEqual({ status: 'MATCHED', employee: e, via: 'NUMBER' })
  })

  it('does not match a four-digit code to a three-digit slice', () => {
    expect(matchEmployeeCode('1000', [employee({ employeeId: 'TPLGOAHLP000' })])).toEqual({ status: 'UNKNOWN' })
    expect(matchEmployeeCode('1000', [employee({ employeeId: 'TPLGOAHLP100' })])).toEqual({ status: 'UNKNOWN' })
  })

  it('reads all trailing digits of the Employee ID', () => {
    expect(matchEmployeeCode('0036', [employee({ employeeId: 'TPLGOAHLP1036' })])).toEqual({ status: 'UNKNOWN' })
  })

  it('does not match an ID with no trailing digits', () => {
    expect(matchEmployeeCode('0036', [employee({ employeeId: 'TPLGOAHLP' })])).toEqual({ status: 'UNKNOWN' })
  })

  it('ignores names', () => {
    const named = employee({ employeeId: 'TPLGOAHLP001', employeeName: 'Empname0036' })
    expect(matchEmployeeCode('0036', [named])).toEqual({ status: 'UNKNOWN' })
  })

  it('never matches a code with non-digit characters by number', () => {
    const e = employee({ employeeId: 'TPLGOAHLP036' })
    expect(matchEmployeeCode('36A', [e])).toEqual({ status: 'UNKNOWN' })
    expect(matchEmployeeCode('', [e])).toEqual({ status: 'UNKNOWN' })
  })
})

describe('matchEmployeeCode: unknown and duplicate (US-12.8)', () => {
  it('returns UNKNOWN when no Employee ID ends in the number', () => {
    const employees = [employee({ employeeId: 'TPLGOAHLP001' }), employee({ employeeId: 'TPLGOAHLP002' })]
    expect(matchEmployeeCode('0999', employees)).toEqual({ status: 'UNKNOWN' })
  })

  it('returns DUPLICATE with both employees, sorted by Employee ID', () => {
    const sup = employee({ employeeId: 'TPLGOASUP007' })
    const hlp = employee({ employeeId: 'TPLGOAHLP007' })
    const result = matchEmployeeCode('0007', [sup, hlp])
    expect(result.status).toBe('DUPLICATE')
    if (result.status === 'DUPLICATE') {
      expect(result.employees.map((e) => e.employeeId)).toEqual(['TPLGOAHLP007', 'TPLGOASUP007'])
    }
  })

  it('does not mutate the input array when sorting duplicates', () => {
    const employees = [employee({ employeeId: 'TPLGOASUP007' }), employee({ employeeId: 'TPLGOAHLP007' })]
    matchEmployeeCode('0007', employees)
    expect(employees.map((e) => e.employeeId)).toEqual(['TPLGOASUP007', 'TPLGOAHLP007'])
  })
})

describe('matchEmployeeCode with saved exceptions (C3)', () => {
  const target = employee({ employeeId: 'TPLGOAHLP500' })
  const natural = employee({ employeeId: 'TPLGOAHLP999' })

  it('MATCH exception links the code even when the number matches nothing', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: target.id }]
    expect(matchEmployeeCode('0999', [target], exceptions)).toEqual({
      status: 'MATCHED',
      employee: target,
      via: 'EXCEPTION',
    })
  })

  it('MATCH exception wins over a natural number match', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: target.id }]
    const result = matchEmployeeCode('0999', [target, natural], exceptions)
    expect(result).toEqual({ status: 'MATCHED', employee: target, via: 'EXCEPTION' })
  })

  it('IGNORE exception wins over a natural match', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'IGNORE', employeeId: null }]
    expect(matchEmployeeCode('0999', [natural], exceptions)).toEqual({ status: 'IGNORED' })
  })

  it('IGNORE exception returns IGNORED when nothing else matches too', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'IGNORE', employeeId: null }]
    expect(matchEmployeeCode('0999', [], exceptions)).toEqual({ status: 'IGNORED' })
  })

  it('a MATCH exception pointing at an unknown employee is treated as UNKNOWN', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: 'deleted-employee' }]
    expect(matchEmployeeCode('0999', [target], exceptions)).toEqual({ status: 'UNKNOWN' })
  })

  it('a stale MATCH exception falls back to the natural number match when one exists', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: 'deleted-employee' }]
    expect(matchEmployeeCode('0999', [natural], exceptions)).toEqual({
      status: 'MATCHED',
      employee: natural,
      via: 'NUMBER',
    })
  })

  it('a MATCH exception with no employeeId falls through to number matching', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0999', kind: 'MATCH', employeeId: null }]
    expect(matchEmployeeCode('0999', [natural], exceptions)).toEqual({
      status: 'MATCHED',
      employee: natural,
      via: 'NUMBER',
    })
  })

  it('an exception can match a code with non-digit characters', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: 'A12', kind: 'MATCH', employeeId: target.id }]
    expect(matchEmployeeCode('A12', [target], exceptions).status).toBe('MATCHED')
  })

  it('exceptions for other codes are ignored', () => {
    const exceptions: CodeExceptionLite[] = [{ empCode: '0001', kind: 'IGNORE', employeeId: null }]
    expect(matchEmployeeCode('0999', [natural], exceptions).status).toBe('MATCHED')
  })
})

describe('needsEmployeeDecision (US-12.9)', () => {
  it('is needed for an inactive employee with punches', () => {
    const e = employee({ employeeId: 'TPLGOAHLP002', isActive: false })
    expect(needsEmployeeDecision(e, 4, week)).toEqual({ needed: true, reason: 'INACTIVE' })
  })

  it('is needed for an employee who resigned before the week', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2026-11-01T00:00:00Z') })
    expect(needsEmployeeDecision(e, 2, week)).toEqual({ needed: true, reason: 'RESIGNED_BEFORE_WEEK' })
  })

  it('is not needed with no punches', () => {
    const e = employee({ employeeId: 'TPLGOAHLP002', isActive: false })
    expect(needsEmployeeDecision(e, 0, week)).toEqual({ needed: false })
  })

  it('is not needed for an employee resigning during the week', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2026-11-07T00:00:00Z') })
    expect(needsEmployeeDecision(e, 2, week)).toEqual({ needed: false })
  })

  it('is not needed when resigning on the first day of the week (not before)', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2026-11-05T00:00:00Z') })
    expect(needsEmployeeDecision(e, 2, week)).toEqual({ needed: false })
  })

  it('is needed when resigning the day before the week starts', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2026-11-04T00:00:00Z') })
    expect(needsEmployeeDecision(e, 1, week).needed).toBe(true)
  })

  it('is not needed for a normal active employee', () => {
    expect(needsEmployeeDecision(employee({ employeeId: 'TPLGOAHLP001' }), 10, week)).toEqual({ needed: false })
  })

  it('reports INACTIVE first when an employee is both inactive and resigned before the week', () => {
    const e = employee({
      employeeId: 'TPLGOAHLP004',
      isActive: false,
      dateOfResignation: new Date('2026-10-01T00:00:00Z'),
    })
    expect(needsEmployeeDecision(e, 1, week)).toEqual({ needed: true, reason: 'INACTIVE' })
  })
})

describe('getReviewGridEmployees (US-12.13)', () => {
  it('includes an active employee with no punches', () => {
    const e = employee({ employeeId: 'TPLGOAHLP001' })
    const grid = getReviewGridEmployees([e], [], week, new Set())
    expect(grid).toHaveLength(1)
    expect(grid[0]).toMatchObject({ id: e.id, tag: 'ACTIVE' })
  })

  it('includes an employee resigning during the week', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2026-11-07T00:00:00Z') })
    const grid = getReviewGridEmployees([e], [], week, new Set())
    expect(grid.map((g) => g.id)).toEqual([e.id])
    expect(grid[0].tag).toBe('ACTIVE')
  })

  it('includes an approved inactive employee', () => {
    const e = employee({ employeeId: 'TPLGOAHLP002', isActive: false })
    const grid = getReviewGridEmployees([e], [{ employeeId: e.id, decision: 'APPROVED' }], week, new Set([e.id]))
    expect(grid).toHaveLength(1)
    expect(grid[0].tag).toBe('INACTIVE_APPROVED')
  })

  it('includes an approved employee who resigned before the week, tagged RESIGNED_APPROVED', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2025-03-01T00:00:00Z') })
    const grid = getReviewGridEmployees([e], [{ employeeId: e.id, decision: 'APPROVED' }], week, new Set([e.id]))
    expect(grid[0].tag).toBe('RESIGNED_APPROVED')
  })

  it('excludes a rejected employee', () => {
    const e = employee({ employeeId: 'TPLGOAHLP003', dateOfResignation: new Date('2025-03-01T00:00:00Z') })
    const grid = getReviewGridEmployees([e], [{ employeeId: e.id, decision: 'REJECTED' }], week, new Set([e.id]))
    expect(grid).toEqual([])
  })

  it('excludes an inactive employee with no punches and no decision', () => {
    const e = employee({ employeeId: 'TPLGOAHLP002', isActive: false })
    expect(getReviewGridEmployees([e], [], week, new Set())).toEqual([])
  })

  it('excludes an inactive employee whose decision is still pending even when they have punches', () => {
    const e = employee({ employeeId: 'TPLGOAHLP002', isActive: false })
    expect(getReviewGridEmployees([e], [], week, new Set([e.id]))).toEqual([])
  })

  it('sorts by employee name', () => {
    const b = employee({ employeeId: 'TPLGOAHLP002', employeeName: 'Bala' })
    const a = employee({ employeeId: 'TPLGOAHLP001', employeeName: 'Anand' })
    const c = employee({ employeeId: 'TPLGOAHLP003', employeeName: 'Chitra' })
    expect(getReviewGridEmployees([c, b, a], [], week, new Set()).map((e) => e.employeeName)).toEqual([
      'Anand',
      'Bala',
      'Chitra',
    ])
  })

  it('does not mutate the input', () => {
    const employees = [
      employee({ employeeId: 'TPLGOAHLP002', employeeName: 'Bala' }),
      employee({ employeeId: 'TPLGOAHLP001', employeeName: 'Anand' }),
    ]
    getReviewGridEmployees(employees, [], week, new Set())
    expect(employees.map((e) => e.employeeName)).toEqual(['Bala', 'Anand'])
  })
})
