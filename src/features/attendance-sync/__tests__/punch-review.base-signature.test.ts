// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { punchSetSignature } from '@/features/attendance-sync/lib/day-signature'
import { DAY_CHANGED_MESSAGE, savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import {
  AttendanceSyncError,
  type ReviewMode,
  type SavePair,
  type SavePunchEditInput,
} from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  baseSignatureOf,
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makePunch,
  makeRun,
  makeSession,
  makeUpload,
  resetDb,
  serveEmployeeLookup,
  serveUpload,
  type Db,
  type PunchRow,
  type PunchStore,
} from './service-fixtures'

// Round 4, item 1: every save carries `baseSignature`, the version of the day its editor was opened on.
// A tab opened before another tab's save (or a pull) is refused with DAY_CHANGED, before the transaction,
// and again under the lock. These tests build "the other tab's save" by changing the store between the
// moment the editor's base was taken and the moment the save is sent.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const DAY = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

const pair = (pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair => ({ pairIndex, in: inn, out })

/** The four punches of Asha's full day as the editor holds them, last OUT changed to `lastOut`. */
function ashaPairs(lastOut = '17:47', prefix = 'p'): SavePair[] {
  return [
    pair(0, { punchId: `${prefix}-0`, time: '07:40' }, { punchId: `${prefix}-1`, time: '13:04' }),
    pair(1, { punchId: `${prefix}-2`, time: '13:56' }, { punchId: `${prefix}-3`, time: lastOut }),
  ]
}

const send = (over: Partial<SavePunchEditInput> & Pick<SavePunchEditInput, 'baseSignature' | 'pairs'>) =>
  savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: DAY, mode: LIVE, ...over })

/** What the editor of the live day holds when it is opened right now. */
const liveBase = (employeeId = 'emp-36') => baseSignatureOf(store, employeeId, DAY, null)
const cloneBase = () => baseSignatureOf(store, 'emp-36', DAY, 'session-1')

/** The other tab saved a hand-entered pair 3 while this tab stayed open on the old day. */
function otherTabAddsManualPair(correctionId: string | null = null) {
  store.rows.push(
    makePunch({ id: 'm-in', correctionId, source: 'MANUAL', pairIndex: 2, position: 'IN', originalTime: null, currentTime: '18:00' }),
    makePunch({ id: 'm-out', correctionId, source: 'MANUAL', pairIndex: 2, position: 'OUT', originalTime: null, currentTime: '19:00' }),
  )
}

function seed(rows: PunchRow[], employees = [asha, ravi]) {
  store = installPunchStore(db, rows)
  db.employee.findMany.mockResolvedValue(employees)
  serveEmployeeLookup(db, employees)
}

function expectNothingWritten() {
  for (const client of [db, db.tx]) {
    expect(client.attendancePunch.create).not.toHaveBeenCalled()
    expect(client.attendancePunch.update).not.toHaveBeenCalled()
    expect(client.attendancePunch.delete).not.toHaveBeenCalled()
    expect(client.auditLog.create).not.toHaveBeenCalled()
    expect(client.payrollCorrectionSession.update).not.toHaveBeenCalled()
  }
}

async function dayChanged(promise: Promise<unknown>): Promise<AttendanceSyncError> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AttendanceSyncError)
  expect(error).toMatchObject({ code: 'DAY_CHANGED', message: DAY_CHANGED_MESSAGE })
  return error as AttendanceSyncError
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock('2026-11-13T03:00:00Z') // the 5-11 Nov week has ended
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  seed(dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }))
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(fetchPunchData).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

it('the refusal message is the text the editor was written against', () => {
  expect(DAY_CHANGED_MESSAGE).toBe(
    'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.',
  )
})

// ─── Live week ────────────────────────────────────────────────────────────────

describe('savePunchEdit (live): a matching base saves', () => {
  it('saves, and the result carries the signature of the rows as stored after the write', async () => {
    const base = liveBase()

    const result = await send({ baseSignature: base, pairs: ashaPairs('18:00') })

    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ originalTime: '17:47', currentTime: '18:00' })
    expect(result.day.signature).toBe(punchSetSignature(store.day('emp-36', DAY)))
    expect(result.day.signature).not.toBe(base) // the save moved the day on
    expect(auditRows(db.tx)).toHaveLength(1)
  })

  it('the signature of the result is the next base: a second save with it works, with the old base it is refused', async () => {
    const base = liveBase()
    const first = await send({ baseSignature: base, pairs: ashaPairs('18:00') })

    await expect(send({ baseSignature: first.day.signature, pairs: ashaPairs('18:30') })).resolves.toMatchObject({
      day: { isEdited: true },
    })
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:30')

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('19:00') })) // a stale editor repeating its first base
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:30')
  })

  it('a save that changes nothing returns the day under the same signature', async () => {
    const base = liveBase()

    const result = await send({ baseSignature: base, pairs: ashaPairs('17:47') })

    expect(result.day.signature).toBe(base)
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('adding a hand-entered pair on an empty day works with the empty-day signature', async () => {
    const base = liveBase('emp-5')
    expect(base).toMatch(/^0\./)

    const result = await send({ employeeId: 'emp-5', baseSignature: base, pairs: [pair(0, { time: '08:00' }, { time: '16:00' })] })

    expect(store.day('emp-5', DAY)).toHaveLength(2)
    expect(result.day.signature).toBe(punchSetSignature(store.day('emp-5', DAY)))
    expect(result.day.signature).toMatch(/^2\./)
  })
})

describe('savePunchEdit (live): a base from before another tab changed the day is refused (DAY_CHANGED)', () => {
  it('the other tab added a MANUAL pair: refused before the transaction, the pair survives, nothing audited', async () => {
    const base = liveBase() // tab B opened the day here
    otherTabAddsManualPair() // tab A saved a third pair afterwards
    const before = structuredClone(store.rows)

    // Tab B knows only the API pairs. Applied, its save would delete the two punches it never saw.
    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('17:30') }))

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
    expect(auditRows(db.tx)).toHaveLength(0)
    expect(auditRows(db)).toHaveLength(0)
    expect(store.rows).toEqual(before)
    expect(store.rows.filter((r) => r.source === 'MANUAL').map((r) => r.id)).toEqual(['m-in', 'm-out'])
  })

  it('the other tab changed a time: refused, and the other tab\'s time is what is stored', async () => {
    const base = liveBase()
    store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expect(store.rows.find((r) => r.id === 'p-1')!.currentTime).toBe('13:10')
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('the other tab typed into the same empty slot first: refused (it used to overwrite silently)', async () => {
    const base = liveBase('emp-5')
    store.rows.push(
      makePunch({ id: 'first-in', employeeId: 'emp-5', empCode: '0005', source: 'MANUAL', pairIndex: 0, position: 'IN', originalTime: null, currentTime: '08:00' }),
    )

    await dayChanged(send({ employeeId: 'emp-5', baseSignature: base, pairs: [pair(0, { time: '09:30' }, { time: null })] }))

    expect(store.day('emp-5', DAY)).toHaveLength(1)
    expect(store.day('emp-5', DAY)[0].currentTime).toBe('08:00')
    expect(db.attendancePunch.create).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.create).not.toHaveBeenCalled()
  })

  it('a pull replaced every row with new ids and identical times: refused', async () => {
    const base = liveBase()
    store.rows = store.rows.map((r) => ({ ...r, id: r.id.replace('p-', 'q-') }))

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expectNothingWritten()
    expect(store.rows.map((r) => r.id)).toEqual(['q-0', 'q-1', 'q-2', 'q-3'])
  })

  it('a pull removed the day\'s punches altogether: refused', async () => {
    const base = liveBase()
    store.rows = []

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expectNothingWritten()
  })

  it('even a save that would change nothing is refused on a stale base', async () => {
    const base = liveBase()
    otherTabAddsManualPair()

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('17:47') }))

    expect(store.rows).toHaveLength(6)
    expectNothingWritten()
  })

  it('a stale punch id with a stale base is DAY_CHANGED, not the "no longer exists" validation error', async () => {
    const base = liveBase()
    store.rows = store.rows.map((r) => ({ ...r, id: r.id.replace('p-', 'q-') })) // the ids the editor holds are gone

    const error = await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expect(error.code).not.toBe('VALIDATION_ERROR')
    expect(error.message).not.toMatch(/no longer exists/i)
  })

  it('an unknown punch id sent with the CURRENT base is still the validation error (the base only guards a stale day)', async () => {
    const error = await send({
      baseSignature: liveBase(),
      pairs: [pair(0, { punchId: 'p-0', time: '08:00' }, { punchId: 'someone-elses', time: '12:00' })],
    }).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect((error as AttendanceSyncError).message).toMatch(/no longer exists/i)
  })

  it.each([
    ['an empty string', ''],
    ['a made-up token', '4.deadbeef'],
    ['the empty-day token on a day with punches', punchSetSignature([])],
    ['a token with the right count and a wrong hash', '4.0'],
  ])('%s as the base: refused, nothing written', async (_label, baseSignature) => {
    await dayChanged(send({ baseSignature, pairs: ashaPairs('18:00') }))

    expectNothingWritten()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('the signature of another employee\'s day, or of another date, is not this day\'s base', async () => {
    store.rows.push(...dayPunches({ idPrefix: 'r', employeeId: 'emp-5', empCode: '0005', date: DAY, times: ['08:00', '12:00'] }))
    store.rows.push(...dayPunches({ idPrefix: 'n', employeeId: 'emp-36', date: '2026-11-06', times: ['08:00', '12:00'] }))

    await dayChanged(send({ baseSignature: baseSignatureOf(store, 'emp-5', DAY), pairs: ashaPairs('18:00') }))
    await dayChanged(send({ baseSignature: baseSignatureOf(store, 'emp-36', '2026-11-06'), pairs: ashaPairs('18:00') }))

    expectNothingWritten()
  })

  it('a stale base wins over a validation error in the same request (the day is checked before the pairs)', async () => {
    const base = liveBase()
    store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'

    await dayChanged(send({ baseSignature: base, pairs: [pair(0, { punchId: 'p-0', time: '17:00' }, { punchId: 'p-1', time: '08:00' })] }))
  })
})

describe('savePunchEdit (live): the checks that come before the base keep their answers', () => {
  it('WEEK_LOCKED wins over DAY_CHANGED', async () => {
    const base = liveBase()
    store.rows.find((r) => r.id === 'p-1')!.currentTime = '13:10'
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))

    await expect(send({ baseSignature: base, pairs: ashaPairs('18:00') })).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
  })

  it('EMPLOYEE_NOT_FOUND wins over DAY_CHANGED', async () => {
    await expect(send({ employeeId: 'nobody', baseSignature: 'stale', pairs: [] })).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    })
  })

  it('a date outside the week is the validation error, not DAY_CHANGED', async () => {
    await expect(send({ date: '2026-11-12', baseSignature: 'stale', pairs: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('savePunchEdit (live): the base is compared again under the week lock', () => {
  it('the day matched the base before the lock and moved by the time the lock was granted: refused, nothing written', async () => {
    const base = liveBase()
    db.tx.$queryRaw.mockImplementationOnce(async () => {
      otherTabAddsManualPair() // committed while this save waited for the lock
      return [{ id: 'upload-1', source: 'ETIMEOFFICE', status: 'REVIEW', syncLockedAt: null, approvedAt: null, payrollWeekStartDate: new Date('2026-11-05T00:00:00Z') }]
    })

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expect(db.$transaction).toHaveBeenCalledTimes(1) // it got past the first check, which is why the second one matters
    expectNothingWritten()
    expect(store.rows).toHaveLength(6)
  })

  it('compares the locked re-read to the base the editor sent, not to the snapshot', async () => {
    const base = liveBase()
    db.tx.attendancePunch.findMany.mockResolvedValueOnce(store.day('emp-36', DAY).map((r, i) => (i === 3 ? { ...r, currentTime: '17:48' } : { ...r })))

    await dayChanged(send({ baseSignature: base, pairs: ashaPairs('18:00') }))

    expectNothingWritten()
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
  })
})

// ─── Correction ───────────────────────────────────────────────────────────────

describe('savePunchEdit (correction): the base is the signature of the clone set', () => {
  const cloneRows = () => dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: DAY, times: FULL_DAY, correctionId: 'session-1' })
  const sendCorrection = (baseSignature: string, pairs: SavePair[]) => send({ mode: CORRECTION, baseSignature, pairs })

  function serveSession(session: ReturnType<typeof makeSession> | null) {
    db.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
  }

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    serveSession(makeSession({ draftRevisionId: 'draft-1' }))
    // The snapshot lets the employee in because approved records exist; the review after the save does too.
    db.attendanceRecord.count.mockResolvedValue(7)
    db.tx.attendanceRecord.count.mockResolvedValue(7)
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-36' }])
    seed([...dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }), ...cloneRows()])
  })

  it('a matching base saves the clone, clears the draft pointer and returns the clone\'s new signature', async () => {
    const base = cloneBase()

    const result = await sendCorrection(base, ashaPairs('18:00', 'c'))

    expect(store.rows.find((r) => r.id === 'c-3')).toMatchObject({ originalTime: '17:47', currentTime: '18:00', correctionId: 'session-1' })
    expect(store.rows.find((r) => r.id === 'p-3')).toMatchObject({ currentTime: '17:47', correctionId: null })
    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledWith({ where: { id: 'session-1' }, data: { draftRevisionId: null } })
    expect(result.day.signature).toBe(punchSetSignature(store.day('emp-36', DAY, 'session-1')))
    expect(result.day.signature).not.toBe(base)
    expect(result.day.signature).not.toBe(punchSetSignature(store.day('emp-36', DAY, null)))
  })

  it('the other tab added a MANUAL pair to the clone: refused before the transaction, the pair survives, the draft pointer is untouched', async () => {
    const base = cloneBase()
    otherTabAddsManualPair('session-1')

    await dayChanged(sendCorrection(base, ashaPairs('17:30', 'c')))

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten() // includes payrollCorrectionSession.update: the draft stays valid
    expect(store.rows.filter((r) => r.correctionId === 'session-1' && r.source === 'MANUAL').map((r) => r.id)).toEqual(['m-in', 'm-out'])
    expect(store.rows.find((r) => r.id === 'c-3')!.currentTime).toBe('17:47')
  })

  it('the clone changed while the save waited for the lock: refused, draft pointer untouched', async () => {
    const base = cloneBase()
    db.tx.$queryRaw.mockImplementationOnce(async () => {
      store.rows.find((r) => r.id === 'c-1')!.currentTime = '13:10'
      return [{ id: 'upload-1', source: 'ETIMEOFFICE', status: 'APPROVED', syncLockedAt: null, approvedAt: new Date('2026-11-12T00:00:00Z'), payrollWeekStartDate: new Date('2026-11-05T00:00:00Z') }]
    })

    await dayChanged(sendCorrection(base, ashaPairs('18:00', 'c')))

    expectNothingWritten()
  })

  it('a change to the live set of the same employee-day does not affect a correction save', async () => {
    const base = cloneBase()
    store.rows.find((r) => r.id === 'p-3')!.currentTime = '18:20' // the live punches moved
    store.rows.push(makePunch({ id: 'live-late', source: 'MANUAL', pairIndex: 2, position: 'IN', originalTime: null, currentTime: '20:00' }))

    await expect(sendCorrection(base, ashaPairs('18:00', 'c'))).resolves.toMatchObject({ day: { isEdited: true } })

    expect(store.rows.find((r) => r.id === 'c-3')!.currentTime).toBe('18:00')
    expect(store.rows.find((r) => r.id === 'live-late')).toBeDefined() // and the live set was not touched
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:20')
  })

  it('a base taken from the live set is not the clone\'s base', async () => {
    await dayChanged(sendCorrection(liveBase(), ashaPairs('18:00', 'c')))

    expectNothingWritten()
    expect(store.rows.find((r) => r.id === 'c-3')!.currentTime).toBe('17:47')
  })
})
