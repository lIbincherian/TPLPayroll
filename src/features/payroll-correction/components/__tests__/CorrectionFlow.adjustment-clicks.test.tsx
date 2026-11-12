import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CorrectionFlow } from '../CorrectionFlow'
import type { CorrectionSessionInfo, InitiateCorrectionResult } from '@/features/payroll-correction/types/correction.types'
import {
  approveAdjustmentInCorrectionAction,
  recalculateAndCreateRevisionAction,
  skipAdjustmentInCorrectionAction,
} from '@/features/payroll-correction/actions/correction.actions'

// Approving or skipping an adjustment inside a correction only changes a status, and the server can refuse it
// (nothing left to deduct, the adjustment is completed or cancelled, a carried-forward ONE_TIME already dealt
// with). The refusal is shown, and the row keeps the status it had; a later click that works clears it.

const push = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, back: vi.fn() }) }))
vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  recalculateAndCreateRevisionAction: vi.fn(),
  startAttendanceCorrectionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
  approveAdjustmentInCorrectionAction: vi.fn(),
  skipAdjustmentInCorrectionAction: vi.fn(),
}))

const NOTHING_LEFT = 'Nothing is left to deduct for this adjustment.'
const COMPLETED = 'This adjustment is already completed or cancelled.'

const data: InitiateCorrectionResult = {
  payrollRunId: 'run-1',
  revisionId: 'rev-1',
  revisionNumber: 1,
  weekStart: new Date('2025-03-06T00:00:00.000Z'),
  weekEnd: new Date('2025-03-12T00:00:00.000Z'),
  totals: { totalRegularHours: 40, totalOvertimeHours: 0, totalRegularPay: 2500, totalOvertimePay: 0, totalAdditions: 0, totalDeductions: 0, totalNetPayable: 2500 },
  employees: [],
  adjustmentApplications: [
    { applicationId: 'app-a', adjustmentId: 'adj-a', employeeId: 'emp-1', employeeName: 'Anita Sharma', employeeCode: 'E-1', adjustmentType: 'DEDUCTION', amount: 500, appliedAmount: 500, reason: 'Advance', approvalStatus: 'PENDING', isReversed: false },
    { applicationId: 'app-b', adjustmentId: 'adj-b', employeeId: 'emp-2', employeeName: 'Rajesh Iyer', employeeCode: 'E-2', adjustmentType: 'DEDUCTION', amount: 500, appliedAmount: 500, reason: 'Uniform', approvalStatus: 'PENDING', isReversed: false },
  ],
}

const session: CorrectionSessionInfo = {
  sessionId: 'session-1',
  payrollRunId: 'run-1',
  attendanceUploadId: 'upload-1',
  weekId: '2025-03-06',
  attendanceSource: 'ETIMEOFFICE',
  correctionReason: null,
  correctionTypes: ['ADJUSTMENTS'],
  hasPunchClone: false,
  draftRevisionId: null,
}

const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement
const status = (name: string) => within(row(name)).getByText(/^(Pending|Approved|Skipped)$/).textContent

// Approve and Skip are disabled while a transition is pending, and that outlasts the message or status the click just
// produced. A click or an assertion that follows an earlier one must wait for the button to be enabled again.
const button = (name: string, label: 'Approve' | 'Skip') => () => within(row(name)).getByRole('button', { name: label })
async function clickWhenEnabled(name: string, label: 'Approve' | 'Skip') {
  await waitFor(() => expect(button(name, label)()).toBeEnabled(), { timeout: 15000 })
  fireEvent.click(button(name, label)())
}

function renderFlow() {
  return render(<CorrectionFlow data={data} weekLabel="Week 06 Mar - 12 Mar" activeSession={session} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(approveAdjustmentInCorrectionAction).mockResolvedValue({ ok: true, data: { applicationId: 'app-a', approvalStatus: 'APPROVED' } })
  vi.mocked(skipAdjustmentInCorrectionAction).mockResolvedValue({ ok: true, data: { applicationId: 'app-a', approvalStatus: 'SKIPPED' } })
})

// The waits below allow 15 s for a React transition to settle (they had 5 s, the default test timeout too): on a busy
// machine (a full parallel run) neither the wait nor the test could be trusted to finish in 5 s. The describe timeout is above the waits.
describe('CorrectionFlow: a refused approve or skip is shown, and the row keeps its status', { timeout: 20000 }, () => {
  it('a failed approve shows the server\'s message and the row stays Pending, with both buttons still there', async () => {
    vi.mocked(approveAdjustmentInCorrectionAction).mockResolvedValue({ ok: false, error: NOTHING_LEFT, code: 'ADJUSTMENT_NOT_APPLICABLE' })
    renderFlow()

    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText(NOTHING_LEFT, undefined, { timeout: 15000 })).toBeInTheDocument()
    expect(approveAdjustmentInCorrectionAction).toHaveBeenCalledWith('app-a')
    expect(status('Anita Sharma')).toBe('Pending')
    await waitFor(() => expect(button('Anita Sharma', 'Approve')()).toBeEnabled(), { timeout: 15000 })
    expect(button('Anita Sharma', 'Skip')()).toBeEnabled()
    expect(status('Rajesh Iyer')).toBe('Pending')
  })

  it('a failed skip shows the message and the row stays as it was (Approved stays Approved)', async () => {
    renderFlow()
    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(status('Anita Sharma')).toBe('Approved'), { timeout: 15000 })
    vi.mocked(skipAdjustmentInCorrectionAction).mockResolvedValue({ ok: false, error: 'This correction is no longer in progress.', code: 'CORRECTION_NOT_ACTIVE' })

    await clickWhenEnabled('Anita Sharma', 'Skip')

    expect(await screen.findByText('This correction is no longer in progress.', undefined, { timeout: 15000 })).toBeInTheDocument()
    expect(status('Anita Sharma')).toBe('Approved')
  })

  it('a later click that works clears the message and changes the row', async () => {
    vi.mocked(approveAdjustmentInCorrectionAction).mockResolvedValueOnce({ ok: false, error: COMPLETED, code: 'ADJUSTMENT_NOT_APPLICABLE' })
    renderFlow()
    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(COMPLETED, undefined, { timeout: 15000 })).toBeInTheDocument()

    // the user skips it instead: this works
    await clickWhenEnabled('Anita Sharma', 'Skip')

    await waitFor(() => expect(status('Anita Sharma')).toBe('Skipped'), { timeout: 15000 })
    expect(screen.queryByText(COMPLETED)).not.toBeInTheDocument()
  })

  it('a second click clears the old message at once, before its own answer comes back', async () => {
    vi.mocked(approveAdjustmentInCorrectionAction).mockResolvedValueOnce({ ok: false, error: NOTHING_LEFT, code: 'ADJUSTMENT_NOT_APPLICABLE' })
    renderFlow()
    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(NOTHING_LEFT, undefined, { timeout: 15000 })).toBeInTheDocument()

    let answer: (value: { ok: true; data: { applicationId: string; approvalStatus: 'APPROVED' } }) => void = () => undefined
    vi.mocked(approveAdjustmentInCorrectionAction).mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    await clickWhenEnabled('Rajesh Iyer', 'Approve')

    await waitFor(() => expect(screen.queryByText(NOTHING_LEFT)).not.toBeInTheDocument(), { timeout: 15000 })
    expect(status('Rajesh Iyer')).toBe('Pending') // still waiting for the server
    answer({ ok: true, data: { applicationId: 'app-b', approvalStatus: 'APPROVED' } })
    await waitFor(() => expect(status('Rajesh Iyer')).toBe('Approved'), { timeout: 15000 })
  })

  it('one row failing leaves the other rows alone: each keeps its own status', async () => {
    vi.mocked(approveAdjustmentInCorrectionAction).mockImplementation(async (id: string) =>
      id === 'app-a' ? { ok: false, error: NOTHING_LEFT, code: 'ADJUSTMENT_NOT_APPLICABLE' } : { ok: true, data: { applicationId: id, approvalStatus: 'APPROVED' } },
    )
    renderFlow()

    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))
    await screen.findByText(NOTHING_LEFT, undefined, { timeout: 15000 })
    await clickWhenEnabled('Rajesh Iyer', 'Approve')

    await waitFor(() => expect(status('Rajesh Iyer')).toBe('Approved'), { timeout: 15000 })
    expect(status('Anita Sharma')).toBe('Pending')
    expect(screen.queryByText(NOTHING_LEFT)).not.toBeInTheDocument() // the second click's success cleared it
  })

  it('a refusal does not start a recalculation or navigate', async () => {
    vi.mocked(approveAdjustmentInCorrectionAction).mockResolvedValue({ ok: false, error: NOTHING_LEFT, code: 'ADJUSTMENT_NOT_APPLICABLE' })
    renderFlow()

    fireEvent.click(within(row('Anita Sharma')).getByRole('button', { name: 'Approve' }))
    await screen.findByText(NOTHING_LEFT, undefined, { timeout: 15000 })

    expect(recalculateAndCreateRevisionAction).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('the recalculation no longer sends adjustment changes: the server reads the statuses it has', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({
      ok: true,
      data: { payrollRunId: 'run-1', revisionId: 'rev-2', revisionNumber: 2, totals: data.totals, employeeCount: 0 },
    })
    renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    await waitFor(() => expect(recalculateAndCreateRevisionAction).toHaveBeenCalledTimes(1), { timeout: 15000 })
    const input = vi.mocked(recalculateAndCreateRevisionAction).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(input).not.toHaveProperty('adjustmentChanges')
    expect(input).toMatchObject({ payrollRunId: 'run-1', correctionTypes: ['ADJUSTMENTS'], correctionSessionId: 'session-1' })
  })

  it('a refused recalculation (ADJUSTMENT_NOT_APPLICABLE: the balance ran out since the click) shows its message and stays', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({ ok: false, error: NOTHING_LEFT, code: 'ADJUSTMENT_NOT_APPLICABLE' })
    renderFlow()

    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    expect(await screen.findByText(NOTHING_LEFT, undefined, { timeout: 15000 })).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
