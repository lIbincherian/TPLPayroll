// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { getPunchReview, loadReviewContext } from '@/features/attendance-sync/services/punch-review.service'
import type { ReviewMode } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  dayPunches,
  freezeClock,
  makeEmployee,
  makeRun,
  makeSession,
  makeUpload,
  resetDb,
  serveUpload,
  type Db,
} from './service-fixtures'

// Round 3, item 8: loadReviewContext reads employees, decisions, punches and the approved payroll run
// together on the plain client, and one after another on a transaction client (a transaction owns one
// connection, and the pool holds two). The result must be the same either way.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })
const old = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })

type Client = Db | Db['tx']

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Let every already-resolved promise and queued microtask run, so "not called yet" means not called. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

/** The fixture both modes read: three employees, one decision, one day of punches, an approved run. */
const EMPLOYEES = [asha, ravi, old]
const DECISIONS = [{ employeeId: 'emp-2', decision: 'APPROVED' }]
const punches = () => dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04', '13:56', '17:47'] })

function serveFixture(client: Client, opts: { run?: boolean; session?: boolean } = {}) {
  client.employee.findMany.mockResolvedValue(EMPLOYEES)
  client.attendanceEmployeeDecision.findMany.mockResolvedValue(DECISIONS)
  client.attendancePunch.findMany.mockResolvedValue(punches())
  client.payrollRun.findFirst.mockResolvedValue(opts.run ? makeRun() : null)
  client.payrollCorrectionSession.findFirst.mockResolvedValue(opts.session ? makeSession() : null)
  client.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
  client.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-2' }])
}

/** Replace the four independent reads of a client with deferred promises the test resolves itself. */
function deferReads(client: Client) {
  const reads = {
    employees: deferred<unknown>(),
    decisions: deferred<unknown>(),
    punches: deferred<unknown>(),
    run: deferred<unknown>(),
  }
  client.employee.findMany.mockReturnValue(reads.employees.promise)
  client.attendanceEmployeeDecision.findMany.mockReturnValue(reads.decisions.promise)
  client.attendancePunch.findMany.mockReturnValue(reads.punches.promise)
  client.payrollRun.findFirst.mockReturnValue(reads.run.promise)
  return reads
}

beforeEach(() => {
  resetDb(db)
  freezeClock('2026-11-13T03:00:00Z')
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
})

afterEach(() => vi.useRealTimers())

// ─── The plain client: the four reads run together ────────────────────────────

describe('loadReviewContext on the plain client reads the independent tables together', () => {
  it('has all four reads started before any of them has finished', async () => {
    const reads = deferReads(db)
    const pending = loadReviewContext(WEEK_ID, LIVE)

    await vi.waitFor(() => expect(db.employee.findMany).toHaveBeenCalled())
    await settle()

    // Nothing has resolved yet, and all four are already in flight.
    expect(db.attendanceEmployeeDecision.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendancePunch.findMany).toHaveBeenCalledTimes(1)
    expect(db.payrollRun.findFirst).toHaveBeenCalledTimes(1)

    reads.employees.resolve(EMPLOYEES)
    reads.decisions.resolve(DECISIONS)
    reads.punches.resolve(punches())
    reads.run.resolve(null)
    await expect(pending).resolves.toMatchObject({ employees: EMPLOYEES })
  })

  it('does not care which read finishes first (the results land in the right fields)', async () => {
    const reads = deferReads(db)
    const pending = loadReviewContext(WEEK_ID, LIVE)
    await vi.waitFor(() => expect(db.payrollRun.findFirst).toHaveBeenCalled())

    // Reverse order of the call order.
    reads.run.resolve(makeRun())
    reads.punches.resolve(punches())
    reads.decisions.resolve(DECISIONS)
    reads.employees.resolve(EMPLOYEES)
    db.payrollCorrectionSession.findFirst.mockResolvedValue(makeSession())
    const ctx = await pending

    expect(ctx.employees.map((e) => e.id)).toEqual(['emp-36', 'emp-5', 'emp-2'])
    expect(ctx.decisions).toEqual([{ employeeId: 'emp-2', decision: 'APPROVED' }])
    expect(ctx.punches).toHaveLength(4)
    expect(ctx.payrollRun).toMatchObject({ id: 'run-1' })
  })

  it('reads through the plain client only (the transaction client is untouched)', async () => {
    serveFixture(db)

    await loadReviewContext(WEEK_ID, LIVE)

    for (const read of [db.tx.employee.findMany, db.tx.attendanceEmployeeDecision.findMany, db.tx.attendancePunch.findMany, db.tx.payrollRun.findFirst]) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('getPunchReview without a client takes the same parallel path', async () => {
    const reads = deferReads(db)
    const pending = getPunchReview(WEEK_ID)

    await vi.waitFor(() => expect(db.employee.findMany).toHaveBeenCalled())
    await settle()
    expect(db.attendanceEmployeeDecision.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendancePunch.findMany).toHaveBeenCalledTimes(1)
    expect(db.payrollRun.findFirst).toHaveBeenCalledTimes(1)

    reads.employees.resolve(EMPLOYEES)
    reads.decisions.resolve([])
    reads.punches.resolve([])
    reads.run.resolve(null)
    await expect(pending).resolves.toMatchObject({ weekId: WEEK_ID, mode: { kind: 'LIVE' } })
  })

  it('a read that fails fails the whole load (nothing is half returned)', async () => {
    serveFixture(db)
    db.attendancePunch.findMany.mockRejectedValue(new Error('connection reset'))

    await expect(loadReviewContext(WEEK_ID, LIVE)).rejects.toThrow('connection reset')
  })
})

// ─── A transaction client: one query at a time ────────────────────────────────

describe('loadReviewContext on a transaction client reads one table after another', () => {
  it('starts each read only once the previous one has finished: employees, decisions, punches, then the payroll run', async () => {
    const tx = db.tx
    const reads = deferReads(tx)
    const pending = loadReviewContext(WEEK_ID, LIVE, tx as never)

    await vi.waitFor(() => expect(tx.employee.findMany).toHaveBeenCalledTimes(1))
    await settle()
    // Employees are still pending: nothing after them may have started.
    expect(tx.attendanceEmployeeDecision.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.payrollRun.findFirst).not.toHaveBeenCalled()

    reads.employees.resolve(EMPLOYEES)
    await vi.waitFor(() => expect(tx.attendanceEmployeeDecision.findMany).toHaveBeenCalledTimes(1))
    await settle()
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.payrollRun.findFirst).not.toHaveBeenCalled()

    reads.decisions.resolve(DECISIONS)
    await vi.waitFor(() => expect(tx.attendancePunch.findMany).toHaveBeenCalledTimes(1))
    await settle()
    expect(tx.payrollRun.findFirst).not.toHaveBeenCalled()

    reads.punches.resolve(punches())
    await vi.waitFor(() => expect(tx.payrollRun.findFirst).toHaveBeenCalledTimes(1))

    reads.run.resolve(null)
    await expect(pending).resolves.toMatchObject({ employees: EMPLOYEES })
    expect(order(tx.employee.findMany)).toBeLessThan(order(tx.attendanceEmployeeDecision.findMany))
    expect(order(tx.attendanceEmployeeDecision.findMany)).toBeLessThan(order(tx.attendancePunch.findMany))
    expect(order(tx.attendancePunch.findMany)).toBeLessThan(order(tx.payrollRun.findFirst))
  })

  it('never has two reads in flight at once', async () => {
    let inFlight = 0
    let peak = 0
    const slow = (value: unknown) =>
      vi.fn(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await settle()
        inFlight--
        return value
      })
    db.tx.employee.findMany = slow(EMPLOYEES)
    db.tx.attendanceEmployeeDecision.findMany = slow(DECISIONS)
    db.tx.attendancePunch.findMany = slow(punches())
    db.tx.payrollRun.findFirst = slow(makeRun())
    db.tx.payrollCorrectionSession.findFirst = slow(makeSession())

    await loadReviewContext(WEEK_ID, LIVE, db.tx as never)

    expect(peak).toBe(1)
  })

  it('the same load on the plain client does overlap (so the test above would catch a regression)', async () => {
    let inFlight = 0
    let peak = 0
    const slow = (value: unknown) =>
      vi.fn(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await settle()
        inFlight--
        return value
      })
    db.employee.findMany = slow(EMPLOYEES)
    db.attendanceEmployeeDecision.findMany = slow(DECISIONS)
    db.attendancePunch.findMany = slow(punches())
    db.payrollRun.findFirst = slow(null)

    await loadReviewContext(WEEK_ID, LIVE)

    expect(peak).toBe(4)
  })

  it('reads through the transaction client only (the plain client is untouched)', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
    serveFixture(db.tx)

    await loadReviewContext(WEEK_ID, LIVE, db.tx as never)

    for (const read of [db.employee.findMany, db.attendanceEmployeeDecision.findMany, db.attendancePunch.findMany, db.payrollRun.findFirst]) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('stops at the first failing read and starts none after it', async () => {
    serveFixture(db.tx)
    db.tx.attendanceEmployeeDecision.findMany.mockRejectedValue(new Error('deadlock detected'))

    await expect(loadReviewContext(WEEK_ID, LIVE, db.tx as never)).rejects.toThrow('deadlock detected')

    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(db.tx.payrollRun.findFirst).not.toHaveBeenCalled()
  })
})

// ─── Same answer either way ───────────────────────────────────────────────────

describe('the review is identical on the plain client and on a transaction client', () => {
  it('live week with no payroll', async () => {
    serveFixture(db)
    serveFixture(db.tx)

    const plain = await getPunchReview(WEEK_ID, LIVE)
    const inTx = await getPunchReview(WEEK_ID, LIVE, db.tx as never)

    expect(inTx).toEqual(plain)
    expect(plain.employees.length).toBeGreaterThan(0)
    expect(plain.employees[0].days[0].pairs).toHaveLength(2)
  })

  it('live week with approved payroll and a correction in progress', async () => {
    serveFixture(db, { run: true, session: true })
    serveFixture(db.tx, { run: true, session: true })

    const plain = await getPunchReview(WEEK_ID, LIVE)
    const inTx = await getPunchReview(WEEK_ID, LIVE, db.tx as never)

    expect(inTx).toEqual(plain)
    expect(plain.payroll).toEqual({ status: 'APPROVED', payrollRunId: 'run-1', activeCorrectionId: 'session-1' })
  })

  it('correction of an approved week', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    serveFixture(db, { run: true })
    serveFixture(db.tx, { run: true })

    const plain = await getPunchReview(WEEK_ID, CORRECTION)
    const inTx = await getPunchReview(WEEK_ID, CORRECTION, db.tx as never)

    expect(inTx).toEqual(plain)
    expect(plain.mode).toEqual(CORRECTION)
    // The deactivated employee with approved records is in the correction grid in both modes.
    expect(plain.employees.map((e) => e.employeeId)).toContain('emp-2')
  })

  it('an empty week', async () => {
    const plain = await getPunchReview(WEEK_ID)
    const inTx = await getPunchReview(WEEK_ID, LIVE, db.tx as never)

    expect(inTx).toEqual(plain)
  })
})

// ─── The dependent reads stay sequential ──────────────────────────────────────

describe('the reads that depend on the first ones stay after them', () => {
  it('live week: the correction-session lookup waits for the payroll run and uses its id', async () => {
    const reads = deferReads(db)
    const pending = loadReviewContext(WEEK_ID, LIVE)
    await vi.waitFor(() => expect(db.payrollRun.findFirst).toHaveBeenCalled())
    await settle()

    expect(db.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()

    // Everything but the run is back: still no session lookup, it needs the run's id.
    reads.employees.resolve(EMPLOYEES)
    reads.decisions.resolve(DECISIONS)
    reads.punches.resolve(punches())
    await settle()
    expect(db.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()

    db.payrollCorrectionSession.findFirst.mockResolvedValue(makeSession())
    reads.run.resolve(makeRun({ id: 'run-77' }))
    const ctx = await pending

    expect(db.payrollCorrectionSession.findFirst).toHaveBeenCalledTimes(1)
    expect(db.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({ where: { payrollRunId: 'run-77', status: 'IN_PROGRESS' } })
    expect(order(db.payrollRun.findFirst)).toBeLessThan(order(db.payrollCorrectionSession.findFirst))
    expect(ctx.session).toMatchObject({ id: 'session-1' })
  })

  it('live week without an approved run: no session lookup at all', async () => {
    serveFixture(db)

    const ctx = await loadReviewContext(WEEK_ID, LIVE)

    expect(db.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
    expect(ctx.session).toBeNull()
    expect(ctx.payrollRun).toBeNull()
  })

  it('live week on a transaction client: the session lookup follows the run lookup on the same client', async () => {
    serveFixture(db.tx, { run: true, session: true })

    await loadReviewContext(WEEK_ID, LIVE, db.tx as never)

    expect(db.tx.payrollCorrectionSession.findFirst).toHaveBeenCalledTimes(1)
    expect(order(db.tx.payrollRun.findFirst)).toBeLessThan(order(db.tx.payrollCorrectionSession.findFirst))
    expect(db.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
  })

  it('correction: the session is checked before the four reads, the approved-records read comes after all of them', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    const reads = deferReads(db)
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-2' }])
    const pending = loadReviewContext(WEEK_ID, CORRECTION)

    await vi.waitFor(() => expect(db.employee.findMany).toHaveBeenCalled())
    await settle()
    expect(db.payrollCorrectionSession.findUnique).toHaveBeenCalledWith({ where: { id: 'session-1' } })
    expect(order(db.payrollCorrectionSession.findUnique)).toBeLessThan(order(db.employee.findMany))
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()

    reads.employees.resolve(EMPLOYEES)
    reads.decisions.resolve(DECISIONS)
    reads.punches.resolve(punches())
    await settle()
    // One read is still out: the approved-records lookup must not start yet.
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()

    reads.run.resolve(makeRun())
    const ctx = await pending

    expect(db.attendanceRecord.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1' },
      select: { employeeId: true },
      distinct: ['employeeId'],
    })
    expect([...ctx.approvedEmployeeIds]).toEqual(['emp-2'])
  })

  it('correction reads the punches of its own set, live reads the live set', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    serveFixture(db)

    await loadReviewContext(WEEK_ID, CORRECTION)
    await loadReviewContext(WEEK_ID, LIVE)

    expect(db.attendancePunch.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: 'session-1' } }))
    expect(db.attendancePunch.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null } }))
  })

  it('live mode never looks up approved records', async () => {
    serveFixture(db)

    const ctx = await loadReviewContext(WEEK_ID, LIVE)

    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()
    expect(ctx.approvedEmployeeIds.size).toBe(0)
  })

  it('the payroll-run lookup asks for the approved or revised run of the week', async () => {
    serveFixture(db)

    await loadReviewContext(WEEK_ID, LIVE)

    expect(db.payrollRun.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: new Date('2026-11-05T00:00:00Z'), status: { in: ['APPROVED', 'REVISED'] } },
    })
  })
})

