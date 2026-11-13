// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { runScheduledSync, syncWeek } from '@/features/attendance-sync/services/sync.service'
import type { ParsedPunch } from '@/features/attendance-sync/types/attendance-sync.types'
import { auditRows, makeEmployee, makeUpload, resetDb, utc, WEEK, type Db } from './service-fixtures'

const db = prisma as unknown as Db
const fetchMock = vi.mocked(fetchPunchData)

// Thursday 12 Nov 2026, 06:00 IST: the week 5-11 Nov is complete.
const NOW = new Date('2026-11-12T00:30:00Z')

function scans(code: string, date: string, times: string[]): ParsedPunch[] {
  return times.map((time) => ({ empCode: code, empName: `E${code}`, date, time, mcid: '1' }))
}

const ABSENT = makeEmployee({ id: 'emp-7', employeeId: 'TPLGOAHLP007', employeeName: 'Ravi Kumar' })
const BACK = makeEmployee({ id: 'emp-36', isActive: false })
const RESIGNED = makeEmployee({
  id: 'emp-41',
  employeeId: 'TPLGOAHLP041',
  employeeName: 'Meena Das',
  isActive: false,
  dateOfResignation: utc('2026-10-01'),
})

beforeEach(() => {
  resetDb(db)
  fetchMock.mockReset()
  db.attendanceUpload.findFirst.mockResolvedValue(makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  db.attendanceUpload.update.mockResolvedValue({})
  db.employee.findMany.mockResolvedValue([ABSENT, BACK, RESIGNED])
  fetchMock.mockResolvedValue({
    ok: true,
    punches: [...scans('0036', '2026-11-05', ['08:00', '17:00']), ...scans('0041', '2026-11-05', ['08:00', '12:00'])],
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const updates = () => db.tx.employee.updateMany.mock.calls.map((call) => call[0])
const employeeAudits = () =>
  db.tx.auditLog.createMany.mock.calls.flatMap((call) => (call[0] as { data: Array<Record<string, any>> }).data) // eslint-disable-line @typescript-eslint/no-explicit-any

describe('syncWeek sets employee status from a completed, latest-synced week', () => {
  it('marks the active employee with no punches inactive and reactivates the inactive one, in the transaction', async () => {
    const outcome = await runScheduledSync(NOW)

    expect(db.employee.updateMany).not.toHaveBeenCalled()
    expect(updates()).toEqual([
      { where: { id: { in: ['emp-7'] } }, data: { isActive: false } },
      { where: { id: { in: ['emp-36'] } }, data: { isActive: true } },
    ])
    // The employee who resigned before today stays inactive despite punches.
    expect(JSON.stringify(updates())).not.toContain('emp-41')

    const audits = employeeAudits()
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({
      actionType: 'UPDATE',
      entityType: 'EMPLOYEE',
      entityId: 'emp-7',
      detailsJson: {
        summary: 'Marked inactive from attendance: Ravi Kumar (TPLGOAHLP007) had no punches in 5 Nov – 11 Nov 2026',
        changeSource: 'AUTO_ATTENDANCE',
        employeeId: 'TPLGOAHLP007',
        employeeName: 'Ravi Kumar',
        isActive: { from: true, to: false },
        weekStart: WEEK.start,
        weekEnd: WEEK.end,
        punchCount: 0,
        hours: 0,
      },
    })
    expect(audits[1]).toMatchObject({
      entityId: 'emp-36',
      detailsJson: {
        summary: 'Reactivated from attendance: Asha Rao (TPLGOAHLP036) has 2 punches in 5 Nov – 11 Nov 2026',
        changeSource: 'AUTO_ATTENDANCE',
        isActive: { from: false, to: true },
        punchCount: 2,
        hours: 9,
      },
    })

    const statusChanges = {
      markedInactive: [{ id: 'emp-7', employeeId: 'TPLGOAHLP007', employeeName: 'Ravi Kumar' }],
      reactivated: [{ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' }],
    }
    expect(outcome).toMatchObject({ outcome: 'LOADED', statusChanges })
    const loaded = auditRows(db.tx).find((r) => r.entityType === 'ATTENDANCE_WEEK')
    expect(loaded?.detailsJson.statusChanges).toEqual(statusChanges)
  })

  it('reads whether a later eTimeOffice week was synced inside the transaction', async () => {
    await runScheduledSync(NOW)

    expect(db.tx.attendanceUpload.count).toHaveBeenCalledWith({
      where: { source: 'ETIMEOFFICE', payrollWeekStartDate: { gt: utc(WEEK.start) }, lastSyncedAt: { not: null } },
    })
  })

  it('changes nobody when a later eTimeOffice week has lastSyncedAt', async () => {
    db.tx.attendanceUpload.count.mockResolvedValue(1)

    const outcome = await runScheduledSync(NOW)

    expect(outcome.outcome).toBe('LOADED')
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })

  it('changes nobody when the week ends today or later', async () => {
    const outcome = await syncWeek({ week: WEEK, trigger: 'MANUAL', now: new Date('2026-11-11T06:00:00Z') })

    expect(outcome.outcome).toBe('LOADED')
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })

  it('changes nobody on a FAILED outcome', async () => {
    fetchMock.mockResolvedValue({ ok: false, code: 'SYNC_FAILED', message: 'down' })

    const outcome = await runScheduledSync(NOW)

    expect(outcome.outcome).toBe('FAILED')
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
    expect(db.employee.updateMany).not.toHaveBeenCalled()
  })

  it('changes nobody on an EMPTY outcome', async () => {
    fetchMock.mockResolvedValue({ ok: true, punches: [] })

    const outcome = await runScheduledSync(NOW)

    expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })
    expect(db.tx.employee.updateMany).not.toHaveBeenCalled()
  })
})
