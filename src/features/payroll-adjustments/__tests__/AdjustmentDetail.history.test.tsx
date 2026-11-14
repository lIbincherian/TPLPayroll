import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { AdjustmentDetail } from '@/features/payroll-adjustments/components/AdjustmentDetail'
import type {
  AdjustmentApplicationRecord,
  AdjustmentDetailRecord,
} from '@/features/payroll-adjustments/types/adjustment.types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/features/payroll-adjustments/actions/adjustment.actions', () => ({ cancelAdjustmentAction: vi.fn() }))

function app(
  id: string,
  weekStart: string,
  approvalStatus: AdjustmentApplicationRecord['approvalStatus'],
  carriedTo: string | null = null,
): AdjustmentApplicationRecord {
  return {
    id,
    payrollAdjustmentId: 'adj-1',
    employeeId: 'emp-1',
    payrollWeekStartDate: new Date(weekStart),
    payrollWeekEndDate: new Date(new Date(weekStart).getTime() + 6 * 86400000),
    appliedAmount: 300,
    approvalStatus,
    approvedAt: null,
    appliedAt: null,
    skippedAt: approvalStatus === 'SKIPPED' ? new Date(weekStart) : null,
    carriedForwardToPayrollWeekStartDate: carriedTo ? new Date(carriedTo) : null,
    isReversed: false,
  }
}

function adjustment(status: AdjustmentDetailRecord['status'], applications: AdjustmentApplicationRecord[]) {
  return {
    id: 'adj-1',
    employeeId: 'emp-1',
    employeeName: 'Worker',
    employeeCode: 'E1',
    adjustmentType: 'DEDUCTION',
    recurrenceType: 'ONE_TIME',
    amount: 300,
    reason: 'Uniform',
    status,
    startPayrollWeekStartDate: new Date('2025-10-09'),
    startPayrollWeekEndDate: new Date('2025-10-15'),
    endPayrollWeekStartDate: null,
    endPayrollWeekEndDate: null,
    totalRecurrenceWeeks: null,
    totalBalance: null,
    remainingBalance: null,
    recurrenceEndType: null,
    skippedCarryForwardCount: 0,
    createdAt: new Date('2025-10-01'),
    applications,
  } satisfies AdjustmentDetailRecord
}

function historyTable() {
  return screen.getByText('Application History').parentElement as HTMLElement
}

describe('AdjustmentDetail: Application History labels', () => {
  it('labels a carried-forward skip with its week, and a plain skip as Skipped', () => {
    render(
      <AdjustmentDetail
        adjustment={adjustment('ACTIVE', [
          app('a1', '2025-10-09', 'SKIPPED', '2025-10-16'),
          app('a2', '2025-10-16', 'SKIPPED'),
          app('a3', '2025-10-23', 'PENDING'),
        ])}
      />,
    )
    const history = within(historyTable())
    expect(history.getByText('Skipped, carried to week of 16 Oct 2025')).toBeTruthy()
    expect(history.getByText('Skipped')).toBeTruthy()
    expect(history.getByText('Pending')).toBeTruthy()
    expect(screen.queryByTestId('history-cancelled-entry')).toBeNull()
  })

  it('ends a cancelled adjustment with a Cancelled entry and shows no pending row', () => {
    render(
      <AdjustmentDetail
        adjustment={adjustment('CANCELLED', [
          app('a1', '2025-10-09', 'SKIPPED', '2025-10-16'),
          app('a2', '2025-10-16', 'PENDING'),
        ])}
      />,
    )
    const rows = within(historyTable()).getAllByRole('row')
    expect(rows[rows.length - 1].getAttribute('data-testid')).toBe('history-cancelled-entry')
    expect(rows[rows.length - 1].textContent).toContain('Cancelled')
    expect(within(historyTable()).queryByText('Pending')).toBeNull()
  })

  it('shows the Cancelled entry even when no applications remain', () => {
    render(<AdjustmentDetail adjustment={adjustment('CANCELLED', [app('a1', '2025-10-09', 'PENDING')])} />)
    expect(screen.getByTestId('history-cancelled-entry')).toBeTruthy()
    expect(screen.queryByText('No applications yet.')).toBeNull()
  })
})
