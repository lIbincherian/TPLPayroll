import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { PunchReviewGrid, type CorrectionGridActions } from '@/features/attendance-sync/components/PunchReviewGrid'
import { getApprovalSummaryAction, getPunchReviewAction, savePunchEditAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { buildGridEmployees } from '@/features/attendance-sync/lib/review'
import { getWeekDates, weekFromStartISO } from '@/features/attendance-sync/lib/week'
import type {
  ActionResult,
  CorrectionReview,
  LiveReview,
  PunchReview,
  SavePunchEditResult,
  StoredPunchRow,
} from '@/features/attendance-sync/types/attendance-sync.types'

// Round 4, item 1 (grid side): when the editor's save is refused because the day changed, the grid reloads
// the review, hands the editor the latest view of that day, and closes the editor if the employee is gone.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }))
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
  // jsdom has no layout; the grid scrolls the open cell into view.
  Element.prototype.scrollIntoView = vi.fn()
})

const WEEK = '2026-11-05'
const DATE = '2026-11-05'
const DATES = getWeekDates(weekFromStartISO(WEEK))
const ASHA = { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const }
const RAVI = { id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const }
const SERVER_MESSAGE = 'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.'

type Row = StoredPunchRow & { employeeId: string; punchDate: Date }
const punch = (employeeId: string, id: string, pairIndex: number, position: 'IN' | 'OUT', time: string, extra: Partial<StoredPunchRow> = {}): Row => ({
  id,
  employeeId,
  punchDate: new Date(`${DATE}T00:00:00Z`),
  pairIndex,
  position,
  source: 'API',
  originalTime: time as StoredPunchRow['originalTime'],
  currentTime: time as StoredPunchRow['currentTime'],
  note: null,
  ...extra,
})

const ASHA_OPENED = [punch('emp-36', 'p-0', 0, 'IN', '07:40'), punch('emp-36', 'p-1', 0, 'OUT', '13:04'), punch('emp-36', 'p-2', 1, 'IN', '13:56'), punch('emp-36', 'p-3', 1, 'OUT', '17:47')]
const ASHA_AFTER_OTHER_TAB = [
  ...ASHA_OPENED,
  punch('emp-36', 'm-in', 2, 'IN', '18:00', { source: 'MANUAL', originalTime: null }),
  punch('emp-36', 'm-out', 2, 'OUT', '19:00', { source: 'MANUAL', originalTime: null }),
]
const RAVI_ROWS = [punch('emp-5', 'r-0', 0, 'IN', '08:00'), punch('emp-5', 'r-1', 0, 'OUT', '16:00')]

function reviewOf(over: { mode?: PunchReview['mode']; locked?: boolean; people?: Array<typeof ASHA>; rows: Row[] }): PunchReview {
  const mode = over.mode ?? { kind: 'LIVE' as const }
  const employees = buildGridEmployees(over.people ?? [ASHA, RAVI], over.rows, DATES)
  const regular = employees.reduce((sum, e) => sum + e.totalRegularHours, 0)
  const overtime = employees.reduce((sum, e) => sum + e.totalOvertimeHours, 0)
  return {
    weekId: WEEK,
    week: { start: WEEK, end: '2026-11-11' },
    status: over.locked ? 'APPROVED' : mode.kind === 'CORRECTION' ? 'APPROVED' : 'REVIEW',
    mode,
    locked: over.locked ?? false,
    employees,
    dates: DATES,
    counts: { needsFixingDays: 0, noPunchEmployees: 0, unusualDays: 0, unresolvedCodes: 0, pendingDecisions: 0, editedDays: 0 },
    totals: { byDay: DATES.map((date) => ({ date, regular: 0, overtime: 0 })), regular, overtime },
    approval: { canApprove: true, blockers: [], weekHasEnded: true },
    payroll: { status: over.locked ? 'NOT_GENERATED' : 'APPROVED', payrollRunId: null, activeCorrectionId: null },
    lastSavedAt: null,
    approvedAt: over.locked ? '2026-11-12T03:00:00.000Z' : null,
  } as PunchReview
}

const dayChangedFailure = { ok: false, error: SERVER_MESSAGE, code: 'DAY_CHANGED' } as ActionResult<SavePunchEditResult>
const save = vi.mocked(savePunchEditAction)
const getReview = vi.mocked(getPunchReviewAction)

function renderLive(initial: PunchReview) {
  return render(<PunchReviewGrid initialReview={initial as LiveReview} backHref="/attendance" backLabel="Attendance" title="Punches" />)
}

const correctionActions: CorrectionGridActions = { reason: null, onApprove: vi.fn(), onAbandon: vi.fn() }

async function openAshasDay() {
  fireEvent.click(screen.getByTestId(`day-cell-${ASHA.employeeId}-${DATE}`))
  await screen.findByTestId('day-editor')
  expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:47')
}

/** Type a new last OUT; the (mocked) server refuses it as a stale day. */
function editLastOut(value = '17:30') {
  const input = screen.getByTestId('editor-pair-2-out')
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

const weekTotalOf = (code: string) => screen.getByTestId(`week-total-${code}`).textContent

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  getReview.mockReset()
  vi.mocked(getApprovalSummaryAction).mockResolvedValue({
    ok: true,
    data: { employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 0, editedDays: 0, editedDayDetails: [], leftOut: [] },
  })
})

describe('PunchReviewGrid reloads the day when the editor is refused with DAY_CHANGED', () => {
  it('replaces the review with the reloaded one and hands the editor the latest times', async () => {
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    const totalBefore = weekTotalOf(ASHA.employeeId)
    save.mockResolvedValue(dayChangedFailure)
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ rows: [...ASHA_AFTER_OTHER_TAB, ...RAVI_ROWS] }) })
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(getReview).toHaveBeenCalledTimes(1)
    expect(getReview).toHaveBeenCalledWith(WEEK, { kind: 'LIVE' })
    // The editor shows the other tab's third pair, and the typed 17:30 is gone.
    expect(screen.getByTestId('editor-pair-3-in')).toHaveValue('18:00')
    expect(screen.getByTestId('editor-pair-3-out')).toHaveValue('19:00')
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:47')
    // And so does the grid behind it: the week total of the employee moved on.
    expect(weekTotalOf(ASHA.employeeId)).not.toBe(totalBefore)
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('the next change entered on the reloaded day is sent against the reloaded day\'s signature', async () => {
    const fresh = reviewOf({ rows: [...ASHA_AFTER_OTHER_TAB, ...RAVI_ROWS] })
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    save.mockResolvedValueOnce(dayChangedFailure).mockResolvedValueOnce({ ok: false, error: 'stop here', code: 'WEEK_LOCKED' } as ActionResult<SavePunchEditResult>)
    getReview.mockResolvedValue({ ok: true, data: fresh })
    await openAshasDay()
    const opened = (await import('@/features/attendance-sync/lib/day-signature')).punchSetSignature

    editLastOut()
    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    editLastOut('17:30')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    const freshDay = fresh.employees.find((e) => e.employeeId === ASHA.id)!.days.find((d) => d.date === DATE)!
    expect(save.mock.calls[0][0].baseSignature).toBe(opened(ASHA_OPENED))
    expect(save.mock.calls[1][0].baseSignature).toBe(freshDay.signature)
    expect(save.mock.calls[1][0].baseSignature).toBe(opened(ASHA_AFTER_OTHER_TAB))
  })

  it('a correction reloads the review in its own mode', async () => {
    const mode = { kind: 'CORRECTION' as const, payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }
    const initial = reviewOf({ mode, rows: [...ASHA_OPENED, ...RAVI_ROWS] }) as CorrectionReview
    render(<PunchReviewGrid initialReview={initial} backHref="/payroll" backLabel="Payroll" title="Punches" correction={correctionActions} />)
    save.mockResolvedValue(dayChangedFailure)
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ mode, rows: [...ASHA_AFTER_OTHER_TAB, ...RAVI_ROWS] }) })
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(getReview).toHaveBeenCalledWith(WEEK, mode)
    expect(save.mock.calls[0][0].mode).toEqual(mode)
    expect(screen.getByTestId('punch-review')).toHaveAttribute('data-mode', 'CORRECTION')
  })

  it('the employee is no longer in the review: the editor closes, the user is told, and the grid drops the row', async () => {
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    save.mockResolvedValue(dayChangedFailure)
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ people: [RAVI], rows: RAVI_ROWS }) })
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That employee is no longer in this week's review."))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`employee-row-${RAVI.employeeId}`)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith("That employee is no longer in this week's review.")
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('unexpected'))
  })

  it('the reload itself fails: the review stays as it was, the editor shows the failure with a retry, the header says Not saved', async () => {
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    const totalBefore = weekTotalOf(ASHA.employeeId)
    save.mockResolvedValue(dayChangedFailure)
    getReview.mockResolvedValue({ ok: false, error: 'Could not load the review.' } as ActionResult<PunchReview>)
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(screen.getByTestId('editor-save-status')).toHaveTextContent(SERVER_MESSAGE)
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
    expect(weekTotalOf(ASHA.employeeId)).toBe(totalBefore)
    expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved')
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('day-editor')).toBeInTheDocument() // the editor stays open on a failed reload
  })

  it('the reload shows the week locked meanwhile: the editor is read only from then on', async () => {
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    save.mockResolvedValue(dayChangedFailure)
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ locked: true, rows: [...ASHA_AFTER_OTHER_TAB, ...RAVI_ROWS] }) })
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(screen.queryAllByRole('textbox').filter((el) => el.getAttribute('data-testid')?.startsWith('editor-pair'))).toHaveLength(0))
    expect(screen.getByTestId('punch-review')).toHaveAttribute('data-locked', 'true')
    expect(screen.getByTestId('editor-pair-3-in')).toHaveTextContent('18:00')
    expect(save).toHaveBeenCalledTimes(1) // and nothing more is sent
  })

  it('another error from the save does not reload anything', async () => {
    renderLive(reviewOf({ rows: [...ASHA_OPENED, ...RAVI_ROWS] }))
    save.mockResolvedValue({ ok: false, error: 'This week is locked. Reopen it to edit punches.', code: 'WEEK_LOCKED' } as ActionResult<SavePunchEditResult>)
    await openAshasDay()

    editLastOut()

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(getReview).not.toHaveBeenCalled()
  })
})
