import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CorrectionBanner } from '@/features/attendance-sync/components/CorrectionBanner'
import { abandonCorrectionAction } from '@/features/payroll-correction/actions/correction.actions'

// The line above the punch grid while a correction is open (spec §2.8, E2E-25).

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  abandonCorrectionAction: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const abandoned = { ok: true as const, data: { sessionId: 's-1', discardedEdits: 3 } }

function renderBanner(overrides: Partial<React.ComponentProps<typeof CorrectionBanner>> = {}) {
  return render(<CorrectionBanner payrollRunId="run-1" revisionNumber={1} reason={null} changedDays={3} {...overrides} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CorrectionBanner', () => {
  it('says a correction is in progress, how many days changed, and that the current revision stays in effect', () => {
    renderBanner({ changedDays: 3 })

    const banner = screen.getByTestId('correction-banner')
    expect(banner).toHaveTextContent('Correction in progress.')
    expect(banner).toHaveTextContent('3 days changed.')
    expect(banner).toHaveTextContent('Revision 1 stays in effect until the new one is approved.')
  })

  it('says no days changed yet when nothing was edited', () => {
    renderBanner({ changedDays: 0 })

    expect(screen.getByTestId('correction-banner')).toHaveTextContent('No days changed yet.')
  })

  it('shows the reason only when one was given', () => {
    const { unmount } = renderBanner({ reason: 'Wrong OUT time for TPLGOAHLP036' })
    expect(screen.getByTestId('correction-reason')).toHaveTextContent('Reason: Wrong OUT time for TPLGOAHLP036')
    unmount()

    renderBanner({ reason: null })
    expect(screen.queryByTestId('correction-reason')).not.toBeInTheDocument()
  })

  it('abandons straight away when no day was changed', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue(abandoned)
    renderBanner({ changedDays: 0 })

    fireEvent.click(screen.getByTestId('cancel-correction'))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
    expect(screen.queryByTestId('discard-correction-dialog')).not.toBeInTheDocument()
  })

  it('asks before discarding changed days, and Keep editing discards nothing', async () => {
    renderBanner({ changedDays: 3 })

    fireEvent.click(screen.getByTestId('cancel-correction'))

    const dialog = await screen.findByTestId('discard-correction-dialog')
    expect(dialog).toHaveTextContent('Discard this correction?')
    expect(dialog).toHaveTextContent('Punch edits on 3 days will be discarded.')
    expect(abandonCorrectionAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('keep-editing'))

    await waitFor(() => expect(screen.queryByTestId('discard-correction-dialog')).not.toBeInTheDocument())
    expect(abandonCorrectionAction).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('discards after confirmation, then returns to the payroll run', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue(abandoned)
    renderBanner({ changedDays: 3 })

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-1'))
  })

  it('shows the error and stays when the discard fails', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue({
      ok: false,
      error: 'No correction is in progress for this payroll run',
      code: 'CORRECTION_NOT_ACTIVE',
    })
    renderBanner({ changedDays: 3 })

    fireEvent.click(screen.getByTestId('cancel-correction'))
    fireEvent.click(await screen.findByTestId('discard-correction'))

    await waitFor(() => expect(screen.getAllByText('No correction is in progress for this payroll run').length).toBeGreaterThan(0))
    expect(push).not.toHaveBeenCalled()
  })

  it('asks (rather than abandoning) while the changed-day count is still unknown', async () => {
    renderBanner({ changedDays: null })

    fireEvent.click(screen.getByTestId('cancel-correction'))

    expect(await screen.findByTestId('discard-correction-dialog')).toBeInTheDocument()
    expect(abandonCorrectionAction).not.toHaveBeenCalled()
  })
})
