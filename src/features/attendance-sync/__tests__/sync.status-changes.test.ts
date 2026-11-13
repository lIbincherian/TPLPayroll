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

const updates = () => db.tx.employee.update.mock.calls.map((call) => call[0])

describe('syncWeek sets employee status from a completed, latest-synced week', () => {
  it('marks the active employee with no punches inactive and reactivates the inactive one, in the transaction', async () => {
    const outcome = await runScheduledSync(NOW)

    expect(db.employee.update).not.toHaveBeenCalled()
    expect(updates()).toEqual([
      { where: { id: 'emp-7' }, data: { isActive: false } },
      { where: { id: 'emp-36' }, data: { isActive: true } },
    ])
    // The employee who resigned before today stays inactive despite punches.
    expect(updates().some((u) => u.where.id === 'emp-41')).toBe(false)

    const employeeAudits = auditRows(db.tx).filter((r) => r.entityType === 'EMPLOYEE')
    expect(employeeAudits).toHaveLength(2)
    expect(employeeAudits[0]).toMatchObject({
      actionType: 'UPDATE',
      entityId: 'emp-7',
      detailsJson: {
        changeSource: 'AUTO_ATTENDANCE',
        isActive: { from: true, to: false },
        weekStart: WEEK.start,
        weekEnd: WEEK.end,
        punchCount: 0,
        hours: 0,
      },
    })
    expect(employeeAudits[1]).toMatchObject({
      entityId: 'emp-36',
      detailsJson: { changeSource: 'AUTO_ATTENDANCE', isActive: { from: false, to: true }, punchCount: 2, hours: 9 },
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
    expect(db.tx.employee.update).not.toHaveBeenCalled()
  })

  it('changes nobody when the week ends today or later', async () => {
    const outcome = await syncWeek({ week: WEEK, trigger: 'MANUAL', now: new Date('2026-11-11T06:00:00Z') })

    expect(outcome.outcome).toBe('LOADED')
    expect(db.tx.employee.update).not.toHaveBeenCalled()
  })

  it('changes nobody on a FAILED outcome', async () => {
    fetchMock.mockResolvedValue({ ok: false, code: 'SYNC_FAILED', message: 'down' })

    const outcome = await runScheduledSync(NOW)

    expect(outcome.outcome).toBe('FAILED')
    expect(db.tx.employee.update).not.toHaveBeenCalled()
    expect(db.employee.update).not.toHaveBeenCalled()
  })

  it('changes nobody on an EMPTY outcome', async () => {
    fetchMock.mockResolvedValue({ ok: true, punches: [] })

    const outcome = await runScheduledSync(NOW)

    expect(outcome).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })
    expect(db.tx.employee.update).not.toHaveBeenCalled()
  })
})
