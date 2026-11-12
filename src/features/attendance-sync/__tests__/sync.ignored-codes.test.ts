// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A code ignored for this week only is a decision on the week: weekHasEditsOrDecisions counts it (ignoredCodes),
// getPullWarning reports it, a scheduled sync leaves the week alone, and a manual pull discards it and says so.
// A code ignored for every week is NOT counted: a new pull ignores it again, so nothing is lost.

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { getPullWarning, pullNow, runScheduledSync, weekHasEditsOrDecisions } from '@/features/attendance-sync/services/sync.service'
import type { ParsedPunch, SyncClassification } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  freezeClock,
  makeEmployee,
  makePunch,
  makeUpload,
  resetDb,
  type Db,
  type PunchRow,
} from './service-fixtures'

const db = prisma as unknown as Db
const fetchMock = vi.mocked(fetchPunchData)

// Thursday 12 Nov 2026, 06:00 IST: the scheduled sync targets 5-11 Nov.
const SCHEDULED_NOW = new Date('2026-11-12T00:30:00Z')
const MANUAL_CLOCK = '2026-11-12T03:00:00Z'

const scans = (times: string[]): ParsedPunch[] =>
  times.map((time) => ({ empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time, mcid: '1' }))
const loaded = (punches: ParsedPunch[]): SyncClassification => ({ ok: true, punches })

/** An ignored code's punches: not edited (original equals current), not hand-entered. */
const ignoredPunches = (code: string, idPrefix = code): PunchRow[] =>
  dayPunches({ idPrefix, employeeId: null, empCode: code, date: '2026-11-05', times: ['08:00', '12:00'], matchStatus: 'IGNORED' })

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

/**
 * Save an IGNORE exception for each of `saved`. The lookup for the ignored codes of a week filters by kind and code,
 * like the query does; the plain read of every exception (the pull classifying its punches) gets them all.
 */
function saveIgnoreExceptions(client: { attendanceCodeException: Db['attendanceCodeException'] }, saved: string[]) {
  const all = saved.map((empCode) => ({ empCode, kind: 'IGNORE', employeeId: null }))
  client.attendanceCodeException.findMany.mockImplementation(
    async (args?: { where?: { kind?: string; empCode?: { in: string[] } } }) => {
      const where = args?.where
      if (!where) return all
      return all.filter((e) => (!where.kind || e.kind === where.kind) && (!where.empCode || where.empCode.in.includes(e.empCode)))
    },
  )
}

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
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── weekHasEditsOrDecisions ──────────────────────────────────────────────────

describe('weekHasEditsOrDecisions counts the codes ignored for this week only', () => {
  it('counts one per code, not per punch, and an ignored punch is not an edit', async () => {
    db.attendancePunch.findMany.mockResolvedValue([...ignoredPunches('0999'), ...ignoredPunches('0555')])

    const result = await weekHasEditsOrDecisions('upload-1')

    expect(result).toEqual({ hasEdits: false, editedDays: 0, decisions: 0, ignoredCodes: 2, edits: [] })
  })

  it('asks for the IGNORE exceptions of only the ignored codes', async () => {
    db.attendancePunch.findMany.mockResolvedValue([...ignoredPunches('0999'), ...ignoredPunches('0555')])

    await weekHasEditsOrDecisions('upload-1')

    expect(db.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceCodeException.findMany).toHaveBeenCalledWith({
      where: { kind: 'IGNORE', empCode: { in: ['0999', '0555'] } },
      select: { empCode: true, kind: true, employeeId: true },
    })
  })

  it('does not count a code ignored for every week (it has a saved IGNORE exception)', async () => {
    db.attendancePunch.findMany.mockResolvedValue([...ignoredPunches('0999'), ...ignoredPunches('0555')])
    saveIgnoreExceptions(db, ['0555'])

    expect((await weekHasEditsOrDecisions('upload-1')).ignoredCodes).toBe(1)
  })

  it('is zero when every ignored code is ignored for every week', async () => {
    db.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0555'))
    saveIgnoreExceptions(db, ['0555'])

    expect(await weekHasEditsOrDecisions('upload-1')).toMatchObject({ ignoredCodes: 0, hasEdits: false, decisions: 0 })
  })

  it('does not count unresolved or matched codes, and does not even look up exceptions when nothing is ignored', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      ...dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '12:00'], matchStatus: 'UNKNOWN' }),
      ...dayPunches({ idPrefix: 'd', employeeId: null, empCode: '0007', date: '2026-11-05', times: ['08:00', '12:00'], matchStatus: 'DUPLICATE' }),
      ...dayPunches({ idPrefix: 'm', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
    ])

    expect((await weekHasEditsOrDecisions('upload-1')).ignoredCodes).toBe(0)
    expect(db.attendanceCodeException.findMany).not.toHaveBeenCalled()
  })

  it('reports ignored codes beside edits and decisions without mixing them up', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      ...ignoredPunches('0999'),
      makePunch({ id: 'e-1', originalTime: '07:40', currentTime: '07:45' }),
    ])
    db.attendanceEmployeeDecision.count.mockResolvedValue(2)

    expect(await weekHasEditsOrDecisions('upload-1')).toMatchObject({ hasEdits: true, editedDays: 1, decisions: 2, ignoredCodes: 1 })
  })

  it('reads inside the caller\'s transaction when given its client, and never on the plain one', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0999'))

    const result = await weekHasEditsOrDecisions('upload-1', db.tx as never)

    expect(result.ignoredCodes).toBe(1)
    expect(db.tx.attendanceCodeException.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceCodeException.findMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
  })
})

// ─── getPullWarning ───────────────────────────────────────────────────────────

describe('getPullWarning reports the codes ignored for this week only', () => {
  it('carries the count next to the edited days and decisions', async () => {
    db.attendancePunch.count.mockResolvedValue(40)
    db.attendancePunch.findMany.mockResolvedValue([
      ...ignoredPunches('0999'),
      makePunch({ id: 'a', originalTime: '07:40', currentTime: '07:45' }),
    ])
    db.attendanceEmployeeDecision.count.mockResolvedValue(3)

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: true, editedDays: 1, decisions: 3, ignoredCodes: 1 })
  })

  it('warns about a week-ignored code on its own', async () => {
    db.attendancePunch.count.mockResolvedValue(8)
    db.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0999'))

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: true, editedDays: 0, decisions: 0, ignoredCodes: 1 })
  })

  it('has nothing to warn about for a code ignored for every week', async () => {
    db.attendancePunch.count.mockResolvedValue(8)
    db.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0555'))
    saveIgnoreExceptions(db, ['0555'])

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: true, editedDays: 0, decisions: 0, ignoredCodes: 0 })
  })
})

// ─── Scheduled sync ───────────────────────────────────────────────────────────

describe('scheduled sync and a code ignored for this week only', () => {
  it('leaves the week alone before calling the API: skipped, stale notice set, audit says one ignored code', async () => {
    db.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0999'))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { staleNoticeAt: SCHEDULED_NOW } })
    const [audit] = auditRows(db)
    expect(audit).toMatchObject({ actionType: 'SYNC', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      outcome: 'SKIPPED_HAS_EDITS',
      trigger: 'SCHEDULED',
      summary: 'Scheduled sync skipped: week has edits',
      editedDays: 0,
      decisions: 0,
      ignoredCodes: 1,
    })
  })

  it('replaces the week as usual when the only ignored code is ignored for every week (nothing to lose)', async () => {
    db.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0555'))
    saveIgnoreExceptions(db, ['0555'])

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome.outcome).toBe('LOADED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
  })

  it('still skips when a week-ignored code sits beside an every-week one', async () => {
    db.attendancePunch.findMany.mockResolvedValue([...ignoredPunches('0555'), ...ignoredPunches('0999')])
    saveIgnoreExceptions(db, ['0555'])

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ ignoredCodes: 1 })
  })

  it('skips under the lock when the code is ignored while the API call runs: API was called, nothing replaced', async () => {
    // The pre-fetch check on the plain client sees an untouched week; the locked read on the transaction client does not.
    db.tx.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0999'))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const write of txWrites()) expect(write).not.toHaveBeenCalled()
    expect(db.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { staleNoticeAt: SCHEDULED_NOW, syncLockedAt: null },
    })
    // One SYNC audit row with the count from the locked read, never a FAILED one.
    expect(auditRows(db)).toHaveLength(1)
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS', ignoredCodes: 1 })
  })

  it('does not skip under the lock for a code ignored for every week', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0555'))
    saveIgnoreExceptions(db.tx, ['0555'])

    expect((await runScheduledSync(SCHEDULED_NOW)).outcome).toBe('LOADED')
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
  })
})

// ─── Manual pull ──────────────────────────────────────────────────────────────

describe('manual pull and a code ignored for this week only', () => {
  beforeEach(() => freezeClock(MANUAL_CLOCK))

  it('replaces the week, reports the ignored code as discarded and keeps the count in the PULL audit row', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0999'))

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 4 })
    if (outcome.outcome !== 'LOADED') throw new Error('expected LOADED')
    expect(outcome.discarded).toEqual({ editedDays: 0, decisions: 0, ignoredCodes: 1, edits: [] })
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'PULL', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson.discarded).toMatchObject({ editedDays: 0, decisions: 0, ignoredCodes: 1 })
  })

  it('reports nothing discarded for a code ignored for every week', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue(ignoredPunches('0555'))
    saveIgnoreExceptions(db.tx, ['0555'])

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'LOADED', discarded: null })
  })

  it('counts the ignored code together with edits and decisions', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([
      ...ignoredPunches('0999'),
      makePunch({ id: 'e-1', originalTime: '07:40', currentTime: '07:45' }),
    ])
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(2)

    const outcome = await pullNow('2026-11-05')

    if (outcome.outcome !== 'LOADED') throw new Error('expected LOADED')
    expect(outcome.discarded).toMatchObject({ editedDays: 1, decisions: 2, ignoredCodes: 1 })
  })
})
