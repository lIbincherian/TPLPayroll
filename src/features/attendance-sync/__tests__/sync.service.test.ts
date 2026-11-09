// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import {
  getPullWarning,
  pullNow,
  runScheduledSync,
  syncWeek,
  weekHasEditsOrDecisions,
} from '@/features/attendance-sync/services/sync.service'
import { SYNC_FAILURE_COPY } from '@/features/attendance-sync/lib/etimeoffice/parser'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import {
  AttendanceSyncError,
  type ParsedPunch,
  type SyncClassification,
} from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  freezeClock,
  makeEmployee,
  makeExcelUpload,
  makePunch,
  makeRun,
  makeUpload,
  resetDb,
  utc,
  WEEK,
  type Db,
} from './service-fixtures'

const db = prisma as unknown as Db
const fetchMock = vi.mocked(fetchPunchData)

// Thursday 12 Nov 2026, 06:00 IST: the scheduled sync targets 5-11 Nov.
const SCHEDULED_NOW = new Date('2026-11-12T00:30:00Z')
const MANUAL_CLOCK = '2026-11-12T03:00:00Z'

function scans(code: string, date: string, times: string[], name: string | null = `Empname${code}`): ParsedPunch[] {
  return times.map((time) => ({ empCode: code, empName: name, date, time, mcid: '1' }))
}

const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const loaded = (punches: ParsedPunch[]): SyncClassification => ({ ok: true, punches })

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetDb(db)
  fetchMock.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  db.attendanceUpload.update.mockResolvedValue({})
  db.employee.findMany.mockResolvedValue([makeEmployee()])
  fetchMock.mockResolvedValue(loaded(scans('0036', '2026-11-05', FULL_DAY)))
})

afterEach(() => {
  // The eTimeOffice client is mocked, and nothing may reach for the real network either.
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── US-12.1 / C1: scheduled sync ─────────────────────────────────────────────

describe('runScheduledSync stores a loaded week as ready for review (US-12.1)', () => {
  it('targets the week that ended yesterday and asks the client for exactly that range', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith({ start: '2026-11-05', end: '2026-11-11' })
  })

  it('replaces the week in one transaction: delete punches, decisions and records, then create the new punches', async () => {
    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'LOADED', punchCount: 4, discarded: null })

    const where = { attendanceUploadId: 'upload-1' }
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalledWith({ where: { ...where, correctionId: null } })
    expect(db.tx.attendanceEmployeeDecision.deleteMany).toHaveBeenCalledWith({ where })
    expect(db.tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where })

    // Deletes run before the inserts.
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0]
    expect(order(db.tx.attendancePunch.deleteMany)).toBeLessThan(order(db.tx.attendancePunch.createMany))
    expect(order(db.tx.attendanceEmployeeDecision.deleteMany)).toBeLessThan(order(db.tx.attendancePunch.createMany))
    expect(order(db.tx.attendanceRecord.deleteMany)).toBeLessThan(order(db.tx.attendancePunch.createMany))

    // Nothing is written outside the transaction on success.
    expect(db.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })

  it('stores the pairs of the day in order, linked to the matched employee, with the original kept', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    const { data } = db.tx.attendancePunch.createMany.mock.calls[0][0]
    expect(data).toHaveLength(4)
    expect(data.map((r: { position: string; pairIndex: number; currentTime: string }) => [r.pairIndex, r.position, r.currentTime])).toEqual([
      [0, 'IN', '07:40'],
      [0, 'OUT', '13:04'],
      [1, 'IN', '13:56'],
      [1, 'OUT', '17:47'],
    ])
    expect(data[0]).toMatchObject({
      attendanceUploadId: 'upload-1',
      employeeId: 'emp-36',
      empCode: '0036',
      empName: 'Empname0036',
      matchStatus: 'MATCHED',
      punchDate: utc('2026-11-05'),
      source: 'API',
      originalTime: '07:40',
      currentTime: '07:40',
      note: null,
      mergedScansJson: Prisma.DbNull,
    })
  })

  it('marks the upload REVIEW and clears the error, stale notice, lock and approval', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    expect(db.tx.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: {
        status: 'REVIEW',
        lastSyncedAt: SCHEDULED_NOW,
        lastSyncError: null,
        staleNoticeAt: null,
        syncLockedAt: null,
        approvedAt: null,
      },
    })
  })

  it('writes a SYNC audit row inside the transaction with the load summary and no discard', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    expect(db.auditLog.create).not.toHaveBeenCalled()
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'SYNC', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      outcome: 'LOADED',
      trigger: 'SCHEDULED',
      weekStart: '2026-11-05',
      weekEnd: '2026-11-11',
      punchCount: 4,
      scanCount: 4,
      codes: 1,
      unknownCodes: [],
      duplicateCodes: [],
      ignoredCodes: [],
      discarded: { editedDays: 0, decisions: 0, edits: [] },
    })
  })

  it('takes the sync lock before calling the API, recording the attempt and trigger', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    expect(db.attendanceUpload.updateMany).toHaveBeenCalledTimes(1)
    const lock = db.attendanceUpload.updateMany.mock.calls[0][0]
    expect(lock.data).toEqual({ syncLockedAt: SCHEDULED_NOW, lastSyncAttemptAt: SCHEDULED_NOW, lastSyncTrigger: 'SCHEDULED' })
    expect(db.attendanceUpload.updateMany.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0])
  })

  it('builds punch rows with saved exceptions: IGNORE leaves a code out, MATCH links an unmatched code', async () => {
    db.employee.findMany.mockResolvedValue([makeEmployee(), makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi' })])
    db.attendanceCodeException.findMany.mockResolvedValue([
      { empCode: '0999', kind: 'IGNORE', employeeId: null },
      { empCode: '0888', kind: 'MATCH', employeeId: 'emp-5' },
    ])
    fetchMock.mockResolvedValue(
      loaded([
        ...scans('0036', '2026-11-05', ['07:40', '16:00']),
        ...scans('0999', '2026-11-05', ['08:00', '17:00']),
        ...scans('0888', '2026-11-06', ['08:00', '17:00']),
        ...scans('0777', '2026-11-06', ['09:00', '18:00']),
      ]),
    )

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 8 })
    const rows: Array<{ empCode: string; matchStatus: string; employeeId: string | null }> =
      db.tx.attendancePunch.createMany.mock.calls[0][0].data
    const byCode = (code: string) => rows.filter((r) => r.empCode === code)
    expect(byCode('0999').every((r) => r.matchStatus === 'IGNORED' && r.employeeId === null)).toBe(true)
    expect(byCode('0888').every((r) => r.matchStatus === 'MATCHED' && r.employeeId === 'emp-5')).toBe(true)
    expect(byCode('0777').every((r) => r.matchStatus === 'UNKNOWN' && r.employeeId === null)).toBe(true)

    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ ignoredCodes: ['0999'], unknownCodes: ['0777'], duplicateCodes: [] })
  })

  it('drops scans dated outside the requested week', async () => {
    fetchMock.mockResolvedValue(
      loaded([...scans('0036', '2026-11-05', ['08:00', '16:00']), ...scans('0036', '2026-11-12', ['08:00', '16:00'])]),
    )

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 2 })
    const days = new Set(db.tx.attendancePunch.createMany.mock.calls[0][0].data.map((r: { punchDate: Date }) => r.punchDate.toISOString()))
    expect([...days]).toEqual([utc('2026-11-05').toISOString()])
  })

  it('inserts large weeks in chunks of 1000 rows', async () => {
    // 1250 unknown codes x two scans each = 2500 stored punches.
    const many: ParsedPunch[] = []
    for (let i = 0; i < 1250; i++) many.push(...scans(String(5000 + i), '2026-11-05', ['08:00', '17:00']))
    fetchMock.mockResolvedValue(loaded(many))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 2500 })
    const sizes = db.tx.attendancePunch.createMany.mock.calls.map((c) => c[0].data.length)
    expect(sizes).toEqual([1000, 1000, 500])
  })
})

describe('scheduled sync and a week with no row yet', () => {
  it('creates a placeholder SYNC_FAILED row, then loads it', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'upload-new' }))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(db.attendanceUpload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'ETIMEOFFICE',
        payrollWeekSource: 'ETIMEOFFICE',
        status: 'SYNC_FAILED',
        fileName: null,
        fileType: null,
        payrollWeekStartDate: utc('2026-11-05'),
        payrollWeekEndDate: utc('2026-11-11'),
      }),
    })
    expect(outcome.outcome).toBe('LOADED')
    expect(db.tx.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-new' },
      data: expect.objectContaining({ status: 'REVIEW' }),
    })
  })
})

// ─── C1: scheduled sync leaves edits alone / replaces unedited pulls ──────────

describe('scheduled sync and edits (C1: E2E-05, E2E-32)', () => {
  it('replaces an earlier pull that has no edits or decisions (E2E-32)', async () => {
    // A partial pull from Monday: all API punches, current equals original.
    db.attendancePunch.findMany.mockResolvedValue(dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04'] }))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome.outcome).toBe('LOADED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.tx.attendancePunch.deleteMany).toHaveBeenCalled()
  })

  it('leaves an edited week alone: no API call, no deletes, staleNoticeAt set, SYNC audit written (E2E-05)', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'p-0', position: 'IN', originalTime: '07:40', currentTime: '07:40' }),
      makePunch({ id: 'p-1', position: 'OUT', pairIndex: 0, originalTime: '17:47', currentTime: '18:00' }),
    ])

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { staleNoticeAt: SCHEDULED_NOW } })
    const [audit] = auditRows(db)
    expect(audit).toMatchObject({ actionType: 'SYNC', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      outcome: 'SKIPPED_HAS_EDITS',
      trigger: 'SCHEDULED',
      summary: 'Scheduled sync skipped: week has edits',
      editedDays: 1,
      decisions: 0,
    })
  })

  it('treats a hand-entered punch as an edit', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'm-0', source: 'MANUAL', originalTime: null, currentTime: '08:00' }),
    ])

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
  })

  it('treats employee decisions alone as enough to leave the week alone', async () => {
    db.attendanceEmployeeDecision.count.mockResolvedValue(2)

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { staleNoticeAt: SCHEDULED_NOW } })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ decisions: 2 })
  })

  it('skips an approved week without calling the API and records why', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_APPROVED' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(auditRows(db)[0]).toMatchObject({ actionType: 'SYNC', entityId: 'upload-1' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_APPROVED', summary: 'Scheduled sync skipped: week is approved' })
  })

  it('skips a week whose payroll is approved or revised without calling the API', async () => {
    db.payrollRun.findFirst.mockResolvedValue({ id: 'run-1' })

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_PAYROLL_APPROVED' })

    expect(db.payrollRun.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: utc('2026-11-05'), status: { in: ['APPROVED', 'REVISED'] } },
      select: { id: true },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_PAYROLL_APPROVED' })
  })

  it('skips an Excel-era week and audits against the Excel row', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload({ id: 'excel-1' }))

    expect(await runScheduledSync(SCHEDULED_NOW)).toEqual({ outcome: 'SKIPPED_EXCEL_ERA' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.attendanceUpload.create).not.toHaveBeenCalled()
    expect(auditRows(db)[0]).toMatchObject({ entityId: 'excel-1' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_EXCEL_ERA' })
  })
})

// ─── US-12.4 / E2E-31: failures change nothing ────────────────────────────────

describe('a failed sync stores nothing and keeps earlier data (US-12.4, E2E-31)', () => {
  const failures: Array<[string, SyncClassification]> = [
    ['an HTTP 500', { ok: false, code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' }],
    ['Error: true', { ok: false, code: 'API_ERROR', message: 'eTimeOffice reported an error: bad login' }],
    ['an unparseable body', { ok: false, code: 'UNPARSEABLE', message: SYNC_FAILURE_COPY.UNPARSEABLE }],
    ['an empty punch list', { ok: false, code: 'EMPTY', message: SYNC_FAILURE_COPY.EMPTY }],
    ['a network error', { ok: false, code: 'NETWORK', message: SYNC_FAILURE_COPY.NETWORK }],
    ['a timeout', { ok: false, code: 'TIMEOUT', message: SYNC_FAILURE_COPY.TIMEOUT }],
    ['missing configuration', { ok: false, code: 'CONFIG_MISSING', message: SYNC_FAILURE_COPY.CONFIG_MISSING }],
  ]

  it.each(failures)('%s: returns FAILED, writes no punches, records the error and releases the lock', async (_label, result) => {
    fetchMock.mockResolvedValue(result)
    const failure = result as Extract<SyncClassification, { ok: false }>

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'FAILED', code: failure.code, message: failure.message })

    // Nothing is replaced.
    expect(db.tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.tx.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceEmployeeDecision.deleteMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(db.attendanceEmployeeDecision.deleteMany).not.toHaveBeenCalled()

    // Only the error and the lock change; the status is not touched.
    expect(db.attendanceUpload.update).toHaveBeenCalledTimes(1)
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { lastSyncError: failure.message, syncLockedAt: null },
    })

    // The failure is audited as a scheduled sync.
    expect(auditRows(db)).toHaveLength(1)
    expect(auditRows(db)[0]).toMatchObject({ actionType: 'SYNC', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({
      outcome: 'FAILED',
      code: failure.code,
      message: failure.message,
      trigger: 'SCHEDULED',
    })
  })

  it('a placeholder week stays SYNC_FAILED after a failed sync (no status write)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'upload-new' }))
    fetchMock.mockResolvedValue({ ok: false, code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })

    await runScheduledSync(SCHEDULED_NOW)

    expect(db.attendanceUpload.create.mock.calls[0][0].data.status).toBe('SYNC_FAILED')
    for (const [arg] of db.attendanceUpload.update.mock.calls) expect(arg.data).not.toHaveProperty('status')
  })

  it('a week that already has punches stays in review after a failed pull (no status write)', async () => {
    fetchMock.mockResolvedValue({ ok: false, code: 'NETWORK', message: SYNC_FAILURE_COPY.NETWORK })

    freezeClock(MANUAL_CLOCK)
    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'NETWORK' })
    for (const [arg] of db.attendanceUpload.update.mock.calls) expect(arg.data).not.toHaveProperty('status')
    expect(auditRows(db)[0]).toMatchObject({ actionType: 'PULL' })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ summary: `Pull failed: ${SYNC_FAILURE_COPY.NETWORK}`, trigger: 'MANUAL' })
  })

  it('treats a response whose scans all fall outside the week as an empty week', async () => {
    fetchMock.mockResolvedValue(loaded(scans('0036', '2026-12-01', ['08:00', '16:00'])))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'FAILED', code: 'EMPTY', message: SYNC_FAILURE_COPY.EMPTY })
    expect(db.tx.attendancePunch.createMany).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { lastSyncError: SYNC_FAILURE_COPY.EMPTY, syncLockedAt: null },
    })
  })

  it('a database failure while saving reports SYNC_FAILED and records it outside the failed transaction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    db.tx.attendancePunch.createMany.mockRejectedValue(new Error('connection reset'))

    const outcome = await runScheduledSync(SCHEDULED_NOW)

    expect(outcome).toEqual({ outcome: 'FAILED', code: 'SYNC_FAILED', message: SYNC_FAILURE_COPY.SYNC_FAILED })
    // The replace ran inside the (rolled back) transaction; the failure is a second, separate write.
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.$transaction.mock.calls[0][0]).toEqual(expect.any(Function))
    expect(Array.isArray(db.$transaction.mock.calls[1][0])).toBe(true)
    // The "loaded" update inside the transaction never ran, and the lock is released by the failure write.
    expect(db.tx.attendanceUpload.update).not.toHaveBeenCalled()
    expect(db.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: { lastSyncError: SYNC_FAILURE_COPY.SYNC_FAILED, syncLockedAt: null },
    })
    expect(auditRows(db)[0].detailsJson).toMatchObject({ outcome: 'FAILED', code: 'SYNC_FAILED' })
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('releases the lock when something unexpected is thrown mid-sync', async () => {
    db.employee.findMany.mockRejectedValue(new Error('database unavailable'))

    await expect(runScheduledSync(SCHEDULED_NOW)).rejects.toThrow('database unavailable')

    expect(db.attendanceUpload.update).toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { syncLockedAt: null } })
  })

  it('does not release the lock a second time after a recorded failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })

    await runScheduledSync(SCHEDULED_NOW)

    const releases = db.attendanceUpload.update.mock.calls.filter(([arg]) => arg.data.syncLockedAt === null)
    expect(releases).toHaveLength(1)
  })
})

// ─── Lock ─────────────────────────────────────────────────────────────────────

describe('sync lock', () => {
  it('turns away a second caller when the lock is held (SYNC_IN_PROGRESS)', async () => {
    db.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(runScheduledSync(SCHEDULED_NOW)).rejects.toMatchObject({
      name: 'AttendanceSyncError',
      code: 'SYNC_IN_PROGRESS',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('takes the lock only when it is free or older than the 5 minute TTL', async () => {
    await runScheduledSync(SCHEDULED_NOW)

    const { where } = db.attendanceUpload.updateMany.mock.calls[0][0]
    expect(where.id).toBe('upload-1')
    expect(where.OR).toEqual([
      { syncLockedAt: null },
      { syncLockedAt: { lt: new Date(SCHEDULED_NOW.getTime() - SYNC_LOCK_TTL_MS) } },
    ])
    expect(SYNC_LOCK_TTL_MS).toBe(5 * 60 * 1000)
  })
})

// ─── pullNow (C2) ─────────────────────────────────────────────────────────────

describe('pullNow', () => {
  beforeEach(() => freezeClock(MANUAL_CLOCK))

  it('loads a week after a failed sync and shows it ready for review (US-12.6)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(
      makeUpload({ status: 'SYNC_FAILED', lastSyncError: 'eTimeOffice returned HTTP 500.' }),
    )

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toEqual({ outcome: 'LOADED', punchCount: 4, discarded: null })
    expect(db.tx.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: 'upload-1' },
      data: expect.objectContaining({ status: 'REVIEW', lastSyncError: null }),
    })
    expect(db.attendanceUpload.updateMany.mock.calls[0][0].data.lastSyncTrigger).toBe('MANUAL')
  })

  it('leaves the week failed on an empty response and stores no punches (US-12.6)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'SYNC_FAILED' }))
    fetchMock.mockResolvedValue({ ok: false, code: 'EMPTY', message: SYNC_FAILURE_COPY.EMPTY })

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })
    expect(db.tx.attendancePunch.createMany).not.toHaveBeenCalled()
    for (const [arg] of db.attendanceUpload.update.mock.calls) expect(arg.data).not.toHaveProperty('status')
  })

  it('replaces a week that has edits and decisions, and the PULL audit keeps what was discarded (C5, E2E-30)', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'e-1', position: 'OUT', originalTime: '17:47', currentTime: '18:00', note: 'Forgot to scan out' }),
      makePunch({ id: 'e-2', pairIndex: 1, position: 'IN', originalTime: null, currentTime: '19:00', source: 'MANUAL' }),
      makePunch({ id: 'e-3', punchDate: utc('2026-11-06'), originalTime: '08:00', currentTime: '08:10' }),
      makePunch({ id: 'ok-1', punchDate: utc('2026-11-07') }),
    ])
    db.tx.attendanceEmployeeDecision.count.mockResolvedValue(2)

    const outcome = await pullNow('2026-11-05')

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 4 })
    // Two employee-days were edited (5 Nov twice counts once, plus 6 Nov).
    if (outcome.outcome !== 'LOADED') throw new Error('expected LOADED')
    expect(outcome.discarded).toMatchObject({ editedDays: 2, decisions: 2 })
    expect(outcome.discarded?.edits.map((e) => e.punchId)).toEqual(['e-1', 'e-2', 'e-3'])
    expect(outcome.discarded?.edits[0]).toMatchObject({
      date: '2026-11-05',
      position: 'OUT',
      original: '17:47',
      current: '18:00',
      note: 'Forgot to scan out',
    })

    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'PULL', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({ trigger: 'MANUAL', outcome: 'LOADED', summary: 'Pull loaded 4 punches' })
    expect(audit.detailsJson.discarded).toMatchObject({ editedDays: 2, decisions: 2 })
    expect(audit.detailsJson.discarded.edits).toHaveLength(3)
    // The old decisions are removed with the old punches.
    expect(db.tx.attendanceEmployeeDecision.deleteMany).toHaveBeenCalled()
  })

  it('caps the discarded edits stored in the audit row at 500 but reports the full counts', async () => {
    const edited = Array.from({ length: 520 }, (_, i) =>
      makePunch({ id: `e-${i}`, employeeId: `emp-${i}`, originalTime: '08:00', currentTime: '09:00' }),
    )
    db.tx.attendancePunch.findMany.mockResolvedValue(edited)

    await pullNow('2026-11-05')

    const [audit] = auditRows(db.tx)
    expect(audit.detailsJson.discarded.editedDays).toBe(520)
    expect(audit.detailsJson.discarded.edits).toHaveLength(500)
  })

  it('does not check for edits first: a manual pull goes ahead on an edited week', async () => {
    db.tx.attendancePunch.findMany.mockResolvedValue([makePunch({ originalTime: '08:00', currentTime: '09:00' })])

    const outcome = await pullNow('2026-11-05')

    expect(outcome.outcome).toBe('LOADED')
    expect(db.attendanceUpload.update).not.toHaveBeenCalledWith({ where: { id: 'upload-1' }, data: { staleNoticeAt: expect.anything() } })
  })

  it('pulls an in-progress week', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'upload-new' }))
    fetchMock.mockResolvedValue(loaded(scans('0036', '2026-11-12', ['08:00', '16:00'])))

    const outcome = await pullNow('2026-11-12')

    expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 2 })
    expect(fetchMock).toHaveBeenCalledWith({ start: '2026-11-12', end: '2026-11-18' })
  })

  it('refuses an approved week until it is reopened (WEEK_APPROVED)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'APPROVED' }))

    await expect(pullNow('2026-11-05')).rejects.toMatchObject({ code: 'WEEK_APPROVED' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('refuses a week whose payroll is approved (PAYROLL_ALREADY_APPROVED)', async () => {
    db.payrollRun.findFirst.mockResolvedValue(makeRun({ status: 'REVISED' }))

    await expect(pullNow('2026-11-05')).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_APPROVED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an Excel-era week (EXCEL_ERA_WEEK)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())

    await expect(pullNow('2026-11-05')).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a week that has not started yet (FUTURE_WEEK)', async () => {
    await expect(pullNow('2026-11-19')).rejects.toMatchObject({ code: 'FUTURE_WEEK' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.attendanceUpload.create).not.toHaveBeenCalled()
  })

  it.each(['2026-11-06', '2026-11-04', 'garbage', '2026-13-05', ''])('rejects %j as not a Thursday week (INVALID_WEEK)', async (weekStart) => {
    await expect(pullNow(weekStart)).rejects.toMatchObject({ code: 'INVALID_WEEK' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.attendanceUpload.findFirst).not.toHaveBeenCalled()
  })

  it('throws AttendanceSyncError instances (so the action layer can map them)', async () => {
    await expect(pullNow('2026-11-06')).rejects.toBeInstanceOf(AttendanceSyncError)
  })
})

describe('syncWeek input checks', () => {
  it('rejects a range that is not Thursday to Wednesday (INVALID_WEEK)', async () => {
    await expect(
      syncWeek({ week: { start: '2026-11-05', end: '2026-11-10' }, trigger: 'MANUAL', now: SCHEDULED_NOW }),
    ).rejects.toMatchObject({ code: 'INVALID_WEEK' })
  })

  it('judges "future" by the IST calendar day of `now`', async () => {
    // 11 Nov 20:00 UTC is already 12 Nov 01:30 IST, so the 12-18 Nov week has started.
    fetchMock.mockResolvedValue(loaded(scans('0036', '2026-11-12', ['08:00', '16:00'])))
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'upload-new' }))

    await expect(
      syncWeek({ week: { start: '2026-11-12', end: '2026-11-18' }, trigger: 'MANUAL', now: new Date('2026-11-11T20:00:00Z') }),
    ).resolves.toMatchObject({ outcome: 'LOADED' })

    await expect(
      syncWeek({ week: { start: '2026-11-12', end: '2026-11-18' }, trigger: 'MANUAL', now: new Date('2026-11-11T17:00:00Z') }),
    ).rejects.toMatchObject({ code: 'FUTURE_WEEK' })
  })
})

// ─── weekHasEditsOrDecisions / getPullWarning (C2) ────────────────────────────

describe('weekHasEditsOrDecisions', () => {
  it('reports nothing for untouched API punches and no decisions', async () => {
    db.attendancePunch.findMany.mockResolvedValue(dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }))

    expect(await weekHasEditsOrDecisions('upload-1')).toEqual({ hasEdits: false, editedDays: 0, decisions: 0, edits: [] })
  })

  it('reads only the live set (correction clones are not edits of the pull)', async () => {
    await weekHasEditsOrDecisions('upload-1')

    expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attendanceUploadId: 'upload-1', correctionId: null } }),
    )
    expect(db.attendanceEmployeeDecision.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1' } })
  })

  it('counts edited days per employee-day, not per punch, and lists each edited punch', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'a', originalTime: '07:40', currentTime: '07:45', employee: { employeeId: 'TPLGOAHLP036' } } as never),
      makePunch({ id: 'b', position: 'OUT', originalTime: '17:47', currentTime: null, employee: { employeeId: 'TPLGOAHLP036' } } as never),
      makePunch({ id: 'c', employeeId: 'emp-5', punchDate: utc('2026-11-05'), originalTime: '08:00', currentTime: '09:00', employee: { employeeId: 'TPLGOAHLP005' } } as never),
      makePunch({ id: 'd', punchDate: utc('2026-11-06'), source: 'MANUAL', originalTime: null, currentTime: '08:00', employee: { employeeId: 'TPLGOAHLP036' } } as never),
      makePunch({ id: 'untouched', punchDate: utc('2026-11-07') }),
    ])
    db.attendanceEmployeeDecision.count.mockResolvedValue(1)

    const result = await weekHasEditsOrDecisions('upload-1')

    expect(result.hasEdits).toBe(true)
    expect(result.editedDays).toBe(3) // emp-36 on 5 Nov, emp-5 on 5 Nov, emp-36 on 6 Nov
    expect(result.decisions).toBe(1)
    expect(result.edits.map((e) => e.punchId)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.edits[1]).toMatchObject({ employeeCode: 'TPLGOAHLP036', original: '17:47', current: null, position: 'OUT' })
  })

  it('keys unlinked punches by their code so one code is one day', async () => {
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'u1', employeeId: null, empCode: '0999', matchStatus: 'UNKNOWN', originalTime: '08:00', currentTime: '08:05' }),
      makePunch({ id: 'u2', employeeId: null, empCode: '0999', matchStatus: 'UNKNOWN', position: 'OUT', originalTime: '17:00', currentTime: '17:05' }),
    ])

    const result = await weekHasEditsOrDecisions('upload-1')

    expect(result.editedDays).toBe(1)
    expect(result.edits[0].employeeCode).toBeNull()
  })
})

describe('getPullWarning (C2)', () => {
  it('has no data and nothing to discard when the week has no row', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: false, editedDays: 0, decisions: 0 })
    expect(db.attendancePunch.count).not.toHaveBeenCalled()
  })

  it('has no data for an Excel-era week', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: false, editedDays: 0, decisions: 0 })
  })

  it('has data but nothing to warn about for an unedited pull', async () => {
    db.attendancePunch.count.mockResolvedValue(8)

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: true, editedDays: 0, decisions: 0 })
  })

  it('counts the edited days and decisions the pull would discard', async () => {
    db.attendancePunch.count.mockResolvedValue(40)
    db.attendancePunch.findMany.mockResolvedValue([
      makePunch({ id: 'a', originalTime: '07:40', currentTime: '07:45' }),
      makePunch({ id: 'b', punchDate: utc('2026-11-06'), originalTime: '07:40', currentTime: '07:45' }),
    ])
    db.attendanceEmployeeDecision.count.mockResolvedValue(3)

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: true, editedDays: 2, decisions: 3 })
  })

  it('reports no data for a SYNC_FAILED placeholder with no punches', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'SYNC_FAILED' }))
    db.attendancePunch.count.mockResolvedValue(0)

    expect(await getPullWarning('2026-11-05')).toEqual({ hasData: false, editedDays: 0, decisions: 0 })
  })
})

describe('week fixture sanity', () => {
  it('uses the 5-11 Nov week for every sync test', () => {
    expect(WEEK).toEqual({ start: '2026-11-05', end: '2026-11-11' })
  })
})
