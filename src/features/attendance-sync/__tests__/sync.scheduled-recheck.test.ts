// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fix round 3, item 4: a SCHEDULED pull leaves a week with edits or decisions alone. The check before the
// API call runs without the week lock, so an edit or decision saved while the call was running (up to
// 45 s) used to be replaced. The replace transaction now repeats the check under the lock and, for a
// scheduled pull, throws an internal ScheduledSkip that is turned into the SKIPPED_HAS_EDITS outcome.
// A manual pull is unchanged: the user confirmed the discard.

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { pullNow, runScheduledSync } from '@/features/attendance-sync/services/sync.service'
import type { ParsedPunch, SyncClassification } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  makeEmployee,
  makePunch,
  makeUpload,
  resetDb,
  freezeClock,
  type Db,
} from './service-fixtures'

const db = prisma as unknown as Db
const fetchMock = vi.mocked(fetchPunchData)

// Thursday 12 Nov 2026, 06:00 IST: the scheduled sync targets 5-11 Nov.
const SCHEDULED_NOW = new Date('2026-11-12T00:30:00Z')
const MANUAL_CLOCK = '2026-11-12T03:00:00Z'

const scans = (times: string[]): ParsedPunch[] =>
  times.map((time) => ({ empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time, mcid: '1' }))
const loaded = (punches: ParsedPunch[]): SyncClassification => ({ ok: true, punches })

/** A hand-entered punch: the edit the scheduled pull must not replace. */
const manualPunch = () => makePunch({ id: 'm-0', source: 'MANUAL', originalTime: null, currentTime: '08:00' })
/** An API punch whose time was changed after the pull. */
const changedPunch = () => makePunch({ id: 'p-1', position: 'OUT', originalTime: '17:47', currentTime: '18:00' })

const txWrites = () => [
  db.tx.attendancePunch.deleteMany,
  db.tx.attendancePunch.createMany,
  db.tx.attendanceEmployeeDecision.deleteMany,
  db.tx.attendanceRecord.deleteMany,
  db.tx.attendanceRecord.createMany,
  db.tx.attendanceUpload.update,
  db.tx.attendanceUpload.updateMany,
  db.tx.auditLog.create,
]

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetDb(db)
  fetchMock.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  db.attendanceUpload.update.mockResolvedValue({})
  db.employee.findMany.mockResolvedValue([makeEmployee()])
  fetchMock.mockResolvedValue(loaded(scans(['07:40', '13:04', '13:56', '17:47'])))
  // The pre-fetch reads (plain client) see an untouched week: db.attendancePunch.findMany -> [] and decisions 0.
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SCHEDULED pull: an edit lands while the API call runs', () => {
  it('a hand-entered punch seen only under the lock: SKIPPED_HAS_EDITS, the API was called, nothing replaced', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // the pre-fetch check saw nothing, so the call went ahead
    for (const write of txWrites()) expect(write).not.toHaveBeenCalled()
    expect(db.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('an API punch whose time was changed counts as an edit', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([changedPunch()])

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    for (const write of txWrites()) expect(write).not.toHaveBeenCalled()
  })

  it('an employee decision recorded during the call is enough (decisions counted under the lock)', async () => {
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(1)

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    for (const write of txWrites()) expect(write).not.toHaveBeenCalled()
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS', editedDays: 0, decisions: 1 })
  })

  it('the stale notice is set to the run time and the sync lock released, in one write on the plain client', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await runScheduledSync(SCHEDULED_NOW)

    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { staleNoticeAt: SCHEDULED_NOW, syncLockedAt: null },
    })
    // Not the pre-fetch skip's write (staleNoticeAt alone): the lock was taken, so it must be freed too.
    expect(db.attendanceUpload.update).not.toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { staleNoticeAt: SCHEDULED_NOW },
    })
    expect(db.tx.attendanceUpload.update).not.toHaveBeenCalled()
  })

  it('writes exactly one SYNC audit row with the counts from the locked read, and no FAILED row', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([
      manualPunch(),
      makePunch({ id: 'm-1', source: 'MANUAL', position: 'OUT', originalTime: null, currentTime: '12:00' }), // same day: one edited day
      makePunch({ id: 'm-2', punchDate: new Date('2026-11-06T00:00:00Z'), source: 'MANUAL', originalTime: null, currentTime: '08:00' }),
    ])
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(2)

    await runScheduledSync(SCHEDULED_NOW)

    const rows = auditRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actionType: 'SYNC', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(rows[0].detailsJson).toMatchObject({
      outcome: 'SKIPPED_HAS_EDITS',
      trigger: 'SCHEDULED',
      summary: 'Scheduled sync skipped: week has edits',
      weekStart: '2026-11-05',
      weekEnd: '2026-11-11',
      editedDays: 2,
      decisions: 2,
    })
    expect(rows.some((r) => r.detailsJson.outcome === 'FAILED')).toBe(false)
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('is not a failure: no lastSyncError is written anywhere, and the failure recorder (array transaction) never runs', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await runScheduledSync(SCHEDULED_NOW)

    const updates = [...db.attendanceUpload.update.mock.calls, ...db.tx.attendanceUpload.update.mock.calls]
    for (const [arg] of updates) expect(arg.data).not.toHaveProperty('lastSyncError')
    expect(db.$transaction.mock.calls.filter(([arg]) => typeof arg !== 'function')).toHaveLength(0)
  })

  it('releases the sync lock once: the finally block does not release it again', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await runScheduledSync(SCHEDULED_NOW)

    const releases = db.attendanceUpload.update.mock.calls.filter(([arg]) => arg.data.syncLockedAt === null)
    expect(releases).toHaveLength(1)
    expect(db.attendanceUpload.update).toHaveBeenCalledTimes(1)
  })

  it('the internal skip signal never leaves syncWeek: the caller gets an outcome, not an exception', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await expect(runScheduledSync(SCHEDULED_NOW)).resolves.toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
  })

  it('reads the edits under the lock: the week row is locked before the edits and decisions are read on tx', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await runScheduledSync(SCHEDULED_NOW)

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null } }),
    )
    expect(db.tx.attendanceEmployeeDecision.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1' } })
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.findMany))
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendanceEmployeeDecision.count))
  })

  it('the transaction is opened exactly once, with the usual timeout, and the skip is decided inside it', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await runScheduledSync(SCHEDULED_NOW)

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    // The API call came first, then the transaction.
    expect(order(fetchMock)).toBeLessThan(order(db.$transaction))
  })

  it('a week with edits that appear in neither read still loads (contrast: nothing to skip)', async () => {
    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'LOADED', punchCount: 4, discarded: null })
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
    expect(db.tx.attendancePunch.createMany).toHaveBeenCalled()
  })

  it('an unedited earlier pull seen under the lock is replaced as before (API punches equal to their originals)', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue(
      dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04'] }),
    )

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome.outcome).toBe('LOADED')
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
  })
})

describe('SCHEDULED pull: the pre-fetch check is kept', () => {
  it('edits already visible before the call: skipped before any API call, lock or transaction', async () => {
    db.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled() // the sync lock was never taken
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { staleNoticeAt: SCHEDULED_NOW } })
    expect(auditRows(db)).toHaveLength(1)
  })
})

describe('SCHEDULED pull: failures around the skip', () => {
  it('when the skip bookkeeping itself fails the sync lock is still released by the finally block', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])
    db.attendanceUpload.update.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue({})

    await expect(runScheduledSync(SCHEDULED_NOW)).rejects.toThrow('connection reset')

    // First call: the notice + release that failed; second: the finally block's own release.
    expect(db.attendanceUpload.update).toHaveBeenCalledTimes(2)
    expect(db.attendanceUpload.update).toHaveBeenLastCalledWith({ where: { id: 'upload-1' }, data: { syncLockedAt: null } })
    expect(auditRows(db)).toHaveLength(0)
  })

  it('when the skip audit row cannot be written the outcome is not reported and the lock is not released twice', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])
    db.auditLog.create.mockRejectedValue(new Error('audit down'))

    await expect(runScheduledSync(SCHEDULED_NOW)).rejects.toThrow('audit down')

    const releases = db.attendanceUpload.update.mock.calls.filter(([arg]) => arg.data.syncLockedAt === null)
    expect(releases).toHaveLength(1) // lockReleased was already true
  })
})

describe('MANUAL pull: unchanged, the user confirmed the discard', () => {
  beforeEach(() => freezeClock(MANUAL_CLOCK))

  it('edits found under the lock are replaced and reported as discarded', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch(), changedPunch()])

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 4 })
    if (outcome.outcome === 'LOADED') expect(outcome.discarded).toMatchObject({ editedDays: 1, decisions: 0 })
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', correctionId: null } })
    expect(db.tx.attendancePunch.createMany).toHaveBeenCalled()
  })

  it('decisions found under the lock are discarded too, and no stale notice is set', async () => {
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(3)

    const outcome = await pullNow('2026-11-05')

    expect(outcome.outcome).toBe('LOADED')
    if (outcome.outcome === 'LOADED') expect(outcome.discarded).toMatchObject({ editedDays: 0, decisions: 3 })
    expect(db.tx.attendanceEmployeeDecision.deleteMany).toHaveBeenCalled()
    for (const [arg] of db.attendanceUpload.update.mock.calls) expect(arg.data).not.toHaveProperty('staleNoticeAt')
  })

  it('writes a PULL audit row (not SYNC) and never a SKIPPED_HAS_EDITS one', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([manualPunch()])

    await pullNow('2026-11-05')

    const rows = auditRows(db.tx)
    expect(rows).toHaveLength(1)
    expect(rows[0].actionType).toBe('PULL')
    expect(rows[0].detailsJson).toMatchObject({ outcome: 'LOADED', trigger: 'MANUAL' })
    expect(auditRows(db).some((r) => r.detailsJson.outcome === 'SKIPPED_HAS_EDITS')).toBe(false)
  })
})
