import { plural } from './format'
import { calculateDailyHours } from './hours'
import { matchEmployeeCode } from './matching'
import { round2 } from './time'
import { toISODate } from './week'
import type {
  AttendancePunchCreate,
  EmployeeLite,
  HHmm,
  ISODate,
  StatusChangeSummary,
  WeekRange,
} from '../types/attendance-sync.types'

export type StatusEmployee = EmployeeLite & { dateOfJoining: Date | null }

type PunchRow = Pick<
  AttendancePunchCreate,
  'employeeId' | 'empCode' | 'matchStatus' | 'punchDate' | 'pairIndex' | 'position' | 'currentTime'
>

export interface EmployeeStatusChange {
  employeeDbId: string
  employeeId: string
  employeeName: string
  from: boolean
  to: boolean
  punchCount: number
  hours: number
}

/** Regular + overtime from the complete pairs of one employee's rows, summed per day. */
function hoursFrom(rows: PunchRow[]): number {
  const pairsByDay = new Map<string, Map<number, { in: HHmm | null; out: HHmm | null }>>()
  for (const row of rows) {
    const day = toISODate(row.punchDate)
    const pairs = pairsByDay.get(day) ?? new Map<number, { in: HHmm | null; out: HHmm | null }>()
    const pair = pairs.get(row.pairIndex) ?? { in: null, out: null }
    if (row.position === 'IN') pair.in = row.currentTime
    else pair.out = row.currentTime
    pairs.set(row.pairIndex, pair)
    pairsByDay.set(day, pairs)
  }

  let total = 0
  for (const pairs of pairsByDay.values()) {
    const complete = [...pairs.values()].filter(
      (p): p is { in: HHmm; out: HHmm } => p.in !== null && p.out !== null,
    )
    const hours = calculateDailyHours(complete)
    total += hours.regularHours + hours.overtimeHours
  }
  return round2(total)
}

/**
 * Employee status changes the approval of a completed week makes, when no later week is approved: an
 * active employee with no matched punches becomes inactive, an inactive one with punches becomes active
 * again (unless they resigned before today). New joiners, the candidates of a duplicate code and anyone
 * rejected in the employee check are left alone. Punches deleted in review (no current time) don't count.
 */
export function computeStatusChanges(input: {
  week: WeekRange
  today: ISODate
  employees: StatusEmployee[]
  rows: PunchRow[]
  laterWeekApproved: boolean
  /** Employees rejected in the week's employee check: left out of the week, so their status stays. */
  rejectedIds?: ReadonlySet<string>
}): EmployeeStatusChange[] {
  const { week, today, employees, laterWeekApproved, rejectedIds } = input
  if (week.end >= today || laterWeekApproved) return []
  const rows = input.rows.filter((r) => r.currentTime !== null)

  const duplicateCandidates = new Set<string>()
  for (const code of new Set(rows.filter((r) => r.matchStatus === 'DUPLICATE').map((r) => r.empCode))) {
    const match = matchEmployeeCode(code, employees)
    if (match.status === 'DUPLICATE') match.employees.forEach((e) => duplicateCandidates.add(e.id))
  }

  const rowsByEmployee = new Map<string, PunchRow[]>()
  for (const row of rows) {
    if (row.matchStatus !== 'MATCHED' || row.employeeId === null) continue
    const own = rowsByEmployee.get(row.employeeId)
    if (own) own.push(row)
    else rowsByEmployee.set(row.employeeId, [row])
  }

  const changes: EmployeeStatusChange[] = []
  for (const employee of employees) {
    if (employee.dateOfJoining !== null && toISODate(employee.dateOfJoining) >= week.start) continue
    if (duplicateCandidates.has(employee.id) || rejectedIds?.has(employee.id)) continue

    const own = rowsByEmployee.get(employee.id) ?? []
    let to: boolean
    if (employee.isActive && own.length === 0) to = false
    else if (!employee.isActive && own.length > 0) {
      if (employee.dateOfResignation !== null && toISODate(employee.dateOfResignation) < today) continue
      to = true
    } else continue

    changes.push({
      employeeDbId: employee.id,
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      from: employee.isActive,
      to,
      punchCount: own.length,
      hours: hoursFrom(own),
    })
  }
  return changes
}

/** The changes grouped for the approval dialog, the approval result and the APPROVE audit entry. */
export function summarizeStatusChanges(changes: EmployeeStatusChange[]): StatusChangeSummary {
  const pick = (c: EmployeeStatusChange) => ({ id: c.employeeDbId, employeeId: c.employeeId, employeeName: c.employeeName })
  return {
    markedInactive: changes.filter((c) => !c.to).map(pick),
    reactivated: changes.filter((c) => c.to).map(pick),
  }
}

/** "2 employees marked inactive, 1 reactivated"; null when nothing changed. */
export function describeStatusChanges(summary: StatusChangeSummary): string | null {
  const inactive = summary.markedInactive.length
  const reactivated = summary.reactivated.length
  if (inactive === 0 && reactivated === 0) return null
  if (reactivated === 0) return `${plural(inactive, 'employee')} marked inactive`
  if (inactive === 0) return `${plural(reactivated, 'employee')} reactivated`
  return `${plural(inactive, 'employee')} marked inactive, ${reactivated} reactivated`
}
