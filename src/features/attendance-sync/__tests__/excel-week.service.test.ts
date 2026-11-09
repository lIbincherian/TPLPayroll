// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { getExcelWeekData } from '@/features/attendance-sync/services/excel-week.service'
import { makeExcelUpload, makeUpload, resetDb, utc, WEEK_DATES, type Db } from './service-fixtures'

const db = prisma as unknown as Db

function record(employee: { id: string; code: string; name: string }, date: string, regular: number, overtime: number) {
  return {
    attendanceDate: utc(date),
    regularHours: regular,
    overtimeHours: overtime,
    employee: { id: employee.id, employeeId: employee.code, employeeName: employee.name },
  }
}

const asha = { id: 'emp-36', code: 'TPLGOAHLP036', name: 'Asha Rao' }
const ravi = { id: 'emp-5', code: 'TPLGOAHLP005', name: 'Ravi Kumar' }

beforeEach(() => resetDb(db))

describe('getExcelWeekData', () => {
  it('returns null when there is no upload', async () => {
    expect(await getExcelWeekData(null)).toBeNull()
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('returns null for an eTimeOffice week (only Excel-era weeks have this view)', async () => {
    expect(await getExcelWeekData(makeUpload({ source: 'ETIMEOFFICE' }))).toBeNull()
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled()
  })

  it('reads the records of the upload and the payroll run of the week', async () => {
    await getExcelWeekData(makeExcelUpload({ id: 'excel-1' }))

    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { attendanceUploadId: 'excel-1' } }))
    expect(db.payrollRun.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: utc('2026-11-05'), status: { in: ['APPROVED', 'REVISED'] } },
      select: { id: true, status: true },
    })
  })

  it('shows the file, the week and the seven dates, with no employees for an empty week', async () => {
    const data = await getExcelWeekData(
      makeExcelUpload({ fileName: 'march-week.xlsx', uploadedAt: new Date('2025-03-13T09:30:00Z') }),
    )

    expect(data).toMatchObject({
      weekId: '2026-11-05',
      week: { start: '2026-11-05', end: '2026-11-11' },
      fileName: 'march-week.xlsx',
      uploadedAt: '2025-03-13T09:30:00.000Z',
      dates: WEEK_DATES,
      employees: [],
      payroll: { status: 'NOT_GENERATED', payrollRunId: null },
    })
    expect(data!.totals.regular).toBe(0)
    expect(data!.totals.byDay).toHaveLength(7)
  })

  it('groups the records per employee into seven days and totals them, employees sorted by name', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      record(ravi, '2026-11-05', 8, 0),
      record(asha, '2026-11-05', 8, 1.25),
      record(asha, '2026-11-06', 4, 0),
      record(ravi, '2026-11-11', 6.5, 0.5),
    ])

    const data = (await getExcelWeekData(makeExcelUpload()))!

    expect(data.employees.map((e) => e.employeeName)).toEqual(['Asha Rao', 'Ravi Kumar'])
    const [first, second] = data.employees
    expect(first).toMatchObject({ employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036', totalRegular: 12, totalOvertime: 1.25 })
    expect(first.days.map((d) => d.date)).toEqual(WEEK_DATES)
    expect(first.days[0]).toEqual({ date: '2026-11-05', regular: 8, overtime: 1.25 })
    expect(first.days[1]).toEqual({ date: '2026-11-06', regular: 4, overtime: 0 })
    expect(first.days[2]).toEqual({ date: '2026-11-07', regular: 0, overtime: 0 })
    expect(second).toMatchObject({ totalRegular: 14.5, totalOvertime: 0.5 })

    expect(data.totals.byDay[0]).toEqual({ date: '2026-11-05', regular: 16, overtime: 1.25 })
    expect(data.totals.byDay[6]).toEqual({ date: '2026-11-11', regular: 6.5, overtime: 0.5 })
    expect(data.totals.regular).toBe(26.5)
    expect(data.totals.overtime).toBe(1.75)
  })

  it('adds up two records of the same employee and date without floating point noise', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      record(asha, '2026-11-05', 0.1, 0.1),
      record(asha, '2026-11-05', 0.2, 0.2),
    ])

    const data = (await getExcelWeekData(makeExcelUpload()))!

    expect(data.employees[0].days[0]).toEqual({ date: '2026-11-05', regular: 0.3, overtime: 0.3 })
    expect(data.employees[0].totalRegular).toBe(0.3)
  })

  it('ignores a record dated outside the week', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([record(asha, '2026-11-20', 8, 0), record(asha, '2026-11-05', 8, 0)])

    const data = (await getExcelWeekData(makeExcelUpload()))!

    expect(data.employees[0].totalRegular).toBe(8)
  })

  it('reads Prisma decimal values', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      record(asha, '2026-11-05', { valueOf: () => '8.00', toString: () => '8.00' } as unknown as number, '1.25' as unknown as number),
    ])

    const data = (await getExcelWeekData(makeExcelUpload()))!

    expect(data.employees[0].days[0]).toEqual({ date: '2026-11-05', regular: 8, overtime: 1.25 })
  })

  it.each([
    ['APPROVED', 'APPROVED'],
    ['REVISED', 'REVISED'],
  ])('shows the payroll status of the week: a %s run reads %s', async (runStatus, expected) => {
    db.payrollRun.findFirst.mockResolvedValue({ id: 'run-7', status: runStatus })

    const data = (await getExcelWeekData(makeExcelUpload()))!

    expect(data.payroll).toEqual({ status: expected, payrollRunId: 'run-7' })
  })

  it('propagates a database failure', async () => {
    db.attendanceRecord.findMany.mockRejectedValue(new Error('database unavailable'))

    await expect(getExcelWeekData(makeExcelUpload())).rejects.toThrow('database unavailable')
  })
})
