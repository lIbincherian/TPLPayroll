// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import {
  getOrCreateApiWeekRow,
  getWeekByStart,
  listAttendanceWeeks,
  requireApiWeek,
} from '@/features/attendance-sync/services/week-list.service'
import { WEEK_LIST_LIMIT } from '@/features/attendance-sync/lib/constants'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'
import {
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

beforeEach(() => resetDb(db))
afterEach(() => vi.useRealTimers())

// ─── getWeekByStart / getOrCreateApiWeekRow / requireApiWeek ──────────────────

describe('getWeekByStart', () => {
  it('finds the active upload for that Thursday, newest first', async () => {
    const row = makeUpload()
    db.attendanceUpload.findFirst.mockResolvedValue(row)

    expect(await getWeekByStart(utc(WEEK.start))).toBe(row)
    expect(db.attendanceUpload.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: utc(WEEK.start), isActiveForPayrollWeek: true },
      orderBy: { uploadedAt: 'desc' },
    })
  })
})

describe('getOrCreateApiWeekRow', () => {
  it('returns the existing API row without creating one', async () => {
    const row = makeUpload({ status: 'REVIEW' })
    db.attendanceUpload.findFirst.mockResolvedValue(row)

    expect(await getOrCreateApiWeekRow(WEEK)).toBe(row)
    expect(db.attendanceUpload.create).not.toHaveBeenCalled()
  })

  it('creates a SYNC_FAILED placeholder with no file for a week that has no row', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'new' }))

    const row = await getOrCreateApiWeekRow(WEEK)

    expect(row.id).toBe('new')
    expect(db.attendanceUpload.create).toHaveBeenCalledWith({
      data: {
        source: 'ETIMEOFFICE',
        payrollWeekSource: 'ETIMEOFFICE',
        status: 'SYNC_FAILED',
        fileName: null,
        fileType: null,
        payrollWeekStartDate: utc('2026-11-05'),
        payrollWeekEndDate: utc('2026-11-11'),
        isActiveForPayrollWeek: true,
        activeWeekStart: utc('2026-11-05'),
      },
    })
  })

  it('refuses an Excel-era week (EXCEL_ERA_WEEK) and creates nothing', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())

    await expect(getOrCreateApiWeekRow(WEEK)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
    await expect(getOrCreateApiWeekRow(WEEK)).rejects.toBeInstanceOf(AttendanceSyncError)
    expect(db.attendanceUpload.create).not.toHaveBeenCalled()
  })
})

describe('requireApiWeek', () => {
  it('resolves the row and the week range for a Thursday', async () => {
    const row = makeUpload()
    db.attendanceUpload.findFirst.mockResolvedValue(row)

    expect(await requireApiWeek('2026-11-05')).toEqual({ upload: row, week: WEEK })
  })

  it.each(['2026-11-06', 'not-a-date', '2026-02-30', ''])('rejects %j as INVALID_WEEK before reading the database', async (weekId) => {
    await expect(requireApiWeek(weekId)).rejects.toMatchObject({ code: 'INVALID_WEEK' })
    expect(db.attendanceUpload.findFirst).not.toHaveBeenCalled()
  })

  it('says WEEK_NOT_READY when nothing has been loaded for the week', async () => {
    await expect(requireApiWeek('2026-11-05')).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
  })

  it('says EXCEL_ERA_WEEK for a legacy week (read-only)', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(makeExcelUpload())

    await expect(requireApiWeek('2026-11-05')).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })
})

// ─── listAttendanceWeeks ──────────────────────────────────────────────────────

describe('listAttendanceWeeks', () => {
  // Thursday 12 Nov 2026: the in-progress week is 12-18 Nov, the last completed week 5-11 Nov.
  const TODAY = '2026-11-12'
  beforeEach(() => freezeClock('2026-11-12T01:00:00Z'))

  it('asks for the newest active uploads of both sources, capped', async () => {
    await listAttendanceWeeks(TODAY)

    expect(db.attendanceUpload.findMany).toHaveBeenCalledWith({
      where: { isActiveForPayrollWeek: true },
      orderBy: { payrollWeekStartDate: 'desc' },
      take: WEEK_LIST_LIMIT,
    })
    expect(WEEK_LIST_LIMIT).toBe(26)
  })

  describe('virtual rows', () => {
    it('lists the current week and the last completed week when nothing is stored, newest first', async () => {
      const items = await listAttendanceWeeks(TODAY)

      expect(items.map((i) => i.weekId)).toEqual(['2026-11-12', '2026-11-05'])
      expect(items[0]).toMatchObject({
        source: null,
        status: 'NO_DATA',
        uploadId: null,
        week: { start: '2026-11-12', end: '2026-11-18' },
        hasEnded: false,
        isSyncing: false,
        payrollStatus: 'NOT_GENERATED',
        payrollRunId: null,
        canPullNow: true, // E2E-06: Pull now works on a week still in progress
        canReopen: false,
        employeeCount: 0,
        lastSyncError: null,
      })
      expect(items[1]).toMatchObject({ source: null, status: 'NO_DATA', hasEnded: true, canPullNow: true })
    })

    it('does not add a virtual row for a week that already has one', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({ id: 'u-cur', payrollWeekStartDate: utc('2026-11-12'), payrollWeekEndDate: utc('2026-11-18'), status: 'SYNC_FAILED' }),
        makeUpload({ id: 'u-prev', status: 'SYNC_FAILED' }),
      ])

      const items = await listAttendanceWeeks(TODAY)

      expect(items).toHaveLength(2)
      expect(items.every((i) => i.uploadId !== null)).toBe(true)
    })

    it('adds only the missing one of the two', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'u-prev', status: 'SYNC_FAILED' })])

      const items = await listAttendanceWeeks(TODAY)

      expect(items.map((i) => [i.weekId, i.uploadId])).toEqual([
        ['2026-11-12', null],
        ['2026-11-05', 'u-prev'],
      ])
    })

    it('sorts stored and virtual rows together, newest first', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({ id: 'u-oct', payrollWeekStartDate: utc('2026-10-29'), payrollWeekEndDate: utc('2026-11-04'), status: 'APPROVED' }),
      ])

      const items = await listAttendanceWeeks(TODAY)

      expect(items.map((i) => i.weekId)).toEqual(['2026-11-12', '2026-11-05', '2026-10-29'])
    })

    it('uses the IST calendar day for the current week', async () => {
      const items = await listAttendanceWeeks('2026-11-11') // a Wednesday: still the 5-11 Nov week

      expect(items.map((i) => i.weekId)).toEqual(['2026-11-05', '2026-10-29'])
      expect(items[0].hasEnded).toBe(false)
      expect(items[1].hasEnded).toBe(true)
    })
  })

  describe('status and flags by row type', () => {
    it('SYNC_FAILED row: shows the error and offers Pull now', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({
          status: 'SYNC_FAILED',
          lastSyncError: 'eTimeOffice returned HTTP 500.',
          lastSyncAttemptAt: new Date('2026-11-12T00:30:00Z'),
          lastSyncedAt: null,
        }),
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({
        source: 'ETIMEOFFICE',
        status: 'SYNC_FAILED',
        lastSyncError: 'eTimeOffice returned HTTP 500.',
        lastSyncAttemptAt: '2026-11-12T00:30:00.000Z',
        lastSyncedAt: null,
        canPullNow: true,
        canReopen: false,
      })
    })

    it('REVIEW row: surfaces the stale notice and still offers Pull now', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({ status: 'REVIEW', staleNoticeAt: new Date('2026-11-12T00:30:00Z'), lastSyncedAt: new Date('2026-11-09T08:00:00Z') }),
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({
        status: 'REVIEW',
        staleNoticeAt: '2026-11-12T00:30:00.000Z',
        lastSyncedAt: '2026-11-09T08:00:00.000Z',
        canPullNow: true,
        canReopen: false,
      })
    })

    it('APPROVED row with no payroll: offers Reopen, not Pull now (E2E-33)', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ status: 'APPROVED', approvedAt: new Date() })])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({ status: 'APPROVED', payrollStatus: 'NOT_GENERATED', canPullNow: false, canReopen: true })
    })

    it('APPROVED row with approved payroll: no Pull now, no Reopen (E2E-23)', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ status: 'APPROVED' })])
      db.payrollRun.findMany.mockResolvedValue([
        { id: 'run-1', payrollWeekStartDate: utc('2026-11-05'), status: 'APPROVED' },
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({ payrollStatus: 'APPROVED', payrollRunId: 'run-1', canPullNow: false, canReopen: false })
    })

    it('a revised payroll reads as REVISED and blocks Pull now and Reopen', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ status: 'APPROVED' })])
      db.payrollRun.findMany.mockResolvedValue([
        { id: 'run-2', payrollWeekStartDate: utc('2026-11-05'), status: 'REVISED' },
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({ payrollStatus: 'REVISED', payrollRunId: 'run-2', canPullNow: false, canReopen: false })
    })

    it('joins payroll runs by week start for approved and revised runs only', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ status: 'REVIEW' })])

      await listAttendanceWeeks(TODAY)

      expect(db.payrollRun.findMany).toHaveBeenCalledWith({
        where: {
          payrollWeekStartDate: { in: [utc('2026-11-05'), utc('2026-11-12')] },
          status: { in: ['APPROVED', 'REVISED'] },
        },
        select: { id: true, payrollWeekStartDate: true, status: true },
      })
    })

    it('Excel-era row reads as APPROVED, shows its file name and offers nothing (E2E-27)', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeExcelUpload({ id: 'excel-1', status: 'READY' })])
      db.attendanceRecord.groupBy.mockImplementation(async (args: { by: string[] }) =>
        args.by.includes('employeeId')
          ? [
              { attendanceUploadId: 'excel-1', employeeId: 'e1' },
              { attendanceUploadId: 'excel-1', employeeId: 'e2' },
            ]
          : [{ attendanceUploadId: 'excel-1', _sum: { regularHours: 60, overtimeHours: 4.5 } }],
      )

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({
        source: 'EXCEL',
        status: 'APPROVED',
        fileName: 'attendance-week.xlsx',
        employeeCount: 2,
        totalRegularHours: 60,
        totalOvertimeHours: 4.5,
        canPullNow: false,
        canReopen: false,
      })
    })

    it('an Excel row with an ERRORS legacy status still reads as APPROVED', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeExcelUpload({ status: 'ERRORS' })])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item.status).toBe('APPROVED')
      expect(item.canPullNow).toBe(false)
    })

    it('a row for a week that has not started cannot be pulled', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({ id: 'u-future', payrollWeekStartDate: utc('2026-11-19'), payrollWeekEndDate: utc('2026-11-25'), status: 'SYNC_FAILED' }),
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-19')!

      expect(item.canPullNow).toBe(false)
    })
  })

  describe('isSyncing comes from a fresh sync lock', () => {
    it('is true while the lock is younger than 5 minutes, and Pull now is withheld', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ syncLockedAt: new Date('2026-11-12T00:57:00Z') })])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item.isSyncing).toBe(true)
      expect(item.canPullNow).toBe(false)
    })

    it('is false once the lock is older than the TTL (a stale lock)', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ syncLockedAt: new Date('2026-11-12T00:50:00Z') })])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item.isSyncing).toBe(false)
      expect(item.canPullNow).toBe(true)
    })

    it('is false with no lock', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ syncLockedAt: null })])

      expect((await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!.isSyncing).toBe(false)
    })
  })

  describe('counts for weeks in review come from the live punches', () => {
    const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
    const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' })
    const inactive = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })

    it('totals hours of payroll employees and counts needs-fixing days, unresolved codes and pending decisions', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'REVIEW' })])
      db.employee.findMany.mockResolvedValue([asha, ravi, inactive])
      db.attendancePunch.findMany.mockResolvedValue([
        // Asha: 07:40-13:04 + 13:56-17:47 = 8.00 / 1.25
        ...dayPunches({ idPrefix: 'a', employeeId: 'emp-36', date: '2026-11-05', times: ['07:40', '13:04', '13:56', '17:47'] }),
        // Ravi: one lone punch on 6 Nov (incomplete) and 08:00-12:00 on 5 Nov (4.00)
        ...dayPunches({ idPrefix: 'r1', employeeId: 'emp-5', empCode: '0005', date: '2026-11-05', times: ['08:00', '12:00'] }),
        ...dayPunches({ idPrefix: 'r2', employeeId: 'emp-5', empCode: '0005', date: '2026-11-06', times: ['18:26'] }),
        // An unknown code and a duplicate code: two unresolved codes.
        ...dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN' }),
        ...dayPunches({ idPrefix: 'd', employeeId: null, empCode: '0007', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'DUPLICATE' }),
        // An inactive employee with punches and no decision: one pending decision, not in the grid.
        ...dayPunches({ idPrefix: 'i', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }),
      ])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({
        status: 'REVIEW',
        employeeCount: 2, // the inactive employee has no decision, so is not in the grid
        totalRegularHours: 12, // 8.00 + 4.00
        totalOvertimeHours: 1.25,
        needsFixingDays: 1,
        unresolvedCodes: 2,
        pendingDecisions: 1,
      })
    })

    it('includes an approved inactive employee and drops a rejected one', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'REVIEW' })])
      db.employee.findMany.mockResolvedValue([asha, inactive])
      db.attendanceEmployeeDecision.findMany.mockResolvedValue([
        { attendanceUploadId: 'upload-1', employeeId: 'emp-2', decision: 'APPROVED' },
      ])
      db.attendancePunch.findMany.mockResolvedValue([
        ...dayPunches({ idPrefix: 'a', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
        ...dayPunches({ idPrefix: 'i', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }),
      ])

      let item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!
      expect(item).toMatchObject({ employeeCount: 2, totalRegularHours: 16, pendingDecisions: 0 })

      db.attendanceEmployeeDecision.findMany.mockResolvedValue([
        { attendanceUploadId: 'upload-1', employeeId: 'emp-2', decision: 'REJECTED' },
      ])
      item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!
      expect(item).toMatchObject({ employeeCount: 1, totalRegularHours: 8, pendingDecisions: 0 })
    })

    it('does not count a zero-punch employee as a payroll employee', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'REVIEW' })])
      db.employee.findMany.mockResolvedValue([asha, ravi])
      db.attendancePunch.findMany.mockResolvedValue(
        dayPunches({ idPrefix: 'a', employeeId: 'emp-36', date: '2026-11-05', times: ['08:00', '16:00'] }),
      )

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item.employeeCount).toBe(1)
    })

    it('reads only live punches (correction clones are excluded)', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'REVIEW' })])

      await listAttendanceWeeks(TODAY)

      expect(db.attendancePunch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { attendanceUploadId: { in: ['upload-1'] }, correctionId: null } }),
      )
    })

    it('does not load employees or punches when there is no week in review', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ status: 'APPROVED' })])

      await listAttendanceWeeks(TODAY)

      expect(db.employee.findMany).not.toHaveBeenCalled()
      expect(db.attendancePunch.findMany).not.toHaveBeenCalled()
    })
  })

  describe('counts for approved weeks come from AttendanceRecord', () => {
    it('counts distinct employees and sums hours', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'APPROVED' })])
      db.attendanceRecord.groupBy.mockImplementation(async (args: { by: string[] }) =>
        args.by.includes('employeeId')
          ? [
              { attendanceUploadId: 'upload-1', employeeId: 'e1' },
              { attendanceUploadId: 'upload-1', employeeId: 'e2' },
              { attendanceUploadId: 'upload-1', employeeId: 'e3' },
            ]
          : [{ attendanceUploadId: 'upload-1', _sum: { regularHours: '40.00', overtimeHours: '2.75' } }],
      )

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({ employeeCount: 3, totalRegularHours: 40, totalOvertimeHours: 2.75, needsFixingDays: 0 })
      expect(db.attendanceRecord.groupBy).toHaveBeenCalledTimes(2)
    })

    it('an approved week with no records reads as zero', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([makeUpload({ id: 'upload-1', status: 'APPROVED' })])

      const item = (await listAttendanceWeeks(TODAY)).find((i) => i.weekId === '2026-11-05')!

      expect(item).toMatchObject({ employeeCount: 0, totalRegularHours: 0, totalOvertimeHours: 0 })
    })

    it('keeps each week own totals when several weeks are listed', async () => {
      db.attendanceUpload.findMany.mockResolvedValue([
        makeUpload({ id: 'u-a', status: 'APPROVED' }),
        makeUpload({ id: 'u-b', payrollWeekStartDate: utc('2026-10-29'), payrollWeekEndDate: utc('2026-11-04'), status: 'APPROVED' }),
      ])
      db.attendanceRecord.groupBy.mockImplementation(async (args: { by: string[] }) =>
        args.by.includes('employeeId')
          ? [
              { attendanceUploadId: 'u-a', employeeId: 'e1' },
              { attendanceUploadId: 'u-b', employeeId: 'e1' },
              { attendanceUploadId: 'u-b', employeeId: 'e2' },
            ]
          : [
              { attendanceUploadId: 'u-a', _sum: { regularHours: 8, overtimeHours: 1 } },
              { attendanceUploadId: 'u-b', _sum: { regularHours: 16, overtimeHours: 0 } },
            ],
      )

      const items = await listAttendanceWeeks(TODAY)

      expect(items.find((i) => i.uploadId === 'u-a')).toMatchObject({ employeeCount: 1, totalRegularHours: 8, totalOvertimeHours: 1 })
      expect(items.find((i) => i.uploadId === 'u-b')).toMatchObject({ employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 0 })
    })
  })

  it('propagates a database failure instead of returning a partial list', async () => {
    db.attendanceUpload.findMany.mockRejectedValue(new Error('database unavailable'))

    await expect(listAttendanceWeeks(TODAY)).rejects.toThrow('database unavailable')
  })

  it('defaults "today" to the IST calendar day when no argument is given', async () => {
    // Frozen at 12 Nov 01:00 UTC = 12 Nov 06:30 IST.
    const items = await listAttendanceWeeks()

    expect(items.map((i) => i.weekId)).toEqual(['2026-11-12', '2026-11-05'])
  })
})

describe('fixture sanity', () => {
  it('builds stored punches with a utc-midnight date', () => {
    expect(makePunch().punchDate.toISOString()).toBe('2026-11-05T00:00:00.000Z')
    expect(makeRun().status).toBe('APPROVED')
  })
})
