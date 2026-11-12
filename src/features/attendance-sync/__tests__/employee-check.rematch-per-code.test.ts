// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { matchCodeToEmployee, rematchWeekCodes } from '@/features/attendance-sync/services/employee-check.service'
import { SYNC_IN_PROGRESS_MESSAGE } from '@/features/attendance-sync/services/week-lock.service'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'
import { auditRows, lockedRow, makeEmployee, makeUpload, resetDb, utc, type Db } from './service-fixtures'

// Round 4, items 5 and 9.
//  5. rematchWeekCodes reads on the plain client, then commits each CHANGING code in its own transaction
//     (lock first, skip a code with nothing left to link, then that code's writes and audit row). A code
//     that is already linked stays linked when a later code fails. Linking moves rows with one updateMany
//     per pair offset, never one update per row.
//  9. matchCodeToEmployee reads the employee again under the lock and writes that copy.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const UNRESOLVED = ['UNKNOWN', 'DUPLICATE']
const unresolvedWhere = (empCode: string) => ({
  where: { attendanceUploadId: 'upload-1', correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
})

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })
const meena = makeEmployee({ id: 'emp-9', employeeId: 'TPLGOAHLP009', employeeName: 'Meena Das' })
const sevenA = makeEmployee({ id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp' })
const sevenB = makeEmployee({ id: 'emp-7b', employeeId: 'TPLGOASUP007', employeeName: 'Seven Sup' })

type Rows = Array<{ id: string; punchDate: Date; pairIndex: number }>

/** What the database holds for the run: still-unresolved row counts and rows per code, plus the employee's existing pairs. */
let remaining: Record<string, number>
let codeRows: Record<string, Rows>
let existing: Array<{ punchDate: Date; pairIndex: number }>
/** Everything the transactions did, in order, so each transaction's own sequence can be read off. */
let log: string[]

function serve(opts: {
  unresolved: Array<{ empCode: string; matchStatus: string }>
  employees?: Array<ReturnType<typeof makeEmployee>>
  exceptions?: Array<{ empCode: string; kind: string; employeeId: string | null }>
}) {
  db.employee.findMany.mockResolvedValue(opts.employees ?? [asha, ravi, meena, sevenA, sevenB])
  db.attendanceCodeException.findMany.mockResolvedValue(opts.exceptions ?? [])
  db.attendancePunch.findMany.mockResolvedValue(opts.unresolved)
  // Each changing code is matched again under its lock, on the transaction client: the same employees and exceptions.
  db.tx.employee.findMany.mockResolvedValue(opts.employees ?? [asha, ravi, meena, sevenA, sevenB])
  db.tx.attendanceCodeException.findMany.mockResolvedValue(opts.exceptions ?? [])
}

beforeEach(() => {
  resetDb(db)
  log = []
  remaining = {}
  codeRows = {}
  existing = []
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))

  db.$transaction.mockImplementation(async (arg: unknown) => {
    log.push('begin')
    const result = await (arg as (tx: Db['tx']) => Promise<unknown>)(db.tx)
    log.push('commit')
    return result
  })
  db.tx.$queryRaw.mockImplementation(async () => {
    log.push('lock')
    return [lockedRow()]
  })
  db.tx.attendancePunch.count.mockImplementation(async ({ where }: { where: { empCode: string } }) => {
    log.push(`count ${where.empCode}`)
    return remaining[where.empCode] ?? 1
  })
  db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) => {
    if (where.empCode) {
      log.push(`rows ${where.empCode}`)
      return codeRows[where.empCode] ?? []
    }
    log.push('existing')
    return existing
  })
  db.tx.attendancePunch.updateMany.mockImplementation(async (args: { data: { matchStatus: string; pairIndex?: unknown } }) => {
    log.push(`updateMany ${args.data.matchStatus}${args.data.pairIndex ? ' +' + (args.data.pairIndex as { increment: number }).increment : ''}`)
    return { count: 1 }
  })
  db.tx.auditLog.create.mockImplementation(async ({ data }: { data: { detailsJson: { summary: string } } }) => {
    log.push(`audit ${data.detailsJson.summary}`)
    return { id: 'audit-1' }
  })
})

const timeoutOf = (callIndex: number) => (db.$transaction.mock.calls[callIndex] as [unknown, { timeout: number }])[1]

// ─── Item 5: one transaction per changing code ────────────────────────────────

describe('rematchWeekCodes: one transaction per code that changes', () => {
  it('three changing codes make three transactions, each with the timeout, each starting with the week lock', async () => {
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' }, // now matches Asha
        { empCode: '0005', matchStatus: 'UNKNOWN' }, // now matches Ravi
        { empCode: '0999', matchStatus: 'UNKNOWN' }, // a saved IGNORE
      ],
      exceptions: [{ empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })
    codeRows['0036'] = [{ id: 'a-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
    codeRows['0005'] = [{ id: 'r-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({
      matched: [
        { empCode: '0036', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' },
        { empCode: '0005', employeeId: 'emp-5', employeeCode: 'TPLGOAHLP005' },
      ],
      stillUnresolved: [],
    })
    expect(db.$transaction).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i++) {
      expect(typeof db.$transaction.mock.calls[i][0]).toBe('function')
      expect(timeoutOf(i)).toEqual({ timeout: 30000 })
    }
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(3)
    // Each transaction's own sequence: lock, count, (reads), writes, audit, then it ends before the next begins.
    expect(log).toEqual([
      'begin', 'lock', 'count 0036', 'rows 0036', 'existing', 'updateMany MATCHED', 'audit Code 0036 linked to TPLGOAHLP036', 'commit',
      'begin', 'lock', 'count 0005', 'rows 0005', 'existing', 'updateMany MATCHED', 'audit Code 0005 linked to TPLGOAHLP005', 'commit',
      'begin', 'lock', 'count 0999', 'updateMany IGNORED', 'audit Code 0999 ignored', 'commit',
    ])
  })

  it('locks the week row by the upload id, in every transaction', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }, { empCode: '0005', matchStatus: 'UNKNOWN' }] })
    codeRows['0036'] = [{ id: 'a-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
    codeRows['0005'] = [{ id: 'r-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]

    await rematchWeekCodes(WEEK_ID)

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(2)
    for (const call of db.tx.$queryRaw.mock.calls) {
      expect(call.slice(1)).toEqual(['upload-1'])
      expect((call[0] as string[]).join('?')).toContain('FOR UPDATE')
    }
  })

  it('processes the codes in the order they were read', async () => {
    serve({
      unresolved: [
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })
    for (const code of ['0005', '0036', '0009']) codeRows[code] = [{ id: `${code}-0`, punchDate: utc('2026-11-05'), pairIndex: 0 }]

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.matched.map((m) => m.empCode)).toEqual(['0005', '0036', '0009'])
    expect(auditRows(db.tx).map((a) => a.detailsJson.empCode)).toEqual(['0005', '0036', '0009'])
  })

  it('a code that still matches nothing opens no transaction and is reported as unresolved', async () => {
    serve({ unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0999'] })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.count).not.toHaveBeenCalled()
  })

  it('a duplicate that is still a duplicate opens no transaction either', async () => {
    serve({ unresolved: [{ empCode: '0007', matchStatus: 'DUPLICATE' }] }) // sevenA and sevenB both still end in 007

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0007'] })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('only the changing code gets a transaction when it sits between unchanged ones', async () => {
    serve({
      unresolved: [
        { empCode: '0998', matchStatus: 'UNKNOWN' }, // unchanged
        { empCode: '0036', matchStatus: 'UNKNOWN' }, // changes
        { empCode: '0007', matchStatus: 'DUPLICATE' }, // unchanged
      ],
    })
    codeRows['0036'] = [{ id: 'a-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]

    const result = await rematchWeekCodes(WEEK_ID)

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      matched: [{ empCode: '0036', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' }],
      stillUnresolved: ['0998', '0007'],
    })
  })

  it('a status change (unknown that now matches two employees) is written in its own transaction and stays in the unresolved list', async () => {
    serve({ unresolved: [{ empCode: '0007', matchStatus: 'UNKNOWN' }] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['begin', 'lock', 'count 0007', 'updateMany DUPLICATE', 'commit'])
    expect(result).toEqual({ matched: [], stillUnresolved: ['0007'] })
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('no unresolved codes at all: no transaction, no lock, an empty answer', async () => {
    serve({ unresolved: [] })

    await expect(rematchWeekCodes(WEEK_ID)).resolves.toEqual({ matched: [], stillUnresolved: [] })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('rematchWeekCodes: a code with nothing left to link is skipped under the lock', () => {
  it('count 0 after the lock: no write, no audit, and the code is in neither list', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })
    remaining['0036'] = 0 // a pull or another match got there first

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: [] })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(log).toEqual(['begin', 'lock', 'count 0036', 'commit'])
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.count).toHaveBeenCalledWith(unresolvedWhere('0036'))
  })

  it('also for an ignored code and for a status change', async () => {
    serve({
      unresolved: [
        { empCode: '0999', matchStatus: 'UNKNOWN' }, // would be ignored
        { empCode: '0007', matchStatus: 'UNKNOWN' }, // would become DUPLICATE
      ],
      exceptions: [{ empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })
    remaining['0999'] = 0
    remaining['0007'] = 0

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: [] })
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('only the skipped code is dropped; the others around it are still linked', async () => {
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })
    remaining['0005'] = 0
    codeRows['0036'] = [{ id: 'a-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
    codeRows['0009'] = [{ id: 'm-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.matched.map((m) => m.empCode)).toEqual(['0036', '0009'])
    expect(result.stillUnresolved).toEqual([])
    expect(auditRows(db.tx)).toHaveLength(2)
    expect(db.$transaction).toHaveBeenCalledTimes(3)
  })

  it('two rematches at once: the second finds nothing left and writes nothing, so each code is linked and audited once', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }, { empCode: '0005', matchStatus: 'UNKNOWN' }] })
    remaining['0036'] = 1
    remaining['0005'] = 1
    codeRows['0036'] = [{ id: 'a-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
    codeRows['0005'] = [{ id: 'r-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
    // A first writer's link makes the code resolved for whoever takes the lock next.
    db.tx.attendancePunch.updateMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) => {
      if (args.where.id) for (const code of Object.keys(codeRows)) if (codeRows[code].some((r) => args.where.id!.in.includes(r.id))) remaining[code] = 0
      return { count: 1 }
    })
    // The week row lock: the second transaction starts only after the first has finished.
    let tail: Promise<unknown> = Promise.resolve()
    db.$transaction.mockImplementation((arg: unknown) => {
      const run = tail.then(() => (arg as (tx: Db['tx']) => Promise<unknown>)(db.tx))
      tail = run.catch(() => undefined)
      return run
    })

    const [first, second] = await Promise.all([rematchWeekCodes(WEEK_ID), rematchWeekCodes(WEEK_ID)])

    expect(first.matched.map((m) => m.empCode)).toEqual(['0036', '0005'])
    expect(second).toEqual({ matched: [], stillUnresolved: [] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx)).toHaveLength(2)
  })
})

describe('rematchWeekCodes: an error stops the loop and earlier codes stay linked', () => {
  const threeCodes = () => {
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })
    for (const code of ['0036', '0005', '0009']) codeRows[code] = [{ id: `${code}-0`, punchDate: utc('2026-11-05'), pairIndex: 0 }]
  }

  it('the second code\'s transaction fails (a deadlock): the error is thrown as it is, the first code stays, the third is never tried', async () => {
    threeCodes()
    const deadlock = new Error('deadlock detected')
    db.tx.attendancePunch.updateMany
      .mockImplementationOnce(async () => {
        log.push('updateMany MATCHED')
        return { count: 1 }
      })
      .mockRejectedValueOnce(deadlock)

    const error = await rematchWeekCodes(WEEK_ID).catch((e: unknown) => e)

    expect(error).toBe(deadlock)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(2)
    // The first code's writes and audit row are all there is; nothing of the second, nothing of the third.
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ empCode: '0036', employeeId: 'emp-36' })
    expect(log.some((entry) => entry.includes('0009'))).toBe(false)
    expect(log.filter((entry) => entry === 'commit')).toHaveLength(1)
  })

  it('the second code\'s week is APPROVED under its lock: WEEK_LOCKED, the first code stays, the third is never tried', async () => {
    threeCodes()
    db.tx.$queryRaw
      .mockImplementationOnce(async () => {
        log.push('lock')
        return [lockedRow()]
      })
      .mockImplementationOnce(async () => {
        log.push('lock')
        return [lockedRow({ status: 'APPROVED', approvedAt: new Date('2026-11-13T03:00:00Z') })]
      })

    const error = await rematchWeekCodes(WEEK_ID).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error).toMatchObject({ code: 'WEEK_LOCKED', message: 'This week is approved. Reopen it to change codes or decisions.' })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx)).toHaveLength(1) // code 0036 only
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ empCode: '0036' })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.count).toHaveBeenCalledTimes(1) // the second transaction stopped at the lock
  })

  it('a pull takes the week between two codes: SYNC_IN_PROGRESS with the shared copy, earlier code stays', async () => {
    threeCodes()
    db.tx.$queryRaw
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([lockedRow({ syncLockedAt: new Date(Date.now() - 30_000) })])

    const error = await rematchWeekCodes(WEEK_ID).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })

  it('the week row is gone when the second lock is taken: WEEK_NOT_READY, nothing more is attempted', async () => {
    threeCodes()
    db.tx.$queryRaw.mockResolvedValueOnce([lockedRow()]).mockResolvedValueOnce([])

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx)).toHaveLength(1)
  })

  it('the audit write of the second code fails: the error propagates and the third code is not tried', async () => {
    threeCodes()
    db.tx.auditLog.create.mockResolvedValueOnce({ id: 'a1' }).mockRejectedValueOnce(new Error('audit table locked'))

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toThrow('audit table locked')

    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2) // the second code's link ran (and rolls back with its transaction)
  })

  it('the fast fail still comes first: an approved week opens no transaction at all', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    threeCodes()

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('an error on the plain-client reads happens before any transaction, so nothing is written', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })
    db.attendanceCodeException.findMany.mockRejectedValue(new Error('connection refused'))

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toThrow('connection refused')

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
  })
})

// ─── Item 5: one updateMany per pair offset ───────────────────────────────────

describe('linking a code moves its rows with one updateMany per pair offset', () => {
  const day = (iso: string) => utc(iso)

  function relink() {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })
    return rematchWeekCodes(WEEK_ID)
  }

  it('rows on two days at offsets 0 and 2: exactly two updateMany, no update, the right increments', async () => {
    codeRows['0036'] = [
      { id: 'x-0', punchDate: day('2026-11-05'), pairIndex: 0 }, // the employee already has pairs 0 and 1 here
      { id: 'x-1', punchDate: day('2026-11-05'), pairIndex: 0 },
      { id: 'x-2', punchDate: day('2026-11-05'), pairIndex: 1 },
      { id: 'y-0', punchDate: day('2026-11-06'), pairIndex: 0 }, // nothing there yet
      { id: 'y-1', punchDate: day('2026-11-06'), pairIndex: 0 },
    ]
    existing = [
      { punchDate: day('2026-11-05'), pairIndex: 0 },
      { punchDate: day('2026-11-05'), pairIndex: 1 },
    ]

    await relink()

    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2)
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['x-0', 'x-1', 'x-2'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED', pairIndex: { increment: 2 } },
    })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['y-0', 'y-1'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED' },
    })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ linkedPunches: 5 })
  })

  it('days that share an offset share one updateMany; three different offsets make three', async () => {
    codeRows['0036'] = [
      { id: 'a-0', punchDate: day('2026-11-05'), pairIndex: 0 }, // offset 2
      { id: 'b-0', punchDate: day('2026-11-06'), pairIndex: 0 }, // offset 2
      { id: 'c-0', punchDate: day('2026-11-07'), pairIndex: 0 }, // offset 1
      { id: 'd-0', punchDate: day('2026-11-08'), pairIndex: 0 }, // offset 4
      { id: 'e-0', punchDate: day('2026-11-09'), pairIndex: 0 }, // offset 0
    ]
    existing = [
      { punchDate: day('2026-11-05'), pairIndex: 1 },
      { punchDate: day('2026-11-06'), pairIndex: 0 },
      { punchDate: day('2026-11-06'), pairIndex: 1 },
      { punchDate: day('2026-11-07'), pairIndex: 0 },
      { punchDate: day('2026-11-08'), pairIndex: 3 },
    ]

    await relink()

    const calls = db.tx.attendancePunch.updateMany.mock.calls.map((c) => c[0] as { where: { id: { in: string[] } }; data: { pairIndex?: { increment: number } } })
    expect(calls).toHaveLength(4)
    const byOffset = new Map(calls.map((c) => [c.data.pairIndex?.increment ?? 0, c.where.id.in]))
    expect(byOffset.get(2)).toEqual(['a-0', 'b-0'])
    expect(byOffset.get(1)).toEqual(['c-0'])
    expect(byOffset.get(4)).toEqual(['d-0'])
    expect(byOffset.get(0)).toEqual(['e-0'])
    // offset 0 carries no pairIndex change at all
    expect(calls.find((c) => c.where.id.in.includes('e-0'))!.data).toEqual({ employeeId: 'emp-36', matchStatus: 'MATCHED' })
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
  })

  it('every row of a code is covered exactly once by the updateMany calls (none dropped, none moved twice)', async () => {
    codeRows['0036'] = Array.from({ length: 40 }, (_, i) => ({
      id: `r-${i}`,
      punchDate: day(`2026-11-${String(5 + (i % 5)).padStart(2, '0')}`),
      pairIndex: Math.floor(i / 10),
    }))
    existing = [
      { punchDate: day('2026-11-06'), pairIndex: 2 },
      { punchDate: day('2026-11-08'), pairIndex: 0 },
    ]

    await relink()

    const moved = db.tx.attendancePunch.updateMany.mock.calls.flatMap((c) => (c[0] as { where: { id: { in: string[] } } }).where.id.in)
    expect([...moved].sort()).toEqual(codeRows['0036'].map((r) => r.id).sort())
    expect(new Set(moved).size).toBe(40)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ linkedPunches: 40 })
  })

  it('a code with no rows left to read makes no updateMany but is still audited as 0 linked punches', async () => {
    codeRows['0036'] = []

    await relink()

    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Code 0036 linked to TPLGOAHLP036', linkedPunches: 0 })
  })

  it('the reads of linking are one after the other and on the transaction client', async () => {
    codeRows['0036'] = [{ id: 'a-0', punchDate: day('2026-11-05'), pairIndex: 0 }]

    await relink()

    expect(log.slice(log.indexOf('rows 0036'), log.indexOf('rows 0036') + 3)).toEqual(['rows 0036', 'existing', 'updateMany MATCHED'])
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled() // the plain client wrote nothing
  })

  it('matchCodeToEmployee links with the same updateMany-per-offset rule', async () => {
    db.attendancePunch.count.mockResolvedValue(3)
    db.tx.attendancePunch.count.mockResolvedValue(3)
    db.employee.findUnique.mockResolvedValue({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
    db.tx.employee.findUnique.mockResolvedValue({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-1' })
    codeRows['0999'] = [
      { id: 'n-0', punchDate: day('2026-11-05'), pairIndex: 0 },
      { id: 'n-1', punchDate: day('2026-11-05'), pairIndex: 1 },
      { id: 'n-2', punchDate: day('2026-11-06'), pairIndex: 0 },
    ]
    existing = [{ punchDate: day('2026-11-05'), pairIndex: 0 }]

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).resolves.toEqual({ linkedPunches: 3 })

    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n-0', 'n-1'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED', pairIndex: { increment: 1 } },
    })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n-2'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED' },
    })
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
  })
})

// ─── Item 9: matchCodeToEmployee re-reads the employee under the lock ─────────

describe('matchCodeToEmployee reads the employee again under the week lock', () => {
  const SELECT = { id: true, employeeId: true, employeeName: true }

  function serveMatch(over: { before?: unknown; locked?: unknown } = {}) {
    const before = over.before === undefined ? { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' } : over.before
    const locked = over.locked === undefined ? before : over.locked
    db.attendancePunch.count.mockResolvedValue(2)
    db.tx.attendancePunch.count.mockResolvedValue(2)
    db.employee.findUnique.mockResolvedValue(before)
    db.tx.employee.findUnique.mockResolvedValue(locked)
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-1' })
    codeRows['0999'] = [{ id: 'u-0', punchDate: utc('2026-11-05'), pairIndex: 0 }]
  }

  function expectNothingWritten() {
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
    expect(db.tx.attendanceCodeException.findUnique).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.auditLog.create).not.toHaveBeenCalled()
  }

  it('order: lock, then the code re-check, then the employee re-read, then the exception upsert', async () => {
    serveMatch()

    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.count))
    expect(order(db.tx.attendancePunch.count)).toBeLessThan(order(db.tx.employee.findUnique))
    expect(order(db.tx.employee.findUnique)).toBeLessThan(order(db.tx.attendanceCodeException.upsert))
    expect(order(db.tx.employee.findUnique)).toBeLessThan(order(db.tx.attendancePunch.updateMany))
    expect(db.tx.employee.findUnique).toHaveBeenCalledTimes(1)
    expect(db.tx.employee.findUnique).toHaveBeenCalledWith({ where: { id: 'emp-36' }, select: SELECT })
  })

  it('the pre-lock read stays on the plain client with the same select (the fast fail)', async () => {
    serveMatch()

    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(db.employee.findUnique).toHaveBeenCalledTimes(1)
    expect(db.employee.findUnique).toHaveBeenCalledWith({ where: { id: 'emp-36' }, select: SELECT })
    expect(db.employee.findUnique.mock.invocationCallOrder[0]).toBeLessThan(db.$transaction.mock.invocationCallOrder[0])
  })

  it('present before the lock, gone under it: EMPLOYEE_NOT_FOUND, no exception, no punch update, no audit', async () => {
    serveMatch({ locked: null })

    const error = await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error).toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: 'That employee no longer exists.' })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNothingWritten()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled() // nothing was even read for linking
  })

  it('gone before the lock: EMPLOYEE_NOT_FOUND from the fast fail, no transaction at all', async () => {
    serveMatch({ before: null })

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.employee.findUnique).not.toHaveBeenCalled()
  })

  it('the code resolved meanwhile: CODE_NOT_FOUND, and the employee is not even read under the lock', async () => {
    serveMatch()
    db.tx.attendancePunch.count.mockResolvedValue(0)

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })

    expect(db.tx.employee.findUnique).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('writes and audits the employee as read under the lock, not the copy read before it', async () => {
    serveMatch({
      before: { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' },
      locked: { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha R. Nair' }, // renamed in between
    })

    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    const [audit] = auditRows(db.tx)
    expect(audit.detailsJson.summary).toBe('Code 0999 matched to Asha R. Nair (TPLGOAHLP036)')
    expect(audit.detailsJson.summary).not.toContain('Asha Rao')
    expect(db.tx.attendanceCodeException.upsert).toHaveBeenCalledWith({
      where: { empCode: '0999' },
      create: { empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' },
      update: { kind: 'MATCH', employeeId: 'emp-36' },
    })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u-0'] } },
      data: { employeeId: 'emp-36', matchStatus: 'MATCHED' },
    })
  })

  it('uses the id from the locked read for the exception, the link and the audit', async () => {
    // The row found under the lock is the one written, whatever the first read returned.
    serveMatch({
      before: { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' },
      locked: { id: 'emp-36', employeeId: 'TPLGOAHLP036X', employeeName: 'Asha Rao' }, // the code was edited in between
    })

    await matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')

    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036X' })
  })

  it('a failure after the employee re-read (the link fails) writes no audit row', async () => {
    serveMatch()
    db.tx.attendancePunch.updateMany.mockRejectedValue(new Error('deadlock'))

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).rejects.toThrow('deadlock')

    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
  })
})
