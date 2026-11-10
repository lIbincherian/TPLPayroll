import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { PunchReviewGrid } from '@/features/attendance-sync/components/PunchReviewGrid'
import { getApprovalSummaryAction, getPunchReviewAction, savePunchEditAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { buildGridEmployees } from '@/features/attendance-sync/lib/review'
import { buildDayView } from '@/features/attendance-sync/lib/hours'
import { getWeekDates, weekFromStartISO } from '@/features/attendance-sync/lib/week'
import type {
  ActionResult,
  LiveReview,
  PunchReview,
  SavePunchEditResult,
  StoredPunchRow,
} from '@/features/attendance-sync/types/attendance-sync.types'

// The grid header ("Saved 10:42" / "Not saved") must tell the truth about the LAST save, including a save that
// was still in flight when the user stepped to another day or closed the editor. The editor reports such a save
// to the grid (the reporter it gets from onSaveStart, and onSaved); only a day that left the review during a
// DAY_CHANGED reload is silent, because the grid closed the editor and cleared the header itself. An edit that
// was queued behind the in-flight save before the editor closed is still sent, and that save is reported too.
// After the close a DAY_CHANGED refusal is a failed save, not a reload.

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
  Element.prototype.scrollIntoView = vi.fn()
})

const WEEK = '2026-11-05'
const DATE = '2026-11-05'
const NEXT_DATE = '2026-11-06'
const DATES = getWeekDates(weekFromStartISO(WEEK))
const ASHA = { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const }
const RAVI = { id: 'emp-5', employeeId: 'TPLGOAHLP005', employeeName: 'Ravi Kumar', isActive: true, dateOfResignation: null, tag: 'ACTIVE' as const }
const SERVER_MESSAGE = 'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.'

type Row = StoredPunchRow & { employeeId: string; punchDate: Date }
const punch = (employeeId: string, id: string, date: string, pairIndex: number, position: 'IN' | 'OUT', time: string, extra: Partial<StoredPunchRow> = {}): Row => ({
  id,
  employeeId,
  punchDate: new Date(`${date}T00:00:00Z`),
  pairIndex,
  position,
  source: 'API',
  originalTime: time as StoredPunchRow['originalTime'],
  currentTime: time as StoredPunchRow['currentTime'],
  note: null,
  ...extra,
})

const ASHA_ROWS = [
  punch('emp-36', 'p-0', DATE, 0, 'IN', '07:40'),
  punch('emp-36', 'p-1', DATE, 0, 'OUT', '13:04'),
  punch('emp-36', 'p-2', DATE, 1, 'IN', '13:56'),
  punch('emp-36', 'p-3', DATE, 1, 'OUT', '17:47'),
]
const ASHA_NEXT_DAY_ROWS = [punch('emp-36', 'n-0', NEXT_DATE, 0, 'IN', '08:00'), punch('emp-36', 'n-1', NEXT_DATE, 0, 'OUT', '16:00')]
const ASHA_AFTER_OTHER_TAB = [
  ...ASHA_ROWS,
  punch('emp-36', 'm-in', DATE, 2, 'IN', '18:00', { source: 'MANUAL', originalTime: null }),
  punch('emp-36', 'm-out', DATE, 2, 'OUT', '19:00', { source: 'MANUAL', originalTime: null }),
]
const RAVI_ROWS = [punch('emp-5', 'r-0', DATE, 0, 'IN', '08:00'), punch('emp-5', 'r-1', DATE, 0, 'OUT', '16:00')]

function reviewOf(over: { people?: Array<typeof ASHA>; rows: Row[]; lastSavedAt?: string | null }): PunchReview {
  const employees = buildGridEmployees(over.people ?? [ASHA, RAVI], over.rows, DATES)
  const regular = employees.reduce((sum, e) => sum + e.totalRegularHours, 0)
  const overtime = employees.reduce((sum, e) => sum + e.totalOvertimeHours, 0)
  return {
    weekId: WEEK,
    week: { start: WEEK, end: '2026-11-11' },
    status: 'REVIEW',
    mode: { kind: 'LIVE' as const },
    locked: false,
    employees,
    dates: DATES,
    counts: { needsFixingDays: 0, noPunchEmployees: 0, unusualDays: 0, unresolvedCodes: 0, pendingDecisions: 0, editedDays: 0 },
    totals: { byDay: DATES.map((date) => ({ date, regular: 0, overtime: 0 })), regular, overtime },
    approval: { canApprove: true, blockers: [], weekHasEnded: true },
    payroll: { status: 'NOT_GENERATED', payrollRunId: null, activeCorrectionId: null },
    lastSavedAt: over.lastSavedAt ?? null,
    approvedAt: null,
  } as PunchReview
}

/** What the server answers when a save lands: the saved day plus the display data of the review. */
function savedResult(date: string, rows: Row[]): ActionResult<SavePunchEditResult> {
  const day = buildDayView(date, rows.filter((r) => r.punchDate.toISOString().startsWith(date)))
  const base = reviewOf({ rows })
  return {
    ok: true,
    data: {
      day,
      employeeTotals: { regular: 8, overtime: 0, hasAnyPunch: true },
      counts: base.counts,
      totals: base.totals,
      approval: base.approval,
      savedAt: '2026-11-13T05:12:00.000Z',
    },
  } as ActionResult<SavePunchEditResult>
}

const failure = (code: string, error: string) => ({ ok: false, error, code }) as ActionResult<SavePunchEditResult>
const dayChangedFailure = failure('DAY_CHANGED', SERVER_MESSAGE)
const weekLocked = failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.')

const save = vi.mocked(savePunchEditAction)
const getReview = vi.mocked(getPunchReviewAction)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const renderLive = (initial: PunchReview) =>
  render(<PunchReviewGrid initialReview={initial as LiveReview} backHref="/attendance" backLabel="Attendance" title="Punches" />)

const cell = (code: string, date: string) => screen.getByTestId(`day-cell-${code}-${date}`)
const settle = () => new Promise((r) => setTimeout(r, 30))

async function openAshasDay(date = DATE) {
  fireEvent.click(cell(ASHA.employeeId, date))
  await screen.findByTestId('day-editor')
  expect(screen.getByTestId('editor-day-label')).toHaveTextContent(ASHA.employeeId)
}

function editLastOut(value = '17:30') {
  const input = screen.getByTestId('editor-pair-2-out')
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

/** Type the last OUT of Asha's first day and keep that save in flight. */
async function saveInFlight() {
  const inFlight = deferred<ActionResult<SavePunchEditResult>>()
  save.mockImplementationOnce(() => inFlight.promise)
  editLastOut()
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  return inFlight
}

const stepToNextDay = async () => {
  fireEvent.click(screen.getByTestId('editor-next'))
  await waitFor(() => expect(screen.getByTestId('editor-day-label')).toHaveTextContent('Fri'))
}

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  getReview.mockReset()
  vi.mocked(getApprovalSummaryAction).mockResolvedValue({
    ok: true,
    data: { employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 0, editedDays: 0, editedDayDetails: [], leftOut: [] },
  })
})

// ─── Gone ─────────────────────────────────────────────────────────────────────

describe('PunchReviewGrid: the employee left the review while a refused save was being reloaded', () => {
  async function runGone(over: { queueAnotherEdit?: boolean } = {}) {
    renderLive(reviewOf({ rows: [...ASHA_ROWS, ...RAVI_ROWS] }))
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ people: [RAVI], rows: RAVI_ROWS }) })
    await openAshasDay()
    const inFlight = await saveInFlight()
    if (over.queueAnotherEdit) {
      const first = screen.getByTestId('editor-pair-1-in')
      fireEvent.change(first, { target: { value: '07:30' } })
      fireEvent.keyDown(first, { key: 'Enter' })
    }
    inFlight.resolve(dayChangedFailure)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That employee is no longer in this week's review."))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    await settle()
  }

  it('the header does not say "Not saved" for a day nobody is editing any more', async () => {
    await runGone()

    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
    expect(screen.queryByTestId('saved-status')).not.toBeInTheDocument()
  })

  it('the user is told once, the employee\'s row is dropped, and exactly one save was ever sent', async () => {
    await runGone()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`employee-row-${RAVI.employeeId}`)).toBeInTheDocument()
    expect(save).toHaveBeenCalledTimes(1)
    expect(getReview).toHaveBeenCalledTimes(1)
  })

  it('an edit queued behind the refused save is not resent', async () => {
    await runGone({ queueAnotherEdit: true })

    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
  })
})

// ─── Step away / close with a save in flight ──────────────────────────────────

describe('PunchReviewGrid: the user steps to another day while a save is in flight', () => {
  const rows = () => [...ASHA_ROWS, ...ASHA_NEXT_DAY_ROWS, ...RAVI_ROWS]

  it('the save is refused: the header says "Not saved" even though the editor now shows another day', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    await stepToNextDay()
    expect(screen.queryByTestId('saved-status')).not.toBeInTheDocument() // nothing has failed yet

    inFlight.resolve(weekLocked)

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
    expect(screen.getByTestId('day-editor')).toBeInTheDocument()
    expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:47') // the grid still shows what is stored
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('the request fails (network): the header says "Not saved"', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    await stepToNextDay()

    inFlight.reject(new Error('Failed to fetch'))

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
    expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:47')
  })

  it('the save is refused as DAY_CHANGED: the header says "Not saved" and the review is not reloaded under the editor that is open now', async () => {
    renderLive(reviewOf({ rows: rows() }))
    const totalBefore = screen.getByTestId(`week-total-${ASHA.employeeId}`).textContent
    getReview.mockResolvedValue({ ok: true, data: reviewOf({ rows: [...ASHA_AFTER_OTHER_TAB, ...ASHA_NEXT_DAY_ROWS, ...RAVI_ROWS] }) })
    await openAshasDay()
    const inFlight = await saveInFlight()
    await stepToNextDay()

    inFlight.resolve(dayChangedFailure)

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
    await settle()
    // A reload would let the grid close the editor the user has open now (and lose its draft), so none happens.
    expect(getReview).not.toHaveBeenCalled()
    expect(screen.getByTestId(`week-total-${ASHA.employeeId}`).textContent).toBe(totalBefore)
    // The editor that is open now is for the next day and does not carry the old day's notice.
    expect(screen.getByTestId('day-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
  })

  it('the save lands: the grid shows it on the day it was made on, the editor stays on the next day, and nothing says "Not saved"', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    await stepToNextDay()

    inFlight.resolve(savedResult(DATE, [...ASHA_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r)), ...ASHA_NEXT_DAY_ROWS, ...RAVI_ROWS]))

    await waitFor(() => expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:30'))
    expect(cell(ASHA.employeeId, NEXT_DATE)).toHaveTextContent('16:00') // the other day is untouched
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
    expect(screen.getByTestId('saved-status')).toHaveTextContent('Saved')
    expect(screen.getByTestId('editor-pair-1-out')).toHaveValue('16:00') // still the next day's editor
  })

  it('a later save in the new editor clears the "Not saved" the step-away left', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    await stepToNextDay()
    inFlight.resolve(weekLocked)
    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
    save.mockResolvedValueOnce(savedResult(NEXT_DATE, [...ASHA_ROWS, ...ASHA_NEXT_DAY_ROWS.map((r) => (r.id === 'n-1' ? { ...r, currentTime: '17:00' as StoredPunchRow['currentTime'] } : r)), ...RAVI_ROWS]))

    const out = screen.getByTestId('editor-pair-1-out')
    fireEvent.change(out, { target: { value: '17:00' } })
    fireEvent.keyDown(out, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Saved'))
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe('PunchReviewGrid: the user closes the editor while a save is in flight', () => {
  const rows = () => [...ASHA_ROWS, ...RAVI_ROWS]

  it('the save is refused after the editor closed: the header says "Not saved" (closing had cleared it)', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()

    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    expect(screen.queryByTestId('saved-status')).not.toBeInTheDocument()
    inFlight.resolve(weekLocked)

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
    expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:47')
  })

  it('the request fails after the editor closed: "Not saved" as well', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    inFlight.reject(new Error('Failed to fetch'))

    await waitFor(() => expect(screen.getByTestId('saved-status')).toHaveTextContent('Not saved'))
  })

  it('the save lands after the editor closed: the grid shows it and the header says "Saved"', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    inFlight.resolve(savedResult(DATE, [...ASHA_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r)), ...RAVI_ROWS]))

    await waitFor(() => expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:30'))
    expect(screen.getByTestId('saved-status')).toHaveTextContent('Saved')
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
  })

  it('an edit queued behind the save is still sent once the editor is closed, and the header reports that save', async () => {
    renderLive(reviewOf({ rows: rows() }))
    await openAshasDay()
    const inFlight = await saveInFlight()
    const first = screen.getByTestId('editor-pair-1-in')
    fireEvent.change(first, { target: { value: '07:30' } })
    fireEvent.keyDown(first, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    const withOut = ASHA_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r))
    const withBoth = withOut.map((r) => (r.id === 'p-0' ? { ...r, currentTime: '07:30' as StoredPunchRow['currentTime'] } : r))
    save.mockResolvedValueOnce(savedResult(DATE, withBoth))
    inFlight.resolve(savedResult(DATE, withOut))

    await waitFor(() => expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('07:30'))
    await settle()

    expect(save).toHaveBeenCalledTimes(2)
    expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:30')
    expect(screen.getByTestId('saved-status')).toHaveTextContent('Saved')
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
  })
})
