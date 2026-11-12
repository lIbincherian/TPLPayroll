import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PayrollGenerateFlow } from '@/features/payroll-generation/components/PayrollGenerateFlow'
import {
  approvePayrollAction,
  calculatePayrollAction,
  checkAttendanceReadinessAction,
  getPendingAdjustmentsForWeekAction,
} from '@/features/payroll-generation/actions/payroll.actions'
import type { PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

// Fix round, item 4: a payroll summary built from attendance that was later reopened, or approved
// again with different hours, cannot be approved. The flow says so and goes back to the Adjustments
// step so the summary is calculated again.

vi.mock('@/features/payroll-generation/actions/payroll.actions', () => ({
  checkAttendanceReadinessAction: vi.fn(),
  getPendingAdjustmentsForWeekAction: vi.fn(),
  calculatePayrollAction: vi.fn(),
  approvePayrollAction: vi.fn(),
}))

const WEEK_START = new Date('2026-11-05T00:00:00.000Z')
const WEEK_END = new Date('2026-11-11T00:00:00.000Z')
const CHANGED = 'Attendance for this week changed after this summary was calculated. Go back and recalculate.'

function summary(netPayable: number): PayrollSummary {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    attendanceApprovedAt: new Date('2026-11-12T08:00:00.000Z'),
    employees: [
      {
        employeeId: 'emp-1',
        employeeCode: 'EMP-001',
        employeeName: 'Anita Rao',
        designation: 'Guard',
        designationShort: null,
        site: null,
        gPay: null,
        phone: null,
        bankAccount: null,
        weeklySalaryUsed: 2500,
        hourlyRateUsed: 62.5,
        regularHours: 40,
        overtimeHours: 0,
        regularPay: netPayable,
        overtimePay: 0,
        grossPay: netPayable,
        additions: 0,
        deductions: 0,
        netPayable,
      },
    ],
    totals: {
      totalRegularHours: 40,
      totalOvertimeHours: 0,
      totalRegularPay: netPayable,
      totalOvertimePay: 0,
      totalAdditions: 0,
      totalDeductions: 0,
      totalNetPayable: netPayable,
    },
  }
}

async function toSummaryStep() {
  render(<PayrollGenerateFlow weekStart={WEEK_START} weekEnd={WEEK_END} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /Continue to Summary/ }))
  await screen.findByRole('heading', { name: 'Payroll Summary' })
}

async function approve() {
  fireEvent.click(screen.getByRole('button', { name: 'Approve Payroll' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm Approval' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkAttendanceReadinessAction).mockResolvedValue({
    ok: true,
    data: { ready: true, matchedEmployeeCount: 1, leftOutCount: 0, totalRegularHours: 40, totalOvertimeHours: 0 },
  })
  vi.mocked(getPendingAdjustmentsForWeekAction).mockResolvedValue({ ok: true, data: [] })
  vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: summary(2500) })
})

describe('PayrollGenerateFlow: the attendance changed after the summary was calculated', () => {
  it.each(['ATTENDANCE_CHANGED', 'ATTENDANCE_NOT_APPROVED'])(
    'on %s it shows the message and goes back to the Adjustments step, dropping the summary',
    async (code) => {
      vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: CHANGED, code })
      await toSummaryStep()

      await approve()

      expect(await screen.findByRole('alert')).toHaveTextContent(CHANGED)
      expect(screen.getByRole('heading', { name: 'Review Adjustments' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Approve Payroll' })).not.toBeInTheDocument()
    },
  )

  it('sends the summary it calculated, untouched, to the approval', async () => {
    const calculated = summary(2500)
    vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: calculated })
    vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: CHANGED, code: 'ATTENDANCE_CHANGED' })
    await toSummaryStep()

    await approve()

    await waitFor(() => expect(approvePayrollAction).toHaveBeenCalledTimes(1))
    expect(approvePayrollAction).toHaveBeenCalledWith(calculated)
    expect(vi.mocked(approvePayrollAction).mock.calls[0][0].attendanceApprovedAt).toEqual(calculated.attendanceApprovedAt)
  })

  it('continuing recalculates from the current attendance, clears the message and shows the new summary', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: CHANGED, code: 'ATTENDANCE_CHANGED' })
    await toSummaryStep()
    await approve()
    await screen.findByRole('alert')

    vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: summary(3100) })
    fireEvent.click(screen.getByRole('button', { name: /Continue to Summary/ }))

    await screen.findByRole('heading', { name: 'Payroll Summary' })
    expect(calculatePayrollAction).toHaveBeenCalledTimes(2)
    // The old message is cleared when the calculation starts; React commits that update together with
    // the end of the async transition, which can be a tick after the new summary shows.
    await waitFor(() => expect(screen.queryByText(CHANGED)).not.toBeInTheDocument())
    expect(screen.getAllByText('₹3,100.00').length).toBeGreaterThan(0)
  })

  it('a recalculated summary approves with its own approval time', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValueOnce({ ok: false, error: CHANGED, code: 'ATTENDANCE_CHANGED' })
    await toSummaryStep()
    await approve()
    await screen.findByRole('alert')

    const fresh = { ...summary(3100), attendanceApprovedAt: new Date('2026-11-13T09:00:00.000Z') }
    vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: fresh })
    vi.mocked(approvePayrollAction).mockResolvedValueOnce({
      ok: true,
      data: {
        payrollRunId: 'run-1',
        payrollRevisionId: 'rev-1',
        revisionNumber: 1,
        approvedAt: new Date(),
        totalNetPayable: 3100,
        employeeCount: 1,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /Continue to Summary/ }))
    await screen.findByRole('heading', { name: 'Payroll Summary' })
    await approve()

    await screen.findByRole('heading', { name: 'Payroll Approved' })
    expect(vi.mocked(approvePayrollAction).mock.calls[1][0]).toBe(fresh)
  })

  it('other failures keep the summary on screen with the message (no going back)', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({
      ok: false,
      error: 'Payroll for this week is already approved',
      code: 'PAYROLL_ALREADY_EXISTS',
    })
    await toSummaryStep()

    await approve()

    expect(await screen.findByText('Payroll for this week is already approved')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Payroll Summary' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Review Adjustments' })).not.toBeInTheDocument()
  })

  it('a failure without a code (unexpected error) also keeps the summary', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: 'An unexpected error occurred' })
    await toSummaryStep()

    await approve()

    expect(await screen.findByText('An unexpected error occurred')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Payroll Summary' })).toBeInTheDocument()
  })
})
