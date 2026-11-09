import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const connectionString = process.env.DIRECT_DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 5000,
})
pool.on('error', () => {}) // Suppress pool errors
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })
export default prisma;


export async function cleanupDatabase() {
  const tables = [
    '"AuditLog"',
    '"AttendancePunch"',
    '"PayrollCorrectionSession"',
    '"AttendanceEmployeeDecision"',
    '"AttendanceCodeException"',
    '"InvoiceSnapshot"',
    '"PayrollRunEmployee"',
    '"PayrollRevision"',
    '"PayrollAdjustmentApplication"',
    '"PayrollAdjustment"',
    '"PayrollRun"',
    '"AttendanceRecord"',
    '"AttendanceUpload"',
    '"EmployeeWageHistory"',
    '"EmployeeDocument"',
    '"Employee"',
    '"EmployeeImportBatch"',
  ];
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM ${tables.join('; DELETE FROM ')};`);
  } catch (err) {
    console.error(`Cleanup failed:`, (err as Error).message);
    throw err;
  }
}

// ─── F12 helpers: API weeks, punches and employees ────────────────────────────
// Attendance now enters only through eTimeOffice. An approved week has live AttendancePunch rows
// AND the AttendanceRecord rows that payroll reads (the approval step writes both).

export const utcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

export function addDaysISO(iso: string, days: number): string {
  const d = utcDate(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function weekDatesISO(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i))
}

function toHHmm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** eTimeOffice code for an Employee ID: its trailing digits, padded to four ("EMP-PRY-001" -> "0001"). */
export function codeForEmployeeId(employeeId: string): string {
  const digits = /(\d+)$/.exec(employeeId)?.[1] ?? '0'
  return digits.padStart(4, '0')
}

export interface DayHours {
  reg: number
  ot: number
}

interface SeedEmployee {
  id: string
  employeeId: string
  employeeName: string
}

/** One pair from 08:00 that produces exactly these hours (8/0 -> 08:00-16:00, 8/2 -> 08:00-18:00). */
function punchRowsForHours(uploadId: string, employee: SeedEmployee, date: string, hours: DayHours) {
  const total = hours.reg + hours.ot
  if (total <= 0) return []
  const base = {
    attendanceUploadId: uploadId,
    employeeId: employee.id,
    empCode: codeForEmployeeId(employee.employeeId),
    empName: employee.employeeName,
    matchStatus: 'MATCHED',
    punchDate: utcDate(date),
    pairIndex: 0,
    source: 'API',
    mcid: '1',
  }
  const out = toHHmm(8 * 60 + Math.round(total * 60))
  return [
    { ...base, position: 'IN', originalTime: '08:00', currentTime: '08:00' },
    { ...base, position: 'OUT', originalTime: out, currentTime: out },
  ]
}

/**
 * An eTimeOffice week with punches for every employee and, when APPROVED, the AttendanceRecord
 * rows payroll reads. `days[i]` holds employee i's seven days (Thursday first).
 */
export async function seedApiWeek(opts: {
  weekStartISO: string
  employees: SeedEmployee[]
  days: DayHours[][]
  status?: 'APPROVED' | 'REVIEW'
}): Promise<{ id: string }> {
  const { weekStartISO, employees, days, status = 'APPROVED' } = opts
  const dates = weekDatesISO(weekStartISO)
  const loadedAt = new Date(`${addDaysISO(weekStartISO, 7)}T01:00:00.000Z`)
  const upload = await prisma.attendanceUpload.create({
    data: {
      source: 'ETIMEOFFICE',
      payrollWeekSource: 'ETIMEOFFICE',
      fileName: null,
      fileType: null,
      status,
      isActiveForPayrollWeek: true,
      payrollWeekStartDate: utcDate(weekStartISO),
      payrollWeekEndDate: utcDate(dates[6]),
      lastSyncedAt: loadedAt,
      lastSyncTrigger: 'SCHEDULED',
      approvedAt: status === 'APPROVED' ? new Date(`${addDaysISO(weekStartISO, 7)}T08:00:00.000Z`) : null,
    },
  })

  const punchRows = employees.flatMap((emp, ei) =>
    dates.flatMap((date, di) => punchRowsForHours(upload.id, emp, date, days[ei][di])),
  )
  if (punchRows.length > 0) await prisma.attendancePunch.createMany({ data: punchRows })

  if (status === 'APPROVED') {
    await prisma.attendanceRecord.createMany({
      data: employees.flatMap((emp, ei) =>
        dates.map((date, di) => ({
          attendanceUploadId: upload.id,
          employeeId: emp.id,
          attendanceDate: utcDate(date),
          regularHours: days[ei][di].reg,
          overtimeHours: days[ei][di].ot,
          sourceSheetName: null,
          sourceEmployeeBlockIndex: null,
        })),
      ),
    })
  }
  return { id: upload.id }
}

/** A legacy Excel-era week: READY, six slot columns filled, no punches. */
export async function seedExcelWeek(opts: {
  weekStartISO?: string
  employees: SeedEmployee[]
  days: DayHours[][]
  fileName?: string
}): Promise<{ id: string; weekStartISO: string }> {
  const weekStartISO = opts.weekStartISO ?? '2025-02-06'
  const dates = weekDatesISO(weekStartISO)
  const upload = await prisma.attendanceUpload.create({
    data: {
      source: 'EXCEL',
      payrollWeekSource: 'SHEET_CONTENT',
      fileName: opts.fileName ?? 'attendance-legacy.xlsx',
      fileType: 'xlsx',
      status: 'READY',
      isActiveForPayrollWeek: true,
      payrollWeekStartDate: utcDate(weekStartISO),
      payrollWeekEndDate: utcDate(dates[6]),
    },
  })
  await prisma.attendanceRecord.createMany({
    data: opts.employees.flatMap((emp, ei) =>
      dates.map((date, di) => {
        const d = opts.days[ei][di]
        const worked = d.reg + d.ot > 0
        return {
          attendanceUploadId: upload.id,
          employeeId: emp.id,
          attendanceDate: utcDate(date),
          regularHours: d.reg,
          overtimeHours: d.ot,
          beforeNoonIn: worked ? '08:00' : null,
          beforeNoonOut: worked ? '12:00' : null,
          afternoonIn: worked ? '13:00' : null,
          afternoonOut: worked ? '17:00' : null,
          overtimeIn: d.ot > 0 ? '17:30' : null,
          overtimeOut: d.ot > 0 ? '19:30' : null,
          sourceSheetName: 'Attendance',
          sourceEmployeeBlockIndex: ei,
        }
      }),
    ),
  })
  return { id: upload.id, weekStartISO }
}

/** A week whose last pull failed and that has no punches: shows "Sync failed". */
export async function seedSyncFailedWeek(weekStartISO: string, error = 'eTimeOffice returned HTTP 500.') {
  const dates = weekDatesISO(weekStartISO)
  return prisma.attendanceUpload.create({
    data: {
      source: 'ETIMEOFFICE',
      payrollWeekSource: 'ETIMEOFFICE',
      fileName: null,
      fileType: null,
      status: 'SYNC_FAILED',
      isActiveForPayrollWeek: true,
      payrollWeekStartDate: utcDate(weekStartISO),
      payrollWeekEndDate: utcDate(dates[6]),
      lastSyncError: error,
      lastSyncAttemptAt: new Date(),
      lastSyncTrigger: 'SCHEDULED',
    },
  })
}

export interface SeededPunch {
  /** The punch after merging; paired with its neighbours in time order. */
  time: string
  /** Scans merged into this one (the "Merged" marker). */
  merged?: string[]
}

export interface ReviewWeekRow {
  /** The employee the code resolved to; null for an unresolved code. */
  employee: SeedEmployee | null
  empCode: string
  empName?: string
  matchStatus?: 'MATCHED' | 'UNKNOWN' | 'DUPLICATE' | 'IGNORED'
  days: Array<{ date: string; punches: SeededPunch[] }>
}

/**
 * A week in REVIEW with explicit punch rows, paired the way the sync does: in time order, an odd
 * punch left as a lone IN (an incomplete pair).
 */
export async function seedReviewWeek(opts: {
  weekStartISO: string
  rows: ReviewWeekRow[]
}): Promise<{ id: string }> {
  const dates = weekDatesISO(opts.weekStartISO)
  const upload = await prisma.attendanceUpload.create({
    data: {
      source: 'ETIMEOFFICE',
      payrollWeekSource: 'ETIMEOFFICE',
      fileName: null,
      fileType: null,
      status: 'REVIEW',
      isActiveForPayrollWeek: true,
      payrollWeekStartDate: utcDate(opts.weekStartISO),
      payrollWeekEndDate: utcDate(dates[6]),
      lastSyncedAt: new Date(`${addDaysISO(opts.weekStartISO, 7)}T01:00:00.000Z`),
      lastSyncTrigger: 'SCHEDULED',
    },
  })

  const data: Array<Record<string, unknown>> = []
  for (const row of opts.rows) {
    for (const day of row.days) {
      const punches = [...day.punches].sort((a, b) => (a.time < b.time ? -1 : 1))
      punches.forEach((punch, i) => {
        data.push({
          attendanceUploadId: upload.id,
          employeeId: row.employee?.id ?? null,
          empCode: row.empCode,
          empName: row.empName ?? `Empname${row.empCode}`,
          matchStatus: row.matchStatus ?? (row.employee ? 'MATCHED' : 'UNKNOWN'),
          punchDate: utcDate(day.date),
          pairIndex: Math.floor(i / 2),
          position: i % 2 === 0 ? 'IN' : 'OUT',
          source: 'API',
          originalTime: punch.time,
          currentTime: punch.time,
          mergedScansJson: punch.merged && punch.merged.length > 0 ? punch.merged : undefined,
          mcid: '1',
        })
      })
    }
  }
  if (data.length > 0) await prisma.attendancePunch.createMany({ data: data as never })
  return { id: upload.id }
}

export async function createEmployee(opts: {
  employeeId: string
  employeeName: string
  isActive?: boolean
  dateOfResignation?: string | null
  weeklySalary?: number
  hourlyRate?: number
}) {
  return prisma.employee.create({
    data: {
      employeeId: opts.employeeId,
      employeeName: opts.employeeName,
      designation: 'Security Guard',
      designationShort: 'Guard',
      site: 'Main Gate',
      isActive: opts.isActive ?? true,
      dateOfResignation: opts.dateOfResignation ? utcDate(opts.dateOfResignation) : null,
      wageHistory: {
        create: {
          weeklySalary: opts.weeklySalary ?? 2500,
          hourlyRate: opts.hourlyRate ?? 62.5,
          effectiveFrom: utcDate('2025-01-01'),
          changeSource: 'SEED',
        },
      },
    },
  })
}

/**
 * Employees for the sync and employee-check specs. Codes: 0001 / 0004 / 0036 active, 0002 inactive,
 * 0003 resigned before any 2026 week, 0007 matches two employees, 1000 needs four digits.
 */
export async function seedEmployeesForSync() {
  const defs = [
    { employeeId: 'TPLGOAHLP001', employeeName: 'Anita Rao' },
    { employeeId: 'TPLGOAHLP002', employeeName: 'Bala Singh', isActive: false },
    { employeeId: 'TPLGOAHLP003', employeeName: 'Chitra Devi', dateOfResignation: '2025-03-01' },
    { employeeId: 'TPLGOAHLP004', employeeName: 'Dev Kapoor' },
    { employeeId: 'TPLGOAHLP007', employeeName: 'Esha Menon' },
    { employeeId: 'TPLGOASUP007', employeeName: 'Farhan Ali' },
    { employeeId: 'TPLGOAHLP036', employeeName: 'Gita Pillai' },
    { employeeId: 'TPLGOAHLP1000', employeeName: 'Hari Prasad' },
  ]
  const created: Record<string, Awaited<ReturnType<typeof createEmployee>>> = {}
  for (const def of defs) created[def.employeeId] = await createEmployee(def)
  return created
}

// ─── F12 verification helpers ─────────────────────────────────────────────────

// Reads retry on the errors the local PGlite database throws when two clients (the app server and
// this test process) talk to it at the same moment. Real Postgres never does this.
const TRANSIENT_DB_ERROR = /bind message supplies|Connection terminated|ECONNRESET|prepared statement/

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!TRANSIENT_DB_ERROR.test((error as Error)?.message ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)))
    }
  }
  throw lastError
}

async function getWeekRowOnce(weekStartISO: string) {
  return prisma.attendanceUpload.findFirst({
    where: { payrollWeekStartDate: utcDate(weekStartISO), isActiveForPayrollWeek: true },
  })
}

/** Live punches of a week (or a correction clone), with the employee's code, ordered by day and slot. */
async function getPunchRowsOnce(
  weekStartISO: string,
  opts: { correctionId?: string | null; employeeCode?: string; empCode?: string; date?: string } = {},
) {
  const week = await getWeekRow(weekStartISO)
  if (!week) return []
  const rows = await prisma.attendancePunch.findMany({
    where: {
      attendanceUploadId: week.id,
      correctionId: opts.correctionId === undefined ? null : opts.correctionId,
      ...(opts.empCode ? { empCode: opts.empCode } : {}),
      ...(opts.date ? { punchDate: utcDate(opts.date) } : {}),
      ...(opts.employeeCode ? { employee: { employeeId: opts.employeeCode } } : {}),
    },
    include: { employee: { select: { employeeId: true } } },
    orderBy: [{ punchDate: 'asc' }, { pairIndex: 'asc' }, { position: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    employeeCode: r.employee?.employeeId ?? null,
    empCode: r.empCode,
    matchStatus: r.matchStatus,
    date: r.punchDate.toISOString().slice(0, 10),
    pairIndex: r.pairIndex,
    position: r.position,
    source: r.source,
    originalTime: r.originalTime,
    currentTime: r.currentTime,
    note: r.note,
    mergedScans: (r.mergedScansJson as string[] | null) ?? [],
  }))
}

async function getAuditRowsOnce(entityType?: string, actionType?: string) {
  return prisma.auditLog.findMany({
    where: { ...(entityType ? { entityType } : {}), ...(actionType ? { actionType } : {}) },
    orderBy: { createdAt: 'asc' },
  })
}

async function getDecisionRowsOnce(weekStartISO: string) {
  const week = await getWeekRow(weekStartISO)
  if (!week) return []
  const rows = await prisma.attendanceEmployeeDecision.findMany({
    where: { attendanceUploadId: week.id },
    include: { employee: { select: { employeeId: true } } },
  })
  return rows.map((r) => ({ employeeCode: r.employee.employeeId, reason: r.reason, decision: r.decision }))
}

async function getCodeExceptionsOnce() {
  const rows = await prisma.attendanceCodeException.findMany({ include: { employee: { select: { employeeId: true } } } })
  return rows.map((r) => ({ empCode: r.empCode, kind: r.kind, employeeCode: r.employee?.employeeId ?? null }))
}

/** AttendanceRecord hours of a week, optionally for one employee. */
async function getAttendanceRecordHoursOnce(weekStartISO: string, employeeCode?: string) {
  const week = await getWeekRow(weekStartISO)
  if (!week) return []
  const rows = await prisma.attendanceRecord.findMany({
    where: { attendanceUploadId: week.id, ...(employeeCode ? { employee: { employeeId: employeeCode } } : {}) },
    include: { employee: { select: { employeeId: true } } },
    orderBy: [{ attendanceDate: 'asc' }],
  })
  return rows.map((r) => ({
    employeeCode: r.employee.employeeId,
    date: r.attendanceDate.toISOString().slice(0, 10),
    regularHours: Number(r.regularHours),
    overtimeHours: Number(r.overtimeHours),
  }))
}

async function getRevisionsOnce(payrollRunId: string) {
  const rows = await prisma.payrollRevision.findMany({ where: { payrollRunId }, orderBy: { revisionNumber: 'asc' } })
  return rows.map((r) => ({
    id: r.id,
    revisionNumber: r.revisionNumber,
    status: r.status,
    isCurrent: r.isCurrent,
    correctionReason: r.correctionReason,
    netPayable: Number(r.totalNetPayable),
  }))
}

async function getRevisionEmployeesOnce(revisionId: string) {
  const rows = await prisma.payrollRunEmployee.findMany({
    where: { payrollRevisionId: revisionId },
    include: { employee: { select: { employeeId: true } } },
  })
  return rows.map((r) => ({
    employeeCode: r.employee.employeeId,
    regularHours: Number(r.regularHours),
    overtimeHours: Number(r.overtimeHours),
    netPayable: Number(r.netPayable),
  }))
}

async function getCorrectionSessionsOnce(payrollRunId: string) {
  return prisma.payrollCorrectionSession.findMany({ where: { payrollRunId }, orderBy: { createdAt: 'asc' } })
}

export const getWeekRow = (...args: Parameters<typeof getWeekRowOnce>) => withRetry(() => getWeekRowOnce(...args))
export const getPunchRows = (...args: Parameters<typeof getPunchRowsOnce>) => withRetry(() => getPunchRowsOnce(...args))
export const getAuditRows = (...args: Parameters<typeof getAuditRowsOnce>) => withRetry(() => getAuditRowsOnce(...args))
export const getDecisionRows = (...args: Parameters<typeof getDecisionRowsOnce>) => withRetry(() => getDecisionRowsOnce(...args))
export const getCodeExceptions = (...args: Parameters<typeof getCodeExceptionsOnce>) => withRetry(() => getCodeExceptionsOnce(...args))
export const getAttendanceRecordHours = (...args: Parameters<typeof getAttendanceRecordHoursOnce>) => withRetry(() => getAttendanceRecordHoursOnce(...args))
export const getRevisions = (...args: Parameters<typeof getRevisionsOnce>) => withRetry(() => getRevisionsOnce(...args))
export const getRevisionEmployees = (...args: Parameters<typeof getRevisionEmployeesOnce>) => withRetry(() => getRevisionEmployeesOnce(...args))
export const getCorrectionSessions = (...args: Parameters<typeof getCorrectionSessionsOnce>) => withRetry(() => getCorrectionSessionsOnce(...args))

export async function seedAdjustmentTestData() {
  try {
    await prisma.$connect();

    // Create a test employee for adjustment flows
    const employee = await prisma.employee.create({
      data: {
        employeeId: 'EMP-ADJ-001',
        employeeName: 'Adjustment Test Employee',
        designation: 'Worker',
        isActive: true,
        wageHistory: {
          create: {
            weeklySalary: 6000,
            hourlyRate: 120,
            effectiveFrom: new Date('2025-01-01'),
            changeSource: 'SEED',
          },
        },
      },
    });

    // Create 3 test adjustments (2 active, 1 completed)
    const week1Start = new Date('2025-03-06');
    const week1End = new Date('2025-03-12');
    const week2Start = new Date('2025-03-13');
    const week2End = new Date('2025-03-19');

    // Adjustment 1: ONE_TIME DEDUCTION (active, pending)
    const adj1 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'ONE_TIME',
        amount: 500,
        reason: 'Advance recovery seed',
        startPayrollWeekStartDate: week1Start,
        startPayrollWeekEndDate: week1End,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj1.id,
        employeeId: employee.id,
        payrollWeekStartDate: week1Start,
        payrollWeekEndDate: week1End,
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    });

    // Adjustment 2: RECURRING ADDITION (active)
    const adj2 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'ADDITION',
        recurrenceType: 'RECURRING',
        amount: 1000,
        reason: 'Transport allowance seed',
        startPayrollWeekStartDate: week1Start,
        startPayrollWeekEndDate: week1End,
        recurrenceEndType: 'FIXED_WEEKS',
        totalRecurrenceWeeks: 4,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj2.id,
        employeeId: employee.id,
        payrollWeekStartDate: week1Start,
        payrollWeekEndDate: week1End,
        appliedAmount: 1000,
        approvalStatus: 'APPROVED',
        appliedAt: new Date('2025-03-12'),
      },
    });

    // Adjustment 3: RECURRING DEDUCTION with total balance (completed)
    const adj3 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'RECURRING',
        amount: 2000,
        reason: 'Loan recovery seed',
        startPayrollWeekStartDate: week2Start,
        startPayrollWeekEndDate: week2End,
        recurrenceEndType: 'TOTAL_BALANCE',
        totalBalance: 2000,
        remainingBalance: 0,
        status: 'COMPLETED',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj3.id,
        employeeId: employee.id,
        payrollWeekStartDate: week2Start,
        payrollWeekEndDate: week2End,
        appliedAmount: 2000,
        approvalStatus: 'APPROVED',
        appliedAt: new Date('2025-03-19'),
      },
    });
  } catch (err) {
    console.error('Adjustment seed failed:', err);
    throw err;
  }
}

// ─── seedPayrollTestData ──────────────────────────────────────────────────────
// Seeds a minimal but complete scenario for F06 E2E tests:
//   - 3 employees with wage history
//   - 1 READY AttendanceUpload for March 6-12 with daily records
//   - 1 ERRORS AttendanceUpload for March 13-19 (blocked)
//   - 1 pending adjustment application for March 6-12

export async function seedPayrollTestData() {
  try {
    await prisma.$connect();

    const weekStart = new Date('2025-03-06T00:00:00.000Z');
    const weekEnd   = new Date('2025-03-12T00:00:00.000Z');
    const errWeekStart = new Date('2025-03-13T00:00:00.000Z');
    const errWeekEnd   = new Date('2025-03-19T00:00:00.000Z');

    // ── Employees ──────────────────────────────────────────────────────────
    const employees = await Promise.all([
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-001',
          employeeName: 'Kavitha Rajan',
          designation: 'Security Guard',
          designationShort: 'Guard',
          site: 'North Gate',
          gPay: '9876543210',
          bankAccount: '012345678901',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 2500,
              hourlyRate: 62.5,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-002',
          employeeName: 'Ramesh Nair',
          designation: 'Supervisor',
          designationShort: 'Supv.',
          site: 'South Gate',
          gPay: '9123456780',
          bankAccount: '098765432109',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 3000,
              hourlyRate: 75.0,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-003',
          employeeName: 'Sunita Pillai',
          designation: 'Security Guard',
          designationShort: 'Guard',
          site: 'East Gate',
          gPay: null,
          bankAccount: null,
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 2500,
              hourlyRate: 62.5,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
    ]);

    // ── Approved eTimeOffice week for March 6-12 ───────────────────────────
    // Daily hours for each employee (Thu–Wed = 7 days); each worked day gets one punch pair
    // from 08:00 that produces exactly those hours.
    // Employee 1: reg=[8,8,6,0,8,8,8], OT=[2,0,0,0,3,1,0] → reg=46, OT=6
    // Employee 2: reg=[8,8,8,8,8,8,8], OT=[0,0,0,0,0,0,0] → reg=56, OT=0
    // Employee 3: reg=[8,8,8,0,8,8,8], OT=[0,0,0,0,0,0,0] → reg=48, OT=0
    const attendanceDays: DayHours[][] = [
      [{ reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 }],
      [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
      [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
    ];
    const readyUpload = await seedApiWeek({
      weekStartISO: '2025-03-06',
      employees: employees,
      days: attendanceDays,
      status: 'APPROVED',
    });

    // ── Pending adjustment for Employee 1 in week 1 ───────────────────────
    const adj = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employees[0].id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'ONE_TIME',
        amount: 500,
        reason: 'Advance recovery',
        startPayrollWeekStartDate: weekStart,
        startPayrollWeekEndDate: weekEnd,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj.id,
        employeeId: employees[0].id,
        payrollWeekStartDate: weekStart,
        payrollWeekEndDate: weekEnd,
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    });

    // ── Loaded but not approved week for March 13-19 (blocks payroll) ──────
    await seedApiWeek({
      weekStartISO: '2025-03-13',
      employees: employees,
      days: attendanceDays,
      status: 'REVIEW',
    });

    return { employees, readyUpload };
  } catch (err) {
    console.error('Payroll seed failed:', err);
    throw err;
  }
}

// ─── seedApprovedPayrollData ──────────────────────────────────────────────────
// Seeds a complete approved payroll scenario for F07 E2E tests:
//   - 2 employees with wage history and attendance records
//   - 1 APPROVED PayrollRun + PayrollRevision + PayrollRunEmployee records
//   - Attendance records for 7 days (for daily slip breakdown)

export async function seedApprovedPayrollData(
  opts: { source?: 'ETIMEOFFICE' | 'EXCEL'; weekStartISO?: string } = {},
): Promise<{ payrollRunId: string; weekStartISO: string }> {
  await prisma.$connect();

  const source = opts.source ?? 'ETIMEOFFICE';
  const weekStartISO = opts.weekStartISO ?? '2025-04-03';
  const weekStart = new Date(`${weekStartISO}T00:00:00.000Z`);
  const weekEnd   = new Date(`${addDaysISO(weekStartISO, 6)}T00:00:00.000Z`);
  const approvedAt = new Date(`${addDaysISO(weekStartISO, 7)}T08:00:00.000Z`);

  const emp1 = await prisma.employee.create({
    data: {
      employeeId: 'EMP-RPT-001',
      employeeName: 'Meera Krishnan',
      designation: 'Security Guard',
      designationShort: 'Guard',
      site: 'Main Gate',
      gPay: '9988776655',
      bankAccount: '123456789012',
      isActive: true,
      wageHistory: {
        create: {
          weeklySalary: 2500,
          hourlyRate: 62.5,
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
          changeSource: 'SEED',
        },
      },
    },
  });

  const emp2 = await prisma.employee.create({
    data: {
      employeeId: 'EMP-RPT-002',
      employeeName: 'Vijay Kumar',
      designation: 'Supervisor',
      designationShort: 'Supv.',
      site: 'Back Gate',
      gPay: '9876543212',
      bankAccount: '987654321098',
      isActive: true,
      wageHistory: {
        create: {
          weeklySalary: 3000,
          hourlyRate: 75.0,
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
          changeSource: 'SEED',
        },
      },
    },
  });

  // emp1: reg=[8,8,6,0,8,8,8] ot=[2,0,0,0,3,1,0] → reg=46, ot=6
  // emp2: reg=[8,8,8,8,8,8,8] ot=[0,0,0,0,0,0,0] → reg=56, ot=0
  const attendanceDays: DayHours[][] = [
    [{ reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 }],
    [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
  ];
  const employees = [emp1, emp2];

  // The approved attendance the payroll was generated from: an eTimeOffice week with punches
  // (the slips show a Punches column), or a legacy Excel week (the slips keep six columns).
  if (source === 'EXCEL') {
    await seedExcelWeek({ weekStartISO, employees, days: attendanceDays, fileName: 'attendance-apr-wk1.xlsx' });
  } else {
    await seedApiWeek({ weekStartISO, employees, days: attendanceDays, status: 'APPROVED' });
  }

  // emp1: reg=46h × Rs.62.5 = 2875, ot=6h × Rs.62.5 = 375, ded=500 → net=2750
  // emp2: reg=56h × Rs.75  = 4200, ot=0                    , ded=0   → net=4200
  const run = await prisma.payrollRun.create({
    data: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate:   weekEnd,
      status: 'APPROVED',
      currentRevisionNumber: 1,
      totalRegularPay:  7075,
      totalOvertimePay: 375,
      totalAdditions:   0,
      totalDeductions:  500,
      totalNetPayable:  6950,
      approvedAt,
    },
  });

  const revision = await prisma.payrollRevision.create({
    data: {
      payrollRunId: run.id,
      revisionNumber: 1,
      status: 'APPROVED',
      isCurrent: true,
      totalRegularPay:  7075,
      totalOvertimePay: 375,
      totalAdditions:   0,
      totalDeductions:  500,
      totalNetPayable:  6950,
      approvedAt,
    },
  });

  const payrollEmployeeData = [
    { emp: emp1, weeklySalary: 2500, hourlyRate: 62.5, regularHours: 46, overtimeHours: 6, regularPay: 2875, overtimePay: 375, additions: 0, deductions: 500, netPayable: 2750 },
    { emp: emp2, weeklySalary: 3000, hourlyRate: 75,   regularHours: 56, overtimeHours: 0, regularPay: 4200, overtimePay: 0,   additions: 0, deductions: 0,   netPayable: 4200 },
  ];

  await prisma.payrollRunEmployee.createMany({
    data: payrollEmployeeData.map(pd => ({
      payrollRunId:      run.id,
      payrollRevisionId: revision.id,
      employeeId:        pd.emp.id,
      weeklySalaryUsed:  pd.weeklySalary,
      hourlyRateUsed:    pd.hourlyRate,
      regularHours:      pd.regularHours,
      overtimeHours:     pd.overtimeHours,
      regularPay:        pd.regularPay,
      overtimePay:       pd.overtimePay,
      additions:         pd.additions,
      deductions:        pd.deductions,
      netPayable:        pd.netPayable,
    }))
  });

  return { payrollRunId: run.id, weekStartISO };
}

// ─── DB verification helpers ──────────────────────────────────────────────────

export async function getInvoiceSnapshotCount(payrollRunId: string): Promise<number> {
  await prisma.$connect();
  return prisma.invoiceSnapshot.count({ where: { payrollRunId } });
}

export async function getCleanedSnapshotCount(payrollRunId: string): Promise<number> {
  await prisma.$connect();
  return prisma.invoiceSnapshot.count({
    where: { payrollRunId, temporaryFileDeletedAt: { not: null } },
  });
}

export async function seedTestData() {
  try {
    // We use a transaction for seeding to ensure atomicity
    await prisma.$transaction([
      prisma.employee.create({
        data: {
          employeeId: 'EMP001',
          employeeName: 'Matched Employee',
          designation: 'Worker',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP002',
          employeeName: 'Inactive Employee',
          designation: 'Worker',
          isActive: false,
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP003',
          employeeName: 'Resigned Employee',
          designation: 'Worker',
          isActive: true,
          dateOfResignation: new Date('2025-03-01'),
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
    ]);
  } catch (err) {
    console.error('Seed failed:', err);
    throw err;
  }
}

// ─── seedApprovedPayrollForCorrection ─────────────────────────────────────────
// Seeds a complete approved payroll scenario for F08 correction E2E tests using raw SQL:
//   - 2 employees with wage history + attendance records
//   - 1 APPROVED PayrollRun + PayrollRevision (revision 1) + PayrollRunEmployee records
//   - 1 approved deduction adjustment application

export async function seedApprovedPayrollForCorrection(): Promise<{
  payrollRunId: string;
  revisionId: string;
  employeeIds: string[];
  adjustmentApplicationId: string;
  weekStartISO: string;
  uploadId: string;
}> {
  const client = {
    query: async (sql: string, params: any[] = []) => {
      await prisma.$executeRawUnsafe(sql, ...params);
    }
  };

  const weekStart = '2025-04-17T00:00:00.000Z'
  const weekEnd   = '2025-04-23T00:00:00.000Z'
  const approvedAt = '2025-04-24T08:00:00.000Z'
  const wageEffective = '2025-01-01T00:00:00.000Z'

  // Use crypto.randomUUID for IDs
  const emp1Id = crypto.randomUUID()
  const emp2Id = crypto.randomUUID()
  const wage1Id = crypto.randomUUID()
  const wage2Id = crypto.randomUUID()
  const uploadId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const adjId = crypto.randomUUID()
  const adjAppId = crypto.randomUUID()

  // Create employees
  await client.query(
    `INSERT INTO "Employee" (id, "employeeId", "employeeName", designation, "designationShort", site, "gPay", "bankAccount", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW()),
            ($9, $10, $11, $12, $13, $14, $15, $16, true, NOW(), NOW())`,
    [
      emp1Id, 'EMP-COR-001', 'Anita Sharma', 'Security Guard', 'Guard', 'North Gate', '9876543210', '112233445566',
      emp2Id, 'EMP-COR-002', 'Rajesh Iyer', 'Supervisor', 'Supv.', 'South Gate', '9123456780', '665544332211',
    ]
  )

  // Create wage history
  await client.query(
    `INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "changeSource", "createdAt")
     VALUES ($1, $2, 2500.00, 62.50, $3, 'SEED', NOW()),
            ($4, $5, 3000.00, 75.00, $6, 'SEED', NOW())`,
    [wage1Id, emp1Id, wageEffective, wage2Id, emp2Id, wageEffective]
  )

  // Create the approved eTimeOffice week the payroll was generated from
  await client.query(
    `INSERT INTO "AttendanceUpload" (id, "fileName", "fileType", "payrollWeekStartDate", "payrollWeekEndDate", "payrollWeekSource", source, status, "isActiveForPayrollWeek", "uploadedAt", "lastSyncedAt", "lastSyncTrigger", "approvedAt")
     VALUES ($1, NULL, NULL, $2, $3, 'ETIMEOFFICE', 'ETIMEOFFICE', 'APPROVED', true, NOW(), $4, 'SCHEDULED', $4)`,
    [uploadId, weekStart, weekEnd, approvedAt]
  )

  // Create attendance records
  // emp1: reg=[8,8,6,0,8,8,8]=46h, ot=[2,0,0,0,3,1,0]=6h
  // emp2: reg=[8,8,8,8,8,8,8]=56h, ot=[0,0,0,0,0,0,0]=0h
  const emp1Days = [
    { reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 },
    { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 },
  ]
  const emp2Days = [
    { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 },
    { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 },
  ]

  const values: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  for (const [empId, days] of [[emp1Id, emp1Days], [emp2Id, emp2Days]] as const) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart)
      date.setUTCDate(date.getUTCDate() + day)
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`)
      params.push(crypto.randomUUID(), uploadId, empId, date.toISOString(), days[day].reg, days[day].ot)
    }
  }

  await client.query(
    `INSERT INTO "AttendanceRecord" (id, "attendanceUploadId", "employeeId", "attendanceDate", "regularHours", "overtimeHours")
     VALUES ${values.join(', ')}`,
    params
  )

  // Matching live punches: one pair per worked day that produces exactly those hours
  const correctionEmployees = [
    { id: emp1Id, employeeId: 'EMP-COR-001', employeeName: 'Anita Sharma', days: emp1Days },
    { id: emp2Id, employeeId: 'EMP-COR-002', employeeName: 'Rajesh Iyer', days: emp2Days },
  ]
  const punchRows = correctionEmployees.flatMap((emp) =>
    emp.days.flatMap((d, dayIndex) =>
      punchRowsForHours(uploadId, emp, addDaysISO('2025-04-17', dayIndex), d),
    ),
  )
  await prisma.attendancePunch.createMany({ data: punchRows })

  // Create payroll run
  // emp1: reg=46×62.5=2875, ot=6×62.5=375, ded=500 → net=2750
  // emp2: reg=56×75=4200, ot=0 → net=4200
  await client.query(
    `INSERT INTO "PayrollRun" (id, "payrollWeekStartDate", "payrollWeekEndDate", status, "currentRevisionNumber",
     "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable", "approvedAt", "generatedAt")
     VALUES ($1, $2, $3, 'APPROVED', 1, 7075.00, 375.00, 0.00, 500.00, 6950.00, $4, NOW())`,
    [runId, weekStart, weekEnd, approvedAt]
  )

  // Create payroll revision
  await client.query(
    `INSERT INTO "PayrollRevision" (id, "payrollRunId", "revisionNumber", status, "isCurrent",
     "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable",
     "approvedAt", "generatedAt")
     VALUES ($1, $2, 1, 'APPROVED', true, 7075.00, 375.00, 0.00, 500.00, 6950.00, $3, $4)`,
    [revisionId, runId, approvedAt, approvedAt]
  )

  // Create payroll run employees
  await client.query(
    `INSERT INTO "PayrollRunEmployee" (id, "payrollRunId", "payrollRevisionId", "employeeId",
     "weeklySalaryUsed", "hourlyRateUsed", "regularHours", "overtimeHours",
     "regularPay", "overtimePay", additions, deductions, "netPayable")
     VALUES ($1, $2, $3, $4, 2500.00, 62.50, 46, 6, 2875.00, 375.00, 0.00, 500.00, 2750.00),
            ($5, $6, $7, $8, 3000.00, 75.00, 56, 0, 4200.00, 0.00, 0.00, 0.00, 4200.00)`,
    [
      crypto.randomUUID(), runId, revisionId, emp1Id,
      crypto.randomUUID(), runId, revisionId, emp2Id,
    ]
  )

  // Adjustment: ₹500 deduction for emp1 (approved)
  await client.query(
    `INSERT INTO "PayrollAdjustment" (id, "employeeId", "adjustmentType", "recurrenceType",
     amount, reason, "startPayrollWeekStartDate", "startPayrollWeekEndDate", status, "skippedCarryForwardCount", "createdAt")
     VALUES ($1, $2, 'DEDUCTION', 'ONE_TIME', 500.00, 'Advance recovery seed', $3, $4, 'ACTIVE', 0, NOW())`,
    [adjId, emp1Id, weekStart, weekEnd]
  )

  await client.query(
    `INSERT INTO "PayrollAdjustmentApplication" (id, "payrollAdjustmentId", "employeeId",
     "payrollRunId", "payrollWeekStartDate", "payrollWeekEndDate",
     "appliedAmount", "approvalStatus", "appliedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 500.00, 'APPROVED', $7)`,
    [adjAppId, adjId, emp1Id, runId, weekStart, weekEnd, approvedAt]
  )

  return {
    payrollRunId: runId,
    revisionId: revisionId,
    employeeIds: [emp1Id, emp2Id],
    adjustmentApplicationId: adjAppId,
    weekStartISO: '2025-04-17',
    uploadId,
  }
}

// ─── F08 verification helpers ─────────────────────────────────────────────────

export async function getRevisionCount(payrollRunId: string): Promise<number> {
  const result = await prisma.$queryRawUnsafe<any[]>(
    'SELECT COUNT(*) as cnt FROM "PayrollRevision" WHERE "payrollRunId" = $1',
    payrollRunId
  )
  return parseInt(result[0]?.cnt?.toString() ?? '0', 10)
}

export async function getCurrentRevision(payrollRunId: string) {
  const result = await prisma.$queryRawUnsafe<any[]>(
    'SELECT * FROM "PayrollRevision" WHERE "payrollRunId" = $1 AND "isCurrent" = true LIMIT 1',
    payrollRunId
  )
  return result[0] ?? null
}

export async function getPayrollRunStatus(payrollRunId: string) {
  const result = await prisma.$queryRawUnsafe<any[]>(
    'SELECT status FROM "PayrollRun" WHERE id = $1',
    payrollRunId
  )
  return result[0]?.status ?? null
}
