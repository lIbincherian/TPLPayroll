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

// Two grid contracts, each with the failure that would break it:
//
//  1. The header's "Not saved" is kept per day (a reporter per save from onSaveStart, for the day the save is for).
//     A failed save puts its day in the set, a later successful save of the SAME day takes it out, and the header
//     says "Not saved" while any day is in the set. So an older save that fails late is never hidden by a newer
//     success on another day, and a newer success on another day does not clear an older failure.
//  2. reloadDay (the DAY_CHANGED reload) looks at the editor that is open NOW. If that editor's employee or day is
//     gone from the reloaded review (whichever day it shows) it is closed with the notice; if it shows something that
//     still exists it is left alone (no close, no toast, draft kept) and only the review data is updated, and the old
//     save counts as not saved.

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
const at = (time: string) => time as StoredPunchRow['currentTime']

const ASHA_DAY1 = [
  punch('emp-36', 'p-0', DATE, 0, 'IN', '07:40'),
  punch('emp-36', 'p-1', DATE, 0, 'OUT', '13:04'),
  punch('emp-36', 'p-2', DATE, 1, 'IN', '13:56'),
  punch('emp-36', 'p-3', DATE, 1, 'OUT', '17:47'),
]
const ASHA_DAY2 = [punch('emp-36', 'n-0', NEXT_DATE, 0, 'IN', '08:00'), punch('emp-36', 'n-1', NEXT_DATE, 0, 'OUT', '16:00')]
const ASHA_DAY1_AFTER_OTHER_TAB = [
  ...ASHA_DAY1,
  punch('emp-36', 'm-in', DATE, 2, 'IN', '18:00', { source: 'MANUAL', originalTime: null }),
  punch('emp-36', 'm-out', DATE, 2, 'OUT', '19:00', { source: 'MANUAL', originalTime: null }),
]
const RAVI_ROWS = [punch('emp-5', 'r-0', DATE, 0, 'IN', '08:00'), punch('emp-5', 'r-1', DATE, 0, 'OUT', '16:00')]

function reviewOf(over: { people?: Array<typeof ASHA>; rows: Row[] }): PunchReview {
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
    lastSavedAt: null,
    approvedAt: null,
  } as PunchReview
}

/** What the server answers when a save lands: the saved day plus the display data of the review. */
function savedResult(date: string, rows: Row[]): ActionResult<SavePunchEditResult> {
  // The saved day is Asha's: Ravi has punches on the same date and they must not leak into her day.
  const day = buildDayView(date, rows.filter((r) => r.employeeId === 'emp-36' && r.punchDate.toISOString().startsWith(date)))
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
type SaveResult = ActionResult<SavePunchEditResult>

const renderLive = (initial: PunchReview) =>
  render(<PunchReviewGrid initialReview={initial as LiveReview} backHref="/attendance" backLabel="Attendance" title="Punches" />)

const cell = (code: string, date: string) => screen.getByTestId(`day-cell-${code}-${date}`)
const settle = () => new Promise((r) => setTimeout(r, 30))
const header = () => screen.queryByTestId('saved-status')

async function openDay(code: string, date: string) {
  fireEvent.click(cell(code, date))
  await waitFor(() => expect(screen.getByTestId('editor-day-label')).toHaveTextContent(code))
}

function type(testId: string, value: string, enter = true) {
  const input = screen.getByTestId(testId)
  fireEvent.change(input, { target: { value } })
  if (enter) fireEvent.keyDown(input, { key: 'Enter' })
}

/** Asha's first day: type the last OUT and keep that save in flight (the first save of the test). */
async function saveOnDay1() {
  const inFlight = deferred<SaveResult>()
  save.mockImplementationOnce(() => inFlight.promise)
  type('editor-pair-2-out', '17:30')
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  return inFlight
}

const stepToNextDay = async () => {
  fireEvent.click(screen.getByTestId('editor-next'))
  await waitFor(() => expect(screen.getByTestId('editor-day-label')).toHaveTextContent('Fri'))
}

/** On Asha's next day, type the OUT and keep that save in flight (the second save of the test). */
async function saveOnDay2(calls = 2) {
  const inFlight = deferred<SaveResult>()
  save.mockImplementationOnce(() => inFlight.promise)
  type('editor-pair-1-out', '17:00')
  await waitFor(() => expect(save).toHaveBeenCalledTimes(calls))
  return inFlight
}

const day1With1730 = (rows: Row[] = [...ASHA_DAY2, ...RAVI_ROWS]) =>
  savedResult(DATE, [...ASHA_DAY1.map((r) => (r.id === 'p-3' ? { ...r, currentTime: at('17:30') } : r)), ...rows])
const day2With1700 = () =>
  savedResult(NEXT_DATE, [...ASHA_DAY1, ...ASHA_DAY2.map((r) => (r.id === 'n-1' ? { ...r, currentTime: at('17:00') } : r)), ...RAVI_ROWS])

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  getReview.mockReset()
  vi.mocked(getApprovalSummaryAction).mockResolvedValue({
    ok: true,
    data: { employeeCount: 2, totalRegularHours: 16, totalOvertimeHours: 0, editedDays: 0, editedDayDetails: [], leftOut: [] },
  })
})

const allRows = () => [...ASHA_DAY1, ...ASHA_DAY2, ...RAVI_ROWS]

// ─── 1. The header follows the newest save ────────────────────────────────────

describe('PunchReviewGrid header: "Not saved" is kept per day', () => {
  async function twoSavesInFlight() {
    renderLive(reviewOf({ rows: allRows() }))
    await openDay(ASHA.employeeId, DATE)
    const older = await saveOnDay1() // started first: the older save
    await stepToNextDay()
    const newer = await saveOnDay2() // started second: the newer save
    return { older, newer }
  }

  it('an older save that succeeds late cannot clear the failure of a newer save', async () => {
    const { older, newer } = await twoSavesInFlight()
    newer.resolve(weekLocked)
    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))

    older.resolve(day1With1730())

    // The older save still lands in the grid...
    await waitFor(() => expect(cell(ASHA.employeeId, DATE)).toHaveTextContent('17:30'))
    await settle()
    // ...but it does not get to say "Saved" over the newer save's failure.
    expect(header()).toHaveTextContent('Not saved')
    expect(header()).not.toHaveTextContent(/^Saved/)
  })

  it('an older save that fails late still shows "Not saved": the newer success was for another day', async () => {
    const { older, newer } = await twoSavesInFlight()
    newer.resolve(day2With1700())
    await waitFor(() => expect(header()).toHaveTextContent('Saved'))

    older.resolve(weekLocked)

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
  })

  it('an older save that fails late shows "Not saved" the same way when the network drops', async () => {
    const { older, newer } = await twoSavesInFlight()
    newer.resolve(day2With1700())
    await waitFor(() => expect(header()).toHaveTextContent('Saved'))

    older.reject(new Error('Failed to fetch'))

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
  })

  it('a newer save of another day that succeeds does not clear the failure the older day reported first', async () => {
    const { older, newer } = await twoSavesInFlight()
    older.resolve(weekLocked)
    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))

    newer.resolve(day2With1700())

    await waitFor(() => expect(cell(ASHA.employeeId, NEXT_DATE)).toHaveTextContent('17:00')) // the newer save landed
    await settle()
    expect(header()).toHaveTextContent('Not saved') // the first day is still unsaved
  })

  it('a newer save that fails replaces the success the older save reported first', async () => {
    const { older, newer } = await twoSavesInFlight()
    older.resolve(day1With1730())
    await waitFor(() => expect(header()).toHaveTextContent('Saved'))

    newer.resolve(weekLocked)

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
  })

  it('a save that starts after another has already reported always sets the header (a later failure shows)', async () => {
    renderLive(reviewOf({ rows: allRows() }))
    await openDay(ASHA.employeeId, DATE)
    const first = await saveOnDay1()
    first.resolve(day1With1730())
    await waitFor(() => expect(header()).toHaveTextContent('Saved'))
    await stepToNextDay()

    const second = await saveOnDay2()
    second.resolve(weekLocked)

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
  })

  it('an edit queued behind a save and sent after the editor closed is a newer save: its failure shows after the first one landed', async () => {
    renderLive(reviewOf({ rows: allRows() }))
    await openDay(ASHA.employeeId, DATE)
    const first = await saveOnDay1()
    type('editor-pair-1-in', '07:30') // queued behind the first save
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    save.mockResolvedValueOnce(weekLocked) // the flushed follow-up is refused
    first.resolve(day1With1730())

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
    expect(save).toHaveBeenCalledTimes(2) // sent once, not looped
  })

  it('an edit queued behind a save that failed is sent after the close, and its success clears the failure', async () => {
    renderLive(reviewOf({ rows: allRows() }))
    await openDay(ASHA.employeeId, DATE)
    const first = await saveOnDay1()
    type('editor-pair-1-in', '07:30')
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    save.mockResolvedValueOnce(
      savedResult(DATE, [...ASHA_DAY1.map((r) => (r.id === 'p-0' ? { ...r, currentTime: at('07:30') } : r)), ...ASHA_DAY2, ...RAVI_ROWS]),
    )
    first.resolve(weekLocked)

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(header()).toHaveTextContent('Saved'))
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
  })

  it('closing the editor still clears the header; a report from a save that started before the close can set it again', async () => {
    renderLive(reviewOf({ rows: allRows() }))
    await openDay(ASHA.employeeId, DATE)
    const inFlight = await saveOnDay1()
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    expect(header()).not.toBeInTheDocument()

    inFlight.resolve(weekLocked)

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
  })
})

// ─── 2. reloadDay only closes the editor that still shows the refused day ─────

describe('PunchReviewGrid reloadDay: the editor is closed only when it still shows the day that was reloaded', () => {
  const withoutAsha = () => reviewOf({ people: [RAVI], rows: RAVI_ROWS })

  /** Open Asha's day, have a save refused as DAY_CHANGED, and hold the reload that follows. */
  async function refusedWithReloadInFlight() {
    renderLive(reviewOf({ rows: allRows() }))
    const reload = deferred<{ ok: true; data: PunchReview }>()
    getReview.mockImplementationOnce(() => reload.promise as ReturnType<typeof getPunchReviewAction>)
    await openDay(ASHA.employeeId, DATE)
    const inFlight = await saveOnDay1()
    inFlight.resolve(dayChangedFailure)
    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(1))
    return reload
  }

  it('contrast: the user is still on the refused day and the employee is gone: the editor closes and the user is told once', async () => {
    const reload = await refusedWithReloadInFlight()

    reload.resolve({ ok: true, data: withoutAsha() })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That employee is no longer in this week's review."))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument()
    expect(header()).not.toBeInTheDocument() // the grid cleared the header itself and nothing more is reported
  })

  it('the user opened another employee\'s day while the reload ran: that editor stays open with its draft, and no toast is shown', async () => {
    const reload = await refusedWithReloadInFlight()
    await openDay(RAVI.employeeId, DATE)
    type('editor-pair-1-out', '15:00', false) // a draft that has not been sent
    expect(screen.getByTestId('editor-pair-1-out')).toHaveValue('15:00')

    reload.resolve({ ok: true, data: withoutAsha() })
    await waitFor(() => expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument()) // the review was updated
    await settle()

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('day-editor')).toBeInTheDocument()
    expect(screen.getByTestId('editor-day-label')).toHaveTextContent(RAVI.employeeId)
    expect(screen.getByTestId('editor-pair-1-out')).toHaveValue('15:00')
    expect(save).toHaveBeenCalledTimes(1) // the draft was not sent, and the refused one was not sent again
    expect(getReview).toHaveBeenCalledTimes(1)
  })

  it('the user opened another employee\'s day: the old save counts as not saved', async () => {
    const reload = await refusedWithReloadInFlight()
    await openDay(RAVI.employeeId, DATE)

    reload.resolve({ ok: true, data: withoutAsha() })

    await waitFor(() => expect(header()).toHaveTextContent('Not saved'))
    expect(screen.getByTestId('editor-day-label')).toHaveTextContent(RAVI.employeeId)
  })

  it('the user stepped to the next day while the reload ran and the employee is still in the review: no close, no toast, the review is refreshed', async () => {
    const reload = await refusedWithReloadInFlight()
    await stepToNextDay()
    type('editor-pair-1-out', '16:30', false)

    const totalBefore = screen.getByTestId(`week-total-${ASHA.employeeId}`).textContent

    reload.resolve({ ok: true, data: reviewOf({ rows: [...ASHA_DAY1_AFTER_OTHER_TAB, ...ASHA_DAY2, ...RAVI_ROWS] }) })

    // The other tab's extra hour is now in Asha's week total.
    await waitFor(() => expect(screen.getByTestId(`week-total-${ASHA.employeeId}`).textContent).not.toBe(totalBefore))
    await settle()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('day-editor')).toBeInTheDocument()
    expect(screen.getByTestId('editor-day-label')).toHaveTextContent('Fri')
    expect(screen.getByTestId('editor-pair-1-out')).toHaveValue('16:30')
    expect(header()).toHaveTextContent('Not saved') // the old edit was never saved
    expect(save).toHaveBeenCalledTimes(1)
  })

  async function steppedToAnotherDayOfAshaWhileAshaIsGone() {
    const reload = await refusedWithReloadInFlight()
    await stepToNextDay()
    type('editor-pair-1-out', '16:30', false)

    reload.resolve({ ok: true, data: withoutAsha() })
    await waitFor(() => expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument())
    await settle()
  }

  it('the user stepped to the next day of the SAME employee while the reload ran and that employee is gone: the editor shows a day that no longer exists, so it closes with the toast', async () => {
    await steppedToAnotherDayOfAshaWhileAshaIsGone()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith("That employee is no longer in this week's review.")
    expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument()
    expect(header()).not.toBeInTheDocument() // the day left the review: nothing is left to save, so nothing is "Not saved"
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('...and the open panel is not left empty: the employee is no longer in the review, so whatever the grid does it must not leave a blank, unexplained sheet', async () => {
    await steppedToAnotherDayOfAshaWhileAshaIsGone()

    // Asha is gone, so the editor for her other day has nothing to show. Closing it (with or without a notice) is fine;
    // an open sheet with no content is not: the user's draft has vanished and nothing says why.
    const sheet = screen.queryByTestId('day-editor-sheet')
    expect(sheet === null || (sheet.textContent ?? '').trim() !== '').toBe(true)
  })

  it('the user closed the editor while the reload ran and the employee is gone: no toast (nothing is open to close)', async () => {
    const reload = await refusedWithReloadInFlight()
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())

    reload.resolve({ ok: true, data: withoutAsha() })
    await waitFor(() => expect(screen.queryByTestId(`employee-row-${ASHA.employeeId}`)).not.toBeInTheDocument())
    await settle()

    expect(toast.error).not.toHaveBeenCalled()
    expect(header()).toHaveTextContent('Not saved')
  })

  it('the user closed the editor and reopened the same employee and day while the reload ran: that editor is the refused day, so it closes with the toast', async () => {
    const reload = await refusedWithReloadInFlight()
    fireEvent.click(screen.getByTestId('editor-close'))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
    await openDay(ASHA.employeeId, DATE)

    reload.resolve({ ok: true, data: withoutAsha() })

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('day-editor')).not.toBeInTheDocument())
  })

  it('a reload that fails changes nothing: no close, no toast, the editor the user is on stays', async () => {
    const reload = await refusedWithReloadInFlight()
    await openDay(RAVI.employeeId, DATE)

    reload.resolve({ ok: false, error: 'boom' } as unknown as { ok: true; data: PunchReview })
    await settle()

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('editor-day-label')).toHaveTextContent(RAVI.employeeId)
    expect(screen.getByTestId(`employee-row-${ASHA.employeeId}`)).toBeInTheDocument() // the review was not replaced
    expect(header()).toHaveTextContent('Not saved')
  })
})
