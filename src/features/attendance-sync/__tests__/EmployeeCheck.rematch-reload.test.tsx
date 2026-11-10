import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { EmployeeCheck } from '@/features/attendance-sync/components/EmployeeCheck'
import {
  getEmployeeCheckAction,
  rematchWeekCodesAction,
} from '@/features/attendance-sync/actions/attendance-sync.actions'
import type { ActionResult, EmployeeCheck as EmployeeCheckData } from '@/features/attendance-sync/types/attendance-sync.types'

// Coming back from fixing an Employee ID, the page re-matches the open codes. Each code commits on its own,
// so a run that fails part-way can still have linked some of them: the page therefore reloads after EVERY
// attempt (success with matches, success with none, an error result, a network failure), and only then shows
// the error or the toasts for the codes that matched.

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
  setEmployeeDecisionAction: vi.fn(),
}))

const WEEK = '2026-11-05'
const rematch = vi.mocked(rematchWeekCodesAction)
const getCheck = vi.mocked(getEmployeeCheckAction)

const CODE_GITA: EmployeeCheckData['codes'][number] = { empCode: '0999', empName: 'Gita Pillai', status: 'UNKNOWN', punchCount: 4, dayCount: 2, candidates: [] }
const CODE_SEVEN: EmployeeCheckData['codes'][number] = {
  empCode: '0007',
  empName: 'Seven',
  status: 'DUPLICATE',
  punchCount: 2,
  dayCount: 1,
  candidates: [
    { id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp', isActive: true, dateOfResignation: null },
    { id: 'emp-7b', employeeId: 'TPLGOASUP007', employeeName: 'Seven Sup', isActive: true, dateOfResignation: null },
  ],
}

function checkOf(codes: EmployeeCheckData['codes'], over: Partial<EmployeeCheckData> = {}): EmployeeCheckData {
  return {
    weekId: WEEK,
    week: { start: WEEK, end: '2026-11-11' },
    codes,
    ignoredCodes: [],
    decisions: [],
    counts: {
      codesInSync: 5,
      matched: 5 - codes.length,
      unknown: codes.filter((c) => c.status === 'UNKNOWN').length,
      duplicate: codes.filter((c) => c.status === 'DUPLICATE').length,
      decisionsLeft: 0,
    },
    allEmployees: [
      { id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' },
      { id: 'emp-7a', employeeId: 'TPLGOAHLP007', employeeName: 'Seven Hlp' },
    ],
    complete: codes.length === 0,
    ...over,
  }
}

const loaded = (data: EmployeeCheckData): ActionResult<EmployeeCheckData> => ({ ok: true, data })
const matchedGita = { matched: [{ empCode: '0999', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' }], stillUnresolved: ['0007'] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const renderCheck = (status: Parameters<typeof EmployeeCheck>[0]['status'] = 'REVIEW', initial = checkOf([CODE_GITA, CODE_SEVEN])) =>
  render(<EmployeeCheck initial={initial} status={status} />)

const rechecking = () => screen.queryByText('Rechecking codes…')

beforeEach(() => {
  vi.clearAllMocks()
  rematch.mockReset()
  getCheck.mockReset()
})

describe('EmployeeCheck reloads after the rematch it runs on arrival', () => {
  it('a rematch that matched a code: one rematch, one reload, a toast for the match, the row gone, no error', async () => {
    rematch.mockResolvedValue({ ok: true, data: matchedGita })
    getCheck.mockResolvedValue(loaded(checkOf([CODE_SEVEN])))
    renderCheck()
    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument()

    await waitFor(() => expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument())

    expect(rematch).toHaveBeenCalledTimes(1)
    expect(rematch).toHaveBeenCalledWith(WEEK)
    expect(getCheck).toHaveBeenCalledTimes(1)
    expect(getCheck).toHaveBeenCalledWith(WEEK)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Code 0999 matched to TPLGOAHLP036')
    expect(screen.getByTestId('code-row-0007')).toBeInTheDocument()
    expect(screen.queryByTestId('employee-check-error')).not.toBeInTheDocument()
    await waitFor(() => expect(rechecking()).not.toBeInTheDocument())
  })

  it('a rematch that matched nothing still reloads (it used to reload only when something matched)', async () => {
    rematch.mockResolvedValue({ ok: true, data: { matched: [], stillUnresolved: ['0999', '0007'] } })
    getCheck.mockResolvedValue(loaded(checkOf([CODE_GITA, CODE_SEVEN])))
    renderCheck()

    await waitFor(() => expect(rechecking()).not.toBeInTheDocument())

    expect(getCheck).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByTestId('employee-check-error')).not.toBeInTheDocument()
  })

  it('every matched code gets its own toast, after the reload', async () => {
    rematch.mockResolvedValue({
      ok: true,
      data: {
        matched: [
          { empCode: '0999', employeeId: 'emp-36', employeeCode: 'TPLGOAHLP036' },
          { empCode: '0007', employeeId: 'emp-7a', employeeCode: 'TPLGOAHLP007' },
        ],
        stillUnresolved: [],
      },
    })
    getCheck.mockResolvedValue(loaded(checkOf([])))
    renderCheck()

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2))

    expect(toast.success).toHaveBeenNthCalledWith(1, 'Code 0999 matched to TPLGOAHLP036')
    expect(toast.success).toHaveBeenNthCalledWith(2, 'Code 0007 matched to TPLGOAHLP007')
    expect(screen.getByTestId('employee-check-resolved')).toBeInTheDocument() // the reload is what shows it
  })
})

describe('EmployeeCheck reloads when the rematch failed too', () => {
  it('an error result: the reload still happens, the codes the run linked first are gone, and the error is shown', async () => {
    const message = 'A pull is running for this week. Wait for it to finish, then try again.'
    rematch.mockResolvedValue({ ok: false, error: message, code: 'SYNC_IN_PROGRESS' } as ActionResult<never>)
    // The run linked 0999 before it failed on the next code.
    getCheck.mockResolvedValue(loaded(checkOf([CODE_SEVEN])))
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent(message))

    expect(getCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument() // it is not shown as unresolved any more
    expect(screen.getByTestId('code-row-0007')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(rechecking()).not.toBeInTheDocument()
  })

  it('the action throwing (a network failure): the reload still happens and the page says it could not reach the server', async () => {
    rematch.mockRejectedValue(new Error('Failed to fetch'))
    getCheck.mockResolvedValue(loaded(checkOf([CODE_SEVEN])))
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent("Couldn't reach the server. Try again."))

    expect(getCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(rechecking()).not.toBeInTheDocument()
  })

  it('a WEEK_LOCKED refusal (approved in another tab) reloads as well', async () => {
    rematch.mockResolvedValue({ ok: false, error: 'This week is approved. Reopen it to change codes or decisions.', code: 'WEEK_LOCKED' } as ActionResult<never>)
    getCheck.mockResolvedValue(loaded(checkOf([CODE_GITA, CODE_SEVEN])))
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent('This week is approved.'))

    expect(getCheck).toHaveBeenCalledTimes(1)
  })
})

describe('EmployeeCheck: the error and the toasts come after the reload', () => {
  it('while the reload is pending the failed rematch is not reported yet and the page still says it is rechecking', async () => {
    const reload = deferred<ActionResult<EmployeeCheckData>>()
    rematch.mockResolvedValue({ ok: false, error: 'Something went wrong.', code: 'UNKNOWN' } as ActionResult<never>)
    getCheck.mockReturnValue(reload.promise)
    renderCheck()

    await waitFor(() => expect(getCheck).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('employee-check-error')).not.toBeInTheDocument()
    expect(rechecking()).toBeInTheDocument()

    reload.resolve(loaded(checkOf([CODE_SEVEN])))

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent('Something went wrong.'))
    expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument()
    expect(rechecking()).not.toBeInTheDocument()
  })

  it('while the reload is pending no toast is shown for the codes that matched', async () => {
    const reload = deferred<ActionResult<EmployeeCheckData>>()
    rematch.mockResolvedValue({ ok: true, data: matchedGita })
    getCheck.mockReturnValue(reload.promise)
    renderCheck()

    await waitFor(() => expect(getCheck).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()

    reload.resolve(loaded(checkOf([CODE_SEVEN])))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Code 0999 matched to TPLGOAHLP036'))
    expect(screen.queryByTestId('code-row-0999')).not.toBeInTheDocument()
  })
})

describe('EmployeeCheck when the reload itself does not work', () => {
  it('a reload that answers with an error keeps the page as it was, still reports the rematch error and stops "rechecking"', async () => {
    rematch.mockResolvedValue({ ok: false, error: 'The rematch failed.', code: 'UNKNOWN' } as ActionResult<never>)
    getCheck.mockResolvedValue({ ok: false, error: 'Could not load.', code: 'UNKNOWN' } as ActionResult<EmployeeCheckData>)
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent('The rematch failed.'))

    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument() // nothing newer to show
    expect(screen.getByTestId('code-row-0007')).toBeInTheDocument()
    expect(rechecking()).not.toBeInTheDocument()
  })

  it('a reload that throws is caught: the rematch error is still reported and "rechecking" stops', async () => {
    rematch.mockResolvedValue({ ok: false, error: 'The rematch failed.', code: 'UNKNOWN' } as ActionResult<never>)
    getCheck.mockRejectedValue(new Error('Failed to fetch'))
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent('The rematch failed.'))

    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument()
    expect(rechecking()).not.toBeInTheDocument()
  })

  it('both failing: the network error is reported and the page is not stuck rechecking', async () => {
    rematch.mockRejectedValue(new Error('Failed to fetch'))
    getCheck.mockRejectedValue(new Error('Failed to fetch'))
    renderCheck()

    await waitFor(() => expect(screen.getByTestId('employee-check-error')).toHaveTextContent("Couldn't reach the server. Try again."))

    expect(rechecking()).not.toBeInTheDocument()
    expect(screen.getByTestId('code-row-0999')).toBeInTheDocument()
  })

  it('a successful rematch whose reload fails still toasts the matches', async () => {
    rematch.mockResolvedValue({ ok: true, data: matchedGita })
    getCheck.mockRejectedValue(new Error('Failed to fetch'))
    renderCheck()

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Code 0999 matched to TPLGOAHLP036'))

    expect(screen.queryByTestId('employee-check-error')).not.toBeInTheDocument()
    expect(rechecking()).not.toBeInTheDocument()
  })
})

describe('EmployeeCheck only rematches when there is something to rematch', () => {
  it('rematches once: a re-render of the same page does not run it (or the reload) again', async () => {
    rematch.mockResolvedValue({ ok: true, data: { matched: [], stillUnresolved: ['0999', '0007'] } })
    getCheck.mockResolvedValue(loaded(checkOf([CODE_GITA, CODE_SEVEN])))
    const view = renderCheck()
    await waitFor(() => expect(rechecking()).not.toBeInTheDocument())

    view.rerender(<EmployeeCheck initial={checkOf([CODE_GITA, CODE_SEVEN])} status="REVIEW" />)
    await new Promise((r) => setTimeout(r, 20))

    expect(rematch).toHaveBeenCalledTimes(1)
    expect(getCheck).toHaveBeenCalledTimes(1)
  })

  it('an approved week is read only: no rematch and no reload', async () => {
    renderCheck('APPROVED')
    await new Promise((r) => setTimeout(r, 20))

    expect(rematch).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
    expect(rechecking()).not.toBeInTheDocument()
    expect(screen.getByTestId('employee-check-locked')).toBeInTheDocument()
  })

  it('a week with no codes to fix: no rematch and no reload', async () => {
    renderCheck('REVIEW', checkOf([]))
    await new Promise((r) => setTimeout(r, 20))

    expect(rematch).not.toHaveBeenCalled()
    expect(getCheck).not.toHaveBeenCalled()
  })
})
