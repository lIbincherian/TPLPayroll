import { describe, it, expect } from 'vitest'
import {
  buildApprovalSummary,
  buildAttendanceRecords,
  buildGridEmployees,
  canApproveWeek,
  canPullNow,
  canReopenWeek,
  countEmployeeCheckIssues,
  countUnusualDays,
  getAttendanceWeekStatus,
  getNeedsFixingDays,
  getNoPunchEmployees,
  getPayrollEmployees,
  shouldScheduledSyncReplace,
} from '../lib/review'
import { buildDayView } from '../lib/hours'
import { getReviewGridEmployees } from '../lib/matching'
import { getWeekDates } from '../lib/week'
import type {
  ApprovalDecisionInput,
  EmployeeLite,
  GridEmployee,
  StoredPunchRow,
} from '../types/attendance-sync.types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

/** A complete in/out pair of untouched API punches. */
function apiPair(prefix: string, pairIndex: number, inTime: string, outTime: string): StoredPunchRow[] {
  return [row(`${prefix}-i`, pairIndex, 'IN', inTime, inTime), row(`${prefix}-o`, pairIndex, 'OUT', outTime, outTime)]
}

function gridEmployee(
  id: string,
  name: string,
  rowsByDate: Record<string, StoredPunchRow[]> = {},
  tag: GridEmployee['tag'] = 'ACTIVE',
): GridEmployee {
  const days = dates.map((date) => buildDayView(date, rowsByDate[date] ?? []))
  const totalRegularHours = Math.round(days.reduce((s, d) => s + d.regularHours, 0) * 100) / 100
  const totalOvertimeHours = Math.round(days.reduce((s, d) => s + d.overtimeHours, 0) * 100) / 100
  return {
    employeeId: id,
    employeeCode: `TPLGOAHLP${id}`,
    employeeName: name,
    tag,
    days,
    totalRegularHours,
    totalOvertimeHours,
    hasAnyPunch: days.some((d) => d.pairs.length > 0),
  }
}

const fullDayRows = (prefix: string): StoredPunchRow[] => [
  ...apiPair(`${prefix}1`, 0, '07:40', '13:04'),
  ...apiPair(`${prefix}2`, 1, '13:56', '17:47'),
]

// ─── buildGridEmployees ───────────────────────────────────────────────────────

describe('buildGridEmployees', () => {
  const eligible = [
    { id: 'e1', employeeId: 'TPLGOAHLP001', employeeName: 'Anand', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const },
    { id: 'e2', employeeId: 'TPLGOAHLP002', employeeName: 'Bala', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const },
  ]

  it('builds seven day views per employee, Thursday first, with totals', () => {
    const punches = [
      ...fullDayRows('a').map((r) => ({ ...r, employeeId: 'e1', punchDate: new Date('2026-11-05T00:00:00Z') })),
      ...apiPair('b', 0, '08:00', '12:00').map((r) => ({ ...r, employeeId: 'e1', punchDate: new Date('2026-11-06T00:00:00Z') })),
    ]
    const grid = buildGridEmployees(eligible, punches, dates)
    expect(grid).toHaveLength(2)
    expect(grid[0].days.map((d) => d.date)).toEqual(dates)
    expect(grid[0].days).toHaveLength(7)
    expect(grid[0]).toMatchObject({
      employeeId: 'e1',
      employeeCode: 'TPLGOAHLP001',
      employeeName: 'Anand',
      totalRegularHours: 12,
      totalOvertimeHours: 1.25,
      hasAnyPunch: true,
    })
    expect(grid[1]).toMatchObject({ employeeId: 'e2', totalRegularHours: 0, totalOvertimeHours: 0, hasAnyPunch: false })
  })

  it('ignores punches that are not linked to an employee (unknown/duplicate/ignored codes)', () => {
    const punches = [
      { ...row('x', 0, 'IN', '08:00', '08:00'), employeeId: null, punchDate: new Date('2026-11-05T00:00:00Z') },
    ]
    const grid = buildGridEmployees(eligible, punches, dates)
    expect(grid.every((e) => !e.hasAnyPunch)).toBe(true)
  })

  it('ignores punches for employees not in the eligible list', () => {
    const punches = [
      { ...row('x', 0, 'IN', '08:00', '08:00'), employeeId: 'rejected', punchDate: new Date('2026-11-05T00:00:00Z') },
    ]
    expect(buildGridEmployees(eligible, punches, dates).every((e) => !e.hasAnyPunch)).toBe(true)
  })

  it('keeps the tag from the eligible list', () => {
    const grid = buildGridEmployees([{ ...eligible[0], tag: 'INACTIVE_APPROVED' }], [], dates)
    expect(grid[0].tag).toBe('INACTIVE_APPROVED')
  })
})

// ─── countEmployeeCheckIssues (US-12.8 getEmployeeCheckIssues, pure part) ──────

describe('countEmployeeCheckIssues', () => {
  const employees: EmployeeLite[] = [
    { id: 'e1', employeeId: 'TPLGOAHLP001', employeeName: 'Active', isActive: true, dateOfResignation: null },
    { id: 'e2', employeeId: 'TPLGOAHLP002', employeeName: 'Inactive', isActive: false, dateOfResignation: null },
    { id: 'e3', employeeId: 'TPLGOAHLP003', employeeName: 'Resigned', isActive: true, dateOfResignation: new Date('2025-03-01T00:00:00Z') },
  ]

  it('counts distinct unknown and duplicate codes', () => {
    const result = countEmployeeCheckIssues({
      week,
      employees,
      punches: [
        { empCode: '0999', matchStatus: 'UNKNOWN', employeeId: null },
        { empCode: '0999', matchStatus: 'UNKNOWN', employeeId: null },
        { empCode: '0007', matchStatus: 'DUPLICATE', employeeId: null },
        { empCode: '0001', matchStatus: 'MATCHED', employeeId: 'e1' },
        { empCode: '0500', matchStatus: 'IGNORED', employeeId: null },
      ],
      decisions: [],
    })
    expect(result).toEqual({ unresolvedCodes: 2, pendingDecisions: 0 })
  })

  it('counts an inactive or resigned employee with punches and no decision as pending', () => {
    const result = countEmployeeCheckIssues({
      week,
      employees,
      punches: [
        { empCode: '0002', matchStatus: 'MATCHED', employeeId: 'e2' },
        { empCode: '0003', matchStatus: 'MATCHED', employeeId: 'e3' },
      ],
      decisions: [],
    })
    expect(result).toEqual({ unresolvedCodes: 0, pendingDecisions: 2 })
  })

  it('does not count a decided employee', () => {
    const result = countEmployeeCheckIssues({
      week,
      employees,
      punches: [
        { empCode: '0002', matchStatus: 'MATCHED', employeeId: 'e2' },
        { empCode: '0003', matchStatus: 'MATCHED', employeeId: 'e3' },
      ],
      decisions: [{ employeeId: 'e2' }, { employeeId: 'e3' }],
    })
    expect(result.pendingDecisions).toBe(0)
  })

  it('needs no decision for an inactive employee without punches', () => {
    expect(countEmployeeCheckIssues({ week, employees, punches: [], decisions: [] })).toEqual({
      unresolvedCodes: 0,
      pendingDecisions: 0,
    })
  })
})

// ─── Needs fixing / no punch / unusual (US-12.14, 12.15, 12.16) ───────────────

describe('getNeedsFixingDays (US-12.14)', () => {
  it('lists a day with an incomplete pair', () => {
    const e = gridEmployee('1', 'A', { '2026-11-06': [row('a', 0, 'IN', '18:26', '18:26')] })
    expect(getNeedsFixingDays([e])).toEqual([{ employeeId: '1', date: '2026-11-06' }])
  })

  it('skips complete and empty days', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': apiPair('a', 0, '08:00', '08:30') })
    expect(getNeedsFixingDays([e])).toEqual([])
  })

  it('count drops after a fix', () => {
    const before = gridEmployee('1', 'A', {
      '2026-11-06': [row('a', 0, 'IN', '18:26', '18:26')],
      '2026-11-07': [row('b', 0, 'IN', '17:00', '17:00')],
    })
    expect(getNeedsFixingDays([before])).toHaveLength(2)

    const after = gridEmployee('1', 'A', {
      '2026-11-06': [row('a', 0, 'IN', '18:26', '18:26'), row('a2', 0, 'OUT', null, '19:00', { source: 'MANUAL' })],
      '2026-11-07': [row('b', 0, 'IN', '17:00', '17:00')],
    })
    expect(getNeedsFixingDays([after])).toEqual([{ employeeId: '1', date: '2026-11-07' }])
  })

  it('a deleted lone punch no longer needs fixing', () => {
    const e = gridEmployee('1', 'A', { '2026-11-06': [row('a', 0, 'IN', '18:26', null)] })
    expect(getNeedsFixingDays([e])).toEqual([])
  })

  it('covers several employees', () => {
    const a = gridEmployee('1', 'A', { '2026-11-06': [row('a', 0, 'IN', '18:26', '18:26')] })
    const b = gridEmployee('2', 'B', { '2026-11-08': [row('b', 0, 'OUT', '09:00', '09:00')] })
    expect(getNeedsFixingDays([a, b])).toEqual([
      { employeeId: '1', date: '2026-11-06' },
      { employeeId: '2', date: '2026-11-08' },
    ])
  })
})

describe('getNoPunchEmployees (US-12.15)', () => {
  it('lists an employee with no punches', () => {
    const e = gridEmployee('1', 'A')
    expect(getNoPunchEmployees([e])).toEqual([e])
  })

  it('skips an employee with one punch', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': [row('a', 0, 'IN', '08:00', '08:00')] })
    expect(getNoPunchEmployees([e])).toEqual([])
  })

  it('adding a pair by hand calculates hours and removes the employee from the list', () => {
    const e = gridEmployee('1', 'A', {
      '2026-11-05': [
        row('m1', 0, 'IN', null, '08:00', { source: 'MANUAL' }),
        row('m2', 0, 'OUT', null, '16:00', { source: 'MANUAL' }),
      ],
    })
    expect(e.days[0].regularHours).toBe(8)
    expect(getNoPunchEmployees([e])).toEqual([])
  })
})

describe('countUnusualDays', () => {
  it('counts unusual days across employees', () => {
    const a = gridEmployee('1', 'A', { '2026-11-05': apiPair('a', 0, '08:00', '11:10') })
    const b = gridEmployee('2', 'B', {
      '2026-11-05': apiPair('b', 0, '08:00', '17:30'),
      '2026-11-06': fullDayRows('c'),
    })
    expect(countUnusualDays([a, b])).toBe(2)
  })
})

// ─── canApproveWeek (US-12.22, C4) ────────────────────────────────────────────

describe('canApproveWeek (US-12.22, C4)', () => {
  const ready = {
    status: 'REVIEW' as const,
    weekEndISO: '2026-11-11',
    todayISO: '2026-11-12',
    needsFixingCount: 0,
    unresolvedCodeCount: 0,
    pendingDecisionCount: 0,
  }

  it('is true when nothing blocks', () => {
    expect(canApproveWeek(ready)).toEqual({ canApprove: true, blockers: [] })
  })

  it('is false with an incomplete pair', () => {
    expect(canApproveWeek({ ...ready, needsFixingCount: 1 })).toEqual({ canApprove: false, blockers: ['NEEDS_FIXING'] })
  })

  it('is false with an unresolved code', () => {
    expect(canApproveWeek({ ...ready, unresolvedCodeCount: 1 })).toEqual({
      canApprove: false,
      blockers: ['UNRESOLVED_CODES'],
    })
  })

  it('is false with a pending decision', () => {
    expect(canApproveWeek({ ...ready, pendingDecisionCount: 2 })).toEqual({
      canApprove: false,
      blockers: ['PENDING_DECISIONS'],
    })
  })

  it('is false when the week has not ended (today equals the last day)', () => {
    expect(canApproveWeek({ ...ready, todayISO: '2026-11-11' })).toEqual({
      canApprove: false,
      blockers: ['WEEK_NOT_ENDED'],
    })
  })

  it('is false mid-week', () => {
    expect(canApproveWeek({ ...ready, todayISO: '2026-11-08' }).blockers).toEqual(['WEEK_NOT_ENDED'])
  })

  it('is true the day after the week ends', () => {
    expect(canApproveWeek({ ...ready, todayISO: '2026-11-12' }).canApprove).toBe(true)
  })

  it('is false when the week is not in review', () => {
    expect(canApproveWeek({ ...ready, status: 'APPROVED' })).toEqual({ canApprove: false, blockers: ['NOT_IN_REVIEW'] })
    expect(canApproveWeek({ ...ready, status: 'SYNC_FAILED' }).blockers).toEqual(['NOT_IN_REVIEW'])
    expect(canApproveWeek({ ...ready, status: 'NO_DATA' }).blockers).toEqual(['NOT_IN_REVIEW'])
  })

  it('reports every blocker at once, in a stable order', () => {
    expect(
      canApproveWeek({
        status: 'SYNC_FAILED',
        weekEndISO: '2026-11-11',
        todayISO: '2026-11-09',
        needsFixingCount: 3,
        unresolvedCodeCount: 1,
        pendingDecisionCount: 1,
      }),
    ).toEqual({
      canApprove: false,
      blockers: ['NOT_IN_REVIEW', 'WEEK_NOT_ENDED', 'NEEDS_FIXING', 'UNRESOLVED_CODES', 'PENDING_DECISIONS'],
    })
  })

  it('ignores unusual days and no-punch employees (they are not inputs and never block)', () => {
    const unusual = gridEmployee('1', 'A', { '2026-11-05': apiPair('a', 0, '08:00', '11:10') })
    const nopunch = gridEmployee('2', 'B')
    expect(countUnusualDays([unusual, nopunch])).toBe(1)
    expect(getNoPunchEmployees([unusual, nopunch])).toHaveLength(1)
    const result = canApproveWeek({ ...ready, needsFixingCount: getNeedsFixingDays([unusual, nopunch]).length })
    expect(result.canApprove).toBe(true)
  })
})

// ─── getPayrollEmployees (US-12.25) ───────────────────────────────────────────

describe('getPayrollEmployees (US-12.25)', () => {
  it('excludes a zero-hour employee', () => {
    const e = gridEmployee('1', 'A')
    expect(getPayrollEmployees({ employees: [e] })).toEqual([])
  })

  it('excludes a rejected employee who has hours in the week', () => {
    const lite = (id: string, resigned: Date | null): EmployeeLite => ({
      id,
      employeeId: `TPLGOAHLP${id}`,
      employeeName: `Emp ${id}`,
      isActive: true,
      dateOfResignation: resigned,
    })
    const employees = [lite('1', null), lite('2', new Date('2025-03-01T00:00:00Z'))]
    const eligible = getReviewGridEmployees(employees, [{ employeeId: '2', decision: 'REJECTED' }], week)
    const punches = ['1', '2'].flatMap((employeeId) =>
      apiPair(`p${employeeId}`, 0, '08:00', '16:00').map((r) => ({
        ...r,
        employeeId,
        punchDate: new Date('2026-11-05T00:00:00Z'),
      })),
    )
    const grid = buildGridEmployees(eligible, punches, dates)
    expect(getPayrollEmployees({ employees: grid }).map((e) => e.employeeId)).toEqual(['1'])
  })

  it('includes an employee with hand-entered hours', () => {
    const e = gridEmployee('1', 'A', {
      '2026-11-05': [
        row('m1', 0, 'IN', null, '08:00', { source: 'MANUAL' }),
        row('m2', 0, 'OUT', null, '16:00', { source: 'MANUAL' }),
      ],
    })
    expect(getPayrollEmployees({ employees: [e] })).toHaveLength(1)
  })

  it('excludes an employee with only an incomplete pair (zero hours)', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': [row('a', 0, 'IN', '08:00', '08:00')] })
    expect(getPayrollEmployees({ employees: [e] })).toEqual([])
  })

  it('includes an employee whose only day is 0.05 h', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': apiPair('a', 0, '08:00', '08:03') })
    expect(getPayrollEmployees({ employees: [e] })).toHaveLength(1)
  })
})

// ─── buildApprovalSummary (US-12.23) ──────────────────────────────────────────

describe('buildApprovalSummary (US-12.23)', () => {
  it('totals the hours', () => {
    const e = gridEmployee('1', 'A', {
      '2026-11-05': fullDayRows('a'), // 8.00 + 1.25
      '2026-11-06': apiPair('b', 0, '08:00', '12:00'), // 4.00
    })
    const summary = buildApprovalSummary({ employees: [e] }, [])
    expect(summary.totalRegularHours).toBe(12)
    expect(summary.totalOvertimeHours).toBe(1.25)
    expect(summary.employeeCount).toBe(1)
  })

  it('counts edited days and describes before/after', () => {
    const edited = (prefix: string): StoredPunchRow[] => [
      ...apiPair(`${prefix}1`, 0, '07:40', '13:04'),
      row(`${prefix}2`, 1, 'IN', '13:56', '13:56'),
      row(`${prefix}3`, 1, 'OUT', '17:47', '18:00'),
    ]
    const e = gridEmployee('1', 'A', {
      '2026-11-05': edited('a'),
      '2026-11-06': edited('b'),
      '2026-11-07': fullDayRows('c'),
      '2026-11-08': fullDayRows('d'),
      '2026-11-09': fullDayRows('e'),
    })
    const summary = buildApprovalSummary({ employees: [e] }, [])
    expect(summary.editedDays).toBe(2)
    expect(summary.editedDayDetails).toHaveLength(2)
    expect(summary.editedDayDetails[0]).toEqual({
      employeeName: 'A',
      date: '2026-11-05',
      before: '07:40–13:04, 13:56–17:47',
      after: '07:40–13:04, 13:56–18:00',
    })
  })

  it('describes a hand-added day as "-" before and the pair after', () => {
    const e = gridEmployee('1', 'A', {
      '2026-11-05': [
        row('m1', 0, 'IN', null, '08:00', { source: 'MANUAL' }),
        row('m2', 0, 'OUT', null, '16:00', { source: 'MANUAL' }),
      ],
    })
    const summary = buildApprovalSummary({ employees: [e] }, [])
    expect(summary.editedDayDetails).toEqual([
      { employeeName: 'A', date: '2026-11-05', before: '-', after: '08:00–16:00' },
    ])
  })

  it('lists employees being left out: zero hours and rejected', () => {
    const worker = gridEmployee('1', 'Worker', { '2026-11-05': apiPair('a', 0, '08:00', '16:00') })
    const zero = gridEmployee('2', 'Zero')
    const decisions: ApprovalDecisionInput[] = [
      { employeeId: '3', employeeCode: 'TPLGOAHLP003', employeeName: 'Rejected', decision: 'REJECTED' },
      { employeeId: '4', employeeCode: 'TPLGOAHLP004', employeeName: 'Approved', decision: 'APPROVED' },
    ]
    const summary = buildApprovalSummary({ employees: [worker, zero] }, decisions)
    expect(summary.leftOut).toEqual([
      { employeeId: '2', employeeCode: 'TPLGOAHLP2', employeeName: 'Zero', reason: 'ZERO_HOURS' },
      { employeeId: '3', employeeCode: 'TPLGOAHLP003', employeeName: 'Rejected', reason: 'REJECTED' },
    ])
    expect(summary.employeeCount).toBe(1)
  })

  it('handles an empty week', () => {
    expect(buildApprovalSummary({ employees: [] }, [])).toEqual({
      employeeCount: 0,
      totalRegularHours: 0,
      totalOvertimeHours: 0,
      editedDays: 0,
      editedDayDetails: [],
      leftOut: [],
    })
  })
})

// ─── buildAttendanceRecords (US-12.24) ────────────────────────────────────────

describe('buildAttendanceRecords (US-12.24)', () => {
  it('carries the grid hours into the record for that day', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': fullDayRows('a') })
    const records = buildAttendanceRecords('upload-1', { employees: [e] }, [])
    const day = records.find((r) => (r.attendanceDate as Date).toISOString().startsWith('2026-11-05'))
    expect(day).toMatchObject({ regularHours: 8, overtimeHours: 1.25 })
  })

  it('writes seven rows per payroll employee, one per date, zeros for empty days', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': fullDayRows('a') })
    const records = buildAttendanceRecords('upload-1', { employees: [e] }, [])
    expect(records).toHaveLength(7)
    expect(records.map((r) => (r.attendanceDate as Date).toISOString().slice(0, 10))).toEqual(dates)
    expect(records.slice(1).every((r) => r.regularHours === 0 && r.overtimeHours === 0)).toBe(true)
  })

  it('leaves the six legacy slot columns and sheet fields null', () => {
    const e = gridEmployee('1', 'A', { '2026-11-05': fullDayRows('a') })
    const [first] = buildAttendanceRecords('upload-1', { employees: [e] }, [])
    expect(first).toMatchObject({
      attendanceUploadId: 'upload-1',
      employeeId: '1',
      beforeNoonIn: null,
      beforeNoonOut: null,
      afternoonIn: null,
      afternoonOut: null,
      overtimeIn: null,
      overtimeOut: null,
      sourceSheetName: null,
      sourceEmployeeBlockIndex: null,
    })
  })

  it('creates no rows for a zero-hour employee', () => {
    const zero = gridEmployee('2', 'Zero')
    expect(buildAttendanceRecords('upload-1', { employees: [zero] }, [])).toEqual([])
  })

  it('sets verificationDecision from the decision, else null', () => {
    const a = gridEmployee('1', 'A', { '2026-11-05': apiPair('a', 0, '08:00', '16:00') })
    const b = gridEmployee('2', 'B', { '2026-11-05': apiPair('b', 0, '08:00', '16:00') })
    const records = buildAttendanceRecords('u', { employees: [a, b] }, [{ employeeId: '1', decision: 'APPROVED' }])
    expect(records.filter((r) => r.employeeId === '1').every((r) => r.verificationDecision === 'APPROVED')).toBe(true)
    expect(records.filter((r) => r.employeeId === '2').every((r) => r.verificationDecision === null)).toBe(true)
  })

  it('hours per day equal the grid day hours', () => {
    const e = gridEmployee('1', 'A', {
      '2026-11-05': fullDayRows('a'),
      '2026-11-06': apiPair('b', 0, '08:00', '11:10'),
    })
    const records = buildAttendanceRecords('u', { employees: [e] }, [])
    expect(records.map((r) => [r.regularHours, r.overtimeHours]).slice(0, 2)).toEqual(
      e.days.slice(0, 2).map((d) => [d.regularHours, d.overtimeHours]),
    )
  })
})

// ─── canPullNow (US-12.6 adapted per C2, US-12.33) ────────────────────────────

describe('canPullNow (C2)', () => {
  const today = '2026-11-12'
  const base = {
    source: 'ETIMEOFFICE' as const,
    status: 'NO_DATA' as const,
    payrollStatus: 'NOT_GENERATED' as const,
    isSyncing: false,
    start: '2026-10-01',
  }

  it('is true for a past week with no data', () => {
    expect(canPullNow({ ...base, source: null }, today)).toBe(true)
  })

  it('is true for a past week after a failed sync', () => {
    expect(canPullNow({ ...base, status: 'SYNC_FAILED' }, today)).toBe(true)
  })

  it('is true for a week with data (REVIEW)', () => {
    expect(canPullNow({ ...base, status: 'REVIEW', start: '2026-11-05' }, today)).toBe(true)
  })

  it('is true for an in-progress week', () => {
    expect(canPullNow({ ...base, status: 'NO_DATA', start: '2026-11-12' }, today)).toBe(true)
  })

  it('is false for an APPROVED week', () => {
    expect(canPullNow({ ...base, status: 'APPROVED' }, today)).toBe(false)
  })

  it('is false for an Excel-era week (US-12.33)', () => {
    expect(canPullNow({ ...base, source: 'EXCEL', status: 'APPROVED' }, today)).toBe(false)
    expect(canPullNow({ ...base, source: 'EXCEL', status: 'REVIEW' }, today)).toBe(false)
  })

  it.each(['APPROVED', 'REVISED'] as const)('is false when payroll is %s', (payrollStatus) => {
    expect(canPullNow({ ...base, status: 'REVIEW', payrollStatus }, today)).toBe(false)
  })

  it('is false for a future week', () => {
    expect(canPullNow({ ...base, start: '2026-11-13' }, today)).toBe(false)
  })

  it('is false while a sync holds the lock', () => {
    expect(canPullNow({ ...base, isSyncing: true }, today)).toBe(false)
  })
})

// ─── canReopenWeek (US-12.27, 12.28) ──────────────────────────────────────────

describe('canReopenWeek', () => {
  const approved = { source: 'ETIMEOFFICE' as const, status: 'APPROVED' as const, payrollStatus: 'NOT_GENERATED' as const }

  it('is true before payroll exists', () => {
    expect(canReopenWeek(approved)).toBe(true)
  })

  it('is false for an unapproved week', () => {
    expect(canReopenWeek({ ...approved, status: 'REVIEW' })).toBe(false)
    expect(canReopenWeek({ ...approved, status: 'SYNC_FAILED' })).toBe(false)
    expect(canReopenWeek({ ...approved, status: 'NO_DATA' })).toBe(false)
  })

  it('is false after payroll approval', () => {
    expect(canReopenWeek({ ...approved, payrollStatus: 'APPROVED' })).toBe(false)
  })

  it('is false after a revision', () => {
    expect(canReopenWeek({ ...approved, payrollStatus: 'REVISED' })).toBe(false)
  })

  it('is false for an Excel-era week and a virtual week', () => {
    expect(canReopenWeek({ ...approved, source: 'EXCEL' })).toBe(false)
    expect(canReopenWeek({ ...approved, source: null })).toBe(false)
  })
})

// ─── shouldScheduledSyncReplace (C1) ──────────────────────────────────────────

describe('shouldScheduledSyncReplace (C1)', () => {
  it('is true when the week has no edits or decisions', () => {
    expect(shouldScheduledSyncReplace({ hasEditsOrDecisions: false, status: 'REVIEW' })).toBe(true)
  })

  it('is true for a failed or empty week', () => {
    expect(shouldScheduledSyncReplace({ hasEditsOrDecisions: false, status: 'SYNC_FAILED' })).toBe(true)
    expect(shouldScheduledSyncReplace({ hasEditsOrDecisions: false, status: 'NO_DATA' })).toBe(true)
  })

  it('is false when the week has edits or decisions', () => {
    expect(shouldScheduledSyncReplace({ hasEditsOrDecisions: true, status: 'REVIEW' })).toBe(false)
  })

  it('is false for an approved week', () => {
    expect(shouldScheduledSyncReplace({ hasEditsOrDecisions: false, status: 'APPROVED' })).toBe(false)
  })
})

// ─── getAttendanceWeekStatus (US-12.33) ───────────────────────────────────────

describe('getAttendanceWeekStatus (US-12.33, C6)', () => {
  it('no row is NO_DATA', () => {
    expect(getAttendanceWeekStatus(null)).toBe('NO_DATA')
  })

  it.each(['READY', 'ERRORS', 'APPROVED', 'anything'])('an Excel-era row with status %s reads as approved', (status) => {
    expect(getAttendanceWeekStatus({ source: 'EXCEL', status })).toBe('APPROVED')
  })

  it.each(['SYNC_FAILED', 'REVIEW', 'APPROVED'] as const)('an eTimeOffice row keeps status %s', (status) => {
    expect(getAttendanceWeekStatus({ source: 'ETIMEOFFICE', status })).toBe(status)
  })

  it('an eTimeOffice row with an unexpected status falls back to SYNC_FAILED', () => {
    expect(getAttendanceWeekStatus({ source: 'ETIMEOFFICE', status: 'READY' })).toBe('SYNC_FAILED')
  })
})
