// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import { approveWeek, reopenWeek } from '@/features/attendance-sync/services/week-approval.service'
import {
  ignoreCode,
  matchCodeToEmployee,
  rematchWeekCodes,
  setEmployeeDecision,
} from '@/features/attendance-sync/services/employee-check.service'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import type { SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makeUpload,
  mockLockedWeek,
  resetDb,
  serveEmployeeLookup,
  serveUpload,
  utc,
  type Db,
  type PunchStore,
} from './service-fixtures'

// Fix round, items 3 and 6: every writer of a week takes the row lock first, inside one interactive
// transaction, re-reads what it needs through that same client, and refuses while a pull is running.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const NOW = '2026-11-13T03:00:00Z' // the 5-11 Nov week has ended
const SYNC_IN_PROGRESS_COPY = 'A pull is running for this week. Wait for it to finish, then try again.'

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })

const freshLock = () => new Date(Date.now() - 60_000)
const staleLock = () => new Date(Date.now() - SYNC_LOCK_TTL_MS - 1000)

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

function serveEmployees(employees: ReturnType<typeof makeEmployee>[]) {
  db.employee.findMany.mockResolvedValue(employees)
  db.tx.employee.findMany.mockResolvedValue(employees)
  // savePunchEdit looks the employee up again inside its transaction.
  serveEmployeeLookup(db, employees)
}

function seedWeek(extra: ReturnType<typeof dayPunches> = []) {
  store = installPunchStore(db, [
    ...dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }),
    ...extra,
  ])
  serveEmployees([asha, ravi])
}

function writes(client: Db | Db['tx']) {
  return [
    client.attendanceUpload.updateMany,
    client.attendanceRecord.deleteMany,
    client.attendanceRecord.createMany,
    client.attendancePunch.create,
    client.attendancePunch.update,
    client.attendancePunch.delete,
    client.auditLog.create,
  ]
}

function expectNothingWritten() {
  for (const client of [db, db.tx]) for (const write of writes(client)) expect(write).not.toHaveBeenCalled()
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock(NOW)
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  seedWeek()
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── approveWeek (items 3 and 6) ──────────────────────────────────────────────

describe('approveWeek under the week lock', () => {
  it('takes the row lock first, then reads the grid through the transaction, then writes (lock < reads < updateMany)', async () => {
    await approveWeek(WEEK_ID)

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    const lock = order(db.tx.$queryRaw)
    const punchRead = order(db.tx.attendancePunch.findMany)
    const employeeRead = order(db.tx.employee.findMany)
    const decisionRead = order(db.tx.attendanceEmployeeDecision.findMany)
    const claim = order(db.tx.attendanceUpload.updateMany)
    for (const read of [punchRead, employeeRead, decisionRead]) {
      expect(lock).toBeLessThan(read)
      expect(read).toBeLessThan(claim)
    }
    expect(claim).toBeLessThan(order(db.tx.attendanceRecord.createMany))
  })

  it('runs in one transaction and reads the review only on the transaction client', async () => {
    await approveWeek(WEEK_ID)

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    // Before the transaction only the week row is resolved; nothing about the grid is read outside it.
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(db.employee.findMany).not.toHaveBeenCalled()
    expect(db.attendanceEmployeeDecision.findMany).not.toHaveBeenCalled()
    expect(db.payrollRun.findFirst).not.toHaveBeenCalled()
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('builds the records from the punches the transaction reads, not from an earlier read (a punch edited in between is included)', async () => {
    // An edit that landed before the lock was granted: only the transaction's read can see it.
    const lateEdit = dayPunches({ idPrefix: 'late', employeeId: 'emp-36', date: '2026-11-06', times: ['08:00', '12:00'] })
    db.tx.attendancePunch.findMany.mockResolvedValue([...store.rows, ...lateEdit])
    db.attendancePunch.findMany.mockResolvedValue(store.rows)

    await approveWeek(WEEK_ID)

    const { data } = db.tx.attendanceRecord.createMany.mock.calls[0][0]
    const friday = data.find(
      (r: { employeeId: string; attendanceDate: Date }) =>
        r.employeeId === 'emp-36' && r.attendanceDate.toISOString().startsWith('2026-11-06'),
    )
    expect(friday).toMatchObject({ regularHours: 4, overtimeHours: 0 })
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('refuses with WEEK_NOT_IN_REVIEW when the locked row is already APPROVED, and writes nothing', async () => {
    // Pre-transaction read says REVIEW; by the time the lock is granted another approve has committed.
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-13T02:59:00Z') })

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expectNothingWritten()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('refuses with WEEK_NOT_IN_REVIEW when the locked row is gone', async () => {
    mockLockedWeek(db.tx, null)

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })
    expectNothingWritten()
  })

  it('refuses with SYNC_IN_PROGRESS while a pull holds a fresh lock, reading and writing nothing more', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: freshLock() })

    const error = await approveWeek(WEEK_ID).catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_COPY })
    expectNothingWritten()
    expect(db.tx.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('proceeds when the pull lock is stale (older than SYNC_LOCK_TTL_MS)', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: staleLock() })

    await expect(approveWeek(WEEK_ID)).resolves.toMatchObject({ approvedAt: expect.any(Date) })
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledTimes(1)
  })

  it('proceeds when there is no pull lock', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: null })

    await expect(approveWeek(WEEK_ID)).resolves.toMatchObject({ approvedAt: expect.any(Date) })
  })

  it('writes nothing when a blocker shows up in the transaction read (incomplete pair): the transaction opens, nothing is written', async () => {
    seedWeek(dayPunches({ idPrefix: 'lone', employeeId: 'emp-36', date: '2026-11-06', times: ['18:26'] }))

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expectNothingWritten()
  })

  it('writes nothing when the week turns out not to have ended', async () => {
    freezeClock('2026-11-10T03:00:00Z')

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_ENDED' })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNothingWritten()
  })

  it('claims the week with the compare-and-set, so a second approval that slipped through still loses', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })
    expect(db.tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

// ─── reopenWeek (item 4: payroll approval races a reopen) ─────────────────────

describe('reopenWeek under the week lock', () => {
  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  })

  it('locks the row, re-reads the payroll run through the transaction, and only then moves the week', async () => {
    await reopenWeek(WEEK_ID)

    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.tx.payrollRun.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: utc('2026-11-05'), status: { in: ['APPROVED', 'REVISED'] } },
      select: { id: true },
    })
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.payrollRun.findFirst))
    expect(order(db.tx.payrollRun.findFirst)).toBeLessThan(order(db.tx.attendanceUpload.updateMany))
    expect(order(db.tx.attendanceUpload.updateMany)).toBeLessThan(order(db.tx.attendanceRecord.deleteMany))
  })

  it.each(['APPROVED', 'REVISED'])(
    'refuses with PAYROLL_ALREADY_APPROVED when payroll was %s while the reopen waited for the lock (nothing is deleted)',
    async (status) => {
      // The pre-transaction check found no run; the one inside the transaction finds it.
      db.payrollRun.findFirst.mockResolvedValue(null)
      db.tx.payrollRun.findFirst.mockResolvedValue({ id: 'run-1', status })

      const error = await reopenWeek(WEEK_ID).catch((e: { code: string; message: string }) => e)

      expect(error).toMatchObject({ code: 'PAYROLL_ALREADY_APPROVED' })
      expect(db.$transaction).toHaveBeenCalledTimes(1)
      expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
      expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
      expect(auditRows(db.tx)).toHaveLength(0)
    },
  )

  it('still reopens when the in-transaction read finds no run', async () => {
    db.tx.payrollRun.findFirst.mockResolvedValue(null)

    await expect(reopenWeek(WEEK_ID)).resolves.toMatchObject({ reopenedAt: expect.any(Date) })
    expect(db.tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1' } })
  })
})

// ─── savePunchEdit, live mode (items 3 and 6) ─────────────────────────────────

describe('savePunchEdit in live mode under the week lock', () => {
  const pair = (pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair => ({ pairIndex, in: inn, out })
  const changed = (): SavePair[] => [
    pair(0, { punchId: 'p-0', time: '07:40' }, { punchId: 'p-1', time: '13:04' }),
    pair(1, { punchId: 'p-2', time: '13:56' }, { punchId: 'p-3', time: '18:00' }),
  ]
  const unchanged = (): SavePair[] => [
    pair(0, { punchId: 'p-0', time: '07:40' }, { punchId: 'p-1', time: '13:04' }),
    pair(1, { punchId: 'p-2', time: '13:56' }, { punchId: 'p-3', time: '17:47' }),
  ]
  const save = (pairs: SavePair[]) =>
    savePunchEdit({ weekId: WEEK_ID, employeeId: 'emp-36', date: '2026-11-05', mode: { kind: 'LIVE' }, pairs })

  it('writes inside one interactive transaction that starts with the row lock (lock < update < audit)', async () => {
    await save(changed())

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.attendancePunch.update))
    expect(order(db.tx.attendancePunch.update)).toBeLessThan(order(db.tx.auditLog.create))
    // Nothing is written on the plain client.
    expect(db.attendancePunch.update).not.toHaveBeenCalled()
    expect(db.auditLog.create).not.toHaveBeenCalled()
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('does not touch a correction session in live mode', async () => {
    await save(changed())

    expect(db.tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(db.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('refuses with WEEK_LOCKED when the locked row is APPROVED although the earlier read said REVIEW, and writes nothing', async () => {
    mockLockedWeek(db.tx, { status: 'APPROVED', approvedAt: new Date('2026-11-13T02:59:00Z') })

    await expect(save(changed())).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

    expectNothingWritten()
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')
  })

  it.each(['SYNC_FAILED', 'READY'])('refuses with WEEK_LOCKED when the locked row is %s (only REVIEW is editable)', async (status) => {
    mockLockedWeek(db.tx, { status })

    await expect(save(changed())).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expectNothingWritten()
  })

  it('refuses with WEEK_NOT_READY when the locked row is gone', async () => {
    mockLockedWeek(db.tx, null)

    await expect(save(changed())).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
    expectNothingWritten()
  })

  it('refuses with SYNC_IN_PROGRESS while a pull holds a fresh lock, and writes nothing', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: freshLock() })

    const error = await save(changed()).catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_COPY })
    expectNothingWritten()
  })

  it('saves when the pull lock is stale', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: staleLock() })

    await expect(save(changed())).resolves.toMatchObject({ day: { isEdited: true } })
    expect(db.tx.attendancePunch.update).toHaveBeenCalledTimes(1)
  })

  it('saves when there is no pull lock', async () => {
    mockLockedWeek(db.tx, { syncLockedAt: null })

    await expect(save(changed())).resolves.toMatchObject({ day: { isEdited: true } })
  })

  it('opens no transaction and takes no lock when nothing changed', async () => {
    await save(unchanged())

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('a validation failure opens no transaction and takes no lock', async () => {
    await expect(save([pair(0, { punchId: 'p-0', time: '17:00' }, { punchId: 'p-1', time: '08:00' })])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('a failing write inside the transaction is not reported as saved', async () => {
    db.tx.attendancePunch.update.mockRejectedValue(new Error('deadlock detected'))

    await expect(save(changed())).rejects.toThrow('deadlock detected')
    expect(db.tx.auditLog.create).not.toHaveBeenCalled()
  })
})

// ─── Employee check: codes and decisions (item 3) ─────────────────────────────

describe('employee check refuses while a pull is running', () => {
  const inactive = {
    id: 'emp-2',
    employeeId: 'TPLGOAHLP002',
    employeeName: 'Old Timer',
    isActive: false,
    dateOfResignation: null,
  }

  beforeEach(() => {
    db.employee.findMany.mockResolvedValue([asha, makeEmployee({ ...inactive })])
    db.employee.findUnique.mockResolvedValue({ ...inactive, id: 'emp-36' })
    db.attendancePunch.count.mockResolvedValue(4)
    db.tx.attendanceCodeException.findUnique.mockResolvedValue(null)
    db.tx.attendanceCodeException.upsert.mockResolvedValue({ id: 'exception-1' })
    db.tx.attendancePunch.findMany.mockResolvedValue([])
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 0 })
    db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue(null)
    db.tx.attendanceEmployeeDecision.create.mockResolvedValue({ id: 'decision-1' })
  })

  const actions: Array<[string, () => Promise<unknown>]> = [
    ['setEmployeeDecision', () => setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')],
    ['matchCodeToEmployee', () => matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')],
    ['ignoreCode', () => ignoreCode(WEEK_ID, '0999')],
    ['rematchWeekCodes', () => rematchWeekCodes(WEEK_ID)],
  ]

  it.each(actions)('%s: SYNC_IN_PROGRESS for a fresh pull lock, with nothing read or written', async (_name, run) => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: freshLock() }))

    const error = await run().catch((e: { code: string; message: string }) => e)

    expect(error).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_COPY })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.attendancePunch.count).not.toHaveBeenCalled()
    expect(db.employee.findUnique).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it.each(actions)('%s: still refuses an approved week with WEEK_LOCKED first', async (_name, run) => {
    db.attendanceUpload.findFirst.mockResolvedValue(
      makeUpload({ status: 'APPROVED', syncLockedAt: freshLock(), approvedAt: new Date('2026-11-12T05:00:00Z') }),
    )

    await expect(run()).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
  })

  it('setEmployeeDecision proceeds when the lock is stale', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: staleLock() }))
    db.employee.findUnique.mockResolvedValue({ ...inactive })

    await expect(setEmployeeDecision(WEEK_ID, 'emp-2', 'APPROVED')).resolves.toEqual({ decision: 'APPROVED' })
    expect(db.tx.attendanceEmployeeDecision.create).toHaveBeenCalledTimes(1)
  })

  it('setEmployeeDecision proceeds when there is no lock', async () => {
    db.employee.findUnique.mockResolvedValue({ ...inactive })

    await expect(setEmployeeDecision(WEEK_ID, 'emp-2', 'REJECTED')).resolves.toEqual({ decision: 'REJECTED' })
  })

  it('matchCodeToEmployee proceeds when the lock is stale', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ status: 'REVIEW', syncLockedAt: staleLock() }))
    db.employee.findUnique.mockResolvedValue({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
    db.tx.attendancePunch.findMany.mockImplementation(async ({ where }: { where: { empCode?: string } }) =>
      where.empCode ? [{ id: 'u1-0', punchDate: utc('2026-11-05'), pairIndex: 0 }] : [],
    )
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 1 })

    await expect(matchCodeToEmployee(WEEK_ID, '0999', 'emp-36')).resolves.toEqual({ linkedPunches: 1 })
  })

  it('ignoreCode proceeds when there is no lock', async () => {
    db.tx.attendancePunch.updateMany.mockResolvedValue({ count: 4 })

    await expect(ignoreCode(WEEK_ID, '0999')).resolves.toEqual({ ignoredPunches: 4 })
  })
})
