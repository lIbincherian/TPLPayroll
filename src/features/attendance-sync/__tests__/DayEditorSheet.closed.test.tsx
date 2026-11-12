import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DayEditorSheet, type DayReload } from '@/features/attendance-sync/components/DayEditorSheet'
import { savePunchEditAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { buildDayView } from '@/features/attendance-sync/lib/hours'
import type {
  ActionResult,
  DayView,
  GridEmployee,
  ISODate,
  ReviewMode,
  SavePunchEditResult,
  StoredPunchRow,
} from '@/features/attendance-sync/types/attendance-sync.types'

// What a day editor reports, and does, once it is no longer the editor the user is looking at.
//
//  - "closed" means the body is unmounted (the user stepped to another day or closed the editor) or the grid
//    reported the day gone (a DAY_CHANGED reload found the employee or day missing; the grid has already closed
//    the editor and cleared its header, but React has not unmounted the body yet).
//  - A closed body starts no new save on its own (a blur or Enter) and updates none of its own state.
//  - It still reports a save that was already in flight to the grid, because the grid's header must never claim
//    an edit was saved when it was not: a failure through the reporter of that save (onSaveStart) as true, a
//    success as false plus onSaved. Only the 'gone' close, which the grid itself caused, reports nothing.
//  - An edit that was queued behind the in-flight save before the close is still sent when that save returns,
//    from the refs, and its outcome is reported the same way.
//  - A DAY_CHANGED refusal after the close is a failed save for the header. It is never reloaded: that could
//    make the grid close whichever editor the user has open by then.

vi.mock('@/features/attendance-sync/actions/attendance-sync.actions', () => ({ savePunchEditAction: vi.fn() }))

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

const DATE = '2026-11-05'
const NEXT_DATE = '2026-11-06'
const SERVER_MESSAGE = 'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.'

const row = (id: string, pairIndex: number, position: 'IN' | 'OUT', time: string): StoredPunchRow => ({
  id,
  pairIndex,
  position,
  source: 'API',
  originalTime: time as StoredPunchRow['originalTime'],
  currentTime: time as StoredPunchRow['currentTime'],
  note: null,
})

const rowsFor = (prefix: string) => [row(`${prefix}-0`, 0, 'IN', '07:40'), row(`${prefix}-1`, 0, 'OUT', '13:04'), row(`${prefix}-2`, 1, 'IN', '13:56'), row(`${prefix}-3`, 1, 'OUT', '17:47')]
const OPENED = buildDayView(DATE, rowsFor('p'))
const NEXT_DAY = buildDayView(NEXT_DATE, rowsFor('n'))
const AFTER_OTHER_TAB = buildDayView(DATE, [
  ...rowsFor('p'),
  { ...row('m-in', 2, 'IN', '18:00'), source: 'MANUAL', originalTime: null },
  { ...row('m-out', 2, 'OUT', '19:00'), source: 'MANUAL', originalTime: null },
])

const EMPLOYEE: GridEmployee = {
  employeeId: 'emp-36',
  employeeCode: 'TPLGOAHLP036',
  employeeName: 'Asha Rao',
  tag: 'ACTIVE',
  days: [],
  totalRegularHours: 0,
  totalOvertimeHours: 0,
  hasAnyPunch: true,
}

const LIVE: ReviewMode = { kind: 'LIVE' }
const save = vi.mocked(savePunchEditAction)

const savedWith = (day: DayView): ActionResult<SavePunchEditResult> =>
  ({ ok: true, data: { day, savedAt: '2026-11-13T05:00:00.000Z' } as unknown as SavePunchEditResult }) as ActionResult<SavePunchEditResult>
const failure = (code: string, error: string) => ({ ok: false, error, code }) as ActionResult<SavePunchEditResult>
const dayChanged = failure('DAY_CHANGED', SERVER_MESSAGE)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const onSaved = vi.fn()
const onSaveFailed = vi.fn()
const onClose = vi.fn()
const onDayChanged = vi.fn<(employeeId: string, date: ISODate) => Promise<DayReload>>()

function renderEditor(day: DayView = OPENED) {
  const element = (employee: GridEmployee | null, current: DayView | null) => (
    <DayEditorSheet
      open
      onClose={onClose}
      weekId="2026-11-05"
      mode={LIVE}
      employee={employee}
      day={current}
      readOnly={false}
      canStepPrevious={false}
      canStepNext
      onStep={vi.fn()}
      onSaved={onSaved}
      onSaveStart={() => onSaveFailed}
      onDayChanged={onDayChanged}
    />
  )
  const view = render(element(EMPLOYEE, day))
  return {
    ...view,
    /** The user steps to the next day: the body of this day is unmounted and a new one takes its place. */
    stepAway: () => view.rerender(element(EMPLOYEE, NEXT_DAY)),
    /** The grid closes the editor: no body at all. */
    closeEditor: () => view.rerender(element(null, null)),
  }
}

function enter(testId: string, value: string) {
  const input = screen.getByTestId(testId)
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const status = () => screen.getByTestId('editor-save-status')

/** Start a save that stays in flight until the test resolves it. */
async function saveInFlight() {
  const inFlight = deferred<ActionResult<SavePunchEditResult>>()
  save.mockImplementationOnce(() => inFlight.promise)
  enter('editor-pair-2-out', '17:30')
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  return inFlight
}

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  onDayChanged.mockReset()
})

// ─── The grid closed the editor: the day is gone ──────────────────────────────

describe('DayEditorSheet when the DAY_CHANGED reload reports the day gone', () => {
  it('reports nothing to the grid: not a failure, not a success (the grid has closed the editor and cleared its header)', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockResolvedValue('gone')
    renderEditor()

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))
    await settle()

    expect(onSaveFailed).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    expect(onDayChanged).toHaveBeenCalledWith('emp-36', DATE)
  })

  it('leaves its own state alone: no day-changed notice, no failure message, no retry, the typed time is not reset', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockResolvedValue('gone')
    renderEditor()

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))
    await settle()

    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('editor-retry')).not.toBeInTheDocument()
    expect(status()).not.toHaveTextContent(SERVER_MESSAGE)
    expect(status()).not.toHaveTextContent('Saved')
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:30')
  })

  it('a blur or Enter from the input that is still mounted starts no save, so the refused draft is not sent again', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockResolvedValue('gone')
    renderEditor()
    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))
    await settle()

    const input = screen.getByTestId('editor-pair-2-out')
    fireEvent.blur(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(screen.getByTestId('editor-pair-1-in'), { target: { value: '07:30' } })
    fireEvent.blur(screen.getByTestId('editor-pair-1-in'))
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
    expect(onDayChanged).toHaveBeenCalledTimes(1)
    expect(onSaveFailed).not.toHaveBeenCalled()
  })

  it('an edit queued while the refused save was in flight is dropped with it', async () => {
    renderEditor()
    const inFlight = await saveInFlight()
    onDayChanged.mockResolvedValue('gone')
    enter('editor-pair-1-in', '07:30') // queued behind the save that is about to be refused

    inFlight.resolve(dayChanged)
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
    expect(onSaveFailed).not.toHaveBeenCalled()
  })

  it('an Enter in a note box does not send anything either', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockResolvedValue('gone')
    // A day that already lists a change, so it has a note box.
    const edited = buildDayView(DATE, [
      row('p-0', 0, 'IN', '07:40'),
      row('p-1', 0, 'OUT', '13:04'),
      { ...row('p-2', 1, 'IN', '13:56'), currentTime: '14:00' as StoredPunchRow['currentTime'] },
      row('p-3', 1, 'OUT', '17:47'),
    ])
    renderEditor(edited)
    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))
    await settle()

    const note = screen.getByTestId('editor-note-1')
    fireEvent.change(note, { target: { value: 'late' } })
    fireEvent.keyDown(note, { key: 'Enter' })
    fireEvent.blur(note)
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('contrast: a reload that returns the day (not gone) still resets the editor and reports "not failed"', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockResolvedValue(AFTER_OTHER_TAB)
    renderEditor()

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(onSaveFailed).toHaveBeenLastCalledWith(false)
    expect(screen.getByTestId('editor-pair-3-in')).toHaveValue('18:00')
  })
})

describe('DayEditorSheet when the editor is still open and the DAY_CHANGED reload throws', () => {
  it('shows the generic failure with a retry and tells the grid the save failed', async () => {
    save.mockResolvedValue(dayChanged)
    onDayChanged.mockRejectedValue(new Error('Failed to fetch'))
    renderEditor()

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(status()).toHaveTextContent("Couldn't save. Your last saved times are unchanged.")
    expect(onSaveFailed).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:30') // what the user typed is kept
  })
})

// ─── The user moved on: the body is unmounted, the save is still in flight ────

describe.each([
  ['steps to another day', 'stepAway' as const],
  ['closes the editor', 'closeEditor' as const],
])('DayEditorSheet when the user %s while a save is in flight', (_label, leave) => {
  it('a save that fails (the server refuses it) is reported to the grid as a failure, and not as a success', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    view[leave]()

    inFlight.resolve(failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.'))
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1))

    expect(onSaveFailed).toHaveBeenCalledWith(true)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onDayChanged).not.toHaveBeenCalled()
  })

  it('a save that throws (the network dropped) is reported as a failure too', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    view[leave]()

    inFlight.reject(new Error('Failed to fetch'))
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1))

    expect(onSaveFailed).toHaveBeenCalledWith(true)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a save that lands is reported as saved, with the day it was made on, not the day the editor shows now', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    const result = savedWith(buildDayView(DATE, rowsFor('p').map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r))))
    view[leave]()

    inFlight.resolve(result)
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

    expect(onSaved).toHaveBeenCalledWith('emp-36', DATE, (result as { data: SavePunchEditResult }).data)
    expect(onSaveFailed).toHaveBeenCalledTimes(1)
    expect(onSaveFailed).toHaveBeenCalledWith(false)
    expect(onSaveFailed).not.toHaveBeenCalledWith(true)
  })

  it('a DAY_CHANGED refusal is a failed save for the header and is not reloaded (the grid would close the editor the user has open now)', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    onDayChanged.mockResolvedValue(AFTER_OTHER_TAB)
    view[leave]()

    inFlight.resolve(dayChanged)
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1))
    await settle()

    expect(onDayChanged).not.toHaveBeenCalled()
    expect(onSaveFailed).toHaveBeenCalledWith(true)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('an edit queued behind the save is still sent when the save returns, from the refs, and its outcome is reported', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    enter('editor-pair-1-in', '07:30') // queued: the first save is still running
    expect(save).toHaveBeenCalledTimes(1)
    view[leave]()

    const afterFirst = buildDayView(DATE, rowsFor('p').map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r)))
    const afterSecond = buildDayView(
      DATE,
      rowsFor('p').map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as StoredPunchRow['currentTime'] } : r.id === 'p-0' ? { ...r, currentTime: '07:30' as StoredPunchRow['currentTime'] } : r)),
    )
    save.mockResolvedValueOnce(savedWith(afterSecond))
    inFlight.resolve(savedWith(afterFirst))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    await settle()

    expect(save).toHaveBeenCalledTimes(2)
    // The second request carries both edits and is built on the day the first save returned, not on the opened one.
    const second = save.mock.calls[1][0]
    expect(second).toMatchObject({ date: DATE, baseSignature: afterFirst.signature })
    expect(second.pairs[0].in.time).toBe('07:30')
    expect(second.pairs[1].out.time).toBe('17:30')
    expect(onSaved).toHaveBeenLastCalledWith('emp-36', DATE, expect.objectContaining({ day: afterSecond }))
    expect(onSaveFailed.mock.calls).toEqual([[false], [false]])
  })

  it('an edit queued behind a save that failed is sent once after it closed too, and the failure of that one is reported as well', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    enter('editor-pair-1-in', '07:30')
    view[leave]()

    save.mockResolvedValueOnce(failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.'))
    inFlight.resolve(failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.'))
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(2))
    await settle()

    expect(save).toHaveBeenCalledTimes(2) // once, not in a loop
    expect(onSaveFailed.mock.calls).toEqual([[true], [true]])
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('DayEditorSheet: the body that took over is not touched by the old body\'s save', () => {
  it('after a step-away, the failure of the old save does not show a failure or a retry in the new editor', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    view.stepAway()
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:47')

    inFlight.resolve(failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.'))
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledWith(true))

    expect(screen.queryByTestId('editor-retry')).not.toBeInTheDocument()
    expect(status()).not.toHaveTextContent('locked')
    expect(status()).not.toHaveTextContent('Saved')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('after a step-away, the new editor saves its own day on its own signature', async () => {
    const view = renderEditor()
    const inFlight = await saveInFlight()
    view.stepAway()
    inFlight.resolve(failure('WEEK_LOCKED', 'x'))
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledWith(true))
    save.mockResolvedValueOnce(savedWith(NEXT_DAY))

    enter('editor-pair-2-out', '18:00')

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0]).toMatchObject({ date: NEXT_DATE, baseSignature: NEXT_DAY.signature })
    expect(save.mock.calls[0][0]).toMatchObject({ date: DATE, baseSignature: OPENED.signature })
  })
})
