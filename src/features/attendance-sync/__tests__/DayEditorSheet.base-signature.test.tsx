import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DayEditorSheet } from '@/features/attendance-sync/components/DayEditorSheet'
import { savePunchEditAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { buildDayView } from '@/features/attendance-sync/lib/hours'
import { punchSetSignature } from '@/features/attendance-sync/lib/day-signature'
import type {
  ActionResult,
  DayView,
  GridEmployee,
  ReviewMode,
  SavePunchEditResult,
  StoredPunchRow,
} from '@/features/attendance-sync/types/attendance-sync.types'

// Round 4, item 1 (client): the editor sends the version of the day it was opened on, follows the
// version through its own saves, and on a refusal (DAY_CHANGED) reloads the day instead of saving.

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
const DAY_CHANGED_TEXT =
  'This day was changed in another tab or by a pull, so your change was not saved. It now shows the latest times. Enter your change again.'
const SERVER_MESSAGE = 'This day was changed somewhere else (another tab or a pull) after you opened it. Nothing was saved. Reload the day and try again.'

const row = (id: string, pairIndex: number, position: 'IN' | 'OUT', time: string, extra: Partial<StoredPunchRow> = {}): StoredPunchRow => ({
  id,
  pairIndex,
  position,
  source: 'API',
  originalTime: time as StoredPunchRow['originalTime'],
  currentTime: time as StoredPunchRow['currentTime'],
  note: null,
  ...extra,
})

const OPENED_ROWS = [row('p-0', 0, 'IN', '07:40'), row('p-1', 0, 'OUT', '13:04'), row('p-2', 1, 'IN', '13:56'), row('p-3', 1, 'OUT', '17:47')]
const dayOf = (rows: StoredPunchRow[]): DayView => buildDayView(DATE, rows)

/** What the day looks like after another tab added a hand-entered third pair. */
const OTHER_TAB_ROWS = [
  ...OPENED_ROWS,
  row('m-in', 2, 'IN', '18:00', { source: 'MANUAL', originalTime: null }),
  row('m-out', 2, 'OUT', '19:00', { source: 'MANUAL', originalTime: null }),
]

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

const resultFor = (day: DayView): ActionResult<SavePunchEditResult> =>
  ({ ok: true, data: { day, savedAt: '2026-11-13T05:00:00.000Z' } as unknown as SavePunchEditResult }) as ActionResult<SavePunchEditResult>
const dayChangedFailure = { ok: false, error: SERVER_MESSAGE, code: 'DAY_CHANGED' } as ActionResult<SavePunchEditResult>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const onSaved = vi.fn()
const onSaveFailed = vi.fn()
const onClose = vi.fn()
const onDayChanged = vi.fn<() => Promise<DayView | null>>()

function renderEditor(day: DayView, over: { mode?: ReviewMode; readOnly?: boolean } = {}) {
  const element = (current: DayView) => (
    <DayEditorSheet
      open
      onClose={onClose}
      weekId="2026-11-05"
      mode={over.mode ?? LIVE}
      employee={EMPLOYEE}
      day={current}
      readOnly={over.readOnly ?? false}
      canStepPrevious={false}
      canStepNext={false}
      onStep={vi.fn()}
      onSaved={onSaved}
      onSaveFailed={onSaveFailed}
      onDayChanged={onDayChanged}
    />
  )
  const view = render(element(day))
  return { ...view, rerenderDay: (next: DayView) => view.rerender(element(next)) }
}

/** Type a time into a pair field and press Enter, the way the editor commits a change. */
function enter(testId: string, value: string) {
  const input = screen.getByTestId(testId)
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

const sentCall = (index: number) => save.mock.calls[index][0]
const status = () => screen.getByTestId('editor-save-status')

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  onDayChanged.mockReset()
})

// ─── The version that is sent ─────────────────────────────────────────────────

describe('DayEditorSheet sends the version of the day it was opened on', () => {
  it('the first save carries the day\'s signature, with the week, employee, date and mode', async () => {
    const opened = dayOf(OPENED_ROWS)
    save.mockResolvedValue(resultFor(dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:00' as never } : r)))))
    renderEditor(opened)

    enter('editor-pair-2-out', '18:00')

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(sentCall(0)).toMatchObject({
      weekId: '2026-11-05',
      employeeId: 'emp-36',
      date: DATE,
      mode: LIVE,
      baseSignature: opened.signature,
    })
    expect(sentCall(0).baseSignature).toBe(punchSetSignature(OPENED_ROWS))
    expect(sentCall(0).pairs).toHaveLength(2)
  })

  it('a correction sends its mode and the signature it was opened with', async () => {
    const correction: ReviewMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 }
    const opened = dayOf(OPENED_ROWS)
    save.mockResolvedValue(resultFor(opened))
    renderEditor(opened, { mode: correction })

    enter('editor-pair-2-out', '18:00')

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(sentCall(0)).toMatchObject({ mode: correction, baseSignature: opened.signature })
  })

  it('after a successful save the next save carries the signature the server returned, not the old one', async () => {
    const opened = dayOf(OPENED_ROWS)
    const afterFirst = dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:00' as never } : r)))
    const afterSecond = dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:30' as never } : r)))
    expect(afterFirst.signature).not.toBe(opened.signature)
    save.mockResolvedValueOnce(resultFor(afterFirst)).mockResolvedValueOnce(resultFor(afterSecond))
    renderEditor(opened)

    enter('editor-pair-2-out', '18:00')
    await waitFor(() => expect(status()).toHaveTextContent('Saved'))
    enter('editor-pair-2-out', '18:30')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    expect(sentCall(0).baseSignature).toBe(opened.signature)
    expect(sentCall(1).baseSignature).toBe(afterFirst.signature)
    expect(sentCall(1).baseSignature).not.toBe(opened.signature)
  })

  it('a field committed while the first save is in flight is sent after it, with the NEW signature', async () => {
    const opened = dayOf(OPENED_ROWS)
    const afterFirst = dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:00' as never } : r)))
    const afterSecond = dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:00' as never } : r.id === 'p-0' ? { ...r, currentTime: '07:30' as never } : r)))
    const firstInFlight = deferred<ActionResult<SavePunchEditResult>>()
    save.mockImplementationOnce(() => firstInFlight.promise).mockResolvedValueOnce(resultFor(afterSecond))
    renderEditor(opened)

    enter('editor-pair-2-out', '18:00')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    enter('editor-pair-1-in', '07:30') // typed while the first save is still running
    expect(save).toHaveBeenCalledTimes(1) // queued, not sent

    firstInFlight.resolve(resultFor(afterFirst))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    expect(sentCall(0).baseSignature).toBe(opened.signature)
    expect(sentCall(1).baseSignature).toBe(afterFirst.signature) // not the signature the editor was opened with
    // The queued save carries both edits: the last OUT already saved and the new first IN.
    expect(sentCall(1).pairs[0].in.time).toBe('07:30')
    expect(sentCall(1).pairs[1].out.time).toBe('18:00')
  })

  it('a note edited after a save is sent with the new signature too', async () => {
    const opened = dayOf(OPENED_ROWS)
    const afterFirst = dayOf(OPENED_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '18:00' as never } : r)))
    save.mockResolvedValue(resultFor(afterFirst))
    const { rerenderDay } = renderEditor(opened)

    enter('editor-pair-2-out', '18:00')
    await waitFor(() => expect(status()).toHaveTextContent('Saved'))
    // The saved day now lists the change; its note box is editable. The grid passes the new day down.
    expect(afterFirst.signature).not.toBe(opened.signature)
    rerenderDay(afterFirst)
    const note = screen.getByTestId('editor-note-1')
    fireEvent.change(note, { target: { value: 'forgot to scan out' } })
    fireEvent.keyDown(note, { key: 'Enter' })

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(sentCall(1).baseSignature).toBe(afterFirst.signature)
  })

  it('a new `day` prop without a save (the grid reloaded) does not change the signature the draft is sent against', async () => {
    const opened = dayOf(OPENED_ROWS)
    const reloaded = dayOf(OTHER_TAB_ROWS) // another tab's save, picked up by a grid reload
    expect(reloaded.signature).not.toBe(opened.signature)
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(reloaded)
    const { rerenderDay } = renderEditor(opened)

    rerenderDay(reloaded)
    enter('editor-pair-2-out', '17:30') // the draft is still the old one: two pairs, typed against `opened`
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    expect(sentCall(0).baseSignature).toBe(opened.signature)
    expect(sentCall(0).baseSignature).not.toBe(reloaded.signature)
    // Only two pairs went out: the draft never saw the third pair, so the server must refuse it.
    expect(sentCall(0).pairs).toHaveLength(2)
  })

  it('a read-only editor sends nothing', () => {
    renderEditor(dayOf(OPENED_ROWS), { readOnly: true })

    expect(screen.queryAllByRole('textbox')).toHaveLength(0) // times are plain text, not fields
    expect(screen.getByTestId('editor-pair-2-out')).toHaveTextContent('17:47')
    expect(save).not.toHaveBeenCalled()
  })

  it('a time that is typed but unchanged sends nothing', async () => {
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:47')
    await new Promise((r) => setTimeout(r, 20))

    expect(save).not.toHaveBeenCalled()
  })
})

// ─── DAY_CHANGED ──────────────────────────────────────────────────────────────

describe('DayEditorSheet when the save is refused because the day changed', () => {
  it('asks the grid for the latest day once, shows the notice, and puts the latest times in the fields', async () => {
    const opened = dayOf(OPENED_ROWS)
    const fresh = dayOf(OTHER_TAB_ROWS)
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(fresh)
    renderEditor(opened)
    expect(screen.queryByTestId('editor-pair-3-in')).not.toBeInTheDocument() // the stale draft has two pairs

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(onDayChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('editor-day-changed')).toHaveTextContent(DAY_CHANGED_TEXT)
    // Reset to the returned day: the typed 17:30 is gone, 17:47 is back, and the third pair is there.
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:47')
    expect(screen.getByTestId('editor-pair-3-in')).toHaveValue('18:00')
    expect(screen.getByTestId('editor-pair-3-out')).toHaveValue('19:00')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not show the server\'s English error or a retry button: the notice replaces them', async () => {
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(dayOf(OTHER_TAB_ROWS))
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(screen.queryByTestId('editor-retry')).not.toBeInTheDocument()
    expect(status()).not.toHaveTextContent(SERVER_MESSAGE)
    expect(status()).not.toHaveTextContent('Saved')
  })

  it('tells the grid header the last save did not fail (the day was reloaded, nothing is pending)', async () => {
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(dayOf(OTHER_TAB_ROWS))
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(onSaveFailed).toHaveBeenLastCalledWith(false)
    expect(onSaveFailed).not.toHaveBeenCalledWith(true)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a field committed while the refused save was in flight is dropped with the stale draft: no second action call', async () => {
    const refused = deferred<ActionResult<SavePunchEditResult>>()
    save.mockImplementationOnce(() => refused.promise)
    onDayChanged.mockResolvedValue(dayOf(OTHER_TAB_ROWS))
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    enter('editor-pair-1-in', '07:30') // queued behind the save that is about to be refused

    refused.resolve(dayChangedFailure)
    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 30)) // a queued rerun would have fired by now

    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('editor-pair-1-in')).toHaveValue('07:40') // reset to the reloaded day, not the typed 07:30
  })

  it('the next save is sent against the reloaded day\'s signature, and then the notice gives way to "Saved"', async () => {
    const fresh = dayOf(OTHER_TAB_ROWS)
    const afterRetype = dayOf(OTHER_TAB_ROWS.map((r) => (r.id === 'p-3' ? { ...r, currentTime: '17:30' as never } : r)))
    save.mockResolvedValueOnce(dayChangedFailure).mockResolvedValueOnce(resultFor(afterRetype))
    onDayChanged.mockResolvedValue(fresh)
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    enter('editor-pair-2-out', '17:30') // entered again, on the reloaded day
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    expect(sentCall(1).baseSignature).toBe(fresh.signature)
    expect(sentCall(1).pairs).toHaveLength(3) // the third pair is part of this save, so it is kept
    await waitFor(() => expect(status()).toHaveTextContent('Saved'))
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('the notice stays until the next save: committing an unchanged field does not clear it', async () => {
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(dayOf(OTHER_TAB_ROWS))
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    enter('editor-pair-2-out', '17:47') // the value it already has: a no-op commit
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('the reload failing (null) shows the failed state with the server\'s message and a retry button', async () => {
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValue(null)
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(status()).toHaveTextContent(SERVER_MESSAGE)
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
    expect(onSaveFailed).toHaveBeenLastCalledWith(true)
    expect(onDayChanged).toHaveBeenCalledTimes(1)
    // The draft is left as the user typed it, so nothing they typed is lost on a failed reload.
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:30')
  })

  it('"Try again" after a failed reload sends the same draft against the same base again', async () => {
    const opened = dayOf(OPENED_ROWS)
    save.mockResolvedValue(dayChangedFailure)
    onDayChanged.mockResolvedValueOnce(null).mockResolvedValueOnce(dayOf(OTHER_TAB_ROWS))
    renderEditor(opened)

    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('editor-retry'))

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    expect(save).toHaveBeenCalledTimes(2)
    expect(sentCall(1).baseSignature).toBe(opened.signature)
    expect(onDayChanged).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.'],
    ['EMPLOYEE_NOT_FOUND', "That employee isn't in this week's review."],
    ['SYNC_IN_PROGRESS', 'A pull is running for this week. Wait for it to finish, then try again.'],
  ])('%s is a plain failure: the grid is not asked to reload the day', async (code, error) => {
    save.mockResolvedValue({ ok: false, error, code } as ActionResult<SavePunchEditResult>)
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(status()).toHaveTextContent(error)
    expect(onDayChanged).not.toHaveBeenCalled()
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
    expect(onSaveFailed).toHaveBeenLastCalledWith(true)
  })

  it('an action that throws is a plain failure too', async () => {
    save.mockRejectedValue(new Error('network down'))
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '17:30')

    await waitFor(() => expect(screen.getByTestId('editor-retry')).toBeInTheDocument())
    expect(onDayChanged).not.toHaveBeenCalled()
    expect(status()).toHaveTextContent("Couldn't save. Your last saved times are unchanged.")
  })

  it('a validation refusal still marks the field and does not reload the day', async () => {
    save.mockResolvedValue({
      ok: false,
      error: 'OUT (07:00) must be after IN (13:56).',
      code: 'VALIDATION_ERROR',
      validation: { valid: false, code: 'OUT_NOT_AFTER_IN', pairIndex: 1, field: 'out', message: 'OUT (07:00) must be after IN (13:56).' },
    } as ActionResult<SavePunchEditResult>)
    renderEditor(dayOf(OPENED_ROWS))

    enter('editor-pair-2-out', '18:00')

    await waitFor(() => expect(screen.getByTestId('editor-error')).toBeInTheDocument())
    expect(onDayChanged).not.toHaveBeenCalled()
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument()
  })
})
