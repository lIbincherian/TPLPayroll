import { addDaysISO } from './week'
import { formatDayShort, plural } from './format'
import type {
  DayView,
  GridEmployee,
  ISODate,
  PairView,
  PunchReview,
  SavePunchEditResult,
} from '../types/attendance-sync.types'

// Pure helpers behind the punch review grid: filtering, what a cell shows, stepping between
// days in the editor, and merging a save result into the loaded review. No React, no I/O.

export type GridFilter = 'all' | 'needs' | 'nopunch' | 'unusual'

export function matchesFilter(employee: GridEmployee, filter: GridFilter): boolean {
  switch (filter) {
    case 'needs':
      return employee.days.some((day) => day.incomplete)
    case 'nopunch':
      return !employee.hasAnyPunch
    case 'unusual':
      return employee.days.some((day) => day.isUnusual)
    default:
      return true
  }
}

export function matchesSearch(employee: GridEmployee, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return employee.employeeName.toLowerCase().includes(needle) || employee.employeeCode.toLowerCase().includes(needle)
}

// ─── What a cell shows ────────────────────────────────────────────────────────

function hasTime(pair: PairView): boolean {
  return Boolean(pair.in?.time || pair.out?.time)
}

export function isIncompletePair(pair: PairView): boolean {
  return (pair.in?.time ? 1 : 0) + (pair.out?.time ? 1 : 0) === 1
}

/** "07:40–13:04"; the missing side of an incomplete pair reads "--:--". */
export function pairText(pair: PairView): string {
  return `${pair.in?.time ?? '--:--'}–${pair.out?.time ?? '--:--'}`
}

/** Pairs that hold at least one time. Deleted punches leave a pair with none. */
export function getShownPairs(day: DayView): PairView[] {
  return day.pairs.filter(hasTime)
}

/**
 * A cell has room for two pairs. Past that the rest sit behind a `+N` chip, but an
 * incomplete pair is never hidden because it blocks approval.
 */
export function getCellPairs(day: DayView): { pairs: PairView[]; hiddenCount: number } {
  const shown = getShownPairs(day)
  if (shown.length <= 2) return { pairs: shown, hiddenCount: 0 }

  const incomplete = shown.find(isIncompletePair)
  const second = incomplete && incomplete !== shown[0] ? incomplete : shown[1]
  return { pairs: [shown[0], second], hiddenCount: shown.length - 2 }
}

/** Every pair, one per line, for the tooltip. */
export function describeDay(day: DayView): string[] {
  return getShownPairs(day).map(pairText)
}

export function dayAriaLabel(employee: GridEmployee, day: DayView): string {
  const pairs = describeDay(day)
  const parts = [`${employee.employeeName}, ${formatDayShort(day.date)}`]
  parts.push(pairs.length > 0 ? pairs.join(', ') : 'no punches')
  if (pairs.length > 0) {
    parts.push(`${day.regularHours.toFixed(2)} regular, ${day.overtimeHours.toFixed(2)} overtime`)
  }
  if (day.incomplete) parts.push('needs fixing')
  if (day.isUnusual && day.unusualReason) parts.push(`unusual: ${day.unusualReason}`)
  if (day.isMerged) parts.push('merged scans')
  if (day.isEdited) parts.push('edited')
  return parts.join('. ')
}

// ─── Stepping between days in the editor ──────────────────────────────────────

export interface DayTarget {
  employeeId: string
  date: ISODate
}

function dayMatchesFilter(day: DayView, filter: GridFilter): boolean {
  if (filter === 'needs') return day.incomplete
  if (filter === 'unusual') return day.isUnusual
  return true
}

/**
 * The day the editor's previous/next buttons go to. With Needs fixing or Unusual days on, it
 * steps through matching days across employees, so a whole list can be cleared in one pass; a
 * day that was just fixed no longer matches but still marks the current position. Otherwise it
 * steps through the same employee's seven days.
 */
export function findStepTarget(
  employees: GridEmployee[],
  filter: GridFilter,
  from: DayTarget,
  direction: 'previous' | 'next',
): DayTarget | null {
  const rowIndex = employees.findIndex((e) => e.employeeId === from.employeeId)
  if (rowIndex === -1) return null

  if (filter !== 'needs' && filter !== 'unusual') {
    const days = employees[rowIndex].days
    const next = days.findIndex((d) => d.date === from.date) + (direction === 'next' ? 1 : -1)
    const day = days[next]
    return day ? { employeeId: from.employeeId, date: day.date } : null
  }

  const flat = employees.flatMap((employee) =>
    employee.days.map((day) => ({ employeeId: employee.employeeId, day })),
  )
  const position = flat.findIndex((item) => item.employeeId === from.employeeId && item.day.date === from.date)
  if (position === -1) return null

  const candidates =
    direction === 'next'
      ? flat.slice(position + 1)
      : flat.slice(0, position).reverse()
  const hit = candidates.find((item) => dayMatchesFilter(item.day, filter))
  return hit ? { employeeId: hit.employeeId, date: hit.day.date } : null
}

// ─── Merging a save into the loaded review ────────────────────────────────────

/** The grid, counts, totals and approval state after one employee-day was saved. */
export function applySaveResult(
  review: PunchReview,
  employeeId: string,
  date: ISODate,
  result: SavePunchEditResult,
): PunchReview {
  return {
    ...review,
    employees: review.employees.map((employee) =>
      employee.employeeId !== employeeId
        ? employee
        : {
            ...employee,
            days: employee.days.map((day) => (day.date === date ? result.day : day)),
            totalRegularHours: result.employeeTotals.regular,
            totalOvertimeHours: result.employeeTotals.overtime,
            hasAnyPunch: result.employeeTotals.hasAnyPunch,
          },
    ),
    counts: result.counts,
    totals: result.totals,
    approval: result.approval,
    lastSavedAt: result.savedAt,
  }
}

// ─── Approval blockers ────────────────────────────────────────────────────────

/** One plain sentence per blocker, for the disabled Approve button's tooltip. */
export function describeBlockers(review: Pick<PunchReview, 'approval' | 'counts' | 'week'>): string[] {
  const { approval, counts, week } = review
  const lines: string[] = []
  if (approval.blockers.includes('WEEK_NOT_ENDED')) {
    lines.push(`This week hasn't ended yet. You can approve it from ${formatDayShort(addDaysISO(week.end, 1))}.`)
  }
  if (approval.blockers.includes('NEEDS_FIXING')) {
    lines.push(`${plural(counts.needsFixingDays, 'day')} need${counts.needsFixingDays === 1 ? 's' : ''} fixing first.`)
  }
  if (approval.blockers.includes('UNRESOLVED_CODES')) {
    lines.push(`${plural(counts.unresolvedCodes, 'code')} to fix in the employee check.`)
  }
  if (approval.blockers.includes('PENDING_DECISIONS')) {
    lines.push(`${plural(counts.pendingDecisions, 'decision')} left in the employee check.`)
  }
  return lines
}
