// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import {
  getEmployeeCheck,
  ignoreCode,
  rematchWeekCodes,
  unignoreCode,
} from '@/features/attendance-sync/services/employee-check.service'
import { ignoreScopeOf } from '@/features/attendance-sync/lib/matching'
import { SYNC_IN_PROGRESS_MESSAGE } from '@/features/attendance-sync/services/week-lock.service'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import type { EmployeeLite } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  makeEmployee,
  makeUpload,
  mockLockedWeek,
  resetDb,
  type Db,
  type PunchRow,
} from './service-fixtures'

// "Ignore this week" / "Ignore every week" and "Stop ignoring".
//
// These tests back the Prisma mock with a small in-memory world (punches, saved exceptions, employees) on both the
// plain and the transaction client, so what is asserted is the state the service leaves behind (which punches carry
// which status, which exceptions exist) and not only which calls it made. Call-shape assertions are added where the
// point is a call that must NOT happen (a week-only ignore never saves an exception).

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const freshLock = () => new Date(Date.now() - 60_000)
const staleLock = () => new Date(Date.now() - SYNC_LOCK_TTL_MS - 1000)

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
/** The employee a code 0999 resolves to by number. */
const gita = makeEmployee({ id: 'emp-999', employeeId: 'TPLGOAHLP999', employeeName: 'Gita Pillai' })
const sevenA = makeEmployee({ id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp' })
const sevenB = makeEmployee({ id: 'emp-7b', employeeId: 'TPLGOASUP007', employeeName: 'Seven Sup' })

interface Exception {
  id: string
  empCode: string
  kind: 'MATCH' | 'IGNORE'
  employeeId: string | null
}

interface World {
  punches: PunchRow[]
  exceptions: Exception[]
  employees: EmployeeLite[]
}

type Where = Record<string, unknown>

function rowMatches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key]
    if (cond === null) return value === null || value === undefined
    if (typeof cond === 'object') {
      const c = cond as { in?: unknown[] }
      if (c.in) return c.in.includes(value)
      throw new Error(`Unsupported where operator on ${key}: ${JSON.stringify(cond)}`)
    }
    return value === cond
  })
}

/** Back the punch, code-exception and employee reads and writes of both clients with `world`. */
function installWorld(world: World): World {
  for (const client of [db, db.tx]) {
    client.attendancePunch.findMany.mockImplementation(async (args?: { where?: Where; distinct?: string[] }) => {
      let rows = world.punches.filter((r) => rowMatches(r as unknown as Record<string, unknown>, args?.where))
      if (args?.distinct?.includes('empCode')) {
        rows = rows.filter((r, i) => rows.findIndex((x) => x.empCode === r.empCode) === i)
      }
      return rows.map((r) => ({ ...r }))
    })
    client.attendancePunch.count.mockImplementation(
      async ({ where }: { where: Where }) =>
        world.punches.filter((r) => rowMatches(r as unknown as Record<string, unknown>, where)).length,
    )
    client.attendancePunch.updateMany.mockImplementation(
      async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const rows = world.punches.filter((r) => rowMatches(r as unknown as Record<string, unknown>, where))
        for (const row of rows) {
          for (const [key, value] of Object.entries(data)) {
            const increment = (value as { increment?: number } | null)?.increment
            ;(row as unknown as Record<string, unknown>)[key] =
              typeof increment === 'number' ? (row as unknown as Record<string, number>)[key] + increment : value
          }
        }
        return { count: rows.length }
      },
    )
    client.attendanceCodeException.findMany.mockImplementation(async (args?: { where?: Where }) =>
      world.exceptions
        .filter((e) => {
          const where = args?.where
          if (!where) return true
          if (where.kind && e.kind !== where.kind) return false
          const empCode = where.empCode as string | { in: string[] } | undefined
          if (typeof empCode === 'string') return e.empCode === empCode
          if (empCode?.in) return empCode.in.includes(e.empCode)
          return true
        })
        .map((e) => ({ ...e })),
    )
    client.attendanceCodeException.findUnique.mockImplementation(async ({ where }: { where: { empCode: string } }) => {
      const found = world.exceptions.find((e) => e.empCode === where.empCode)
      return found ? { ...found } : null
    })
    client.attendanceCodeException.upsert.mockImplementation(
      async ({ where, create, update }: { where: { empCode: string }; create: Partial<Exception>; update: Partial<Exception> }) => {
        const found = world.exceptions.find((e) => e.empCode === where.empCode)
        if (found) {
          Object.assign(found, update)
          return { ...found }
        }
        const row = { id: `exception-${world.exceptions.length + 1}`, ...create } as Exception
        world.exceptions.push(row)
        return { ...row }
      },
    )
    client.attendanceCodeException.delete.mockImplementation(async ({ where }: { where: { empCode: string } }) => {
      const found = world.exceptions.find((e) => e.empCode === where.empCode)
      if (!found) throw new Error(`No exception ${where.empCode}`)
      world.exceptions = world.exceptions.filter((e) => e !== found)
      return { ...found }
    })
    client.employee.findMany.mockImplementation(async () => world.employees.map((e) => ({ ...e })))
  }
  return world
}

/** Two punches (08:00 IN, 12:00 OUT) of one code on 5 Nov, in this week's upload unless told otherwise. */
const codePunches = (
  idPrefix: string,
  empCode: string,
  matchStatus: string,
  opts: { uploadId?: string; correctionId?: string | null; employeeId?: string | null; date?: string } = {},
): PunchRow[] =>
  dayPunches({
    idPrefix,
    employeeId: opts.employeeId ?? (matchStatus === 'MATCHED' ? 'emp-36' : null),
    empCode,
    date: opts.date ?? '2026-11-05',
    times: ['08:00', '12:00'],
    matchStatus,
    uploadId: opts.uploadId,
    correctionId: opts.correctionId,
  })

const worldOf = (partial: Partial<World> & { punches: PunchRow[] }): World =>
  installWorld({ exceptions: [], employees: [asha], ...partial })

const statusesOf = (world: World, empCode: string, uploadId = 'upload-1') =>
  world.punches.filter((p) => p.empCode === empCode && p.attendanceUploadId === uploadId && p.correctionId === null).map((p) => p.matchStatus)

type Fn = ReturnType<typeof vi.fn>
const order = (fn: Fn, index = 0): number => fn.mock.invocationCallOrder[index]

/** Nothing was written anywhere: no punch update, no exception write, no audit row, on either client. */
function expectNothingWritten() {
  for (const [label, client] of [['plain', db], ['tx', db.tx]] as const) {
    for (const method of ['update', 'updateMany', 'create', 'createMany', 'delete', 'deleteMany']) {
      expect(client.attendancePunch[method], `${label} attendancePunch.${method}`).not.toHaveBeenCalled()
    }
    expect(client.attendanceCodeException.upsert, `${label} attendanceCodeException.upsert`).not.toHaveBeenCalled()
    expect(client.attendanceCodeException.delete, `${label} attendanceCodeException.delete`).not.toHaveBeenCalled()
    expect(client.auditLog.create, `${label} auditLog.create`).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  resetDb(db)
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
})

// ─── ignoreScopeOf ────────────────────────────────────────────────────────────

describe('ignoreScopeOf', () => {
  it('is ALWAYS when the code has a saved IGNORE exception', () => {
    expect(ignoreScopeOf('0999', [{ empCode: '0999', kind: 'IGNORE', employeeId: null }])).toBe('ALWAYS')
  })

  it('is WEEK when the code has no exception at all', () => {
    expect(ignoreScopeOf('0999', [])).toBe('WEEK')
  })

  it('is WEEK when the code only has a MATCH exception (a match is not an ignore)', () => {
    expect(ignoreScopeOf('0999', [{ empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' }])).toBe('WEEK')
  })

  it('is WEEK when only another code is ignored for every week', () => {
    expect(ignoreScopeOf('0999', [{ empCode: '0555', kind: 'IGNORE', employeeId: null }])).toBe('WEEK')
  })
})

// ─── getEmployeeCheck: the scope of an ignored code ───────────────────────────

describe('getEmployeeCheck lists ignored codes with their scope', () => {
  it('derives ALWAYS from an IGNORE exception and WEEK from its absence, sorted by code', async () => {
    worldOf({
      punches: [
        ...codePunches('g1', '0555', 'IGNORED'),
        ...codePunches('g2', '0444', 'IGNORED'),
        ...codePunches('m1', '0036', 'MATCHED'),
      ],
      exceptions: [{ id: 'exception-1', empCode: '0555', kind: 'IGNORE', employeeId: null }],
    })

    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.ignoredCodes.map((c) => [c.empCode, c.scope, c.punchCount])).toEqual([
      ['0444', 'WEEK', 2],
      ['0555', 'ALWAYS', 2],
    ])
    expect(check.codes).toEqual([])
  })

  it('a MATCH exception does not make an ignored code an every-week ignore', async () => {
    worldOf({
      punches: codePunches('g1', '0555', 'IGNORED'),
      exceptions: [{ id: 'exception-1', empCode: '0555', kind: 'MATCH', employeeId: 'emp-36' }],
    })

    expect((await getEmployeeCheck(WEEK_ID)).ignoredCodes).toEqual([
      expect.objectContaining({ empCode: '0555', scope: 'WEEK' }),
    ])
  })

  it('a week-ignored code leaves the week complete; an open code beside it still blocks it', async () => {
    worldOf({ punches: [...codePunches('g1', '0444', 'IGNORED'), ...codePunches('m1', '0036', 'MATCHED')] })
    expect((await getEmployeeCheck(WEEK_ID)).complete).toBe(true)

    worldOf({
      punches: [...codePunches('g1', '0444', 'IGNORED'), ...codePunches('u1', '0999', 'UNKNOWN'), ...codePunches('m1', '0036', 'MATCHED')],
    })
    const check = await getEmployeeCheck(WEEK_ID)
    expect(check.complete).toBe(false)
    expect(check.codes.map((c) => c.empCode)).toEqual(['0999'])
  })
})

// ─── ignoreCode: this week only ───────────────────────────────────────────────

describe('ignoreCode with scope WEEK', () => {
  it('marks only this week\'s unresolved punches of the code IGNORED and saves no exception', async () => {
    const world = worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    const result = await ignoreCode(WEEK_ID, '0999', 'WEEK')

    expect(result).toEqual({ ignoredPunches: 2 })
    expect(statusesOf(world, '0999')).toEqual(['IGNORED', 'IGNORED'])
    expect(world.punches.every((p) => p.employeeId === null)).toBe(true)
    // No row is written for it, on either client.
    expect(world.exceptions).toEqual([])
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
    expect(db.tx.attendanceCodeException.delete).not.toHaveBeenCalled()
    expect(db.attendanceCodeException.upsert).not.toHaveBeenCalled()
  })

  it('writes the punches and the audit row in one transaction, never on the plain client', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await ignoreCode(WEEK_ID, '0999', 'WEEK')

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expect(db.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(auditRows(db)).toHaveLength(0)
    expect(auditRows(db.tx)).toHaveLength(1)
  })

  it('audits an UPDATE against the week (there is no exception row), with the scope, the kind and the count', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await ignoreCode(WEEK_ID, '0999', 'WEEK')

    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_CODE', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Code 0999 ignored for this week only',
      weekStart: '2026-11-05',
      empCode: '0999',
      kind: 'IGNORE',
      scope: 'WEEK',
      ignoredPunches: 2,
    })
  })

  it('ignores a duplicate code too (UNKNOWN and DUPLICATE are both unresolved)', async () => {
    const world = worldOf({ punches: codePunches('d1', '0007', 'DUPLICATE'), employees: [sevenA, sevenB] })

    await expect(ignoreCode(WEEK_ID, '0007', 'WEEK')).resolves.toEqual({ ignoredPunches: 2 })

    expect(statusesOf(world, '0007')).toEqual(['IGNORED', 'IGNORED'])
  })

  it('leaves other codes, matched punches, correction clones and other weeks\' punches of the same code alone', async () => {
    const world = worldOf({
      punches: [
        ...codePunches('u1', '0999', 'UNKNOWN'),
        ...codePunches('other', '0888', 'UNKNOWN'),
        ...codePunches('m1', '0036', 'MATCHED'),
        ...codePunches('clone', '0999', 'UNKNOWN', { correctionId: 'correction-1' }),
        ...codePunches('later', '0999', 'UNKNOWN', { uploadId: 'upload-2' }),
      ],
    })

    await ignoreCode(WEEK_ID, '0999', 'WEEK')

    expect(statusesOf(world, '0999')).toEqual(['IGNORED', 'IGNORED'])
    expect(statusesOf(world, '0888')).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(statusesOf(world, '0036')).toEqual(['MATCHED', 'MATCHED'])
    expect(world.punches.filter((p) => p.correctionId === 'correction-1').map((p) => p.matchStatus)).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(statusesOf(world, '0999', 'upload-2')).toEqual(['UNKNOWN', 'UNKNOWN'])
  })

  it('leaves a MATCH exception the code already has exactly as it is', async () => {
    const world = worldOf({
      punches: codePunches('u1', '0999', 'UNKNOWN'),
      exceptions: [{ id: 'exception-1', empCode: '0999', kind: 'MATCH', employeeId: 'emp-ghost' }],
    })

    await ignoreCode(WEEK_ID, '0999', 'WEEK')

    expect(world.exceptions).toEqual([{ id: 'exception-1', empCode: '0999', kind: 'MATCH', employeeId: 'emp-ghost' }])
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
  })

  it('shows up as a WEEK-scoped ignored code in the employee check, and the code is no longer to fix', async () => {
    worldOf({ punches: [...codePunches('u1', '0999', 'UNKNOWN'), ...codePunches('m1', '0036', 'MATCHED')] })

    await ignoreCode(WEEK_ID, '0999', 'WEEK')
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.codes).toEqual([])
    expect(check.ignoredCodes).toEqual([expect.objectContaining({ empCode: '0999', scope: 'WEEK', punchCount: 2 })])
    expect(check.complete).toBe(true)
  })
})

// ─── ignoreCode: every week ───────────────────────────────────────────────────

describe('ignoreCode with scope ALWAYS', () => {
  it('saves an IGNORE exception (no employee) and marks the punches IGNORED', async () => {
    const world = worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await expect(ignoreCode(WEEK_ID, '0999', 'ALWAYS')).resolves.toEqual({ ignoredPunches: 2 })

    expect(world.exceptions).toEqual([{ id: 'exception-1', empCode: '0999', kind: 'IGNORE', employeeId: null }])
    expect(statusesOf(world, '0999')).toEqual(['IGNORED', 'IGNORED'])
    expect(db.tx.attendanceCodeException.upsert).toHaveBeenCalledWith({
      where: { empCode: '0999' },
      create: { empCode: '0999', kind: 'IGNORE', employeeId: null },
      update: { kind: 'IGNORE', employeeId: null },
    })
  })

  it('audits a CREATE against the new exception, with scope ALWAYS', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await ignoreCode(WEEK_ID, '0999', 'ALWAYS')

    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'CREATE', entityType: 'ATTENDANCE_CODE', entityId: 'exception-1' })
    expect(audit.detailsJson).toMatchObject({ summary: 'Code 0999 ignored', empCode: '0999', kind: 'IGNORE', scope: 'ALWAYS', ignoredPunches: 2 })
  })

  it('replaces a saved MATCH with the IGNORE and audits an UPDATE', async () => {
    const world = worldOf({
      punches: codePunches('u1', '0999', 'UNKNOWN'),
      exceptions: [{ id: 'exception-7', empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' }],
    })

    await ignoreCode(WEEK_ID, '0999', 'ALWAYS')

    expect(world.exceptions).toEqual([{ id: 'exception-7', empCode: '0999', kind: 'IGNORE', employeeId: null }])
    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'UPDATE', entityId: 'exception-7' })
  })

  it('shows up as an ALWAYS-scoped ignored code', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await ignoreCode(WEEK_ID, '0999', 'ALWAYS')

    expect((await getEmployeeCheck(WEEK_ID)).ignoredCodes).toEqual([expect.objectContaining({ empCode: '0999', scope: 'ALWAYS' })])
  })
})

// ─── ignoreCode: refusals ─────────────────────────────────────────────────────

describe.each(['WEEK', 'ALWAYS'] as const)('ignoreCode (%s) refusals', (scope) => {
  const run = () => ignoreCode(WEEK_ID, '0999', scope)

  it.each([
    ['a code that is matched', () => codePunches('m1', '0999', 'MATCHED')],
    ['a code that is already ignored', () => codePunches('g1', '0999', 'IGNORED')],
    ['a code with no punches this week', () => codePunches('m1', '0036', 'MATCHED')],
    ['a code whose only unresolved punches belong to a correction clone', () => codePunches('c1', '0999', 'UNKNOWN', { correctionId: 'correction-1' })],
    ['a code whose unresolved punches are in another week', () => codePunches('x1', '0999', 'UNKNOWN', { uploadId: 'upload-2' })],
  ])('CODE_NOT_FOUND for %s: no transaction, nothing saved', async (_label, punches) => {
    worldOf({ punches: punches() })

    await expect(run()).rejects.toMatchObject({ code: 'CODE_NOT_FOUND', message: "That code doesn't need fixing in this week." })

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('CODE_NOT_FOUND when a pull or a match resolved the code between the first check and the lock', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    db.tx.attendancePunch.count.mockResolvedValue(0) // the locked read no longer sees it

    await expect(run()).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })

    expectNothingWritten()
  })

  it('WEEK_LOCKED for an approved week, before any transaction', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))

    await expect(run()).rejects.toMatchObject({
      code: 'WEEK_LOCKED',
      message: 'This week is approved. Reopen it to change codes or decisions.',
    })

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('WEEK_LOCKED when the week was approved after the first read, found on the locked row; nothing written', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') })

    await expect(run()).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

    expect(db.tx.attendancePunch.count).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('SYNC_IN_PROGRESS while a pull holds the week, on the first read and again on the locked row', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: freshLock() }))
    await expect(run()).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
    expect(db.$transaction).not.toHaveBeenCalled()

    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW' }))
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: freshLock() })
    await expect(run()).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })

    expectNothingWritten()
  })

  it('goes ahead when the pull lock is stale (older than the TTL)', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: staleLock() })

    await expect(run()).resolves.toEqual({ ignoredPunches: 2 })
  })

  it('WEEK_NOT_READY when the week row is gone by the time the lock is taken', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    mockLockedWeek(db.tx, null)

    await expect(run()).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expectNothingWritten()
  })

  it('WEEK_NOT_READY for a week that has no data at all', async () => {
    worldOf({ punches: [] })
    db.attendanceUpload.findFirst.mockResolvedValue(null)

    await expect(run()).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expectNothingWritten()
  })

  it('takes the week lock before reading the punches on the transaction client and before its first write', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })

    await run()

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['upload-1'])
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.count))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.updateMany))
  })

  it('writes no audit row when the transaction fails part way, and rethrows the error', async () => {
    worldOf({ punches: codePunches('u1', '0999', 'UNKNOWN') })
    db.tx.attendancePunch.updateMany.mockRejectedValue(new Error('deadlock'))

    await expect(run()).rejects.toThrow('deadlock')

    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

// ─── unignoreCode ─────────────────────────────────────────────────────────────

describe('unignoreCode: a code ignored for this week only', () => {
  it('puts the punches back to UNKNOWN when the code matches nobody, and changes no exception', async () => {
    const world = worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })

    const result = await unignoreCode(WEEK_ID, '0999')

    expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'UNKNOWN' } })
    expect(statusesOf(world, '0999')).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(world.punches.every((p) => p.employeeId === null)).toBe(true)
    expect(world.exceptions).toEqual([])
    expect(db.tx.attendanceCodeException.delete).not.toHaveBeenCalled()
    expect(db.tx.attendanceCodeException.upsert).not.toHaveBeenCalled()
  })

  it('matches the punches to the employee the code now resolves to by number (MATCHED, with the employee code)', async () => {
    const world = worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), employees: [asha, gita] })

    const result = await unignoreCode(WEEK_ID, '0999')

    expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'MATCHED', employeeCode: 'TPLGOAHLP999' } })
    expect(statusesOf(world, '0999')).toEqual(['MATCHED', 'MATCHED'])
    expect(world.punches.map((p) => p.employeeId)).toEqual(['emp-999', 'emp-999'])
  })

  it('appends the restored pair after the employee\'s own pairs on the same day and never re-pairs theirs', async () => {
    const world = worldOf({
      punches: [
        ...codePunches('own', '0999', 'MATCHED', { employeeId: 'emp-999' }), // emp-999 already has pair 0 on 5 Nov
        ...codePunches('g1', '0999', 'IGNORED'),
      ],
      employees: [asha, gita],
    })
    // Same code on both: tell the two groups apart by id.
    const own = world.punches.filter((p) => p.id.startsWith('own'))
    const restored = world.punches.filter((p) => p.id.startsWith('g1'))

    await unignoreCode(WEEK_ID, '0999')

    expect(own.map((p) => p.pairIndex)).toEqual([0, 0])
    expect(restored.map((p) => [p.matchStatus, p.employeeId, p.pairIndex])).toEqual([
      ['MATCHED', 'emp-999', 1],
      ['MATCHED', 'emp-999', 1],
    ])
  })

  it('puts the punches back to DUPLICATE when the code now matches two employees, linking nobody', async () => {
    const world = worldOf({ punches: codePunches('g1', '0007', 'IGNORED'), employees: [asha, sevenA, sevenB] })

    const result = await unignoreCode(WEEK_ID, '0007')

    expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'DUPLICATE' } })
    expect(statusesOf(world, '0007')).toEqual(['DUPLICATE', 'DUPLICATE'])
    expect(world.punches.every((p) => p.employeeId === null)).toBe(true)
  })

  it('applies a MATCH exception the code has (the exception is not deleted), even when the number matches nothing', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      employees: [asha],
      exceptions: [{ id: 'exception-3', empCode: '0999', kind: 'MATCH', employeeId: 'emp-36' }],
    })

    const result = await unignoreCode(WEEK_ID, '0999')

    expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'MATCHED', employeeCode: 'TPLGOAHLP036' } })
    expect(world.punches.map((p) => [p.matchStatus, p.employeeId])).toEqual([['MATCHED', 'emp-36'], ['MATCHED', 'emp-36']])
    expect(world.exceptions).toHaveLength(1)
    expect(db.tx.attendanceCodeException.delete).not.toHaveBeenCalled()
    // A MATCH exception is not an every-week ignore: the undo is the week-only one.
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ undoneScope: 'WEEK', result: 'MATCHED' })
  })

  it('audits an UPDATE against the week with the undone scope, the result and the restored count', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })

    await unignoreCode(WEEK_ID, '0999')

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(auditRows(db)).toHaveLength(0)
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_CODE', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Code 0999 no longer ignored (was ignored for this week only)',
      weekStart: '2026-11-05',
      empCode: '0999',
      kind: 'IGNORE',
      undoneScope: 'WEEK',
      restoredPunches: 2,
      result: 'UNKNOWN',
    })
    expect(audit.detailsJson).not.toHaveProperty('employeeId')
  })

  it('names the employee in the audit row when the code matched', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), employees: [asha, gita] })

    await unignoreCode(WEEK_ID, '0999')

    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ result: 'MATCHED', employeeId: 'emp-999', employeeCode: 'TPLGOAHLP999' })
  })
})

describe('unignoreCode: a code ignored for every week', () => {
  const ignoreException = (): Exception => ({ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null })

  it('deletes the IGNORE exception and puts the punches back to UNKNOWN', async () => {
    const world = worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), exceptions: [ignoreException()] })

    const result = await unignoreCode(WEEK_ID, '0999')

    expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'UNKNOWN' } })
    expect(world.exceptions).toEqual([])
    expect(db.tx.attendanceCodeException.delete).toHaveBeenCalledWith({ where: { empCode: '0999' } })
    expect(statusesOf(world, '0999')).toEqual(['UNKNOWN', 'UNKNOWN'])
  })

  it('then matches the punches by number when an employee now has that number, and the exception is still gone', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      exceptions: [ignoreException()],
      employees: [asha, gita],
    })

    const result = await unignoreCode(WEEK_ID, '0999')

    expect(result.outcome).toEqual({ status: 'MATCHED', employeeCode: 'TPLGOAHLP999' })
    expect(world.exceptions).toEqual([])
    expect(world.punches.map((p) => [p.matchStatus, p.employeeId])).toEqual([['MATCHED', 'emp-999'], ['MATCHED', 'emp-999']])
  })

  it('lands on DUPLICATE when two employees share the number', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0007', 'IGNORED'),
      exceptions: [{ id: 'exception-5', empCode: '0007', kind: 'IGNORE', employeeId: null }],
      employees: [sevenA, sevenB],
    })

    await expect(unignoreCode(WEEK_ID, '0007')).resolves.toEqual({ restoredPunches: 2, outcome: { status: 'DUPLICATE' } })
    expect(statusesOf(world, '0007')).toEqual(['DUPLICATE', 'DUPLICATE'])
  })

  it('audits a DELETE against the removed exception, with the undone scope', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), exceptions: [ignoreException()] })

    await unignoreCode(WEEK_ID, '0999')

    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'DELETE', entityType: 'ATTENDANCE_CODE', entityId: 'exception-5' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Code 0999 no longer ignored (was ignored for every week)',
      undoneScope: 'ALWAYS',
      restoredPunches: 2,
      result: 'UNKNOWN',
    })
  })
})

describe('unignoreCode: what it leaves alone', () => {
  it('restores only this week\'s live punches of the code: other codes, other weeks and correction clones stay as they were', async () => {
    const world = worldOf({
      punches: [
        ...codePunches('g1', '0999', 'IGNORED'),
        ...codePunches('other', '0555', 'IGNORED'),
        ...codePunches('later', '0999', 'IGNORED', { uploadId: 'upload-2' }),
        ...codePunches('clone', '0999', 'IGNORED', { correctionId: 'correction-1' }),
      ],
      exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })

    await unignoreCode(WEEK_ID, '0999')

    expect(statusesOf(world, '0999')).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(statusesOf(world, '0555')).toEqual(['IGNORED', 'IGNORED'])
    // Another week keeps its IGNORED punches: only a pull of that week asks about the code again.
    expect(statusesOf(world, '0999', 'upload-2')).toEqual(['IGNORED', 'IGNORED'])
    expect(world.punches.filter((p) => p.correctionId === 'correction-1').map((p) => p.matchStatus)).toEqual(['IGNORED', 'IGNORED'])
  })

  it('only the IGNORED punches move: matched or unresolved punches of the same code in the week are not touched', async () => {
    const world = worldOf({
      punches: [
        ...codePunches('g1', '0999', 'IGNORED'),
        ...dayPunches({ idPrefix: 'u9', employeeId: null, empCode: '0999', date: '2026-11-06', times: ['08:00', '12:00'], matchStatus: 'UNKNOWN' }),
      ],
    })

    await expect(unignoreCode(WEEK_ID, '0999')).resolves.toMatchObject({ restoredPunches: 2 })

    expect(world.punches.filter((p) => p.id.startsWith('u9')).map((p) => p.matchStatus)).toEqual(['UNKNOWN', 'UNKNOWN'])
  })

  it('shows the code under Codes to fix, no longer ignored, in the employee check afterwards', async () => {
    worldOf({ punches: [...codePunches('g1', '0999', 'IGNORED'), ...codePunches('m1', '0036', 'MATCHED')] })

    await unignoreCode(WEEK_ID, '0999')
    const check = await getEmployeeCheck(WEEK_ID)

    expect(check.ignoredCodes).toEqual([])
    expect(check.codes).toEqual([expect.objectContaining({ empCode: '0999', status: 'UNKNOWN', punchCount: 2 })])
    expect(check.complete).toBe(false)
  })
})

describe('unignoreCode refusals', () => {
  it.each([
    ['a code that is unresolved, not ignored', () => codePunches('u1', '0999', 'UNKNOWN')],
    ['a code that is matched', () => codePunches('m1', '0999', 'MATCHED')],
    ['a code with no punches this week', () => codePunches('m1', '0036', 'MATCHED')],
    ['a code ignored only in another week', () => codePunches('g1', '0999', 'IGNORED', { uploadId: 'upload-2' })],
    ['a code whose IGNORED punches belong to a correction clone', () => codePunches('g1', '0999', 'IGNORED', { correctionId: 'correction-1' })],
  ])('CODE_NOT_FOUND for %s: no transaction, nothing changed', async (_label, punches) => {
    worldOf({ punches: punches(), exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }] })

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND', message: "That code isn't ignored in this week." })

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('CODE_NOT_FOUND under the lock, with the exception NOT deleted, when a pull replaced the punches since the first check', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })
    db.tx.attendancePunch.count.mockResolvedValue(0)

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })

    expect(world.exceptions).toHaveLength(1)
    expectNothingWritten()
  })

  it('WEEK_LOCKED for an approved week, before any transaction', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({
      code: 'WEEK_LOCKED',
      message: 'This week is approved. Reopen it to change codes or decisions.',
    })

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('WEEK_LOCKED when the locked row is APPROVED although the first read said REVIEW; the exception survives', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') })

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

    expect(world.exceptions).toHaveLength(1)
    expect(db.tx.attendancePunch.count).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('SYNC_IN_PROGRESS while a pull holds the week, on the first read and again on the locked row', async () => {
    const world = worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: freshLock() }))
    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
    expect(db.$transaction).not.toHaveBeenCalled()

    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW' }))
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: freshLock() })
    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })

    expect(world.exceptions).toHaveLength(1)
    expectNothingWritten()
  })

  it('goes ahead when the pull lock is stale', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })
    mockLockedWeek(db.tx, { status: 'REVIEW', syncLockedAt: staleLock() })

    await expect(unignoreCode(WEEK_ID, '0999')).resolves.toMatchObject({ restoredPunches: 2 })
  })

  it('WEEK_NOT_READY when the week row is gone by the time the lock is taken, and for a week with no data', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })
    mockLockedWeek(db.tx, null)
    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    db.attendanceUpload.findFirst.mockResolvedValue(null)
    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expectNothingWritten()
  })

  it('takes the week lock before it reads, deletes the exception or writes a punch', async () => {
    worldOf({
      punches: codePunches('g1', '0999', 'IGNORED'),
      exceptions: [{ id: 'exception-5', empCode: '0999', kind: 'IGNORE', employeeId: null }],
    })

    await unignoreCode(WEEK_ID, '0999')

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['upload-1'])
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.count))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendanceCodeException.delete))
    expect(order(db.tx.attendanceCodeException.delete)).toBeLessThan(order(db.tx.attendancePunch.updateMany))
  })

  it('VALIDATION_ERROR and no punch written when the code is still ignored by an exception the delete did not remove', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })
    // The week-only branch saw no IGNORE exception, but the matching read does (an every-week ignore landed in between).
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.findMany.mockResolvedValue([{ empCode: '0999', kind: 'IGNORE', employeeId: null }])

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'That code was ignored again a moment ago. Try again.',
    })

    expect(db.tx.attendancePunch.updateMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('EMPLOYEE_NOT_FOUND when the employee was deleted between the matching read and the link (foreign key refusal)', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), employees: [asha, gita] })
    const real = db.tx.attendancePunch.updateMany.getMockImplementation() as (args: unknown) => Promise<unknown>
    db.tx.attendancePunch.updateMany.mockImplementation(async (args: { data: { employeeId?: string } }) => {
      if (args.data.employeeId) {
        throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' })
      }
      return real(args)
    })

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: 'That employee no longer exists.' })

    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('rethrows any other database error unchanged, with no audit row', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED') })
    db.tx.attendancePunch.updateMany.mockRejectedValue(new Error('deadlock'))

    await expect(unignoreCode(WEEK_ID, '0999')).rejects.toThrow('deadlock')

    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

// ─── rematchWeekCodes and week-ignored punches ────────────────────────────────

describe('rematchWeekCodes never reopens a code ignored for this week', () => {
  it('leaves IGNORED punches alone even when the code would now match an employee, and still matches an open code beside it', async () => {
    const newHire = makeEmployee({ id: 'emp-888', employeeId: 'TPLGOAHLP888', employeeName: 'New Hire' })
    const world = worldOf({
      punches: [...codePunches('g1', '0999', 'IGNORED'), ...codePunches('u1', '0888', 'UNKNOWN')],
      employees: [asha, gita, newHire],
    })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [{ empCode: '0888', employeeId: 'emp-888', employeeCode: 'TPLGOAHLP888' }], stillUnresolved: [] })
    expect(statusesOf(world, '0999')).toEqual(['IGNORED', 'IGNORED'])
    expect(world.punches.filter((p) => p.empCode === '0999').every((p) => p.employeeId === null)).toBe(true)
    expect(statusesOf(world, '0888')).toEqual(['MATCHED', 'MATCHED'])
  })

  it('reads only UNKNOWN and DUPLICATE punches, so an IGNORED one is never even looked at', async () => {
    worldOf({ punches: codePunches('g1', '0999', 'IGNORED'), employees: [asha, gita] })

    const result = await rematchWeekCodes(WEEK_ID)

    expect(result).toEqual({ matched: [], stillUnresolved: [] })
    expect(db.attendancePunch.findMany).toHaveBeenCalledWith({
      where: { attendanceUploadId: 'upload-1', correctionId: null, matchStatus: { in: ['UNKNOWN', 'DUPLICATE'] } },
      select: { empCode: true, matchStatus: true },
      distinct: ['empCode'],
    })
    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })
})
