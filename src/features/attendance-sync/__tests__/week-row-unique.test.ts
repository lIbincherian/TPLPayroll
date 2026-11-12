// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { getOrCreateApiWeekRow } from '@/features/attendance-sync/services/week-list.service'
import { weekFromStartISO } from '@/features/attendance-sync/lib/week'
import { makeExcelUpload, makeUpload, resetDb, utc, type Db } from './service-fixtures'

// Fix round, item 5: AttendanceUpload.activeWeekStart is a nullable unique column that equals the
// week start while the row is the active one. Two callers racing to create a week cannot both win:
// the loser gets P2002 and uses the row the winner created.

const db = prisma as unknown as Db
const week = weekFromStartISO('2026-11-05')

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`activeWeekStart`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['activeWeekStart'] },
  })

beforeEach(() => {
  resetDb(db)
  db.attendanceUpload.create.mockImplementation(async ({ data }: { data: object }) => makeUpload({ ...data, id: 'created' }))
})

describe('getOrCreateApiWeekRow: the placeholder carries activeWeekStart', () => {
  it('creates the SYNC_FAILED placeholder with activeWeekStart equal to the week start', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)

    await getOrCreateApiWeekRow(week)

    expect(db.attendanceUpload.create).toHaveBeenCalledTimes(1)
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

  it('keeps activeWeekStart and payrollWeekStartDate in step', async () => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)

    await getOrCreateApiWeekRow(week)

    const { data } = db.attendanceUpload.create.mock.calls[0][0]
    expect(data.activeWeekStart.getTime()).toBe(data.payrollWeekStartDate.getTime())
  })

  it('creates nothing when the week already has an active API row', async () => {
    const existing = makeUpload({ id: 'existing' })
    db.attendanceUpload.findFirst.mockResolvedValue(existing)

    await expect(getOrCreateApiWeekRow(week)).resolves.toBe(existing)
    expect(db.attendanceUpload.create).not.toHaveBeenCalled()
  })
})

describe('getOrCreateApiWeekRow: losing the creation race (P2002)', () => {
  it('uses the row the winner created and does not create a second one', async () => {
    const winner = makeUpload({ id: 'winner' })
    db.attendanceUpload.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    db.attendanceUpload.create.mockRejectedValueOnce(p2002())

    await expect(getOrCreateApiWeekRow(week)).resolves.toBe(winner)

    expect(db.attendanceUpload.create).toHaveBeenCalledTimes(1)
    // The second lookup is the same active-row lookup as the first.
    expect(db.attendanceUpload.findFirst).toHaveBeenCalledTimes(2)
    expect(db.attendanceUpload.findFirst.mock.calls[1][0]).toEqual(db.attendanceUpload.findFirst.mock.calls[0][0])
    expect(db.attendanceUpload.findFirst.mock.calls[1][0].where).toEqual({
      payrollWeekStartDate: utc('2026-11-05'),
      isActiveForPayrollWeek: true,
    })
  })

  it('refuses with EXCEL_ERA_WEEK when the winner is an Excel-era row', async () => {
    db.attendanceUpload.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(makeExcelUpload())
    db.attendanceUpload.create.mockRejectedValueOnce(p2002())

    await expect(getOrCreateApiWeekRow(week)).rejects.toMatchObject({ name: 'AttendanceSyncError', code: 'EXCEL_ERA_WEEK' })
    expect(db.attendanceUpload.create).toHaveBeenCalledTimes(1)
  })

  it('rethrows the P2002 when the re-read finds nothing (the conflict was not this week)', async () => {
    const conflict = p2002()
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockRejectedValueOnce(conflict)

    await expect(getOrCreateApiWeekRow(week)).rejects.toBe(conflict)
    expect(db.attendanceUpload.findFirst).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['another Prisma error', new Prisma.PrismaClientKnownRequestError('FK failed', { code: 'P2003', clientVersion: 'test' })],
    ['a plain error', new Error('connection reset')],
  ])('rethrows %s without a second lookup', async (_label, error) => {
    db.attendanceUpload.findFirst.mockResolvedValue(null)
    db.attendanceUpload.create.mockRejectedValueOnce(error)

    await expect(getOrCreateApiWeekRow(week)).rejects.toBe(error)
    expect(db.attendanceUpload.findFirst).toHaveBeenCalledTimes(1)
  })

  it('two callers racing for the same new week end up with the same single row', async () => {
    // Caller A wins the create; caller B sees nothing first, loses with P2002, then finds A's row.
    const winnerRow = makeUpload({ id: 'a-created', status: 'SYNC_FAILED' })
    db.attendanceUpload.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(winnerRow)
    db.attendanceUpload.create.mockResolvedValueOnce(winnerRow).mockRejectedValueOnce(p2002())

    const [a, b] = await Promise.all([getOrCreateApiWeekRow(week), getOrCreateApiWeekRow(week)])

    expect(a.id).toBe('a-created')
    expect(b.id).toBe('a-created')
    expect(db.attendanceUpload.create).toHaveBeenCalledTimes(2)
  })
})
