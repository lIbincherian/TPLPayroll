// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// listAttendanceWeeks(today, { includeReviewStats }): counts for weeks in review need a review grid per week
// (employees, decisions and about 4k punches each). The payroll page shows no such counts, so it passes
// `includeReviewStats: false` and those weeks report zeros without any of that being read. Nothing else
// about the list changes.

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { listAttendanceWeeks } from '@/features/attendance-sync/services/week-list.service'
import { dayPunches, freezeClock, makeEmployee, makeUpload, resetDb, utc, type Db } from './service-fixtures'

const db = prisma as unknown as Db

const TODAY = '2026-11-12'
const ZERO_COUNTS = {
  employeeCount: 0,
  totalRegularHours: 0,
  totalOvertimeHours: 0,
  unresolvedCodes: 0,
  pendingDecisions: 0,
  needsFixingDays: 0,
}

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })

/** One week in review with 8 regular and 1.25 overtime hours, one unresolved code and one incomplete day. */
function serveReviewWeek() {
  db.attendanceUpload.findMany.mockResolvedValue([
    makeUpload({ id: 'upload-1', status: 'REVIEW', staleNoticeAt: new Date('2026-11-12T00:30:00Z'), lastSyncError: 'eTimeOffice returned HTTP 500.' }),
  ])
  db.employee.findMany.mockResolvedValue([asha])
  db.attendancePunch.findMany.mockResolvedValue([
    ...dayPunches({ idPrefix: 'a', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04', '13:56', '17:47'] }),
    ...dayPunches({ idPrefix: 'a2', employeeId: 'emp-36', date: '2026-11-06', times: ['18:26'] }),
    ...dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN' }),
  ])
}

beforeEach(() => {
  resetDb(db)
  freezeClock('2026-11-12T01:00:00Z')
})
afterEach(() => vi.useRealTimers())

describe('listAttendanceWeeks, includeReviewStats', () => {
  it.each([
    ['no options', undefined],
    ['an empty options object', {}],
    ['includeReviewStats: true', { includeReviewStats: true }],
    ['includeReviewStats: undefined', { includeReviewStats: undefined }],
  ])('%s: the counts of a week in review are computed (8 + 0 regular, 1.25 overtime, 1 unresolved code, 1 day to fix)', async (_label, options) => {
    serveReviewWeek()

    const item = (await listAttendanceWeeks(TODAY, options)).find((i) => i.weekId === '2026-11-05')!

    expect(item).toMatchObject({
      status: 'REVIEW',
      employeeCount: 1,
      totalRegularHours: 8,
      totalOvertimeHours: 1.25,
      unresolvedCodes: 1,
      needsFixingDays: 1,
    })
    expect(db.employee.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendancePunch.findMany).toHaveBeenCalledTimes(1)
    expect(db.attendanceEmployeeDecision.findMany).toHaveBeenCalledTimes(1)
  })

  it('includeReviewStats: false reports zero counts for the week in review and reads no employees, decisions or punches', async () => {
    serveReviewWeek()

    const item = (await listAttendanceWeeks(TODAY, { includeReviewStats: false })).find((i) => i.weekId === '2026-11-05')!

    expect(item).toMatchObject({ status: 'REVIEW', ...ZERO_COUNTS })
    expect(db.employee.findMany).not.toHaveBeenCalled()
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(db.attendanceEmployeeDecision.findMany).not.toHaveBeenCalled()
  })

  it('everything except those six counts is the same with the option off', async () => {
    serveReviewWeek()
    const full = await listAttendanceWeeks(TODAY)
    const lean = await listAttendanceWeeks(TODAY, { includeReviewStats: false })

    expect(lean).toHaveLength(full.length)
    expect(lean).toEqual(full.map((item) => (item.status === 'REVIEW' ? { ...item, ...ZERO_COUNTS } : item)))
    // in particular the flags the payroll page builds its rows from
    const review = lean.find((i) => i.weekId === '2026-11-05')!
    expect(review).toMatchObject({
      canPullNow: true,
      canReopen: false,
      staleNoticeAt: '2026-11-12T00:30:00.000Z',
      lastSyncError: 'eTimeOffice returned HTTP 500.',
      hasEnded: true,
      payrollStatus: 'NOT_GENERATED',
    })
  })

  it('an approved week keeps its record counts with the option off (it needs no review grid)', async () => {
    db.attendanceUpload.findMany.mockResolvedValue([
      makeUpload({ id: 'u-review', status: 'REVIEW', payrollWeekStartDate: utc('2026-11-12'), payrollWeekEndDate: utc('2026-11-18') }),
      makeUpload({ id: 'u-approved', status: 'APPROVED', approvedAt: new Date() }),
    ])
    db.attendanceRecord.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by.includes('employeeId')
        ? [
            { attendanceUploadId: 'u-approved', employeeId: 'e1' },
            { attendanceUploadId: 'u-approved', employeeId: 'e2' },
          ]
        : [{ attendanceUploadId: 'u-approved', _sum: { regularHours: '40.00', overtimeHours: '2.75' } }],
    )

    const items = await listAttendanceWeeks(TODAY, { includeReviewStats: false })

    expect(items.find((i) => i.uploadId === 'u-approved')).toMatchObject({ employeeCount: 2, totalRegularHours: 40, totalOvertimeHours: 2.75 })
    expect(items.find((i) => i.uploadId === 'u-review')).toMatchObject(ZERO_COUNTS)
    expect(db.attendanceRecord.groupBy).toHaveBeenCalledTimes(2)
    expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('a failure while building a review grid breaks the full list, but not the lean one', async () => {
    serveReviewWeek()
    db.attendancePunch.findMany.mockRejectedValue(new Error('punch table unavailable'))

    await expect(listAttendanceWeeks(TODAY)).rejects.toThrow('punch table unavailable')
    await expect(listAttendanceWeeks(TODAY, { includeReviewStats: false })).resolves.toHaveLength(2)
  })

  it('a database failure while listing still propagates with the option off', async () => {
    db.attendanceUpload.findMany.mockRejectedValue(new Error('database unavailable'))

    await expect(listAttendanceWeeks(TODAY, { includeReviewStats: false })).rejects.toThrow('database unavailable')
  })
})
