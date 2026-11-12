import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RevisedPreview } from '../RevisedPreview'
import { approveRevisionAction } from '@/features/payroll-correction/actions/correction.actions'

// Fix round, item 1: when the punches changed after the preview was calculated, approving it is
// refused with REVISION_STALE and the user is sent back to the punches to approve them again.

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  approveRevisionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
}))

const totals = {
  totalRegularHours: 40,
  totalOvertimeHours: 4,
  totalRegularPay: 2500,
  totalOvertimePay: 250,
  totalAdditions: 0,
  totalDeductions: 0,
  totalNetPayable: 2750,
}

function renderPreview(backHref = '/payroll/run/run-1/correct/punches') {
  return render(
    <RevisedPreview
      payrollRunId="run-1"
      revisionId="draft-1"
      revisionNumber={2}
      currentRevisionNumber={1}
      weekLabel="6 Mar 2025 – 12 Mar 2025"
      employees={[]}
      totals={totals}
      previousTotals={{ ...totals, totalNetPayable: 2500 }}
      backHref={backHref}
      hasPunchEdits
    />,
  )
}

function approve() {
  fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))
  fireEvent.click(screen.getByRole('button', { name: /confirm revision/i }))
}

beforeEach(() => vi.clearAllMocks())

describe('RevisedPreview: a stale preview', () => {
  it('goes back to the punches when the approval is refused as REVISION_STALE', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: false,
      error: 'This preview is out of date: the punches changed after it was calculated. Approve the punches again.',
      code: 'REVISION_STALE',
    })
    renderPreview('/payroll/run/run-1/correct/punches')

    approve()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1/correct/punches'))
    expect(push).toHaveBeenCalledTimes(1)
    expect(approveRevisionAction).toHaveBeenCalledWith('draft-1')
    // It is not an error to read: the user is taken to the punches instead.
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument()
  })

  it('uses backHref as given (the reason step for a correction without punch edits)', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: 'stale', code: 'REVISION_STALE' })
    renderPreview('/payroll/run/run-1/correct')

    approve()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1/correct'))
  })

  it('never opens the payroll run for a stale draft', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: 'stale', code: 'REVISION_STALE' })
    renderPreview()

    approve()

    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalledWith('/payroll/run/run-1')
  })

  it('other failures still show their message and stay on the preview', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: false,
      error: 'This correction is no longer in progress.',
      code: 'CORRECTION_NOT_ACTIVE',
    })
    renderPreview()

    approve()

    expect(await screen.findByText('This correction is no longer in progress.')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('a successful approval opens the payroll run', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: true,
      data: { revisionId: 'draft-1', revisionNumber: 2, status: 'APPROVED', approvedAt: new Date() },
    } as never)
    renderPreview()

    approve()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
  })
})
