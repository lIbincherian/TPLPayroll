// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { getReviewGridEmployees } from '@/features/attendance-sync/lib/matching'
import {
  getPunchReview,
  loadReviewContext,
  savePunchEdit,
} from '@/features/attendance-sync/services/punch-review.service'
import type { ReviewMode, SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makeRun,
  makeSession,
  makeUpload,
  mockLockedWeek,
  resetDb,
  serveUpload,
  type Db,
  type PunchStore,
} from './service-fixtures'

// Fix round, items 1 and 2: (1) saving a punch edit in a correction clears the session's draft
// pointer, so a preview calculated from earlier punches can no longer be approved; (2) a correction's
// grid keeps everyone who has approved records for the week, even if they were deactivated since.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const WEEK = { start: '2026-11-05', end: '2026-11-11' }
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
// Deactivated after the week was approved; has approved records, no decision row.
const deactivated = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })
// Resignation date set after the week was approved, before the week started.
const resigned = makeEmployee({
  id: 'emp-3',
  employeeId: 'TPLGOAHLP003',
  employeeName: 'Gone Before',
  dateOfResignation: new Date('2026-11-01T00:00:00Z'),
})

let store: PunchStore

const pair = (pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair => ({ pairIndex, in: inn, out })
const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

beforeEach(() => {
  resetDb(db)
  freezeClock('2026-11-13T03:00:00Z')
})

afterEach(() => vi.useRealTimers())

// ─── Item 2, pure: getReviewGridEmployees(…, alwaysInclude) ───────────────────

describe('getReviewGridEmployees with alwaysInclude', () => {
  const lite = (over: Partial<ReturnType<typeof makeEmployee>>) => makeEmployee(over)
  const inactive = lite({ id: 'i', employeeId: 'TPLGOAHLP002', employeeName: 'Inactive', isActive: false })
  const gone = lite({ id: 'g', employeeId: 'TPLGOAHLP003', employeeName: 'Gone', dateOfResignation: new Date('2026-11-01T00:00:00Z') })
  const active = lite({ id: 'a', employeeId: 'TPLGOAHLP001', employeeName: 'Active' })

  it('lists an inactive employee that is in the set, tagged INACTIVE_APPROVED, without any decision', () => {
    const grid = getReviewGridEmployees([inactive], [], WEEK, new Set(['i']))
    expect(grid.map((e) => [e.id, e.tag])).toEqual([['i', 'INACTIVE_APPROVED']])
  })

  it('lists an employee who resigned before the week that is in the set, tagged RESIGNED_APPROVED', () => {
    const grid = getReviewGridEmployees([gone], [], WEEK, new Set(['g']))
    expect(grid.map((e) => [e.id, e.tag])).toEqual([['g', 'RESIGNED_APPROVED']])
  })

  it('an employee both inactive and resigned is tagged INACTIVE_APPROVED', () => {
    const both = lite({ id: 'b', isActive: false, dateOfResignation: new Date('2026-11-01T00:00:00Z') })
    expect(getReviewGridEmployees([both], [], WEEK, new Set(['b']))[0].tag).toBe('INACTIVE_APPROVED')
  })

  it('wins over a REJECTED decision (such an employee only has records if they were approved)', () => {
    const grid = getReviewGridEmployees(
      [inactive, gone],
      [
        { employeeId: 'i', decision: 'REJECTED' },
        { employeeId: 'g', decision: 'REJECTED' },
      ],
      WEEK,
      new Set(['i', 'g']),
    )
    expect(grid.map((e) => e.id).sort()).toEqual(['g', 'i'])
  })

  it('leaves out inactive and resigned employees that are not in the set (the old rule still applies)', () => {
    const grid = getReviewGridEmployees([inactive, gone, active], [], WEEK, new Set(['someone-else']))
    expect(grid.map((e) => e.id)).toEqual(['a'])
  })

  it.each([
    ['undefined', undefined],
    ['an empty set', new Set<string>()],
  ])('behaves as before with %s', (_label, set) => {
    const decisions = [{ employeeId: 'i', decision: 'APPROVED' as const }]
    const withArg = getReviewGridEmployees([inactive, gone, active], decisions, WEEK, set)
    const without = getReviewGridEmployees([inactive, gone, active], decisions, WEEK)
    expect(withArg).toEqual(without)
    expect(withArg.map((e) => e.id).sort()).toEqual(['a', 'i'])
  })

  it('does not change an active employee that is in the set, and invents no employee that does not exist', () => {
    const grid = getReviewGridEmployees([active], [], WEEK, new Set(['a', 'ghost']))
    expect(grid).toEqual([expect.objectContaining({ id: 'a', tag: 'ACTIVE' })])
  })

  it('keeps an employee approved by decision when the set is given but does not contain them', () => {
    const grid = getReviewGridEmployees([inactive], [{ employeeId: 'i', decision: 'APPROVED' }], WEEK, new Set(['other']))
    expect(grid.map((e) => e.tag)).toEqual(['INACTIVE_APPROVED'])
  })

  it('still sorts by employee name', () => {
    const grid = getReviewGridEmployees([gone, active, inactive], [], WEEK, new Set(['i', 'g']))
    expect(grid.map((e) => e.employeeName)).toEqual(['Active', 'Gone', 'Inactive'])
  })
})

// ─── Item 2: the review ───────────────────────────────────────────────────────

describe('getPunchReview: who is in a correction grid', () => {
  const clone = (idPrefix: string, employeeId: string, empCode: string) =>
    dayPunches({
      idPrefix,
      employeeId,
      empCode,
      date: '2026-11-05',
      times: ['08:00', '12:00', '13:00', '17:00'],
      correctionId: 'session-1',
    })
  const live = (idPrefix: string, employeeId: string, empCode: string) =>
    dayPunches({ idPrefix, employeeId, empCode, date: '2026-11-05', times: ['08:00', '12:00', '13:00', '17:00'] })

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.payrollCorrectionSession.findFirst.mockResolvedValue(makeSession())
    db.employee.findMany.mockResolvedValue([asha, deactivated, resigned])
    // Approved records exist for the two employees that changed status after approval. No decisions.
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-2' }, { employeeId: 'emp-3' }])
    db.attendanceEmployeeDecision.findMany.mockResolvedValue([])
    store = installPunchStore(db, [
      ...live('lp-a', 'emp-36', '0036'),
      ...live('lp-i', 'emp-2', '0002'),
      ...live('lp-r', 'emp-3', '0003'),
      ...clone('cp-a', 'emp-36', '0036'),
      ...clone('cp-i', 'emp-2', '0002'),
      ...clone('cp-r', 'emp-3', '0003'),
    ])
  })

  it('CORRECTION lists the now-inactive and the now-resigned employee who have approved records', async () => {
    const review = await getPunchReview(WEEK_ID, CORRECTION)

    expect(review.employees.map((e) => [e.employeeName, e.tag])).toEqual([
      ['Asha Rao', 'ACTIVE'],
      ['Gone Before', 'RESIGNED_APPROVED'],
      ['Old Timer', 'INACTIVE_APPROVED'],
    ])
    // Their clone punches give them hours in the grid.
    const oldTimer = review.employees.find((e) => e.employeeName === 'Old Timer')!
    expect(oldTimer.hasAnyPunch).toBe(true)
    expect(oldTimer.days[0].regularHours).toBe(8)
  })

  it('LIVE omits them (they are pending decisions) and blocks approval with PENDING_DECISIONS', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))

    const review = await getPunchReview(WEEK_ID, LIVE)

    expect(review.employees.map((e) => e.employeeName)).toEqual(['Asha Rao'])
    expect(review.counts.pendingDecisions).toBe(2)
    expect(review.approval.blockers).toContain('PENDING_DECISIONS')
  })

  it('CORRECTION raises no pending decision for them and never blocks with PENDING_DECISIONS', async () => {
    const review = await getPunchReview(WEEK_ID, CORRECTION)

    expect(review.counts.pendingDecisions).toBe(0)
    expect(review.approval.blockers).not.toContain('PENDING_DECISIONS')
    expect(review.approval.blockers).toEqual([])
    expect(review.approval.canApprove).toBe(true)
  })

  it('CORRECTION still counts a decision-needing employee WITHOUT approved records as pending', async () => {
    // A third employee, deactivated, with clone punches but no approved records: nothing ever approved them.
    const stranger = makeEmployee({ id: 'emp-9', employeeId: 'TPLGOAHLP009', employeeName: 'Stranger', isActive: false })
    db.employee.findMany.mockResolvedValue([asha, deactivated, resigned, stranger])
    store.rows.push(...clone('cp-s', 'emp-9', '0009'))

    const review = await getPunchReview(WEEK_ID, CORRECTION)

    expect(review.employees.map((e) => e.employeeName)).not.toContain('Stranger')
    expect(review.counts.pendingDecisions).toBe(1)
    expect(review.approval.blockers).toContain('PENDING_DECISIONS')
  })

  it('reads the employees with approved records for the upload, once each, in CORRECTION mode only', async () => {
    await getPunchReview(WEEK_ID, CORRECTION)

    expect(db.attendanceRecord.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1' },
      select: { employeeId: true },
      distinct: ['employeeId'],
    })

    db.attendanceRecord.findMany.mockClear()
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
    await getPunchReview(WEEK_ID, LIVE)
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('loadReviewContext exposes approvedEmployeeIds: the recorded employees in a correction, empty when live', async () => {
    const correction = await loadReviewContext(WEEK_ID, CORRECTION)
    expect([...correction.approvedEmployeeIds].sort()).toEqual(['emp-2', 'emp-3'])

    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
    const liveContext = await loadReviewContext(WEEK_ID, LIVE)
    expect(liveContext.approvedEmployeeIds.size).toBe(0)
  })

  it('totals and the approval state still cover only the clone punches of the listed employees', async () => {
    const review = await getPunchReview(WEEK_ID, CORRECTION)

    // Three employees x 8 regular hours on Thursday.
    expect(review.totals.regular).toBe(24)
  })
})

// ─── Item 6: the review can be read through a transaction client, one query at a time ──

describe('loadReviewContext / getPunchReview with a transaction client', () => {
  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
    store = installPunchStore(db, dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }))
    db.employee.findMany.mockResolvedValue([asha])
    db.tx.employee.findMany.mockResolvedValue([asha])
  })

  it('reads everything on the client it is given and nothing on the global client', async () => {
    await getPunchReview(WEEK_ID, LIVE, db.tx as never)

    expect(db.tx.attendanceUpload.findFirst).toHaveBeenCalled()
    expect(db.tx.employee.findMany).toHaveBeenCalled()
    expect(db.tx.attendanceEmployeeDecision.findMany).toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).toHaveBeenCalled()
    expect(db.tx.payrollRun.findFirst).toHaveBeenCalled()
    for (const read of [
      db.attendanceUpload.findFirst,
      db.employee.findMany,
      db.attendanceEmployeeDecision.findMany,
      db.attendancePunch.findMany,
      db.payrollRun.findFirst,
    ]) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('in a correction, also reads the session and the approved records on the given client', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollRun.findFirst.mockResolvedValue(makeRun())

    await getPunchReview(WEEK_ID, CORRECTION, db.tx as never)

    expect(db.tx.payrollCorrectionSession.findUnique).toHaveBeenCalledWith({ where: { id: 'session-1' } })
    expect(db.tx.attendanceRecord.findMany).toHaveBeenCalledTimes(1)
    expect(db.payrollCorrectionSession.findUnique).not.toHaveBeenCalled()
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('never has two queries in flight at once (one connection is enough inside a transaction)', async () => {
    let inFlight = 0
    let peak = 0
    const slow = (value: unknown) =>
      vi.fn(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight--
        return value
      })
    db.tx.attendanceUpload.findFirst = slow(makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.tx.employee.findMany = slow([asha, deactivated])
    db.tx.attendanceEmployeeDecision.findMany = slow([])
    db.tx.attendancePunch.findMany = slow(store.rows)
    db.tx.payrollRun.findFirst = slow(makeRun())
    db.tx.payrollCorrectionSession.findUnique = slow(makeSession())
    db.tx.payrollCorrectionSession.findFirst = slow(makeSession())
    db.tx.attendanceRecord.findMany = slow([{ employeeId: 'emp-2' }])

    await getPunchReview(WEEK_ID, CORRECTION, db.tx as never)
    await getPunchReview(WEEK_ID, LIVE, db.tx as never)

    expect(peak).toBe(1)
  })
})

// ─── Item 2: savePunchEdit in a correction ────────────────────────────────────

describe('savePunchEdit: who may be edited', () => {
  const cloneRows = () =>
    dayPunches({
      idPrefix: 'c',
      employeeId: 'emp-2',
      empCode: '0002',
      date: '2026-11-05',
      times: ['08:00', '12:00'],
      correctionId: 'session-1',
    })
  const cloneEdit = (): SavePair[] => [pair(0, { punchId: 'c-0', time: '08:00' }, { punchId: 'c-1', time: '13:00' })]

  const save = (mode: ReviewMode, pairs = cloneEdit(), employeeId = 'emp-2') =>
    savePunchEdit({ weekId: WEEK_ID, employeeId, date: '2026-11-05', mode, pairs })

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.employee.findMany.mockResolvedValue([asha, deactivated])
    db.attendanceEmployeeDecision.findMany.mockResolvedValue([])
    store = installPunchStore(db, cloneRows())
  })

  it('CORRECTION accepts a now-inactive employee who has approved records, and edits their clone punch', async () => {
    db.attendanceRecord.count.mockResolvedValue(7)
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-2' }]) // the review that follows the save
    const result = await save(CORRECTION)

    expect(db.attendanceRecord.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', employeeId: 'emp-2' } })
    expect(result.day).toMatchObject({ regularHours: 5, isEdited: true })
    expect(store.rows.find((r) => r.id === 'c-1')).toMatchObject({ currentTime: '13:00', correctionId: 'session-1' })
  })

  it('CORRECTION refuses an inactive employee who has no approved records (EMPLOYEE_NOT_FOUND) and writes nothing', async () => {
    db.attendanceRecord.count.mockResolvedValue(0)

    await expect(save(CORRECTION)).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('LIVE refuses the same employee (undecided inactive) and never looks at approved records', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
    db.attendanceRecord.count.mockResolvedValue(7)
    store = installPunchStore(
      db,
      dayPunches({ idPrefix: 'l', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '12:00'] }),
    )

    await expect(
      save(LIVE, [pair(0, { punchId: 'l-0', time: '08:00' }, { punchId: 'l-1', time: '13:00' })]),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expect(db.attendanceRecord.count).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('CORRECTION still refuses an employee who does not exist at all', async () => {
    db.attendanceRecord.count.mockResolvedValue(7)

    await expect(save(CORRECTION, cloneEdit(), 'nobody')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
  })
})

// ─── Item 1: a saved correction edit clears the session's draft pointer ───────

describe('savePunchEdit in a correction clears the draft revision pointer', () => {
  const cloneRows = () =>
    dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY, correctionId: 'session-1' })
  const changed = (): SavePair[] => [
    pair(0, { punchId: 'c-0', time: '07:40' }, { punchId: 'c-1', time: '13:04' }),
    pair(1, { punchId: 'c-2', time: '13:56' }, { punchId: 'c-3', time: '18:00' }),
  ]
  const unchanged = (): SavePair[] => [
    pair(0, { punchId: 'c-0', time: '07:40' }, { punchId: 'c-1', time: '13:04' }),
    pair(1, { punchId: 'c-2', time: '13:56' }, { punchId: 'c-3', time: '17:47' }),
  ]
  const save = (pairs: SavePair[]) =>
    savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: '2026-11-05', mode: CORRECTION, pairs })

  const serveSession = (before: ReturnType<typeof makeSession> | null, inside = before) => {
    db.payrollCorrectionSession.findUnique.mockResolvedValue(before)
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(inside)
  }

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.employee.findMany.mockResolvedValue([asha])
    serveSession(makeSession({ draftRevisionId: 'draft-1' }))
    installPunchStore(db, cloneRows())
  })

  it('sets draftRevisionId to null on the session, in the same transaction, after the punch writes', async () => {
    await save(changed())

    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { draftRevisionId: null },
    })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.payrollCorrectionSession.update).not.toHaveBeenCalled()
    // lock < punch write < audit < pointer cleared
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.update))
    expect(order(db.tx.attendancePunch.update)).toBeLessThan(order(db.tx.payrollCorrectionSession.update))
    expect(order(db.tx.auditLog.create)).toBeLessThan(order(db.tx.payrollCorrectionSession.update))
  })

  it('clears it for an added punch and for a delete as well, not only for a time change', async () => {
    await save([
      pair(0, { punchId: 'c-0', time: '07:40' }, { punchId: 'c-1', time: '13:04' }),
      pair(1, { punchId: 'c-2', time: '13:56' }, { punchId: 'c-3', time: '' }),
    ])
    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)

    db.tx.payrollCorrectionSession.update.mockClear()
    await save([
      ...unchanged().slice(0, 1),
      pair(1, { punchId: 'c-2', time: '13:56' }, { punchId: 'c-3', time: '17:47' }),
      pair(2, { time: '19:00' }, { time: '20:00' }),
    ])
    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
  })

  it('does not clear it when nothing changed (no transaction at all)', async () => {
    await save(unchanged())

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(db.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('does not clear it when validation rejects the edit', async () => {
    await expect(save([pair(0, { punchId: 'c-0', time: '17:00' }, { punchId: 'c-1', time: '08:00' })])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })

    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it.each([
    ['an applied session', makeSession({ status: 'APPLIED' })],
    ['an abandoned session', makeSession({ status: 'ABANDONED' })],
    ['a session of another run', makeSession({ payrollRunId: 'run-9' })],
    ['a deleted session', null],
  ])('refuses with CORRECTION_NOT_ACTIVE and writes nothing when the in-transaction read finds %s', async (_label, inside) => {
    // The pre-transaction read still saw the session in progress (the correction ended in between).
    serveSession(makeSession({ draftRevisionId: 'draft-1' }), inside)

    await expect(save(changed())).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.create).not.toHaveBeenCalled()
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('saves in a correction although the locked week row is APPROVED (the status check is for live mode only)', async () => {
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') })

    await expect(save(changed())).resolves.toMatchObject({ day: { isEdited: true } })
  })

  it('refuses with WEEK_NOT_READY when the week row has gone', async () => {
    mockLockedWeek(db.tx, null)

    await expect(save(changed())).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('a failing pointer update rolls the edit back (the error propagates, nothing is reported saved)', async () => {
    db.tx.payrollCorrectionSession.update.mockRejectedValue(new Error('connection reset'))

    await expect(save(changed())).rejects.toThrow('connection reset')
  })

  it('uses a transaction timeout of 30 s', async () => {
    await save(changed())

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })
})
