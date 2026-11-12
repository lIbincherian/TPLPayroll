// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import {
  ignoreCode,
  matchCodeToEmployee,
  rematchWeekCodes,
  setEmployeeDecision,
} from '@/features/attendance-sync/services/employee-check.service'
import { SYNC_IN_PROGRESS_MESSAGE } from '@/features/attendance-sync/services/week-lock.service'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import {
  auditRows,
  makeEmployee,
  makeUpload,
  mockLockedWeek,
  resetDb,
  utc,
  type Db,
} from './service-fixtures'

// Fix round 3, item 2: the four employee-check writers (rematchWeekCodes, matchCodeToEmployee, ignoreCode,
// setEmployeeDecision) take the week row lock first inside their transaction and decide again on the LOCKED
// row. The pre-transaction check on the unlocked row is only a fast fail. These tests make the unlocked read
// and the locked read disagree, which is exactly the race the lock closes.
// Round 4, items 5 and 9: rematchWeekCodes reads its codes on the plain client and commits each changing code
// in its own transaction; matchCodeToEmployee reads the employee again under the lock.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const CODE_ROWS = [
  { id: 'u1-0', punchDate: utc('2026-11-05'), pairIndex: 0 },
  { id: 'u1-1', punchDate: utc('2026-11-05'), pairIndex: 0 },
]

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const inactive = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })

const freshLock = () => new Date(Date.now() - 60_000)
const staleLock = () => new Date(Date.now() - SYNC_LOCK_TTL_MS - 1000)

type Fn = ReturnType<typeof vi.fn>
const order = (fn: Fn, index = 0): number => fn.mock.invocationCallOrder[index]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Nothing was saved anywhere: no punch, exception or decision write, no audit row, on either client. */
function expectNothingWritten() {
  for (const [label, client] of [['plain', db], ['tx', db.tx]] as const) {
    for (const method of ['update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
      expect(client.attendancePunch[method], `${label} attendancePunch.${method}`).not.toHaveBeenCalled()
    }
    expect(client.attendanceCodeException.upsert, `${label} attendanceCodeException.upsert`).not.toHaveBeenCalled()
    for (const method of ['create', 'update', 'deleteMany']) {
      expect(client.attendanceEmployeeDecision[method], `${label} attendanceEmployeeDecision.${method}`).not.toHaveBeenCalled()
    }
    expect(client.auditLog.create, `${label} auditLog.create`).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  resetDb(db)
  // The unlocked read (before the transaction): a REVIEW week nobody is pulling.
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  const employeeById = async ({ where }: { where: { id: string } }) =>
    where.id === 'emp-2' ? { ...inactive } : { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao', isActive: true, dateOfResignation: null }
  db.employee.findUnique.mockImplementation(employeeById)
  db.attendancePunch.count.mockResolvedValue(4)

  // rematchWeekCodes reads its codes, employees and exceptions on the plain client, before any transaction.
  db.attendancePunch.findMany.mockImplementation(async ({ distinct }: { distinct?: string[] }) =>
    distinct ? [{ empCode: '0999', matchStatus: 'UNKNOWN' }] : [],
  )
  db.employee.findMany.mockResolvedValue([asha])
  // A saved IGNORE exception makes rematchWeekCodes write (updateMany) for the unresolved code 0999.
  db.attendanceCodeException.findMany.mockResolvedValue([{ empCode: '0999', kind: 'IGNORE', employeeId: null }])
  // Each changing code is matched again under its lock, on the transaction client: the same employees and exceptions.
  db.tx.employee.findMany.mockResolvedValue([asha])
  db.tx.attendanceCodeException.findMany.mockResolvedValue([{ empCode: '0999', kind: 'IGNORE', employeeId: null }])

  // The transaction's own reads: everything the four writers need to succeed.
  db.tx.attendancePunch.count.mockResolvedValue(4)
  db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) =>
    where.empCode ? CODE_ROWS : [],
  )
  db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 2 })
  db.tx.employee.findUnique.mockImplementation(employeeById) // matchCodeToEmployee reads the employee again under the lock
  db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
  db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-1' })
  db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue(null)
  db.tx.attendanceEmployeeDecision.create.mockResolvedValue({ id: 'decision-1' })
})

interface WriterCase {
  name: string
  run: () => Promise<unknown>
  /** The first write the writer makes once it has the lock. */
  firstWrite: () => Fn
  /** The first read the writer makes on the transaction client. */
  firstTxRead: () => Fn
  /** Decisions need status REVIEW; the code writers only refuse APPROVED. */
  needsReview: boolean
  approvedMessage: string
}

const CODES_APPROVED = 'This week is approved. Reopen it to change codes or decisions.'
const DECISIONS_LOCKED = 'This week is locked. Reopen it to change decisions.'

const writers: WriterCase[] = [
  {
    name: 'rematchWeekCodes',
    run: () => rematchWeekCodes(WEEK_ID),
    firstWrite: () => db.tx.attendancePunch.updateMany,
    firstTxRead: () => db.tx.attendancePunch.count,
    needsReview: false,
    approvedMessage: CODES_APPROVED,
  },
  {
    name: 'matchCodeToEmployee',
    run: () => matchCodeToEmployee(WEEK_ID, '0999', 'emp-36'),
    firstWrite: () => db.tx.attendanceCodeException.upsert,
    firstTxRead: () => db.tx.attendancePunch.count,
    needsReview: false,
    approvedMessage: CODES_APPROVED,
  },
  {
    name: 'ignoreCode',
    run: () => ignoreCode(WEEK_ID, '0999', 'ALWAYS'),
    firstWrite: () => db.tx.attendanceCodeException.upsert,
    firstTxRead: () => db.tx.attendancePunch.count,
    needsReview: false,
    approvedMessage: CODES_APPROVED,
  },
  {
    name: 'setEmployeeDecision',
    run: () => setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED'),
    firstWrite: () => db.tx.attendanceEmployeeDecision.create,
    firstTxRead: () => db.tx.attendancePunch.count,
    needsReview: true,
    approvedMessage: DECISIONS_LOCKED,
  },
]

// ─── The lock: first statement of the one transaction ─────────────────────────

describe.each(writers)('$name takes the week lock', (w) => {
  it('opens one interactive transaction with the 30 s timeout and locks the week row by id, once', async () => {
    await w.run()

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    // lockWeekRow's tagged template: [strings, ...values]; the only value is the upload id.
    expect(db.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['upload-1'])
    // The lock is never taken on the plain client (it would be released at once).
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('locks before it reads anything on the transaction client and before its first write', async () => {
    await w.run()

    expect(w.firstWrite()).toHaveBeenCalled()
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(w.firstTxRead()))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(w.firstWrite()))
  })

  it('WEEK_LOCKED when the locked row is APPROVED although the unlocked read said REVIEW; nothing is read or written', async () => {
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') })

    const error = await w.run().catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'WEEK_LOCKED', message: w.approvedMessage })
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(w.firstTxRead()).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('SYNC_IN_PROGRESS with the shared copy when the locked row has a fresh pull lock; nothing is read or written', async () => {
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: freshLock() })

    const error = await w.run().catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
    expect(w.firstTxRead()).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('proceeds when the locked row carries a stale pull lock (older than the TTL)', async () => {
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: staleLock() })

    await expect(w.run()).resolves.toBeDefined()

    expect(w.firstWrite()).toHaveBeenCalledTimes(1)
  })

  it('WEEK_NOT_READY when the week row is gone by the time the lock is taken; nothing is read or written', async () => {
    mockLockedWeek(db.tx, null)

    const error = await w.run().catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'WEEK_NOT_READY', message: 'No attendance has been loaded for this week.' })
    expect(w.firstTxRead()).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('keeps the fast fail: an approved week is refused before any transaction is opened or lock taken', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(
      makeUpload({ status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }),
    )

    await expect(w.run()).rejects.toMatchObject({ code: 'WEEK_LOCKED', message: w.approvedMessage })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('keeps the fast fail: a fresh pull lock is refused before any transaction is opened or lock taken', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: freshLock() }))

    await expect(w.run()).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
  })
})

// ─── Which statuses each writer accepts on the locked row ─────────────────────

describe('the locked status rules differ for codes and decisions', () => {
  it('setEmployeeDecision needs REVIEW on the locked row: a week that failed or was approved meanwhile is WEEK_LOCKED', async () => {
    for (const status of ['APPROVED', 'SYNC_FAILED']) {
      db.tx.$queryRaw.mockClear()
      mockLockedWeek(db.tx, { status })

      const error = await setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED').catch((e: { code: string; message: string }) => e)

      expect(error, status).toMatchObject({ code: 'WEEK_LOCKED', message: DECISIONS_LOCKED })
    }
    expectNothingWritten()
  })

  it.each([
    ['matchCodeToEmployee', () => matchCodeToEmployee(WEEK_ID, '0999', 'emp-36'), () => db.tx.attendanceCodeException.upsert],
    ['ignoreCode', () => ignoreCode(WEEK_ID, '0999', 'ALWAYS'), () => db.tx.attendanceCodeException.upsert],
    ['rematchWeekCodes', () => rematchWeekCodes(WEEK_ID), () => db.tx.attendancePunch.updateMany],
  ])('%s still accepts a SYNC_FAILED locked row (codes only refuse an approved week)', async (_name, run, firstWrite) => {
    mockLockedWeek(db.tx, { status: 'SYNC_FAILED' })

    await expect(run()).resolves.toBeDefined()

    expect(firstWrite()).toHaveBeenCalledTimes(1)
  })
})

// ─── matchCodeToEmployee / ignoreCode: the code is checked again under the lock ─

describe.each([
  ['matchCodeToEmployee', () => matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')],
  ['ignoreCode', () => ignoreCode(WEEK_ID, '0999', 'ALWAYS')],
])('%s re-checks that the code is still unresolved under the lock', (_name, run) => {
  const unresolvedWhere = {
    where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0999', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
  }

  it('CODE_NOT_FOUND, with no exception saved and nothing linked, when a pull or another match resolved it since the unlocked check', async () => {
    db.attendancePunch.count.mockResolvedValue(3) // the unlocked check still sees it
    db.tx.attendancePunch.count.mockResolvedValue(0) // the locked read does not

    const error = await run().catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'CODE_NOT_FOUND', message: "That code doesn't need fixing in this week." })
    expect(db.attendancePunch.count).toHaveBeenCalledWith(unresolvedWhere)
    expect(db.tx.attendancePunch.count).toHaveBeenCalledWith(unresolvedWhere)
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('counts the unresolved punches on the transaction client, after the lock, not on the plain client again', async () => {
    await run()

    expect(db.attendancePunch.count).toHaveBeenCalledTimes(1) // the fast fail only
    expect(db.tx.attendancePunch.count).toHaveBeenCalledTimes(1)
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.count))
    expect(order(db.tx.attendancePunch.count)).toBeLessThan(order(db.tx.attendanceCodeException.upsert))
  })
})

// ─── setEmployeeDecision: a decision exists only while it is needed ───────────

describe('setEmployeeDecision re-counts the employee\'s punches under the lock', () => {
  it('VALIDATION_ERROR and no decision row when a pull removed the punches after the unlocked count', async () => {
    db.attendancePunch.count.mockResolvedValue(4) // unlocked: needed
    db.tx.attendancePunch.count.mockResolvedValue(0) // locked: the pull took them away

    const error = await setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED').catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'This employee does not need a decision for this week.' })
    expect(db.tx.attendancePunch.count).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-2' },
    })
    expect(db.tx.attendanceEmployeeDecision.findUnique).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('counts on the transaction client after the lock and before the decision is read or written', async () => {
    await setEmployeeDecision(WEEK_ID, 'emp-2', 'REJECTED')

    expect(db.attendancePunch.count).toHaveBeenCalledTimes(1) // the unlocked count only
    expect(db.tx.attendancePunch.count).toHaveBeenCalledTimes(1)
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.count))
    expect(order(db.tx.attendancePunch.count)).toBeLessThan(order(db.tx.attendanceEmployeeDecision.findUnique))
    expect(order(db.tx.attendanceEmployeeDecision.findUnique)).toBeLessThan(order(db.tx.attendanceEmployeeDecision.create))
  })

  it('still writes the decision and its audit row on the transaction client when the locked count agrees', async () => {
    await expect(setEmployeeDecision(WEEK_ID, 'emp-2', 'REJECTED')).resolves.toEqual({ decision: 'REJECTED' })

    expect(db.tx.attendanceEmployeeDecision.create).toHaveBeenCalledWith({
      data: { attendanceUploadId: 'upload-1', employeeId: 'emp-2', reason: 'INACTIVE', decision: 'REJECTED' },
    })
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db)).toHaveLength(0)
  })
})

// ─── rematchWeekCodes: plain reads first, then one transaction per changing code ─

describe('rematchWeekCodes reads on the plain client and commits each changing code in its own transaction', () => {
  it('reads the unresolved codes, the employees and the exceptions through the plain client, before any lock', async () => {
    await rematchWeekCodes(WEEK_ID)

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      select: { empCode: true, matchStatus: true },
      distinct: ['empCode'],
    })
    expect(db.employee.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    // The transaction client does not repeat the unresolved-codes read; it reads the employees and the
    // code's exception again, but only after taking the lock.
    expect(db.tx.employee.findMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendanceCodeException.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { empCode: '0999' } }))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.employee.findMany))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendanceCodeException.findMany))
    for (const call of db.tx.attendancePunch.findMany.mock.calls) {
      expect((call[0] as { distinct?: string[] }).distinct).toBeUndefined()
    }
    // All three come before the lock.
    for (const read of [db.attendancePunch.findMany, db.employee.findMany, db.attendanceCodeException.findMany]) {
      expect(order(read)).toBeLessThan(order(db.tx.$queryRaw))
    }
  })

  it('reads the employees and the exceptions together (no transaction is open yet, so the plain client may overlap them)', async () => {
    const employees = deferred<unknown[]>()
    db.employee.findMany.mockReturnValue(employees.promise)

    const run = rematchWeekCodes(WEEK_ID)
    await vi.waitFor(() => expect(db.employee.findMany).toHaveBeenCalled())
    await tick()
    expect(db.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    expect(db.$transaction).not.toHaveBeenCalled()

    employees.resolve([asha])
    await run
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('the IGNORED branch writes through the transaction client, with its audit row, and nothing on the plain client', async () => {
    await rematchWeekCodes(WEEK_ID)

    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0999', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      data: { employeeId: null, matchStatus: 'IGNORED' },
    })
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Code 0999 ignored' })
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(db.auditLog.create).not.toHaveBeenCalled()
    expect(order(db.tx.attendancePunch.updateMany)).toBeLessThan(order(db.tx.auditLog.create))
  })

  it('the UNKNOWN/DUPLICATE status flip goes through the transaction client too', async () => {
    const sevens = [
      makeEmployee({ id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp' }),
      makeEmployee({ id: 'emp-7b', employeeId: 'TPLGOASUP007', employeeName: 'Seven Sup' }),
    ]
    db.attendanceCodeException.findMany.mockResolvedValue([])
    db.employee.findMany.mockResolvedValue(sevens)
    db.tx.attendanceCodeException.findMany.mockResolvedValue([])
    db.tx.employee.findMany.mockResolvedValue(sevens)
    db.attendancePunch.findMany.mockImplementation(async ({ distinct }: { distinct?: string[] }) =>
      distinct ? [{ empCode: '0007', matchStatus: 'UNKNOWN' }] : [],
    )

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0007'] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, empCode: '0007', matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      data: { matchStatus: 'DUPLICATE' },
    })
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
  })

  it('a failing write rejects, leaves no audit row for it, and nothing was done outside the transaction that rolls back', async () => {
    db.tx.attendancePunch.updateMany.mockRejectedValue(new Error('deadlock detected'))

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toThrow('deadlock detected')

    expect(auditRows(db.tx)).toHaveLength(0)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNoPlainClientWrites()
  })

  it('a failure on a later code leaves the earlier code committed in its own transaction (never on the plain client)', async () => {
    const ignores = [
      { empCode: '0999', kind: 'IGNORE', employeeId: null },
      { empCode: '0998', kind: 'IGNORE', employeeId: null },
    ]
    db.attendanceCodeException.findMany.mockResolvedValue(ignores)
    db.tx.attendanceCodeException.findMany.mockResolvedValue(ignores)
    db.attendancePunch.findMany.mockImplementation(async ({ distinct }: { distinct?: string[] }) =>
      distinct
        ? [
            { empCode: '0998', matchStatus: 'UNKNOWN' },
            { empCode: '0999', matchStatus: 'UNKNOWN' },
          ]
        : [],
    )
    db.tx.attendancePunch.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error('connection reset'))

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toThrow('connection reset')

    // One transaction per code: the first code's write and audit committed with its transaction and stay.
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Code 0998 ignored' })
    expectNoPlainClientWrites()
  })

  it('returns what it matched and what is still unresolved, once the transactions have committed', async () => {
    db.attendanceCodeException.findMany.mockResolvedValue([])
    db.tx.attendanceCodeException.findMany.mockResolvedValue([])
    db.attendancePunch.findMany.mockImplementation(async ({ distinct }: { distinct?: string[] }) =>
      distinct
        ? [
            { empCode: '0036', matchStatus: 'UNKNOWN' },
            { empCode: '0999', matchStatus: 'UNKNOWN' },
          ]
        : [],
    )
    db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) =>
      where.empCode === '0036' ? [{ id: 'm-0', punchDate: utc('2026-11-05'), pairIndex: 0 }] : [],
    )

    await expect(rematchWeekCodes(WEEK_ID)).resolves.toEqual({
      matched: [{ empCode: '0036', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' }],
      stillUnresolved: ['0999'],
    })
  })
})

function expectNoPlainClientWrites() {
  for (const method of ['update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
    expect(db.attendancePunch[method], `plain attendancePunch.${method}`).not.toHaveBeenCalled()
  }
  expect(db.auditLog.create).not.toHaveBeenCalled()
}

// ─── linkCodeToEmployee: two reads in sequence, never Promise.all on tx ───────

describe('linking a code reads the code\'s rows, then the employee\'s existing pairs, one after the other', () => {
  function gateTheCodeRows() {
    const calls: string[] = []
    const gate = deferred<typeof CODE_ROWS>()
    db.tx.attendancePunch.findMany.mockImplementation(
      (args: { where: { empCode?: string } }) => {
        if (args.where.empCode) {
          calls.push('codeRows')
          return gate.promise
        }
        calls.push('existingPairs')
        return Promise.resolve([])
      },
    )
    return { calls, gate }
  }

  it('matchCodeToEmployee: the existing-pairs read does not start while the code-rows read is pending', async () => {
    const { calls, gate } = gateTheCodeRows()

    const run = matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')
    await vi.waitFor(() => expect(calls).toContain('codeRows'))
    await tick()
    await tick()
    expect(calls).toEqual(['codeRows']) // a Promise.all would already have started 'existingPairs'

    gate.resolve(CODE_ROWS)
    await expect(run).resolves.toEqual({ linkedPunches: 2 })
    expect(calls).toEqual(['codeRows', 'existingPairs'])
  })

  it('rematchWeekCodes: the same, for a code that now matches an employee by number', async () => {
    db.attendanceCodeException.findMany.mockResolvedValue([])
    db.tx.attendanceCodeException.findMany.mockResolvedValue([])
    db.attendancePunch.findMany.mockResolvedValue([{ empCode: '0036', matchStatus: 'UNKNOWN' }])
    const { calls, gate } = gateTheCodeRows()

    const run = rematchWeekCodes(WEEK_ID)
    await vi.waitFor(() => expect(calls).toContain('codeRows'))
    await tick()
    await tick()
    expect(calls).toEqual(['codeRows'])

    gate.resolve(CODE_ROWS)
    await run
    expect(calls).toEqual(['codeRows', 'existingPairs'])
  })
})
