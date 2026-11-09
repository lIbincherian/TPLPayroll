import { toISODate } from './week'
import type {
  CodeExceptionLite,
  CodeMatch,
  DecisionReason,
  EmployeeDecisionValue,
  EmployeeLite,
  GridEmployeeTag,
  WeekRange,
} from '../types/attendance-sync.types'

/** All trailing digits of an Employee ID as a number: "TPLGOAHLP036" → 36, "TPLGOAHLP" → null. */
export function trailingNumber(employeeId: string): number | null {
  const match = /(\d+)$/.exec(employeeId)
  if (!match) return null
  return parseInt(match[1], 10)
}

/**
 * Match an eTimeOffice code to an employee. A saved exception wins first; otherwise
 * the code's number must equal the Employee ID's trailing number. Names are never read.
 */
export function matchEmployeeCode(
  code: string,
  employees: EmployeeLite[],
  exceptions: CodeExceptionLite[] = [],
): CodeMatch {
  const exception = exceptions.find((e) => e.empCode === code)
  if (exception?.kind === 'IGNORE') return { status: 'IGNORED' }
  if (exception?.kind === 'MATCH' && exception.employeeId) {
    const target = employees.find((e) => e.id === exception.employeeId)
    if (target) return { status: 'MATCHED', employee: target, via: 'EXCEPTION' }
    // The linked employee no longer exists: fall back to matching on the number.
  }

  if (!/^\d+$/.test(code)) return { status: 'UNKNOWN' }
  const number = parseInt(code, 10)
  const hits = employees
    .filter((e) => trailingNumber(e.employeeId) === number)
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))

  if (hits.length === 0) return { status: 'UNKNOWN' }
  if (hits.length === 1) return { status: 'MATCHED', employee: hits[0], via: 'NUMBER' }
  return { status: 'DUPLICATE', employees: hits }
}

function resignedBeforeWeek(employee: EmployeeLite, week: WeekRange): boolean {
  return employee.dateOfResignation !== null && toISODate(employee.dateOfResignation) < week.start
}

/**
 * An inactive employee, or one who resigned before the week, needs an approve/reject
 * decision, but only when they have punches. Resigning during the week is normal.
 */
export function needsEmployeeDecision(
  employee: EmployeeLite,
  punchCount: number,
  week: WeekRange,
): { needed: false } | { needed: true; reason: DecisionReason } {
  if (punchCount <= 0) return { needed: false }
  if (!employee.isActive) return { needed: true, reason: 'INACTIVE' }
  if (resignedBeforeWeek(employee, week)) return { needed: true, reason: 'RESIGNED_BEFORE_WEEK' }
  return { needed: false }
}

/**
 * Employees listed in the review grid: every active employee who did not resign before
 * the week, plus inactive/resigned employees whose decision is APPROVED. A rejected
 * employee, or one with no decision, is left out.
 *
 * `alwaysInclude` lists employees who are in the grid regardless of their decision or current
 * status. A correction passes everyone with approved attendance records: they were approved
 * when the week was, and may have been deactivated or had a resignation date set since. It
 * wins even over a REJECTED decision, because a rejected employee never gets records.
 */
export function getReviewGridEmployees(
  employees: EmployeeLite[],
  decisions: Array<{ employeeId: string; decision: EmployeeDecisionValue }>,
  week: WeekRange,
  alwaysInclude?: ReadonlySet<string>,
): Array<EmployeeLite & { tag: GridEmployeeTag }> {
  const approved = new Set(decisions.filter((d) => d.decision === 'APPROVED').map((d) => d.employeeId))
  const listable = (employee: EmployeeLite) => approved.has(employee.id) || !!alwaysInclude?.has(employee.id)

  const listed: Array<EmployeeLite & { tag: GridEmployeeTag }> = []
  for (const employee of employees) {
    if (!employee.isActive) {
      if (listable(employee)) listed.push({ ...employee, tag: 'INACTIVE_APPROVED' })
    } else if (resignedBeforeWeek(employee, week)) {
      if (listable(employee)) listed.push({ ...employee, tag: 'RESIGNED_APPROVED' })
    } else {
      listed.push({ ...employee, tag: 'ACTIVE' })
    }
  }
  return listed.sort((a, b) => a.employeeName.localeCompare(b.employeeName))
}
