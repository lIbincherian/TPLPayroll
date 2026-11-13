import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { AttendanceWeekList } from '@/features/attendance-sync/components/AttendanceWeekList'
import { getPullWarningAction, pullWeekAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { formatWeekLabel } from '@/features/attendance-sync/lib/week'
import type { AttendanceWeekListItem, SyncOutcome } from '@/features/attendance-sync/types/attendance-sync.types'

// The "Pull this week again?" warning lists what the pull would discard: edited days, the employee decisions and,
// now, codes ignored for this week only. Two items read "A and B", three "A, B and C". The same wording is used
// in the toast after a pull that discarded them. A week with nothing to lose is pulled without asking.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/attendance',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/features/attendance-sync/actions/attendance-sync.actions', () => ({
  getPullWarningAction: vi.fn(),
  pullWeekAction: vi.fn(),
}))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
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

const WEEK_ID = '2026-11-05'
const LABEL = formatWeekLabel({ start: WEEK_ID, end: '2026-11-11' })
const warn = vi.mocked(getPullWarningAction)
const pull = vi.mocked(pullWeekAction)

const row: AttendanceWeekListItem = {
  weekId: WEEK_ID,
  week: { start: WEEK_ID, end: '2026-11-11' },
  source: 'ETIMEOFFICE',
  status: 'REVIEW',
  isSyncing: false,
  uploadId: 'upload-1',
  employeeCount: 3,
  totalRegularHours: 0,
  totalOvertimeHours: 0,
  unresolvedCodes: 0,
  pendingDecisions: 0,
  needsFixingDays: 0,
  lastSyncError: null,
  lastSyncAttemptAt: null,
  lastSyncedAt: null,
  staleNoticeAt: null,
  fileName: null,
  payrollStatus: 'NOT_GENERATED',
  payrollRunId: null,
  canPullNow: true,
  canReopen: false,
  hasEnded: true,
}

const warning = (editedDays: number, decisions: number, ignoredCodes: number) =>
  warn.mockResolvedValue({ ok: true, data: { hasData: true, editedDays, decisions, ignoredCodes } })

type Loaded = Extract<SyncOutcome, { outcome: 'LOADED' }>

const loaded = (
  discarded: Loaded['discarded'],
  statusChanges: Loaded['statusChanges'] = { markedInactive: [], reactivated: [] },
) => pull.mockResolvedValue({ ok: true, data: { outcome: 'LOADED', punchCount: 8, discarded, statusChanges } as SyncOutcome })

async function clickPull() {
  render(<AttendanceWeekList weeks={[row]} todayISO="2026-11-12" />)
  fireEvent.click(screen.getByTestId(`pull-now-${WEEK_ID}`))
}

async function warningText() {
  const text = await screen.findByTestId('pull-warning-text')
  return text.textContent
}

beforeEach(() => {
  warn.mockReset()
  pull.mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.info).mockReset()
})

describe('the pull warning wording', () => {
  it.each([
    ['one code ignored for this week', [0, 0, 1], 'This will discard 1 code ignored for this week.'],
    ['several codes ignored for this week', [0, 0, 3], 'This will discard 3 codes ignored for this week.'],
    ['edited days only', [12, 0, 0], 'This will discard 12 edited days.'],
    ['one edited day only', [1, 0, 0], 'This will discard 1 edited day.'],
    ['decisions only', [0, 2, 0], 'This will discard your employee decisions.'],
    ['edits and decisions (unchanged wording)', [12, 1, 0], 'This will discard 12 edited days and your employee decisions.'],
    ['edits and an ignored code', [2, 0, 1], 'This will discard 2 edited days and 1 code ignored for this week.'],
    ['decisions and an ignored code', [0, 1, 2], 'This will discard your employee decisions and 2 codes ignored for this week.'],
    ['all three', [12, 1, 1], 'This will discard 12 edited days, your employee decisions and 1 code ignored for this week.'],
  ] as const)('says %s', async (_label, [editedDays, decisions, ignoredCodes], expected) => {
    warning(editedDays, decisions, ignoredCodes)

    await clickPull()

    expect(await warningText()).toBe(expected)
    expect(screen.getByTestId('pull-warning-dialog')).toBeInTheDocument()
    expect(pull).not.toHaveBeenCalled()
  })
})

describe('the warning gate', () => {
  it('a code ignored for this week alone is enough to ask before pulling', async () => {
    warning(0, 0, 1)

    await clickPull()

    await screen.findByTestId('pull-warning-dialog')
    expect(pull).not.toHaveBeenCalled()
  })

  it('pulls straight away, with no question, when there is nothing to discard', async () => {
    warning(0, 0, 0)
    loaded(null)

    await clickPull()

    await waitFor(() => expect(pull).toHaveBeenCalledWith(WEEK_ID))
    expect(screen.queryByTestId('pull-warning-dialog')).not.toBeInTheDocument()
  })

  it('Cancel leaves the week alone: no pull, dialog closed', async () => {
    warning(0, 0, 1)
    await clickPull()
    await screen.findByTestId('pull-warning-dialog')

    fireEvent.click(screen.getByTestId('pull-warning-cancel'))

    await waitFor(() => expect(screen.queryByTestId('pull-warning-dialog')).not.toBeInTheDocument())
    expect(pull).not.toHaveBeenCalled()
  })

  it('Discard and pull runs the pull once', async () => {
    warning(0, 0, 1)
    loaded({ editedDays: 0, decisions: 0, ignoredCodes: 1, edits: [] })
    await clickPull()
    await screen.findByTestId('pull-warning-dialog')

    fireEvent.click(screen.getByTestId('pull-warning-confirm'))

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
    expect(pull).toHaveBeenCalledWith(WEEK_ID)
  })

  it('does not pull and shows the error when the warning check itself is refused', async () => {
    warn.mockResolvedValue({ ok: false, error: 'The request was not valid.', code: 'VALIDATION_ERROR' })

    await clickPull()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The request was not valid.'))
    expect(pull).not.toHaveBeenCalled()
    expect(screen.queryByTestId('pull-warning-dialog')).not.toBeInTheDocument()
  })

  it('does not pull and says it could not reach the server when the warning check fails to run', async () => {
    warn.mockRejectedValue(new Error('network'))

    await clickPull()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't reach the server. Try again."))
    expect(pull).not.toHaveBeenCalled()
  })
})

describe('the toast after a pull that discarded things', () => {
  it('lists the ignored code that was discarded', async () => {
    warning(0, 0, 1)
    loaded({ editedDays: 0, decisions: 0, ignoredCodes: 1, edits: [] })
    await clickPull()
    await screen.findByTestId('pull-warning-dialog')

    fireEvent.click(screen.getByTestId('pull-warning-confirm'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Loaded ${LABEL}`, { description: 'Discarded 1 code ignored for this week.' }),
    )
  })

  it('lists all three kinds with the same wording as the warning', async () => {
    warning(2, 1, 2)
    loaded({ editedDays: 2, decisions: 1, ignoredCodes: 2, edits: [] })
    await clickPull()
    await screen.findByTestId('pull-warning-dialog')

    fireEvent.click(screen.getByTestId('pull-warning-confirm'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(`Loaded ${LABEL}`, {
        description: 'Discarded 2 edited days, your employee decisions and 2 codes ignored for this week.',
      }),
    )
  })

  it('has no "Discarded" line when nothing was discarded', async () => {
    warning(0, 0, 0)
    loaded(null)

    await clickPull()

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Loaded ${LABEL}`, { description: undefined }))
  })

  it('has no "Discarded" line when the counts are all zero', async () => {
    warning(0, 0, 0)
    loaded({ editedDays: 0, decisions: 0, ignoredCodes: 0, edits: [] })

    await clickPull()

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Loaded ${LABEL}`, { description: undefined }))
  })

  it('reports a failed pull as an error, not as a discard', async () => {
    warning(0, 0, 1)
    pull.mockResolvedValue({
      ok: true,
      data: { outcome: 'FAILED', code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' } as SyncOutcome,
    })
    await clickPull()
    await screen.findByTestId('pull-warning-dialog')

    fireEvent.click(screen.getByTestId('pull-warning-confirm'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`Couldn't load ${LABEL}`, { description: 'eTimeOffice returned HTTP 500.' }))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('the pull toast reports employee status changes', () => {
  const person = (id: string) => ({ id, employeeId: `TPL${id}`, employeeName: `Name ${id}` })

  it('adds the counts when a pull marked employees inactive or reactivated them', async () => {
    warning(0, 0, 0)
    loaded(null, { markedInactive: [person('a'), person('b')], reactivated: [person('c')] })

    await clickPull()

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Loaded 5 Nov – 11 Nov 2026', {
        description: '2 employees marked inactive, 1 reactivated.',
      }),
    )
  })

  it('adds nothing when nobody changed', async () => {
    warning(0, 0, 0)
    loaded(null)

    await clickPull()

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Loaded 5 Nov – 11 Nov 2026', { description: undefined }),
    )
  })
})
