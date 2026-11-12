import { describe, expect, it } from 'vitest'
import { buildApprovalSummary, countLeftOut } from '@/features/attendance-sync/lib/review'
import type { GridEmployee } from '@/features/attendance-sync/types/attendance-sync.types'

// countLeftOut: how many employees approving a review leaves out, the number stored as
// AttendanceUpload.approvedLeftOutCount when a week is approved or a correction rebuilds its records.
// Same rule as the approval summary's `leftOut` list, which it counts: an employee in the grid with no hours,
// plus every employee rejected in the employee check (rejected employees are not in the grid).

function employee(id: string, regular: number, overtime: number): GridEmployee {
  return {
    employeeId: id,
    employeeCode: id.toUpperCase(),
    employeeName: `Employee ${id}`,
    tag: 'MATCHED',
    days: [],
    totalRegularHours: regular,
    totalOvertimeHours: overtime,
    hasAnyPunch: regular + overtime > 0,
  } as unknown as GridEmployee
}

const review = (...employees: GridEmployee[]) => ({ employees })

describe('countLeftOut', () => {
  it('is 0 when everyone has hours and nobody was rejected', () => {
    expect(countLeftOut(review(employee('a', 8, 0), employee('b', 0, 1.5)), [])).toBe(0)
  })

  it('counts each employee with no hours at all', () => {
    expect(countLeftOut(review(employee('a', 8, 0), employee('b', 0, 0), employee('c', 0, 0)), [])).toBe(2)
  })

  it('counts each rejected employee, who is not in the grid', () => {
    expect(
      countLeftOut(review(employee('a', 8, 0)), [
        { employeeId: 'x', decision: 'REJECTED' },
        { employeeId: 'y', decision: 'REJECTED' },
      ]),
    ).toBe(2)
  })

  it('does not count an approved decision', () => {
    expect(countLeftOut(review(employee('a', 8, 0)), [{ employeeId: 'x', decision: 'APPROVED' }])).toBe(0)
  })

  it('adds the two kinds: 2 with no hours and 1 rejected is 3', () => {
    expect(
      countLeftOut(review(employee('a', 8, 0), employee('b', 0, 0), employee('c', 0, 0)), [
        { employeeId: 'x', decision: 'REJECTED' },
        { employeeId: 'a', decision: 'APPROVED' },
      ]),
    ).toBe(3)
  })

  it('a few minutes of overtime alone is hours: not left out', () => {
    expect(countLeftOut(review(employee('a', 0, 0.25)), [])).toBe(0)
  })

  it('an empty review with no decisions is 0', () => {
    expect(countLeftOut(review(), [])).toBe(0)
  })

  it('equals the length of the approval summary\'s leftOut list for the same input', () => {
    const grid = review(employee('a', 8, 0), employee('b', 0, 0), employee('c', 4, 0), employee('d', 0, 0))
    const decisions = [
      { employeeId: 'x', decision: 'REJECTED' as const },
      { employeeId: 'a', decision: 'APPROVED' as const },
    ]

    const summary = buildApprovalSummary(
      grid,
      decisions.map((d) => ({ ...d, employeeCode: 'X', employeeName: 'X' })),
    )

    expect(countLeftOut(grid, decisions)).toBe(summary.leftOut.length)
    expect(summary.leftOut.map((l) => l.reason).sort()).toEqual(['REJECTED', 'ZERO_HOURS', 'ZERO_HOURS'])
  })
})
