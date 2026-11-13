// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { syncWeek } from '@/features/attendance-sync/services/sync.service'
import { approveWeek, getApprovalSummary } from '@/features/attendance-sync/services/week-approval.service'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makeUpload,
  resetDb,
  serveUpload,
  utc,
  WEEK,
  type Db,
} from './service-fixtures'

const db = prisma as unknown as Db
const WEEK_ID = WEEK.start
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' }) // no punches
const back = makeEmployee({ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Bala Singh', isActive: false })
const rejected = makeEmployee({ id: 'emp-9', employeeId: 'TPLGOAHLP009', employeeName: 'Left Out', isActive: false })
const resigned = makeEmployee({
  id: 'emp-3',
  employeeId: 'TPLGOAHLP003',
  employeeName: 'Gone Before',
  isActive: false,
  dateOfResignation: utc('2026-11-01'),
})

const decision = (id: string, code: string, name: string, value: 'APPROVED' | 'REJECTED') => ({
  employeeId: id,
  decision: value,
  employee: { employeeId: code, employeeName: name },
})

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  freezeClock('2026-11-13T03:00:00Z') // the 5-11 Nov week has ended
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  installPunchStore(db, [
    ...dayPunches({ idPrefix: 'a', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }),
    ...dayPunches({ idPrefix: 'b', employeeId: 'emp-8', empCode: '0008', date: '2026-11-05', times: ['08:00', '17:00'] }),
    ...dayPunches({ idPrefix: 'c', employeeId: 'emp-9', empCode: '0009', date: '2026-11-05', times: ['08:00', '17:00'] }),
    ...dayPunches({ idPrefix: 'd', employeeId: 'emp-3', empCode: '0003', date: '2026-11-05', times: ['08:00', '17:00'] }),
  ])
  const employees = [asha, ravi, back, rejected, resigned]
  db.employee.findMany.mockResolvedValue(employees)
  db.tx.employee.findMany.mockResolvedValue(employees)
  const decisions = [
    decision('emp-8', 'TPLGOAHLP008', 'Bala Singh', 'APPROVED'),
    decision('emp-9', 'TPLGOAHLP009', 'Left Out', 'REJECTED'),
    decision('emp-3', 'TPLGOAHLP003', 'Gone Before', 'APPROVED'),
  ]
  db.attendanceEmployeeDecision.findMany.mockResolvedValue(decisions)
  db.tx.attendanceEmployeeDecision.findMany.mockResolvedValue(decisions)
})

afterEach(() => {
  vi.useRealTimers()
})

const updates = () => db.tx.employee.updateMany.mock.calls.map((call) => call[0])
const employeeAudits = () =>
  db.tx.auditLog.createMany.mock.calls.flatMap((call) => (call[0] as { data: Array<Record<string, unknown>> }).data)

describe('approveWeek sets employee status from the approved week', () => {
  it('marks the active employee with no punches inactive and reactivates an approved inactive one, in the transaction', async () => {
    const { statusChanges } = await approveWeek(WEEK_ID)

    expect(db.employee.updateMany).not.toHaveBeenCalled()
    expect(updates()).toEqual([
      { where: { id: { in: ['emp-5'] } }, data: { isActive: false } },
      { where: { id: { in: ['emp-8'] } }, data: { isActive: true } },
    ])

    const audits = employeeAudits()
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({
      actionType: 'UPDATE',
      entityType: 'EMPLOYEE',
      entityId: 'emp-5',
      detailsJson: {
        summary: 'Marked inactive on approval: Ravi Kumar (TPLGOAHLP005) had no punches in 5 Nov – 11 Nov 2026',
        changeSource: 'AUTO_ATTENDANCE',
        employeeId: 'TPLGOAHLP005',
        employeeName: 'Ravi Kumar',
        isActive: { from: true, to: false },
        weekStart: WEEK.start,
        weekEnd: WEEK.end,
        punchCount: 0,
        hours: 0,
      },
    })
    expect(audits[1]).toMatchObject({
      entityId: 'emp-8',
      detailsJson: {
        summary: 'Reactivated on approval: Bala Singh (TPLGOAHLP008) has 2 punches in 5 Nov – 11 Nov 2026',
        changeSource: 'AUTO_ATTENDANCE',
        isActive: { from: false, to: true },
        punchCount: 2,
        hours: 9,
      },
    })

    const expected = {
      markedInactive: [{ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' }],
      reactivated: [{ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Bala Singh' }],
    }
    expect(statusChanges).toEqual(expected)
    const approval = auditRows(db.tx).find((r) => r.actionType === 'APPROVE')
    expect(approval?.detailsJson.statusChanges).toEqual(expected)
  })

  it('leaves the rejected employee and the one who resigned before today inactive', async () => {
    await approveWeek(WEEK_ID)

    const touched = JSON.stringify(updates())
    expect(touched).not.toContain('emp-9')
    expect(touched).not.toContain('emp-3')
  })

  it('checks for a later approved eTimeOffice week inside the transaction', async () => {
    await approveWeek(WEEK_ID)

    expect(db.tx.attendanceUpload.count).toHaveBeenCalledWith({
      where: { source: 'ETIMEOFFICE', payrollWeekStartDate: { gt: utc(WEEK.start) }, status: 'APPROVED' },
    })
  })

  it('changes nobody when a later eTimeOffice week is already approved', async () => {
    db.tx.attendanceUpload.count.mockResolvedValue(1)

    const { statusChanges } = await approveWeek(WEEK_ID)

    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
    expect(statusChanges).toEqual({ markedInactive: [], reactivated: [] })
  })

  it('changes nobody when the approval fails, so nothing is half-applied', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveWeek(WEEK_ID)).rejects.toBeInstanceOf(AttendanceSyncError)
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })
})

describe('a pull never changes employee status', () => {
  it('a loaded pull of a completed week updates no employee', async () => {
    vi.mocked(fetchPunchData).mockResolvedValue({
      ok: true,
      punches: [{ empCode: '0036', empName: 'Asha', date: WEEK.start, time: '08:00', mcid: '1' }],
    })
    db.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })

    const outcome = await syncWeek({ week: WEEK, trigger: 'MANUAL', now: new Date('2026-11-13T03:00:00Z') })

    expect(outcome.outcome).toBe('LOADED')
    expect(db.employee.updateMany).not.toHaveBeenCalled()
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })
})

describe('getApprovalSummary previews the status changes', () => {
  it('lists who approving would mark inactive and reactivate, without writing anything', async () => {
    const summary = await getApprovalSummary(WEEK_ID)

    expect(summary.statusChanges).toEqual({
      markedInactive: [{ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' }],
      reactivated: [{ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Bala Singh' }],
    })
    expect(db.employee.updateMany).not.toHaveBeenCalled()
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })

  it('has no preview for an approved week', async () => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))

    const summary = await getApprovalSummary(WEEK_ID)

    expect(summary.statusChanges).toBeUndefined()
  })
})
