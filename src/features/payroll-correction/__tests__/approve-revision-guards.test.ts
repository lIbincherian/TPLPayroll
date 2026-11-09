import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix round, items 1 and 7 (approveRevision):
//  1. A correction session approves only the draft its punches produced. Editing punches clears the
//     session's draft pointer, so an older draft is REVISION_STALE; the check is repeated inside the
//     transaction after the week row is locked, and the punches are read there too.
//  7. An employee the new revision leaves out has their pending/approved adjustment applications
//     skipped (carried to the next week) instead of staying attached to the run.

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
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({ skipAdjustmentApplication: vi.fn() }))
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
import { skipAdjustmentApplication } from '@/features/payroll-adjustments/services/adjustment.service'

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
  attendanceUpload: { id: UPLOAD_ID, payrollWeekStartDate: WEEK_START },
  ...overrides,
})

function makeTx() {
  const m = () => vi.fn()
  return {
    payrollRevision: { updateMany: m() },
    payrollRun: { update: m() },
    payrollRunEmployee: { findMany: m() },
    payrollCorrectionSession: { findUnique: m(), update: m() },
    payrollAdjustmentApplication: { findMany: m(), updateMany: m() },
    attendanceEmployeeDecision: { findMany: m() },
    attendancePunch: { count: m(), deleteMany: m(), updateMany: m() },
    attendanceRecord: { deleteMany: m(), createMany: m() },
  }
}
type Tx = ReturnType<typeof makeTx>

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
  tx.payrollRunEmployee.findMany.mockResolvedValue([{ employeeId: 'emp-1' }, { employeeId: 'emp-2' }])
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
  expect(skipAdjustmentApplication).not.toHaveBeenCalled()
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

  it('a legacy draft with no session approves without locking or reading punches', async () => {
    setup({ before: null })

    await expect(approveRevision(DRAFT_ID)).resolves.toMatchObject({ status: 'APPROVED' })

    expect(lockWeekRow).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.findUnique).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
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

describe('approveRevision carries forward the adjustments of employees the revision leaves out', () => {
  it('asks for PENDING/APPROVED applications of the week for employees outside the new revision, not on cancelled adjustments', async () => {
    setup()

    await approveRevision(DRAFT_ID)

    expect(tx.payrollRunEmployee.findMany).toHaveBeenCalledWith({
      where: { payrollRevisionId: DRAFT_ID },
      select: { employeeId: true },
    })
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({
      where: {
        payrollWeekStartDate: WEEK_START,
        approvalStatus: { in: ['PENDING', 'APPROVED'] },
        employeeId: { notIn: ['emp-1', 'emp-2'] },
        OR: [{ payrollRunId: RUN_ID }, { payrollRunId: null }],
        payrollAdjustment: { status: { not: 'CANCELLED' } },
      },
      select: { id: true },
    })
  })

  it('skips each left-out application with the transaction client', async () => {
    setup()
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'app-pending' }, { id: 'app-approved' }])

    await approveRevision(DRAFT_ID)

    expect(skipAdjustmentApplication).toHaveBeenCalledTimes(2)
    expect(skipAdjustmentApplication).toHaveBeenNthCalledWith(1, 'app-pending', tx)
    expect(skipAdjustmentApplication).toHaveBeenNthCalledWith(2, 'app-approved', tx)
  })

  it('does the skipping after the run is updated and before the applications are re-pointed to the new revision', async () => {
    setup()
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'app-1' }])

    await approveRevision(DRAFT_ID)

    expect(order(tx.payrollRun.update)).toBeLessThan(order(tx.payrollRunEmployee.findMany))
    expect(order(tx.payrollRunEmployee.findMany)).toBeLessThan(order(tx.payrollAdjustmentApplication.findMany))
    expect(order(tx.payrollAdjustmentApplication.findMany)).toBeLessThan(order(vi.mocked(skipAdjustmentApplication)))
    expect(order(vi.mocked(skipAdjustmentApplication))).toBeLessThan(order(tx.payrollAdjustmentApplication.updateMany))
  })

  it('still re-points the week\'s applications to the new revision afterwards', async () => {
    setup()
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'app-1' }])

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

  it('skips nothing when the paid set is unchanged (nobody is left out)', async () => {
    setup()
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])

    await approveRevision(DRAFT_ID)

    expect(skipAdjustmentApplication).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(1)
  })

  it('with nobody paid at all, every pending or approved application is carried forward (notIn: [])', async () => {
    setup()
    tx.payrollRunEmployee.findMany.mockResolvedValue([])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }])

    await approveRevision(DRAFT_ID)

    expect(tx.payrollAdjustmentApplication.findMany.mock.calls[0][0].where.employeeId).toEqual({ notIn: [] })
    expect(skipAdjustmentApplication).toHaveBeenCalledTimes(3)
  })

  it('runs for a draft without a session too (an adjustments-only or legacy correction)', async () => {
    setup({ before: null })
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'app-legacy' }])

    await approveRevision(DRAFT_ID)

    expect(skipAdjustmentApplication).toHaveBeenCalledWith('app-legacy', tx)
  })

  it('runs for an attendance correction that deletes every punch of an employee', async () => {
    setup({ clones: 28 })
    tx.payrollRunEmployee.findMany.mockResolvedValue([{ employeeId: 'emp-2' }]) // emp-1 now has zero hours
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'emp-1-deduction' }])

    await approveRevision(DRAFT_ID)

    expect(tx.payrollAdjustmentApplication.findMany.mock.calls[0][0].where.employeeId).toEqual({ notIn: ['emp-2'] })
    expect(skipAdjustmentApplication).toHaveBeenCalledWith('emp-1-deduction', tx)
    // The corrected attendance still replaces the live one.
    expect(tx.attendanceRecord.deleteMany).toHaveBeenCalled()
  })

  it('a skip that throws aborts the approval: nothing after it runs and the session is not marked applied', async () => {
    setup({ clones: 28 })
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([{ id: 'app-1' }, { id: 'app-2' }])
    vi.mocked(skipAdjustmentApplication).mockRejectedValueOnce(new Error('carry-forward failed'))

    await expect(approveRevision(DRAFT_ID)).rejects.toThrow('carry-forward failed')

    expect(skipAdjustmentApplication).toHaveBeenCalledTimes(1) // the second one is never attempted
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.attendanceRecord.deleteMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })

  it('does not skip anything when the approval is refused as stale', async () => {
    setup({ before: session({ draftRevisionId: null }) })

    await expect(approveRevision(DRAFT_ID)).rejects.toMatchObject({ code: 'REVISION_STALE' })
    expect(tx.payrollRunEmployee.findMany).not.toHaveBeenCalled()
    expect(skipAdjustmentApplication).not.toHaveBeenCalled()
  })
})
