import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toast } from 'sonner'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  PunchReviewGrid,
  type CorrectionGridActions,
  type PunchReviewGridProps,
} from '@/features/attendance-sync/components/PunchReviewGrid'
import {
  approveWeekAction,
  getApprovalSummaryAction,
  getPunchReviewAction,
  reopenWeekAction,
} from '@/features/attendance-sync/actions/attendance-sync.actions'
import type {
  ApprovalSummary,
  CorrectionReview,
  LiveReview,
  PunchReview,
} from '@/features/attendance-sync/types/attendance-sync.types'

// Fix round, item 9b: attendance-sync does not import payroll-correction. The page that mounts a
// correction injects "Approve punches" and "Cancel correction", and the grid calls what it was given.
// Round 3, item 10: the props make the injection a compile-time requirement (a correction review must
// come with its actions, a live one must not), so there is no runtime "action missing" fallback.

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

function reviewOf<M extends PunchReview['mode']>(mode: M): PunchReview & { mode: M } {
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

const CORRECTION: CorrectionReview = reviewOf({
  kind: 'CORRECTION',
  payrollRunId: 'run-1',
  correctionId: 'session-1',
  revisionNumber: 1,
})
const LIVE: LiveReview = reviewOf({ kind: 'LIVE' })

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

const correctionActions: CorrectionGridActions = { reason: null, onApprove: onApproveCorrection, onAbandon: onAbandonCorrection }

function renderCorrection(correction: CorrectionGridActions = correctionActions) {
  return render(
    <PunchReviewGrid initialReview={CORRECTION} backHref="/payroll" backLabel="Payroll" title="Punches" correction={correction} />,
  )
}

function renderLive() {
  return render(<PunchReviewGrid initialReview={LIVE} backHref="/payroll" backLabel="Payroll" title="Punches" />)
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
    renderCorrection()
    expect(screen.getByTestId('approve-week-button')).toHaveTextContent('Approve punches')

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalledTimes(1))
    expect(onApproveCorrection).toHaveBeenCalledWith('run-1')
    // It is the correction action that runs, not the live approval.
    expect(approveWeekAction).not.toHaveBeenCalled()
  })

  it('does not call the action until the dialog is confirmed', async () => {
    renderCorrection()

    await openApproveDialog()

    expect(onApproveCorrection).not.toHaveBeenCalled()
  })

  it('shows the error the injected action returns and stays on the page', async () => {
    onApproveCorrection.mockResolvedValue({ ok: false, error: 'Some days still have a missing time.', code: 'CORRECTION_HAS_INCOMPLETE_PAIRS' })
    renderCorrection()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent('Some days still have a missing time.')
    expect(screen.getByTestId('show-needs-fixing')).toBeInTheDocument() // a blocking code offers Show days
    expect(push).not.toHaveBeenCalled()
  })

  it('shows a generic failure with the "Couldn\'t approve" prefix for other codes', async () => {
    onApproveCorrection.mockResolvedValue({ ok: false, error: 'This correction is no longer in progress.', code: 'CORRECTION_NOT_ACTIVE' })
    renderCorrection()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent("Couldn't approve. This correction is no longer in progress.")
  })

  it('shows no error when the action returns nothing (it redirected to the preview)', async () => {
    onApproveCorrection.mockResolvedValue(undefined)
    renderCorrection()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalled())
    expect(screen.queryByTestId('approve-error')).not.toBeInTheDocument()
  })

})

describe('PunchReviewGrid in a correction: Cancel correction', () => {
  it('shows the banner, and Discard calls the injected abandon action with the run id', async () => {
    onAbandonCorrection.mockResolvedValue({ ok: true, data: { sessionId: 's-1', discardedEdits: 0 } })
    renderCorrection()

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
    renderCorrection()

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() => expect(screen.getAllByText('This correction is no longer in progress.').length).toBeGreaterThan(0))
    expect(push).not.toHaveBeenCalled()
  })
})

describe('PunchReviewGrid for the live week', () => {
  it('has no correction banner, labels the button Approve week, and approves through the live action', async () => {
    vi.mocked(approveWeekAction).mockResolvedValue({ ok: false, error: 'This week isn\'t in review.', code: 'WEEK_NOT_IN_REVIEW' })
    vi.mocked(reopenWeekAction).mockResolvedValue({ ok: true, data: { reopenedAt: new Date().toISOString() } } as never)
    renderLive()

    expect(screen.queryByTestId('correction-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('approve-week-button')).toHaveTextContent('Approve week')

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(approveWeekAction).toHaveBeenCalledWith('2026-11-05'))
    expect(onApproveCorrection).not.toHaveBeenCalled()
    expect(onAbandonCorrection).not.toHaveBeenCalled()
  })
})

// The pairing of review and actions is checked by `tsc` (the `@ts-expect-error` lines fail the build if the
// props ever loosen again). Nothing here renders.
describe('PunchReviewGridProps (compile time)', () => {
  it('requires the actions with a correction review and refuses them with a live one', () => {
    // @ts-expect-error a correction review must come with its actions
    const missing: PunchReviewGridProps = { initialReview: CORRECTION, backHref: '/', backLabel: 'Back', title: 'Punches' }
    // @ts-expect-error a live review takes no correction actions
    const unexpected: PunchReviewGridProps = { initialReview: LIVE, backHref: '/', backLabel: 'Back', title: 'Punches', correction: correctionActions }
    const valid: PunchReviewGridProps[] = [
      { initialReview: CORRECTION, backHref: '/', backLabel: 'Back', title: 'Punches', correction: correctionActions },
      { initialReview: LIVE, backHref: '/', backLabel: 'Back', title: 'Punches' },
    ]

    expect([missing, unexpected, ...valid]).toHaveLength(4)
  })
})

// Round 3, item 10 (tester): what the injected actions carry reaches the screen, and the run id comes
// from the review's own mode, not from anything the page hard-codes.
describe('PunchReviewGrid in a correction: what the injected actions carry', () => {
  it('shows the reason from the actions in the banner', () => {
    renderCorrection({ ...correctionActions, reason: 'Wrong OUT time on Friday' })

    expect(screen.getByTestId('correction-banner')).toBeInTheDocument()
    expect(screen.getByTestId('correction-reason')).toHaveTextContent('Reason: Wrong OUT time on Friday')
  })

  it('shows no reason line when the reason is null', () => {
    renderCorrection({ ...correctionActions, reason: null })

    expect(screen.getByTestId('correction-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('correction-reason')).not.toBeInTheDocument()
  })

  it('shows the revision being corrected from the review mode in the banner', () => {
    render(
      <PunchReviewGrid
        initialReview={reviewOf({ kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 3 })}
        backHref="/payroll"
        backLabel="Payroll"
        title="Punches"
        correction={correctionActions}
      />,
    )

    expect(screen.getByTestId('correction-banner')).toHaveTextContent('Revision 3 stays in effect')
  })

  const renderRun9 = () =>
    render(
      <PunchReviewGrid
        initialReview={reviewOf({ kind: 'CORRECTION', payrollRunId: 'run-9', correctionId: 'session-9', revisionNumber: 1 })}
        backHref="/payroll"
        backLabel="Payroll"
        title="Punches"
        correction={correctionActions}
      />,
    )

  it('hands the run id of the review itself to the approve action (not a fixed one)', async () => {
    renderRun9()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalledWith('run-9'))
    expect(onApproveCorrection).not.toHaveBeenCalledWith('run-1')
  })

  it('hands the run id of the review itself to the abandon action (not a fixed one)', async () => {
    onAbandonCorrection.mockResolvedValue({ ok: true, data: { sessionId: 's-9', discardedEdits: 0 } })
    renderRun9()

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() => expect(onAbandonCorrection).toHaveBeenCalledWith('run-9'))
    expect(onAbandonCorrection).not.toHaveBeenCalledWith('run-1')
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-9'))
  })

  it('does not call either action just by rendering', () => {
    renderCorrection()

    expect(onApproveCorrection).not.toHaveBeenCalled()
    expect(onAbandonCorrection).not.toHaveBeenCalled()
  })

  it('a failed approve result is shown as a failure and never falls through to the live approval', async () => {
    onApproveCorrection.mockResolvedValue({ ok: false, error: 'Nothing changed.', code: 'VALIDATION_ERROR' })
    renderCorrection()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(push).not.toHaveBeenCalled()
    expect(approveWeekAction).not.toHaveBeenCalled()
  })
})

// ─── Round 4, item 4: a correction review never falls through to the live approval ───────────────

describe('PunchReviewGrid: a correction review with no actions never calls the live approval (round 4, item 4)', () => {
  const MISSING = "This correction can't be approved from this page. Reload and try again."

  /** The prop union forbids this at compile time; the review state can still turn into a correction at run time. */
  function renderCorrectionWithoutActions() {
    const props = { initialReview: CORRECTION, backHref: '/payroll', backLabel: 'Payroll', title: 'Punches' } as unknown as PunchReviewGridProps
    return render(<PunchReviewGrid {...props} />)
  }

  it('shows the refusal in the approve dialog, calls no approval, shows no success toast and does not navigate', async () => {
    renderCorrectionWithoutActions()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.getByTestId('approve-error')).toHaveTextContent(`Couldn't approve. ${MISSING}`)
    expect(approveWeekAction).not.toHaveBeenCalled()
    expect(onApproveCorrection).not.toHaveBeenCalled()
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('it is not a blocking error: there is no "Show days" button for it', async () => {
    renderCorrectionWithoutActions()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    expect(screen.queryByTestId('show-needs-fixing')).not.toBeInTheDocument()
  })

  it('pressing the button again gives the same refusal and still no live approval', async () => {
    renderCorrectionWithoutActions()
    await openApproveDialog()

    fireEvent.click(screen.getByTestId('approve-confirm'))
    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-confirm')).not.toBeDisabled())
    expect(screen.getByTestId('approve-error')).toHaveTextContent(MISSING)
    expect(approveWeekAction).not.toHaveBeenCalled()
  })

  it('does not reload the review either (a refusal that calls nothing reads nothing)', async () => {
    renderCorrectionWithoutActions()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))
    await waitFor(() => expect(screen.getByTestId('approve-error')).toBeInTheDocument())

    expect(getPunchReviewAction).not.toHaveBeenCalled()
  })

  it('a live grid whose review is replaced by a correction review on reload refuses too, after its one live attempt', async () => {
    // The live page mounts the grid without actions. "Show days" reloads the review; if that comes back as a
    // correction review, the grid's mode is CORRECTION while its props still carry no actions.
    vi.mocked(approveWeekAction).mockResolvedValue({
      ok: false,
      error: 'Some days still have a missing time.',
      code: 'WEEK_NOT_READY',
    })
    vi.mocked(getPunchReviewAction).mockResolvedValue({ ok: true, data: CORRECTION })
    renderLive()
    expect(screen.getByTestId('punch-review')).toHaveAttribute('data-mode', 'LIVE')

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))
    await waitFor(() => expect(screen.getByTestId('show-needs-fixing')).toBeInTheDocument())
    expect(approveWeekAction).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('show-needs-fixing'))
    await waitFor(() => expect(screen.getByTestId('punch-review')).toHaveAttribute('data-mode', 'CORRECTION'))
    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-error')).toHaveTextContent(MISSING))
    expect(approveWeekAction).toHaveBeenCalledTimes(1) // still only the first, live, attempt
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it('with its actions a correction review still approves through them, and the live action stays untouched', async () => {
    renderCorrection()

    await openApproveDialog()
    fireEvent.click(screen.getByTestId('approve-confirm'))

    await waitFor(() => expect(onApproveCorrection).toHaveBeenCalledWith('run-1'))
    expect(approveWeekAction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('approve-error')).not.toBeInTheDocument()
  })

  it('the grid source has no path from a correction mode to approveWeekAction', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/PunchReviewGrid.tsx'), 'utf8')
    const confirmApprove = /async function confirmApprove[\s\S]*?\n  }\n/.exec(source)?.[0] ?? ''

    expect(confirmApprove).toContain("mode.kind === 'CORRECTION'")
    // Inside the correction branch every path returns before the live approval is reached.
    const correctionBranch = /if \(mode\.kind === 'CORRECTION'\) \{[\s\S]*?\n    \}\n/.exec(confirmApprove)?.[0] ?? ''
    expect(correctionBranch).toContain('if (!correction) return')
    expect(correctionBranch).not.toContain('approveWeekAction')
    expect(confirmApprove.indexOf('approveWeekAction')).toBeGreaterThan(confirmApprove.indexOf(correctionBranch) + correctionBranch.length - 1)
  })
})
