import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix round, items 1 and 7 (approveRevision):
//  1. A correction session approves only the draft its punches produced. Editing punches clears the
//     session's draft pointer, so an older draft is REVISION_STALE; the check is repeated inside the
//     transaction after the week row is locked, and the punches are read there too.
//  7. An employee the new revision leaves out has their pending/approved adjustment applications
//     carried to the next week instead of staying attached to the run, and every application's net
//     effect on its adjustment's balance is settled once (against the session's snapshot). The settlement
//     is planned first, from the draft's rows, under the adjustment row locks; a draft that differs from
//     the plan is stale. A punch copy without Attendance among the types is stale as well.

vi.mock('@/lib/prisma', () => {
  const m = () => vi.fn()
  return {
    default: {
      payrollRevision: { findUnique: m() },
      payrollCorrectionSession: { findFirst: m() },
      payrollRun: { update: m() },
      attendancePunch: { count: m(), deleteMany: m(), updateMany: m() },
      $transaction: m(),
    },
  }
})
vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))
vi.mock('@/features/attendance-sync/services/attendance-audit.service', () => ({ auditEntry: vi.fn() }))
vi.mock('@/features/attendance-sync/services/week-lock.service', () => ({ lockWeekRow: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment-lock.service', () => ({ lockAdjustmentRows: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({
  amountToApply: vi.fn(),
  applyApprovalToAdjustment: vi.fn(),
  carryApplicationForward: vi.fn(),
  removeCarryForward: vi.fn(),
  undoApprovalOnAdjustment: vi.fn(),
}))
vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  calculateRegularPay: vi.fn(),
  calculateOvertimePay: vi.fn(),
  calculateNetPayable: vi.fn(),
}))

import prisma from '@/lib/prisma'
import { approveRevision } from '@/features/payroll-correction/services/correction.service'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { lockAdjustmentRows } from '@/features/payroll-adjustments/services/adjustment-lock.service'
import {
  applyApprovalToAdjustment,
  carryApplicationForward,
  undoApprovalOnAdjustment,
} from '@/features/payroll-adjustments/services/adjustment.service'

const RUN_ID = 'run-1'
const SESSION_ID = 'session-1'
const UPLOAD_ID = 'upload-1'
const DRAFT_ID = 'revision-2'
const WEEK_START = new Date('2025-03-06T00:00:00.000Z')

const session = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  payrollRunId: RUN_ID,
  attendanceUploadId: UPLOAD_ID,
  status: 'IN_PROGRESS',
  draftRevisionId: DRAFT_ID,
  // An attendance correction: its copied punches are promoted only because Attendance is selected.
  correctionTypesJson: ['ATTENDANCE'],
  adjustmentSnapshotJson: [],
  attendanceUpload: { id: UPLOAD_ID, payrollWeekStartDate: WEEK_START },
  ...overrides,
})

function makeTx() {
  const m = () => vi.fn()
  return {
    payrollRevision: { updateMany: m() },
    payrollRun: { update: m() },
    payrollRunEmployee: { findMany: m() },
    payrollAdjustment: { findUniqueOrThrow: m() },
    payrollCorrectionSession: { findUnique: m(), update: m() },
    payrollAdjustmentApplication: { findMany: m(), findUnique: m(), updateMany: m() },
    attendanceEmployeeDecision: { findMany: m() },
    attendancePunch: { count: m(), deleteMany: m(), updateMany: m() },
    attendanceRecord: { deleteMany: m(), createMany: m() },
    attendanceUpload: { update: m() },
  }
}
type Tx = ReturnType<typeof makeTx>

/** The draft's employee rows, as approveRevision reads them: who is paid, and what they are deducted and added. */
const paidRows = (...employeeIds: string[]) => employeeIds.map((employeeId) => ({ employeeId, additions: 0, deductions: 0 }))

const order = (fn: unknown, index = 0): number =>
  (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]

let tx: Tx

/** A draft revision 2 of run-1, a session that points at it, and a transaction that finds the same. */
function setup(opts: { before?: ReturnType<typeof session> | null; inside?: ReturnType<typeof session> | null; clones?: number } = {}) {
  tx = makeTx()
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(tx) : Promise.all(arg as Promise<unknown>[])) as never)
  vi.mocked(prisma.payrollRevision.findUnique).mockResolvedValue({
    id: DRAFT_ID,
    payrollRunId: RUN_ID,
    revisionNumber: 2,
    status: 'DRAFT',
    isCurrent: false,
    totalRegularPay: 7000,
    totalOvertimePay: 300,
    totalAdditions: 0,
    totalDeductions: 0,
    totalNetPayable: 7300,
    payrollRun: {
      id: RUN_ID,
      payrollWeekStartDate: WEEK_START,
      payrollWeekEndDate: new Date('2025-03-12T00:00:00.000Z'),
      currentRevisionNumber: 1,
    },
  } as never)
  const before = opts.before === undefined ? session() : opts.before
  vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(before as never)
  tx.payrollCorrectionSession.findUnique.mockResolvedValue(opts.inside === undefined ? before : opts.inside)
  vi.mocked(lockWeekRow).mockResolvedValue({
    id: UPLOAD_ID,
    source: 'ETIMEOFFICE',
    status: 'APPROVED',
    syncLockedAt: null,
    approvedAt: new Date('2025-03-14'),
    payrollWeekStartDate: WEEK_START,
  })
  tx.attendancePunch.count.mockResolvedValue(opts.clones ?? 0)
  vi.mocked(getPunchReview).mockResolvedValue({ employees: [], counts: { needsFixingDays: 0 } } as never)
  tx.attendanceEmployeeDecision.findMany.mockResolvedValue([])
  tx.payrollRunEmployee.findMany.mockResolvedValue(paidRows('emp-1', 'emp-2'))
  tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
  tx.payrollRevision.updateMany.mockResolvedValue({ count: 1 })
}

function expectNothingWritten() {
  expect(tx.payrollRevision.updateMany).not.toHaveBeenCalled()
  expect(tx.payrollRun.update).not.toHaveBeenCalled()
  expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  expect(tx.attendanceRecord.createMany).not.toHaveBeenCalled()
  expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
  expect(tx.attendancePunch.updateMany).not.toHaveBeenCalled()
  expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
  expect(carryApplicationForward).not.toHaveBeenCalled()
  expect(auditEntry).not.toHaveBeenCalled()
  // and nothing outside the transaction either
  expect(prisma.payrollRun.update).not.toHaveBeenCalled()
  expect(prisma.attendancePunch.deleteMany).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Item 1: REVISION_STALE ───────────────────────────────────────────────────

describe('approveRevision: a stale preview cannot be approved', () => {
  it('looks the session up by run (not by draft pointer), in progress only, with its upload', async () => {
    setup()

    await approveRevision(DRAFT_ID)

    expect(prisma.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({
      where: { payrollRunId: RUN_ID, status: 'IN_PROGRESS' },
      include: { attendanceUpload: { select: { id: true, payrollWeekStartDate: true } } },
    })
  })

  it('REVISION_STALE when the session no longer points at this draft (the punches were edited), before any transaction', async () => {
    setup({ before: session({ draftRevisionId: null }) })

    const error = await approveRevision(DRAFT_ID).catch((e: CorrectionServiceError) => e)

    expect(error).toBeInstanceOf(CorrectionServiceError)
    expect(error).toMatchObject({
      code: 'REVISION_STALE',
      message: 'This preview is out of date: the punches changed after it was calculated. Approve the punches again.',
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('REVISION_STALE when the session points at a different draft', async () => {
    setup({ before: session({ draftRevisionId: 'revision-3' }) })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_STALE' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('REVISION_STALE when an edit lands between the first check and the lock: the pointer is cleared inside the transaction', async () => {
    setup({ before: session(), inside: session({ draftRevisionId: null }), clones: 28 })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_STALE' })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expectNothingWritten()
    // The punches were never read for the stale draft.
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
  })

  it('REVISION_STALE (types) when a punch copy is there but Attendance is not among the types: nothing is written and the copy is not dropped', async () => {
    setup({ before: session({ correctionTypesJson: ['ADJUSTMENTS'] }), clones: 28 })

    const error = await approveRevision(DRAFT_ID).catch((e: CorrectionServiceError) => e)

    expect(error).toBeInstanceOf(CorrectionServiceError)
    expect(error).toMatchObject({
      code: 'REVISION_STALE',
      message: 'This preview is out of date: the correction types changed after it was calculated. Go back and recalculate.',
    })
    expectNothingWritten()
    expect(getPunchReview).not.toHaveBeenCalled()
  })

  it.each([
    ['APPLIED', session({ status: 'APPLIED' })],
    ['ABANDONED', session({ status: 'ABANDONED' })],
  ])('CORRECTION_NOT_ACTIVE when the in-transaction read finds the session %s, and writes nothing', async (_status, inside) => {
    setup({ before: session(), inside })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expectNothingWritten()
  })

  it('CORRECTION_NOT_ACTIVE when the session row is gone inside the transaction', async () => {
    setup({ before: session(), inside: null })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expectNothingWritten()
  })

  it('locks the week row of the session first, then re-reads the session, then the punches, then writes', async () => {
    setup({ clones: 28 })

    await approveRevision(DRAFT_ID)

    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    const lock = order(vi.mocked(lockWeekRow))
    const sessionRead = order(tx.payrollCorrectionSession.findUnique)
    const countRead = order(tx.attendancePunch.count)
    const review = order(vi.mocked(getPunchReview))
    const decisions = order(tx.attendanceEmployeeDecision.findMany)
    const firstWrite = order(tx.payrollRevision.updateMany)
    expect([lock, sessionRead, countRead, review, decisions, firstWrite]).toEqual(
      [lock, sessionRead, countRead, review, decisions, firstWrite].slice().sort((a, b) => a - b),
    )
    expect(new Set([lock, sessionRead, countRead, review, decisions, firstWrite]).size).toBe(6)
  })

  it('reads the clone count and the corrected review on the transaction client, not the global one', async () => {
    setup({ clones: 28 })

    await approveRevision(DRAFT_ID)

    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(getPunchReview).toHaveBeenCalledWith(
      '2025-03-06',
      { kind: 'CORRECTION', payrollRunId: RUN_ID, correctionId: SESSION_ID, revisionNumber: 1 },
      tx,
    )
    expect(prisma.attendancePunch.count).not.toHaveBeenCalled()
  })

  it('an unchanged session (pointer equal to the draft) approves normally', async () => {
    setup({ clones: 28 })

    await expect(approveRevision(DRAFT_ID)).resolves.toMatchObject({ revisionId: DRAFT_ID, revisionNumber: 2, status: 'APPROVED' })
    expect(tx.payrollRevision.updateMany).toHaveBeenCalledWith({
      where: { id: DRAFT_ID, status: 'DRAFT' },
      data: { status: 'APPROVED', isCurrent: true, approvedAt: expect.any(Date) },
    })
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'APPLIED', appliedAt: expect.any(Date) },
    })
  })

  it('an adjustments-only correction (no punch copy) approves, and reads no review', async () => {
    setup({ clones: 0 })

    await expect(approveRevision(DRAFT_ID)).resolves.toMatchObject({ status: 'APPROVED' })
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
  })

  it('a legacy draft with no session approves under the week lock (found by start date), without reading punches', async () => {
    setup({ before: null })

    await expect(approveRevision(DRAFT_ID)).resolves.toMatchObject({ status: 'APPROVED' })

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { weekStart: WEEK_START })
    expect(tx.payrollCorrectionSession.findUnique).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
  })

  // Round 4, item 2b: every promotion holds the week lock, with a session or without one.
  it('a draft with no session takes the week lock, by start date, before it promotes anything', async () => {
    setup({ before: null })

    await approveRevision(DRAFT_ID)

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { weekStart: WEEK_START })
    expect(order(lockWeekRow)).toBeLessThan(order(tx.payrollRevision.updateMany)) // the claim of the draft
    expect(order(lockWeekRow)).toBeLessThan(order(tx.payrollRun.update))
    expect(order(lockWeekRow)).toBeLessThan(order(tx.payrollRunEmployee.findMany))
  })

  it('a session-less promotion locks on the transaction client and once, never by upload id', async () => {
    setup({ before: null })

    await approveRevision(DRAFT_ID)

    const [client, where] = vi.mocked(lockWeekRow).mock.calls[0]
    expect(client).toBe(tx)
    expect(where).toEqual({ weekStart: WEEK_START })
    expect(where).not.toHaveProperty('id')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('with a session the lock is still by upload id and still once (the weekStart branch is for session-less drafts only)', async () => {
    setup({ clones: 28 })

    await approveRevision(DRAFT_ID)

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expect(order(lockWeekRow)).toBeLessThan(order(tx.payrollCorrectionSession.findUnique))
  })

  it('a session-less promotion that loses the claim (a second approve) still took the lock first and writes nothing else', async () => {
    setup({ before: null })
    tx.payrollRevision.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(tx.payrollRun.update).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  })

  it('a failing lock query stops a session-less promotion before it writes anything', async () => {
    setup({ before: null })
    vi.mocked(lockWeekRow).mockRejectedValue(new Error('could not obtain lock'))

    await expect(approveRevision(DRAFT_ID)).rejects.toThrow('could not obtain lock')

    expectNothingWritten()
  })

  it('a second approval of the same draft is still REVISION_NOT_DRAFT (the claim fails), not REVISION_STALE', async () => {
    setup()
    tx.payrollRevision.updateMany.mockResolvedValue({ count: 0 })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })
    expect(tx.payrollRun.update).not.toHaveBeenCalled()
  })

  it('a draft that is no longer a DRAFT is rejected before the session is even looked up', async () => {
    setup()
    vi.mocked(prisma.payrollRevision.findUnique).mockResolvedValue({ id: DRAFT_ID, status: 'APPROVED', payrollRun: {} } as never)

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_NOT_DRAFT' })
    expect(prisma.payrollCorrectionSession.findFirst).not.toHaveBeenCalled()
  })

  it('uses a 30 second transaction timeout', async () => {
    setup()

    await approveRevision(DRAFT_ID)

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
  })
})

// ─── Item 7: left-out employees' adjustments ──────────────────────────────────

describe('approveRevision settles the adjustments of the week: employees the revision leaves out are carried forward', () => {
  const adjustment = {
    id: 'adj-1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'RECURRING',
    recurrenceEndType: null,
    amount: 500,
    totalBalance: null,
    remainingBalance: null,
    status: 'ACTIVE',
  }
  const row = (id: string, employeeId: string, approvalStatus = 'PENDING') => ({
    id,
    payrollAdjustmentId: adjustment.id,
    employeeId,
    approvalStatus,
    isReversed: false,
    appliedAmount: 500,
    carriedForwardToPayrollWeekStartDate: null,
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: new Date('2025-03-12T00:00:00.000Z'),
    payrollAdjustment: adjustment,
  })
  /**
   * What the week's three application queries return: the adjustment ids of the scope (select), the applications
   * with their adjustments (include), and the adjustments that have a PENDING application the week after.
   */
  function serveApplications(rows: ReturnType<typeof row>[]) {
    tx.payrollAdjustmentApplication.findMany.mockImplementation((async (args: {
      include?: unknown
      where: { approvalStatus?: string }
    }) => {
      if (args.include) return rows
      if (args.where.approvalStatus === 'PENDING') return []
      return rows.map((r) => ({ payrollAdjustmentId: r.payrollAdjustmentId }))
    }) as never)
    tx.payrollAdjustment.findUniqueOrThrow.mockResolvedValue(adjustment)
  }
  const snapshot = (...entries: Array<[string, string]>) =>
    entries.map(([applicationId, approvalStatus]) => ({ applicationId, approvalStatus }))
  const scope = { payrollWeekStartDate: WEEK_START, OR: [{ payrollRunId: RUN_ID }, { payrollRunId: null }] }

  it('reads the draft\'s rows and the week\'s applications (every one on the run or not yet linked, cancelled adjustments included) on the transaction client', async () => {
    setup()

    await approveRevision(DRAFT_ID)

    expect(tx.payrollRunEmployee.findMany).toHaveBeenCalledWith({
      where: { payrollRevisionId: DRAFT_ID },
      select: { employeeId: true, additions: true, deductions: true },
    })
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({ where: scope, select: { payrollAdjustmentId: true } })
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({ where: scope, include: { payrollAdjustment: true } })
  })

  it('carries each left-out application forward on the transaction client', async () => {
    // The snapshot says the original approval had applied the second one: carrying it forward gives the balance back.
    // Its give-back is planned (and written) before the carry of the one that was never applied.
    setup({ before: session({ adjustmentSnapshotJson: snapshot(['app-approved', 'APPROVED']) }) })
    serveApplications([row('app-pending', 'emp-9'), row('app-approved', 'emp-9', 'APPROVED')])

    await approveRevision(DRAFT_ID)

    expect(carryApplicationForward).toHaveBeenCalledTimes(2)
    expect(carryApplicationForward).toHaveBeenNthCalledWith(1, tx, expect.objectContaining({ id: 'app-approved' }), adjustment, { undoApproval: true })
    expect(carryApplicationForward).toHaveBeenNthCalledWith(2, tx, expect.objectContaining({ id: 'app-pending' }), adjustment, { undoApproval: false })
  })

  it('plans before it promotes (the adjustments are locked after the week) and settles after the run is updated, before the applications are re-pointed to the new revision', async () => {
    setup()
    serveApplications([row('app-1', 'emp-9')])

    await approveRevision(DRAFT_ID)

    expect(lockAdjustmentRows).toHaveBeenCalledWith(tx, ['adj-1'])
    expect(order(vi.mocked(lockWeekRow))).toBeLessThan(order(tx.payrollRunEmployee.findMany))
    expect(order(tx.payrollRunEmployee.findMany)).toBeLessThan(order(vi.mocked(lockAdjustmentRows)))
    expect(order(vi.mocked(lockAdjustmentRows))).toBeLessThan(order(tx.payrollRevision.updateMany))
    expect(order(tx.payrollRun.update)).toBeLessThan(order(vi.mocked(carryApplicationForward)))
    expect(order(vi.mocked(carryApplicationForward))).toBeLessThan(order(tx.payrollAdjustmentApplication.updateMany))
  })

  it('still re-points the week\'s applications to the new revision afterwards', async () => {
    setup()
    serveApplications([row('app-1', 'emp-9')])

    await approveRevision(DRAFT_ID)

    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { payrollRunId: RUN_ID },
          { payrollWeekStartDate: WEEK_START, approvalStatus: 'APPROVED', isReversed: false, payrollRunId: null },
        ],
      },
      data: { payrollRunId: RUN_ID, payrollRevisionId: DRAFT_ID },
    })
  })

  it('settles nothing when the paid set is unchanged and no application changed (nobody is left out)', async () => {
    setup()
    serveApplications([])

    await approveRevision(DRAFT_ID)

    expect(carryApplicationForward).not.toHaveBeenCalled()
    expect(applyApprovalToAdjustment).not.toHaveBeenCalled()
    expect(undoApprovalOnAdjustment).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(1)
  })

  it('with nobody paid at all, every pending or approved application is carried forward', async () => {
    setup()
    tx.payrollRunEmployee.findMany.mockResolvedValue([])
    serveApplications([row('a', 'emp-1'), row('b', 'emp-2', 'APPROVED'), row('c', 'emp-3')])

    await approveRevision(DRAFT_ID)

    expect(carryApplicationForward).toHaveBeenCalledTimes(3)
  })

  it('runs for a draft without a session too (an adjustments-only or legacy correction): the application\'s own status says whether it was applied', async () => {
    setup({ before: null })
    serveApplications([row('app-legacy', 'emp-9', 'APPROVED')])

    await approveRevision(DRAFT_ID)

    expect(carryApplicationForward).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'app-legacy' }), adjustment, { undoApproval: true })
  })

  it('runs for an attendance correction that deletes every punch of an employee', async () => {
    setup({ clones: 28 })
    tx.payrollRunEmployee.findMany.mockResolvedValue(paidRows('emp-2')) // emp-1 now has zero hours
    serveApplications([row('emp-1-deduction', 'emp-1')])

    await approveRevision(DRAFT_ID)

    expect(carryApplicationForward).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'emp-1-deduction' }), adjustment, { undoApproval: false })
    // The corrected attendance still replaces the live one.
    expect(tx.attendanceRecord.deleteMany).toHaveBeenCalled()
  })

  it('a carry-forward that throws aborts the approval: nothing after it runs and the session is not marked applied', async () => {
    setup({ clones: 28 })
    serveApplications([row('app-1', 'emp-9'), row('app-2', 'emp-9')])
    vi.mocked(carryApplicationForward).mockRejectedValueOnce(new Error('carry-forward failed'))

    await expect(approveRevision(DRAFT_ID)).rejects.toThrow('carry-forward failed')

    expect(carryApplicationForward).toHaveBeenCalledTimes(1) // the second one is never attempted
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })

  it('does not settle anything when the approval is refused as stale', async () => {
    setup({ before: session({ draftRevisionId: null }) })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_STALE' })
    expect(tx.payrollRunEmployee.findMany).not.toHaveBeenCalled()
    expect(carryApplicationForward).not.toHaveBeenCalled()
  })
})
