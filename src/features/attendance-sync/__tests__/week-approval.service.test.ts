// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import { approveWeek, getApprovalSummary, reopenWeek } from '@/features/attendance-sync/services/week-approval.service'
import type { SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  baseSignatureOf,
  dayPunches,
  freezeClock,
  installPunchStore,
  lockedRow,
  makeEmployee,
  makeExcelUpload,
  makeRun,
  makeSession,
  makeUpload,
  resetDb,
  serveDecisionLookup,
  serveEmployeeLookup,
  serveUpload,
  utc,
  WEEK_DATES,
  type Db,
  type PunchRow,
  type PunchStore,
} from './service-fixtures'

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const ravi = makeEmployee({ id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar' }) // no punches
const approvedInactive = makeEmployee({ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Approved Inactive', isActive: false })
const rejectedResigned = makeEmployee({
  id: 'emp-3',
  employeeId: 'TPLGOAHLP003',
  employeeName: 'Gone Before',
  dateOfResignation: new Date('2026-11-01T00:00:00Z'),
})

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

const decisionRows = (...rows: Array<{ id: string; code: string; name: string; decision: 'APPROVED' | 'REJECTED' }>) =>
  rows.map((r) => ({ employeeId: r.id, decision: r.decision, employee: { employeeId: r.code, employeeName: r.name } }))

/** approveWeek reads the employees inside its transaction (db.tx) as well as before it (db). */
function serveEmployees(employees: ReturnType<typeof makeEmployee>[]) {
  db.employee.findMany.mockResolvedValue(employees)
  db.tx.employee.findMany.mockResolvedValue(employees)
  // savePunchEdit looks the employee up again inside its transaction.
  serveEmployeeLookup(db, employees)
}

function serveDecisions(rows: ReturnType<typeof decisionRows>) {
  db.attendanceEmployeeDecision.findMany.mockResolvedValue(rows)
  db.tx.attendanceEmployeeDecision.findMany.mockResolvedValue(rows)
  serveDecisionLookup(db, rows)
}

/** Asha works a full day; one approved inactive employee and one rejected resigned employee have punches; Ravi has none. */
function seedWeek(extra: PunchRow[] = []) {
  store = installPunchStore(db, [
    ...dayPunches({ idPrefix: 'p', employeeId: 'emp-36', date: '2026-11-05', times: FULL_DAY }),
    ...dayPunches({ idPrefix: 'i8', employeeId: 'emp-8', empCode: '0008', date: '2026-11-05', times: ['08:00', '12:00', '13:00', '17:00'] }),
    ...dayPunches({ idPrefix: 'r3', employeeId: 'emp-3', empCode: '0003', date: '2026-11-05', times: ['08:00', '12:00', '13:00', '17:00'] }),
    ...extra,
  ])
  serveEmployees([asha, ravi, approvedInactive, rejectedResigned])
  serveDecisions(
    decisionRows(
      { id: 'emp-8', code: 'TPLGOAHLP008', name: 'Approved Inactive', decision: 'APPROVED' },
      { id: 'emp-3', code: 'TPLGOAHLP003', name: 'Gone Before', decision: 'REJECTED' },
    ),
  )
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock('2026-11-13T03:00:00Z') // the 5-11 Nov week has ended
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 1 })
  seedWeek()
})

afterEach(() => {
  // approving, reopening and summarising never go back to eTimeOffice (US-12.27 AC6)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(fetchPunchData).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── approveWeek (US-12.22 - US-12.25) ────────────────────────────────────────

describe('approveWeek', () => {
  it('locks the week: moves REVIEW to APPROVED with an approval time, only if it is still in review', async () => {
    const { approvedAt } = await approveWeek(WEEK_ID)

    expect(approvedAt).toBeInstanceOf(Date)
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'upload-1', status: 'REVIEW' },
      data: { status: 'APPROVED', approvedAt, lastSyncError: null },
    })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })

  it('writes seven AttendanceRecord rows per payroll employee carrying the grid hours (US-12.24)', async () => {
    await approveWeek(WEEK_ID)

    const { data } = db.tx.attendanceRecord.createMany.mock.calls[0][0]
    const forAsha = data.filter((r: { employeeId: string }) => r.employeeId === 'emp-36')
    expect(forAsha).toHaveLength(7)
    expect(forAsha.map((r: { attendanceDate: Date }) => r.attendanceDate.toISOString().slice(0, 10))).toEqual(WEEK_DATES)
    // 07:40-13:04 + 13:56-17:47 = 8.00 regular, 1.25 overtime; the other days are 0.00.
    expect(forAsha[0]).toMatchObject({
      attendanceUploadId: 'upload-1',
      regularHours: 8,
      overtimeHours: 1.25,
      beforeNoonIn: null,
      beforeNoonOut: null,
      afternoonIn: null,
      afternoonOut: null,
      overtimeIn: null,
      overtimeOut: null,
      sourceSheetName: null,
      sourceEmployeeBlockIndex: null,
      verificationDecision: null,
    })
    expect(forAsha.slice(1).every((r: { regularHours: number; overtimeHours: number }) => r.regularHours === 0 && r.overtimeHours === 0)).toBe(true)
  })

  it('writes records for the approved inactive employee with their decision, and none for zero-hour or rejected employees (US-12.25, E2E-17)', async () => {
    await approveWeek(WEEK_ID)

    const { data } = db.tx.attendanceRecord.createMany.mock.calls[0][0]
    const ids = [...new Set(data.map((r: { employeeId: string }) => r.employeeId))].sort()
    expect(ids).toEqual(['emp-36', 'emp-8']) // Ravi has zero hours; Gone Before was rejected
    expect(data).toHaveLength(14)
    expect(data.filter((r: { employeeId: string }) => r.employeeId === 'emp-8')[0]).toMatchObject({
      regularHours: 8,
      overtimeHours: 0,
      verificationDecision: 'APPROVED',
    })
  })

  it('replaces any earlier records of the week before writing the new ones', async () => {
    await approveWeek(WEEK_ID)

    expect(db.tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1' } })
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0]
    expect(order(db.tx.attendanceUpload.updateMany)).toBeLessThan(order(db.tx.attendanceRecord.deleteMany))
    expect(order(db.tx.attendanceRecord.deleteMany)).toBeLessThan(order(db.tx.attendanceRecord.createMany))
  })

  it('returns the summary: employees, hours, who is left out', async () => {
    const { summary } = await approveWeek(WEEK_ID)

    expect(summary).toMatchObject({ employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 1.25, editedDays: 0 })
    expect(summary.leftOut.map((l) => [l.employeeCode, l.reason])).toEqual([
      ['TPLGOAHLP005', 'ZERO_HOURS'],
      ['TPLGOAHLP003', 'REJECTED'],
    ])
  })

  it('records an APPROVE audit row inside the transaction with the summary (US-12.21)', async () => {
    await approveWeek(WEEK_ID)

    expect(db.auditLog.create).not.toHaveBeenCalled()
    const [audit] = auditRows(db.tx)
    expect(audit).toMatchObject({ actionType: 'APPROVE', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(audit.detailsJson).toMatchObject({
      summary: 'Approved: 2 employees, 16.00 regular, 1.25 overtime',
      weekStart: '2026-11-05',
      weekEnd: '2026-11-11',
      employeeCount: 2,
      totalRegularHours: 16,
      totalOvertimeHours: 1.25,
      editedDays: 0,
    })
    expect(audit.detailsJson.leftOut).toHaveLength(2)
  })

  it('counts edited days in the summary', async () => {
    seedWeek()
    store.rows.find((r) => r.id === 'p-3')!.currentTime = '18:00'

    const { summary } = await approveWeek(WEEK_ID)

    expect(summary.editedDays).toBe(1)
    expect(summary.totalOvertimeHours).toBe(1.47)
  })

  it('approves a week where nobody has hours, writing no records', async () => {
    store = installPunchStore(db, [])
    serveDecisions([])
    serveEmployees([asha, ravi])

    const { summary } = await approveWeek(WEEK_ID)

    expect(summary.employeeCount).toBe(0)
    expect(db.tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalled()
  })

  describe('is rejected on the server when anything still blocks (US-12.24 AC5)', () => {
    async function expectRefused(code: string): Promise<{ details?: { blockers?: string[] }; message: string }> {
      const error = await approveWeek(WEEK_ID).then(
        () => {
          throw new Error('expected approveWeek to be rejected')
        },
        (e: { code: string; details?: { blockers?: string[] }; message: string }) => e,
      )
      expect(error.code).toBe(code)
      // The checks run inside the transaction, which writes nothing: no records, no status change.
      expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
      expect(db.tx.attendanceRecord.createMany).not.toHaveBeenCalled()
      expect(db.tx.attendanceUpload.updateMany).not.toHaveBeenCalled()
      expect(auditRows(db.tx)).toHaveLength(0)
      return error
    }

    it('with an incomplete pair: WEEK_NOT_READY with the blockers', async () => {
      seedWeek(dayPunches({ idPrefix: 'lone', employeeId: 'emp-36', date: '2026-11-06', times: ['18:26'] }))

      const error = await expectRefused('WEEK_NOT_READY')

      expect(error.details?.blockers).toEqual(['NEEDS_FIXING'])
      expect(error.message).toContain('1 day(s) need fixing')
    })

    it('with an unknown or duplicate code', async () => {
      seedWeek(dayPunches({ idPrefix: 'u', employeeId: null, empCode: '0999', date: '2026-11-05', times: ['08:00', '17:00'], matchStatus: 'UNKNOWN' }))

      const error = await expectRefused('WEEK_NOT_READY')

      expect(error.details?.blockers).toEqual(['UNRESOLVED_CODES'])
      expect(error.message).toContain('1 code(s) to fix')
    })

    it('with an inactive employee waiting on a decision', async () => {
      seedWeek(dayPunches({ idPrefix: 'i2', employeeId: 'emp-2', empCode: '0002', date: '2026-11-05', times: ['08:00', '16:00'] }))
      serveEmployees([
        asha,
        ravi,
        approvedInactive,
        rejectedResigned,
        makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false }),
      ])

      const error = await expectRefused('WEEK_NOT_READY')

      expect(error.details?.blockers).toEqual(['PENDING_DECISIONS'])
    })

    it('while the week has not ended: WEEK_NOT_ENDED when that is the only blocker (C4, E2E-34)', async () => {
      freezeClock('2026-11-11T10:00:00Z') // Wednesday, the last day of the week

      const error = await expectRefused('WEEK_NOT_ENDED')

      expect(error.message).toMatch(/hasn't ended/i)
    })

    it('reports WEEK_NOT_READY, not WEEK_NOT_ENDED, when other blockers exist as well', async () => {
      freezeClock('2026-11-11T10:00:00Z')
      seedWeek(dayPunches({ idPrefix: 'lone', employeeId: 'emp-36', date: '2026-11-06', times: ['18:26'] }))

      const error = await expectRefused('WEEK_NOT_READY')

      expect(error.details?.blockers).toEqual(['WEEK_NOT_ENDED', 'NEEDS_FIXING'])
    })

    it.each(['APPROVED', 'SYNC_FAILED'])('when the week is %s: WEEK_NOT_IN_REVIEW, ahead of every other check', async (status) => {
      serveUpload(db, makeUpload({ status }))
      seedWeek(dayPunches({ idPrefix: 'lone', employeeId: 'emp-36', date: '2026-11-06', times: ['18:26'] }))

      await expectRefused('WEEK_NOT_IN_REVIEW')
    })
  })

  it('a double approve loses the race: the second caller gets WEEK_NOT_IN_REVIEW and writes nothing', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceRecord.createMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('does not audit an approval whose records could not be written', async () => {
    db.tx.attendanceRecord.createMany.mockRejectedValue(new Error('disk full'))

    await expect(approveWeek(WEEK_ID)).rejects.toThrow('disk full')

    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('rejects a weekId that is not a Thursday, a week with no data, and an Excel-era week', async () => {
    await expect(approveWeek('2026-11-06')).rejects.toMatchObject({ code: 'INVALID_WEEK' })

    serveUpload(db, null)
    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })

    serveUpload(db, makeExcelUpload())
    await expect(approveWeek(WEEK_ID)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })
})

// ─── reopenWeek (US-12.27, US-12.28) ──────────────────────────────────────────

describe('reopenWeek', () => {
  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED', approvedAt: new Date('2026-11-12T05:00:00Z') }))
  })

  it('moves an approved week back to review, clears the approval time and deletes its attendance records', async () => {
    const { reopenedAt } = await reopenWeek(WEEK_ID)

    expect(reopenedAt).toBeInstanceOf(Date)
    expect(db.tx.attendanceUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'upload-1', status: 'APPROVED' },
      data: { status: 'REVIEW', approvedAt: null, lastSyncError: null },
    })
    expect(db.tx.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1' } })
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })

  it('records a REOPEN audit row inside the transaction', async () => {
    await reopenWeek(WEEK_ID)

    expect(db.auditLog.create).not.toHaveBeenCalled()
    expect(auditRows(db.tx)[0]).toMatchObject({ actionType: 'REOPEN', entityType: 'ATTENDANCE_WEEK', entityId: 'upload-1' })
    expect(auditRows(db.tx)[0].detailsJson).toMatchObject({ summary: 'Reopened for editing', weekStart: '2026-11-05', weekEnd: '2026-11-11' })
  })

  it('looks for an approved or revised payroll run of that week', async () => {
    await reopenWeek(WEEK_ID)

    expect(db.payrollRun.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: utc('2026-11-05'), status: { in: ['APPROVED', 'REVISED'] } },
      select: { id: true, status: true },
    })
  })

  it.each(['APPROVED', 'REVISED'])('is refused once payroll is %s (PAYROLL_ALREADY_APPROVED)', async (status) => {
    db.payrollRun.findFirst.mockResolvedValue(makeRun({ status }))

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'PAYROLL_ALREADY_APPROVED' })

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  })

  it.each(['REVIEW', 'SYNC_FAILED'])('has nothing to reopen on a %s week (WEEK_NOT_IN_REVIEW)', async (status) => {
    serveUpload(db, makeUpload({ status }))

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('a double reopen loses the race: WEEK_NOT_IN_REVIEW and the records are kept', async () => {
    db.tx.attendanceUpload.updateMany.mockResolvedValue({ count: 0 })

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_IN_REVIEW' })

    expect(db.tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(auditRows(db.tx)).toHaveLength(0)
  })

  it('rejects an Excel-era week (EXCEL_ERA_WEEK)', async () => {
    serveUpload(db, makeExcelUpload())

    await expect(reopenWeek(WEEK_ID)).rejects.toMatchObject({ code: 'EXCEL_ERA_WEEK' })
  })
})

// ─── approve, reopen, edit, approve (US-12.24, US-12.27) ──────────────────────

describe('approve, then reopen, edit and approve again', () => {
  it('locks edits after approval, and a reopened edit replaces the hours with no revision and no API call', async () => {
    // A tiny stateful upload and record table, so the three services run against each other.
    const upload = makeUpload({ id: 'upload-1', status: 'REVIEW' })
    let records: Array<{ employeeId: string; attendanceDate: Date; regularHours: number; overtimeHours: number }> = []
    db.attendanceUpload.findFirst.mockImplementation(async () => ({ ...upload }))
    db.tx.attendanceUpload.findFirst.mockImplementation(async () => ({ ...upload }))
    db.tx.$queryRaw.mockImplementation(async () => [lockedRow({ status: upload.status, approvedAt: upload.approvedAt })])
    db.tx.attendanceUpload.updateMany.mockImplementation(async ({ where, data }: { where: { status: string }; data: object }) => {
      if (where.status !== upload.status) return { count: 0 }
      Object.assign(upload, data)
      return { count: 1 }
    })
    db.tx.attendanceRecord.deleteMany.mockImplementation(async () => {
      records = []
      return { count: 0 }
    })
    db.tx.attendanceRecord.createMany.mockImplementation(async ({ data }: { data: typeof records }) => {
      records = [...data]
      return { count: data.length }
    })
    const ashaOvertimeOn5Nov = () =>
      records.find((r) => r.employeeId === 'emp-36' && r.attendanceDate.getTime() === utc('2026-11-05').getTime())?.overtimeHours
    const lastOut = (time: string): SavePair[] => [
      { pairIndex: 0, in: { punchId: 'p-0', time: '07:40' }, out: { punchId: 'p-1', time: '13:04' } },
      { pairIndex: 1, in: { punchId: 'p-2', time: '13:56' }, out: { punchId: 'p-3', time } },
    ]
    const edit = (time: string) =>
      savePunchEdit({
        weekId: WEEK_ID,
        employeeId: 'emp-36',
        date: '2026-11-05',
        mode: { kind: 'LIVE' },
        baseSignature: baseSignatureOf(store, 'emp-36', '2026-11-05'),
        pairs: lastOut(time),
      })

    await approveWeek(WEEK_ID)
    expect(upload.status).toBe('APPROVED')
    expect(ashaOvertimeOn5Nov()).toBe(1.25)

    // The week is locked.
    await expect(edit('18:00')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
    expect(store.rows.find((r) => r.id === 'p-3')!.currentTime).toBe('17:47')

    // Reopen removes the records and unlocks the week.
    await reopenWeek(WEEK_ID)
    expect(upload.status).toBe('REVIEW')
    expect(upload.approvedAt).toBeNull()
    expect(records).toEqual([])

    await edit('18:00')
    await approveWeek(WEEK_ID)

    expect(upload.status).toBe('APPROVED')
    expect(ashaOvertimeOn5Nov()).toBe(1.47)
    // Both approvals, the reopen and the edit (written in the edit's own transaction) were audited;
    // no payroll revision model was used.
    expect(auditRows(db.tx).map((a) => a.actionType)).toEqual(['APPROVE', 'REOPEN', 'UPDATE', 'APPROVE'])
    expect(db.payrollRun.findMany).not.toHaveBeenCalled()
  })
})

// ─── getApprovalSummary (US-12.23) ────────────────────────────────────────────

describe('getApprovalSummary', () => {
  it('totals the hours and counts the employees (US-12.23)', async () => {
    const summary = await getApprovalSummary(WEEK_ID)

    expect(summary).toMatchObject({ employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 1.25, editedDays: 0 })
    expect(summary.changedDaysInCorrection).toBeUndefined()
  })

  it('lists edited days with the original and current punches', async () => {
    seedWeek()
    store.rows.find((r) => r.id === 'p-3')!.currentTime = '18:00'

    const summary = await getApprovalSummary(WEEK_ID)

    expect(summary.editedDays).toBe(1)
    expect(summary.editedDayDetails).toEqual([
      {
        employeeName: 'Asha Rao',
        date: '2026-11-05',
        before: '07:40–13:04, 13:56–17:47',
        after: '07:40–13:04, 13:56–18:00',
      },
    ])
  })

  it('lists the employees being left out, both zero-hour and rejected', async () => {
    const summary = await getApprovalSummary(WEEK_ID)

    expect(summary.leftOut).toEqual([
      { employeeId: 'emp-5', employeeCode: 'TPLGOAHLP005', employeeName: 'Ravi Kumar', reason: 'ZERO_HOURS' },
      { employeeId: 'emp-3', employeeCode: 'TPLGOAHLP003', employeeName: 'Gone Before', reason: 'REJECTED' },
    ])
  })

  it('also works on an approved week (read-only summary)', async () => {
    serveUpload(db, makeUpload({ status: 'APPROVED' }))

    await expect(getApprovalSummary(WEEK_ID)).resolves.toMatchObject({ employeeCount: 2 })
  })

  describe('in a correction, it counts the days that differ from the approved punches', () => {
    const CORRECTION = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 } as const
    /** A correction starts as a full copy of the live punches; `change` edits the copy. */
    function seedWithClone(change: (clones: PunchRow[]) => PunchRow[] = (clones) => clones) {
      seedWeek()
      const clones = store.rows.map((r) => ({ ...r, id: `c-${r.id}`, correctionId: 'session-1' }))
      store.rows.push(...change(clones))
    }

    beforeEach(() => {
      serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
      db.payrollRun.findFirst.mockResolvedValue(makeRun())
      db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    })

    it('is 0 for an untouched clone', async () => {
      seedWithClone()

      const summary = await getApprovalSummary(WEEK_ID, CORRECTION)

      expect(summary.changedDaysInCorrection).toBe(0)
    })

    it('counts an edited day', async () => {
      seedWithClone((clones) => clones.map((r) => (r.id === 'c-p-3' ? { ...r, currentTime: '18:00' } : r)))

      expect((await getApprovalSummary(WEEK_ID, CORRECTION)).changedDaysInCorrection).toBe(1)
    })

    it('counts a day removed from the clone and a day added in it', async () => {
      // Asha's 5 Nov is dropped from the clone and Ravi gets a new 6 Nov.
      seedWithClone((clones) => [
        ...clones.filter((r) => r.employeeId !== 'emp-36'),
        ...dayPunches({ idPrefix: 'cr', employeeId: 'emp-5', empCode: '0005', date: '2026-11-06', times: ['08:00', '16:00'], correctionId: 'session-1' }),
      ])

      expect((await getApprovalSummary(WEEK_ID, CORRECTION)).changedDaysInCorrection).toBe(2)
    })

    it('counts a day where a punch was deleted', async () => {
      seedWithClone((clones) => clones.map((r) => (r.id === 'c-p-3' ? { ...r, currentTime: null } : r)))

      expect((await getApprovalSummary(WEEK_ID, CORRECTION)).changedDaysInCorrection).toBe(1)
    })

    it('reads the clone through the correction session, and refuses an inactive session', async () => {
      seedWithClone()
      await getApprovalSummary(WEEK_ID, CORRECTION)
      expect(db.payrollCorrectionSession.findUnique).toHaveBeenCalledWith({ where: { id: 'session-1' } })

      db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession({ status: 'ABANDONED' }))
      await expect(getApprovalSummary(WEEK_ID, CORRECTION)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    })
  })

  it('rejects a week with no data (WEEK_NOT_READY)', async () => {
    serveUpload(db, null)

    await expect(getApprovalSummary(WEEK_ID)).rejects.toMatchObject({ code: 'WEEK_NOT_READY' })
  })
})
