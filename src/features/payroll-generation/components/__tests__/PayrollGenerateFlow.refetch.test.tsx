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
import type { WeeklyReviewItem } from '@/features/payroll-adjustments/types/adjustment.types'

// When the approval is refused because the attendance changed under the summary (ATTENDANCE_CHANGED) or is
// no longer approved (ATTENDANCE_NOT_APPROVED), what steps 0 and 1 hold was loaded from the old attendance.
// The flow loads it again: it lands on the adjustments step with the fresh adjustments when the attendance is
// still ready, and on the first step (which says why) when it is not ready or when the reload failed. The first
// step never shows the numbers of the old attendance: when the reload failed it loads them again, and a load that
// fails shows its error with a way to try again.

vi.mock('@/features/payroll-generation/actions/payroll.actions', () => ({
  checkAttendanceReadinessAction: vi.fn(),
  getPendingAdjustmentsForWeekAction: vi.fn(),
  calculatePayrollAction: vi.fn(),
  approvePayrollAction: vi.fn(),
}))
vi.mock('@/features/payroll-adjustments/actions/adjustment.actions', () => ({
  approveAdjustmentApplicationAction: vi.fn(),
  skipAdjustmentApplicationAction: vi.fn(),
  cancelAdjustmentAction: vi.fn(async () => ({ ok: true, data: undefined })),
}))

const WEEK_START = new Date('2026-11-05T00:00:00.000Z')
const WEEK_END = new Date('2026-11-11T00:00:00.000Z')
const CHANGED = 'Attendance for this week changed after this summary was calculated. Go back and recalculate.'
const NOT_APPROVED = "Attendance for this week isn't approved yet"

const ready = (matched: number, leftOut: number, regular = 40) => ({
  ok: true as const,
  data: { ready: true as const, matchedEmployeeCount: matched, leftOutCount: leftOut, totalRegularHours: regular, totalOvertimeHours: 0 },
})

function adjustment(reason: string): WeeklyReviewItem {
  return {
    applicationId: `app-${reason}`,
    adjustmentId: `adj-${reason}`,
    employeeId: 'emp-1',
    employeeCode: 'EMP-001',
    employeeName: 'Anita Rao',
    adjustmentType: 'DEDUCTION',
    amount: 500,
    appliedAmount: 500,
    reason,
    recurrenceType: 'ONE_TIME',
    approvalStatus: 'PENDING',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
  }
}

function summary(netPayable: number): PayrollSummary {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    attendanceApprovedAt: new Date('2026-11-12T08:00:00.000Z'),
    employees: [
      {
        employeeId: 'emp-1', employeeCode: 'EMP-001', employeeName: 'Anita Rao', designation: 'Guard', designationShort: null, site: null,
        gPay: null, bankAccount: null, weeklySalaryUsed: 2500, hourlyRateUsed: 62.5, regularHours: 40, overtimeHours: 0,
        regularPay: netPayable, overtimePay: 0, grossPay: netPayable, additions: 0, deductions: 0, netPayable,
      },
    ],
    totals: {
      totalRegularHours: 40, totalOvertimeHours: 0, totalRegularPay: netPayable, totalOvertimePay: 0,
      totalAdditions: 0, totalDeductions: 0, totalNetPayable: netPayable,
    },
  }
}

/** Open the flow, go to the summary (no adjustments to review the first time), and press Approve. */
async function approveFromSummary() {
  render(<PayrollGenerateFlow weekStart={WEEK_START} weekEnd={WEEK_END} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /Continue to Summary/ }))
  await screen.findByRole('heading', { name: 'Payroll Summary' })
  fireEvent.click(screen.getByRole('button', { name: 'Approve Payroll' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm Approval' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkAttendanceReadinessAction).mockResolvedValue(ready(1, 0))
  vi.mocked(getPendingAdjustmentsForWeekAction).mockResolvedValue({ ok: true, data: [] })
  vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: summary(2500) })
  vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: CHANGED, code: 'ATTENDANCE_CHANGED' })
})

describe('PayrollGenerateFlow reloads what it showed when the attendance changed under the summary', () => {
  it.each(['ATTENDANCE_CHANGED', 'ATTENDANCE_NOT_APPROVED'])(
    '%s with the attendance still ready: lands on the adjustments step with the adjustments of the attendance as it is now',
    async (code) => {
      vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: CHANGED, code })
      vi.mocked(getPendingAdjustmentsForWeekAction)
        .mockResolvedValueOnce({ ok: true, data: [] })
        .mockResolvedValue({ ok: true, data: [adjustment('Fresh advance recovery')] })

      await approveFromSummary()

      expect(await screen.findByText('Fresh advance recovery')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Review Adjustments' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
    },
  )

  it('reads both again with the same week, shows the changed adjustments and the message, and drops the summary', async () => {
    vi.mocked(approvePayrollAction)
      .mockResolvedValueOnce({ ok: false, error: CHANGED, code: 'ATTENDANCE_CHANGED' })
    // After the first pass (readiness once, adjustments once) the attendance has changed: a new adjustment is pending.
    vi.mocked(getPendingAdjustmentsForWeekAction)
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [adjustment('Fresh advance recovery')] })
    vi.mocked(checkAttendanceReadinessAction).mockResolvedValueOnce(ready(1, 0)).mockResolvedValue(ready(2, 3, 56))

    await approveFromSummary()

    expect(await screen.findByText('Fresh advance recovery')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Review Adjustments' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED)
    expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve Payroll' })).not.toBeInTheDocument()
    expect(checkAttendanceReadinessAction).toHaveBeenCalledTimes(2) // on mount, and again after the refusal
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenCalledTimes(2) // on Continue, and again after the refusal
    expect(checkAttendanceReadinessAction).toHaveBeenLastCalledWith(WEEK_START, WEEK_END)
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenLastCalledWith(WEEK_START, WEEK_END)
  })

  it('ATTENDANCE_NOT_APPROVED with the attendance no longer approved: lands on the first step, which says why, with the message above it', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: NOT_APPROVED, code: 'ATTENDANCE_NOT_APPROVED' })
    vi.mocked(checkAttendanceReadinessAction)
      .mockResolvedValueOnce(ready(1, 0))
      .mockResolvedValue({ ok: true, data: { ready: false, reason: 'NOT_APPROVED' } })

    await approveFromSummary()

    expect(await screen.findByRole('heading', { name: 'Verify Attendance' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(NOT_APPROVED)
    expect(screen.getAllByText(NOT_APPROVED).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /Review punches/ })).toHaveAttribute('href', '/attendance/2026-11-05/review')
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument() // nothing to continue with
    expect(screen.queryByRole('heading', { name: 'Review Adjustments' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
  })

  it.each([
    ['NO_DATA', 'No attendance loaded for this week'],
    ['SYNC_FAILED', 'The eTimeOffice sync failed for this week'],
    ['EXCEL_ERA', "This week was imported from Excel and can't start payroll"],
  ] as const)('a week that is %s now also goes to the first step and says so', async (reason, message) => {
    vi.mocked(checkAttendanceReadinessAction)
      .mockResolvedValueOnce(ready(1, 0))
      .mockResolvedValue({ ok: true, data: { ready: false, reason } })

    await approveFromSummary()

    expect(await screen.findByRole('heading', { name: 'Verify Attendance' })).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it('the reload of the readiness failing (ok: false): back to the first step, which loads it again and, when that fails too, shows the error with Try again and never the old numbers', async () => {
    vi.mocked(checkAttendanceReadinessAction).mockResolvedValueOnce(ready(1, 0)).mockResolvedValue({ ok: false, error: 'An unexpected error occurred' })

    await approveFromSummary()

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(
      expect.arrayContaining([CHANGED, expect.stringContaining('An unexpected error occurred')]),
    )
    expect(screen.queryByText('Attendance approved: 1 employees, 0 left out')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Verify Attendance' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
    expect(checkAttendanceReadinessAction).toHaveBeenCalledTimes(3) // on mount, after the refusal, and again for the first step

    // Try again loads it: this time it comes back.
    vi.mocked(checkAttendanceReadinessAction).mockResolvedValue(ready(2, 3, 56))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Attendance approved: 2 employees, 3 left out')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('the reload of the adjustments failing (ok: false) while the attendance is ready: first step, with the refreshed readiness (2 employees, 3 left out)', async () => {
    vi.mocked(checkAttendanceReadinessAction).mockResolvedValueOnce(ready(1, 0)).mockResolvedValue(ready(2, 3, 56))
    vi.mocked(getPendingAdjustmentsForWeekAction).mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValue({ ok: false, error: 'An unexpected error occurred' })

    await approveFromSummary()

    expect(await screen.findByRole('heading', { name: 'Verify Attendance' })).toBeInTheDocument()
    expect(screen.getByText('Attendance approved: 2 employees, 3 left out')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED)
    expect(screen.queryByRole('heading', { name: 'Review Adjustments' })).not.toBeInTheDocument()
  })

  it('from the first step the user can continue again once the attendance is ready: the adjustments, then a new summary', async () => {
    vi.mocked(checkAttendanceReadinessAction).mockResolvedValueOnce(ready(1, 0)).mockResolvedValueOnce({ ok: false, error: 'x' }).mockResolvedValue(ready(1, 0))
    await approveFromSummary()
    await screen.findByRole('heading', { name: 'Verify Attendance' })
    vi.mocked(calculatePayrollAction).mockResolvedValue({ ok: true, data: summary(3100) })
    vi.mocked(approvePayrollAction).mockResolvedValue({
      ok: true,
      data: { payrollRunId: 'run-1', payrollRevisionId: 'rev-1', revisionNumber: 1, approvedAt: new Date(), totalNetPayable: 3100, employeeCount: 1 },
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: /Continue to Summary/ }))
    await screen.findByRole('heading', { name: 'Payroll Summary' })
    expect(screen.getAllByText('₹3,100').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Approve Payroll' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Approval' }))

    await screen.findByRole('heading', { name: 'Payroll Approved' })
  })

  it('other refusals (already approved) reload nothing: one read of each, the summary stays', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({ ok: false, error: 'Payroll for this week is already approved', code: 'PAYROLL_ALREADY_EXISTS' })

    await approveFromSummary()

    expect(await screen.findByText('Payroll for this week is already approved')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Payroll Summary' })).toBeInTheDocument()
    expect(checkAttendanceReadinessAction).toHaveBeenCalledTimes(1)
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenCalledTimes(1)
  })

  it('a successful approval reloads nothing either', async () => {
    vi.mocked(approvePayrollAction).mockResolvedValue({
      ok: true,
      data: { payrollRunId: 'run-1', payrollRevisionId: 'rev-1', revisionNumber: 1, approvedAt: new Date(), totalNetPayable: 2500, employeeCount: 1 },
    })

    await approveFromSummary()

    await screen.findByRole('heading', { name: 'Payroll Approved' })
    await waitFor(() => expect(approvePayrollAction).toHaveBeenCalledTimes(1))
    expect(checkAttendanceReadinessAction).toHaveBeenCalledTimes(1)
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenCalledTimes(1)
  })

  it('Back from the summary loads the pending adjustments again, so one cancelled in the review is gone', async () => {
    vi.mocked(getPendingAdjustmentsForWeekAction)
      .mockResolvedValueOnce({ ok: true, data: [adjustment('Cancelled uniform recovery')] })
      .mockResolvedValue({ ok: true, data: [] })
    render(<PayrollGenerateFlow weekStart={WEEK_START} weekEnd={WEEK_END} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Cancelled uniform recovery')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel adjustment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    const next = screen.getByRole('button', { name: /Continue to Payroll Summary/ })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await screen.findByRole('heading', { name: 'Payroll Summary' })

    fireEvent.click(screen.getByRole('button', { name: /Back/ }))

    expect(await screen.findByRole('heading', { name: 'Review Adjustments' })).toBeInTheDocument()
    expect(screen.queryByText('Cancelled uniform recovery')).not.toBeInTheDocument()
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenCalledTimes(2)
    expect(getPendingAdjustmentsForWeekAction).toHaveBeenLastCalledWith(WEEK_START, WEEK_END)
  })

  it('a reload that throws (the server cannot be reached) takes the user off the dead summary to the first step, which loads the attendance again: the fresh numbers, never the old ones', async () => {
    vi.mocked(checkAttendanceReadinessAction)
      .mockResolvedValueOnce(ready(1, 0))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue(ready(2, 3, 56))

    await approveFromSummary()

    expect(await screen.findByRole('heading', { name: 'Verify Attendance' })).toBeInTheDocument()
    expect(screen.getByText('Attendance approved: 2 employees, 3 left out')).toBeInTheDocument()
    expect(screen.queryByText('Attendance approved: 1 employees, 0 left out')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED)
    expect(screen.queryByRole('heading', { name: 'Payroll Summary' })).not.toBeInTheDocument()
    expect(checkAttendanceReadinessAction).toHaveBeenCalledTimes(3) // on mount, the reload that threw, and the first step's own
  })
})
