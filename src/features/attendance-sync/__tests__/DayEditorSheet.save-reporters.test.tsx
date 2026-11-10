import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DayEditorSheet, type DayReload, type SaveReport } from '@/features/attendance-sync/components/DayEditorSheet'
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

// The save contract of the day editor, tested with a SEPARATE reporter for every save (the grid's onSaveStart hands
// out one per save, and the header trusts that each save reports through its own):
//
//  - a reporter is taken once for each request that is sent, before it is sent, and never when nothing is sent
//    (an invalid draft, or a draft equal to what is saved);
//  - each save reports exactly once, through its own reporter, with its own outcome;
//  - an edit queued behind a save is sent once the save returns, as ONE follow-up that carries every queued edit,
//    whether the editor is still open, the user stepped to another day, or the editor closed;
//  - the follow-up is sent from the refs (times, notes, the base signature the first save returned);
//  - a closed body never reloads a refused day (onDayChanged) and drops what was queued behind a refused save.

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

type Time = StoredPunchRow['currentTime']
const row = (id: string, pairIndex: number, position: 'IN' | 'OUT', time: string): StoredPunchRow => ({
  id,
  pairIndex,
  position,
  source: 'API',
  originalTime: time as Time,
  currentTime: time as Time,
  note: null,
})
const rowsFor = (prefix: string) => [row(`${prefix}-0`, 0, 'IN', '07:40'), row(`${prefix}-1`, 0, 'OUT', '13:04'), row(`${prefix}-2`, 1, 'IN', '13:56'), row(`${prefix}-3`, 1, 'OUT', '17:47')]
const withTime = (rows: StoredPunchRow[], id: string, time: string) => rows.map((r) => (r.id === id ? { ...r, currentTime: time as Time } : r))

const OPENED = buildDayView(DATE, rowsFor('p'))
const NEXT_DAY = buildDayView(NEXT_DATE, rowsFor('n'))
const AFTER_OTHER_TAB = buildDayView(DATE, [
  ...rowsFor('p'),
  { ...row('m-in', 2, 'IN', '18:00'), source: 'MANUAL', originalTime: null },
  { ...row('m-out', 2, 'OUT', '19:00'), source: 'MANUAL', originalTime: null },
])
/** The day after the first save (last OUT 17:30), and after the second one (first IN 07:30 as well). */
const AFTER_FIRST = buildDayView(DATE, withTime(rowsFor('p'), 'p-3', '17:30'))
const AFTER_SECOND = buildDayView(DATE, withTime(withTime(rowsFor('p'), 'p-3', '17:30'), 'p-0', '07:30'))

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

type SaveResult = ActionResult<SavePunchEditResult>
const savedWith = (day: DayView): SaveResult =>
  ({ ok: true, data: { day, savedAt: '2026-11-13T05:00:00.000Z' } as unknown as SavePunchEditResult }) as SaveResult
const failure = (code: string, error: string) => ({ ok: false, error, code }) as SaveResult
const dayChanged = failure('DAY_CHANGED', SERVER_MESSAGE)
const weekLocked = failure('WEEK_LOCKED', 'This week is locked. Reopen it to edit punches.')

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
const onClose = vi.fn()
const onDayChanged = vi.fn<(employeeId: string, date: ISODate) => Promise<DayReload>>()
/** One reporter per save, in the order the saves started. */
let reporters: Array<ReturnType<typeof vi.fn<SaveReport>>> = []
const onSaveStart = vi.fn<() => SaveReport>(() => {
  const reporter = vi.fn<SaveReport>()
  reporters.push(reporter)
  return reporter
})

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
      onSaveStart={onSaveStart}
      onDayChanged={onDayChanged}
    />
  )
  const view = render(element(EMPLOYEE, day))
  return {
    ...view,
    stepAway: () => view.rerender(element(EMPLOYEE, NEXT_DAY)),
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
  const inFlight = deferred<SaveResult>()
  save.mockImplementationOnce(() => inFlight.promise)
  enter('editor-pair-2-out', '17:30')
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  return inFlight
}

beforeEach(() => {
  vi.clearAllMocks()
  save.mockReset()
  onDayChanged.mockReset()
  reporters = []
})

// The editor is still open, the user stepped to another day, or the editor closed: the follow-up behaves alike.
const LEAVE = [
  ['the editor stays open', 'stayOpen'],
  ['the user steps to another day', 'stepAway'],
  ['the user closes the editor', 'closeEditor'],
] as const
type Leave = (typeof LEAVE)[number][1]
const leaveWith = (view: ReturnType<typeof renderEditor>, how: Leave) => {
  if (how !== 'stayOpen') view[how]()
}

describe.each(LEAVE)('a save with an edit queued behind it when %s', (_label, how) => {
  it('takes one reporter per request, each used once with its own outcome (first lands, follow-up refused)', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30') // queued behind the first save
    leaveWith(view, how)

    save.mockResolvedValueOnce(weekLocked)
    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(reporters[1]).toHaveBeenCalledTimes(1))
    await settle()

    expect(onSaveStart).toHaveBeenCalledTimes(2)
    expect(reporters).toHaveLength(2)
    expect(reporters[0].mock.calls).toEqual([[false]]) // the first save landed
    expect(reporters[1].mock.calls).toEqual([[true]]) // the follow-up was refused
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('takes one reporter per request (first refused, follow-up lands): the follow-up is not tied to the first save\'s reporter', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30')
    leaveWith(view, how)

    save.mockResolvedValueOnce(savedWith(AFTER_SECOND))
    first.resolve(weekLocked)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(reporters[1]).toHaveBeenCalledTimes(1))
    await settle()

    expect(reporters[0].mock.calls).toEqual([[true]])
    expect(reporters[1].mock.calls).toEqual([[false]])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('asks for the reporter before the request goes out', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30')
    leaveWith(view, how)
    save.mockResolvedValueOnce(savedWith(AFTER_SECOND))
    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    for (const n of [0, 1]) {
      expect(onSaveStart.mock.invocationCallOrder[n]).toBeLessThan(save.mock.invocationCallOrder[n])
    }
  })

  it('sends every queued edit in ONE follow-up built on the first save\'s signature (two requests in all, not three)', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30') // queued
    enter('editor-pair-1-out', '13:10') // queued as well
    leaveWith(view, how)

    save.mockResolvedValueOnce(savedWith(AFTER_SECOND))
    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await settle()

    expect(save).toHaveBeenCalledTimes(2)
    const second = save.mock.calls[1][0]
    expect(second).toMatchObject({ date: DATE, baseSignature: AFTER_FIRST.signature })
    expect(second.pairs[0].in.time).toBe('07:30')
    expect(second.pairs[0].out.time).toBe('13:10')
    expect(second.pairs[1].out.time).toBe('17:30') // the first save's edit is part of what is sent
  })

  it('a queued edit that is invalid sends nothing and takes no reporter', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '7:3x') // not a time
    leaveWith(view, how)

    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
    expect(onSaveStart).toHaveBeenCalledTimes(1)
    expect(reporters[0].mock.calls).toEqual([[false]])
  })

  it('a queued edit that puts the day back to what was just saved sends nothing', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-2-out', '17:47') // back to the original, queued
    leaveWith(view, how)

    first.resolve(savedWith(buildDayView(DATE, rowsFor('p')))) // the server's answer to the first save: the same day
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
    expect(onSaveStart).toHaveBeenCalledTimes(1)
  })
})

describe('nothing is sent and no reporter is taken', () => {
  it('for a draft that is not a time', async () => {
    renderEditor()
    enter('editor-pair-2-out', '25:99')
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(onSaveStart).not.toHaveBeenCalled()
    expect(screen.getByTestId('editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('editor-pair-2-out')).toHaveAttribute('aria-invalid', 'true')
  })

  it('for a draft equal to what is saved', async () => {
    renderEditor()
    enter('editor-pair-2-out', '17:47')
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(onSaveStart).not.toHaveBeenCalled()
  })

  it('and a reporter is taken once an edit really changes the day', async () => {
    save.mockResolvedValueOnce(savedWith(AFTER_FIRST))
    renderEditor()
    enter('editor-pair-2-out', '17:30')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    expect(onSaveStart).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(reporters[0]).toHaveBeenCalledWith(false))
  })
})

// ─── Notes travel with the follow-up ──────────────────────────────────────────

describe.each([
  ['the user steps to another day', 'stepAway'],
  ['the user closes the editor', 'closeEditor'],
] as const)('a note queued behind a save when %s', (_label, how) => {
  const edited = () =>
    buildDayView(DATE, [
      row('p-0', 0, 'IN', '07:40'),
      row('p-1', 0, 'OUT', '13:04'),
      { ...row('p-2', 1, 'IN', '13:56'), currentTime: '14:00' as Time }, // already changed, so it lists under Changes with a note box
      row('p-3', 1, 'OUT', '17:47'),
    ])

  it('is sent with the follow-up, against the punch it belongs to', async () => {
    const view = renderEditor(edited())
    const first = await saveInFlight()
    const note = screen.getByTestId('editor-note-1')
    fireEvent.change(note, { target: { value: 'covering the late bus' } })
    fireEvent.keyDown(note, { key: 'Enter' }) // queued behind the first save
    view[how]()

    const afterFirst = buildDayView(DATE, [
      row('p-0', 0, 'IN', '07:40'),
      row('p-1', 0, 'OUT', '13:04'),
      { ...row('p-2', 1, 'IN', '13:56'), currentTime: '14:00' as Time },
      { ...row('p-3', 1, 'OUT', '17:47'), currentTime: '17:30' as Time },
    ])
    save.mockResolvedValueOnce(savedWith(afterFirst))
    first.resolve(savedWith(afterFirst))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await settle()

    const second = save.mock.calls[1][0]
    expect(second.baseSignature).toBe(afterFirst.signature)
    expect(second.pairs[1].in).toMatchObject({ punchId: 'p-2', time: '14:00', note: 'covering the late bus' })
    expect(save).toHaveBeenCalledTimes(2)
  })
})

// ─── DAY_CHANGED ──────────────────────────────────────────────────────────────

describe.each([
  ['the user steps to another day', 'stepAway'],
  ['the user closes the editor', 'closeEditor'],
] as const)('DAY_CHANGED after %s', (_label, how) => {
  it('on the first save: the edit queued behind it is dropped, nothing is reloaded, and the save reports a failure', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30') // queued, typed against the day the server is about to refuse
    onDayChanged.mockResolvedValue(AFTER_OTHER_TAB)
    view[how]()

    first.resolve(dayChanged)
    await waitFor(() => expect(reporters[0]).toHaveBeenCalledTimes(1))
    await settle()

    expect(reporters[0].mock.calls).toEqual([[true]])
    expect(save).toHaveBeenCalledTimes(1) // the queued edit is not sent
    expect(onSaveStart).toHaveBeenCalledTimes(1)
    expect(onDayChanged).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('on the follow-up: it is a failed save too and is not reloaded, and the follow-up is not retried', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30')
    onDayChanged.mockResolvedValue(AFTER_OTHER_TAB)
    view[how]()

    save.mockResolvedValueOnce(dayChanged)
    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(reporters[1]).toHaveBeenCalledTimes(1))
    await settle()

    expect(reporters[0].mock.calls).toEqual([[false]])
    expect(reporters[1].mock.calls).toEqual([[true]])
    expect(save).toHaveBeenCalledTimes(2)
    expect(onDayChanged).not.toHaveBeenCalled()
  })
})

describe('DAY_CHANGED while the editor is still open', () => {
  it('reloads once, drops the edit queued behind the refused save, and shows the reloaded day (the contrast to the closed cases)', async () => {
    renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30') // queued behind the save that is about to be refused
    onDayChanged.mockResolvedValue(AFTER_OTHER_TAB)

    first.resolve(dayChanged)

    await waitFor(() => expect(screen.getByTestId('editor-day-changed')).toBeInTheDocument())
    await settle()
    expect(onDayChanged).toHaveBeenCalledTimes(1)
    expect(onDayChanged).toHaveBeenCalledWith('emp-36', DATE)
    expect(save).toHaveBeenCalledTimes(1) // the queued edit was typed against the stale day and is not sent
    expect(screen.getByTestId('editor-pair-3-in')).toHaveValue('18:00')
    expect(screen.getByTestId('editor-pair-1-in')).toHaveValue('07:40')
  })

  it('the editor closes (or steps away) while the reload is still running: the answer finds no editor, so the save is a failure for the header', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    const reload = deferred<DayReload>()
    onDayChanged.mockImplementation(() => reload.promise)
    first.resolve(dayChanged)
    await waitFor(() => expect(onDayChanged).toHaveBeenCalledTimes(1))

    view.stepAway()
    reload.resolve(AFTER_OTHER_TAB)
    await waitFor(() => expect(reporters[0]).toHaveBeenCalledTimes(1))
    await settle()

    expect(reporters[0].mock.calls).toEqual([[true]])
    expect(screen.queryByTestId('editor-day-changed')).not.toBeInTheDocument() // the new editor is not told about the old day
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('17:47')
  })
})

// ─── A server-side validation refusal ─────────────────────────────────────────

describe('the server refuses a save as invalid', () => {
  const invalid = {
    ok: false,
    error: 'Check the times.',
    validation: { valid: false, code: 'OUT_BEFORE_IN', pairIndex: 1, field: 'out', message: 'OUT must be after IN.' },
  } as unknown as SaveResult

  it('while the editor is open: the field error is shown and the header is left alone', async () => {
    renderEditor()
    const first = await saveInFlight()

    first.resolve(invalid)

    await waitFor(() => expect(screen.getByTestId('editor-error')).toHaveTextContent('OUT must be after IN.'))
    expect(reporters[0]).not.toHaveBeenCalled()
  })

  it.each([
    ['steps to another day', 'stepAway'],
    ['closes the editor', 'closeEditor'],
  ] as const)('after the user %s: nobody can see the field error, so the save reports a failure', async (_label, how) => {
    const view = renderEditor()
    const first = await saveInFlight()
    view[how]()

    first.resolve(invalid)

    await waitFor(() => expect(reporters[0]).toHaveBeenCalledTimes(1))
    expect(reporters[0].mock.calls).toEqual([[true]])
    expect(onSaved).not.toHaveBeenCalled()
  })
})

// ─── The editor that took over ────────────────────────────────────────────────

describe('after a step-away the follow-up leaves the new editor alone', () => {
  it('a follow-up that lands does not show "Saved" or touch the draft of the day the user moved to', async () => {
    const view = renderEditor()
    const first = await saveInFlight()
    enter('editor-pair-1-in', '07:30')
    view.stepAway()
    fireEvent.change(screen.getByTestId('editor-pair-2-out'), { target: { value: '18:15' } }) // a draft in the new editor, not sent

    save.mockResolvedValueOnce(savedWith(AFTER_SECOND))
    first.resolve(savedWith(AFTER_FIRST))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(reporters[1]).toHaveBeenCalledWith(false))
    await settle()

    expect(status()).not.toHaveTextContent('Saved')
    expect(screen.getByTestId('editor-pair-2-out')).toHaveValue('18:15')
    expect(screen.getByTestId('editor-pair-1-in')).toHaveValue('07:40') // the next day's own time, not the old day's 07:30
    expect(save).toHaveBeenCalledTimes(2)
  })
})
