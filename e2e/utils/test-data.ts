import { expectedCompletedWeek } from './etimeoffice-mock'
import { PRE_HISTORY_END, TEST_EMPLOYEE_PREFIX } from './test-namespace'

// Deleting the test namespace, and nothing else. Used by the global setup (to clear the reserved weeks out of
// the real-data base), by every spec's cleanup, and by the global teardown. It runs through any executor, so
// the setup can use a plain pg client and the specs the shared Prisma client.

export type SqlExecutor = (sql: string, params: unknown[]) => Promise<unknown>

/**
 * The first reserved week: the last completed Thursday-Wednesday week, from the real clock (IST). The current
 * week and everything after it is reserved too. The cron and Pull now specs target exactly these two weeks.
 */
export function computeReservedFrom(now: Date = new Date()): string {
  return expectedCompletedWeek(now).start
}

/** The reserved start this run uses: what global setup fixed (so every process agrees), else the clock's. */
export function reservedFromISO(): string {
  return process.env.E2E_RESERVED_FROM || computeReservedFrom()
}

const TEST_EMPLOYEE = `"employeeId" IN (SELECT id FROM "Employee" WHERE "employeeId" LIKE '${TEST_EMPLOYEE_PREFIX}%')`

/** SQL for "this week date is in the test namespace": before the real data, or in a reserved/future week. */
function inWeekZone(column: string): string {
  return `(${column} < $1::timestamp OR ${column} >= $2::timestamp)`
}

const UPLOAD_IN_ZONE = `"attendanceUploadId" IN (SELECT id FROM "AttendanceUpload" WHERE ${inWeekZone('"payrollWeekStartDate"')})`
const RUN_IN_ZONE = `"payrollRunId" IN (SELECT id FROM "PayrollRun" WHERE ${inWeekZone('"payrollWeekStartDate"')})`

/**
 * The delete statements, children before parents. $1 = end of the pre-history zone, $2 = first reserved week.
 * A row is deleted when it belongs to a test employee or sits in a test week; the real base has neither.
 */
export const NAMESPACE_DELETES: string[] = [
  `DELETE FROM "AttendancePunch" WHERE ${UPLOAD_IN_ZONE} OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "PayrollCorrectionSession" WHERE ${RUN_IN_ZONE} OR ${UPLOAD_IN_ZONE}`,
  `DELETE FROM "AttendanceEmployeeDecision" WHERE ${UPLOAD_IN_ZONE} OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "AttendanceCodeException" WHERE "empCode" ~ '^9[0-9]{3}$' OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "InvoiceSnapshot" WHERE ${RUN_IN_ZONE} OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "PayrollRunEmployee" WHERE ${RUN_IN_ZONE} OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "PayrollAdjustmentApplication" WHERE ${RUN_IN_ZONE} OR ${TEST_EMPLOYEE} OR ${inWeekZone('"payrollWeekStartDate"')}`,
  `DELETE FROM "PayrollRevision" WHERE ${RUN_IN_ZONE}`,
  `DELETE FROM "PayrollAdjustment" WHERE ${TEST_EMPLOYEE} OR ${inWeekZone('"startPayrollWeekStartDate"')}`,
  `DELETE FROM "PayrollRun" WHERE ${inWeekZone('"payrollWeekStartDate"')}`,
  `DELETE FROM "AttendanceRecord" WHERE ${UPLOAD_IN_ZONE} OR ${TEST_EMPLOYEE}`,
  `DELETE FROM "AttendanceUpload" WHERE ${inWeekZone('"payrollWeekStartDate"')}`,
  `DELETE FROM "EmployeeWageHistory" WHERE ${TEST_EMPLOYEE}`,
  `DELETE FROM "EmployeeDocument" WHERE ${TEST_EMPLOYEE}`,
  `DELETE FROM "Employee" WHERE "employeeId" LIKE '${TEST_EMPLOYEE_PREFIX}%'`,
]

/**
 * Delete the test namespace: every test employee and everything in the test week zones, plus (when given) the
 * audit rows written since the run started. The audit log is append-only and has no week or employee column,
 * so "written during this run" is how its rows are told apart from the base's history.
 */
export async function deleteTestNamespace(
  exec: SqlExecutor,
  opts: { reservedFrom?: string; auditSince?: string | null } = {},
): Promise<void> {
  const params = [PRE_HISTORY_END, opts.reservedFrom ?? reservedFromISO()]
  // Postgres rejects bind parameters a statement does not use, so only the statements that filter by week get them
  for (const sql of NAMESPACE_DELETES) await exec(sql, sql.includes('$1') ? params : [])
  // The column is a UTC "timestamp without time zone"; casting the ISO string drops its Z, which is exactly that.
  if (opts.auditSince) await exec(`DELETE FROM "AuditLog" WHERE "createdAt" >= $1::timestamp`, [opts.auditSince])
}
