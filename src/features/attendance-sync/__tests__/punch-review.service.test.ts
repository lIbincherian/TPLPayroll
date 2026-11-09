// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { getPunchReview, loadReviewContext, savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import { AttendanceSyncError, type ReviewMode, type SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makeExcelUpload,
  makePunch,
  makeRun,
  makeSession,
  makeUpload,
  resetDb,
  serveUpload,
  utc,
  WEEK_DATES,
  type Db,
  type PunchRow,
  type PunchStore,
} from './service-fixtures'

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

function seed(rows: PunchRow[], employees = [asha, ravi]) {
  store = installPunchStore(db, rows)
  db.employee.findMany.mockResolvedValue(employees)
}

const snapshot = () => JSON.parse(JSON.stringify(store.rows))
const ashaDay = (idPrefix = 'p', times = FULL_DAY, date = '2026-11-05') =>
  dayPunches({ idPrefix, employeeId: 'emp-36', date, times })

function pair(pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair {
  return { pairIndex, in: inn, out }
}

/** The four saved punches of a full day, optionally with a changed last OUT. */
function fullDayPairs(lastOut = '17:47'): SavePair[] {
  return [
    pair(0, { punchId: 'p-0', time: '07:40' }, { punchId: 'p-1', time: '13:04' }),
    pair(1, { punchId: 'p-2', time: '13:56' }, { punchId: 'p-3', time: lastOut }),
  ]
}

function save(pairs: SavePair[], over: Partial<Parameters<typeof savePunchEdit>[0]> = {}) {
  return savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: '2026-11-05', mode: LIVE, pairs, ...over })
}

function expectNoWrites() {
  expect(db.$transaction).not.toHaveBeenCalled()
  for (const client of [db, db.tx]) {
    expect(client.attendancePunch.create).not.toHaveBeenCalled()
    expect(client.attendancePunch.update).not.toHaveBeenCalled()
    expect(client.attendancePunch.delete).not.toHaveBeenCalled()
    expect(client.auditLog.create).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  // Friday 13 Nov 2026, IST: the 5-11 Nov week has ended.
  freezeClock('2026-11-13T03:00:00Z')
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  seed([])
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(fetchPunchData).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── getPunchReview ───────────────────────────────────────────────────────────

describe('getPunchReview', () => {
  it('lists every active employee, including one with no punches, with seven days Thursday first (US-12.13)', async () => {
    seed(ashaDay())

    const review = await getPunchReview(WEEK_ID)

    expect(review.employees.map((e) => e.employeeName)).toEqual(['Asha Rao', 'Ravi Kumar'])
    expect(review.dates).toEqual(WEEK_DATES)
    expect(review.employees[0].days.map((d) => d.date)).toEqual(WEEK_DATES)
    expect(review.employees[1]).toMatchObject({ hasAnyPunch: false, totalRegularHours: 0, totalOvertimeHours: 0 })
    expect(review.weekId).toBe(WEEK_ID)
    expect(review.week).toEqual({ start: '2026-11-05', end: '2026-11-11' })
  })

  it('shows pairs and per-day hours: 07:40-13:04 and 13:56-17:47 is 8.00 regular and 1.25 overtime', async () => {
    seed(ashaDay())

    const day = (await getPunchReview(WEEK_ID)).employees[0].days[0]

    expect(day.pairs.map((p) => [p.in?.time, p.out?.time])).toEqual([
      ['07:40', '13:04'],
      ['13:56', '17:47'],
    ])
    expect(day).toMatchObject({ regularHours: 8, overtimeHours: 1.25, incomplete: false, isEdited: false })
  })

  it('computes counts, totals and approval for a mixed week', async () => {
    seed([
      ...ashaDay('a', FULL_DAY, '2026-11-05'),
      ...ashaDay('b', ['18:26'], '2026-11-06'), // incomplete: needs fixing
      ...ashaDay('c', ['08:00', '11:10'], '2026-11-07'), // 3.17 h: unusual
      // Two 4-hour pairs per day, so the day is a normal 8 hours (a single pair over 6 hours would be unusual).
      ...ashaDay('d', ['08:30', '12:30', '13:30', '17:30'], '2026-11-08').map((p, i) =>
        i === 0 ? { ...p, originalTime: '08:00' } : p,
      ), // an edited day
      ...ashaDay('e', ['08:00', '12:00', '13:00', '17:00'], '2026-11-09').map((p, i) =>
        i === 0 ? { ...p, mergedScansJson: ['08:01'] } : p,
      ), // a merged day
    ])

    const review = await getPunchReview(WEEK_ID)

    expect(review.counts).toEqual({
      needsFixingDays: 1,
      noPunchEmployees: 1, // Ravi
      unusualDays: 1,
      unresolvedCodes: 0,
      pendingDecisions: 0,
      editedDays: 1,
    })
    expect(review.totals.regular).toBe(27.17) // 8 + 3.17 + 8 + 8
    expect(review.totals.overtime).toBe(1.25)
    expect(review.totals.byDay[0]).toEqual({ date: '2026-11-05', regular: 8, overtime: 1.25 })
    expect(review.totals.byDay[1]).toEqual({ date: '2026-11-06', regular: 0, overtime: 0 })
    const days = review.employees[0].days
    expect(days[1].incomplete).toBe(true)
    expect(days[2]).toMatchObject({ isUnusual: true })
    expect(days[3]).toMatchObject({ isEdited: true })
    expect(days[4]).toMatchObject({ isMerged: true })
    expect(review.approval).toEqual({ canApprove: false, blockers: ['NEEDS_FIXING'], weekHasEnded: true })
  })

  it('allows approval when the week has ended and nothing blocks, ignoring unusual days and no-punch employees (US-12.22)', async () => {
    seed(ashaDay('c', ['08:00', '11:10']))

    const review = await getPunchReview(WEEK_ID)

    expect(review.counts.unusualDays).toBe(1)
    expect(review.counts.noPunchEmployees).toBe(1)
    expect(review.approval).toEqual({ canApprove: true, blockers: [], weekHasEnded: true })
  })

  it('adds WEEK_NOT_ENDED while the week is still running (C4)', async () => {
    freezeClock('2026-11-10T03:00:00Z')
    seed(ashaDay())

    const review = await getPunchReview(WEEK_ID)

    expect(review.approval).toEqual({ canApprove: false, blockers: ['WEEK_NOT_ENDED'], weekHasEnded: false })
  })

  it('never calls the eTimeOffice API (US-12.13 AC6)', async () => {
    seed(ashaDay())

    await getPunchReview(WEEK_ID)

    expect(fetchPunchData).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  describe('who is in the grid', () => {
    const inactiveApproved = makeEmployee({ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Approved Inactive', isActive: false })
    const inactiveNoDecision = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })
    const resignedRejected = makeEmployee({
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
      seed(
        [
          ...dayPunches({ idPrefix: 'i8', employeeId: 'emp-8', empCode: '0008', date: '2026-11-05', times: ['08:00', '16:00'] }),
          ...dayPunches({ idPrefix: 'i2', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }),
          ...dayPunches({ idPrefix: 'r3', employeeId: 'emp-3', empCode: '0003', date: '2026-11-05', times: ['08:00', '16:00'] }),
        ],
        [asha, inactiveApproved, inactiveNoDecision, resignedRejected, resigningDuringWeek],
      )
      db.attendanceEmployeeDecision.findMany.mockResolvedValue([
        { employeeId: 'emp-8', decision: 'APPROVED' },
        { employeeId: 'emp-3', decision: 'REJECTED' },
      ])
    })

    it('lists active employees (also one resigning during the week) and approved inactive ones; omits rejected and undecided', async () => {
      const review = await getPunchReview(WEEK_ID)

      expect(review.employees.map((e) => [e.employeeName, e.tag])).toEqual([
        ['Approved Inactive', 'INACTIVE_APPROVED'],
        ['Asha Rao', 'ACTIVE'],
        ['Leaving Soon', 'ACTIVE'],
      ])
    })

    it('counts the undecided inactive employee as a pending decision, which blocks approval', async () => {
      const review = await getPunchReview(WEEK_ID)

      expect(review.counts.pendingDecisions).toBe(1)
      expect(review.approval.blockers).toContain('PENDING_DECISIONS')
    })
  })

  it('keeps punches of unknown, duplicate and ignored codes out of the grid, and unresolved codes block approval', async () => {
    seed([
      ...ashaDay(),
      ...dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN' }),
      ...dayPunches({ idPrefix: 'd', employeeId: null, empCode: '0007', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'DUPLICATE' }),
      ...dayPunches({ idPrefix: 'g', employeeId: null, empCode: '0555', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'IGNORED' }),
    ])

    const review = await getPunchReview(WEEK_ID)

    expect(review.totals.regular).toBe(8)
    expect(review.counts.unresolvedCodes).toBe(2) // ignored is resolved
    expect(review.approval.blockers).toEqual(['UNRESOLVED_CODES'])
  })

  it('reports locked only for an approved week in live mode, and blocks with NOT_IN_REVIEW', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))

    const review = await getPunchReview(WEEK_ID)

    expect(review).toMatchObject({ status: 'APPROVED', locked: true, approvedAt: '2026-11-12T05:00:00.000Z' })
    expect(review.approval.canApprove).toBe(false)
    expect(review.approval.blockers).toContain('NOT_IN_REVIEW')
  })

  it('is not locked while in review, and a SYNC_FAILED week reports its status', async () => {
    expect((await getPunchReview(WEEK_ID)).locked).toBe(false)

    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'SYNC_FAILED' }))
    expect((await getPunchReview(WEEK_ID)).status).toBe('SYNC_FAILED')
  })

  it('reports lastSavedAt from the newest edited punch and null for untouched weeks', async () => {
    seed([
      ...ashaDay('a'),
      makePunch({ id: 'e-1', pairIndex: 0, position: 'IN', punchDate: utc('2026-11-06'), originalTime: '08:00', currentTime: '08:10', updatedAt: new Date('2026-11-12T09:00:00Z') }),
      makePunch({ id: 'e-2', pairIndex: 0, position: 'OUT', punchDate: utc('2026-11-06'), originalTime: '16:00', currentTime: '16:20', updatedAt: new Date('2026-11-12T11:30:00Z') }),
    ])
    expect((await getPunchReview(WEEK_ID)).lastSavedAt).toBe('2026-11-12T11:30:00.000Z')

    seed(ashaDay())
    expect((await getPunchReview(WEEK_ID)).lastSavedAt).toBeNull()
  })

  describe('payroll state', () => {
    it('is NOT_GENERATED with no run', async () => {
      expect((await getPunchReview(WEEK_ID)).payroll).toEqual({ status: 'NOT_GENERATED', payrollRunId: null, activeCorrectionId: null })
    })

    it('is APPROVED with an approved run, and REVISED after a revision', async () => {
      db.payrollRun.findFirst.mockResolvedValue(makeRun({ status: 'APPROVED' }))
      expect((await getPunchReview(WEEK_ID)).payroll).toMatchObject({ status: 'APPROVED', payrollRunId: 'run-1' })

      db.payrollRun.findFirst.mockResolvedValue(makeRun({ status: 'REVISED' }))
      expect((await getPunchReview(WEEK_ID)).payroll).toMatchObject({ status: 'REVISED', payrollRunId: 'run-1' })
    })

    it('shows the correction in progress in live mode', async () => {
      db.payrollRun.findFirst.mockResolvedValue(makeRun())
      db.payrollCorrectionSession.findFirst.mockResolvedValue(makeSession())

      const review = await getPunchReview(WEEK_ID)

      expect(db.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({ where: { payrollRunId: 'run-1', status: 'IN_PROGRESS' } })
      expect(review.payroll.activeCorrectionId).toBe('session-1')
    })
  })

  describe('correction mode', () => {
    const live = (idPrefix: string, times = FULL_DAY) =>
      dayPunches({ idPrefix, employeeId: 'emp-36', date: '2026-11-05', times })
    const clone = (idPrefix: string, times = FULL_DAY) =>
      dayPunches({ idPrefix, employeeId: 'emp-36', date: '2026-11-05', times, correctionId: 'session-1' })

    beforeEach(() => {
      db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'APPROVED' }))
      db.payrollRun.findFirst.mockResolvedValue(makeRun())
      db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    })

    it('reads the clone set, not the live punches, and is editable although the week is approved', async () => {
      seed([...live('p'), ...clone('c', ['07:40', '13:04', '13:56', '18:00'])])

      const review = await getPunchReview(WEEK_ID, CORRECTION)

      expect(review.employees[0].days[0].overtimeHours).toBe(1.47)
      expect(review).toMatchObject({ status: 'APPROVED', locked: false, mode: CORRECTION })
      expect(review.payroll.activeCorrectionId).toBe('session-1')
      expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: 'session-1' } }),
      )
    })

    it('treats the week as in review and ended, so punches can be approved', async () => {
      seed(clone('c'))

      const review = await getPunchReview(WEEK_ID, CORRECTION)

      expect(review.approval).toEqual({ canApprove: true, blockers: [], weekHasEnded: true })
    })

    it('blocks approval while the clone has an incomplete pair', async () => {
      seed(clone('c', ['07:40', '13:04', '13:56']))

      const review = await getPunchReview(WEEK_ID, CORRECTION)

      expect(review.counts.needsFixingDays).toBe(1)
      expect(review.approval.blockers).toEqual(['NEEDS_FIXING'])
    })

    it.each([
      ['no session', null],
      ['an applied session', makeSession({ status: 'APPLIED' })],
      ['an abandoned session', makeSession({ status: 'ABANDONED' })],
      ['a session of another payroll run', makeSession({ payrollRunId: 'run-9' })],
      ['a session of another week', makeSession({ attendanceUploadId: 'upload-9' })],
    ])('refuses %s (CORRECTION_NOT_ACTIVE)', async (_label, session) => {
      db.payrollCorrectionSession.findUnique.mockResolvedValue(session)

      await expect(getPunchReview(WEEK_ID, CORRECTION)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
      expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
    })
  })

  it('rejects a weekId that is not a Thursday, a week with no data, and an Excel-era week', async () => {
    await expect(getPunchReview('2026-11-06')).rejects.toMatchObject({ code: 'INVALID_WEEK' })

    db.attendanceUpload.findFirst.mockResolvedValue(null)
    await expect(getPunchReview(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())
    await expect(getPunchReview(WEEK_ID)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })
})

describe('loadReviewContext', () => {
  it('returns the upload, week, employees, decisions and live punches', async () => {
    seed(ashaDay())
    db.attendanceEmployeeDecision.findMany.mockResolvedValue([{ employeeId: 'emp-8', decision: 'APPROVED' }])

    const ctx = await loadReviewContext(WEEK_ID)

    expect(ctx.upload.id).toBe('upload-1')
    expect(ctx.week).toEqual({ start: '2026-11-05', end: '2026-11-11' })
    expect(ctx.employees).toHaveLength(2)
    expect(ctx.decisions).toEqual([{ employeeId: 'emp-8', decision: 'APPROVED' }])
    expect(ctx.punches).toHaveLength(4)
    expect(ctx.payrollRun).toBeNull()
    expect(ctx.session).toBeNull()
  })

  it('defaults to live mode', async () => {
    await loadReviewContext(WEEK_ID)

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null } }),
    )
  })
})

// ─── savePunchEdit: hours, original kept, audit (US-12.17, 12.19, 12.20, 12.21) ─

describe('savePunchEdit: changing a time', () => {
  beforeEach(() => seed(ashaDay()))

  it('recalculates the day: 17:47 changed to 18:00 gives 8.00 regular and 1.47 overtime (US-12.17)', async () => {
    const result = await save(fullDayPairs('18:00'))

    expect(result.day).toMatchObject({ date: '2026-11-05', regularHours: 8, overtimeHours: 1.47, totalHours: 9.47, isEdited: true })
    expect(result.employeeTotals).toEqual({ regular: 8, overtime: 1.47, hasAnyPunch: true })
  })

  it('keeps the original API time and stores the new current time (US-12.20)', async () => {
    const result = await save(fullDayPairs('18:00'))

    const stored = store.rows.find((r) => r.id === 'p-3')!
    expect(stored).toMatchObject({ originalTime: '17:47', currentTime: '18:00', source: 'API' })
    expect(result.day.changes).toEqual([{ punchId: 'p-3', original: '17:47', current: '18:00', note: null, kind: 'EDITED' }])
    // The other punches were not touched.
    expect(db.tx.attendancePunch.update).toHaveBeenCalledTimes(1)
  })

  it('saves without a note (US-12.20)', async () => {
    await expect(save(fullDayPairs('18:00'))).resolves.toBeDefined()

    expect(store.rows.find((r) => r.id === 'p-3')!.note).toBeNull()
  })

  it('stores a note when given, trimmed, and keeps the stored note when none is sent', async () => {
    const pairs = fullDayPairs('18:00')
    pairs[1].out.note = '  Forgot to scan out  '
    await save(pairs)
    expect(store.rows.find((r) => r.id === 'p-3')!.note).toBe('Forgot to scan out')

    // A later edit that sends no note leaves the stored note alone.
    await save(fullDayPairs('18:05'))
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ currentTime: '18:05', note: 'Forgot to scan out' })
  })

  it('clears a note with an empty string and caps it at 500 characters', async () => {
    const pairs = fullDayPairs('18:00')
    pairs[1].out.note = 'x'.repeat(800)
    await save(pairs)
    expect(store.rows.find((r) => r.id === 'p-3')!.note).toHaveLength(500)

    const clear = fullDayPairs('18:00')
    clear[1].out.note = '   '
    await save(clear)
    expect(store.rows.find((r) => r.id === 'p-3')!.note).toBeNull()
  })

  it('writes an UPDATE audit row with the old and new time and a readable summary, in the same transaction (US-12.21)', async () => {
    await save(fullDayPairs('18:00'))

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    // The punch update and its audit row are both written on the transaction client.
    expect(db.tx.attendancePunch.update).toHaveBeenCalledTimes(1)
    expect(db.auditLog.create).not.toHaveBeenCalled()

    const audits = auditRows(db.tx)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_PUNCH', entityId: 'p-3' })
    expect(audits[0].detailsJson).toMatchObject({
      summary: 'Changed OUT 17:47 to 18:00 for Asha Rao (TPLGOAHLP036) on 2026-11-05',
      weekStart: '2026-11-05',
      employeeId: 'emp-36',
      employeeCode: 'TPLGOAHLP036',
      employeeName: 'Asha Rao',
      date: '2026-11-05',
      pairIndex: 1,
      position: 'OUT',
      old: { time: '17:47', note: null },
      new: { time: '18:00', note: null },
    })
    expect(audits[0].detailsJson).not.toHaveProperty('correctionId')
  })

  it('does not change the week status (US-12.19)', async () => {
    await save(fullDayPairs('18:00'))

    expect(db.attendanceUpload.update).not.toHaveBeenCalled()
    expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect((await getPunchReview(WEEK_ID)).status).toBe('REVIEW')
  })

  it('returns edits when the review reloads (US-12.19)', async () => {
    await save(fullDayPairs('18:00'))

    const review = await getPunchReview(WEEK_ID)
    const lastOut = review.employees[0].days[0].pairs[1].out
    expect(lastOut).toMatchObject({ time: '18:00', original: '17:47' })
    expect(review.counts.editedDays).toBe(1)
    expect(review.lastSavedAt).toBe('2026-11-13T03:00:00.000Z')
  })

  it('returns counts, totals, approval and a save time for the grid to update from', async () => {
    const result = await save(fullDayPairs('18:00'))

    expect(result.counts.editedDays).toBe(1)
    expect(result.totals.byDay[0]).toEqual({ date: '2026-11-05', regular: 8, overtime: 1.47 })
    expect(result.approval).toEqual({ canApprove: true, blockers: [], weekHasEnded: true })
    expect(result.savedAt).toBe('2026-11-13T03:00:00.000Z')
  })

  it('typing the original time back clears Edited but keeps the note (C9)', async () => {
    const edit = fullDayPairs('18:00')
    edit[1].out.note = 'Forgot to scan out'
    await save(edit)
    expect((await getPunchReview(WEEK_ID)).employees[0].days[0].isEdited).toBe(true)

    const back = await save(fullDayPairs('17:47'))

    expect(back.day.isEdited).toBe(false)
    expect(back.day.changes).toEqual([])
    expect(back.counts.editedDays).toBe(0)
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ originalTime: '17:47', currentTime: '17:47', note: 'Forgot to scan out' })
  })

  it('normalizes times typed as HHmm or H:mm', async () => {
    const pairs = fullDayPairs()
    pairs[0].in.time = '745'
    pairs[1].out.time = '1800'

    await save(pairs)

    expect(store.rows.find((r) => r.id === 'p-0')!.currentTime).toBe('07:45')
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00')
  })

  it('writes nothing and no audit when nothing changed', async () => {
    const result = await save(fullDayPairs('17:47'))

    expectNoWrites()
    expect(result.day).toMatchObject({ regularHours: 8, overtimeHours: 1.25, isEdited: false })
  })

  it('matches a slot with no punchId by its pair and position, rather than adding a punch', async () => {
    const pairs = [
      pair(0, { time: '07:45' }, { time: '13:04' }),
      pair(1, { time: '13:56' }, { time: '17:47' }),
    ]

    await save(pairs)

    expect(db.tx.attendancePunch.create).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.update).toHaveBeenCalledTimes(1)
    expect(store.rows.find((r) => r.id === 'p-0')).toMatchObject({ currentTime: '07:45', originalTime: '07:40' })
  })

  it('keeps a stored punch in its own pair even when the request numbers the pair differently', async () => {
    seed(ashaDay('p', ['08:00', '12:00']))

    const result = await save([pair(5, { punchId: 'p-0', time: '08:30' }, { punchId: 'p-1', time: '12:00' })])

    expect(db.tx.attendancePunch.create).not.toHaveBeenCalled()
    expect(result.day.pairs.map((p) => p.pairIndex)).toEqual([0])
    expect(result.day).toMatchObject({ regularHours: 3.5 })
  })
})

describe('savePunchEdit: adding and deleting', () => {
  it('adds a pair by hand as two MANUAL punches with no original, and recalculates (US-12.17)', async () => {
    seed(ashaDay('p', ['08:00', '12:00']))

    const result = await save([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(1, { time: '13:00' }, { time: '14:00' }),
    ])

    expect(result.day.regularHours).toBe(5)
    expect(db.tx.attendancePunch.create).toHaveBeenCalledTimes(2)
    expect(db.tx.attendancePunch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        attendanceUploadId: 'upload-1',
        correctionId: null,
        employeeId: 'emp-36',
        empCode: '036',
        empName: null,
        matchStatus: 'MATCHED',
        punchDate: utc('2026-11-05'),
        pairIndex: 1,
        position: 'IN',
        source: 'MANUAL',
        originalTime: null,
        currentTime: '13:00',
        note: null,
      }),
    })
    expect(result.day.changes.filter((c) => c.kind === 'ADDED')).toHaveLength(2)
    expect(result.day.isEdited).toBe(true)
  })

  it('audits each added punch with a CREATE row (old null, new time)', async () => {
    seed(ashaDay('p', ['08:00', '12:00']))

    await save([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(1, { time: '13:00', note: 'Worked late' }, { time: '14:00' }),
    ])

    const audits = auditRows(db.tx)
    expect(audits.map((a) => a.actionType)).toEqual(['CREATE', 'CREATE'])
    expect(audits[0].detailsJson).toMatchObject({
      summary: 'Added IN 13:00 for Asha Rao (TPLGOAHLP036) on 2026-11-05',
      old: null,
      new: { time: '13:00', note: 'Worked late' },
    })
    expect(audits[0].entityId).toBe(db.tx.attendancePunch.create.mock.calls[0][0].data.id)
  })

  it('deletes a pair: API punches keep their original with no current time, and hours drop (US-12.17)', async () => {
    seed(ashaDay('p', ['08:00', '12:00', '13:00', '14:00']))

    const result = await save([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' })])

    expect(result.day.regularHours).toBe(4)
    expect(store.rows.find((r) => r.id === 'p-2')).toMatchObject({ originalTime: '13:00', currentTime: null })
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ originalTime: '14:00', currentTime: null })
    expect(db.tx.attendancePunch.delete).not.toHaveBeenCalled()
    expect(result.day.changes.filter((c) => c.kind === 'DELETED').map((c) => c.punchId)).toEqual(['p-2', 'p-3'])
    expect(auditRows(db.tx).map((a) => [a.actionType, a.entityId])).toEqual([
      ['DELETE', 'p-2'],
      ['DELETE', 'p-3'],
    ])
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ old: { time: '13:00', note: null }, new: null })
  })

  it('treats a cleared time like a delete', async () => {
    seed(ashaDay('p', ['08:00', '12:00', '13:00', '14:00']))

    const result = await save([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(1, { punchId: 'p-2', time: null }, { punchId: 'p-3', time: '' }),
    ])

    expect(result.day.regularHours).toBe(4)
    expect(store.rows.find((r) => r.id === 'p-2')!.currentTime).toBeNull()
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBeNull()
  })

  it('removes a hand-entered punch for good (nothing to preserve) and audits a DELETE', async () => {
    seed([
      ...ashaDay('p', ['08:00', '12:00']),
      makePunch({ id: 'm-0', pairIndex: 1, position: 'IN', source: 'MANUAL', originalTime: null, currentTime: '13:00' }),
      makePunch({ id: 'm-1', pairIndex: 1, position: 'OUT', source: 'MANUAL', originalTime: null, currentTime: '14:00' }),
    ])

    const result = await save([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' })])

    expect(db.tx.attendancePunch.delete).toHaveBeenCalledTimes(2)
    expect(store.rows.map((r) => r.id)).toEqual(['p-0', 'p-1'])
    expect(result.day).toMatchObject({ regularHours: 4, isEdited: false })
    expect(auditRows(db.tx).map((a) => a.actionType)).toEqual(['DELETE', 'DELETE'])
  })

  it('deleting the only punch of a day leaves 0.00 hours and no incomplete pair (US-12.17)', async () => {
    seed(ashaDay('p', ['18:26']))
    expect((await getPunchReview(WEEK_ID)).counts.needsFixingDays).toBe(1)

    const result = await save([])

    expect(result.day).toMatchObject({ regularHours: 0, overtimeHours: 0, incomplete: false, pairs: [] })
    expect(result.counts.needsFixingDays).toBe(0)
    expect(result.approval.canApprove).toBe(true)
    expect(store.rows[0]).toMatchObject({ originalTime: '18:26', currentTime: null })
    expect(result.day.changes).toEqual([{ punchId: 'p-0', original: '18:26', current: null, note: null, kind: 'DELETED' }])
  })

  it('deleting one punch of a complete pair makes the day incomplete and blocks approval (E2E-14)', async () => {
    seed(ashaDay('p', ['08:00', '16:00']))

    const result = await save([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: null })])

    expect(result.day).toMatchObject({ incomplete: true, regularHours: 0 })
    expect(result.counts.needsFixingDays).toBe(1)
    expect(result.approval).toMatchObject({ canApprove: false, blockers: ['NEEDS_FIXING'] })
  })

  it('adding the missing OUT to an incomplete pair completes the day and clears the blocker (E2E-14)', async () => {
    seed(ashaDay('p', ['18:26']))

    const result = await save([pair(0, { punchId: 'p-0', time: '18:26' }, { time: '19:00' })])

    expect(db.tx.attendancePunch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ pairIndex: 0, position: 'OUT', source: 'MANUAL', currentTime: '19:00' }),
    })
    expect(result.day).toMatchObject({ incomplete: false, regularHours: 0.57 })
    expect(result.counts.needsFixingDays).toBe(0)
  })

  it('lets a no-punch employee be entered by hand: 08:00-16:00 is 8.00 and leaves "No punches" (E2E-16)', async () => {
    seed(ashaDay())
    expect((await getPunchReview(WEEK_ID)).counts.noPunchEmployees).toBe(1)

    const result = await save([pair(0, { time: '08:00' }, { time: '16:00' })], { employeeId: 'emp-5', date: '2026-11-06' })

    expect(result.day).toMatchObject({ date: '2026-11-06', regularHours: 8 })
    expect(result.employeeTotals).toEqual({ regular: 8, overtime: 0, hasAnyPunch: true })
    expect(result.counts.noPunchEmployees).toBe(0)
    expect(db.tx.attendancePunch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ employeeId: 'emp-5', empCode: '005', punchDate: utc('2026-11-06') }),
    })
  })

  it('ignores a pair with both times blank (no row is created)', async () => {
    seed([])

    const result = await save([pair(0, { time: null }, { time: '' })], { employeeId: 'emp-5' })

    expect(result.day).toMatchObject({ pairs: [], regularHours: 0 })
    expectNoWrites()
  })
})

// ─── savePunchEdit: validation (US-12.18) ─────────────────────────────────────

describe('savePunchEdit: invalid edits are rejected and change nothing (US-12.18, E2E-19)', () => {
  beforeEach(() => seed(ashaDay('p', ['08:00', '12:00'])))

  async function rejected(pairs: SavePair[]): Promise<AttendanceSyncError> {
    const before = snapshot()
    const error = await save(pairs).then(
      () => {
        throw new Error('expected the save to be rejected')
      },
      (e: unknown) => e as AttendanceSyncError,
    )
    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(snapshot()).toEqual(before) // the stored punches are unchanged
    expectNoWrites() // no write, no audit entry (US-12.21)
    return error
  }

  it('rejects an OUT before the IN with the field to mark', async () => {
    const error = await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '07:00' })])

    expect(error.details).toMatchObject({ valid: false, code: 'OUT_NOT_AFTER_IN', pairIndex: 0, field: 'out' })
    expect(error.message).toContain('07:00')
  })

  it('rejects an OUT equal to the IN', async () => {
    const error = await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '08:00' })])

    expect(error.details).toMatchObject({ valid: false, code: 'OUT_NOT_AFTER_IN' })
  })

  it('rejects a time that is not a time', async () => {
    const error = await rejected([pair(0, { punchId: 'p-0', time: '25:00' }, { punchId: 'p-1', time: '26:00' })])

    expect(error.details).toMatchObject({ valid: false, code: 'INVALID_TIME', pairIndex: 0, field: 'in' })
  })

  it('rejects text typed into a time field', async () => {
    const error = await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: 'noon' })])

    expect(error.details).toMatchObject({ valid: false, code: 'INVALID_TIME', field: 'out' })
  })

  it('rejects overlapping pairs', async () => {
    const error = await rejected([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(1, { time: '11:30' }, { time: '14:00' }),
    ])

    expect(error.details).toMatchObject({ valid: false, code: 'PAIRS_OVERLAP', pairIndex: 1, field: 'in' })
  })

  it('rejects a lone time that falls inside a complete pair', async () => {
    const error = await rejected([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(1, { time: '10:00' }, { time: null }),
    ])

    expect(error.details).toMatchObject({ valid: false, code: 'PAIRS_OVERLAP' })
  })

  it('leaves a saved 08:00-12:00 pair alone when OUT = 07:00 is rejected (US-12.18)', async () => {
    await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '07:00' })])

    expect(store.day('emp-36', '2026-11-05').map((r) => r.currentTime)).toEqual(['08:00', '12:00'])
  })

  it('accepts pairs that touch (OUT equals the next IN)', async () => {
    await expect(
      save([
        pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
        pair(1, { time: '12:00' }, { time: '13:00' }),
      ]),
    ).resolves.toMatchObject({ day: { regularHours: 5 } })
  })

  it('validates after deleting: a deleted punch cannot cause an overlap', async () => {
    seed(ashaDay('p', ['08:00', '12:00', '13:00', '14:00']))

    // Pair 1 is dropped and a new pair in the same window is added.
    await expect(
      save([
        pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
        pair(2, { time: '13:30' }, { time: '15:00' }),
      ]),
    ).resolves.toBeDefined()
  })

  it('rejects a pair index sent twice, and the same punch used twice', async () => {
    await rejected([
      pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-1', time: '12:00' }),
      pair(0, { time: '13:00' }, { time: '14:00' }),
    ])
    await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'p-0', time: '12:00' })])
  })

  it('rejects a punch id that is not in this day (a stale editor)', async () => {
    const error = await rejected([pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'someone-elses', time: '12:00' })])

    expect(error.message).toMatch(/no longer exists/i)
  })
})

// ─── savePunchEdit: guards ────────────────────────────────────────────────────

describe('savePunchEdit: guards', () => {
  beforeEach(() => seed(ashaDay()))

  it.each(['APPROVED', 'SYNC_FAILED'])('refuses a week that is %s (WEEK_LOCKED) without touching anything', async (status) => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status }))

    await expect(save(fullDayPairs('18:00'))).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expectNoWrites()
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
  })

  it('refuses a date outside the week (VALIDATION_ERROR)', async () => {
    await expect(save([], { date: '2026-11-12' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(save([], { date: '2026-11-04' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expectNoWrites()
  })

  it('accepts every date of the week, Thursday through Wednesday', async () => {
    for (const date of WEEK_DATES) {
      await expect(save([], { date, employeeId: 'emp-5' })).resolves.toMatchObject({ day: { date } })
    }
  })

  it('refuses an employee that is not in the review (EMPLOYEE_NOT_FOUND)', async () => {
    await expect(save([], { employeeId: 'nobody' })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
    expectNoWrites()
  })

  it('refuses a rejected employee and an inactive one with no decision, but accepts an approved inactive one', async () => {
    const inactive = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })
    db.employee.findMany.mockResolvedValue([asha, inactive])

    db.attendanceEmployeeDecision.findMany.mockResolvedValue([{ employeeId: 'emp-2', decision: 'REJECTED' }])
    await expect(save([], { employeeId: 'emp-2' })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    db.attendanceEmployeeDecision.findMany.mockResolvedValue([])
    await expect(save([], { employeeId: 'emp-2' })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    db.attendanceEmployeeDecision.findMany.mockResolvedValue([{ employeeId: 'emp-2', decision: 'APPROVED' }])
    await expect(save([pair(0, { time: '08:00' }, { time: '16:00' })], { employeeId: 'emp-2' })).resolves.toMatchObject({
      day: { regularHours: 8 },
    })
  })

  it('rejects a weekId that is not a Thursday and an Excel-era week', async () => {
    await expect(save([], { weekId: '2026-11-06' })).rejects.toMatchObject({ code: 'INVALID_WEEK' })

    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())
    await expect(save([])).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })

  it('only reads punches of the chosen employee and day when saving', async () => {
    await save(fullDayPairs('18:00'))

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-36', punchDate: utc('2026-11-05') },
      }),
    )
  })
})

// ─── savePunchEdit: correction mode (US-12.29) ────────────────────────────────

describe('savePunchEdit in a correction', () => {
  const cloneRows = (times = FULL_DAY) =>
    dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: '2026-11-05', times, correctionId: 'session-1' })
  const cloneFullDayPairs = (lastOut = '17:47'): SavePair[] => [
    pair(0, { punchId: 'c-0', time: '07:40' }, { punchId: 'c-1', time: '13:04' }),
    pair(1, { punchId: 'c-2', time: '13:56' }, { punchId: 'c-3', time: lastOut }),
  ]
  const saveCorrection = (pairs: SavePair[]) => save(pairs, { mode: CORRECTION })

  /** The session is looked up before the transaction (db) and again inside it (db.tx). */
  const serveSession = (session: ReturnType<typeof makeSession> | null) => {
    db.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
  }

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    serveSession(makeSession())
    seed([...ashaDay('p'), ...cloneRows()])
  })

  it('edits the clone and leaves the approved (live) punches and the week status alone', async () => {
    const result = await saveCorrection(cloneFullDayPairs('18:00'))

    expect(result.day).toMatchObject({ regularHours: 8, overtimeHours: 1.47, isEdited: true })
    expect(store.rows.find((r) => r.id === 'c-3')).toMatchObject({ originalTime: '17:47', currentTime: '18:00', correctionId: 'session-1' })
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ currentTime: '17:47', correctionId: null })
    expect(db.attendanceUpload.update).not.toHaveBeenCalled()
    expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled()
  })

  it('reads only the clone for the day', async () => {
    await saveCorrection(cloneFullDayPairs('18:00'))

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendanceUploadId: 'upload-1', correctionId: 'session-1', employeeId: 'emp-36', punchDate: utc('2026-11-05') },
      }),
    )
  })

  it('marks the audit row with the correction id', async () => {
    await saveCorrection(cloneFullDayPairs('18:00'))

    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'UPDATE', entityId: 'c-3' })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ correctionId: 'session-1', old: { time: '17:47' }, new: { time: '18:00' } })
  })

  it('adds a hand-entered punch to the clone set', async () => {
    seed([...ashaDay('p', ['08:00', '12:00']), ...cloneRows(['08:00', '12:00'])])

    await saveCorrection([
      pair(0, { punchId: 'c-0', time: '08:00' }, { punchId: 'c-1', time: '12:00' }),
      pair(1, { time: '13:00' }, { time: '14:00' }),
    ])

    expect(db.tx.attendancePunch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ correctionId: 'session-1', source: 'MANUAL' }),
    })
  })

  it('uses the same validation (US-12.29): OUT before IN is rejected and nothing is written', async () => {
    const before = snapshot()

    const error = await saveCorrection([
      pair(0, { punchId: 'c-0', time: '17:00' }, { punchId: 'c-1', time: '08:00' }),
    ]).catch((e: AttendanceSyncError) => e)

    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect((error as AttendanceSyncError).code).toBe('VALIDATION_ERROR')
    expect((error as AttendanceSyncError).details).toMatchObject({ valid: false, code: 'OUT_NOT_AFTER_IN' })
    expect(snapshot()).toEqual(before)
    expectNoWrites()
  })

  it('a correction can delete all of an employee\'s punches, leaving zero hours (US-12.30)', async () => {
    const result = await saveCorrection([])

    expect(result.employeeTotals).toEqual({ regular: 0, overtime: 0, hasAnyPunch: false })
    expect(store.rows.filter((r) => r.correctionId === 'session-1').every((r) => r.currentTime === null)).toBe(true)
    expect(store.rows.filter((r) => r.correctionId === null).every((r) => r.currentTime !== null)).toBe(true)
  })

  it.each([
    ['no session', null],
    ['an abandoned session', makeSession({ status: 'ABANDONED' })],
    ['an applied session', makeSession({ status: 'APPLIED' })],
    ['a session of another run', makeSession({ payrollRunId: 'run-9' })],
  ])('refuses %s (CORRECTION_NOT_ACTIVE)', async (_label, session) => {
    serveSession(session)

    await expect(saveCorrection(cloneFullDayPairs('18:00'))).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expectNoWrites()
  })

  it('still refuses live edits on the approved week while a correction exists (WEEK_LOCKED)', async () => {
    await expect(save(fullDayPairs('18:00'))).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
  })
})
