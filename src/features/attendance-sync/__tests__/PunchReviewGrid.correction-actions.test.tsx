import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PunchReviewGrid } from '@/features/attendance-sync/components/PunchReviewGrid'
import {
  approveWeekAction,
  getApprovalSummaryAction,
  reopenWeekAction,
} from '@/features/attendance-sync/actions/attendance-sync.actions'
import type { ApprovalSummary, PunchReview } from '@/features/attendance-sync/types/attendance-sync.types'

// Fix round, item 9b: attendance-sync does not import payroll-correction. The page that mounts a
// correction injects "Approve punches" and "Cancel correction", and the grid calls what it was given.

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/features/attendance-sync/actions/attendance-sync.actions', () => ({
  approveWeekAction: vi.fn(),
  getApprovalSummaryAction: vi.fn(),
  getPunchReviewAction: vi.fn(),
  reopenWeekAction: vi.fn(),
  savePunchEditAction: vi.fn(),
  getCorrectionChangedDaysAction: vi.fn(),
}))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
})

const DATES = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']

function reviewOf(mode: PunchReview['mode']): PunchReview {
  return {
    weekId: '2026-11-05',
    week: { start: '2026-11-05', end: '2026-11-11' },
    status: mode.kind === 'CORRECTION' ? 'APPROVED' : 'REVIEW',
    mode,
    locked: false,
    employees: [],
    dates: DATES,
    counts: { needsFixingDays: 0, noPunchEmployees: 0, unusualDays: 0, unresolvedCodes: 0, pendingDecisions: 0, editedDays: 0 },
    totals: { byDay: [], regular: 0, overtime: 0 },
    approval: { canApprove: true, blockers: [], weekHasEnded: true },
    payroll: { status: 'APPROVED', payrollRunId: 'run-1', activeCorrectionId: mode.kind === 'CORRECTION' ? 'session-1' : null },
    lastSavedAt: null,
    approvedAt: null,
  }
}

const CORRECTION = reviewOf({ kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 1 })
const LIVE = reviewOf({ kind: 'LIVE' })

const SUMMARY: ApprovalSummary = {
  employeeCount: 2,
  totalRegularHours: 16,
  totalOvertimeHours: 0,
  editedDays: 0,
  editedDayDetails: [],
  leftOut: [],
}

const onApproveCorrection = vi.fn()
const onAbandonCorrection = vi.fn()

function renderGrid(initialReview: PunchReview, props: Partial<React.ComponentProps<typeof PunchReviewGrid>> = {}) {
  return render(
    <PunchReviewGrid initialReview={initialReview} backHref="/payroll" backLabel="Payroll" title="Punches" {...props} />,
  )
}

async function openApproveDialog() {
  fireEvent.click(screen.getByTestId('approve-week-button'))
  await waitFor(() => expect(screen.getByTestId('approval-employees')).toHaveTextContent('2'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getApprovalSummaryAction).mockResolvedValue({ ok: true, data: SUMMARY })
  onApproveCorrection.mockResolvedValue(undefined)
})

describe('PunchReviewGrid in a correction: Approve punches', () => {
  it('is labelled Approve punches and calls the injected action with the payroll run id', async () => {
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })
    expect(screen.getByTestId('approve-week-button')).toHaveTextContent('Approve punches')

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalledTimes(1))
    expect(onApproveCorrection).toHaveBeenCalledWith('run-1')
    // It is the correction action that runs, not the live approval.
    expect(approveWeekAction).not.toHaveBeenCalled()
  })

  it('does not call the action until the dialog is confirmed', async () => {
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    await openApproveDialog()

    expect(onApproveCorrection).not.toHaveBeenCalled()
  })

  it('shows the error the injected action returns and stays on the page', async () => {
    onApproveCorrection.mockResolvedValue({ ok: false, error: 'Some days still have a missing time.', code: 'CORRECTION_HAS_INCOMPLETE_PAIRS' })
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent('Some days still have a missing time.')
    expect(screen.getByTestId('show-needs-fixing')).toBeInTheDocument() // a blocking code offers Show days
    expect(push).not.toHaveBeenCalled()
  })

  it('shows a generic failure with the "Couldn\'t approve" prefix for other codes', async () => {
    onApproveCorrection.mockResolvedValue({ ok: false, error: 'This correction is no longer in progress.', code: 'CORRECTION_NOT_ACTIVE' })
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent("Couldn't approve. This correction is no longer in progress.")
  })

  it('shows no error when the action returns nothing (it redirected to the preview)', async () => {
    onApproveCorrection.mockResolvedValue(undefined)
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalled())
    expect(screen.queryByTestId('approve-error')).not.toBeInTheDocument()
  })

  it('reports it instead of failing silently when the page did not inject the action', async () => {
    renderGrid(CORRECTION)

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent("Couldn't complete that. Reload the page and try again.")
    expect(approveWeekAction).not.toHaveBeenCalled()
  })
})

describe('PunchReviewGrid in a correction: Cancel correction', () => {
  it('shows the banner, and Discard calls the injected abandon action with the run id', async () => {
    onAbandonCorrection.mockResolvedValue({ ok: true, data: { sessionId: 's-1', discardedEdits: 0 } })
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    expect(screen.getByTestId('correction-banner')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cancel-correction'))
    // Edits are counted a moment after render; with a pending count the discard is confirmed first.
    const confirm = await screen.findByTestId('discard-correction')
    fireEvent.click(confirm)

    await waitFor(() => expect(onAbandonCorrection).toHaveBeenCalledTimes(1))
    expect(onAbandonCorrection).toHaveBeenCalledWith('run-1')
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
  })

  it('shows the error when the injected abandon action fails', async () => {
    onAbandonCorrection.mockResolvedValue({ ok: false, error: 'This correction is no longer in progress.' })
    renderGrid(CORRECTION, { onApproveCorrection, onAbandonCorrection })

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() => expect(screen.getAllByText('This correction is no longer in progress.').length).toBeGreaterThan(0))
    expect(push).not.toHaveBeenCalled()
  })

  it('reports it when the page did not inject the abandon action', async () => {
    renderGrid(CORRECTION, { onApproveCorrection })

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() =>
      expect(screen.getAllByText("Couldn't complete that. Reload the page and try again.").length).toBeGreaterThan(0),
    )
    expect(push).not.toHaveBeenCalled()
  })
})

describe('PunchReviewGrid for the live week', () => {
  it('has no correction banner, labels the button Approve week, and approves through the live action', async () => {
    vi.mocked(approveWeekAction).mockResolvedValue({ ok: false, error: 'This week isn\'t in review.', code: 'WEEK_NOT_IN_REVIEW' })
    vi.mocked(reopenWeekAction).mockResolvedValue({ ok: true, data: { reopenedAt: new Date().toISOString() } } as never)
    renderGrid(LIVE, { onApproveCorrection, onAbandonCorrection })

    expect(screen.queryByTestId('correction-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('approve-week-button')).toHaveTextContent('Approve week')

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(approveWeekAction).toHaveBeenCalledWith('2026-11-05'))
    expect(onApproveCorrection).not.toHaveBeenCalled()
    expect(onAbandonCorrection).not.toHaveBeenCalled()
  })
})
