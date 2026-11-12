import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { RevisedPreview } from '../RevisedPreview'
import { approveRevisionAction } from '@/features/payroll-correction/actions/correction.actions'

// A preview calculated before an adjustment, its balance or a correction type changed is refused with
// REVISION_STALE. The server's message says which, and the user is sent back to recalculate: the message is a
// toast, because the page they land on is another one (the app's toaster outlives the preview).

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  approveRevisionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
}))

const ADJUSTMENTS_STALE = 'This preview is out of date: an adjustment or its balance changed after it was calculated. Go back and recalculate.'
const TYPES_STALE = 'This preview is out of date: the correction types changed after it was calculated. Go back and recalculate.'

const totals = {
  totalRegularHours: 40,
  totalOvertimeHours: 0,
  totalRegularPay: 2500,
  totalOvertimePay: 0,
  totalAdditions: 0,
  totalDeductions: 500,
  totalNetPayable: 2000,
}

function renderPreview(backHref = '/payroll/run/run-1/correct') {
  return render(
    <RevisedPreview
      payrollRunId="run-1"
      revisionId="draft-1"
      revisionNumber={2}
      currentRevisionNumber={1}
      weekLabel="6 Mar 2025 – 12 Mar 2025"
      employees={[]}
      totals={totals}
      previousTotals={{ ...totals, totalDeductions: 0, totalNetPayable: 2500 }}
      backHref={backHref}
    />,
  )
}

function approve() {
  fireEvent.click(screen.getByRole('button', { name: /approve revision/i }))
  fireEvent.click(screen.getByRole('button', { name: /confirm revision/i }))
}

beforeEach(() => vi.clearAllMocks())

describe('RevisedPreview: REVISION_STALE shows why, then goes back to recalculate', () => {
  it.each([
    ['an adjustment or its balance changed', ADJUSTMENTS_STALE],
    ['the correction types changed', TYPES_STALE],
    ['the punches changed', 'This preview is out of date: the punches changed after it was calculated. Approve the punches again.'],
  ])('%s: the server\'s message is a toast that stays long enough to read, and the user lands on backHref', async (_why, message) => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: message, code: 'REVISION_STALE' })
    renderPreview('/payroll/run/run-1/correct')

    approve()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1/correct'), { timeout: 5000 })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(message, { duration: 10000 })
    expect(push).toHaveBeenCalledTimes(1)
    // the message is not also left on the preview the user is leaving
    expect(screen.queryByText(message)).not.toBeInTheDocument()
  })

  it('the toast is shown before the user is sent back, and the payroll run is never opened', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: ADJUSTMENTS_STALE, code: 'REVISION_STALE' })
    renderPreview()

    approve()

    await waitFor(() => expect(push).toHaveBeenCalled(), { timeout: 5000 })
    expect(vi.mocked(toast.error).mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0])
    expect(push).not.toHaveBeenCalledWith('/payroll/run/run-1')
  })

  it('any other failure stays on the preview with its message on the page and no toast', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: 'This correction is no longer in progress.', code: 'CORRECTION_NOT_ACTIVE' })
    renderPreview()

    approve()

    expect(await screen.findByText('This correction is no longer in progress.', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('a draft that was deleted (an approve or skip after the recalculation) is not "stale": its message stays on the preview, and nothing is toasted', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({ ok: false, error: 'Revision "draft-1" not found', code: 'REVISION_NOT_FOUND' })
    renderPreview()

    approve()

    expect(await screen.findByText('Revision "draft-1" not found', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('a successful approval opens the payroll run and toasts nothing', async () => {
    vi.mocked(approveRevisionAction).mockResolvedValue({
      ok: true,
      data: { revisionId: 'draft-1', revisionNumber: 2, status: 'APPROVED', approvedAt: new Date() },
    } as never)
    renderPreview()

    approve()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'), { timeout: 5000 })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
