// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { pullNow, runScheduledSync } from '@/features/attendance-sync/services/sync.service'
import { SYNC_FAILURE_COPY } from '@/features/attendance-sync/lib/etimeoffice/parser'
import type { ParsedPunch, SyncClassification } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  freezeClock,
  makeEmployee,
  makePunch,
  makeUpload,
  mockLockedWeek,
  resetDb,
  serveUpload,
  type Db,
} from './service-fixtures'

// Fix round, item 3: a pull fetches from eTimeOffice outside any transaction, so the week may be
// approved (or edited) while the request is in flight. The replace transaction takes the week's
// row lock first and looks again; an approved week is never replaced.

const db = prisma as unknown as Db
const fetchMock = vi.mocked(fetchPunchData)

const SCHEDULED_NOW = new Date('2026-11-12T00:30:00Z')
const MANUAL_CLOCK = '2026-11-12T03:00:00Z'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const WEEK_CHANGED_COPY = 'The week was approved while the pull was running. Nothing was replaced.'

const scans = (code: string, date: string, times: string[]): ParsedPunch[] =>
  times.map((time) => ({ empCode: code, empName: `Empname${code}`, date, time, mcid: '1' }))
const loaded = (punches: ParsedPunch[]): SyncClassification => ({ ok: true, punches })

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

let fetchSpy: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

/** The week as the pull first found it: in review, no sync lock yet. */
beforeEach(() => {
  resetDb(db)
  fetchMock.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  db.attendanceUpload.update.mockResolvedValue({})
  db.employee.findMany.mockResolvedValue([makeEmployee()])
  fetchMock.mockResolvedValue(loaded(scans('0036', '2026-11-05', FULL_DAY)))
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  consoleError.mockRestore()
  vi.useRealTimers()
})

function expectNothingReplaced() {
  for (const client of [db, db.tx]) {
    expect(client.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(client.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(client.attendanceEmployeeDecision.deleteMany).not.toHaveBeenCalled()
    expect(client.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  }
  expect(db.tx.attendanceUpload.update).not.toHaveBeenCalled()
  expect(auditRows(db.tx)).toHaveLength(0)
}

describe('the replace transaction locks the week row and looks again', () => {
  it('takes the row lock before it reads what it will discard and before it deletes anything', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    const lock = order(db.tx.$queryRaw)
    expect(lock).toBeLessThan(order(db.tx.attendancePunch.findMany))
    expect(lock).toBeLessThan(order(db.tx.attendanceEmployeeDecision.count))
    expect(lock).toBeLessThan(order(db.tx.attendancePunch.deleteMany))
    expect(order(db.tx.attendancePunch.findMany)).toBeLessThan(order(db.tx.attendancePunch.deleteMany))
  })

  it('locks the row of the week being pulled (by id)', async () => {
    await pullNow('2026-11-05')

    const [strings, ...values] = db.tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(strings.join('?')).toContain('WHERE id = ?')
    expect(strings.join('?')).toContain('FOR UPDATE')
    expect(values).toEqual(['upload-1'])
  })

  it('a pull replaces a week that is still in review, as before', async () => {
    mockLockedWeek(db.tx, { status: 'REVIEW' })

    await expect(pullNow('2026-11-05')).resolves.toMatchObject({ outcome: 'LOADED', punchCount: 4 })
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('a SYNC_FAILED placeholder is replaced', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'SYNC_FAILED' }))
    mockLockedWeek(db.tx, { status: 'SYNC_FAILED' })

    await expect(pullNow('2026-11-05')).resolves.toMatchObject({ outcome: 'LOADED' })
  })
})

describe('the week was approved while the pull was running', () => {
  beforeEach(() => {
    freezeClock(MANUAL_CLOCK)
    // Pre-fetch the week was in review; by the time the lock is granted an approval has committed.
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-12T02:59:00Z') })
  })

  it('returns FAILED with WEEK_CHANGED and the explanatory copy', async () => {
    const outcome = await pullNow('2026-11-05')

    expect(outcome).toEqual({ outcome: 'FAILED', code: 'WEEK_CHANGED', message: WEEK_CHANGED_COPY })
    expect(SYNC_FAILURE_COPY.WEEK_CHANGED).toBe(WEEK_CHANGED_COPY)
  })

  it('replaces nothing: no deletes, no inserts, no loaded update, no LOADED audit', async () => {
    await pullNow('2026-11-05')

    expectNothingReplaced()
    expect(order(db.tx.$queryRaw)).toBeGreaterThan(0)
  })

  it('leaves the week APPROVED: the failure write carries the error and releases the lock, never a status', async () => {
    await pullNow('2026-11-05')

    expect(db.attendanceUpload.update).toHaveBeenCalledTimes(1)
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { lastSyncError: WEEK_CHANGED_COPY, syncLockedAt: null },
    })
    for (const [arg] of db.attendanceUpload.update.mock.calls) expect(arg.data).not.toHaveProperty('status')
    expect(db.attendanceUpload.updateMany.mock.calls.every(([arg]) => !('status' in arg.data))).toBe(true)
  })

  it('audits the failure as a FAILED PULL with code WEEK_CHANGED (outside the aborted transaction)', async () => {
    await pullNow('2026-11-05')

    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.$transaction.mock.calls[0][0]).toEqual(expect.any(Function))
    expect(Array.isArray(db.$transaction.mock.calls[1][0])).toBe(true)
    expect(auditRows(db)).toHaveLength(1)
    expect(auditRows(db)[0]).toMatchObject({ actionType: 'PULL', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({
      outcome: 'FAILED',
      code: 'WEEK_CHANGED',
      message: WEEK_CHANGED_COPY,
      trigger: 'MANUAL',
      summary: `Pull failed: ${WEEK_CHANGED_COPY}`,
    })
  })

  it('is not logged as a database failure and does not report SYNC_FAILED', async () => {
    const outcome = await pullNow('2026-11-05')

    expect(outcome).not.toMatchObject({ code: 'SYNC_FAILED' })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('releases the lock exactly once (the failure write; the finally block does not repeat it)', async () => {
    await pullNow('2026-11-05')

    const releases = db.attendanceUpload.update.mock.calls.filter(([arg]) => arg.data.syncLockedAt === null)
    expect(releases).toHaveLength(1)
  })

  it('applies to the scheduled sync too, audited as a SYNC', async () => {
    freezeClock('2026-11-12T00:30:00Z')

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'FAILED', code: 'WEEK_CHANGED', message: WEEK_CHANGED_COPY })
    expectNothingReplaced()
    expect(auditRows(db)[0]).toMatchObject({ actionType: 'SYNC' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'FAILED', code: 'WEEK_CHANGED', trigger: 'SCHEDULED' })
  })
})

describe('the week row is gone when the lock is taken', () => {
  it('fails with WEEK_CHANGED and replaces nothing', async () => {
    freezeClock(MANUAL_CLOCK)
    mockLockedWeek(db.tx, null)

    await expect(pullNow('2026-11-05')).resolves.toEqual({
      outcome: 'FAILED',
      code: 'WEEK_CHANGED',
      message: WEEK_CHANGED_COPY,
    })
    expectNothingReplaced()
  })
})

describe('what is discarded is read after the lock', () => {
  beforeEach(() => freezeClock(MANUAL_CLOCK))

  it('a manual pull reads the edits and decisions only through the transaction, never before it', async () => {
    await pullNow('2026-11-05')

    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(db.attendanceEmployeeDecision.count).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.findMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendanceEmployeeDecision.count).toHaveBeenCalledTimes(1)
  })

  it('an edit made while the API call was running is in the discard summary and the audit row', async () => {
    // Nothing was edited when the pull started; the in-transaction read (after the lock) sees the edit.
    db.tx.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'late-1', position: 'OUT', originalTime: '17:47', currentTime: '18:30', note: 'edited mid-pull' }),
    ])
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(1)

    const outcome = await pullNow('2026-11-05')

    if (outcome.outcome !== 'LOADED') throw new Error('expected LOADED')
    expect(outcome.discarded).toMatchObject({ editedDays: 1, decisions: 1 })
    expect(outcome.discarded?.edits.map((e) => e.punchId)).toEqual(['late-1'])
    const [audit] = auditRows(db.tx)
    expect(audit.detailsJson.discarded).toMatchObject({ editedDays: 1, decisions: 1 })
    expect(audit.detailsJson.discarded.edits[0]).toMatchObject({ punchId: 'late-1', current: '18:30', note: 'edited mid-pull' })
    expect(order(db.tx.attendancePunch.findMany)).toBeLessThan(order(db.tx.attendancePunch.deleteMany))
  })

  it('a week with nothing to discard reports discarded: null', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([makePunch({ id: 'plain-1' })])
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(0)

    await expect(pullNow('2026-11-05')).resolves.toEqual({ outcome: 'LOADED', punchCount: 4, discarded: null })
  })

  it('a scheduled sync still decides to skip an edited week from its pre-fetch read (no API call, no lock)', async () => {
    freezeClock('2026-11-12T00:30:00Z')
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'e-1', position: 'OUT', originalTime: '17:47', currentTime: '18:00' }),
    ])

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe('other failures inside the replace transaction are still SYNC_FAILED', () => {
  beforeEach(() => freezeClock(MANUAL_CLOCK))

  it('a database error', async () => {
    db.tx.attendancePunch.createMany.mockRejectedValue(new Error('connection reset'))

    await expect(pullNow('2026-11-05')).resolves.toEqual({
      outcome: 'FAILED',
      code: 'SYNC_FAILED',
      message: SYNC_FAILURE_COPY.SYNC_FAILED,
    })
    expect(consoleError).toHaveBeenCalled()
  })

  it('a failure of the lock query itself', async () => {
    db.tx.$queryRaw.mockRejectedValue(new Error('lock timeout'))

    await expect(pullNow('2026-11-05')).resolves.toMatchObject({ outcome: 'FAILED', code: 'SYNC_FAILED' })
    expectNothingReplaced()
  })
})

describe('a running pull cannot lose its lock to a takeover', () => {
  it('the lock is taken for the pull and released when the replace finishes', async () => {
    freezeClock(MANUAL_CLOCK)

    await pullNow('2026-11-05')

    expect(db.attendanceUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncLockedAt: expect.any(Date), lastSyncTrigger: 'MANUAL' }) }),
    )
    // The loaded update inside the transaction clears the lock together with the replace.
    expect(db.tx.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: expect.objectContaining({ status: 'REVIEW', syncLockedAt: null, approvedAt: null }),
    })
  })
})
