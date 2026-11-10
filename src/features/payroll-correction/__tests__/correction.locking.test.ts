import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fix round 3, items 3, 13, 14 and 15: every writer of a correction takes the week's row lock first,
// inside its interactive transaction, and re-reads what it checked before the lock. The tests pin
// the order of the calls (invocationCallOrder is one global counter, so the lock mock and the
// transaction client's mocks compare directly), the client each query goes through (the
// transaction client, never the global one) and what is NOT written when the re-read says the
// session is gone.
//
// The local test database serialises connections, so "a second writer really waits for the lock"
// cannot be shown here; what these tests prove is the order and the re-checks that make the wait safe.

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => {
  const m = () => vi.fn()
  return {
    default: {
      payrollRun: { findUnique: m(), update: m() },
      payrollRevision: { findUnique: m(), findMany: m(), create: m(), update: m(), updateMany: m(), deleteMany: m() },
      payrollRunEmployee: { findMany: m(), createMany: m(), deleteMany: m() },
      payrollCorrectionSession: { findUnique: m(), findFirst: m(), create: m(), update: m() },
      attendancePunch: { count: m(), findMany: m(), createMany: m(), deleteMany: m(), updateMany: m() },
      attendanceEmployeeDecision: { findMany: m() },
      payrollAdjustmentApplication: { findUnique: m(), findMany: m(), update: m(), updateMany: m() },
      attendanceUpload: { findFirst: m() },
      attendanceRecord: { findMany: m(), deleteMany: m(), createMany: m() },
      employee: { findMany: m() },
      $transaction: m(),
    },
  }
})

vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({ getPunchReview: vi.fn() }))
vi.mock('@/features/attendance-sync/services/attendance-audit.service', () => ({ auditEntry: vi.fn() }))
vi.mock('@/features/attendance-sync/services/week-lock.service', () => ({ lockWeekRow: vi.fn() }))
vi.mock('@/features/payroll-adjustments/services/adjustment.service', () => ({ skipAdjustmentApplication: vi.fn() }))

// Plain arithmetic stand-ins for the payroll maths (plain functions, so resetAllMocks leaves them alone).
vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  calculateRegularPay: (hours: number[], rate: number) => {
    const total = hours.reduce((s, h) => s + h, 0)
    return { regularHours: total, regularPay: total * rate }
  },
  calculateOvertimePay: (hours: number[], rate: number) => {
    const total = hours.reduce((s, h) => s + h, 0)
    return { overtimeHours: total, overtimePay: total * rate }
  },
  calculateNetPayable: (gross: number, add: number, ded: number) => gross + add - ded,
}))

import prisma from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import {
  abandonCorrection,
  approveCorrectionPunches,
  beginCorrection,
  recalculateAndCreateRevision,
  startAttendanceCorrection,
} from '@/features/payroll-correction/services/correction.service'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { buildGridEmployees } from '@/features/attendance-sync/lib/review'
import { getWeekDates, weekFromStartISO } from '@/features/attendance-sync/lib/week'
import type { EmployeeLite, StoredPunchRow } from '@/features/attendance-sync/types/attendance-sync.types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RUN_ID = 'run-uuid-1'
const SESSION_ID = 'session-uuid-1'
const UPLOAD_ID = 'upload-uuid-1'
const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')
const THU = new Date('2025-03-06T00:00:00.000Z')
const NOT_ACTIVE_MESSAGE = 'This correction is no longer in progress.'

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    status: 'APPROVED',
    currentRevisionNumber: 1,
    ...overrides,
  }
}

function makeRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'revision-uuid-1',
    payrollRunId: RUN_ID,
    revisionNumber: 1,
    status: 'APPROVED',
    isCurrent: true,
    ...overrides,
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    payrollRunId: RUN_ID,
    attendanceUploadId: UPLOAD_ID,
    status: 'IN_PROGRESS',
    correctionReason: null,
    correctionTypesJson: [],
    adjustmentSnapshotJson: null,
    draftRevisionId: null,
    createdAt: new Date('2025-03-15T00:00:00Z'),
    attendanceUpload: { id: UPLOAD_ID, source: 'ETIMEOFFICE', payrollWeekStartDate: WEEK_START },
    ...overrides,
  }
}

const EMPLOYEE_ONE: EmployeeLite = {
  id: 'emp-uuid-1',
  employeeId: 'EMP-001',
  employeeName: 'Kavitha Rajan',
  isActive: true,
  dateOfResignation: null,
}

type PunchFixture = StoredPunchRow & { employeeId: string; punchDate: Date }

function punchRow(
  id: string,
  pairIndex: number,
  position: 'IN' | 'OUT',
  time: string | null,
  original: string | null = time,
): PunchFixture {
  return { id, employeeId: EMPLOYEE_ONE.id, punchDate: THU, pairIndex, position, source: 'API', originalTime: original, currentTime: time, note: null }
}

/** One full day: 07:40-13:04 and 13:56-<lastOut>. 17:47 makes 9.25 h (1.25 overtime); 18:00 makes 9.47 h (1.47). */
function fullDay(lastOut = '18:00'): PunchFixture[] {
  return [
    punchRow('c-1', 0, 'IN', '07:40'),
    punchRow('c-2', 0, 'OUT', '13:04'),
    punchRow('c-3', 1, 'IN', '13:56'),
    punchRow('c-4', 1, 'OUT', lastOut, '17:47'),
  ]
}

/** The review of a correction's punch copy, built with the real grid code. */
function reviewOf(punches: PunchFixture[], needsFixingDays = 0) {
  const dates = getWeekDates(weekFromStartISO('2025-03-06'))
  return {
    employees: buildGridEmployees([{ ...EMPLOYEE_ONE, tag: 'ACTIVE' as const }], punches, dates),
    counts: { needsFixingDays },
  }
}

function payEmployee(employee: EmployeeLite) {
  return {
    id: employee.id,
    employeeId: employee.employeeId,
    employeeName: employee.employeeName,
    designation: 'Guard',
    designationShort: 'Guard',
    site: 'North Gate',
    gPay: null,
    bankAccount: null,
    wageHistory: [{ weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: new Date('2025-01-01') }],
  }
}

/** A transaction client whose queries can be told apart from calls on the global client. */
function makeTx() {
  const m = () => vi.fn()
  const tx = {
    payrollRun: { findUnique: m(), update: m() },
    payrollRevision: { findFirst: m(), updateMany: m(), deleteMany: m(), create: m() },
    payrollRunEmployee: { findMany: m(), deleteMany: m(), createMany: m() },
    payrollCorrectionSession: { create: m(), update: m(), findUnique: m(), findFirst: m() },
    payrollAdjustmentApplication: { findMany: m(), updateMany: m() },
    attendanceEmployeeDecision: { findMany: m() },
    attendancePunch: { count: m(), findMany: m(), createMany: m(), deleteMany: m(), updateMany: m() },
    attendanceRecord: { deleteMany: m(), createMany: m(), findMany: m() },
    attendanceUpload: { findFirst: m() },
    employee: { findMany: m() },
    auditLog: { create: m() },
  }
  tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
  // recalculateAndCreateRevision reads the current revision again under the lock.
  tx.payrollRevision.findFirst.mockResolvedValue(makeRevision())
  return tx
}
type Tx = ReturnType<typeof makeTx>

/** True while an interactive $transaction callback is running (the global client is "outside"). */
let inTransaction = false

function withInteractiveTransaction(tx: Tx) {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[])
    inTransaction = true
    try {
      return await arg(tx)
    } finally {
      inTransaction = false
    }
  }) as never)
}

function callOrder(fn: unknown, index = 0): number {
  const order = (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[index]
  if (order === undefined) throw new Error('expected the mock to have been called, but it was not')
  return order
}

/** Every mock was called, and in exactly this order (first call of each). */
function expectInOrder(...steps: Array<[string, unknown]>) {
  const orders = steps.map(([name, fn]) => {
    const calls = (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
    expect(calls.length, `${name} was not called`).toBeGreaterThan(0)
    return { name, order: calls[0] }
  })
  for (let i = 1; i < orders.length; i++) {
    expect(orders[i - 1].order, `${orders[i - 1].name} must run before ${orders[i].name}`).toBeLessThan(orders[i].order)
  }
}

function txWrites(tx: Tx): Array<[string, unknown]> {
  return [
    ['tx.payrollRun.update', tx.payrollRun.update],
    ['tx.payrollRevision.updateMany', tx.payrollRevision.updateMany],
    ['tx.payrollRevision.deleteMany', tx.payrollRevision.deleteMany],
    ['tx.payrollRevision.create', tx.payrollRevision.create],
    ['tx.payrollRunEmployee.deleteMany', tx.payrollRunEmployee.deleteMany],
    ['tx.payrollRunEmployee.createMany', tx.payrollRunEmployee.createMany],
    ['tx.payrollCorrectionSession.create', tx.payrollCorrectionSession.create],
    ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
    ['tx.payrollAdjustmentApplication.updateMany', tx.payrollAdjustmentApplication.updateMany],
    ['tx.attendancePunch.createMany', tx.attendancePunch.createMany],
    ['tx.attendancePunch.deleteMany', tx.attendancePunch.deleteMany],
    ['tx.attendancePunch.updateMany', tx.attendancePunch.updateMany],
    ['tx.attendanceRecord.deleteMany', tx.attendanceRecord.deleteMany],
    ['tx.attendanceRecord.createMany', tx.attendanceRecord.createMany],
    ['auditEntry', auditEntry],
  ]
}

function expectNoTxWrites(tx: Tx) {
  for (const [name, fn] of txWrites(tx)) expect(fn as ReturnType<typeof vi.fn>, name).not.toHaveBeenCalled()
}

function expectNoGlobalWrites() {
  const writes: Array<[string, ReturnType<typeof vi.fn>]> = [
    ['prisma.payrollRun.update', vi.mocked(prisma.payrollRun.update)],
    ['prisma.payrollRevision.create', vi.mocked(prisma.payrollRevision.create)],
    ['prisma.payrollRevision.update', vi.mocked(prisma.payrollRevision.update)],
    ['prisma.payrollRevision.updateMany', vi.mocked(prisma.payrollRevision.updateMany)],
    ['prisma.payrollRevision.deleteMany', vi.mocked(prisma.payrollRevision.deleteMany)],
    ['prisma.payrollRunEmployee.createMany', vi.mocked(prisma.payrollRunEmployee.createMany)],
    ['prisma.payrollRunEmployee.deleteMany', vi.mocked(prisma.payrollRunEmployee.deleteMany)],
    ['prisma.payrollCorrectionSession.create', vi.mocked(prisma.payrollCorrectionSession.create)],
    ['prisma.payrollCorrectionSession.update', vi.mocked(prisma.payrollCorrectionSession.update)],
    ['prisma.payrollAdjustmentApplication.update', vi.mocked(prisma.payrollAdjustmentApplication.update)],
    ['prisma.payrollAdjustmentApplication.updateMany', vi.mocked(prisma.payrollAdjustmentApplication.updateMany)],
    ['prisma.attendancePunch.createMany', vi.mocked(prisma.attendancePunch.createMany)],
    ['prisma.attendancePunch.deleteMany', vi.mocked(prisma.attendancePunch.deleteMany)],
    ['prisma.attendancePunch.updateMany', vi.mocked(prisma.attendancePunch.updateMany)],
    ['prisma.attendanceRecord.deleteMany', vi.mocked(prisma.attendanceRecord.deleteMany)],
    ['prisma.attendanceRecord.createMany', vi.mocked(prisma.attendanceRecord.createMany)],
  ]
  for (const [name, fn] of writes) expect(fn, name).not.toHaveBeenCalled()
}

/** Every $transaction these writers open is the interactive form (a callback), never an array of promises. */
function expectOnlyInteractiveTransactions() {
  for (const call of vi.mocked(prisma.$transaction).mock.calls) expect(typeof call[0]).toBe('function')
}

beforeEach(() => {
  vi.resetAllMocks()
  inTransaction = false
})

// ─── Item 13: beginCorrection ─────────────────────────────────────────────────

describe('item 13: beginCorrection takes the week lock before it looks for, snapshots and resets', () => {
  const snapshotRow = (id: string) => ({
    id,
    approvalStatus: 'APPROVED',
    isReversed: false,
    approvedAt: new Date('2025-03-14T10:00:00Z'),
    skippedAt: null,
    appliedAt: new Date('2025-03-14T10:00:00Z'),
  })

  /** Pre-checks all pass (no session yet); the transaction client sees no session either, unless a test says so. */
  function setup() {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun() as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: UPLOAD_ID } as never)
    tx.payrollCorrectionSession.findFirst.mockResolvedValue(null)
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([snapshotRow('tx-app-1')] as never)
    tx.payrollCorrectionSession.create.mockResolvedValue(makeSession({ id: 'new-session' }))
    tx.payrollRun.findUnique.mockResolvedValue({ payrollWeekStartDate: WEEK_START })
    return tx
  }

  it('double click: the pre-check sees no session but the locked read finds the first click\'s one, so it resumes it and resets nothing', async () => {
    const tx = setup()
    tx.payrollCorrectionSession.findFirst.mockResolvedValue(
      makeSession({ id: 'opened-by-first-click', correctionTypesJson: ['ATTENDANCE', 'NOT_A_TYPE'] }),
    )

    const result = await beginCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: 'opened-by-first-click', resumed: true, correctionTypes: ['ATTENDANCE'] })
    // No second session, no second snapshot (it would record the state the first click already reset), no second reset.
    expect(tx.payrollCorrectionSession.create).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.payrollRun.findUnique).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('locks the upload row with the transaction client, then looks for an open session on the transaction client', async () => {
    const tx = setup()

    await beginCorrection(RUN_ID)

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expect(tx.payrollCorrectionSession.findFirst).toHaveBeenCalledWith({
      where: { payrollRunId: RUN_ID, status: 'IN_PROGRESS' },
      orderBy: { createdAt: 'desc' },
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expectOnlyInteractiveTransactions()
  })

  it('orders the work: lock, open-session check, snapshot read, session create, reset', async () => {
    const tx = setup()

    await beginCorrection(RUN_ID)

    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.payrollCorrectionSession.findFirst', tx.payrollCorrectionSession.findFirst],
      ['tx.payrollAdjustmentApplication.findMany (snapshot)', tx.payrollAdjustmentApplication.findMany],
      ['tx.payrollCorrectionSession.create', tx.payrollCorrectionSession.create],
      ['tx.payrollRun.findUnique (reset)', tx.payrollRun.findUnique],
      ['tx.payrollAdjustmentApplication.updateMany (reset)', tx.payrollAdjustmentApplication.updateMany],
    )
  })

  it('takes the snapshot from the transaction\'s read (after the lock), not from a read on the global client', async () => {
    const tx = setup()
    // A decoy on the global client: if the snapshot were read there, this id would show up in the session.
    vi.mocked(prisma.payrollAdjustmentApplication.findMany).mockResolvedValue([snapshotRow('global-app')] as never)

    await beginCorrection(RUN_ID)

    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledWith({
      where: { OR: [{ payrollRunId: RUN_ID }, { payrollWeekStartDate: WEEK_START, payrollRunId: null }] },
      select: { id: true, approvalStatus: true, isReversed: true, approvedAt: true, skippedAt: true, appliedAt: true },
    })
    const { data } = tx.payrollCorrectionSession.create.mock.calls[0][0]
    expect((data.adjustmentSnapshotJson as Array<{ applicationId: string }>).map((e) => e.applicationId)).toEqual(['tx-app-1'])
    expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
  })

  it('resets the applications on the transaction client only, and reads the run\'s week there too', async () => {
    const tx = setup()

    await beginCorrection(RUN_ID)

    expect(tx.payrollRun.findUnique).toHaveBeenCalledWith({ where: { id: RUN_ID }, select: { payrollWeekStartDate: true } })
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ payrollRunId: RUN_ID }, { payrollWeekStartDate: WEEK_START, payrollRunId: null, approvalStatus: 'PENDING' }] },
      data: { approvalStatus: 'PENDING', isReversed: false, approvedAt: null, skippedAt: null },
    })
    // The global client looked the run up once, before the transaction, and wrote nothing.
    expect(prisma.payrollRun.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
    expectNoGlobalWrites()
  })

  it('creates the session with the upload, IN_PROGRESS, no types yet, and returns it as not resumed', async () => {
    const tx = setup()

    const result = await beginCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: 'new-session', resumed: false, correctionTypes: [] })
    expect(tx.payrollCorrectionSession.create).toHaveBeenCalledTimes(1)
    expect(tx.payrollCorrectionSession.create.mock.calls[0][0].data).toMatchObject({
      payrollRunId: RUN_ID,
      attendanceUploadId: UPLOAD_ID,
      status: 'IN_PROGRESS',
      correctionTypesJson: [],
    })
  })

  it('two clicks that both passed the pre-check: one session, one snapshot, one reset; the second resumes the first', async () => {
    const tx = setup()
    // A tiny store behind the transaction client: what the first call creates, the second call's locked read finds.
    const sessions: Array<ReturnType<typeof makeSession>> = []
    tx.payrollCorrectionSession.findFirst.mockImplementation((async () => sessions[sessions.length - 1] ?? null) as never)
    tx.payrollCorrectionSession.create.mockImplementation((async () => {
      const created = makeSession({ id: `session-${sessions.length + 1}` })
      sessions.push(created)
      return created
    }) as never)

    const first = await beginCorrection(RUN_ID)
    const second = await beginCorrection(RUN_ID)

    expect(first).toMatchObject({ sessionId: 'session-1', resumed: false })
    expect(second).toEqual({ sessionId: 'session-1', resumed: true, correctionTypes: [] })
    expect(sessions).toHaveLength(1)
    expect(tx.payrollCorrectionSession.create).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.findMany).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledTimes(2)
  })

  it('a session that is already open is resumed before any transaction (fast path): no lock, no transaction', async () => {
    const tx = setup()
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession({ correctionTypesJson: ['ADJUSTMENTS'] }) as never)

    const result = await beginCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, resumed: true, correctionTypes: ['ADJUSTMENTS'] })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expect(prisma.attendanceUpload.findFirst).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })

  it.each([
    ['the run does not exist', () => vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null), 'PAYROLL_RUN_NOT_FOUND'],
    [
      'the run is not approved',
      () => vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun({ status: 'DRAFT' }) as never),
      'CANNOT_CORRECT_UNAPPROVED_PAYROLL',
    ],
    ['the run\'s week has no attendance row', () => vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null), 'PAYROLL_RUN_NOT_FOUND'],
  ])('opens no transaction and takes no lock when %s', async (_label, arrange, code) => {
    const tx = setup()
    arrange()

    await expect(beginCorrection(RUN_ID)).rejects.toMatchObject({ code })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('a failure after the lock (the reset throws) propagates and the caller never gets a session id', async () => {
    const tx = setup()
    tx.payrollAdjustmentApplication.updateMany.mockRejectedValue(new Error('deadlock'))

    await expect(beginCorrection(RUN_ID)).rejects.toThrow('deadlock')
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
  })
})

// ─── Item 14: startAttendanceCorrection ───────────────────────────────────────

describe('item 14: startAttendanceCorrection copies the punches under the week lock', () => {
  function livePunch(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      attendanceUploadId: UPLOAD_ID,
      correctionId: null,
      employeeId: EMPLOYEE_ONE.id,
      empCode: '0001',
      empName: 'Empname0001',
      matchStatus: 'MATCHED',
      punchDate: THU,
      pairIndex: 0,
      position: 'IN',
      source: 'API',
      originalTime: '07:40',
      currentTime: '07:40',
      note: null,
      mergedScansJson: null,
      mcid: 'M1',
      ...overrides,
    }
  }

  const input = { reason: 'Wrong OUT time', types: ['ATTENDANCE' as const] }

  function setup(opts: { alreadyCopied?: number; live?: Array<ReturnType<typeof livePunch>> } = {}) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
    tx.attendancePunch.count.mockResolvedValue(opts.alreadyCopied ?? 0)
    tx.attendancePunch.findMany.mockResolvedValue(opts.live ?? [livePunch('p-1'), livePunch('p-2', { position: 'OUT', originalTime: '17:47', currentTime: '17:47' })])
    return tx
  }

  it('locks the upload row first, then re-reads the session, saves the reason, counts the copy and reads the live punches, all on the transaction client', async () => {
    const tx = setup()

    const result = await startAttendanceCorrection(RUN_ID, input)

    expect(result).toEqual({ sessionId: SESSION_ID, weekId: '2025-03-06' })
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expect(tx.payrollCorrectionSession.findUnique).toHaveBeenCalledWith({ where: { id: SESSION_ID } })
    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
      ['tx.attendancePunch.count', tx.attendancePunch.count],
      ['tx.attendancePunch.findMany', tx.attendancePunch.findMany],
      ['tx.attendancePunch.createMany', tx.attendancePunch.createMany],
    )
    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.attendancePunch.findMany).toHaveBeenCalledWith({ where: { attendanceUploadId: UPLOAD_ID, correctionId: null } })
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { correctionReason: 'Wrong OUT time', correctionTypesJson: ['ATTENDANCE'] },
    })
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expectOnlyInteractiveTransactions()
    // The copy count and the live read are never made on the global client.
    expect(prisma.attendancePunch.count).not.toHaveBeenCalled()
    expect(prisma.attendancePunch.findMany).not.toHaveBeenCalled()
    expectNoGlobalWrites()
  })

  it.each([
    ['ABANDONED', makeSession({ status: 'ABANDONED' })],
    ['APPLIED', makeSession({ status: 'APPLIED' })],
    ['missing', null],
  ])('a session that is %s once the lock is held: CORRECTION_NOT_ACTIVE, nothing saved, nothing copied', async (_label, reread) => {
    const tx = setup()
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(reread)

    const error = await startAttendanceCorrection(RUN_ID, input).catch((e) => e)

    expect(error).toMatchObject({ name: 'CorrectionServiceError', code: 'CORRECTION_NOT_ACTIVE', message: NOT_ACTIVE_MESSAGE })
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('a copy already exists (the other click got there first): the reason is still saved, nothing is copied again', async () => {
    const tx = setup({ alreadyCopied: 28 })

    await startAttendanceCorrection(RUN_ID, input)

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.count).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('no copy yet: the live punches are cloned through the transaction client, tagged with the session and their source', async () => {
    const tx = setup({ live: [livePunch('p-1'), livePunch('p-2', { mergedScansJson: [{ time: '07:41' }], note: 'merged' })] })

    await startAttendanceCorrection(RUN_ID, input)

    expect(tx.attendancePunch.createMany).toHaveBeenCalledTimes(1)
    const { data } = tx.attendancePunch.createMany.mock.calls[0][0]
    expect(data).toHaveLength(2)
    expect(data[0]).toMatchObject({
      attendanceUploadId: UPLOAD_ID,
      correctionId: SESSION_ID,
      clonedFromPunchId: 'p-1',
      employeeId: EMPLOYEE_ONE.id,
      punchDate: THU,
      position: 'IN',
      originalTime: '07:40',
      currentTime: '07:40',
      mergedScansJson: Prisma.DbNull,
    })
    expect(data[1]).toMatchObject({ correctionId: SESSION_ID, clonedFromPunchId: 'p-2', note: 'merged', mergedScansJson: [{ time: '07:41' }] })
    expect(prisma.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('copies a large week in chunks of 1000, every chunk on the transaction client', async () => {
    const live = Array.from({ length: 2500 }, (_, i) => livePunch(`p-${i}`))
    const tx = setup({ live })

    await startAttendanceCorrection(RUN_ID, input)

    expect(tx.attendancePunch.createMany).toHaveBeenCalledTimes(3)
    expect(tx.attendancePunch.createMany.mock.calls.map((c) => c[0].data.length)).toEqual([1000, 1000, 500])
    expect(prisma.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('an adjustments-only correction under the lock saves the reason and reads no punches at all', async () => {
    const tx = setup()

    await startAttendanceCorrection(RUN_ID, { reason: 'Reverse a deduction', types: ['ADJUSTMENTS'] })

    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
    )
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { correctionReason: 'Reverse a deduction', correctionTypesJson: ['ADJUSTMENTS'] },
    })
    // The only punch read is the check for a copy made earlier (Attendance may have been unticked since).
    expect(tx.attendancePunch.count).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.createMany).not.toHaveBeenCalled()
  })

  it('two calls that both passed the pre-check: the first copies the week, the second finds the copy and copies nothing', async () => {
    const tx = setup({ live: [livePunch('p-1'), livePunch('p-2'), livePunch('p-3')] })
    // A tiny punch store behind the transaction client: the clone count follows what createMany wrote.
    const clones: unknown[] = []
    tx.attendancePunch.count.mockImplementation((async () => clones.length) as never)
    tx.attendancePunch.createMany.mockImplementation((async ({ data }: { data: unknown[] }) => {
      clones.push(...data)
      return { count: data.length }
    }) as never)

    await startAttendanceCorrection(RUN_ID, input)
    await startAttendanceCorrection(RUN_ID, input)

    expect(clones).toHaveLength(3) // not 6: the clone set is the live set once
    expect(tx.attendancePunch.createMany).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.count).toHaveBeenCalledTimes(2)
    expect(lockWeekRow).toHaveBeenCalledTimes(2)
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(2)
  })

  it('the pre-lock checks still fail fast without a lock or a transaction', async () => {
    const tx = setup()

    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: [] })).rejects.toMatchObject({ code: 'NO_CORRECTION_TYPE_SELECTED' })

    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    await expect(startAttendanceCorrection(RUN_ID, input)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(
      makeSession({ attendanceUpload: { id: UPLOAD_ID, source: 'EXCEL', payrollWeekStartDate: WEEK_START } }) as never,
    )
    await expect(startAttendanceCorrection(RUN_ID, input)).rejects.toMatchObject({ code: 'EXCEL_ERA_ATTENDANCE_CORRECTION' })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })
})

// ─── Item 15: abandonCorrection ───────────────────────────────────────────────

describe('item 15: abandonCorrection discards under the week lock', () => {
  const snapshot = [
    { applicationId: 'app-1', approvalStatus: 'APPROVED', isReversed: false, approvedAt: '2025-03-14T10:00:00.000Z', skippedAt: null, appliedAt: '2025-03-14T10:00:00.000Z' },
  ]

  type SelectRow = {
    id: string
    clonedFromPunchId: string | null
    punchDate: Date
    position: string
    source: string
    originalTime: string | null
    currentTime: string | null
    note: string | null
    employee: { employeeId: string } | null
  }

  function row(id: string, overrides: Partial<SelectRow> = {}): SelectRow {
    return {
      id,
      clonedFromPunchId: null,
      punchDate: THU,
      position: 'OUT',
      source: 'API',
      originalTime: '17:47',
      currentTime: '17:47',
      note: null,
      employee: { employeeId: 'EMP-001' },
      ...overrides,
    }
  }

  /** The copy and the live set, as the two queries in findDiscardedEdits return them (on the transaction client). */
  function setPunches(tx: Tx, clones: SelectRow[], live: SelectRow[]) {
    tx.attendancePunch.count.mockResolvedValue(clones.length)
    tx.attendancePunch.findMany.mockImplementation((async (args: { where: { correctionId: string | null } }) =>
      args.where.correctionId === SESSION_ID ? clones : live) as never)
  }

  function setup(opts: { before?: Record<string, unknown> | null; locked?: Record<string, unknown> | null } = {}) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    const before = opts.before === undefined ? makeSession({ adjustmentSnapshotJson: snapshot }) : opts.before
    const locked = opts.locked === undefined ? before : opts.locked
    // Found before the transaction, and read again inside it once the week row is locked.
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(before as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(locked)
    setPunches(tx, [row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])
    return tx
  }

  it('takes the lock before any other query or write of the transaction', async () => {
    const tx = setup()

    await abandonCorrection(RUN_ID)

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    const lockOrder = callOrder(lockWeekRow)
    const everythingElse: Array<[string, unknown]> = [
      ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
      ['tx.attendancePunch.count', tx.attendancePunch.count],
      ['tx.attendancePunch.findMany', tx.attendancePunch.findMany],
      ['tx.attendancePunch.deleteMany', tx.attendancePunch.deleteMany],
      ['tx.payrollRunEmployee.deleteMany', tx.payrollRunEmployee.deleteMany],
      ['tx.payrollRevision.deleteMany', tx.payrollRevision.deleteMany],
      ['tx.payrollAdjustmentApplication.updateMany', tx.payrollAdjustmentApplication.updateMany],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
      ['auditEntry', auditEntry],
    ]
    for (const [name, fn] of everythingElse) {
      expect(callOrder(fn), `${name} must come after the lock`).toBeGreaterThan(lockOrder)
    }
    // The pre-transaction session lookup is the only thing before the lock.
    expect(callOrder(prisma.payrollCorrectionSession.findFirst)).toBeLessThan(lockOrder)
  })

  it('orders the work: lock, session re-read, copy count, edit reads, deletes, adjustments, session end, audit', async () => {
    const tx = setup()

    await abandonCorrection(RUN_ID)

    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
      ['tx.attendancePunch.count', tx.attendancePunch.count],
      ['tx.attendancePunch.findMany', tx.attendancePunch.findMany],
      ['tx.attendancePunch.deleteMany', tx.attendancePunch.deleteMany],
      ['tx.payrollRunEmployee.deleteMany', tx.payrollRunEmployee.deleteMany],
      ['tx.payrollRevision.deleteMany', tx.payrollRevision.deleteMany],
      ['tx.payrollAdjustmentApplication.updateMany', tx.payrollAdjustmentApplication.updateMany],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
      ['auditEntry', auditEntry],
    )
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expectOnlyInteractiveTransactions()
  })

  it.each([
    ['APPLIED (an approval won the race)', makeSession({ status: 'APPLIED' })],
    ['ABANDONED (a second abandon got there first)', makeSession({ status: 'ABANDONED' })],
    ['missing', null],
  ])('a session that is %s once the lock is held: CORRECTION_NOT_ACTIVE and nothing is deleted, updated or audited', async (_label, locked) => {
    const tx = setup({ locked })

    const error = await abandonCorrection(RUN_ID).catch((e) => e)

    expect(error).toMatchObject({ name: 'CorrectionServiceError', code: 'CORRECTION_NOT_ACTIVE', message: NOT_ACTIVE_MESSAGE })
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollRevision.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('counts the discarded edits from the transaction\'s reads: an edit only visible inside the transaction is counted and audited', async () => {
    const tx = setup()
    // Global-client decoys: before the lock the copy looked empty. None of these may be consulted.
    vi.mocked(prisma.attendancePunch.count).mockResolvedValue(0)
    vi.mocked(prisma.attendancePunch.findMany).mockResolvedValue([])
    // Inside the transaction (after the lock) the copy holds an edit that landed just before it.
    setPunches(tx, [row('c-late', { clonedFromPunchId: 'p-late', currentTime: '19:00', note: 'Late save' })], [row('p-late')])

    const result = await abandonCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, discardedEdits: 1 })
    const [entry, client] = vi.mocked(auditEntry).mock.calls[0]
    expect(client).toBe(tx)
    expect(entry).toMatchObject({ actionType: 'DISCARD', entityType: 'ATTENDANCE_WEEK', entityId: UPLOAD_ID })
    const edits = (entry.details as { discarded: { edits: Array<Record<string, unknown>> } }).discarded.edits
    expect(edits).toEqual([
      { punchId: 'c-late', employeeCode: 'EMP-001', date: '2025-03-06', position: 'OUT', original: '17:47', current: '19:00', note: 'Late save' },
    ])
    expect((entry.details as { summary: string }).summary).toBe('Discarded correction: 1 punch edit(s)')
    expect(prisma.attendancePunch.count).not.toHaveBeenCalled()
    expect(prisma.attendancePunch.findMany).not.toHaveBeenCalled()
  })

  it('decides "had a copy" from the transaction\'s count: a copy only visible inside is discarded and audited', async () => {
    const tx = setup()
    vi.mocked(prisma.attendancePunch.count).mockResolvedValue(0) // the global client would say "no copy"
    setPunches(tx, [row('c-1', { clonedFromPunchId: 'p-1', currentTime: '18:00' })], [row('p-1')])

    await abandonCorrection(RUN_ID)

    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.attendancePunch.findMany).toHaveBeenCalledTimes(2) // the copy, then the live set
    expect(auditEntry).toHaveBeenCalledTimes(1)
    expect(prisma.attendancePunch.count).not.toHaveBeenCalled()
  })

  it('no copy inside the transaction (adjustments only): no edit reads, no audit entry, the delete and the session end still happen', async () => {
    const tx = setup()
    tx.attendancePunch.count.mockResolvedValue(0)

    const result = await abandonCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, discardedEdits: 0 })
    expect(tx.attendancePunch.findMany).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
    expect(tx.attendancePunch.deleteMany).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { status: 'ABANDONED', abandonedAt: expect.any(Date) },
    })
  })

  it('puts back the adjustment snapshot of the session as re-read under the lock, not the one read before it', async () => {
    const stale = [{ applicationId: 'app-stale', approvalStatus: 'APPROVED', isReversed: false, approvedAt: null, skippedAt: null, appliedAt: null }]
    const fresh = [
      { applicationId: 'app-fresh', approvalStatus: 'SKIPPED', isReversed: true, approvedAt: null, skippedAt: '2025-03-14T11:00:00.000Z', appliedAt: null },
    ]
    const tx = setup({
      before: makeSession({ adjustmentSnapshotJson: stale }),
      locked: makeSession({ adjustmentSnapshotJson: fresh }),
    })

    await abandonCorrection(RUN_ID)

    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-fresh' },
      data: {
        approvalStatus: 'SKIPPED',
        isReversed: true,
        approvedAt: null,
        skippedAt: new Date('2025-03-14T11:00:00.000Z'),
        appliedAt: null,
      },
    })
  })

  it('returns the session id and the number of discarded edits, and writes only through the transaction client', async () => {
    const tx = setup()

    const result = await abandonCorrection(RUN_ID)

    expect(result).toEqual({ sessionId: SESSION_ID, discardedEdits: 1 })
    expect(tx.attendancePunch.deleteMany).toHaveBeenCalledTimes(1)
    expect(vi.mocked(auditEntry).mock.calls[0][1]).toBe(tx)
    expectNoGlobalWrites()
  })

  it('with no correction in progress it fails before any lock or transaction', async () => {
    const tx = setup({ before: null })

    await expect(abandonCorrection(RUN_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })

  it('a failing delete after the lock propagates, and the session is never marked ABANDONED nor an audit written', async () => {
    const tx = setup()
    tx.payrollRevision.deleteMany.mockRejectedValue(new Error('connection reset'))

    await expect(abandonCorrection(RUN_ID)).rejects.toThrow('connection reset')

    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(auditEntry).not.toHaveBeenCalled()
  })
})

// ─── Item 3: recalculateAndCreateRevision / approveCorrectionPunches ──────────

describe('item 3: the draft is calculated and written in one transaction under the week lock', () => {
  const input = {
    payrollRunId: RUN_ID,
    correctionReason: 'Wrong OUT time',
    correctionTypes: ['ATTENDANCE' as const],
    correctionSessionId: SESSION_ID,
  }

  /** Session found before the transaction and read again inside it; the review and hours are served on the transaction client. */
  function setup(
    opts: {
      clonedPunches?: number
      before?: Record<string, unknown> | null
      locked?: Record<string, unknown> | null
      review?: ReturnType<typeof reviewOf>
    } = {},
  ) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    const before = opts.before === undefined ? makeSession() : opts.before
    const locked = opts.locked === undefined ? before : opts.locked
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(before as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(locked)
    tx.attendancePunch.count.mockResolvedValue(opts.clonedPunches ?? 28)
    vi.mocked(getPunchReview).mockResolvedValue((opts.review ?? reviewOf(fullDay())) as never)
    tx.employee.findMany.mockResolvedValue([payEmployee(EMPLOYEE_ONE)])
    tx.payrollRunEmployee.findMany.mockResolvedValue([
      { employeeId: EMPLOYEE_ONE.id, netPayable: 2750, regularPay: 2875, overtimePay: 375, additions: 0, deductions: 500 },
    ])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    return tx
  }

  const changes = { reversed: ['rev-1', 'rev-2'], approved: ['appr-1'] }

  it('with a session: lock, session re-read, punch count, review, hours, previous employees, adjustment changes, approved adjustments, draft writes, pointer - in that order', async () => {
    const tx = setup()

    await recalculateAndCreateRevision({ ...input, adjustmentChanges: changes })

    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
      ['tx.attendancePunch.count', tx.attendancePunch.count],
      ['getPunchReview', getPunchReview],
      ['tx.employee.findMany', tx.employee.findMany],
      ['tx.payrollRunEmployee.findMany', tx.payrollRunEmployee.findMany],
      ['tx.payrollAdjustmentApplication.updateMany', tx.payrollAdjustmentApplication.updateMany],
      ['tx.payrollAdjustmentApplication.findMany', tx.payrollAdjustmentApplication.findMany],
      ['tx.payrollRunEmployee.deleteMany', tx.payrollRunEmployee.deleteMany],
      ['tx.payrollRevision.deleteMany', tx.payrollRevision.deleteMany],
      ['tx.payrollRevision.create', tx.payrollRevision.create],
      ['tx.payrollRunEmployee.createMany', tx.payrollRunEmployee.createMany],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
    )
    expect(tx.attendancePunch.count).toHaveBeenCalledWith({ where: { correctionId: SESSION_ID } })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expectOnlyInteractiveTransactions()
  })

  it('reads the review on the transaction client (third argument), in CORRECTION mode, exactly once, and nothing on the global client', async () => {
    const tx = setup()

    await recalculateAndCreateRevision(input)

    expect(getPunchReview).toHaveBeenCalledTimes(1)
    const [weekId, mode, client] = vi.mocked(getPunchReview).mock.calls[0]
    expect(weekId).toBe('2025-03-06')
    expect(mode).toEqual({ kind: 'CORRECTION', payrollRunId: RUN_ID, correctionId: SESSION_ID, revisionNumber: 1 })
    expect(client).toBe(tx)
    expect(prisma.attendancePunch.count).not.toHaveBeenCalled()
    expect(prisma.employee.findMany).not.toHaveBeenCalled()
    expect(prisma.payrollRunEmployee.findMany).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.findMany).not.toHaveBeenCalled()
  })

  it.each([
    ['APPLIED', makeSession({ status: 'APPLIED' })],
    ['ABANDONED', makeSession({ status: 'ABANDONED' })],
    ['now another run\'s', makeSession({ payrollRunId: 'some-other-run' })],
    ['missing', null],
  ])('a session that is %s once the lock is held: CORRECTION_NOT_ACTIVE and no write of any kind', async (_label, locked) => {
    const tx = setup({ locked })

    const error = await recalculateAndCreateRevision({ ...input, adjustmentChanges: changes }).catch((e) => e)

    expect(error).toMatchObject({
      name: 'CorrectionServiceError',
      code: 'CORRECTION_NOT_ACTIVE',
      message: 'This correction is no longer in progress',
    })
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    // Nothing was read past the re-read, and nothing was written: no draft, no earlier draft deleted, no pointer, no adjustment change.
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.payrollRevision.create).not.toHaveBeenCalled()
    expect(tx.payrollRevision.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.createMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('a session already not in progress before the lock fails fast: no transaction, no lock', async () => {
    const tx = setup({ before: makeSession({ status: 'ABANDONED' }) })

    await expect(recalculateAndCreateRevision(input)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })

  it('an incomplete pair (needsFixingDays 1) refuses the draft: exact message, no revision, no pointer change, earlier draft kept, adjustment changes not applied', async () => {
    const tx = setup({ review: reviewOf(fullDay(), 1) })

    const error = await recalculateAndCreateRevision({ ...input, adjustmentChanges: changes }).catch((e) => e)

    expect(error).toMatchObject({
      name: 'CorrectionServiceError',
      code: 'CORRECTION_HAS_INCOMPLETE_PAIRS',
      message: '1 day(s) still have an incomplete pair. Fix or delete them first.',
    })
    expect(getPunchReview).toHaveBeenCalledTimes(1)
    expect(tx.payrollRevision.create).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.createMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(tx.payrollRevision.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollRunEmployee.deleteMany).not.toHaveBeenCalled()
    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
    expectNoGlobalWrites()
  })

  it('writes the adjustment changes through the transaction client with the exact ids, never through the global client', async () => {
    const tx = setup()

    await recalculateAndCreateRevision({ ...input, adjustmentChanges: changes })

    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['rev-1', 'rev-2'] } },
      data: { isReversed: true },
    })
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['appr-1'] } },
      data: { approvalStatus: 'APPROVED', appliedAt: expect.any(Date) },
    })
    expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(prisma.payrollAdjustmentApplication.update).not.toHaveBeenCalled()
  })

  it('with no adjustment changes there is no adjustment write at all', async () => {
    const tx = setup()

    await recalculateAndCreateRevision(input)
    await recalculateAndCreateRevision({ ...input, adjustmentChanges: { reversed: [], approved: [] } })

    expect(tx.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
  })

  it('a failed draft write rolls back the adjustment changes with it: they exist only inside the one transaction', async () => {
    const tx = setup()
    // A transaction that keeps its writes aside and commits them only if the callback succeeds.
    const committed: unknown[] = []
    vi.mocked(prisma.$transaction).mockImplementation((async (arg: (client: Tx) => Promise<unknown>) => {
      const staged: unknown[] = []
      tx.payrollAdjustmentApplication.updateMany.mockImplementation((async (args: unknown) => {
        staged.push(args)
        return { count: 1 }
      }) as never)
      const result = await arg(tx) // a rejection here drops `staged`
      committed.push(...staged)
      return result
    }) as never)
    tx.payrollRevision.create.mockRejectedValue(new Error('db down'))

    await expect(recalculateAndCreateRevision({ ...input, adjustmentChanges: changes })).rejects.toThrow('db down')

    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(2) // issued inside the transaction callback...
    expect(committed).toEqual([]) // ...and discarded with it
    expect(prisma.payrollAdjustmentApplication.updateMany).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled() // the pointer was never set
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('the pointer is the last write: the draft id, the reason and the types go on the session, and the id is the created revision\'s', async () => {
    const tx = setup()

    const result = await recalculateAndCreateRevision(input)

    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { draftRevisionId: result.revisionId, correctionReason: 'Wrong OUT time', correctionTypesJson: ['ATTENDANCE'] },
    })
    expect(tx.payrollRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: result.revisionId, payrollRunId: RUN_ID, revisionNumber: 2, status: 'DRAFT', isCurrent: false }),
    })
    expect(callOrder(tx.payrollCorrectionSession.update)).toBeGreaterThan(callOrder(tx.payrollRunEmployee.createMany))
    expect(callOrder(tx.payrollCorrectionSession.update)).toBeGreaterThan(callOrder(tx.payrollRevision.create))
    expect(prisma.payrollCorrectionSession.update).not.toHaveBeenCalled()
  })

  it('without a session (an adjustments-only or legacy draft): locked by week start, no session read, no punch count, still one transaction, no pointer', async () => {
    const tx = setup()
    tx.attendanceUpload.findFirst.mockResolvedValue({ id: UPLOAD_ID })
    tx.attendanceRecord.findMany.mockResolvedValue([
      { employeeId: EMPLOYEE_ONE.id, regularHours: 8, overtimeHours: 0, employee: payEmployee(EMPLOYEE_ONE) },
    ])

    const result = await recalculateAndCreateRevision({
      payrollRunId: RUN_ID,
      correctionReason: 'Reverse a deduction',
      correctionTypes: ['ADJUSTMENTS'],
      adjustmentChanges: changes,
    })

    expect(result).toMatchObject({ payrollRunId: RUN_ID, revisionNumber: 2, employeeCount: 1 })
    expect(lockWeekRow).toHaveBeenCalledTimes(1)
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { weekStart: WEEK_START })
    expect(prisma.payrollCorrectionSession.findUnique).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.findUnique).not.toHaveBeenCalled()
    expect(tx.attendancePunch.count).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.payrollCorrectionSession.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
    expectOnlyInteractiveTransactions()
    // The draft and the adjustment changes are all written inside that transaction.
    expect(tx.payrollRevision.create).toHaveBeenCalledTimes(1)
    expect(tx.payrollAdjustmentApplication.updateMany).toHaveBeenCalledTimes(2)
    expectNoGlobalWrites()
  })

  it('a session without punch clones: the lock is taken, the hours come from the approved records on the transaction client, the pointer is set', async () => {
    const tx = setup({ clonedPunches: 0 })
    tx.attendanceUpload.findFirst.mockResolvedValue({ id: UPLOAD_ID })
    tx.attendanceRecord.findMany.mockResolvedValue([
      { employeeId: EMPLOYEE_ONE.id, regularHours: 8, overtimeHours: 0, employee: payEmployee(EMPLOYEE_ONE) },
    ])

    const result = await recalculateAndCreateRevision({ ...input, correctionTypes: ['ADJUSTMENTS'] })

    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(tx.attendanceUpload.findFirst).toHaveBeenCalledWith({
      where: { payrollWeekStartDate: WEEK_START, payrollWeekEndDate: WEEK_END, isActiveForPayrollWeek: true },
    })
    expect(tx.attendanceRecord.findMany).toHaveBeenCalledTimes(1)
    expect(tx.attendanceRecord.findMany.mock.calls[0][0].where).toEqual({ attendanceUploadId: UPLOAD_ID })
    expect(prisma.attendanceUpload.findFirst).not.toHaveBeenCalled()
    expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled()
    expectInOrder(
      ['lockWeekRow', lockWeekRow],
      ['tx.attendancePunch.count', tx.attendancePunch.count],
      ['tx.attendanceUpload.findFirst', tx.attendanceUpload.findFirst],
      ['tx.attendanceRecord.findMany', tx.attendanceRecord.findMany],
      ['tx.payrollRevision.create', tx.payrollRevision.create],
      ['tx.payrollCorrectionSession.update', tx.payrollCorrectionSession.update],
    )
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { draftRevisionId: result.revisionId, correctionReason: 'Wrong OUT time', correctionTypesJson: ['ADJUSTMENTS'] },
    })
  })

  it('no correction type selected is refused before any transaction or lock', async () => {
    const tx = setup()

    await expect(recalculateAndCreateRevision({ ...input, correctionTypes: [] })).rejects.toMatchObject({
      code: 'NO_CORRECTION_TYPE_SELECTED',
      message: 'At least one correction type must be selected',
    })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })
})

describe('item 3: approveCorrectionPunches', () => {
  function setup(opts: { types?: string[]; review?: ReturnType<typeof reviewOf>; punches?: PunchFixture[] } = {}) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    const session = makeSession({ correctionReason: 'Wrong OUT time', correctionTypesJson: opts.types ?? ['ATTENDANCE'] })
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(session as never)
    // approveCorrectionPunches only checks that the run exists; recalculate then reads it with its revisions.
    vi.mocked(prisma.payrollRun.findUnique)
      .mockResolvedValueOnce({ id: RUN_ID } as never)
      .mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(session as never)
    tx.payrollCorrectionSession.findUnique.mockResolvedValue(session)
    tx.attendancePunch.count.mockResolvedValue(28)
    vi.mocked(getPunchReview).mockResolvedValue((opts.review ?? reviewOf(opts.punches ?? fullDay())) as never)
    tx.employee.findMany.mockResolvedValue([payEmployee(EMPLOYEE_ONE)])
    tx.payrollRunEmployee.findMany.mockResolvedValue([])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    return { tx, session }
  }

  it('never reads the review on the global client: every getPunchReview call is inside the transaction and gets the transaction client', async () => {
    const { tx } = setup()
    const reads: Array<{ inTransaction: boolean; client: unknown }> = []
    let readsBeforeTransaction = -1
    vi.mocked(getPunchReview).mockImplementation((async (_week: string, _mode: unknown, client: unknown) => {
      reads.push({ inTransaction, client })
      return reviewOf(fullDay())
    }) as never)
    const original = vi.mocked(prisma.$transaction).getMockImplementation()!
    vi.mocked(prisma.$transaction).mockImplementation(((arg: unknown, ...rest: unknown[]) => {
      readsBeforeTransaction = reads.length
      return (original as (...a: unknown[]) => unknown)(arg, ...rest)
    }) as never)

    await approveCorrectionPunches(RUN_ID)

    expect(readsBeforeTransaction).toBe(0) // the old pre-transaction review (and its needs-fixing check) is gone
    expect(reads).toEqual([{ inTransaction: true, client: tx }])
  })

  it('returns what the recalculation returns, with the session\'s reason and types going into the draft and the pointer', async () => {
    const { tx } = setup()

    const result = await approveCorrectionPunches(RUN_ID)

    expect(result).toMatchObject({ payrollRunId: RUN_ID, revisionNumber: 2, employeeCount: 1 })
    expect(result.revisionId).toEqual(expect.any(String))
    expect(tx.payrollRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: result.revisionId, correctionReason: 'Wrong OUT time', status: 'DRAFT' }),
    })
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { draftRevisionId: result.revisionId, correctionReason: 'Wrong OUT time', correctionTypesJson: ['ATTENDANCE'] },
    })
    expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
  })

  it('an incomplete pair found inside the transaction refuses the draft and leaves the pointer and the earlier draft alone', async () => {
    const { tx } = setup({ review: reviewOf(fullDay(), 2) })

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({
      code: 'CORRECTION_HAS_INCOMPLETE_PAIRS',
      message: '2 day(s) still have an incomplete pair. Fix or delete them first.',
    })

    expect(getPunchReview).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getPunchReview).mock.calls[0][2]).toBe(tx)
    expectNoTxWrites(tx)
  })

  it('NO_CORRECTION_TYPE_SELECTED wins over the incomplete-pairs check: a session with no types is refused before the review is even read', async () => {
    const { tx } = setup({ types: [], review: reviewOf(fullDay(), 3) })

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({ code: 'NO_CORRECTION_TYPE_SELECTED' })

    expect(getPunchReview).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })

  it('needs a correction in progress, and a run that exists, before it opens a transaction', async () => {
    const { tx } = setup()
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)

    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession({ correctionTypesJson: ['ATTENDANCE'] }) as never)
    vi.mocked(prisma.payrollRun.findUnique).mockReset()
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)
    await expect(approveCorrectionPunches(RUN_ID)).rejects.toMatchObject({ code: 'PAYROLL_RUN_NOT_FOUND' })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(getPunchReview).not.toHaveBeenCalled()
    expect(lockWeekRow).not.toHaveBeenCalled()
    expectNoTxWrites(tx)
  })

  it('the punches are read inside the transaction: an edit that landed after the session was looked up but before the transaction is in the draft', async () => {
    const punches = fullDay('17:47')
    const { tx } = setup({ punches })
    // The "other tab" saves its edit (OUT 17:47 -> 18:00) right after the pre-transaction session lookup.
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockImplementation((async () => {
      punches[3] = { ...punches[3], currentTime: '18:00' }
      return makeSession({ correctionTypesJson: ['ATTENDANCE'] })
    }) as never)
    vi.mocked(getPunchReview).mockImplementation((async () => reviewOf(punches)) as never)

    await approveCorrectionPunches(RUN_ID)

    // 07:40-13:04 + 13:56-18:00 = 9.47 h (8.00 regular + 1.47 overtime); with the old OUT it would be 1.25 overtime.
    const rows = tx.payrollRunEmployee.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ employeeId: EMPLOYEE_ONE.id, regularHours: 8, overtimeHours: 1.47 })
  })

  it('an edit applied after the transaction returned is not in the draft that was already written (savePunchEdit clears the pointer for that case)', async () => {
    const punches = fullDay('17:47')
    const { tx } = setup({ punches })
    vi.mocked(getPunchReview).mockImplementation((async () => reviewOf(punches)) as never)

    await approveCorrectionPunches(RUN_ID)
    punches[3] = { ...punches[3], currentTime: '18:00' } // a save after the draft was committed

    const rows = tx.payrollRunEmployee.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ regularHours: 8, overtimeHours: 1.25 })
    // The draft still carries the pointer here; it is the later save (punch-review.service) that must null it.
    expect(tx.payrollCorrectionSession.update).toHaveBeenCalledTimes(1)
  })
})

// ─── Round 4, item 2: the draft always locks, and reads the current revision under the lock ──────────

describe('round 4, item 2: recalculateAndCreateRevision locks with or without a session and re-reads the current revision', () => {
  const REV_2 = makeRevision({ id: 'rev-2', revisionNumber: 2 })
  const REV_3 = makeRevision({ id: 'rev-3', revisionNumber: 3 })
  const adjustmentsOnly = { payrollRunId: RUN_ID, correctionReason: 'Reverse a deduction', correctionTypes: ['ADJUSTMENTS' as const] }
  const withSession = { payrollRunId: RUN_ID, correctionReason: 'Wrong OUT time', correctionTypes: ['ATTENDANCE' as const], correctionSessionId: SESSION_ID }

  /** The run is read with `before` as its current revision; the transaction's own read answers `locked`. */
  function setup(opts: { before?: ReturnType<typeof makeRevision> | null; locked?: ReturnType<typeof makeRevision> | null; session?: boolean } = {}) {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    const before = opts.before === undefined ? REV_2 : opts.before
    const locked = opts.locked === undefined ? before : opts.locked
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({ ...makeRun(), revisions: before ? [before] : [] } as never)
    tx.payrollRevision.findFirst.mockResolvedValue(locked)
    vi.mocked(lockWeekRow).mockResolvedValue({ id: UPLOAD_ID } as never)
    if (opts.session) {
      vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(makeSession() as never)
      tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
      tx.attendancePunch.count.mockResolvedValue(28)
      vi.mocked(getPunchReview).mockResolvedValue(reviewOf(fullDay()) as never)
      tx.employee.findMany.mockResolvedValue([payEmployee(EMPLOYEE_ONE)])
    } else {
      tx.attendanceUpload.findFirst.mockResolvedValue({ id: UPLOAD_ID })
      tx.attendanceRecord.findMany.mockResolvedValue([
        { employeeId: EMPLOYEE_ONE.id, regularHours: 8, overtimeHours: 0, employee: payEmployee(EMPLOYEE_ONE) },
      ])
    }
    tx.payrollRunEmployee.findMany.mockResolvedValue([])
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    return tx
  }

  /** First call order of every query and write the transaction client made. */
  function txCallOrders(tx: Tx): Array<[string, number]> {
    const orders: Array<[string, number]> = []
    for (const [model, methods] of Object.entries(tx)) {
      for (const [method, fn] of Object.entries(methods as Record<string, unknown>)) {
        const calls = (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
        if (calls.length > 0) orders.push([`tx.${model}.${method}`, calls[0]])
      }
    }
    return orders
  }

  describe('without a session', () => {
    it('locks once, by the run\'s week start, before any other call on the transaction client', async () => {
      const tx = setup()

      await recalculateAndCreateRevision(adjustmentsOnly)

      expect(lockWeekRow).toHaveBeenCalledTimes(1)
      expect(lockWeekRow).toHaveBeenCalledWith(tx, { weekStart: WEEK_START })
      const lockArg = vi.mocked(lockWeekRow).mock.calls[0][1] as { weekStart: Date }
      expect(lockArg.weekStart.getTime()).toBe(WEEK_START.getTime())
      const lock = callOrder(lockWeekRow)
      for (const [name, firstCall] of txCallOrders(tx)) expect(lock, `the lock must come before ${name}`).toBeLessThan(firstCall)
      expect(txCallOrders(tx).length).toBeGreaterThan(3)
    })

    it('reads the current revision after the lock, on the transaction client, by run and isCurrent', async () => {
      const tx = setup()

      await recalculateAndCreateRevision(adjustmentsOnly)

      expect(tx.payrollRevision.findFirst).toHaveBeenCalledTimes(1)
      expect(tx.payrollRevision.findFirst).toHaveBeenCalledWith({ where: { payrollRunId: RUN_ID, isCurrent: true } })
      expectInOrder(
        ['lockWeekRow', lockWeekRow],
        ['tx.payrollRevision.findFirst', tx.payrollRevision.findFirst],
        ['tx.attendanceUpload.findFirst', tx.attendanceUpload.findFirst],
        ['tx.payrollRevision.create', tx.payrollRevision.create],
      )
    })

    it('it is still one transaction with the shared timeout, and no query leaves it', async () => {
      setup()

      await recalculateAndCreateRevision(adjustmentsOnly)

      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 })
      expectOnlyInteractiveTransactions()
      expectNoGlobalWrites()
    })

    it('a week with no active row (the lock finds nothing) is not an error: the draft is still written', async () => {
      const tx = setup()
      vi.mocked(lockWeekRow).mockResolvedValue(null)

      await expect(recalculateAndCreateRevision(adjustmentsOnly)).resolves.toMatchObject({ revisionNumber: 3 })

      expect(tx.payrollRevision.create).toHaveBeenCalledTimes(1)
    })

    it('a failing lock query writes nothing', async () => {
      const tx = setup()
      vi.mocked(lockWeekRow).mockRejectedValue(new Error('could not obtain lock'))

      await expect(recalculateAndCreateRevision(adjustmentsOnly)).rejects.toThrow('could not obtain lock')

      expectNoTxWrites(tx)
      expect(tx.payrollRevision.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('with a session', () => {
    it('locks once by the session\'s upload id, before the session re-read and the revision re-read', async () => {
      const tx = setup({ session: true })

      await recalculateAndCreateRevision(withSession)

      expect(lockWeekRow).toHaveBeenCalledTimes(1)
      expect(lockWeekRow).toHaveBeenCalledWith(tx, { id: UPLOAD_ID })
      expectInOrder(
        ['lockWeekRow', lockWeekRow],
        ['tx.payrollCorrectionSession.findUnique', tx.payrollCorrectionSession.findUnique],
        ['tx.payrollRevision.findFirst', tx.payrollRevision.findFirst],
        ['tx.attendancePunch.count', tx.attendancePunch.count],
        ['getPunchReview', getPunchReview],
        ['tx.payrollRevision.create', tx.payrollRevision.create],
      )
      for (const [name, firstCall] of txCallOrders(tx)) expect(callOrder(lockWeekRow), `the lock must come before ${name}`).toBeLessThan(firstCall)
    })

    it('a session that ended while waiting for the lock is refused before the revision is read', async () => {
      const tx = setup({ session: true })
      tx.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession({ status: 'ABANDONED' }))

      await expect(recalculateAndCreateRevision(withSession)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })

      expect(tx.payrollRevision.findFirst).not.toHaveBeenCalled()
      expectNoTxWrites(tx)
    })
  })

  describe('the revision is the one that is current when the lock is held', () => {
    it('another revision was approved after the read: the draft is numbered after it (4, not 3)', async () => {
      const tx = setup({ before: REV_2, locked: REV_3 })

      const result = await recalculateAndCreateRevision(adjustmentsOnly)

      expect(result.revisionNumber).toBe(4)
      expect(tx.payrollRevision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ revisionNumber: 4, status: 'DRAFT', isCurrent: false }),
      })
    })

    it('the previous-employee diff is taken against the revision that is current now', async () => {
      const tx = setup({ before: REV_2, locked: REV_3 })

      await recalculateAndCreateRevision(adjustmentsOnly)

      expect(tx.payrollRunEmployee.findMany).toHaveBeenCalledTimes(1)
      expect(tx.payrollRunEmployee.findMany).toHaveBeenCalledWith({ where: { payrollRevisionId: 'rev-3' } })
      expect(tx.payrollRunEmployee.findMany).not.toHaveBeenCalledWith({ where: { payrollRevisionId: 'rev-2' } })
    })

    it('with a session, the punch review is read for the locked revision number', async () => {
      setup({ before: REV_2, locked: REV_3, session: true })

      await recalculateAndCreateRevision(withSession)

      expect(vi.mocked(getPunchReview).mock.calls[0][1]).toEqual({
        kind: 'CORRECTION',
        payrollRunId: RUN_ID,
        correctionId: SESSION_ID,
        revisionNumber: 3,
      })
    })

    it('when nothing moved, the number is the old read\'s plus one and the diff is against that revision', async () => {
      const tx = setup()

      const result = await recalculateAndCreateRevision(adjustmentsOnly)

      expect(result.revisionNumber).toBe(3)
      expect(tx.payrollRunEmployee.findMany).toHaveBeenCalledWith({ where: { payrollRevisionId: 'rev-2' } })
    })
  })

  describe('no current revision under the lock', () => {
    it('REVISION_NOT_FOUND and no write of any kind (without a session)', async () => {
      const tx = setup({ before: REV_2, locked: null })

      const error = await recalculateAndCreateRevision(adjustmentsOnly).catch((e) => e)

      expect(error).toMatchObject({ name: 'CorrectionServiceError', code: 'REVISION_NOT_FOUND', message: 'No current revision found' })
      expect(lockWeekRow).toHaveBeenCalledTimes(1)
      expectNoTxWrites(tx)
      expectNoGlobalWrites()
      expect(tx.payrollRunEmployee.findMany).not.toHaveBeenCalled()
    })

    it('REVISION_NOT_FOUND and no write of any kind (with a session): the punches are not even read', async () => {
      const tx = setup({ before: REV_2, locked: null, session: true })

      await expect(recalculateAndCreateRevision(withSession)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' })

      expect(tx.attendancePunch.count).not.toHaveBeenCalled()
      expect(getPunchReview).not.toHaveBeenCalled()
      expectNoTxWrites(tx)
      expectNoGlobalWrites()
    })

    it('the earlier draft is kept: nothing is deleted when the re-read finds no revision', async () => {
      const tx = setup({ before: REV_2, locked: null })

      await recalculateAndCreateRevision(adjustmentsOnly).catch(() => undefined)

      expect(tx.payrollRevision.deleteMany).not.toHaveBeenCalled()
      expect(tx.payrollRunEmployee.deleteMany).not.toHaveBeenCalled()
    })

    it('the read before the transaction stays as a fast fail: no revision there means no transaction and no lock', async () => {
      const tx = setup({ before: null })

      await expect(recalculateAndCreateRevision(adjustmentsOnly)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' })

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(lockWeekRow).not.toHaveBeenCalled()
      expect(tx.payrollRevision.findFirst).not.toHaveBeenCalled()
    })
  })
})

// ─── A missing week row ───────────────────────────────────────────────────────

describe('lockWeekRow finds no row (the upload was deleted): current behaviour of each writer', () => {
  // None of the four writers checks the lock's result. beginCorrection has nothing else to stop it;
  // the other three are stopped (or not) by their own session re-read. This pins what happens today.
  it('beginCorrection does not check the lock result and still opens the session', async () => {
    const tx = makeTx()
    withInteractiveTransaction(tx)
    vi.mocked(lockWeekRow).mockResolvedValue(null)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makeRun() as never)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: UPLOAD_ID } as never)
    tx.payrollCorrectionSession.findFirst.mockResolvedValue(null)
    tx.payrollAdjustmentApplication.findMany.mockResolvedValue([])
    tx.payrollCorrectionSession.create.mockResolvedValue(makeSession({ id: 'new-session' }))
    tx.payrollRun.findUnique.mockResolvedValue({ payrollWeekStartDate: WEEK_START })

    await expect(beginCorrection(RUN_ID)).resolves.toMatchObject({ sessionId: 'new-session', resumed: false })
    expect(tx.payrollCorrectionSession.create).toHaveBeenCalledTimes(1)
  })

  it('startAttendanceCorrection, abandonCorrection and recalculateAndCreateRevision go on to their own session re-read', async () => {
    vi.mocked(lockWeekRow).mockResolvedValue(null)

    // startAttendanceCorrection: the session re-read says it is gone -> refused.
    const startTx = makeTx()
    withInteractiveTransaction(startTx)
    vi.mocked(prisma.payrollCorrectionSession.findFirst).mockResolvedValue(makeSession() as never)
    startTx.payrollCorrectionSession.findUnique.mockResolvedValue(null)
    await expect(startAttendanceCorrection(RUN_ID, { reason: null, types: ['ATTENDANCE'] })).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expect(startTx.payrollCorrectionSession.update).not.toHaveBeenCalled()

    // abandonCorrection: same.
    const abandonTx = makeTx()
    withInteractiveTransaction(abandonTx)
    abandonTx.payrollCorrectionSession.findUnique.mockResolvedValue(null)
    await expect(abandonCorrection(RUN_ID)).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expect(abandonTx.attendancePunch.deleteMany).not.toHaveBeenCalled()

    // recalculateAndCreateRevision: same.
    const recalcTx = makeTx()
    withInteractiveTransaction(recalcTx)
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({ ...makeRun(), revisions: [makeRevision()] } as never)
    vi.mocked(prisma.payrollCorrectionSession.findUnique).mockResolvedValue(makeSession() as never)
    recalcTx.payrollCorrectionSession.findUnique.mockResolvedValue(null)
    await expect(
      recalculateAndCreateRevision({ payrollRunId: RUN_ID, correctionReason: null, correctionTypes: ['ATTENDANCE'], correctionSessionId: SESSION_ID }),
    ).rejects.toMatchObject({ code: 'CORRECTION_NOT_ACTIVE' })
    expect(recalcTx.payrollRevision.create).not.toHaveBeenCalled()
  })
})
