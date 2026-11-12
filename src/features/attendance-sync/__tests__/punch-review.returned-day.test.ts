// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { punchSetSignature } from '@/features/attendance-sync/lib/day-signature'
import { buildDayView } from '@/features/attendance-sync/lib/hours'
import { savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import type { ReviewMode, SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
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

// savePunchEdit returns the day it saved, and the editor sends that day's signature as its next
// baseSignature. The day (and its signature) is built from the punches re-read INSIDE the locked
// transaction after the writes; with nothing to write, from the rows the base signature was just checked
// against. The review read after the commit only supplies the display data (employee totals, counts,
// totals, approval) and may already hold another tab's later save, which must never leak into the day.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const DAY = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })

let store: PunchStore
let txReads: PunchRow[][]
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

/** Save as an editor that opened the day just now. */
function save(pairs: SavePair[], over: Partial<Parameters<typeof savePunchEdit>[0]> = {}) {
  const mode = over.mode ?? LIVE
  const baseSignature = baseSignatureOf(store, 'emp-36', DAY, mode.kind === 'CORRECTION' ? mode.correctionId : null)
  return savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: DAY, mode: LIVE, baseSignature, pairs, ...over })
}

function seed(rows: PunchRow[], employees = [asha, ravi]) {
  store = installPunchStore(db, rows)
  db.employee.findMany.mockResolvedValue(employees)
  serveEmployeeLookup(db, employees)
  // Remember what every read inside the transaction returned, so a test can say which one the day came from.
  const base = db.tx.attendancePunch.findMany.getMockImplementation() as (args?: unknown) => Promise<PunchRow[]>
  db.tx.attendancePunch.findMany.mockImplementation(async (args?: unknown) => {
    const rows = await base(args)
    txReads.push(rows)
    return rows
  })
}

/** Another tab's hand-entered third pair: 18:30 to 19:30, for the same employee-day. */
const otherTabPair = (correctionId: string | null = null): PunchRow[] => [
  makePunch({ id: 'o-in', employeeId: 'emp-36', correctionId, punchDate: new Date(`${DAY}T00:00:00Z`), pairIndex: 2, position: 'IN', source: 'MANUAL', originalTime: null, currentTime: '18:30' }),
  makePunch({ id: 'o-out', employeeId: 'emp-36', correctionId, punchDate: new Date(`${DAY}T00:00:00Z`), pairIndex: 2, position: 'OUT', source: 'MANUAL', originalTime: null, currentTime: '19:30' }),
]

/** Run `effect` the moment the save's transaction has committed, before the review is read for the display data. */
function afterCommit(effect: () => void) {
  db.$transaction.mockImplementation(async (arg: unknown) => {
    const result = await (arg as (tx: Db['tx']) => Promise<unknown>)(db.tx)
    effect()
    return result
  })
}

/** Run `effect` as the review is first read on the plain client (every punch of the week, no employee filter). */
function beforeReviewRead(effect: () => void) {
  const base = db.attendancePunch.findMany.getMockImplementation() as (args?: unknown) => Promise<PunchRow[]>
  let done = false
  db.attendancePunch.findMany.mockImplementation(async (args?: { where?: Record<string, unknown> }) => {
    if (!done && args?.where && !('employeeId' in args.where)) {
      done = true
      effect()
    }
    return base(args)
  })
}

const addOtherTabPair = (correctionId: string | null = null) => store.rows.push(...otherTabPair(correctionId).map((r) => ({ ...r })))

beforeEach(() => {
  resetDb(db)
  txReads = []
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock('2026-11-13T03:00:00Z') // the 5-11 Nov week has ended
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  seed(dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }))
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

describe('savePunchEdit: the returned day is the one the transaction saved', () => {
  it('equals the in-transaction re-read even when the read after the commit already holds another tab\'s later save', async () => {
    afterCommit(() => addOtherTabPair())

    const result = await save(ashaPairs('18:00'))

    // The last read inside the transaction is the saved day; the review read afterwards saw three pairs.
    const saved = txReads[txReads.length - 1]
    expect(saved).toHaveLength(4)
    expect(store.day('emp-36', DAY)).toHaveLength(6)
    expect(result.day).toEqual(buildDayView(DAY, saved))
    expect(result.day.pairs).toHaveLength(2)
    expect(result.day.pairs[1].out?.time).toBe('18:00')
    expect(result.day.signature).toBe(punchSetSignature(saved))
    // ...and it is NOT the signature of what is stored now, so the editor's next save cannot overwrite the other tab's pair.
    expect(result.day.signature).not.toBe(baseSignatureOf(store, 'emp-36', DAY))
    expect(result.day.signature).not.toBe(punchSetSignature(store.day('emp-36', DAY)))
  })

  it('takes only the totals, counts and approval from the read after the commit', async () => {
    afterCommit(() => addOtherTabPair())

    const result = await save(ashaPairs('18:00'))

    const everything = buildDayView(DAY, store.day('emp-36', DAY))
    expect(everything.pairs).toHaveLength(3)
    // The week total of the employee includes the other tab's pair (display data from the later read)...
    expect(result.employeeTotals.regular + result.employeeTotals.overtime).toBeCloseTo(everything.totalHours, 2)
    // ...while the day it hands back is just this save, so the two differ by exactly that pair's hour.
    expect(result.employeeTotals.regular + result.employeeTotals.overtime).toBeCloseTo(result.day.totalHours + 1, 2)
    expect(result.employeeTotals.hasAnyPunch).toBe(true)
    expect(result.savedAt).toBe('2026-11-13T03:00:00.000Z')
  })

  it('shows what the writes did when they delete: the hand-entered pair is gone from the day and an edited time is the new one', async () => {
    seed([...dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY }), ...otherTabPair()])
    // The editor holds three pairs; it keeps two, edits the last OUT and drops the hand-entered third pair.
    const result = await save(ashaPairs('18:00'))

    expect(store.day('emp-36', DAY).map((r) => r.id).sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3'])
    expect(result.day.pairs).toHaveLength(2)
    expect(result.day.pairs[1].out?.time).toBe('18:00')
    expect(result.day.signature).toBe(baseSignatureOf(store, 'emp-36', DAY))
  })

  it('shows what the writes did when they create: a new pair comes back with the ids the database gave it', async () => {
    const result = await save([...ashaPairs('17:47'), pair(2, { time: '18:30' }, { time: '19:30' })])

    const created = store.rows.filter((r) => r.source === 'MANUAL')
    expect(created).toHaveLength(2)
    expect(result.day.pairs).toHaveLength(3)
    expect(result.day.pairs[2].in?.id).toBe(created.find((r) => r.position === 'IN')!.id)
    expect(result.day.pairs[2].out?.id).toBe(created.find((r) => r.position === 'OUT')!.id)
    expect(result.day.pairs[2].in?.id).not.toBe(result.day.pairs[2].out?.id)
    // Those ids are part of the signature, so it is the signature of exactly what is stored now.
    expect(result.day.signature).toBe(baseSignatureOf(store, 'emp-36', DAY))
  })

  it('is read after the last audit entry, on the transaction client, for this employee-day only', async () => {
    await save(ashaPairs('18:00'))

    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledTimes(2) // the re-read before the writes, then the saved day
    expect(order(db.tx.auditLog.create)).toBeLessThan(order(db.tx.attendancePunch.findMany, 1))
    expect(db.tx.attendancePunch.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null, employeeId: 'emp-36', punchDate: new Date(`${DAY}T00:00:00Z`) } }),
    )
  })

  it('the signature it returns is what the editor must send next: a later save from it passes, and one from the old signature is refused', async () => {
    const opened = baseSignatureOf(store, 'emp-36', DAY)
    const first = await save(ashaPairs('18:00'))
    expect(first.day.signature).not.toBe(opened)

    await expect(
      savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: DAY, mode: LIVE, baseSignature: first.day.signature, pairs: ashaPairs('18:10') }),
    ).resolves.toMatchObject({ day: { date: DAY } })
    await expect(
      savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: DAY, mode: LIVE, baseSignature: opened, pairs: ashaPairs('18:20') }),
    ).rejects.toMatchObject({ code: 'DAY_CHANGED' })
  })

  it('the next save from the returned signature is refused when another tab saved in between, instead of deleting its pair', async () => {
    afterCommit(() => addOtherTabPair())
    const first = await save(ashaPairs('18:00'))

    const stale = savePunchEdit({
      weekId: WEEK_ID,
      employeeId: 'emp-36',
      date: DAY,
      mode: LIVE,
      baseSignature: first.day.signature,
      pairs: ashaPairs('18:10'), // the editor only knows two pairs, so a save would delete the other tab's third
    })

    await expect(stale).rejects.toMatchObject({ code: 'DAY_CHANGED' })
    expect(store.day('emp-36', DAY).map((r) => r.id)).toEqual(expect.arrayContaining(['o-in', 'o-out']))
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00')
  })

  it('still reports EMPLOYEE_NOT_FOUND when the employee has left the review by the time the totals are read', async () => {
    afterCommit(() => db.employee.findMany.mockResolvedValue([ravi]))

    await expect(save(ashaPairs('18:00'))).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
      message: "That employee isn't in this week's review.",
    })
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('18:00') // the save itself landed
  })
})

describe('savePunchEdit: a save with nothing to write returns the rows the base signature was checked against', () => {
  it('opens no transaction and the day is the pre-lock rows, whatever another tab saved after them', async () => {
    beforeReviewRead(() => addOtherTabPair())
    const opened = baseSignatureOf(store, 'emp-36', DAY)

    const result = await save(ashaPairs('17:47')) // the times it already has

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(store.day('emp-36', DAY)).toHaveLength(6) // the other tab saved before the review was read
    expect(result.day.pairs).toHaveLength(2)
    expect(result.day.signature).toBe(opened)
    expect(result.day).toEqual(buildDayView(DAY, dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: DAY, times: FULL_DAY })))
    // The display data still comes from the later read.
    expect(result.employeeTotals.regular + result.employeeTotals.overtime).toBeCloseTo(result.day.totalHours + 1, 2)
  })

  it('a day with no punches at all returns the empty day', async () => {
    seed([])

    const result = await save([pair(0, { time: null }, { time: null })])

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(result.day).toEqual(buildDayView(DAY, []))
    expect(result.day.pairs).toHaveLength(0)
  })
})

describe('savePunchEdit: a correction returns its own draft rows, not the live punches', () => {
  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.attendanceRecord.count.mockResolvedValue(7)
    db.tx.attendanceRecord.count.mockResolvedValue(7)
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-36' }])
    // The live punches carry different times from the draft clone.
    seed([
      ...dayPunches({ idPrefix: 'live', employeeId: 'emp-36', date: DAY, times: ['06:00', '10:00', '11:00', '15:00'] }),
      ...dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: DAY, times: FULL_DAY, correctionId: 'session-1' }),
    ])
  })

  it('re-reads the draft set under the lock and builds the day from it', async () => {
    afterCommit(() => addOtherTabPair('session-1'))

    const result = await save(ashaPairs('18:00', 'c'), { mode: CORRECTION })

    const saved = txReads[txReads.length - 1]
    expect(db.tx.attendancePunch.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ correctionId: 'session-1', employeeId: 'emp-36' }) }),
    )
    expect(saved.every((r) => r.correctionId === 'session-1' && r.id.startsWith('c-'))).toBe(true)
    expect(result.day).toEqual(buildDayView(DAY, saved))
    expect(result.day.pairs[0].in?.time).toBe('07:40') // the draft's time, not the live 06:00
    expect(result.day.pairs).toHaveLength(2) // not the third pair another tab added right after the commit
    expect(result.day.signature).toBe(punchSetSignature(saved))
  })
})
