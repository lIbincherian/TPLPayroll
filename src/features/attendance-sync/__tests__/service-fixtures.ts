/**
 * Shared test plumbing for the attendance-sync service tests: a Prisma mock (with a separate
 * client for interactive transactions), an in-memory punch store, and fixture builders.
 * Not a test file. Each test file wires it in with:
 *
 *   vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
 */
import { vi } from 'vitest'
import type { AttendanceUpload, PayrollCorrectionSession, PayrollRun } from '@prisma/client'
import { punchSetSignature } from '../lib/day-signature'
import type { StatusEmployee } from '../lib/employee-status'
import type { LockedWeekRow } from '../services/week-lock.service'
import type { EmployeeLite, HHmm, ISODate } from '../types/attendance-sync.types'

type Fn = ReturnType<typeof vi.fn>
type ModelMock = Record<string, Fn>

const MODEL_METHODS = {
  attendanceUpload: ['findFirst', 'findMany', 'count', 'create', 'update', 'updateMany'],
  attendancePunch: ['findMany', 'count', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany'],
  attendanceEmployeeDecision: ['findMany', 'findUnique', 'create', 'update', 'count', 'deleteMany'],
  attendanceCodeException: ['findMany', 'findUnique', 'upsert', 'delete'],
  attendanceRecord: ['findMany', 'groupBy', 'count', 'deleteMany', 'createMany'],
  employee: ['findMany', 'findUnique', 'update'],
  payrollRun: ['findFirst', 'findMany'],
  payrollCorrectionSession: ['findFirst', 'findUnique', 'update'],
  auditLog: ['create'],
} as const

type ModelName = keyof typeof MODEL_METHODS

export interface Db {
  attendanceUpload: ModelMock
  attendancePunch: ModelMock
  attendanceEmployeeDecision: ModelMock
  attendanceCodeException: ModelMock
  attendanceRecord: ModelMock
  employee: ModelMock
  payrollRun: ModelMock
  payrollCorrectionSession: ModelMock
  auditLog: ModelMock
  /** `SELECT ... FOR UPDATE` on the week row (lockWeekRow). Resolves to one row; see `lockedRow`. */
  $queryRaw: Fn
  $transaction: Fn
  /** The client handed to interactive `$transaction(async (tx) => ...)` callbacks. */
  tx: Omit<Db, '$transaction' | 'tx'>
}

function buildModels(): Omit<Db, '$transaction' | 'tx'> {
  const models = { $queryRaw: vi.fn() } as unknown as Record<string, ModelMock>
  for (const name of Object.keys(MODEL_METHODS) as ModelName[]) {
    models[name] = Object.fromEntries(MODEL_METHODS[name].map((method) => [method, vi.fn()]))
  }
  return models as unknown as Omit<Db, '$transaction' | 'tx'>
}

export function buildDb(): Db {
  const db = { ...buildModels(), $transaction: vi.fn(), tx: buildModels() } as Db
  resetDb(db)
  return db
}

/** The row `lockWeekRow` returns for the default upload: an eTimeOffice week in REVIEW, not syncing. */
export function lockedRow(overrides: Partial<LockedWeekRow> = {}): LockedWeekRow {
  return {
    id: 'upload-1',
    source: 'ETIMEOFFICE',
    status: 'REVIEW',
    syncLockedAt: null,
    approvedAt: null,
    payrollWeekStartDate: new Date('2026-11-05T00:00:00Z'),
    ...overrides,
  }
}

/** Make the next `lockWeekRow` calls on a client return this row (or no row, with `null`). */
export function mockLockedWeek(client: { $queryRaw: Fn }, row: Partial<LockedWeekRow> | null = {}): void {
  client.$queryRaw.mockResolvedValue(row === null ? [] : [lockedRow(row)])
}

/**
 * Serve one upload row to the week lookup on both clients (before the transaction and inside it) and
 * make the locked row agree with it. `null` = no active row.
 */
export function serveUpload(db: Db, row: AttendanceUpload | null): void {
  db.attendanceUpload.findFirst.mockResolvedValue(row)
  db.tx.attendanceUpload.findFirst.mockResolvedValue(row)
  mockLockedWeek(
    db.tx,
    row === null
      ? null
      : {
          id: row.id,
          source: row.source,
          status: row.status,
          syncLockedAt: row.syncLockedAt,
          approvedAt: row.approvedAt,
          payrollWeekStartDate: row.payrollWeekStartDate,
        },
  )
}

/** Clear every mock and restore harmless defaults (empty reads, a transaction that runs its argument). */
export function resetDb(db: Db): void {
  const reset = (models: Omit<Db, '$transaction' | 'tx'>) => {
    for (const name of Object.keys(MODEL_METHODS) as ModelName[]) {
      for (const method of MODEL_METHODS[name]) models[name][method].mockReset()
    }
    models.attendanceUpload.findFirst.mockResolvedValue(null)
    models.attendanceUpload.findMany.mockResolvedValue([])
    models.attendanceUpload.count.mockResolvedValue(0)
    models.attendancePunch.findMany.mockResolvedValue([])
    models.attendancePunch.count.mockResolvedValue(0)
    models.attendanceEmployeeDecision.findMany.mockResolvedValue([])
    models.attendanceEmployeeDecision.count.mockResolvedValue(0)
    models.attendanceCodeException.findMany.mockResolvedValue([])
    models.attendanceRecord.findMany.mockResolvedValue([])
    models.attendanceRecord.groupBy.mockResolvedValue([])
    models.attendanceRecord.count.mockResolvedValue(0)
    models.employee.findMany.mockResolvedValue([])
    models.employee.update.mockResolvedValue({})
    models.payrollRun.findFirst.mockResolvedValue(null)
    models.payrollRun.findMany.mockResolvedValue([])
    models.payrollCorrectionSession.findFirst.mockResolvedValue(null)
    models.auditLog.create.mockResolvedValue({ id: 'audit-1' })
    models.$queryRaw.mockReset()
    models.$queryRaw.mockResolvedValue([lockedRow()])
  }
  reset(db)
  reset(db.tx)
  db.$transaction.mockReset()
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: Db['tx']) => Promise<unknown>)(db.tx) : Promise.all(arg as unknown[]),
  )
}

/**
 * Serve `employee.findUnique` (by id) on both clients from the same list the `findMany` mocks return.
 * savePunchEdit looks the employee up again inside its transaction; an unknown id answers null.
 */
export function serveEmployeeLookup(db: Db, employees: EmployeeLite[]): void {
  for (const client of [db, db.tx]) {
    client.employee.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => employees.find((e) => e.id === where.id) ?? null,
    )
  }
}

/**
 * Serve `attendanceEmployeeDecision.findUnique` (by the upload + employee key) on both clients from the
 * same rows the `findMany` mocks return. No decision for the employee answers null.
 */
export function serveDecisionLookup(db: Db, decisions: Array<{ employeeId: string; decision: string }>): void {
  for (const client of [db, db.tx]) {
    client.attendanceEmployeeDecision.findUnique.mockImplementation(
      async ({ where }: { where: { attendanceUploadId_employeeId: { employeeId: string } } }) => {
        const row = decisions.find((d) => d.employeeId === where.attendanceUploadId_employeeId.employeeId)
        return row ? { decision: row.decision } : null
      },
    )
  }
}

/** The `data` of every `auditLog.create` call on a client, in call order. */
export function auditRows(client: { auditLog: ModelMock }): Array<{
  actionType: string
  entityType: string
  entityId: string
  detailsJson: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}> {
  return client.auditLog.create.mock.calls.map((call) => (call[0] as { data: never }).data)
}

// ─── Clock ────────────────────────────────────────────────────────────────────

/** Freeze `new Date()` (timers stay real so promises and awaits behave normally). */
export function freezeClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

export const WEEK = { start: '2026-11-05', end: '2026-11-11' }
export const WEEK_DATES = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']
export const utc = (iso: ISODate) => new Date(`${iso}T00:00:00Z`)

export function makeUpload(overrides: Partial<AttendanceUpload> = {}): AttendanceUpload {
  return {
    id: 'upload-1',
    fileName: null,
    fileType: null,
    payrollWeekStartDate: utc(WEEK.start),
    payrollWeekEndDate: utc(WEEK.end),
    payrollWeekSource: 'ETIMEOFFICE',
    source: 'ETIMEOFFICE',
    status: 'REVIEW',
    isActiveForPayrollWeek: true,
    uploadedBy: null,
    uploadedAt: new Date('2026-11-09T08:00:00Z'),
    sourceStorageKey: null,
    lastSyncAttemptAt: null,
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncTrigger: null,
    staleNoticeAt: null,
    syncLockedAt: null,
    approvedAt: null,
    activeWeekStart: utc(WEEK.start),
    ...overrides,
  } as AttendanceUpload
}

export function makeExcelUpload(overrides: Partial<AttendanceUpload> = {}): AttendanceUpload {
  return makeUpload({
    source: 'EXCEL',
    payrollWeekSource: 'FILE_NAME',
    status: 'READY',
    fileName: 'attendance-week.xlsx',
    fileType: 'xlsx',
    ...overrides,
  })
}

export function makeEmployee(overrides: Partial<StatusEmployee> = {}): StatusEmployee {
  return {
    id: 'emp-36',
    employeeId: 'TPLGOAHLP036',
    employeeName: 'Asha Rao',
    isActive: true,
    dateOfJoining: null,
    dateOfResignation: null,
    ...overrides,
  }
}

export function makeRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run-1',
    payrollWeekStartDate: utc(WEEK.start),
    payrollWeekEndDate: utc(WEEK.end),
    status: 'APPROVED',
    ...overrides,
  } as PayrollRun
}

export function makeSession(overrides: Partial<PayrollCorrectionSession> = {}): PayrollCorrectionSession {
  return {
    id: 'session-1',
    payrollRunId: 'run-1',
    attendanceUploadId: 'upload-1',
    status: 'IN_PROGRESS',
    correctionReason: null,
    correctionTypesJson: ['ATTENDANCE'],
    adjustmentSnapshotJson: null,
    draftRevisionId: null,
    createdAt: new Date('2026-11-13T08:00:00Z'),
    appliedAt: null,
    abandonedAt: null,
    ...overrides,
  } as PayrollCorrectionSession
}

export interface PunchRow {
  id: string
  attendanceUploadId: string
  correctionId: string | null
  employeeId: string | null
  empCode: string
  empName: string | null
  matchStatus: string
  punchDate: Date
  pairIndex: number
  position: string
  source: string
  originalTime: HHmm | null
  currentTime: HHmm | null
  note: string | null
  mergedScansJson: unknown
  mcid: string | null
  updatedAt: Date
}

export function makePunch(overrides: Partial<PunchRow> = {}): PunchRow {
  return {
    id: 'punch-1',
    attendanceUploadId: 'upload-1',
    correctionId: null,
    employeeId: 'emp-36',
    empCode: '0036',
    empName: 'Empname0036',
    matchStatus: 'MATCHED',
    punchDate: utc('2026-11-05'),
    pairIndex: 0,
    position: 'IN',
    source: 'API',
    originalTime: '07:40',
    currentTime: '07:40',
    note: null,
    mergedScansJson: null,
    mcid: null,
    updatedAt: new Date('2026-11-09T10:00:00Z'),
    ...overrides,
  }
}

/**
 * One day of API punches in order: times[0] IN / times[1] OUT of pair 0, times[2] / times[3] of pair 1,
 * and a trailing odd time is an IN with no OUT. Ids are `${idPrefix}-${n}`.
 */
export function dayPunches(opts: {
  idPrefix: string
  employeeId: string | null
  empCode?: string
  date: ISODate
  times: HHmm[]
  uploadId?: string
  correctionId?: string | null
  matchStatus?: string
  empName?: string | null
}): PunchRow[] {
  return opts.times.map((time, i) =>
    makePunch({
      id: `${opts.idPrefix}-${i}`,
      attendanceUploadId: opts.uploadId ?? 'upload-1',
      correctionId: opts.correctionId ?? null,
      employeeId: opts.employeeId,
      empCode: opts.empCode ?? '0036',
      empName: opts.empName === undefined ? `Empname${opts.empCode ?? '0036'}` : opts.empName,
      matchStatus: opts.matchStatus ?? 'MATCHED',
      punchDate: utc(opts.date),
      pairIndex: Math.floor(i / 2),
      position: i % 2 === 0 ? 'IN' : 'OUT',
      originalTime: time,
      currentTime: time,
    }),
  )
}

// ─── In-memory punch store ────────────────────────────────────────────────────

type Where = Record<string, unknown>

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c))
    const value = row[key]
    if (cond === null) return value === null || value === undefined
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
    if (typeof cond === 'object') {
      const c = cond as { in?: unknown[]; not?: unknown }
      if (c.in) return c.in.includes(value)
      if ('not' in c) return value !== c.not
      throw new Error(`Unsupported where operator on ${key}: ${JSON.stringify(cond)}`)
    }
    return value === cond
  })
}

export interface PunchStore {
  rows: PunchRow[]
  /** Rows in the live set (correctionId null) for one employee-day. */
  day(employeeId: string, date: ISODate, correctionId?: string | null): PunchRow[]
}

/** The `baseSignature` an editor opened on this employee-day holds: the signature of its stored rows right now. */
export function baseSignatureOf(
  store: PunchStore,
  employeeId: string,
  date: ISODate,
  correctionId: string | null = null,
): string {
  return punchSetSignature(store.day(employeeId, date, correctionId))
}

/**
 * Back `attendancePunch` with an in-memory table, on both the plain client (reads) and the
 * transaction client (the writes, and the reads inside it). The mocked writes apply immediately,
 * so a call that must not happen is asserted with `not.toHaveBeenCalled()` as well as by reading
 * the store.
 */
export function installPunchStore(db: Db, initial: PunchRow[]): PunchStore {
  const store: PunchStore = {
    rows: initial.map((r) => ({ ...r })),
    day: (employeeId, date, correctionId = null) =>
      store.rows.filter(
        (r) =>
          r.employeeId === employeeId &&
          r.punchDate.getTime() === utc(date).getTime() &&
          r.correctionId === correctionId,
      ),
  }

  for (const client of [db, db.tx]) {
    client.attendancePunch.findMany.mockImplementation(async (args?: { where?: Where }) =>
      store.rows.filter((r) => matches(r as unknown as Record<string, unknown>, args?.where ?? {})).map((r) => ({ ...r })),
    )
    client.attendancePunch.create.mockImplementation(async ({ data }: { data: Partial<PunchRow> }) => {
      const row = makePunch({ ...data, updatedAt: new Date() } as Partial<PunchRow>)
      store.rows.push(row)
      return row
    })
    client.attendancePunch.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Partial<PunchRow> }) => {
        const row = store.rows.find((r) => r.id === where.id)
        if (!row) throw new Error(`No punch ${where.id}`)
        Object.assign(row, data, { updatedAt: new Date() })
        return row
      },
    )
    client.attendancePunch.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
      store.rows = store.rows.filter((r) => r.id !== where.id)
      return { id: where.id }
    })
  }
  return store
}
