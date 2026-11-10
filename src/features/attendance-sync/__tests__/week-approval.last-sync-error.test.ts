// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceUpload } from '@prisma/client'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { approveWeek, reopenWeek } from '@/features/attendance-sync/services/week-approval.service'
import { SYNC_FAILURE_COPY } from '@/features/attendance-sync/lib/etimeoffice/parser'
import {
  auditRows,
  dayPunches,
  freezeClock,
  installPunchStore,
  lockedRow,
  makeEmployee,
  makeRun,
  makeUpload,
  resetDb,
  type Db,
} from './service-fixtures'

// Fix round 3, item 7: approving or reopening a week is a fresh start, so a pull error recorded before it
// ("Last pull failed: ...") is cleared. The case that matters: a pull that lost the race to an approval
// writes WEEK_CHANGED onto the then-approved row; after a reopen the review list must not show it.
//
// The upload row is held in a tiny store here: the updateMany mock applies `data` to it when `where` matches,
// so these tests check what ends up on the row, not only which arguments were passed.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']
const OLD_PULL_ERROR = 'Could not reach eTimeOffice. Nothing was replaced.'
const WEEK_CHANGED_COPY = SYNC_FAILURE_COPY.WEEK_CHANGED

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })

let row: AttendanceUpload

/** Serve `row` (as it is at each read) to both clients, lock it, and apply updateMany's `data` to it. */
function installRowStore(initial: AttendanceUpload) {
  row = initial
  const read = async () => ({ ...row })
  db.attendanceUpload.findFirst.mockImplementation(read)
  db.tx.attendanceUpload.findFirst.mockImplementation(read)
  db.tx.$queryRaw.mockImplementation(async () => [
    lockedRow({ id: row.id, source: row.source, status: row.status, syncLockedAt: row.syncLockedAt, approvedAt: row.approvedAt }),
  ])
  db.tx.attendanceUpload.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Partial<AttendanceUpload> }) => {
      const matches = Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value)
      if (!matches) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
  )
}

/** Asha works one full day: nothing blocks the approval. */
function seedCleanWeek() {
  installPunchStore(db, dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }))
  db.employee.findMany.mockResolvedValue([asha])
  db.tx.employee.findMany.mockResolvedValue([asha])
}

/** The same day with a lone IN: the review has a day that needs fixing, so approval is refused. */
function seedBlockedWeek() {
  installPunchStore(db, dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04', '13:56'] }))
  db.employee.findMany.mockResolvedValue([asha])
  db.tx.employee.findMany.mockResolvedValue([asha])
}

/** Every write the two services could make to the upload row, other than the guarded updateMany. */
function expectNoOtherUploadWrites() {
  expect(db.attendanceUpload.update).not.toHaveBeenCalled()
  expect(db.attendanceUpload.updateMany).not.toHaveBeenCalled()
  expect(db.tx.attendanceUpload.update).not.toHaveBeenCalled()
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetDb(db)
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock('2026-11-13T03:00:00Z') // the 5-11 Nov week has ended
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── approveWeek ──────────────────────────────────────────────────────────────

describe('approveWeek clears an earlier pull error', () => {
  beforeEach(() => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'REVIEW', lastSyncError: OLD_PULL_ERROR }))
    seedCleanWeek()
  })

  it('the approved row no longer carries the error, and its status and approval time are set in the same write', async () => {
    const { approvedAt } = await approveWeek(WEEK_ID)

    expect(row.lastSyncError).toBeNull()
    expect(row.status).toBe('APPROVED')
    expect(row.approvedAt).toEqual(approvedAt)
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'upload-1', status: 'REVIEW' },
      data: { status: 'APPROVED', approvedAt, lastSyncError: null, staleNoticeAt: null, approvedLeftOutCount: 0 },
    })
    expectNoOtherUploadWrites()
  })

  it('clears the stale notice too, and does not touch the other pull bookkeeping (last pull time, trigger)', async () => {
    const lastSyncedAt = new Date('2026-11-12T01:00:00Z')
    installRowStore(
      makeUpload({
        id: 'upload-1',
        status: 'REVIEW',
        lastSyncError: OLD_PULL_ERROR,
        lastSyncedAt,
        lastSyncTrigger: 'SCHEDULED',
        staleNoticeAt: new Date('2026-11-12T02:00:00Z'),
      }),
    )

    await approveWeek(WEEK_ID)

    expect(row.lastSyncError).toBeNull()
    expect(row.lastSyncedAt).toEqual(lastSyncedAt)
    expect(row.lastSyncTrigger).toBe('SCHEDULED')
    expect(row.staleNoticeAt).toBeNull()
  })

  it('a row that never had an error is approved with the error still null', async () => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'REVIEW', lastSyncError: null }))

    await approveWeek(WEEK_ID)

    expect(row).toMatchObject({ status: 'APPROVED', lastSyncError: null })
  })

  it('an approval that is refused for content (a day needs fixing) leaves the error on the row', async () => {
    seedBlockedWeek()

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect(row).toMatchObject({ status: 'REVIEW', lastSyncError: OLD_PULL_ERROR, approvedAt: null })
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('a double approve that loses the race throws and clears nothing', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expect(row.lastSyncError).toBe(OLD_PULL_ERROR)
    expect(row.status).toBe('REVIEW')
    expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expectNoOtherUploadWrites()
  })

  it('a week that failed to load (SYNC_FAILED) is refused and its error is left for the user to see', async () => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'SYNC_FAILED', lastSyncError: OLD_PULL_ERROR }))

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect(row).toMatchObject({ status: 'SYNC_FAILED', lastSyncError: OLD_PULL_ERROR })
    expectNoOtherUploadWrites()
    expect(auditRows(db.tx)).toHaveLength(0)
  })
})

// ─── reopenWeek ───────────────────────────────────────────────────────────────

describe('reopenWeek clears an earlier pull error', () => {
  const approvedAt = new Date('2026-11-12T05:00:00Z')

  beforeEach(() => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'APPROVED', approvedAt, lastSyncError: WEEK_CHANGED_COPY }))
  })

  it('a reopen after a WEEK_CHANGED failure leaves the row in REVIEW with no error', async () => {
    expect(WEEK_CHANGED_COPY).toBe('The week was approved while the pull was running. Nothing was replaced.')

    await reopenWeek(WEEK_ID)

    expect(row).toMatchObject({ status: 'REVIEW', approvedAt: null, lastSyncError: null })
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledTimes(1)
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'upload-1', status: 'APPROVED' },
      data: { status: 'REVIEW', approvedAt: null, lastSyncError: null, staleNoticeAt: null, approvedLeftOutCount: null },
    })
    expectNoOtherUploadWrites()
  })

  it('the clear happens in the same transaction as the reopen: lock, payroll re-check, then the update, records, audit', async () => {
    await reopenWeek(WEEK_ID)

    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0]
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.payrollRun.findFirst))
    expect(order(db.tx.payrollRun.findFirst)).toBeLessThan(order(db.tx.attendanceUpload.updateMany))
    expect(order(db.tx.attendanceUpload.updateMany)).toBeLessThan(order(db.tx.attendanceRecord.deleteMany))
    expect(order(db.tx.attendanceRecord.deleteMany)).toBeLessThan(order(db.tx.auditLog.create))
  })

  it('a double reopen that loses the race throws and leaves the error as it was', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expect(row).toMatchObject({ status: 'APPROVED', lastSyncError: WEEK_CHANGED_COPY })
    expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)).toHaveLength(0)
    expectNoOtherUploadWrites()
  })

  it('payroll approved in the meantime refuses the reopen and the row keeps its approval and its error', async () => {
    db.tx.payrollRun.findFirst.mockResolvedValue(makeRun({ status: 'APPROVED' }))

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_APPROVED' })

    expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
    expect(row).toMatchObject({ status: 'APPROVED', approvedAt, lastSyncError: WEEK_CHANGED_COPY })
  })

  it.each(['REVIEW', 'SYNC_FAILED'])(
    'a %s week has nothing to reopen: refused before any transaction, and its error is untouched',
    async (status) => {
      installRowStore(makeUpload({ id: 'upload-1', status, lastSyncError: OLD_PULL_ERROR }))

      await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

      expect(db.$transaction).not.toHaveBeenCalled()
      expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
      expect(row).toMatchObject({ status, lastSyncError: OLD_PULL_ERROR })
    },
  )
})

// ─── The sequence that motivated the change ───────────────────────────────────

describe('approve, a pull that loses the race, then reopen', () => {
  it('shows no "Last pull failed" text after the reopen', async () => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'REVIEW', lastSyncError: OLD_PULL_ERROR }))
    seedCleanWeek()

    // 1. The week is approved; the error from an earlier pull goes with it.
    await approveWeek(WEEK_ID)
    expect(row).toMatchObject({ status: 'APPROVED', lastSyncError: null })

    // 2. A pull that was already running finds the week approved and records WEEK_CHANGED on the approved row
    //    (this is what sync.service's recordFailure writes).
    row.lastSyncError = WEEK_CHANGED_COPY
    expect(row.status).toBe('APPROVED')

    // 3. Reopening starts the review again without that message.
    await reopenWeek(WEEK_ID)
    expect(row).toMatchObject({ status: 'REVIEW', approvedAt: null, lastSyncError: null })
  })

  it('harness check: the row changes only through the guarded write, so the assertions above observe its `data`', async () => {
    installRowStore(makeUpload({ id: 'upload-1', status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z'), lastSyncError: WEEK_CHANGED_COPY }))
    // Replace the guarded update with one that reports success but applies nothing: the row keeps its error.
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })

    await reopenWeek(WEEK_ID)

    expect(row.lastSyncError).toBe(WEEK_CHANGED_COPY)
    expect(row.status).toBe('APPROVED')
  })
})
