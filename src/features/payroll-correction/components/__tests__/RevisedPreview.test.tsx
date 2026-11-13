import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RevisedPreview } from '../RevisedPreview'
import type { RevisedEmployeeRow } from '@/features/payroll-correction/types/correction.types'
import {
  abandonCorrectionAction,
  approveRevisionAction,
} from '@/features/payroll-correction/actions/correction.actions'

// The revised pay preview of a correction (C8, US-12.30): it shows the DRAFT revision while the
// current one stays current, marks New and Left out employees, and approves in two steps.

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  approveRevisionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
}))

function row(overrides: Partial<RevisedEmployeeRow> = {}): RevisedEmployeeRow {
  return {
    employeeId: 'emp-1',
    employeeCode: 'EMP-001',
    employeeName: 'Kavitha Rajan',
    designation: 'Guard',
    designationShort: 'Guard',
    site: 'North Gate',
    gPay: '9876543210',
    bankAccount: '012345678901',
    weeklySalaryUsed: 2500,
    hourlyRateUsed: 62.5,
    regularHours: 40,
    overtimeHours: 4,
    regularPay: 2500,
    overtimePay: 250,
    grossPay: 2750,
    additions: 0,
    deductions: 0,
    netPayable: 2750,
    previousNetPayable: 2750,
    previousRegularPay: 2500,
    previousOvertimePay: 250,
    previousAdditions: 0,
    previousDeductions: 0,
    isNew: false,
    isLeftOut: false,
    ...overrides,
  }
}

const totals = {
  totalRegularHours: 80,
  totalOvertimeHours: 8,
  totalRegularPay: 5000,
  totalOvertimePay: 500,
  totalAdditions: 0,
  totalDeductions: 0,
  totalNetPayable: 5500,
}

function renderPreview(overrides: Partial<React.ComponentProps<typeof RevisedPreview>> = {}) {
  return render(
    <RevisedPreview
      payrollRunId="run-1"
      revisionId="draft-1"
      revisionNumber={2}
      currentRevisionNumber={1}
      weekLabel="6 Mar 2025 – 12 Mar 2025"
      employees={[row()]}
      totals={totals}
      previousTotals={{ ...totals, totalNetPayable: 6950 }}
      backHref="/payroll/run/run-1/correct/punches"
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RevisedPreview — draft and current revision', () => {
  it('says which revision is previewed and that the current one stays current until approval', () => {
    renderPreview()

    expect(screen.getByText('Revision 2')).toBeInTheDocument()
    expect(screen.getByText(/revision 1 stays current until you approve/i)).toBeInTheDocument()
  })

  it('marks an employee paid only in the new revision as New', () => {
    renderPreview({ employees: [row(), row({ employeeId: 'emp-3', employeeCode: 'EMP-003', employeeName: 'Meena Iyer', isNew: true, previousNetPayable: null })] })

    const meena = screen.getByText('Meena Iyer').closest('tr') as HTMLElement
    expect(within(meena).getByText('New')).toBeInTheDocument()
    const kavitha = screen.getByText('Kavitha Rajan').closest('tr') as HTMLElement
    expect(within(kavitha).queryByText('New')).not.toBeInTheDocument()
  })

  it('marks an employee left out of the new revision as Left out instead of a pay figure', () => {
    renderPreview({
      employees: [
        row(),
        row({
          employeeId: 'emp-2',
          employeeCode: 'EMP-002',
          employeeName: 'Arun Kumar',
          isLeftOut: true,
          netPayable: 0,
          previousNetPayable: 3100,
        }),
      ],
    })

    const arun = screen.getByText('Arun Kumar').closest('tr') as HTMLElement
    expect(within(arun).getByText('Left out')).toBeInTheDocument()
    // The pay figure is not shown as ₹0; the previous amount is in the tooltip.
    expect(within(arun).queryByText('₹0')).not.toBeInTheDocument()
    expect(within(arun).getByText(/Previous: ₹3,100$/)).toBeInTheDocument()
    const kavitha = screen.getByText('Kavitha Rajan').closest('tr') as HTMLElement
    expect(within(kavitha).queryByText('Left out')).not.toBeInTheDocument()
  })
})

describe('RevisedPreview — approving', () => {
  it('asks for a second confirmation before approving', () => {
    renderPreview()

    expect(screen.queryByText('Confirm Revision')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))

    expect(screen.getByText('Approve Revised Payroll?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /confirm revision/i })).toBeInTheDocument()
    expect(approveRevisionAction).not.toHaveBeenCalled()
  })

  it('approves the draft on Confirm Revision, then opens the payroll run', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: true,
      data: { revisionId: 'draft-1', revisionNumber: 2, status: 'APPROVED', approvedAt: new Date() },
    })
    renderPreview()

    fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm revision/i }))

    await waitFor(() => expect(approveRevisionAction).toHaveBeenCalledWith('draft-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
  })

  it('closes the dialog and shows the error when the approval fails', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: false,
      error: 'Only a draft revision can be approved',
      code: 'REVISION_NOT_DRAFT',
    })
    renderPreview()

    fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm revision/i }))

    expect(await screen.findByText('Only a draft revision can be approved')).toBeInTheDocument()
    expect(screen.queryByText('Approve Revised Payroll?')).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('Cancel in the dialog approves nothing', () => {
    renderPreview()

    fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(screen.queryByText('Approve Revised Payroll?')).not.toBeInTheDocument()
    expect(approveRevisionAction).not.toHaveBeenCalled()
  })
})

describe('RevisedPreview — Back and Cancel correction', () => {
  it('Back goes to the punches (or the reason step) given by backHref', () => {
    renderPreview({ backHref: '/payroll/run/run-1/correct/punches' })

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))

    expect(push).toHaveBeenCalledWith('/payroll/run/run-1/correct/punches')
  })

  it('Back goes to the reason step for a correction without punch edits', () => {
    renderPreview({ backHref: '/payroll/run/run-1/correct' })

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))

    expect(push).toHaveBeenCalledWith('/payroll/run/run-1/correct')
  })

  it('Cancel correction abandons straight away when there are no punch edits', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue({ ok: true, data: { sessionId: 's-1', discardedEdits: 0 } })
    renderPreview({ hasPunchEdits: false })

    fireEvent.click(screen.getByRole('button', { name: /cancel correction/i }))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
    expect(screen.queryByText('Discard this correction?')).not.toBeInTheDocument()
  })

  it('Cancel correction asks before discarding punch edits, and keeps editing on request', () => {
    renderPreview({ hasPunchEdits: true })

    fireEvent.click(screen.getByRole('button', { name: /cancel correction/i }))

    expect(screen.getByText('Discard this correction?')).toBeInTheDocument()
    expect(screen.getByText(/revision 1 stay as they are/i)).toBeInTheDocument()
    expect(abandonCorrectionAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }))

    expect(screen.queryByText('Discard this correction?')).not.toBeInTheDocument()
    expect(abandonCorrectionAction).not.toHaveBeenCalled()
  })

  it('discards the correction after confirmation, then returns to the payroll run', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue({ ok: true, data: { sessionId: 's-1', discardedEdits: 3 } })
    renderPreview({ hasPunchEdits: true })

    fireEvent.click(screen.getByRole('button', { name: /cancel correction/i }))
    fireEvent.click(screen.getByRole('button', { name: /discard correction/i }))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
  })

  it('shows the error and does not leave when the discard fails', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue({
      ok: false,
      error: 'No correction is in progress for this payroll run',
      code: 'CORRECTION_NOT_ACTIVE',
    })
    renderPreview({ hasPunchEdits: true })

    fireEvent.click(screen.getByRole('button', { name: /cancel correction/i }))
    fireEvent.click(screen.getByRole('button', { name: /discard correction/i }))

    expect(await screen.findByText('No correction is in progress for this payroll run')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
