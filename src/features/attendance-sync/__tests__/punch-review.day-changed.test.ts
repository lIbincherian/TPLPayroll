// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { punchSetSignature } from '@/features/attendance-sync/lib/review'
import { savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import { SYNC_IN_PROGRESS_MESSAGE, type LockedWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import {
  AttendanceSyncError,
  type ReviewMode,
  type SavePair,
  type StoredPunchRow,
} from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  baseSignatureOf,
  dayPunches,
  freezeClock,
  installPunchStore,
  lockedRow,
  makeEmployee,
  makePunch,
  makeRun,
  makeSession,
  makeUpload,
  mockLockedWeek,
  resetDb,
  serveEmployeeLookup,
  serveUpload,
  utc,
  type Db,
  type PunchStore,
} from './service-fixtures'

// Round 3, item 5: savePunchEdit builds its operations from a snapshot read before the week lock. Under
// the lock it re-reads the day and the employee's place in the grid; if the day changed (another save,
// a pull) it refuses with DAY_CHANGED instead of applying operations to rows that are no longer there.
// "Something committed while this save waited for the lock" is modelled by a side effect on the lock
// query itself: the store changes as the lock is granted, after the snapshot was read.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const DAY = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }
const DAY_CHANGED_MESSAGE =
  'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.'
const NOT_IN_REVIEW_MESSAGE = "That employee isn't in this week's review."

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

const pair = (pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair => ({ pairIndex, in: inn, out })

/** Asha's full day as the editor opened it, with the last OUT changed to `lastOut`. */
function ashaPairs(lastOut = '17:47', prefix = 'p'): SavePair[] {
  return [
    pair(0, { punchId: `${prefix}-0`, time: '07:40' }, { punchId: `${prefix}-1`, time: '13:04' }),
    pair(1, { punchId: `${prefix}-2`, time: '13:56' }, { punchId: `${prefix}-3`, time: lastOut }),
  ]
}

/** Save as an editor that opened the day just now: its `baseSignature` is the day as stored when this is called. */
function save(pairs: SavePair[], over: Partial<Parameters<typeof savePunchEdit>[0]> = {}) {
  const employeeId = over.employeeId ?? 'emp-36'
  const mode = over.mode ?? LIVE
  const baseSignature = baseSignatureOf(store, employeeId, DAY, mode.kind === 'CORRECTION' ? mode.correctionId : null)
  return savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: DAY, mode: LIVE, baseSignature, pairs, ...over })
}

function seed(rows: ReturnType<typeof dayPunches>, employees = [asha, ravi]) {
  store = installPunchStore(db, rows)
  db.employee.findMany.mockResolvedValue(employees)
  // savePunchEdit looks the employee up again inside its transaction.
  serveEmployeeLookup(db, employees)
}

/** Run `mutate` as the week lock is granted: the world changes after the snapshot, before the re-read. */
function committedWhileWaitingForLock(mutate: () => void, row: Partial<LockedWeekRow> = {}) {
  db.tx.$queryRaw.mockImplementationOnce(async () => {
    mutate()
    return [lockedRow(row)]
  })
}

/** The state of every punch, to prove a refused save left the store as the concurrent writer left it. */
const rowsNow = () => JSON.parse(JSON.stringify(store.rows))

function expectNothingWritten() {
  for (const client of [db, db.tx]) {
    expect(client.attendancePunch.create).not.toHaveBeenCalled()
    expect(client.attendancePunch.update).not.toHaveBeenCalled()
    expect(client.attendancePunch.delete).not.toHaveBeenCalled()
    expect(client.auditLog.create).not.toHaveBeenCalled()
    expect(client.payrollCorrectionSession.update).not.toHaveBeenCalled()
  }
  expect(auditRows(db)).toHaveLength(0)
  expect(auditRows(db.tx)).toHaveLength(0)
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  // Friday 13 Nov 2026, IST: the 5-11 Nov week has ended.
  freezeClock('2026-11-13T03:00:00Z')
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  seed(dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }))
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(fetchPunchData).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── punchSetSignature ────────────────────────────────────────────────────────

describe('punchSetSignature', () => {
  const row = (over: Partial<StoredPunchRow> = {}): StoredPunchRow => ({
    id: 'a',
    pairIndex: 0,
    position: 'IN',
    source: 'API',
    originalTime: '07:40',
    currentTime: '07:40',
    note: null,
    ...over,
  })
  const other = row({ id: 'b', position: 'OUT', originalTime: '13:04', currentTime: '13:04' })

  it('is a non-empty token for an empty set, so an empty day can be told from a missing one', () => {
    expect(punchSetSignature([])).not.toBe('')
    expect(punchSetSignature([])).not.toBe(punchSetSignature([row()]))
  })

  it('does not depend on the order of the rows', () => {
    const c = row({ id: 'c', pairIndex: 1, originalTime: '13:56', currentTime: '13:56' })

    expect(punchSetSignature([row(), other, c])).toBe(punchSetSignature([c, other, row()]))
    expect(punchSetSignature([row(), other, c])).toBe(punchSetSignature([other, c, row()]))
  })

  it('is stable for equal rows built separately', () => {
    expect(punchSetSignature([row()])).toBe(punchSetSignature([row()]))
  })

  it.each([
    ['id', { id: 'z' }],
    ['pairIndex', { pairIndex: 1 }],
    ['position', { position: 'OUT' }],
    ['source', { source: 'MANUAL' }],
    ['originalTime', { originalTime: '07:41' }],
    ['currentTime', { currentTime: '07:41' }],
    ['note', { note: 'came late' }],
  ] as Array<[string, Partial<StoredPunchRow>]>)('changes when only the %s of a row changes', (_field, change) => {
    expect(punchSetSignature([row(change), other])).not.toBe(punchSetSignature([row(), other]))
  })

  it('changes when a row is added or removed', () => {
    expect(punchSetSignature([row(), other])).not.toBe(punchSetSignature([row()]))
    expect(punchSetSignature([row()])).not.toBe(punchSetSignature([]))
  })

  it('separates a time that moved from one row to the other (the rows are not summed up)', () => {
    const a = [row({ currentTime: '08:00' }), other]
    const b = [row({ currentTime: '13:04' }), row({ id: 'b', position: 'OUT', originalTime: '13:04', currentTime: '08:00' })]

    expect(punchSetSignature(a)).not.toBe(punchSetSignature(b))
  })

  it('ignores updatedAt and mergedScansJson, which do not change what an edit is built against', () => {
    const plain = punchSetSignature([row()])
    const touched = row() as StoredPunchRow & { updatedAt: Date }
    touched.updatedAt = new Date('2030-01-01T00:00:00Z')

    expect(punchSetSignature([touched])).toBe(plain)
    expect(punchSetSignature([{ ...row(), mergedScansJson: [{ time: '07:40' }, { time: '07:41' }] }])).toBe(plain)
    expect(punchSetSignature([{ ...row(), mergedScansJson: null }])).toBe(plain)
  })

  it('tells a missing time or note from an empty one: null and the empty string differ', () => {
    expect(punchSetSignature([row({ note: null })])).not.toBe(punchSetSignature([row({ note: '' })]))
    expect(punchSetSignature([row({ currentTime: null })])).not.toBe(punchSetSignature([row({ currentTime: '' as never })]))
    expect(punchSetSignature([row({ originalTime: null })])).not.toBe(punchSetSignature([row({ originalTime: '' as never })]))
  })

  it('still tells a missing time from a present one (a cleared punch is a change)', () => {
    expect(punchSetSignature([row({ currentTime: null })])).not.toBe(punchSetSignature([row()]))
    expect(punchSetSignature([row({ originalTime: null })])).not.toBe(punchSetSignature([row()]))
    expect(punchSetSignature([row({ note: 'x' })])).not.toBe(punchSetSignature([row({ note: null })]))
  })
})

// ─── savePunchEdit: the day is re-read under the lock ─────────────────────────

describe('savePunchEdit refuses a day that changed while it waited for the week lock (DAY_CHANGED)', () => {
  const expectDayChanged = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error).toMatchObject({ code: 'DAY_CHANGED', message: DAY_CHANGED_MESSAGE })
    return error as AttendanceSyncError
  }

  it('another save added a punch to the day: DAY_CHANGED, and none of this save\'s operations ran', async () => {
    committedWhileWaitingForLock(() => {
      store.rows.push(makePunch({ id: 'late', source: 'MANUAL', pairIndex: 2, position: 'IN', originalTime: null, currentTime: '19:00' }))
    })

    await expectDayChanged(save(ashaPairs('18:00')))

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNothingWritten()
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47') // this save's edit was not applied
    expect(rowsNow().map((r: { id: string }) => r.id)).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'late'])
  })

  it('another save changed a time of the day: DAY_CHANGED, nothing written', async () => {
    committedWhileWaitingForLock(() => {
      store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'
    })

    await expectDayChanged(save(ashaPairs('18:00')))

    expectNothingWritten()
    expect(store.rows.find((r) => r.id === 'p-1')!.currentTime).toBe('13:10') // the other writer's edit survives
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
  })

  it('another save changed only a note: DAY_CHANGED', async () => {
    committedWhileWaitingForLock(() => {
      store.rows.find((r) => r.id === 'p-0')!.note = 'forgot to punch'
    })

    await expectDayChanged(save(ashaPairs('18:00')))
    expectNothingWritten()
  })

  it('another save deleted a hand-entered punch of the day: DAY_CHANGED', async () => {
    seed([
      ...dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }),
      makePunch({ id: 'm-0', source: 'MANUAL', pairIndex: 2, position: 'IN', originalTime: null, currentTime: '19:00' }),
      makePunch({ id: 'm-1', source: 'MANUAL', pairIndex: 2, position: 'OUT', originalTime: null, currentTime: '20:00' }),
    ])
    committedWhileWaitingForLock(() => {
      store.rows = store.rows.filter((r) => !r.id.startsWith('m-'))
    })

    await expectDayChanged(
      save([...ashaPairs('18:00'), pair(2, { punchId: 'm-0', time: '19:00' }, { punchId: 'm-1', time: '20:30' })]),
    )

    expectNothingWritten()
  })

  it('a pull replaced the punches with new rows of identical times: DAY_CHANGED, not a failed update of a dead id', async () => {
    committedWhileWaitingForLock(() => {
      // What a pull does: the same scans come back as brand-new rows.
      store.rows = store.rows.map((r) => ({ ...r, id: r.id.replace('p-', 'q-') }))
    })

    // Without the re-read the first update would target p-3, which no longer exists (the store's update
    // throws, standing in for Prisma's P2025 "record to update not found").
    const error = await expectDayChanged(save(ashaPairs('18:00')))

    expect(error.message).not.toMatch(/No punch/)
    expectNothingWritten()
    expect(store.rows.map((r) => r.id)).toEqual(['q-0', 'q-1', 'q-2', 'q-3'])
  })

  it('a pull removed the day\'s punches altogether: DAY_CHANGED', async () => {
    committedWhileWaitingForLock(() => {
      store.rows = []
    })

    await expectDayChanged(save(ashaPairs('18:00')))
    expectNothingWritten()
  })

  it('two saves of the same empty day: the second finds the first one\'s punches and adds none (no duplicate MANUAL punches)', async () => {
    const ravisDay = () => store.day('emp-5', DAY)
    const addPair = [pair(0, { time: '08:00' }, { time: '16:00' })]
    expect(ravisDay()).toHaveLength(0)
    // The first save committed its pair while the second one waited for the lock.
    committedWhileWaitingForLock(() => {
      store.rows.push(
        makePunch({ id: 'first-in', employeeId: 'emp-5', empCode: '0005', source: 'MANUAL', pairIndex: 0, position: 'IN', originalTime: null, currentTime: '08:00' }),
        makePunch({ id: 'first-out', employeeId: 'emp-5', empCode: '0005', source: 'MANUAL', pairIndex: 0, position: 'OUT', originalTime: null, currentTime: '16:00' }),
      )
    })

    await expectDayChanged(save(addPair, { employeeId: 'emp-5' }))

    expectNothingWritten()
    expect(ravisDay().map((r) => r.id)).toEqual(['first-in', 'first-out'])
    expect(ravisDay().filter((r) => r.position === 'IN')).toHaveLength(1)
    expect(ravisDay().filter((r) => r.position === 'OUT')).toHaveLength(1)
  })

  it('after DAY_CHANGED the user reopens the day and saves again: the retry works and adds no duplicate', async () => {
    committedWhileWaitingForLock(() => {
      store.rows.push(
        makePunch({ id: 'first-in', employeeId: 'emp-5', empCode: '0005', source: 'MANUAL', pairIndex: 0, position: 'IN', originalTime: null, currentTime: '08:00' }),
        makePunch({ id: 'first-out', employeeId: 'emp-5', empCode: '0005', source: 'MANUAL', pairIndex: 0, position: 'OUT', originalTime: null, currentTime: '16:00' }),
      )
    })
    await expectDayChanged(save([pair(0, { time: '08:00' }, { time: '16:00' })], { employeeId: 'emp-5' }))

    // Reopened: the editor now holds the stored punches' ids; the user changes the OUT.
    await expect(
      save([pair(0, { punchId: 'first-in', time: '08:00' }, { punchId: 'first-out', time: '17:00' })], { employeeId: 'emp-5' }),
    ).resolves.toMatchObject({ day: { date: DAY } })

    expect(store.day('emp-5', DAY)).toHaveLength(2)
    expect(store.rows.find((r) => r.id === 'first-out')!.currentTime).toBe('17:00')
    expect(db.tx.attendancePunch.create).not.toHaveBeenCalled()
  })

  it('does not write the correction session pointer when the day changed (a refused save must not clear a draft)', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    const session = makeSession({ draftRevisionId: 'draft-1' })
    db.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    seed(dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: DAY, times: FULL_DAY, correctionId: 'session-1' }))
    committedWhileWaitingForLock(() => {
      store.rows.find((r) => r.id === 'c-3')!.currentTime = '17:50'
    })

    await expectDayChanged(save(ashaPairs('18:00', 'c'), { mode: CORRECTION }))

    expectNothingWritten()
  })
})

// ─── savePunchEdit: unrelated and cosmetic changes do not refuse the save ─────

describe('savePunchEdit still saves when the concurrent change is not to this day', () => {
  it('saves when the day is untouched (the signatures match)', async () => {
    const result = await save(ashaPairs('18:00'))

    expect(result.day).toMatchObject({ date: DAY, isEdited: true })
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ originalTime: '17:47', currentTime: '18:00' })
    expect(auditRows(db.tx)).toHaveLength(1)
    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'UPDATE', entityId: 'p-3' })
  })

  it.each([
    ['another employee\'s punches on the same date', () => store.rows.push(...dayPunches({ idPrefix: 'r', employeeId: 'emp-5', empCode: '0005', date: DAY, times: ['08:00', '12:00'] }))],
    ['the same employee\'s punches on another date', () => store.rows.push(...dayPunches({ idPrefix: 'n', employeeId: 'emp-36', date: '2026-11-06', times: ['08:00', '12:00'] }))],
    ['a punch of the same employee-day in the correction set', () => store.rows.push(makePunch({ id: 'cl-0', correctionId: 'session-9', pairIndex: 0 }))],
  ])('%s', async (_label, mutate) => {
    committedWhileWaitingForLock(mutate)

    await expect(save(ashaPairs('18:00'))).resolves.toMatchObject({ day: { date: DAY } })

    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00')
  })

  it('saves when only updatedAt or mergedScansJson changed in the meantime', async () => {
    committedWhileWaitingForLock(() => {
      for (const r of store.rows) {
        r.updatedAt = new Date('2026-11-13T02:59:00Z')
        r.mergedScansJson = [{ time: r.currentTime }]
      }
    })

    await expect(save(ashaPairs('18:00'))).resolves.toMatchObject({ day: { date: DAY } })
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00')
  })
})

// ─── savePunchEdit: where the re-read sits ────────────────────────────────────

describe('savePunchEdit: the re-read runs on the transaction client, after the lock and before any write', () => {
  it('lock < day re-read < employee lookup < decision lookup < first write < audit', async () => {
    await save(ashaPairs('18:00'))

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledTimes(1) // the re-read; the pre-read used the plain client
    const lock = order(db.tx.$queryRaw)
    const reread = order(db.tx.attendancePunch.findMany)
    const employee = order(db.tx.employee.findUnique)
    const decision = order(db.tx.attendanceEmployeeDecision.findUnique)
    const write = order(db.tx.attendancePunch.update)
    const audit = order(db.tx.auditLog.create)
    expect(lock).toBeLessThan(reread)
    expect(reread).toBeLessThan(employee)
    expect(employee).toBeLessThan(decision)
    expect(decision).toBeLessThan(write)
    expect(write).toBeLessThan(audit)
  })

  it('reads exactly this employee-day of this set, and the employee and decision rows of this week', async () => {
    await save(ashaPairs('18:00'))

    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-36', punchDate: utc(DAY) },
      }),
    )
    expect(db.tx.employee.findUnique).toHaveBeenCalledWith({
      where: { id: 'emp-36' },
      select: { id: true, employeeId: true, employeeName: true, isActive: true, dateOfResignation: true },
    })
    expect(db.tx.attendanceEmployeeDecision.findUnique).toHaveBeenCalledWith({
      where: { attendanceUploadId_employeeId: { attendanceUploadId: 'upload-1', employeeId: 'emp-36' } },
      select: { decision: true },
    })
    // LIVE never looks at approved records.
    expect(db.tx.attendanceRecord.count).not.toHaveBeenCalled()
  })

  it('the pre-read stays on the plain client (it is the snapshot the operations are built from)', async () => {
    await save(ashaPairs('18:00'))

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-36', punchDate: utc(DAY) },
      }),
    )
    expect(order(db.attendancePunch.findMany)).toBeLessThan(order(db.tx.$queryRaw))
  })

  it('a save that changes nothing opens no transaction and takes no lock, so it cannot report DAY_CHANGED', async () => {
    committedWhileWaitingForLock(() => {
      store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'
    })

    await expect(save(ashaPairs('17:47'))).resolves.toMatchObject({ day: { date: DAY } })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('a save that fails validation opens no transaction and takes no lock', async () => {
    const error = await save([pair(0, { punchId: 'p-0', time: '17:00' }, { punchId: 'p-1', time: '08:00' })]).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
  })
})

// ─── savePunchEdit: the status checks still come first ────────────────────────

describe('savePunchEdit: a locked or syncing week wins over DAY_CHANGED', () => {
  const dayChanges = () => {
    store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'
  }

  it('WEEK_LOCKED when the week was approved while the save waited (and the day changed too)', async () => {
    committedWhileWaitingForLock(dayChanges, { status: 'APPROVED', approvedAt: new Date('2026-11-13T02:59:00Z') })

    await expect(save(ashaPairs('18:00'))).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('SYNC_IN_PROGRESS, with the shared message, when a pull took the week (and the day changed too)', async () => {
    committedWhileWaitingForLock(dayChanges, { syncLockedAt: new Date(Date.now() - 60_000) })

    const error = await save(ashaPairs('18:00')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('SYNC_IN_PROGRESS is the shared message verbatim', () => {
    expect(SYNC_IN_PROGRESS_MESSAGE).toBe('A pull is running for this week. Wait for it to finish, then try again.')
  })

  it('a stale pull lock does not block, so the re-read runs and the day change is what is reported', async () => {
    committedWhileWaitingForLock(dayChanges, { syncLockedAt: new Date(Date.now() - 6 * 60 * 1000) })

    await expect(save(ashaPairs('18:00'))).rejects.toMatchObject({ code: 'DAY_CHANGED' })
    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledTimes(1)
  })

  it('WEEK_NOT_READY when the week row is gone, before any re-read', async () => {
    mockLockedWeek(db.tx, null)

    await expect(save(ashaPairs('18:00'))).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('CORRECTION_NOT_ACTIVE when the correction ended while the save waited (and the day changed too)', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession({ status: 'APPLIED' }))
    seed(dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: DAY, times: FULL_DAY, correctionId: 'session-1' }))
    committedWhileWaitingForLock(() => {
      store.rows.find((r) => r.id === 'c-1')!.currentTime = '13:10'
    })

    await expect(save(ashaPairs('18:00', 'c'), { mode: CORRECTION })).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expectNothingWritten()
  })
})

// ─── savePunchEdit: the employee's place in the grid is re-checked under the lock ──

describe('savePunchEdit: the employee must still be in the review under the lock (EMPLOYEE_NOT_FOUND)', () => {
  const expectNotInReview = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AttendanceSyncError)
    expect(error).toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW_MESSAGE })
  }
  const deactivatedAsha = { ...asha, isActive: false }

  describe('live week', () => {
    it('deactivated with a REJECTED decision since the snapshot: refused, nothing written', async () => {
      // The snapshot (plain client) still shows an active Asha; the transaction sees what happened since.
      db.tx.employee.findUnique.mockResolvedValue(deactivatedAsha)
      db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue({ decision: 'REJECTED' })

      await expectNotInReview(save(ashaPairs('18:00')))

      expect(db.tx.attendancePunch.findMany).toHaveBeenCalledTimes(1) // the day check passed, then the grid check refused
      expectNothingWritten()
      expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
    })

    it('deactivated with no decision yet: refused, nothing written', async () => {
      db.tx.employee.findUnique.mockResolvedValue(deactivatedAsha)

      await expectNotInReview(save(ashaPairs('18:00')))
      expectNothingWritten()
    })

    it('resigned before the week with no decision: refused, nothing written', async () => {
      db.tx.employee.findUnique.mockResolvedValue({ ...asha, dateOfResignation: new Date('2026-11-01T00:00:00Z') })

      await expectNotInReview(save(ashaPairs('18:00')))
      expectNothingWritten()
    })

    it('the employee row is gone: refused, nothing written', async () => {
      db.tx.employee.findUnique.mockResolvedValue(null)

      await expectNotInReview(save(ashaPairs('18:00')))
      expectNothingWritten()
    })

    it('deactivated but APPROVED by decision: still in the review, the save goes through', async () => {
      db.tx.employee.findUnique.mockResolvedValue(deactivatedAsha)
      db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue({ decision: 'APPROVED' })

      await expect(save(ashaPairs('18:00'))).resolves.toMatchObject({ day: { date: DAY } })

      expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00')
    })

    it('an active employee stays in the review: the save goes through', async () => {
      await expect(save(ashaPairs('18:00'))).resolves.toMatchObject({ day: { date: DAY } })
      expect(db.tx.attendancePunch.update).toHaveBeenCalledTimes(1)
    })

    it('the refusal happens before the first write, after the day re-read and the lock', async () => {
      db.tx.employee.findUnique.mockResolvedValue(null)

      await expectNotInReview(save(ashaPairs('18:00')))

      expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.findMany))
      expect(order(db.tx.attendancePunch.findMany)).toBeLessThan(order(db.tx.employee.findUnique))
      expect(db.tx.attendancePunch.update).not.toHaveBeenCalled()
    })
  })

  describe('correction', () => {
    const cloneRows = () => dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: DAY, times: FULL_DAY, correctionId: 'session-1' })
    const saveCorrection = (lastOut = '18:00') => save(ashaPairs(lastOut, 'c'), { mode: CORRECTION })

    beforeEach(() => {
      serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
      db.payrollRun.findFirst.mockResolvedValue(makeRun())
      db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
      db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
      seed(cloneRows(), [deactivatedAsha, ravi])
      // The snapshot let an inactive employee in because approved records exist; so does the review after the save.
      db.attendanceRecord.count.mockResolvedValue(7)
      db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-36' }])
    })

    it('an inactive employee with approved records stays in the grid: the save goes through and the draft pointer is cleared', async () => {
      db.tx.attendanceRecord.count.mockResolvedValue(7)

      await expect(saveCorrection()).resolves.toMatchObject({ day: { date: DAY } })

      expect(db.tx.attendanceRecord.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', employeeId: 'emp-36' } })
      expect(store.rows.find((r) => r.id === 'c-3')!.currentTime).toBe('18:00')
      expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledWith({ where: { id: 'session-1' }, data: { draftRevisionId: null } })
      expect(order(db.tx.attendanceRecord.count)).toBeGreaterThan(order(db.tx.attendancePunch.findMany))
      expect(order(db.tx.attendanceRecord.count)).toBeLessThan(order(db.tx.attendancePunch.update))
    })

    it('the same employee without approved records under the lock: refused, nothing written, draft pointer untouched', async () => {
      db.tx.attendanceRecord.count.mockResolvedValue(0)

      await expectNotInReview(saveCorrection())

      expectNothingWritten()
      expect(store.rows.find((r) => r.id === 'c-3')!.currentTime).toBe('17:47')
    })

    it('an active employee needs no records: the save goes through even when the records count is 0', async () => {
      db.employee.findMany.mockResolvedValue([asha, ravi])
      serveEmployeeLookup(db, [asha, ravi])
      db.tx.attendanceRecord.count.mockResolvedValue(0)

      await expect(saveCorrection()).resolves.toMatchObject({ day: { date: DAY } })
      expect(db.tx.attendanceRecord.count).toHaveBeenCalledTimes(1)
    })

    it('the employee row is gone under the lock: refused, nothing written', async () => {
      db.tx.employee.findUnique.mockResolvedValue(null)
      db.tx.attendanceRecord.count.mockResolvedValue(7)

      await expectNotInReview(saveCorrection())
      expectNothingWritten()
    })
  })
})
