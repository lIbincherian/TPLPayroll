// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { rematchWeekCodes } from '@/features/attendance-sync/services/employee-check.service'
import { auditRows, lockedRow, makeEmployee, makeUpload, resetDb, utc, type Db } from './service-fixtures'

// rematchWeekCodes reads the employees and exceptions once on the plain client, only to skip the codes
// that cannot change. Each code that might change then commits in its own transaction, which takes the week
// lock first and then matches the code AGAIN against the employees and that code's exception read under the
// lock. A link is only written to an employee that exists now and that the code still resolves to; an
// employee that vanished leaves the code unresolved, and a foreign-key refusal (P2003) rolls that one code
// back and reports it as unresolved. Every other error still stops the loop.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const UNRESOLVED = ['UNKNOWN', 'DUPLICATE']
const unresolvedWhere = (empCode: string) => ({
  where: { attendanceUploadId: 'upload-1', correctionId: null, empCode, matchStatus: { in: UNRESOLVED } },
})

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })
const meena = makeEmployee({ id: 'emp-9', employeeId: 'TPLGOAHLP009', employeeName: 'Meena Das' })

type Emp = ReturnType<typeof makeEmployee>
type Exception = { empCode: string; kind: string; employeeId: string | null }

let log: string[]

/** The plain-client reads (the pre-filter) and the transaction-client reads (under the lock) are served separately. */
function serve(opts: {
  unresolved: Array<{ empCode: string; matchStatus: string }>
  before?: Emp[]
  beforeExceptions?: Exception[]
  locked?: Emp[]
  lockedExceptions?: Exception[]
}) {
  const before = opts.before ?? [asha, ravi, meena]
  db.employee.findMany.mockResolvedValue(before)
  db.attendanceCodeException.findMany.mockResolvedValue(opts.beforeExceptions ?? [])
  db.attendancePunch.findMany.mockResolvedValue(opts.unresolved)
  db.tx.employee.findMany.mockImplementation(async () => {
    log.push('locked employees')
    return opts.locked ?? before
  })
  db.tx.attendanceCodeException.findMany.mockImplementation(async (args?: { where?: { empCode?: string } }) => {
    log.push(`locked exception ${args?.where?.empCode}`)
    const all = opts.lockedExceptions ?? opts.beforeExceptions ?? []
    return args?.where?.empCode === undefined ? all : all.filter((e) => e.empCode === args.where!.empCode)
  })
}

const foreignKey = () => new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated on the constraint: `AttendancePunch_employeeId_fkey`', { code: 'P2003', clientVersion: 'test' })

beforeEach(() => {
  resetDb(db)
  log = []
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
    return 1
  })
  db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string; employeeId?: string } }) => {
    if (where.empCode) {
      log.push(`rows ${where.empCode}`)
      return [{ id: `${where.empCode}-0`, punchDate: utc('2026-11-05'), pairIndex: 0 }]
    }
    log.push(`existing ${where.employeeId}`)
    return []
  })
  db.tx.attendancePunch.updateMany.mockImplementation(async (args: { data: { matchStatus: string } }) => {
    log.push(`updateMany ${args.data.matchStatus}`)
    return { count: 1 }
  })
  db.tx.auditLog.create.mockImplementation(async ({ data }: { data: { detailsJson: { summary: string } } }) => {
    log.push(`audit ${data.detailsJson.summary}`)
    return { id: 'audit-1' }
  })
})

// ─── The locked match ─────────────────────────────────────────────────────────

describe('rematchWeekCodes: the match is made again under the week lock', () => {
  it('reads the employees and this code\'s exception on the transaction client, after the lock and the count, before any write', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })

    await rematchWeekCodes(WEEK_ID)

    expect(log).toEqual([
      'begin', 'lock', 'count 0036', 'locked employees', 'locked exception 0036',
      'rows 0036', 'existing emp-36', 'updateMany MATCHED', 'audit Code 0036 linked to TPLGOAHLP036', 'commit',
    ])
    expect(db.tx.employee.findMany).toHaveBeenCalledWith({
      select: { id: true, employeeId: true, employeeName: true, isActive: true, dateOfResignation: true },
    })
    expect(db.tx.attendanceCodeException.findMany).toHaveBeenCalledWith({
      where: { empCode: '0036' },
      select: { empCode: true, kind: true, employeeId: true },
    })
    // The plain client read every exception, once, before the loop: the locked read is the narrow one.
    expect(db.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceCodeException.findMany).toHaveBeenCalledWith({ where: undefined, select: { empCode: true, kind: true, employeeId: true } })
  })

  it('every code gets its own locked reads, each filtered by its own code', async () => {
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })

    await rematchWeekCodes(WEEK_ID)

    expect(db.tx.employee.findMany).toHaveBeenCalledTimes(3)
    expect(db.tx.attendanceCodeException.findMany.mock.calls.map((c) => (c[0] as { where: { empCode: string } }).where.empCode)).toEqual(['0036', '0005', '0009'])
    expect(log.filter((e) => e === 'locked employees')).toHaveLength(3)
  })

  it('a code with nothing left to link is skipped before the locked reads', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })
    db.tx.attendancePunch.count.mockResolvedValue(0)

    await expect(rematchWeekCodes(WEEK_ID)).resolves.toEqual({ matched: [], stillUnresolved: [] })

    expect(db.tx.employee.findMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceCodeException.findMany).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
  })

  it('an employee deleted since the first read: nothing is linked, the code is reported unresolved, no audit row', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }], locked: [ravi, meena] }) // Asha is gone under the lock

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0036'] })
    expect(log).not.toContain('updateMany MATCHED')
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({ ...unresolvedWhere('0036'), data: { matchStatus: 'UNKNOWN' } })
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled() // no rows were read to be moved
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('an employee whose Employee ID was edited since the first read: the link goes to whoever matches now', async () => {
    serve({
      unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }],
      // Under the lock Asha has been renumbered and Ravi holds the 036 ID.
      locked: [{ ...asha, employeeId: 'TPLGOAHLP136' }, { ...ravi, employeeId: 'TPLGOAHLP036' }, meena],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [{ empCode: '0036', employeeId: 'emp-5', employeeCode: 'TPLGOAHLP036' }], stillUnresolved: [] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['0036-0'] } },
      data: { employeeId: 'emp-5', matchStatus: 'MATCHED' },
    })
    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ employeeId: 'emp-36' }) }))
    expect(log).toContain('existing emp-5') // the pairs that are appended after are the new employee's
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ empCode: '0036', employeeId: 'emp-5', employeeCode: 'TPLGOAHLP036', linkedPunches: 1 })
  })

  it('an employee whose Employee ID was edited so the code no longer matches: not linked, reported unresolved', async () => {
    serve({
      unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }],
      locked: [{ ...asha, employeeId: 'TPLGOAHLP136' }, ravi, meena],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0036'] })
    expect(log).not.toContain('updateMany MATCHED')
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('a second employee with the same number appeared since the first read: the code becomes a duplicate, not a link', async () => {
    serve({
      unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }],
      locked: [asha, makeEmployee({ id: 'emp-36b', employeeId: 'TPLGOASUP036', employeeName: 'Asha Sup' }), ravi, meena],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0036'] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({ ...unresolvedWhere('0036'), data: { matchStatus: 'DUPLICATE' } })
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('an IGNORE exception saved since the first read wins under the lock: the code is ignored, not linked', async () => {
    serve({
      unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }],
      lockedExceptions: [{ empCode: '0036', kind: 'IGNORE', employeeId: null }],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: [] }) // ignored: in neither list
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({ ...unresolvedWhere('0036'), data: { employeeId: null, matchStatus: 'IGNORED' } })
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Code 0036 ignored', empCode: '0036' })
    expect(log).not.toContain('updateMany MATCHED')
  })

  it('a MATCH exception saved since the first read points the code at that employee', async () => {
    serve({
      unresolved: [{ empCode: '0999', matchStatus: 'UNKNOWN' }],
      before: [asha, ravi, meena],
      beforeExceptions: [{ empCode: '0999', kind: 'IGNORE', employeeId: null }], // the first read: ignored (a change, so it opens a transaction)
      lockedExceptions: [{ empCode: '0999', kind: 'MATCH', employeeId: 'emp-9' }], // then someone matched it to Meena
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [{ empCode: '0999', employeeId: 'emp-9', employeeCode: 'TPLGOAHLP009' }], stillUnresolved: [] })
    expect(db.tx.attendancePunch.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['0999-0'] } }, data: { employeeId: 'emp-9', matchStatus: 'MATCHED' } })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ empCode: '0999', employeeId: 'emp-9', via: 'EXCEPTION' })
  })

  it('the vanished employee only costs its own code: the codes around it are still linked', async () => {
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
      locked: [asha, meena], // Ravi (0005) is deleted
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.matched.map((m) => m.empCode)).toEqual(['0036', '0009'])
    expect(result.stillUnresolved).toEqual(['0005'])
    expect(auditRows(db.tx).map((a) => a.detailsJson.empCode)).toEqual(['0036', '0009'])
    expect(db.$transaction).toHaveBeenCalledTimes(3)
  })
})

// ─── A foreign-key refusal rolls the code back ────────────────────────────────

describe('rematchWeekCodes: a foreign-key refusal (P2003) leaves that code unresolved and carries on', () => {
  const threeCodes = () =>
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })

  it('the link of the middle code hits P2003 (the employee was deleted after the locked read): it is reported unresolved, the other two are linked', async () => {
    threeCodes()
    db.tx.attendancePunch.updateMany
      .mockImplementationOnce(async () => ({ count: 1 }))
      .mockRejectedValueOnce(foreignKey())
      .mockImplementationOnce(async () => ({ count: 1 }))

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({
      matched: [
        { empCode: '0036', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' },
        { empCode: '0009', employeeId: 'emp-9', employeeCode: 'TPLGOAHLP009' },
      ],
      stillUnresolved: ['0005'],
    })
    expect(db.$transaction).toHaveBeenCalledTimes(3) // the loop did not stop, and 0005 was not retried
    // The refused code wrote no audit row (the audit is after the link in the same transaction).
    expect(auditRows(db.tx).map((a) => a.detailsJson.empCode)).toEqual(['0036', '0009'])
    // Its transaction ended with the error, never with a commit: two commits for three transactions.
    expect(log.filter((e) => e === 'commit')).toHaveLength(2)
  })

  it('P2003 on the first code, then no other error: the run still finishes and answers normally', async () => {
    threeCodes()
    db.tx.attendancePunch.updateMany.mockRejectedValueOnce(foreignKey())

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result.stillUnresolved).toEqual(['0036'])
    expect(result.matched.map((m) => m.empCode)).toEqual(['0005', '0009'])
  })

  it('P2003 on the audit write after the link: the same, the code is not reported as matched', async () => {
    serve({ unresolved: [{ empCode: '0036', matchStatus: 'UNKNOWN' }] })
    db.tx.auditLog.create.mockRejectedValueOnce(foreignKey())

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: ['0036'] })
    expect(log.filter((e) => e === 'commit')).toHaveLength(0)
  })

  it('every code hitting P2003: nothing matched, all unresolved, and no error escapes', async () => {
    threeCodes()
    db.tx.attendancePunch.updateMany.mockRejectedValue(foreignKey())

    await expect(rematchWeekCodes(WEEK_ID)).resolves.toEqual({ matched: [], stillUnresolved: ['0036', '0005', '0009'] })
    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

describe('rematchWeekCodes: every other error still stops the loop and is thrown', () => {
  const threeCodes = () =>
    serve({
      unresolved: [
        { empCode: '0036', matchStatus: 'UNKNOWN' },
        { empCode: '0005', matchStatus: 'UNKNOWN' },
        { empCode: '0009', matchStatus: 'UNKNOWN' },
      ],
    })

  it.each([
    ['P2002', 'a unique constraint'],
    ['P2034', 'a write conflict or deadlock'],
    ['P2025', 'a record that was not found'],
  ])('a Prisma %s (%s) on the second code is thrown as it is; the first code stays, the third is never tried', async (code) => {
    threeCodes()
    const refusal = new Prisma.PrismaClientKnownRequestError('refused', { code, clientVersion: 'test' })
    db.tx.attendancePunch.updateMany.mockImplementationOnce(async () => ({ count: 1 })).mockRejectedValueOnce(refusal)

    const error = await rematchWeekCodes(WEEK_ID).catch((e: unknown) => e)

    expect(error).toBe(refusal)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(auditRows(db.tx).map((a) => a.detailsJson.empCode)).toEqual(['0036'])
    expect(log.some((e) => e.includes('0009'))).toBe(false)
  })

  it('a non-Prisma failure is thrown too, even one that mentions a foreign key', async () => {
    threeCodes()
    const failure = new Error('violates foreign key constraint "AttendancePunch_employeeId_fkey"')
    db.tx.attendancePunch.updateMany.mockRejectedValueOnce(failure)

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toBe(failure)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('a P2003 does not hide a later error: the next code\'s failure is still thrown', async () => {
    threeCodes()
    const deadlock = new Error('deadlock detected')
    db.tx.attendancePunch.updateMany.mockRejectedValueOnce(foreignKey()).mockRejectedValueOnce(deadlock)

    await expect(rematchWeekCodes(WEEK_ID)).rejects.toBe(deadlock)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })
})
