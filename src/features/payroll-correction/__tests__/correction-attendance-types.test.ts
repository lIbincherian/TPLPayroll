/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '@/features/payroll-adjustments/__tests__/support/memory-db'

// A correction's punches count only when Attendance is one of its selected types.
//
//  - Unticking Attendance after the punches were copied deletes the copy and any draft built from it, and
//    writes one DISCARD audit entry that keeps the edits (under `discarded.edits` only).
//  - A draft is calculated from the copy only when Attendance is selected; otherwise from the approved records.
//  - approveRevision promotes the copy (and rebuilds the records and the left-out count) only when Attendance
//    is selected; a copy left over without it makes the draft stale (the types changed after it was calculated),
//    and nothing is written: the copy, the live punches and the records stay as they are.
//
// The real correction service runs against an in-memory database (the real audit writer too, so the audit rows
// are rows and roll back with the transaction); only the week lock and the punch review are stubbed.

vi.mock('@/lib/prisma', async () => {
  const { createMemoryDb } = await import('@/features/payroll-adjustments/__tests__/support/memory-db')
  return { default: createMemoryDb() }
})
vi.mock('@/features/attendance-sync/services/week-lock.service', () => ({ lockWeekRow: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', () => ({ lockAdjustmentRows: vi.fn() }))
vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))

import prismaImport from '@/lib/prisma'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import {
  abandonCorrection,
  approveRevision,
  beginCorrection,
  recalculateAndCreateRevision,
  startAttendanceCorrection,
} from '@/features/payroll-correction/services/correction.service'

const db = prismaImport as unknown as MemoryDb

const RUN = 'run-1'
const UPLOAD = 'upload-1'
const REV1 = 'rev-1'
const DRAFT = 'rev-2'
const WEEK_START = new Date('2025-07-10T00:00:00.000Z')
const WEEK_END = new Date('2025-07-16T00:00:00.000Z')
const DAYS = Array.from({ length: 7 }, (_, i) => new Date(WEEK_START.getTime() + i * 86400000))

type Row = Record<string, any>

function punch(id: string, employeeId: string, code: string, position: 'IN' | 'OUT', time: string, pairIndex = 0): Row {
  return {
    id,
    attendanceUploadId: UPLOAD,
    correctionId: null,
    employeeId,
    empCode: code,
    empName: employeeId,
    matchStatus: 'MATCHED',
    punchDate: WEEK_START,
    pairIndex,
    position,
    source: 'API',
    originalTime: time,
    currentTime: time,
    note: null,
    mcid: null,
  }
}

function seedWorld() {
  db.reset()
  db.seed('employee', [
    { id: 'emp-1', employeeId: 'EMP-001', employeeName: 'Anita' },
    { id: 'emp-2', employeeId: 'EMP-002', employeeName: 'Rajesh' },
  ])
  db.seed('payrollRun', [{ id: RUN, payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, status: 'APPROVED', currentRevisionNumber: 1 }])
  db.seed('payrollRevision', [{ id: REV1, payrollRunId: RUN, revisionNumber: 1, status: 'APPROVED', isCurrent: true, totalNetPayable: 9000 }])
  db.seed('payrollRunEmployee', [
    { payrollRunId: RUN, payrollRevisionId: REV1, employeeId: 'emp-1', netPayable: 5000 },
    { payrollRunId: RUN, payrollRevisionId: REV1, employeeId: 'emp-2', netPayable: 4000 },
  ])
  db.seed('attendanceUpload', [
    {
      id: UPLOAD,
      payrollWeekStartDate: WEEK_START,
      payrollWeekEndDate: WEEK_END,
      isActiveForPayrollWeek: true,
      source: 'ETIMEOFFICE',
      status: 'APPROVED',
      approvedLeftOutCount: 5,
    },
  ])
  db.seed('attendancePunch', [
    punch('live-1-in', 'emp-1', '9001', 'IN', '08:00'),
    punch('live-1-out', 'emp-1', '9001', 'OUT', '17:00'),
    punch('live-2-in', 'emp-2', '9002', 'IN', '08:00'),
    punch('live-2-out', 'emp-2', '9002', 'OUT', '16:00'),
  ])
  db.seed('attendanceRecord', [
    { id: 'rec-1', attendanceUploadId: UPLOAD, employeeId: 'emp-1', attendanceDate: WEEK_START, regularHours: 8, overtimeHours: 1 },
    { id: 'rec-2', attendanceUploadId: UPLOAD, employeeId: 'emp-2', attendanceDate: WEEK_START, regularHours: 8, overtimeHours: 0 },
  ])
}

const session = () => db.rows('payrollCorrectionSession').at(-1)!
const clones = () => db.rows('attendancePunch').filter((r) => r.correctionId !== null)
const live = () => db.rows('attendancePunch').filter((r) => r.correctionId === null)
const audits = () => db.rows('auditLog')
const revisionIds = () => db.rows('payrollRevision').map((r) => r.id).sort()

/** begin + start with Attendance: the live punches are copied. */
async function openWithCopy() {
  await beginCorrection(RUN)
  await startAttendanceCorrection(RUN, { types: ['ATTENDANCE'], reason: 'wrong out' })
}

/** Anita's OUT edited in the copy, 17:00 -> 19:00. */
async function editAnitaOut() {
  await db.attendancePunch.updateMany({ where: { correctionId: session().id, employeeId: 'emp-1', position: 'OUT' }, data: { currentTime: '19:00' } })
}

async function seedDraft() {
  db.seed('payrollRevision', [{ id: DRAFT, payrollRunId: RUN, revisionNumber: 2, status: 'DRAFT', isCurrent: false, totalNetPayable: 9100 }])
  db.seed('payrollRunEmployee', [{ payrollRunId: RUN, payrollRevisionId: DRAFT, employeeId: 'emp-1', netPayable: 5100, additions: 0, deductions: 0 }])
  await db.payrollCorrectionSession.updateMany({ where: { status: 'IN_PROGRESS' }, data: { draftRevisionId: DRAFT } })
}

beforeEach(() => {
  seedWorld()
  vi.clearAllMocks()
  vi.mocked(lockWeekRow).mockImplementation((async () => {
    db.log.push('lock')
    return { id: UPLOAD, source: 'ETIMEOFFICE', status: 'APPROVED', syncLockedAt: null, approvedAt: new Date(), payrollWeekStartDate: WEEK_START }
  }) as never)
})

// ─── startAttendanceCorrection: unticking Attendance ─────────────────────────

describe('startAttendanceCorrection with Attendance unticked after the punches were copied', () => {
  it('deletes the copy and the draft built from it, clears the draft pointer, keeps the live punches, and saves the new types and reason', async () => {
    await openWithCopy()
    expect(clones()).toHaveLength(4)
    await editAnitaOut()
    await seedDraft()
    const liveBefore = live()

    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'only adjustments now' })

    expect(clones()).toHaveLength(0)
    expect(live()).toEqual(liveBefore) // the approved punches were never touched
    expect(revisionIds()).toEqual([REV1]) // the draft is gone ...
    expect(db.rows('payrollRunEmployee').every((r) => r.payrollRevisionId === REV1)).toBe(true) // ... with its employee rows
    expect(session()).toMatchObject({
      status: 'IN_PROGRESS',
      draftRevisionId: null,
      correctionTypesJson: ['ADJUSTMENTS'],
      correctionReason: 'only adjustments now',
    })
  })

  it('writes one DISCARD audit entry that keeps the edit, under discarded.edits and nowhere else', async () => {
    await openWithCopy()
    await editAnitaOut()

    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: null as never })

    expect(audits()).toHaveLength(1)
    const [entry] = audits()
    expect(entry).toMatchObject({ actionType: 'DISCARD', entityType: 'ATTENDANCE_WEEK', entityId: UPLOAD })
    expect(entry.detailsJson).toEqual({
      summary: 'Discarded punch edits (Attendance unticked): 1 punch edit(s)',
      correctionId: session().id,
      payrollRunId: RUN,
      weekStart: '2025-07-10',
      discarded: {
        edits: [
          expect.objectContaining({ employeeCode: 'EMP-001', date: '2025-07-10', position: 'OUT', original: '17:00', current: '19:00' }),
        ],
      },
    })
    expect(Object.keys(entry.detailsJson)).not.toContain('edits') // not repeated at the top level
  })

  it('a copy with no edits is still thrown away and audited (0 edits)', async () => {
    await openWithCopy()
    await seedDraft()

    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'x' })

    expect(clones()).toHaveLength(0)
    expect(revisionIds()).toEqual([REV1])
    expect(audits()).toHaveLength(1)
    expect(audits()[0].detailsJson.summary).toBe('Discarded punch edits (Attendance unticked): 0 punch edit(s)')
    expect(audits()[0].detailsJson.discarded.edits).toEqual([])
  })

  it('with no copy (never ticked) it writes no audit entry, and saving the same types again leaves a draft and its pointer alone', async () => {
    await beginCorrection(RUN)
    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'adjustments only' })
    await seedDraft()

    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'adjustments only, reworded' })

    expect(audits()).toHaveLength(0)
    expect(revisionIds()).toEqual([REV1, DRAFT])
    expect(session()).toMatchObject({ draftRevisionId: DRAFT, correctionTypesJson: ['ADJUSTMENTS'], correctionReason: 'adjustments only, reworded' })
    expect(clones()).toHaveLength(0)
  })

  it('ticking Attendance again copies a fresh set from the live punches: the unticked edit is gone', async () => {
    await openWithCopy()
    await editAnitaOut()
    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'x' })

    await startAttendanceCorrection(RUN, { types: ['ATTENDANCE', 'ADJUSTMENTS'], reason: 'x' })

    expect(clones()).toHaveLength(4)
    expect(clones().find((r) => r.employeeId === 'emp-1' && r.position === 'OUT')).toMatchObject({ currentTime: '17:00', clonedFromPunchId: 'live-1-out' })
    expect(audits()).toHaveLength(1) // only the earlier discard
  })

  it('keeping Attendance ticked keeps the copy and its edits and audits nothing; the same types keep the draft, a different set clears it', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()

    await startAttendanceCorrection(RUN, { types: ['ATTENDANCE'], reason: 'same types' })

    expect(clones()).toHaveLength(4)
    expect(session().draftRevisionId).toBe(DRAFT)
    expect(revisionIds()).toEqual([REV1, DRAFT])

    // Ticking another type changes the set: the draft was calculated for the old one, so it goes (the copy stays).
    await startAttendanceCorrection(RUN, { types: ['ATTENDANCE', 'ADJUSTMENTS'], reason: 'both' })

    expect(clones()).toHaveLength(4)
    expect(clones().find((r) => r.employeeId === 'emp-1' && r.position === 'OUT')!.currentTime).toBe('19:00')
    expect(session()).toMatchObject({ draftRevisionId: null, correctionTypesJson: ['ATTENDANCE', 'ADJUSTMENTS'] })
    expect(revisionIds()).toEqual([REV1])
    expect(audits()).toHaveLength(0)
  })

  it('a failure while deleting the copy rolls everything back: copy, draft, pointer and types as they were', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()
    const before = db.snapshot()
    db.failOn('attendancePunch.deleteMany', new Error('delete failed'))

    await expect(startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'x' })).rejects.toThrow('delete failed')

    expect(db.snapshot()).toEqual(before)
  })

  it('a failure while writing the audit entry rolls the deletion back too', async () => {
    await openWithCopy()
    await editAnitaOut()
    const before = db.snapshot()
    db.failOn('auditLog.create', new Error('audit failed'))

    await expect(startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'x' })).rejects.toThrow('audit failed')

    expect(db.snapshot()).toEqual(before)
    expect(clones()).toHaveLength(4) // the edits were not lost without their audit entry
  })
})

// ─── recalculateAndCreateRevision: which hours it uses ───────────────────────

describe('recalculateAndCreateRevision uses the copied punches only when Attendance is selected', () => {
  const wage = [{ hourlyRate: 62.5, weeklySalary: 2500 }]
  const payEmployee = (id: string, code: string) => ({
    id, employeeId: code, employeeName: id, designation: 'Guard', designationShort: 'G', site: 'Gate', gPay: null, bankAccount: null, wageHistory: wage,
  })
  const records = () => [
    { employeeId: 'emp-1', regularHours: 8, overtimeHours: 2, employee: payEmployee('emp-1', 'EMP-001') },
    { employeeId: 'emp-1', regularHours: 8, overtimeHours: 0, employee: payEmployee('emp-1', 'EMP-001') },
  ]

  function stubReads() {
    // The services read wage history and a run's current revision through relations the in-memory database does not model.
    vi.spyOn(db.payrollRun, 'findUnique').mockResolvedValue({
      id: RUN, payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, status: 'APPROVED', currentRevisionNumber: 1,
      revisions: [db.rows('payrollRevision')[0]],
    } as never)
    const recordRead = vi.spyOn(db.attendanceRecord, 'findMany').mockResolvedValue(records() as never)
    vi.spyOn(db.employee, 'findMany').mockResolvedValue([payEmployee('emp-1', 'EMP-001')] as never)
    vi.mocked(getPunchReview).mockResolvedValue({
      counts: { needsFixingDays: 0 },
      employees: [
        {
          employeeId: 'emp-1', employeeCode: 'EMP-001', employeeName: 'Anita', tag: 'MATCHED', hasAnyPunch: true, totalRegularHours: 8, totalOvertimeHours: 3,
          days: [{ date: '2025-07-10', regularHours: 8, overtimeHours: 3 }],
        },
      ],
    } as never)
    return recordRead
  }

  it('Attendance not selected, with a copy left over: the copy is dropped and audited, and the hours come from the approved records (16 regular, 2 overtime)', async () => {
    await openWithCopy()
    await editAnitaOut()
    const recordRead = stubReads()
    const sess = session()

    const result = await recalculateAndCreateRevision({
      payrollRunId: RUN, correctionReason: 'adjustments', correctionTypes: ['ADJUSTMENTS'], correctionSessionId: sess.id,
    })

    expect(getPunchReview).not.toHaveBeenCalled()
    expect(recordRead).toHaveBeenCalledTimes(1)
    expect(clones()).toHaveLength(0)
    expect(audits()).toHaveLength(1)
    expect(audits()[0]).toMatchObject({ actionType: 'DISCARD', entityId: UPLOAD })
    expect(audits()[0].detailsJson.summary).toBe('Discarded punch edits (Attendance unticked): 1 punch edit(s)')
    const row = db.rows('payrollRunEmployee').find((r) => r.payrollRevisionId === result.revisionId)!
    expect(row).toMatchObject({ employeeId: 'emp-1', regularHours: 16, overtimeHours: 2, regularPay: 1000, overtimePay: 125, netPayable: 1125 })
    expect(session()).toMatchObject({ draftRevisionId: result.revisionId, correctionTypesJson: ['ADJUSTMENTS'] })
  })

  it('Attendance not selected and no copy: nothing is dropped or audited', async () => {
    await beginCorrection(RUN)
    stubReads()

    await recalculateAndCreateRevision({
      payrollRunId: RUN, correctionReason: 'adjustments', correctionTypes: ['ADJUSTMENTS'], correctionSessionId: session().id,
    })

    expect(audits()).toHaveLength(0)
    expect(getPunchReview).not.toHaveBeenCalled()
  })

  it('Attendance selected with a copy: the hours come from the copied punches (8 regular, 3 overtime), not from the records', async () => {
    await openWithCopy()
    const recordRead = stubReads()

    const result = await recalculateAndCreateRevision({
      payrollRunId: RUN, correctionReason: 'punches', correctionTypes: ['ATTENDANCE'], correctionSessionId: session().id,
    })

    expect(getPunchReview).toHaveBeenCalledTimes(1)
    expect(recordRead).not.toHaveBeenCalled()
    expect(clones()).toHaveLength(4) // kept
    expect(audits()).toHaveLength(0)
    const row = db.rows('payrollRunEmployee').find((r) => r.payrollRevisionId === result.revisionId)!
    expect(row).toMatchObject({ regularHours: 8, overtimeHours: 3, regularPay: 500, overtimePay: 187.5, netPayable: 687.5 })
  })

  it('a failing draft write after the copy was dropped rolls the drop back (the copy and its audit entry survive/are absent together)', async () => {
    await openWithCopy()
    await editAnitaOut()
    stubReads()
    const before = db.snapshot()
    db.failOn('payrollRevision.create', new Error('draft failed'))

    await expect(
      recalculateAndCreateRevision({ payrollRunId: RUN, correctionReason: 'x', correctionTypes: ['ADJUSTMENTS'], correctionSessionId: session().id }),
    ).rejects.toThrow('draft failed')

    expect(db.snapshot()).toEqual(before)
    expect(clones()).toHaveLength(4)
    expect(audits()).toHaveLength(0)
  })
})

// ─── approveRevision: what is promoted ───────────────────────────────────────

describe('approveRevision promotes the copied punches only when Attendance is selected', () => {
  const review = {
    counts: { needsFixingDays: 0 },
    employees: [
      {
        employeeId: 'emp-1', employeeCode: 'EMP-001', employeeName: 'Anita', tag: 'MATCHED', hasAnyPunch: true, totalRegularHours: 8, totalOvertimeHours: 1,
        days: DAYS.map((d, i) => ({ date: d.toISOString().slice(0, 10), regularHours: i === 0 ? 8 : 0, overtimeHours: i === 0 ? 1 : 0 })),
      },
      {
        employeeId: 'emp-2', employeeCode: 'EMP-002', employeeName: 'Rajesh', tag: 'MATCHED', hasAnyPunch: false, totalRegularHours: 0, totalOvertimeHours: 0,
        days: DAYS.map((d) => ({ date: d.toISOString().slice(0, 10), regularHours: 0, overtimeHours: 0 })),
      },
    ],
  }

  beforeEach(() => {
    vi.mocked(getPunchReview).mockResolvedValue(review as never)
  })

  it('Attendance selected: the copy becomes the live set, the records are rebuilt, and the stored left-out count follows (5 -> 2: one zero-hours employee, one rejected)', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()
    db.seed('attendanceEmployeeDecision', [
      { attendanceUploadId: UPLOAD, employeeId: 'emp-1', decision: 'APPROVED' },
      { attendanceUploadId: UPLOAD, employeeId: 'emp-3', decision: 'REJECTED' },
    ])

    await approveRevision(DRAFT)

    expect(live()).toHaveLength(4)
    expect(clones()).toHaveLength(0)
    expect(live().find((r) => r.employeeId === 'emp-1' && r.position === 'OUT')).toMatchObject({ currentTime: '19:00', originalTime: '17:00', clonedFromPunchId: null })
    expect(db.rows('attendanceRecord').map((r) => r.employeeId)).toEqual(Array(7).fill('emp-1')) // emp-2 has no hours: no rows
    expect(db.rows('attendanceRecord')[0]).toMatchObject({ regularHours: 8, overtimeHours: 1, verificationDecision: 'APPROVED' })
    expect(db.rows('attendanceUpload')[0].approvedLeftOutCount).toBe(2)
    expect(session()).toMatchObject({ status: 'APPLIED' })
    expect(audits()).toHaveLength(1)
    expect(audits()[0]).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_WEEK' })
    expect(audits()[0].detailsJson.summary).toBe('Correction applied as revision 2')
  })

  it('Attendance not selected but a copy is still there: the draft is stale (types), and nothing is written: the copy, the live punches, the records and the left-out count stay as they were', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()
    await db.payrollCorrectionSession.updateMany({ where: { status: 'IN_PROGRESS' }, data: { correctionTypesJson: ['ADJUSTMENTS'] } })
    const before = db.snapshot()

    await expect(approveRevision(DRAFT)).rejects.toMatchObject({
      code: 'REVISION_STALE',
      message: 'This preview is out of date: the correction types changed after it was calculated. Go back and recalculate.',
    })

    expect(db.snapshot()).toEqual(before)
    expect(clones()).toHaveLength(4) // the copy and its edits are still there, to be dropped or used when the types are saved again
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(audits()).toHaveLength(0)
    expect(session()).toMatchObject({ status: 'IN_PROGRESS', draftRevisionId: DRAFT })
    expect(db.rows('payrollRun')[0]).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
  })

  it('an adjustments-only correction (no copy at all) leaves punches, records and the left-out count alone and writes no audit entry', async () => {
    await beginCorrection(RUN)
    await startAttendanceCorrection(RUN, { types: ['ADJUSTMENTS'], reason: 'x' })
    await seedDraft()
    const liveBefore = live()
    const recordsBefore = db.rows('attendanceRecord')
    db.log.length = 0

    await approveRevision(DRAFT)

    expect(live()).toEqual(liveBefore)
    expect(db.rows('attendanceRecord')).toEqual(recordsBefore)
    expect(db.rows('attendanceUpload')[0].approvedLeftOutCount).toBe(5)
    expect(db.log).not.toContain('attendanceUpload.update')
    expect(audits()).toHaveLength(0)
    expect(session().status).toBe('APPLIED')
  })

  it('a failure while promoting rolls the whole approval back: copy, live punches, records, count, revision and session as they were', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()
    const before = db.snapshot()
    db.failOn('attendanceUpload.update', new Error('count write failed'))

    await expect(approveRevision(DRAFT)).rejects.toThrow('count write failed')

    expect(db.snapshot()).toEqual(before)
    expect(db.rows('payrollRevision').find((r) => r.id === DRAFT)).toMatchObject({ status: 'DRAFT' })
    expect(session().status).toBe('IN_PROGRESS')
  })
})

// ─── abandonCorrection: the other way a copy ends ────────────────────────────

describe('abandonCorrection with a copy', () => {
  it('deletes the copy and the draft, keeps the live punches, and writes the DISCARD entry under discarded.edits', async () => {
    await openWithCopy()
    await editAnitaOut()
    await seedDraft()
    const liveBefore = live()

    const result = await abandonCorrection(RUN)

    expect(result.discardedEdits).toBe(1)
    expect(clones()).toHaveLength(0)
    expect(live()).toEqual(liveBefore)
    expect(revisionIds()).toEqual([REV1])
    expect(audits()).toHaveLength(1)
    expect(audits()[0].detailsJson.summary).toBe('Discarded correction: 1 punch edit(s)')
    expect(audits()[0].detailsJson.discarded.edits).toHaveLength(1)
    expect(Object.keys(audits()[0].detailsJson)).not.toContain('edits')
    expect(db.rows('attendanceUpload')[0].approvedLeftOutCount).toBe(5)
  })
})
