import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { EmployeeCheck } from '@/features/attendance-sync/components/EmployeeCheck'
import {
  getEmployeeCheckAction,
  ignoreCodeAction,
  rematchWeekCodesAction,
  unignoreCodeAction,
} from '@/features/attendance-sync/actions/attendance-sync.actions'
import type {
  ActionResult,
  EmployeeCheck as EmployeeCheckData,
  UnignoreCodeResult,
} from '@/features/attendance-sync/types/attendance-sync.types'

// "Ignore this code" asks which scope (this week / every week); each ignored code shows its scope and a
// "Stop ignoring" button. A week-only ignore stops at once, an every-week ignore asks first. The toasts say where
// the code went. These tests drive the component with the server actions mocked.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/features/attendance-sync/actions/attendance-sync.actions', () => ({
  getEmployeeCheckAction: vi.fn(),
  rematchWeekCodesAction: vi.fn(),
  matchCodeAction: vi.fn(),
  ignoreCodeAction: vi.fn(),
  unignoreCodeAction: vi.fn(),
  setEmployeeDecisionAction: vi.fn(),
}))

const WEEK = '2026-11-05'
const getCheck = vi.mocked(getEmployeeCheckAction)
const rematch = vi.mocked(rematchWeekCodesAction)
const ignore = vi.mocked(ignoreCodeAction)
const unignore = vi.mocked(unignoreCodeAction)

type CheckCode = EmployeeCheckData['codes'][number]
type IgnoredCode = EmployeeCheckData['ignoredCodes'][number]

const CODE_GITA: CheckCode = { empCode: '0999', empName: 'Gita Pillai', status: 'UNKNOWN', punchCount: 4, dayCount: 2, candidates: [] }
const WEEK_IGNORED: IgnoredCode = { empCode: '0444', empName: 'Test Enrollment', punchCount: 2, scope: 'WEEK' }
const ALWAYS_IGNORED: IgnoredCode = { empCode: '0555', empName: 'Door Test', punchCount: 3, scope: 'ALWAYS' }

function checkOf(codes: CheckCode[], ignoredCodes: IgnoredCode[] = []): EmployeeCheckData {
  return {
    weekId: WEEK,
    week: { start: WEEK, end: '2026-11-11' },
    codes,
    ignoredCodes,
    decisions: [],
    counts: {
      codesInSync: 5,
      matched: 5 - codes.length - ignoredCodes.length,
      unknown: codes.filter((c) => c.status === 'UNKNOWN').length,
      duplicate: codes.filter((c) => c.status === 'DUPLICATE').length,
      decisionsLeft: 0,
    },
    allEmployees: [{ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' }],
    complete: codes.length === 0,
  }
}

const loaded = (data: EmployeeCheckData): ActionResult<EmployeeCheckData> => ({ ok: true, data })
const stopped = (outcome: UnignoreCodeResult['outcome']): ActionResult<UnignoreCodeResult> => ({
  ok: true,
  data: { restoredPunches: 2, outcome },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Render, and wait out the re-match the page runs on arrival when it has codes to fix; then forget its calls. */
async function renderCheck(initial: EmployeeCheckData, status: Parameters<typeof EmployeeCheck>[0]['status'] = 'REVIEW') {
  rematch.mockResolvedValue({ ok: true, data: { matched: [], stillUnresolved: initial.codes.map((c) => c.empCode) } })
  getCheck.mockResolvedValue(loaded(initial))
  const view = render(<EmployeeCheck initial={initial} status={status} />)
  if (initial.codes.length > 0 && status === 'REVIEW') {
    await waitFor(() => expect(screen.queryByText('Rechecking codes…')).not.toBeInTheDocument())
  }
  vi.mocked(toast.success).mockClear()
  getCheck.mockClear()
  rematch.mockClear()
  return view
}

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId))
const errorText = () => screen.queryByTestId('employee-check-error')?.textContent ?? null

beforeEach(() => {
  for (const mock of [getCheck, rematch, ignore, unignore]) mock.mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.info).mockReset()
  vi.mocked(toast.error).mockReset()
})

// ─── The ignore confirmation ──────────────────────────────────────────────────

describe('Ignore this code asks for a scope', () => {
  it('opens a confirmation with Ignore this week, Ignore every week and Cancel, and explains the difference', async () => {
    await renderCheck(checkOf([CODE_GITA]))

    click('ignore-code-0999')

    const dialog = screen.getByRole('alertdialog', { name: 'Ignore code 0999' })
    expect(within(dialog).getByTestId('ignore-week-0999')).toHaveTextContent('Ignore this week')
    expect(within(dialog).getByTestId('ignore-always-0999')).toHaveTextContent('Ignore every week')
    expect(within(dialog).getByTestId('cancel-ignore-0999')).toHaveTextContent('Cancel')
    expect(within(dialog).getByText('Leave 4 punches out of payroll?')).toBeInTheDocument()
    expect(within(dialog).getByTestId('ignore-help-0999')).toHaveTextContent(/This week:.*Every week:/)
    // The row's own actions give way to the confirmation, and nothing has been sent.
    expect(screen.queryByTestId('ignore-code-0999')).not.toBeInTheDocument()
    expect(ignore).not.toHaveBeenCalled()
  })

  it('Cancel closes it without sending anything, and the code is still to fix', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    click('ignore-code-0999')

    click('cancel-ignore-0999')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('ignore-code-0999')).toBeInTheDocument()
    expect(ignore).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
  })

  it('Ignore this week sends the WEEK scope, says so in the toast, reloads and lists the code as "This week only"', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    ignore.mockResolvedValue({ ok: true, data: { ignoredPunches: 4 } })
    getCheck.mockResolvedValue(loaded(checkOf([], [{ empCode: '0999', empName: 'Gita Pillai', punchCount: 4, scope: 'WEEK' }])))
    click('ignore-code-0999')

    click('ignore-week-0999')

    await waitFor(() => expect(screen.getByTestId('ignored-code-0999')).toBeInTheDocument())
    expect(ignore).toHaveBeenCalledTimes(1)
    expect(ignore).toHaveBeenCalledWith(WEEK, '0999', 'WEEK')
    expect(toast.success).toHaveBeenCalledWith('Code 0999 ignored for this week', {
      description: 'It will be asked about again in later weeks.',
    })
    expect(getCheck).toHaveBeenCalledWith(WEEK)
    expect(screen.getByTestId('ignored-scope-0999')).toHaveTextContent('This week only')
    expect(screen.getByTestId('ignored-scope-0999')).toHaveAttribute('data-scope', 'WEEK')
    expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('Ignore every week sends the ALWAYS scope, says it stays ignored, and lists the code as "Every week"', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    ignore.mockResolvedValue({ ok: true, data: { ignoredPunches: 4 } })
    getCheck.mockResolvedValue(loaded(checkOf([], [{ empCode: '0999', empName: 'Gita Pillai', punchCount: 4, scope: 'ALWAYS' }])))
    click('ignore-code-0999')

    click('ignore-always-0999')

    await waitFor(() => expect(screen.getByTestId('ignored-code-0999')).toBeInTheDocument())
    expect(ignore).toHaveBeenCalledTimes(1)
    expect(ignore).toHaveBeenCalledWith(WEEK, '0999', 'ALWAYS')
    expect(toast.success).toHaveBeenCalledWith('Code 0999 ignored', { description: 'It stays ignored in future weeks.' })
    expect(screen.getByTestId('ignored-scope-0999')).toHaveTextContent('Every week')
    expect(screen.getByTestId('ignored-scope-0999')).toHaveAttribute('data-scope', 'ALWAYS')
  })

  it('shows the server\'s refusal, closes the confirmation, keeps the code to fix, and neither toasts nor reloads', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    ignore.mockResolvedValue({ ok: false, error: 'This week is approved. Reopen it to change codes or decisions.', code: 'WEEK_LOCKED' })
    click('ignore-code-0999')

    click('ignore-week-0999')

    await waitFor(() => expect(errorText()).toBe('This week is approved. Reopen it to change codes or decisions.'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument()
    expect(screen.queryByTestId('ignored-code-0999')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('says it could not reach the server when the request itself fails (every-week choice)', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    ignore.mockRejectedValue(new Error('network'))
    click('ignore-code-0999')

    click('ignore-always-0999')

    await waitFor(() => expect(errorText()).toBe("Couldn't reach the server. Try again."))
    expect(toast.success).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument()
  })

  it('locks all three choices while the request runs, so a second click cannot send a second request', async () => {
    await renderCheck(checkOf([CODE_GITA]))
    const pending = deferred<Awaited<ReturnType<typeof ignoreCodeAction>>>()
    ignore.mockReturnValue(pending.promise)
    click('ignore-code-0999')

    click('ignore-week-0999')

    await waitFor(() => expect(screen.getByTestId('ignore-week-0999')).toBeDisabled())
    expect(screen.getByTestId('ignore-always-0999')).toBeDisabled()
    expect(screen.getByTestId('cancel-ignore-0999')).toBeDisabled()
    click('ignore-week-0999')
    click('ignore-always-0999')
    expect(ignore).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: false, error: 'stop here', code: 'WEEK_LOCKED' })
    await waitFor(() => expect(errorText()).toBe('stop here'))
  })

  it('cannot be opened on an approved week: the button is disabled and nothing opens', async () => {
    await renderCheck(checkOf([CODE_GITA]), 'APPROVED')

    expect(screen.getByTestId('ignore-code-0999')).toBeDisabled()
    click('ignore-code-0999')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ignore).not.toHaveBeenCalled()
  })
})

// ─── Ignored codes and their scope pill ───────────────────────────────────────

describe('ignored codes show their scope', () => {
  it('a week-only ignore reads "This week only" and an every-week ignore reads "Every week", each with a Stop ignoring button', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED, ALWAYS_IGNORED]))

    expect(screen.getByRole('heading', { name: 'Ignored codes' })).toBeInTheDocument()
    expect(screen.getByTestId('ignored-scope-0444')).toHaveTextContent('This week only')
    expect(screen.getByTestId('ignored-scope-0444')).toHaveAttribute('data-scope', 'WEEK')
    expect(screen.getByTestId('ignored-scope-0555')).toHaveTextContent('Every week')
    expect(screen.getByTestId('ignored-scope-0555')).toHaveAttribute('data-scope', 'ALWAYS')
    const week = screen.getByTestId('ignored-code-0444')
    expect(week).toHaveTextContent('Test Enrollment')
    expect(week).toHaveTextContent('2 punches')
    expect(screen.getByTestId('ignored-code-0555')).toHaveTextContent('3 punches')
    expect(screen.getByRole('button', { name: 'Stop ignoring code 0444' })).toBe(screen.getByTestId('unignore-0444'))
    expect(screen.getByRole('button', { name: 'Stop ignoring code 0555' })).toBe(screen.getByTestId('unignore-0555'))
  })

  it('has no Ignored codes section when nothing is ignored', async () => {
    await renderCheck(checkOf([CODE_GITA]))

    expect(screen.queryByRole('heading', { name: 'Ignored codes' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('ignored-code-0999')).not.toBeInTheDocument()
  })

  it('shows the dash for an ignored code with no name from eTimeOffice', async () => {
    await renderCheck(checkOf([], [{ ...WEEK_IGNORED, empName: null }]))

    expect(screen.getByTestId('ignored-code-0444')).toHaveTextContent('—')
  })
})

// ─── Stop ignoring: week only ─────────────────────────────────────────────────

describe('Stop ignoring a code ignored for this week only', () => {
  it('acts at once, with no confirmation, and says the code is back under Codes to fix', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    unignore.mockResolvedValue(stopped({ status: 'UNKNOWN' }))
    const back: CheckCode = { empCode: '0444', empName: 'Test Enrollment', status: 'UNKNOWN', punchCount: 2, dayCount: 1, candidates: [] }
    getCheck.mockResolvedValue(loaded(checkOf([back])))

    click('unignore-0444')

    await waitFor(() => expect(screen.getByTestId('code-row-0444')).toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(unignore).toHaveBeenCalledTimes(1)
    expect(unignore).toHaveBeenCalledWith(WEEK, '0444')
    expect(toast.info).toHaveBeenCalledWith('Code 0444 is back under Codes to fix')
    expect(toast.success).not.toHaveBeenCalled()
    expect(getCheck).toHaveBeenCalledWith(WEEK)
    expect(screen.queryByTestId('ignored-code-0444')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Ignored codes' })).not.toBeInTheDocument()
  })

  it('says the code matched an employee when it now resolves to one, and the code does not come back to fix', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    unignore.mockResolvedValue(stopped({ status: 'MATCHED', employeeCode: 'TPLGOAHLP444' }))
    getCheck.mockResolvedValue(loaded(checkOf([])))

    click('unignore-0444')

    await waitFor(() => expect(screen.queryByTestId('ignored-code-0444')).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Code 0444 matched to TPLGOAHLP444')
    expect(toast.info).not.toHaveBeenCalled()
    expect(screen.queryByTestId('code-row-0444')).not.toBeInTheDocument()
  })

  it('treats a duplicate outcome as back under Codes to fix', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    unignore.mockResolvedValue(stopped({ status: 'DUPLICATE' }))
    getCheck.mockResolvedValue(loaded(checkOf([])))

    click('unignore-0444')

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Code 0444 is back under Codes to fix'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows the server\'s refusal, keeps the code ignored, and neither toasts nor reloads', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    unignore.mockResolvedValue({ ok: false, error: "That code isn't ignored in this week.", code: 'CODE_NOT_FOUND' })

    click('unignore-0444')

    await waitFor(() => expect(errorText()).toBe("That code isn't ignored in this week."))
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
    expect(screen.getByTestId('ignored-code-0444')).toBeInTheDocument()
  })

  it('says it could not reach the server when the request itself fails', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    unignore.mockRejectedValue(new Error('network'))

    click('unignore-0444')

    await waitFor(() => expect(errorText()).toBe("Couldn't reach the server. Try again."))
    expect(toast.info).not.toHaveBeenCalled()
    expect(screen.getByTestId('ignored-code-0444')).toBeInTheDocument()
  })

  it('locks the button while the request runs, so a second click sends nothing more', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED]))
    const pending = deferred<Awaited<ReturnType<typeof unignoreCodeAction>>>()
    unignore.mockReturnValue(pending.promise)

    click('unignore-0444')

    await waitFor(() => expect(screen.getByTestId('unignore-0444')).toBeDisabled())
    click('unignore-0444')
    expect(unignore).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: false, error: 'stop here', code: 'WEEK_LOCKED' })
    await waitFor(() => expect(errorText()).toBe('stop here'))
  })
})

// ─── Stop ignoring: every week ────────────────────────────────────────────────

describe('Stop ignoring a code ignored for every week', () => {
  it('asks first, says future weeks are affected, and sends nothing until confirmed', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))

    click('unignore-0555')

    const dialog = screen.getByRole('alertdialog', { name: 'Stop ignoring code 0555' })
    expect(within(dialog).getByText('Stop ignoring 0555 in future weeks too?')).toBeInTheDocument()
    expect(within(dialog).getByTestId('confirm-unignore-0555')).toHaveTextContent('Stop ignoring')
    expect(within(dialog).getByTestId('cancel-unignore-0555')).toHaveTextContent('Cancel')
    expect(screen.queryByTestId('unignore-0555')).not.toBeInTheDocument()
    expect(unignore).not.toHaveBeenCalled()
  })

  it('Cancel closes the question without sending anything, and the code is still ignored for every week', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))
    click('unignore-0555')

    click('cancel-unignore-0555')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('unignore-0555')).toBeInTheDocument()
    expect(screen.getByTestId('ignored-scope-0555')).toHaveTextContent('Every week')
    expect(unignore).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
  })

  it('confirming sends one request, says the code is back under Codes to fix, and reloads', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))
    unignore.mockResolvedValue(stopped({ status: 'UNKNOWN' }))
    const back: CheckCode = { empCode: '0555', empName: 'Door Test', status: 'UNKNOWN', punchCount: 3, dayCount: 1, candidates: [] }
    getCheck.mockResolvedValue(loaded(checkOf([back])))
    click('unignore-0555')

    click('confirm-unignore-0555')

    await waitFor(() => expect(screen.getByTestId('code-row-0555')).toBeInTheDocument())
    expect(unignore).toHaveBeenCalledTimes(1)
    expect(unignore).toHaveBeenCalledWith(WEEK, '0555')
    expect(toast.info).toHaveBeenCalledWith('Code 0555 is back under Codes to fix')
    expect(screen.queryByTestId('ignored-code-0555')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('confirming says "matched to" when the code resolves to an employee', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))
    unignore.mockResolvedValue(stopped({ status: 'MATCHED', employeeCode: 'TPLGOAHLP555' }))
    getCheck.mockResolvedValue(loaded(checkOf([])))
    click('unignore-0555')

    click('confirm-unignore-0555')

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Code 0555 matched to TPLGOAHLP555'))
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('shows the server\'s refusal after confirming, closes the question, and keeps the code ignored', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))
    unignore.mockResolvedValue({ ok: false, error: 'A pull for this week is already running.', code: 'SYNC_IN_PROGRESS' })
    click('unignore-0555')

    click('confirm-unignore-0555')

    await waitFor(() => expect(errorText()).toBe('A pull for this week is already running.'))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('ignored-code-0555')).toBeInTheDocument()
    expect(toast.info).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
  })

  it('locks both buttons of the question while the request runs', async () => {
    await renderCheck(checkOf([], [ALWAYS_IGNORED]))
    const pending = deferred<Awaited<ReturnType<typeof unignoreCodeAction>>>()
    unignore.mockReturnValue(pending.promise)
    click('unignore-0555')

    click('confirm-unignore-0555')

    await waitFor(() => expect(screen.getByTestId('confirm-unignore-0555')).toBeDisabled())
    expect(screen.getByTestId('cancel-unignore-0555')).toBeDisabled()
    click('confirm-unignore-0555')
    expect(unignore).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: false, error: 'stop here', code: 'WEEK_LOCKED' })
    await waitFor(() => expect(errorText()).toBe('stop here'))
  })

  it('asking about one code does not open the question on the other ignored code', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED, ALWAYS_IGNORED]))

    click('unignore-0555')

    expect(screen.queryByTestId('confirm-unignore-0444')).not.toBeInTheDocument()
    expect(screen.getByTestId('unignore-0444')).toBeEnabled()
  })
})

// ─── Approved week ────────────────────────────────────────────────────────────

describe('on an approved week', () => {
  it('Stop ignoring is disabled for both scopes and sends nothing when clicked', async () => {
    await renderCheck(checkOf([], [WEEK_IGNORED, ALWAYS_IGNORED]), 'APPROVED')

    expect(screen.getByTestId('unignore-0444')).toBeDisabled()
    expect(screen.getByTestId('unignore-0555')).toBeDisabled()
    click('unignore-0444')
    click('unignore-0555')

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(unignore).not.toHaveBeenCalled()
    expect(screen.getByTestId('employee-check-locked')).toBeInTheDocument()
  })
})
