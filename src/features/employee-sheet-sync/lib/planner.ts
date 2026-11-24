import { createHash } from 'crypto'
import { trailingNumber } from '@/features/attendance-sync/lib/matching'
import { isWageEffectiveTooFarAhead } from '@/features/employee-management/lib/wage-effective-from'
import type {
  EmployeeSnapshot,
  FieldChange,
  ParsedRow,
  ParseResult,
  PlannedCreate,
  PlannedSkip,
  PlannedUpdate,
  RowWarning,
  SheetOwnedField,
  SkipReason,
  SyncPlan,
} from '../types/employee-sheet-sync.types'

const SALARY_TOLERANCE = 0.005

const REQUIRED_LABELS: Record<string, string> = {
  employeeName: 'Employee Name',
  designation: 'Designation',
  salary: 'Salary',
  dateOfJoining: 'Date of Joining',
}

const ID_HINT =
  "The sheet's Employee ID is #N/A or blank. It comes from the sheet's designation lookup, so add the designation there."

function skip(row: ParsedRow, reason: SkipReason, detail?: string): PlannedSkip {
  return {
    rowNumber: row.rowNumber,
    srRaw: row.srRaw,
    employeeIdRaw: row.employeeIdRaw,
    name: row.fields.employeeName ?? null,
    reason,
    ...(detail ? { detail } : {}),
  }
}

function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

function planUpdate(
  row: ParsedRow,
  employee: EmployeeSnapshot,
  presentFields: SheetOwnedField[],
): PlannedUpdate {
  const changes: FieldChange[] = []
  for (const field of presentFields) {
    if (!(field in row.fields)) continue // unreadable value: left unchanged (a warning explains)
    const next = row.fields[field] ?? null
    const old = employee.fields[field] ?? null
    if (!sameValue(old, next)) changes.push({ field, old, new: next })
  }
  return {
    rowNumber: row.rowNumber,
    employeeDbId: employee.id,
    employeeId: employee.employeeId,
    employeeName: employee.employeeName,
    changes,
    warnings: row.warnings,
  }
}

function existingWarnings(row: ParsedRow, employee: EmployeeSnapshot): RowWarning[] {
  const warnings: RowWarning[] = []
  const sheetSalary = row.salary.value
  if (sheetSalary !== null && (employee.openWage === null || Math.abs(sheetSalary - employee.openWage) > SALARY_TOLERANCE)) {
    warnings.push({
      kind: 'SALARY_MISMATCH',
      rowNumber: row.rowNumber,
      employeeId: employee.employeeId,
      sheet: sheetSalary,
      app: employee.openWage,
    })
  }
  if (row.active.value !== null && row.active.value !== employee.isActive) {
    warnings.push({
      kind: 'STATUS_MISMATCH',
      rowNumber: row.rowNumber,
      employeeId: employee.employeeId,
      sheet: row.active.value,
      app: employee.isActive,
    })
  }
  return warnings
}

function fieldWarnings(row: ParsedRow, employeeId: string | null): RowWarning[] {
  return row.warnings.map((warning) => ({ kind: 'FIELD' as const, rowNumber: row.rowNumber, employeeId, warning }))
}

/**
 * Turns parsed sheet rows and a snapshot of the app's employees into a plan. Pure: the preview shows this
 * plan and Apply writes exactly this plan.
 *
 * The employee number (Sr. in the sheet, trailing digits of the Employee ID in the app) is the match key.
 * A matched employee keeps their Employee ID, wage and status; the sheet owns every other mapped field.
 */
export function planSync(parsed: ParseResult, snapshot: EmployeeSnapshot[], today: Date): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], unchangedCount: 0, skips: [], warnings: [], appOnly: [] }

  const rowsBySr = new Map<number, ParsedRow[]>()
  for (const row of parsed.rows) {
    if (row.sr === null) continue
    rowsBySr.set(row.sr, [...(rowsBySr.get(row.sr) ?? []), row])
  }

  const appByNumber = new Map<number, EmployeeSnapshot[]>()
  for (const employee of snapshot) {
    if (employee.number === null) continue
    appByNumber.set(employee.number, [...(appByNumber.get(employee.number) ?? []), employee])
  }
  const takenIds = new Set(snapshot.map((e) => e.employeeId))

  for (const row of parsed.rows) {
    if (row.sr === null) {
      plan.skips.push(skip(row, 'SR_INVALID', 'Sr. must be a whole number.'))
      continue
    }
    if ((rowsBySr.get(row.sr)?.length ?? 0) > 1) {
      plan.skips.push(skip(row, 'SR_DUPLICATE', `Sr. ${row.sr} appears on more than one row.`))
      continue
    }

    const matches = appByNumber.get(row.sr) ?? []
    if (matches.length > 1) {
      plan.skips.push(
        skip(row, 'AMBIGUOUS_APP_MATCH', `Number ${row.sr} matches ${matches.map((m) => m.employeeId).join(', ')} in the app.`),
      )
      continue
    }

    if (matches.length === 1) {
      planExisting(plan, row, matches[0], parsed.presentFields)
    } else {
      planNew(plan, row, takenIds, today)
    }
  }

  const sheetNumbers = new Set(rowsBySr.keys())
  plan.appOnly = snapshot
    .filter((e) => e.number === null || !sheetNumbers.has(e.number))
    .map((e) => ({ employeeDbId: e.id, employeeId: e.employeeId, employeeName: e.employeeName }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))

  return plan
}

function planExisting(plan: SyncPlan, row: ParsedRow, employee: EmployeeSnapshot, presentFields: SheetOwnedField[]): void {
  const missing = row.requiredErrors.filter((e) => e.field === 'employeeName' || e.field === 'designation')
  if (missing.length > 0) {
    plan.skips.push(
      skip(row, 'EXISTING_REQUIRED_INVALID', `Blank ${missing.map((m) => REQUIRED_LABELS[m.field]).join(' and ')}.`),
    )
    return
  }

  const update = planUpdate(row, employee, presentFields)
  if (update.changes.length > 0) plan.updates.push(update)
  else plan.unchangedCount++
  plan.warnings.push(...existingWarnings(row, employee), ...fieldWarnings(row, employee.employeeId))
}

function planNew(plan: SyncPlan, row: ParsedRow, takenIds: Set<string>, today: Date): void {
  const employeeNumber = row.employeeIdRaw === null ? null : trailingNumber(row.employeeIdRaw)
  if (row.employeeIdRaw === null || employeeNumber === null) {
    plan.skips.push(skip(row, 'NEW_EMPLOYEE_ID_INVALID', ID_HINT))
    return
  }
  if (employeeNumber !== row.sr) {
    plan.skips.push(
      skip(row, 'NEW_SR_ID_MISMATCH', `Sr. ${row.srRaw} does not match the digits of ${row.employeeIdRaw}.`),
    )
    return
  }
  if (takenIds.has(row.employeeIdRaw)) {
    plan.skips.push(skip(row, 'NEW_EMPLOYEE_ID_TAKEN', `${row.employeeIdRaw} already exists in the app.`))
    return
  }

  const problems = row.requiredErrors.map((e) => REQUIRED_LABELS[e.field])
  const joining = row.fields.dateOfJoining ?? null
  const joiningInFuture =
    joining !== null && isWageEffectiveTooFarAhead(new Date(`${joining}T00:00:00.000Z`), today)
  if (problems.length > 0 || joiningInFuture) {
    const detail =
      problems.length > 0
        ? `Missing or invalid: ${problems.join(', ')}.`
        : 'JOINING_IN_FUTURE: Date of Joining is more than 7 days ahead.'
    plan.skips.push(skip(row, 'NEW_REQUIRED_INVALID', detail))
    return
  }

  const create: PlannedCreate = {
    rowNumber: row.rowNumber,
    number: row.sr as number,
    employeeId: row.employeeIdRaw,
    serialNumber: row.srRaw,
    fields: row.fields,
    salary: row.salary.value as number,
    isActive: row.active.value ?? true,
    wageEffectiveFrom: joining as string,
    warnings: row.warnings,
  }
  plan.creates.push(create)
  plan.warnings.push(...fieldWarnings(row, row.employeeIdRaw))
}

// ─── Plan hash ────────────────────────────────────────────────────────────────

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
}

/** sha256 of the actionable plan (not the counts or the timestamp), as hex. */
export function hashPlan(plan: SyncPlan): string {
  const { creates, updates, skips, warnings, appOnly } = plan
  return createHash('sha256').update(canonical({ creates, updates, skips, warnings, appOnly })).digest('hex')
}
