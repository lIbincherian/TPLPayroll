import fs from 'fs'
import path from 'path'

// What the real-data specs expect, derived from the production snapshot files at run time. Nothing in the specs
// is hard-coded: not a name, an ID, a count or an amount. A refreshed snapshot changes the expectations, never
// the specs. These files hold real names and pay: never log what they return, and never put it in a test title.

const DIR = path.resolve(__dirname, '..', 'prod-snapshot')

export function snapshotAvailable(): boolean {
  return fs.existsSync(path.join(DIR, 'manifest.json'))
}

/** True when the snapshot exists and global setup loaded it as the base of this run. */
export function realDataLoaded(): boolean {
  return snapshotAvailable() && process.env.E2E_BASE_KIND === 'real-data'
}

const cache = new Map<string, unknown[]>()

/** The rows of one snapshot table (parsed once per worker). */
// A snapshot row is whatever the production table held; the callers read the few columns they need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function snapshotRows<T = Record<string, any>>(table: string): T[] {
  let rows = cache.get(table)
  if (!rows) {
    rows = (JSON.parse(fs.readFileSync(path.join(DIR, `${table}.json`), 'utf8')) as { rows: unknown[] }).rows
    cache.set(table, rows)
  }
  return rows as T[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * Global setup deletes the base's rows for the reserved weeks (the last completed week onward: the cron and
 * Pull now specs own them). A week in the snapshot from that date on is not in the database, so not expected.
 */
export const isReal = (weekStart: string): boolean => !process.env.E2E_RESERVED_FROM || weekStart < process.env.E2E_RESERVED_FROM

/** "2026-09-03 00:00:00" -> "2026-09-03". */
export const isoDay = (timestamp: string): string => timestamp.slice(0, 10)

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

export interface SnapshotRun {
  id: string
  weekStart: string
  weekEnd: string
  status: string
  currentRevisionId: string | null
  /** Payroll employees of the current revision: the rows the history page and the slips are made from. */
  currentEmployeeCount: number
  currentNetTotal: number
}

/** Every approved or revised payroll run, newest week first. */
export function approvedRuns(): SnapshotRun[] {
  const revisions = snapshotRows<Row>('PayrollRevision')
  const employees = snapshotRows<Row>('PayrollRunEmployee')
  const currentByRun = new Map<string, Row>()
  for (const r of revisions) if (r.isCurrent && r.status === 'APPROVED') currentByRun.set(r.payrollRunId, r)

  const countByRevision = new Map<string, number>()
  for (const e of employees) countByRevision.set(e.payrollRevisionId, (countByRevision.get(e.payrollRevisionId) ?? 0) + 1)

  return snapshotRows<Row>('PayrollRun')
    .filter((run) => (run.status === 'APPROVED' || run.status === 'REVISED') && isReal(isoDay(run.payrollWeekStartDate)))
    .map((run) => {
      const current = currentByRun.get(run.id) ?? null
      return {
        id: run.id as string,
        weekStart: isoDay(run.payrollWeekStartDate),
        weekEnd: isoDay(run.payrollWeekEndDate),
        status: run.status as string,
        currentRevisionId: (current?.id as string | undefined) ?? null,
        currentEmployeeCount: current ? (countByRevision.get(current.id) ?? 0) : 0,
        currentNetTotal: current ? Number(current.totalNetPayable) : 0,
      }
    })
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
}

/** The total the dashboard's "Latest Payroll Total" card shows: the newest-approved current revision. */
export function latestPayrollTotal(): number {
  const runs = new Map(
    snapshotRows<Row>('PayrollRun')
      .filter((r) => isReal(isoDay(r.payrollWeekStartDate)))
      .map((r) => [r.id as string, r]),
  )
  const candidates = snapshotRows<Row>('PayrollRevision').filter((rev) => {
    const run = runs.get(rev.payrollRunId)
    return rev.isCurrent && rev.status === 'APPROVED' && run && (run.status === 'APPROVED' || run.status === 'REVISED')
  })
  candidates.sort((a, b) => ((a.approvedAt ?? '') < (b.approvedAt ?? '') ? 1 : -1))
  return candidates.length > 0 ? Number(candidates[0].totalNetPayable) : 0
}

export function pendingAdjustmentApplications(): number {
  return snapshotRows<Row>('PayrollAdjustmentApplication').filter(
    (a) => a.approvalStatus === 'PENDING' && isReal(isoDay(a.payrollWeekStartDate)),
  ).length
}

// ─── Attendance weeks ─────────────────────────────────────────────────────────

export interface SnapshotWeek {
  uploadId: string
  weekStart: string
  weekEnd: string
  fileName: string | null
}

/**
 * The active attendance weeks, newest first. Every week in a production snapshot taken before the F12 release is
 * an Excel-era week (the column `source` did not exist yet; the loader defaults it to EXCEL).
 */
export function activeWeeks(): SnapshotWeek[] {
  return snapshotRows<Row>('AttendanceUpload')
    .filter((u) => u.isActiveForPayrollWeek && isReal(isoDay(u.payrollWeekStartDate)))
    .map((u) => ({
      uploadId: u.id as string,
      weekStart: isoDay(u.payrollWeekStartDate),
      weekEnd: isoDay(u.payrollWeekEndDate),
      fileName: (u.fileName as string | null) ?? null,
    }))
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
}

export interface WeekHours {
  employees: number
  regular: number
  overtime: number
}

/** Distinct employees and hours in one week's attendance records (reads the large AttendanceRecord table). */
export function weekHours(uploadId: string): WeekHours {
  const employees = new Set<string>()
  let regular = 0
  let overtime = 0
  for (const r of snapshotRows<Row>('AttendanceRecord')) {
    if (r.attendanceUploadId !== uploadId) continue
    employees.add(r.employeeId)
    regular += Number(r.regularHours)
    overtime += Number(r.overtimeHours)
  }
  return { employees: employees.size, regular, overtime }
}

// ─── Employees ────────────────────────────────────────────────────────────────

export interface EmployeeTotals {
  total: number
  /** The dashboard's "Active Team Members": isActive, whatever the resignation date. */
  activeFlag: number
  /** The directory's status filter: ACTIVE = isActive and not resigned; INACTIVE = not active, not resigned. */
  active: number
  inactive: number
  resigned: number
}

export function employeeTotals(): EmployeeTotals {
  const employees = snapshotRows<Row>('Employee')
  const resigned = employees.filter((e) => e.dateOfResignation != null).length
  return {
    total: employees.length,
    activeFlag: employees.filter((e) => e.isActive).length,
    active: employees.filter((e) => e.isActive && e.dateOfResignation == null).length,
    inactive: employees.filter((e) => !e.isActive && e.dateOfResignation == null).length,
    resigned,
  }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

/** Row counts per "ENTITY/ACTION" pair, and per entity and per action. */
export function auditCounts(): { total: number; byPair: Map<string, number> } {
  const byPair = new Map<string, number>()
  const rows = snapshotRows<Row>('AuditLog')
  for (const r of rows) byPair.set(`${r.entityType}/${r.actionType}`, (byPair.get(`${r.entityType}/${r.actionType}`) ?? 0) + 1)
  return { total: rows.length, byPair }
}
