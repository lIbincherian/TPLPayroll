import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BulkActionToolbar } from '@/features/employee-management/components/BulkActionToolbar'

// ─── Mock Phosphor icons as simple spans ─────────────────────────────────────
vi.mock('@phosphor-icons/react', () => ({
  UserMinus: (props: Record<string, unknown>) => <span data-testid="icon-user-minus" {...props} />,
  Prohibit: (props: Record<string, unknown>) => <span data-testid="icon-prohibit" {...props} />,
  X: (props: Record<string, unknown>) => <span data-testid="icon-x" {...props} />,
  Warning: (props: Record<string, unknown>) => <span data-testid="icon-warning" {...props} />,
  SpinnerGap: (props: Record<string, unknown>) => <span data-testid="icon-spinner" {...props} />,
  CurrencyCircleDollar: (props: Record<string, unknown>) => <span data-testid="icon-currency-circle" {...props} />,
}))

// ─── Mock server actions ─────────────────────────────────────────────────────
vi.mock('@/features/employee-management/actions/employee.actions', () => ({
  bulkUpdateStatusAction: vi.fn(),
  bulkUpdateHourlyRateAction: vi.fn(),
  getEmployeeWageHistoryAction: vi.fn(),
}))

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.2: Floating bulk-action toolbar
// ─────────────────────────────────────────────────────────────────────────────

describe('BulkActionToolbar', () => {
  const defaultProps = {
    onMarkResigned: vi.fn(),
    onMarkInactive: vi.fn(),
    onChangeHourlyRate: vi.fn(),
    onClear: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders when selectedCount is non-empty and shows count', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={3} />)

    expect(screen.getByText('3 selected')).toBeInTheDocument()
    expect(screen.getByText('Mark Resigned')).toBeInTheDocument()
    expect(screen.getByText('Mark Inactive')).toBeInTheDocument()
    expect(screen.getByText('Change Daily Wage')).toBeInTheDocument()
  })

  it('does not render when selectedCount is 0', () => {
    const { container } = render(<BulkActionToolbar {...defaultProps} selectedCount={0} />)

    expect(container.innerHTML).toBe('')
  })

  it('clear button calls onClear', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={5} />)

    const clearBtn = screen.getByLabelText('Clear selection')
    fireEvent.click(clearBtn)

    expect(defaultProps.onClear).toHaveBeenCalledOnce()
  })

  it('Mark Resigned button calls onMarkResigned', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={2} />)

    fireEvent.click(screen.getByText('Mark Resigned'))

    expect(defaultProps.onMarkResigned).toHaveBeenCalledOnce()
  })

  it('Mark Inactive button calls onMarkInactive', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={2} />)

    fireEvent.click(screen.getByText('Mark Inactive'))

    expect(defaultProps.onMarkInactive).toHaveBeenCalledOnce()
  })

  it('Change Daily Wage button calls onChangeHourlyRate', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={2} />)

    fireEvent.click(screen.getByText('Change Daily Wage'))

    expect(defaultProps.onChangeHourlyRate).toHaveBeenCalledOnce()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.3: Bulk Resigned dialog — validation
// ─────────────────────────────────────────────────────────────────────────────

import { BulkStatusDialog } from '@/features/employee-management/components/BulkStatusDialog'
import { bulkUpdateStatusAction } from '@/features/employee-management/actions/employee.actions'
import type { EmployeeListItem } from '@/features/employee-management/types/employee.types'

const makeListItem = (overrides: Partial<EmployeeListItem> = {}): EmployeeListItem => ({
  id: 'uuid-1',
  employeeId: 'EMP-042',
  employeeName: 'Lakshmi Venkatesh',
  designation: 'Guard',
  designationShort: 'GRD',
  site: 'North Gate',
  isActive: true,
  dateOfResignation: null,
  status: 'ACTIVE',
  ...overrides,
})

describe('BulkStatusDialog — Resigned validation', () => {
  const onClose = vi.fn()
  const onComplete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows validation error when confirming without a date', async () => {
    const employees = [makeListItem()]

    render(
      <BulkStatusDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    // Clear the default date value
    const dateInput = screen.getByDisplayValue(new Date().toISOString().split('T')[0])
    fireEvent.change(dateInput, { target: { value: '' } })

    // Click confirm
    fireEvent.click(screen.getByText('Confirm'))

    // Error message should appear
    expect(screen.getByText('Date of Resignation is required')).toBeInTheDocument()

    // No server action should have been called
    expect(bulkUpdateStatusAction).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('calls server action and shows success toast when date is provided', async () => {
    vi.mocked(bulkUpdateStatusAction).mockResolvedValue({
      ok: true,
      data: { succeeded: 2, skipped: 0, failed: 0, errors: [] },
    })

    const employees = [
      makeListItem({ id: 'uuid-1', employeeId: 'EMP-042' }),
      makeListItem({ id: 'uuid-2', employeeId: 'EMP-117', employeeName: 'Arjun Mehrotra' }),
    ]

    render(
      <BulkStatusDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    // The default date should already be set to today
    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => {
      expect(bulkUpdateStatusAction).toHaveBeenCalledWith({
        ids: ['uuid-1', 'uuid-2'],
        status: 'RESIGNED',
        dateOfResignation: expect.any(Date),
      })
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce()
    })
  })

  it('disables buttons during processing', async () => {
    // Make the action hang so we can inspect the processing state
    let resolveAction: (value: Awaited<ReturnType<typeof bulkUpdateStatusAction>>) => void
    vi.mocked(bulkUpdateStatusAction).mockReturnValue(
      new Promise((resolve) => { resolveAction = resolve })
    )

    const employees = [makeListItem()]

    render(
      <BulkStatusDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    fireEvent.click(screen.getByText('Confirm'))

    // While processing, both buttons should be disabled
    await waitFor(() => {
      const cancelBtn = screen.getByText('Cancel')
      const confirmBtn = screen.getByText('Processing...')
      expect(cancelBtn).toBeDisabled()
      expect(confirmBtn).toBeDisabled()
    })

    // Resolve the action to clean up
    resolveAction!({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: 0, errors: [] },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.4: Bulk Inactive dialog
// ─────────────────────────────────────────────────────────────────────────────

import { BulkInactiveDialog } from '@/features/employee-management/components/BulkInactiveDialog'

describe('BulkInactiveDialog', () => {
  const onClose = vi.fn()
  const onComplete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows already-inactive employees as skipped', () => {
    const employees = [
      makeListItem({ id: 'uuid-1', isActive: true }),
      makeListItem({ id: 'uuid-2', isActive: false, employeeName: 'Sunita Patil', employeeId: 'EMP-150' }),
    ]

    render(
      <BulkInactiveDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    // Active employee should be shown normally
    expect(screen.getByText('Lakshmi Venkatesh')).toBeInTheDocument()

    // Already-inactive section should appear
    expect(screen.getByText('Already inactive — will be skipped:')).toBeInTheDocument()
    expect(screen.getByText('Sunita Patil')).toBeInTheDocument()
  })

  it('disables confirm when all employees are already inactive', () => {
    const employees = [
      makeListItem({ id: 'uuid-1', isActive: false }),
      makeListItem({ id: 'uuid-2', isActive: false, employeeName: 'Sunita Patil' }),
    ]

    render(
      <BulkInactiveDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    const confirmBtn = screen.getByRole('button', { name: /confirm/i })
    expect(confirmBtn).toBeDisabled()
  })

  it('calls server action for active employees', async () => {
    vi.mocked(bulkUpdateStatusAction).mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 1, failed: 0, errors: [] },
    })

    const employees = [
      makeListItem({ id: 'uuid-1', isActive: true }),
      makeListItem({ id: 'uuid-2', isActive: false, employeeName: 'Sunita Patil' }),
    ]

    render(
      <BulkInactiveDialog
        employees={employees}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    await waitFor(() => {
      expect(bulkUpdateStatusAction).toHaveBeenCalledWith({
        ids: ['uuid-1', 'uuid-2'],
        status: 'INACTIVE',
      })
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-E01.5: Bulk Rate dialog — validation
// ─────────────────────────────────────────────────────────────────────────────

import { BulkRateDialog } from '@/features/employee-management/components/BulkRateDialog'
import { getEmployeeWageHistoryAction, bulkUpdateHourlyRateAction } from '@/features/employee-management/actions/employee.actions'

describe('BulkRateDialog — validation', () => {
  const onClose = vi.fn()
  const onComplete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock wage history fetch to return current rates
    vi.mocked(getEmployeeWageHistoryAction).mockResolvedValue({
      ok: true,
      data: [{
        id: 'wh-1',
        employeeId: 'uuid-1',
        weeklySalary: 14000,
        hourlyRate: 62.50,
        effectiveFrom: new Date('2025-01-01'),
        effectiveTo: null,
        changeSource: 'MANUAL',
      }],
    })
  })

  it('shows validation error when rate is empty', async () => {
    render(
      <BulkRateDialog
        employees={[makeListItem()]}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText('Loading current wages...')).not.toBeInTheDocument()
    })

    // Click confirm without entering a rate
    fireEvent.click(screen.getByText('Update Wages'))

    expect(screen.getByText('Enter a daily wage greater than 0')).toBeInTheDocument()
  })

  it('shows validation error when rate is zero', async () => {
    render(
      <BulkRateDialog
        employees={[makeListItem()]}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading current wages...')).not.toBeInTheDocument()
    })

    const rateInput = screen.getByPlaceholderText('0.00')
    fireEvent.change(rateInput, { target: { value: '0' } })
    fireEvent.click(screen.getByText('Update Wages'))

    expect(screen.getByText('Enter a daily wage greater than 0')).toBeInTheDocument()
  })

  it('displays the current daily wage for each employee', async () => {
    render(
      <BulkRateDialog
        employees={[makeListItem()]}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('₹14000.00')).toBeInTheDocument()
    })
  })

  it('asks for a new daily wage, shows the computed hourly rate and submits the daily wage', async () => {
    vi.mocked(bulkUpdateHourlyRateAction).mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: 0, errors: [] },
    })
    render(
      <BulkRateDialog
        employees={[makeListItem()]}
        onClose={onClose}
        onComplete={onComplete}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Loading current wages...')).not.toBeInTheDocument()
    })

    expect(screen.getByText(/change daily wage for 1 employee/i)).toBeInTheDocument()
    expect(screen.getByText('New Daily Wage (₹) *')).toBeInTheDocument()
    expect(screen.getByTestId('bulk-computed-hourly-rate')).toHaveTextContent('—')

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '800' } })
    expect(screen.getByTestId('bulk-computed-hourly-rate')).toHaveTextContent('₹100.00')

    fireEvent.click(screen.getByText('Update Wages'))

    await waitFor(() => expect(bulkUpdateHourlyRateAction).toHaveBeenCalledTimes(1))
    expect(vi.mocked(bulkUpdateHourlyRateAction).mock.calls[0][0]).toMatchObject({ newDailyWage: 800 })
  })
})
