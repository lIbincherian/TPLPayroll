// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { fetchPunchData } from '@/features/attendance-sync/services/etimeoffice.client'
import { getReviewGridEmployees } from '@/features/attendance-sync/lib/matching'
import { savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import type { EmployeeLite, ReviewMode, SavePair } from '@/features/attendance-sync/types/attendance-sync.types'
import {
  auditRows,
  baseSignatureOf,
  dayPunches,
  freezeClock,
  installPunchStore,
  makeEmployee,
  makeRun,
  makeSession,
  makeUpload,
  resetDb,
  serveDecisionLookup,
  serveEmployeeLookup,
  serveUpload,
  type Db,
  type PunchRow,
  type PunchStore,
} from './service-fixtures'

// Round 4, item 10: savePunchEdit asks "is this employee in the grid?" with single-row reads (the employee,
// the employee's decision, in a correction the approved-records count) instead of loading every employee
// and every decision of the week. It asks once before the lock, as a fast fail, and again under it.

const db = prisma as unknown as Db

const WEEK_ID = '2026-11-05'
const DAY = '2026-11-05'
const LIVE: ReviewMode = { kind: 'LIVE' }
const CORRECTION: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }
const NOT_IN_REVIEW = "That employee isn't in this week's review."
const EMPLOYEE_SELECT = { id: true, employeeId: true, employeeName: true, isActive: true, dateOfResignation: true }

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })
const oldTimer = makeEmployee({ id: 'emp-2', employeeId: 'TPLGOAHLP002', employeeName: 'Old Timer', isActive: false })
const gone = makeEmployee({
  id: 'emp-3',
  employeeId: 'TPLGOAHLP003',
  employeeName: 'Gone Before',
  dateOfResignation: new Date('2026-11-01T00:00:00Z'),
})

let store: PunchStore
let fetchSpy: ReturnType<typeof vi.spyOn>

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

const pair = (pairIndex: number, inn: SavePair['in'], out: SavePair['out']): SavePair => ({ pairIndex, in: inn, out })

/** A hand-entered pair on a day with no punches. */
const newPair = (): SavePair[] => [pair(0, { time: '08:00' }, { time: '16:00' })]

function save(employeeId: string, over: { mode?: ReviewMode; pairs?: SavePair[] } = {}) {
  const mode = over.mode ?? LIVE
  return savePunchEdit({
    weekId: WEEK_ID,
    employeeId,
    date: DAY,
    mode,
    baseSignature: baseSignatureOf(store, employeeId, DAY, mode.kind === 'CORRECTION' ? mode.correctionId : null),
    pairs: over.pairs ?? newPair(),
  })
}

/** Serve the employees and the decisions to every kind of read, the findUnique the save uses and the findMany the review uses. */
function world(employees: EmployeeLite[], decisions: Array<{ employeeId: string; decision: string }> = [], rows: PunchRow[] = []) {
  store = installPunchStore(db, rows)
  db.employee.findMany.mockResolvedValue(employees)
  db.tx.employee.findMany.mockResolvedValue(employees)
  serveEmployeeLookup(db, employees)
  db.attendanceEmployeeDecision.findMany.mockResolvedValue(decisions)
  db.tx.attendanceEmployeeDecision.findMany.mockResolvedValue(decisions)
  serveDecisionLookup(db, decisions)
}

function expectNothingWritten() {
  for (const client of [db, db.tx]) {
    expect(client.attendancePunch.create).not.toHaveBeenCalled()
    expect(client.attendancePunch.update).not.toHaveBeenCalled()
    expect(client.attendancePunch.delete).not.toHaveBeenCalled()
    expect(client.auditLog.create).not.toHaveBeenCalled()
    expect(client.payrollCorrectionSession.update).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  resetDb(db)
  vi.mocked(fetchPunchData).mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the real network must not be used'))
  freezeClock('2026-11-13T03:00:00Z')
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'REVIEW' }))
  world([asha, oldTimer, gone])
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(fetchPunchData).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
  vi.useRealTimers()
})

// ─── What is read, and when ───────────────────────────────────────────────────

describe('savePunchEdit reads one employee, not the whole roster, to decide membership', () => {
  it('before the transaction it calls employee.findUnique and attendanceEmployeeDecision.findUnique on the plain client', async () => {
    await save('emp-36')

    expect(db.employee.findUnique).toHaveBeenCalledTimes(1)
    expect(db.employee.findUnique).toHaveBeenCalledWith({ where: { id: 'emp-36' }, select: EMPLOYEE_SELECT })
    expect(db.attendanceEmployeeDecision.findUnique).toHaveBeenCalledTimes(1)
    expect(db.attendanceEmployeeDecision.findUnique).toHaveBeenCalledWith({
      where: { attendanceUploadId_employeeId: { attendanceUploadId: 'upload-1', employeeId: 'emp-36' } },
      select: { decision: true },
    })
    expect(order(db.employee.findUnique)).toBeLessThan(order(db.$transaction))
    expect(order(db.attendanceEmployeeDecision.findUnique)).toBeLessThan(order(db.$transaction))
  })

  it('never calls employee.findMany or attendanceEmployeeDecision.findMany before the transaction opens', async () => {
    await save('emp-36')

    // The review that is read after the commit may list everyone; nothing before the transaction may.
    const txOpened = order(db.$transaction)
    for (const findMany of [db.employee.findMany, db.attendanceEmployeeDecision.findMany]) {
      for (let i = 0; i < findMany.mock.calls.length; i++) expect(order(findMany, i)).toBeGreaterThan(txOpened)
    }
    // And under the lock it is single-row reads again.
    expect(db.tx.employee.findMany).not.toHaveBeenCalled()
    expect(db.tx.attendanceEmployeeDecision.findMany).not.toHaveBeenCalled()
  })

  it('when the employee is refused, no roster read happens at all and no transaction opens', async () => {
    world([asha, oldTimer], [{ employeeId: 'emp-2', decision: 'REJECTED' }])

    await expect(save('emp-2')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW })

    expect(db.employee.findMany).not.toHaveBeenCalled()
    expect(db.attendanceEmployeeDecision.findMany).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('under the lock it reads the same two rows again on the transaction client, after the lock and before the first write', async () => {
    await save('emp-36')

    expect(db.tx.employee.findUnique).toHaveBeenCalledTimes(1)
    expect(db.tx.employee.findUnique).toHaveBeenCalledWith({ where: { id: 'emp-36' }, select: EMPLOYEE_SELECT })
    expect(db.tx.attendanceEmployeeDecision.findUnique).toHaveBeenCalledTimes(1)
    expect(order(db.tx.$queryRaw)).toBeLessThan(order(db.tx.employee.findUnique))
    expect(order(db.tx.employee.findUnique)).toBeLessThan(order(db.tx.attendanceEmployeeDecision.findUnique))
    expect(order(db.tx.attendanceEmployeeDecision.findUnique)).toBeLessThan(order(db.tx.attendancePunch.create))
  })

  it('the three reads of one check run one after the other (never overlapped on one connection)', async () => {
    let releaseEmployee!: (value: EmployeeLite | null) => void
    const gate = new Promise<EmployeeLite | null>((resolve) => {
      releaseEmployee = resolve
    })
    db.tx.employee.findUnique.mockReturnValueOnce(gate)
    // (the transaction client is the one that must stay on a single connection)

    const run = save('emp-36')
    await vi.waitFor(() => expect(db.tx.employee.findUnique).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 5))
    expect(db.tx.attendanceEmployeeDecision.findUnique).not.toHaveBeenCalled()
    expect(db.tx.attendanceRecord.count).not.toHaveBeenCalled()

    releaseEmployee(asha)
    await run
    expect(db.tx.attendanceEmployeeDecision.findUnique).toHaveBeenCalledTimes(1)
  })

  it('LIVE never counts approved records; a correction counts them once before the lock and once under it', async () => {
    await save('emp-36')
    expect(db.attendanceRecord.count).not.toHaveBeenCalled()
    expect(db.tx.attendanceRecord.count).not.toHaveBeenCalled()

    resetDb(db)
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.attendanceRecord.count.mockResolvedValue(3)
    db.tx.attendanceRecord.count.mockResolvedValue(3)
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-36' }])
    world([asha], [], dayPunches({ idPrefix: 'c', employeeId: 'emp-36', date: '2026-11-06', times: ['08:00', '12:00'], correctionId: 'session-1' }))

    await save('emp-36', { mode: CORRECTION })

    expect(db.attendanceRecord.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', employeeId: 'emp-36' } })
    expect(db.tx.attendanceRecord.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', employeeId: 'emp-36' } })
  })

  it('the audit text and the stored empCode come from the employee the check returned', async () => {
    await save('emp-36')

    const [created] = auditRows(db.tx)
    expect(created.detailsJson).toMatchObject({
      employeeId: 'emp-36',
      employeeCode: 'TPLGOAHLP036',
      employeeName: 'Asha Rao',
    })
    expect(created.detailsJson.summary).toContain('Asha Rao (TPLGOAHLP036) on 2026-11-05')
    expect(db.tx.attendancePunch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ employeeId: 'emp-36', empCode: '036', source: 'MANUAL' }),
    })
  })
})

// ─── Who is in the grid (live week) ───────────────────────────────────────────

describe('savePunchEdit: who may be edited in a live week', () => {
  it('an inactive employee with an APPROVED decision passes (before the lock and under it)', async () => {
    world([asha, oldTimer], [{ employeeId: 'emp-2', decision: 'APPROVED' }])

    await expect(save('emp-2')).resolves.toMatchObject({ day: { date: DAY } })

    expect(store.day('emp-2', DAY)).toHaveLength(2)
    expect(db.tx.attendanceEmployeeDecision.findUnique).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['REJECTED decision', [{ employeeId: 'emp-2', decision: 'REJECTED' }]],
    ['no decision', []],
  ])('an inactive employee with a %s is refused (EMPLOYEE_NOT_FOUND) and no transaction opens', async (_label, decisions) => {
    world([asha, oldTimer], decisions)

    const error = await save('emp-2').catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.tx.$queryRaw).not.toHaveBeenCalled()
    expectNothingWritten()
    expect(store.rows).toHaveLength(0)
  })

  it('an employee who resigned before the week is refused without a decision and accepted with an APPROVED one', async () => {
    world([asha, gone])
    await expect(save('emp-3')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
    expect(db.$transaction).not.toHaveBeenCalled()

    world([asha, gone], [{ employeeId: 'emp-3', decision: 'APPROVED' }])
    await expect(save('emp-3')).resolves.toMatchObject({ day: { date: DAY } })
  })

  it('an employee who is not in the system at all is refused, with one lookup and no transaction', async () => {
    await expect(save('nobody')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW })

    expect(db.employee.findUnique).toHaveBeenCalledTimes(1)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('the decision of a different employee does not admit this one', async () => {
    world([asha, oldTimer], [{ employeeId: 'emp-36', decision: 'APPROVED' }])

    await expect(save('emp-2')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('removed between the two checks: passes before the lock, refused under it, nothing written', async () => {
    world([asha, oldTimer], [{ employeeId: 'emp-2', decision: 'APPROVED' }])
    // Under the lock the decision has become REJECTED (someone changed it in the employee check meanwhile).
    db.tx.attendanceEmployeeDecision.findUnique.mockResolvedValue({ decision: 'REJECTED' })

    await expect(save('emp-2')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNothingWritten()
    expect(store.rows).toHaveLength(0)
  })

  it('deactivated between the two checks: refused under the lock, nothing written', async () => {
    world([asha], [])
    db.tx.employee.findUnique.mockResolvedValue({ ...asha, isActive: false })

    await expect(save('emp-36')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expectNothingWritten()
  })

  it('deleted between the two checks: refused under the lock, nothing written', async () => {
    world([asha], [])
    db.tx.employee.findUnique.mockResolvedValue(null)

    await expect(save('emp-36')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expectNothingWritten()
  })

  // The single-row check has to give the same answer as the list the grid itself is built from.
  it.each([
    ['active', asha, undefined, true],
    ['active with a REJECTED decision', asha, 'REJECTED', true],
    ['active with an APPROVED decision', asha, 'APPROVED', true],
    ['inactive, undecided', oldTimer, undefined, false],
    ['inactive, APPROVED', oldTimer, 'APPROVED', true],
    ['inactive, REJECTED', oldTimer, 'REJECTED', false],
    ['resigned before the week, undecided', gone, undefined, false],
    ['resigned before the week, APPROVED', gone, 'APPROVED', true],
    ['resigned before the week, REJECTED', gone, 'REJECTED', false],
  ] as Array<[string, EmployeeLite, string | undefined, boolean]>)('agrees with the grid list: %s', async (_label, employee, decision, inGrid) => {
    const decisions = decision ? [{ employeeId: employee.id, decision }] : []
    world([employee], decisions)
    const week = { start: '2026-11-05', end: '2026-11-11' }
    const listed = getReviewGridEmployees([employee], decisions.map((d) => ({ ...d, decision: d.decision as 'APPROVED' | 'REJECTED' })), week).length > 0
    expect(listed).toBe(inGrid)

    const outcome = await save(employee.id).then(
      () => 'saved',
      (e: { code: string }) => e.code,
    )

    expect(outcome).toBe(inGrid ? 'saved' : 'EMPLOYEE_NOT_FOUND')
  })
})

// ─── Correction ───────────────────────────────────────────────────────────────

describe('savePunchEdit: who may be edited in a correction', () => {
  const cloneOf = (employeeId: string) => dayPunches({ idPrefix: 'c', employeeId, date: '2026-11-06', times: ['08:00', '12:00'], correctionId: 'session-1' })

  beforeEach(() => {
    serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
    db.payrollRun.findFirst.mockResolvedValue(makeRun())
    db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    db.tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
  })

  const approvedRecords = (count: number, employeeIds = ['emp-2']) => {
    db.attendanceRecord.count.mockResolvedValue(count)
    db.tx.attendanceRecord.count.mockResolvedValue(count)
    db.attendanceRecord.findMany.mockResolvedValue(employeeIds.map((employeeId) => ({ employeeId })))
  }

  it('a deactivated employee with approved records passes and the clone is edited', async () => {
    world([asha, oldTimer], [], cloneOf('emp-2'))
    approvedRecords(7)

    await expect(save('emp-2', { mode: CORRECTION })).resolves.toMatchObject({ day: { date: DAY } })

    expect(db.attendanceRecord.count).toHaveBeenCalledWith({ where: { attendanceUploadId: 'upload-1', employeeId: 'emp-2' } })
    expect(store.day('emp-2', DAY, 'session-1')).toHaveLength(2)
    expect(db.tx.payrollCorrectionSession.update).toHaveBeenCalledWith({ where: { id: 'session-1' }, data: { draftRevisionId: null } })
  })

  it('a deactivated employee with approved records passes even when the decision is REJECTED', async () => {
    world([asha, oldTimer], [{ employeeId: 'emp-2', decision: 'REJECTED' }], cloneOf('emp-2'))
    approvedRecords(7)

    await expect(save('emp-2', { mode: CORRECTION })).resolves.toMatchObject({ day: { date: DAY } })
  })

  it('a deactivated employee with no approved records is refused before any transaction opens', async () => {
    world([asha, oldTimer], [], cloneOf('emp-2'))
    approvedRecords(0, [])

    await expect(save('emp-2', { mode: CORRECTION })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: NOT_IN_REVIEW })

    expect(db.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('approved records of another employee do not admit this one (the count is for this employee only)', async () => {
    world([asha, oldTimer], [], cloneOf('emp-2'))
    approvedRecords(0, ['emp-36'])

    await expect(save('emp-2', { mode: CORRECTION })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('the records vanished between the two checks: refused under the lock, nothing written, draft pointer untouched', async () => {
    world([asha, oldTimer], [], cloneOf('emp-2'))
    db.attendanceRecord.count.mockResolvedValue(7)
    db.attendanceRecord.findMany.mockResolvedValue([{ employeeId: 'emp-2' }])
    db.tx.attendanceRecord.count.mockResolvedValue(0)

    await expect(save('emp-2', { mode: CORRECTION })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expectNothingWritten()
  })

  it('the employee row is gone under the lock: refused, nothing written', async () => {
    world([asha, oldTimer], [], cloneOf('emp-2'))
    approvedRecords(7)
    db.tx.employee.findUnique.mockResolvedValue(null)

    await expect(save('emp-2', { mode: CORRECTION })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    expectNothingWritten()
  })

  it('an active employee passes whatever the count says', async () => {
    world([asha, oldTimer], [], cloneOf('emp-36'))
    approvedRecords(0, [])

    await expect(save('emp-36', { mode: CORRECTION })).resolves.toMatchObject({ day: { date: DAY } })
  })
})
