// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import {
  getEmployeeCheck,
  getEmployeeCheckIssues,
  ignoreCode,
  matchCodeToEmployee,
  rematchWeekCodes,
  setEmployeeDecision,
} from '@/features/attendance-sync/services/employee-check.service'
import {
  auditRows,
  dayPunches,
  makeEmployee,
  makeExcelUpload,
  makePunch,
  makeUpload,
  resetDb,
  utc,
  type Db,
} from './service-fixtures'

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'

// The people in the week.
const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const sevenA = makeEmployee({ id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp' })
const sevenB = makeEmployee({ id: 'emp-7b', employeeId: 'TPLGOASUP007', employeeName: 'Seven Sup' })
const inactive = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })
const resigned = makeEmployee({
  id: 'emp-3',
  employeeId: 'TPLGOAHLP003',
  employeeName: 'Gone Before',
  dateOfResignation: new Date('2026-11-01T00:00:00Z'),
})
const resigningDuringWeek = makeEmployee({
  id: 'emp-4',
  employeeId: 'TPLGOAHLP004',
  employeeName: 'Leaving Soon',
  dateOfResignation: new Date('2026-11-07T00:00:00Z'),
})

beforeEach(() => {
  resetDb(db)
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.employee.findMany.mockResolvedValue([asha, sevenA, sevenB, inactive, resigned, resigningDuringWeek])
})

// ─── getEmployeeCheck (US-12.8, US-12.9, C3) ──────────────────────────────────

describe('getEmployeeCheck', () => {
  const punches = () => [
    // Unknown code 0999 on two days, with the name eTimeOffice has for it.
    ...dayPunches({ idPrefix: 'u1', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN', empName: 'Empname0999' }),
    ...dayPunches({ idPrefix: 'u2', employeeId: null, empCode: '0999', date: '2026-11-06', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN', empName: 'Empname0999' }),
    // Duplicate code 0007 (matches both TPLGOAHLP007 and TPLGOASUP007).
    ...dayPunches({ idPrefix: 'd1', employeeId: null, empCode: '0007', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'DUPLICATE', empName: 'Empname0007' }),
    // An ignored code.
    ...dayPunches({ idPrefix: 'g1', employeeId: null, empCode: '0555', date: '2026-11-05', times: ['09:00', '10:00'], matchStatus: 'IGNORED', empName: 'Test Enrollment' }),
    // Matched: an active employee, an inactive one (2 days) and one who resigned before the week.
    ...dayPunches({ idPrefix: 'm1', employeeId: 'emp-36', empCode: '0036', date: '2026-11-05', times: ['08:00', '16:00'] }),
    ...dayPunches({ idPrefix: 'i1', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['07:40', '13:04', '13:56', '17:47'] }),
    ...dayPunches({ idPrefix: 'i2', employeeId: 'emp-2', empCode: '0002', date: '2026-11-06', times: ['08:00', '12:00'] }),
    ...dayPunches({ idPrefix: 'r1', employeeId: 'emp-3', empCode: '0003', date: '2026-11-05', times: ['08:00', '16:30'] }),
    // Resigning during the week: a normal employee, never needs a decision.
    ...dayPunches({ idPrefix: 'l1', employeeId: 'emp-4', empCode: '0004', date: '2026-11-05', times: ['08:00', '16:00'] }),
  ]

  beforeEach(() => db.attendancePunch.findMany.mockResolvedValue(punches()))

  it('lists unknown and duplicate codes with the name eTimeOffice has, punch and day counts', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.codes.map((c) => c.empCode)).toEqual(['0007', '0999'])
    const unknown = check.codes.find((c) => c.empCode === '0999')!
    expect(unknown).toMatchObject({ empName: 'Empname0999', status: 'UNKNOWN', punchCount: 4, dayCount: 2, candidates: [] })
    const duplicate = check.codes.find((c) => c.empCode === '0007')!
    expect(duplicate).toMatchObject({ empName: 'Empname0007', status: 'DUPLICATE', punchCount: 2, dayCount: 1 })
  })

  it('lists both candidates of a duplicate code, sorted by Employee ID, with no guess applied', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    const duplicate = check.codes.find((c) => c.empCode === '0007')!
    expect(duplicate.candidates.map((c) => c.employeeId)).toEqual(['TPLGOAHLP007', 'TPLGOASUP007'])
  })

  it('lists ignored codes separately, read-only', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.ignoredCodes).toEqual([{ empCode: '0555', empName: 'Test Enrollment', punchCount: 2 }])
    expect(check.codes.some((c) => c.empCode === '0555')).toBe(false)
  })

  it('lists inactive and resigned-before-week employees who have punches, with their hours and no decision yet', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    // Sorted by name: "Gone Before" then "Old Timer".
    expect(check.decisions.map((d) => d.employeeCode)).toEqual(['TPLGOAHLP003', 'TPLGOAHLP002'])
    const inactiveRow = check.decisions.find((d) => d.employeeId === 'emp-2')!
    expect(inactiveRow).toMatchObject({
      employeeName: 'Old Timer',
      reason: 'INACTIVE',
      resignedOn: null,
      dayCount: 2,
      regularHours: 12, // 8.00 on 5 Nov (overtime 1.25 separate) + 4.00 on 6 Nov
      overtimeHours: 1.25,
      decision: null,
    })
    const resignedRow = check.decisions.find((d) => d.employeeId === 'emp-3')!
    expect(resignedRow).toMatchObject({
      reason: 'RESIGNED_BEFORE_WEEK',
      resignedOn: '2026-11-01',
      dayCount: 1,
      regularHours: 8,
      overtimeHours: 0.5,
      decision: null,
    })
  })

  it('does not ask for a decision for an employee resigning during the week, or an active one', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    const ids = check.decisions.map((d) => d.employeeId)
    expect(ids).not.toContain('emp-4')
    expect(ids).not.toContain('emp-36')
  })

  it('does not ask for a decision when an inactive employee has no punches this week', async () => {
    db.attendancePunch.findMany.mockResolvedValue(
      dayPunches({ idPrefix: 'm1', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
    )

    expect((await getEmployeeCheck(WEEK_ID)).decisions).toEqual([])
  })

  it('shows recorded decisions', async () => {
    db.attendanceEmployeeDecision.findMany.mockResolvedValue([
      { employeeId: 'emp-2', decision: 'APPROVED' },
      { employeeId: 'emp-3', decision: 'REJECTED' },
    ])

    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.decisions.find((d) => d.employeeId === 'emp-2')!.decision).toBe('APPROVED')
    expect(check.decisions.find((d) => d.employeeId === 'emp-3')!.decision).toBe('REJECTED')
    expect(check.counts.decisionsLeft).toBe(0)
  })

  it('counts codes in the sync and is not complete while a code or decision is open', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.counts).toEqual({
      codesInSync: 7, // 0999, 0007, 0555, 0036, 0002, 0003, 0004
      matched: 4,
      unknown: 1,
      duplicate: 1,
      decisionsLeft: 2,
    })
    expect(check.complete).toBe(false)
  })

  it('is complete once nothing is unknown or duplicate and every decision is made', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      ...dayPunches({ idPrefix: 'm1', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
      ...dayPunches({ idPrefix: 'g1', employeeId: null, empCode: '0555', date: '2026-11-05', times: ['09:00', '10:00'], matchStatus: 'IGNORED' }),
      ...dayPunches({ idPrefix: 'i1', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }),
    ])
    db.attendanceEmployeeDecision.findMany.mockResolvedValue([{ employeeId: 'emp-2', decision: 'REJECTED' }])

    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.codes).toEqual([])
    expect(check.complete).toBe(true)
  })

  it('recomputes candidates now: a duplicate whose second ID was edited has no candidates until it is rematched', async () => {
    // TPLGOASUP007 was renamed TPLGOASUP070, so 0007 now matches only one employee.
    db.employee.findMany.mockResolvedValue([asha, sevenA, { ...sevenB, employeeId: 'TPLGOASUP070' }])

    const check = await getEmployeeCheck(WEEK_ID)

    const duplicate = check.codes.find((c) => c.empCode === '0007')!
    expect(duplicate.status).toBe('DUPLICATE') // stored status; rematch updates it
    expect(duplicate.candidates).toEqual([])
  })

  it('offers every employee, sorted by name, for the match picker', async () => {
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.allEmployees.map((e) => e.employeeName)).toEqual([
      'Asha Rao',
      'Gone Before',
      'Leaving Soon',
      'Old Timer',
      'Seven Hlp',
      'Seven Sup',
    ])
    expect(Object.keys(check.allEmployees[0]).sort()).toEqual(['employeeId', 'employeeName', 'id'])
  })

  it('reads only the live set and never the unmatched/ignored punches as hours', async () => {
    await getEmployeeCheck(WEEK_ID)

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null } }),
    )
  })

  it('works on an approved week (read-only) and rejects an Excel-era week', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))
    await expect(getEmployeeCheck(WEEK_ID)).resolves.toMatchObject({ weekId: WEEK_ID })

    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())
    await expect(getEmployeeCheck(WEEK_ID)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })

  it('rejects a weekId that is not a Thursday and a week with no data', async () => {
    await expect(getEmployeeCheck('2026-11-06')).rejects.toMatchObject({ code: 'INVALID_WEEK' })

    db.attendanceUpload.findFirst.mockResolvedValue(null)
    await expect(getEmployeeCheck(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
  })
})

// ─── getEmployeeCheckIssues (US-12.8) ─────────────────────────────────────────

describe('getEmployeeCheckIssues', () => {
  it('counts both kinds of code', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      ...dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN' }),
      ...dayPunches({ idPrefix: 'd', employeeId: null, empCode: '0007', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'DUPLICATE' }),
      ...dayPunches({ idPrefix: 'm', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
    ])

    expect(await getEmployeeCheckIssues(WEEK_ID)).toEqual({ unresolvedCodes: 2, pendingDecisions: 0 })
  })

  it('counts a pending decision until it is recorded', async () => {
    db.attendancePunch.findMany.mockResolvedValue(
      dayPunches({ idPrefix: 'i', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }),
    )
    expect(await getEmployeeCheckIssues(WEEK_ID)).toEqual({ unresolvedCodes: 0, pendingDecisions: 1 })

    db.attendanceEmployeeDecision.findMany.mockResolvedValue([{ employeeId: 'emp-2' }])
    expect(await getEmployeeCheckIssues(WEEK_ID)).toEqual({ unresolvedCodes: 0, pendingDecisions: 0 })
  })

  it('is clean when every code is matched or ignored', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      ...dayPunches({ idPrefix: 'g', employeeId: null, empCode: '0555', date: '2026-11-05', times: ['09:00', '10:00'], matchStatus: 'IGNORED' }),
      ...dayPunches({ idPrefix: 'm', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
    ])

    expect(await getEmployeeCheckIssues(WEEK_ID)).toEqual({ unresolvedCodes: 0, pendingDecisions: 0 })
  })
})

// ─── rematchWeekCodes (US-12.8 AC6, E2E-35) ───────────────────────────────────

describe('rematchWeekCodes', () => {
  const newEmployee = makeEmployee({ id: 'emp-999', employeeId: 'TPLGOAHLP999', employeeName: 'New Hire' })

  /**
   * rematchWeekCodes reads the unresolved codes (the `distinct` query), the employees and the saved
   * exceptions on the plain client. Each code that changes then runs in its own transaction, on db.tx: the
   * unresolved count under the lock, the two lookups linkCodeToEmployee makes (the code's rows, then the
   * employee's existing pairs) and the writes.
   */
  function serveRematch(opts: {
    unresolved: Array<{ empCode: string; matchStatus: string }>
    employees?: Array<ReturnType<typeof makeEmployee>>
    exceptions?: Array<{ empCode: string; kind: string; employeeId: string | null }>
    codeRows?: Array<{ id: string; punchDate: Date; pairIndex: number }>
    existing?: Array<{ punchDate: Date; pairIndex: number }>
  }) {
    db.employee.findMany.mockResolvedValue(opts.employees ?? [asha, sevenA, sevenB, inactive, resigned, resigningDuringWeek])
    db.attendanceCodeException.findMany.mockResolvedValue(opts.exceptions ?? [])
    db.attendancePunch.findMany.mockResolvedValue(opts.unresolved)
    db.tx.attendancePunch.count.mockResolvedValue(opts.codeRows?.length ?? 1) // still unresolved under the lock
    db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) =>
      where.empCode ? (opts.codeRows ?? []) : (opts.existing ?? []),
    )
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: opts.codeRows?.length ?? 0 })
  }

  it('links the punches of a code to an employee created after the fix, and says which codes matched', async () => {
    serveRematch({
      employees: [asha, newEmployee],
      unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }],
      codeRows: [
        { id: 'u1-0', punchDate: utc('2026-11-05'), pairIndex: 0 },
        { id: 'u1-1', punchDate: utc('2026-11-05'), pairIndex: 0 },
      ],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({
      matched: [{ empCode: '0999', employeeId: 'emp-999', employeeCode: 'TPLGOAHLP999' }],
      stillUnresolved: [],
    })
    // The write and the audit row happen in the code's own transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.auditLog.create).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1-0', 'u1-1'] } },
      data: { employeeId: 'emp-999', matchStatus: 'MATCHED' },
    })
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_CODE', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Code 0999 linked to TPLGOAHLP999',
      empCode: '0999',
      employeeId: 'emp-999',
      via: 'NUMBER',
      linkedPunches: 2,
    })
  })

  it('looks only at unresolved codes in the live set', async () => {
    serveRematch({ unresolved: [] })

    await rematchWeekCodes(WEEK_ID)

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      select: { empCode: true, matchStatus: true },
      distinct: ['empCode'],
    })
  })

  it('leaves a code that still matches nothing in the unresolved list and writes nothing', async () => {
    serveRematch({ unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0999'] })
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.auditLog.create).not.toHaveBeenCalled()
  })

  it('does not guess: a code that now matches two employees stays unresolved as DUPLICATE', async () => {
    serveRematch({ unresolved: [{ empCode: '0007', matchStatus: 'UNKNOWN' }] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0007'] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0007', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      data: { matchStatus: 'DUPLICATE' },
    })
  })

  it('turns a duplicate whose second ID was edited into a match for the remaining employee', async () => {
    serveRematch({
      employees: [sevenA, { ...sevenB, employeeId: 'TPLGOASUP070' }],
      unresolved: [{ empCode: '0007', matchStatus: 'DUPLICATE' }],
      codeRows: [{ id: 'd1-0', punchDate: utc('2026-11-05'), pairIndex: 0 }],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.matched).toEqual([{ empCode: '0007', employeeId: 'emp-7a', employeeCode: 'TPLGOAHLP007' }])
  })

  it('turns a duplicate whose second ID was edited into UNKNOWN when neither matches any more', async () => {
    serveRematch({ employees: [asha], unresolved: [{ empCode: '0007', matchStatus: 'DUPLICATE' }] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0007'] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { matchStatus: 'UNKNOWN' } }),
    )
  })

  it('appends the code\'s pairs after an employee\'s existing pairs on the same day and never re-pairs existing punches', async () => {
    serveRematch({
      employees: [asha, newEmployee],
      unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }],
      codeRows: [
        { id: 'c-0', punchDate: utc('2026-11-05'), pairIndex: 0 }, // same day as an existing pair 0 and 1
        { id: 'c-1', punchDate: utc('2026-11-05'), pairIndex: 0 },
        { id: 'c-2', punchDate: utc('2026-11-06'), pairIndex: 0 }, // a day the employee has nothing on
      ],
      existing: [
        { punchDate: utc('2026-11-05'), pairIndex: 0 },
        { punchDate: utc('2026-11-05'), pairIndex: 1 },
      ],
    })

    await rematchWeekCodes(WEEK_ID)

    // The rows on the day with existing pairs 0 and 1 move together, by an increment of 2.
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-0', 'c-1'] } },
      data: { employeeId: 'emp-999', matchStatus: 'MATCHED', pairIndex: { increment: 2 } },
    })
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    // The row on the free day is linked as is.
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-2'] } },
      data: { employeeId: 'emp-999', matchStatus: 'MATCHED' },
    })
  })

  it('applies a saved IGNORE exception to a code that is still unresolved', async () => {
    serveRematch({
      exceptions: [{ empCode: '0999', kind: 'IGNORE', employeeId: null }],
      unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: [] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0999', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      data: { employeeId: null, matchStatus: 'IGNORED' },
    })
    // The write and its audit row are in the same transaction, not on the plain client.
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(auditRows(db)).toHaveLength(0)
    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_CODE' })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Code 0999 ignored' })
  })

  it('applies a saved MATCH exception even when the number matches nothing (C3, E2E-36)', async () => {
    serveRematch({
      exceptions: [{ empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' }],
      unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }],
      codeRows: [{ id: 'u1-0', punchDate: utc('2026-11-05'), pairIndex: 0 }],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.matched).toEqual([{ empCode: '0999', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' }])
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ via: 'EXCEPTION' })
  })

  it('refuses an approved week (WEEK_LOCKED) and reads nothing', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
  })
})

// ─── matchCodeToEmployee (C3, E2E-36) ─────────────────────────────────────────

describe('matchCodeToEmployee', () => {
  beforeEach(() => {
    db.attendancePunch.count.mockResolvedValue(4)
    db.tx.attendancePunch.count.mockResolvedValue(4) // the same check, repeated under the week lock
    db.employee.findUnique.mockResolvedValue({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
    db.tx.employee.findUnique.mockResolvedValue({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' }) // read again under the lock
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-1' })
    db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) =>
      where.empCode
        ? [
            { id: 'u1-0', punchDate: utc('2026-11-05'), pairIndex: 0 },
            { id: 'u1-1', punchDate: utc('2026-11-05'), pairIndex: 0 },
          ]
        : [],
    )
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 2 })
  })

  it('saves a MATCH exception and links the code\'s punches to the employee', async () => {
    const result = await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(result).toEqual({ linkedPunches: 2 })
    expect(db.tx.attendanceCodeException.upsert).toHaveBeenCalledWith({
      where: { empCode: '0999' },
      create: { empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' },
      update: { kind: 'MATCH', employeeId: 'emp-36' },
    })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1-0', 'u1-1'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED' },
    })
  })

  it('does all of it in one transaction, with a CREATE audit row against the exception', async () => {
    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.auditLog.create).not.toHaveBeenCalled()
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'CREATE', entityType: 'ATTENDANCE_CODE', entityId: 'exception-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Code 0999 matched to Asha Rao (TPLGOAHLP036)',
      empCode: '0999',
      kind: 'MATCH',
      employeeId: 'emp-36',
      employeeCode: 'TPLGOAHLP036',
      linkedPunches: 2,
    })
  })

  it('audits an UPDATE when the code already had a saved exception', async () => {
    db.tx.attendanceCodeException.findUnique.mockResolvedValue({ id: 'exception-1' })

    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(auditRows(db.tx)[0].actionType).toBe('UPDATE')
  })

  it('checks the code is unresolved in the live set of this week first', async () => {
    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(db.attendancePunch.count).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0999', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
    })
  })

  it('refuses a code that does not need fixing (CODE_NOT_FOUND) and saves nothing', async () => {
    db.attendancePunch.count.mockResolvedValue(0)

    await expect(matchCodeToEmployee(WEEK_ID, '0036', 'emp-36')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
  })

  it('refuses an employee that no longer exists (EMPLOYEE_NOT_FOUND) and saves nothing', async () => {
    db.employee.findUnique.mockResolvedValue(null)

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'gone')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('refuses an approved week (WEEK_LOCKED)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('does not audit when the transaction fails part way', async () => {
    db.tx.attendancePunch.updateMany.mockRejectedValue(new Error('deadlock'))

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).rejects.toThrow('deadlock')
    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

// ─── ignoreCode (C3, E2E-37) ──────────────────────────────────────────────────

describe('ignoreCode', () => {
  beforeEach(() => {
    db.attendancePunch.count.mockResolvedValue(4)
    db.tx.attendancePunch.count.mockResolvedValue(4) // the same check, repeated under the week lock
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-9' })
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 4 })
  })

  it('saves an IGNORE exception and marks the code\'s unresolved punches IGNORED', async () => {
    const result = await ignoreCode(WEEK_ID, '0999')

    expect(result).toEqual({ ignoredPunches: 4 })
    expect(db.tx.attendanceCodeException.upsert).toHaveBeenCalledWith({
      where: { empCode: '0999' },
      create: { empCode: '0999', kind: 'IGNORE', employeeId: null },
      update: { kind: 'IGNORE', employeeId: null },
    })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0999', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      data: { matchStatus: 'IGNORED', employeeId: null },
    })
  })

  it('audits the exception inside the same transaction', async () => {
    await ignoreCode(WEEK_ID, '0999')

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'CREATE', entityType: 'ATTENDANCE_CODE', entityId: 'exception-9' })
    expect(audit.detailsJson).toMatchObject({ summary: 'Code 0999 ignored', kind: 'IGNORE', ignoredPunches: 4 })
  })

  it('audits an UPDATE when the code already had an exception', async () => {
    db.tx.attendanceCodeException.findUnique.mockResolvedValue({ id: 'exception-9' })

    await ignoreCode(WEEK_ID, '0999')

    expect(auditRows(db.tx)[0].actionType).toBe('UPDATE')
  })

  it('refuses a code that is not unresolved (CODE_NOT_FOUND)', async () => {
    db.attendancePunch.count.mockResolvedValue(0)

    await expect(ignoreCode(WEEK_ID, '0036')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('refuses an approved week (WEEK_LOCKED)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))

    await expect(ignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
  })
})

// ─── setEmployeeDecision (US-12.9) ────────────────────────────────────────────

describe('setEmployeeDecision', () => {
  const inactiveLite = { id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false, dateOfResignation: null }

  beforeEach(() => {
    db.employee.findUnique.mockResolvedValue(inactiveLite)
    db.attendancePunch.count.mockResolvedValue(4)
    db.tx.attendancePunch.count.mockResolvedValue(4) // the same count, repeated under the week lock
    db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue(null)
    db.tx.attendanceEmployeeDecision.create.mockResolvedValue({ id: 'decision-1' })
  })

  it('records a first decision for an inactive employee with punches, with the reason', async () => {
    const result = await setEmployeeDecision(WEEK_ID, 'emp-2', 'REJECTED')

    expect(result).toEqual({ decision: 'REJECTED' })
    expect(db.tx.attendanceEmployeeDecision.create).toHaveBeenCalledWith({
      data: { attendanceUploadId: 'upload-1', employeeId: 'emp-2', reason: 'INACTIVE', decision: 'REJECTED' },
    })
    expect(db.tx.attendanceEmployeeDecision.update).not.toHaveBeenCalled()
  })

  it('audits a CREATE with the old/new decision and a readable summary', async () => {
    await setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')

    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'CREATE', entityType: 'ATTENDANCE_DECISION', entityId: 'decision-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Approved Old Timer (TPLGOAHLP002): inactive',
      employeeId: 'emp-2',
      reason: 'INACTIVE',
      old: null,
      new: { decision: 'APPROVED' },
    })
  })

  it('changes an existing decision with an UPDATE audit carrying the previous value', async () => {
    db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue({ id: 'decision-1', decision: 'APPROVED' })
    db.tx.attendanceEmployeeDecision.update.mockResolvedValue({ id: 'decision-1' })

    await setEmployeeDecision(WEEK_ID, 'emp-2', 'REJECTED')

    expect(db.tx.attendanceEmployeeDecision.update).toHaveBeenCalledWith({
      where: { attendanceUploadId_employeeId: { attendanceUploadId: 'upload-1', employeeId: 'emp-2' } },
      data: { decision: 'REJECTED', reason: 'INACTIVE' },
    })
    expect(db.tx.attendanceEmployeeDecision.create).not.toHaveBeenCalled()
    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'UPDATE', entityId: 'decision-1' })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ old: { decision: 'APPROVED' }, new: { decision: 'REJECTED' } })
  })

  it('uses RESIGNED_BEFORE_WEEK as the reason for an employee who resigned before the week', async () => {
    db.employee.findUnique.mockResolvedValue({ ...resigned })

    await setEmployeeDecision(WEEK_ID, 'emp-3', 'APPROVED')

    expect(db.tx.attendanceEmployeeDecision.create).toHaveBeenCalledWith({
      data: { attendanceUploadId: 'upload-1', employeeId: 'emp-3', reason: 'RESIGNED_BEFORE_WEEK', decision: 'APPROVED' },
    })
    expect(auditRows(db.tx)[0].detailsJson.summary).toBe('Approved Gone Before (TPLGOAHLP003): resigned before the week')
  })

  it('counts the employee\'s live punches to decide whether a decision is needed', async () => {
    await setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')

    expect(db.attendancePunch.count).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-2' },
    })
  })

  it.each(['APPROVED', 'SYNC_FAILED'])('refuses a week that is %s (WEEK_LOCKED)', async (status) => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status }))

    await expect(setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('refuses an employee that no longer exists (EMPLOYEE_NOT_FOUND)', async () => {
    db.employee.findUnique.mockResolvedValue(null)

    await expect(setEmployeeDecision(WEEK_ID, 'gone', 'APPROVED')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('refuses an employee who does not need a decision (VALIDATION_ERROR): an active one', async () => {
    db.employee.findUnique.mockResolvedValue({ ...asha })

    await expect(setEmployeeDecision(WEEK_ID, 'emp-36', 'APPROVED')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('refuses an inactive employee with no punches this week (VALIDATION_ERROR)', async () => {
    db.attendancePunch.count.mockResolvedValue(0)

    await expect(setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('refuses an employee who resigns during the week (VALIDATION_ERROR)', async () => {
    db.employee.findUnique.mockResolvedValue({ ...resigningDuringWeek })

    await expect(setEmployeeDecision(WEEK_ID, 'emp-4', 'REJECTED')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('punch fixture sanity', () => {
  it('builds MATCHED punches by default', () => {
    expect(makePunch().matchStatus).toBe('MATCHED')
  })
})
