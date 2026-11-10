import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CorrectionFlow } from '../CorrectionFlow'
import type {
  CorrectionSessionInfo,
  InitiateCorrectionResult,
} from '@/features/payroll-correction/types/correction.types'
import {
  abandonCorrectionAction,
  recalculateAndCreateRevisionAction,
  startAttendanceCorrectionAction,
} from '@/features/payroll-correction/actions/correction.actions'

// US-12.35 AC1, US-12.29 AC1-AC3 and spec §2.8: the attendance option, the optional reason,
// Cancel -> abandon, and the Excel-era restriction. The core flow is in CorrectionFlow.test.tsx.

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  recalculateAndCreateRevisionAction: vi.fn(),
  startAttendanceCorrectionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
  approveAdjustmentInCorrectionAction: vi.fn(),
  skipAdjustmentInCorrectionAction: vi.fn(),
}))

const DATA: InitiateCorrectionResult = {
  payrollRunId: 'run-uuid-1',
  revisionId: 'revision-uuid-1',
  revisionNumber: 1,
  weekStart: new Date('2025-03-06T00:00:00.000Z'),
  weekEnd: new Date('2025-03-12T00:00:00.000Z'),
  totals: {
    totalRegularHours: 40,
    totalOvertimeHours: 5,
    totalRegularPay: 1000,
    totalOvertimePay: 150,
    totalAdditions: 0,
    totalDeductions: 0,
    totalNetPayable: 1150,
  },
  employees: [],
  adjustmentApplications: [],
}

const SESSION: CorrectionSessionInfo = {
  sessionId: 'session-uuid-1',
  payrollRunId: 'run-uuid-1',
  attendanceUploadId: 'upload-uuid-1',
  weekId: '2025-03-06',
  attendanceSource: 'ETIMEOFFICE',
  correctionReason: null,
  correctionTypes: [],
  hasPunchClone: false,
  draftRevisionId: null,
}

const props = { data: DATA, weekLabel: 'Week 06 Mar - 12 Mar' }

const abandoned = { ok: true as const, data: { sessionId: 'session-uuid-1', discardedEdits: 0 } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CorrectionFlow — attendance option and reason', () => {
  it('has no file input or dropzone with every correction type selected', () => {
    render(<CorrectionFlow {...props} activeSession={SESSION} />)

    for (const name of [/adjustments/i, /attendance/i, /employee data updated/i]) {
      fireEvent.click(screen.getByRole('checkbox', { name }))
    }

    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.queryByText(/drag and drop/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/upload/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/dropzone/i)).not.toBeInTheDocument()
  })

  it('labels the Attendance option "Attendance" with the hint "Edit this week\'s punches"', () => {
    render(<CorrectionFlow {...props} activeSession={SESSION} />)

    const label = screen.getByRole('checkbox', { name: /attendance/i }).closest('label')
    expect(label).not.toBeNull()
    expect(label).toHaveTextContent('Attendance')
    expect(label).toHaveTextContent("Edit this week's punches")
  })

  it('shows a busy label while Continue to punches is working', async () => {
    let resolve: (v: { ok: true; data: { sessionId: string } }) => void = () => {}
    vi.mocked(startAttendanceCorrectionAction).mockReturnValue(new Promise((r) => (resolve = r)))

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to punches/i }))

    expect(await screen.findByText(/opening punches/i)).toBeInTheDocument()
    resolve({ ok: true, data: { sessionId: 'session-uuid-1' } })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1/correct/punches'))
  })

  it('sends a blank or whitespace-only reason as null', async () => {
    vi.mocked(startAttendanceCorrectionAction).mockResolvedValue({ ok: true, data: { sessionId: 'session-uuid-1' } })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.change(screen.getByLabelText(/correction reason/i), { target: { value: '    ' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to punches/i }))

    await waitFor(() =>
      expect(startAttendanceCorrectionAction).toHaveBeenCalledWith('run-uuid-1', { reason: null, types: ['ATTENDANCE'] }),
    )
  })

  it('sends a given reason trimmed', async () => {
    vi.mocked(startAttendanceCorrectionAction).mockResolvedValue({ ok: true, data: { sessionId: 'session-uuid-1' } })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.change(screen.getByLabelText(/correction reason/i), { target: { value: '  Wrong OUT time for TPLGOAHLP036 ' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to punches/i }))

    await waitFor(() =>
      expect(startAttendanceCorrectionAction).toHaveBeenCalledWith('run-uuid-1', {
        reason: 'Wrong OUT time for TPLGOAHLP036',
        types: ['ATTENDANCE'],
      }),
    )
  })

  it('sends a blank reason as null on the recalculate path too (adjustments only)', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({
      ok: true,
      data: { payrollRunId: 'run-uuid-1', revisionId: 'revision-uuid-2', revisionNumber: 2, totals: DATA.totals, employeeCount: 0 },
    })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /adjustments/i }))
    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    await waitFor(() =>
      expect(recalculateAndCreateRevisionAction).toHaveBeenCalledWith(
        expect.objectContaining({ correctionReason: null, correctionTypes: ['ADJUSTMENTS'] }),
      ),
    )
  })

  it('shows the error and stays put when the attendance correction cannot start', async () => {
    vi.mocked(startAttendanceCorrectionAction).mockResolvedValue({
      ok: false,
      error: 'No correction is in progress for this payroll run',
      code: 'CORRECTION_NOT_ACTIVE',
    })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue to punches/i }))

    expect(await screen.findByText('No correction is in progress for this payroll run')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('shows the error and does not open the preview when the recalculation fails', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({ ok: false, error: 'No current revision found' })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /adjustments/i }))
    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    expect(await screen.findByText('No current revision found')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('prefills the reason and types when a correction is resumed', () => {
    render(
      <CorrectionFlow
        {...props}
        activeSession={{ ...SESSION, correctionReason: 'Wrong OUT', correctionTypes: ['ATTENDANCE'], hasPunchClone: true }}
      />,
    )

    expect(screen.getByLabelText(/correction reason/i)).toHaveValue('Wrong OUT')
    expect(screen.getByRole('checkbox', { name: /attendance/i })).toBeChecked()
    expect(screen.getByRole('button', { name: /continue to punches/i })).toBeInTheDocument()
  })

  it('says the current revision stays current until the new one is approved', () => {
    render(<CorrectionFlow {...props} activeSession={SESSION} />)

    expect(screen.getByText(/revision 1 stays current until the new one is approved/i)).toBeInTheDocument()
  })
})

describe('CorrectionFlow — Cancel abandons the correction', () => {
  it('abandons the correction, then returns to the payroll run', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue(abandoned)

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-uuid-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1'))
  })

  it('the "Cancel Correction" link at the top abandons the correction too', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue(abandoned)

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel correction/i }))

    await waitFor(() => expect(abandonCorrectionAction).toHaveBeenCalledWith('run-uuid-1'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1'))
  })

  it('stays on the page and shows the error when the abandon fails', async () => {
    vi.mocked(abandonCorrectionAction).mockResolvedValue({
      ok: false,
      error: 'No correction is in progress for this payroll run',
      code: 'CORRECTION_NOT_ACTIVE',
    })

    render(<CorrectionFlow {...props} activeSession={SESSION} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(await screen.findByText('No correction is in progress for this payroll run')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('just leaves when there is no correction session to abandon', () => {
    render(<CorrectionFlow {...props} activeSession={null} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(abandonCorrectionAction).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1')
  })
})

describe('CorrectionFlow — an Excel-era run', () => {
  const excelSession: CorrectionSessionInfo = { ...SESSION, attendanceSource: 'EXCEL' }

  it('disables the Attendance option and says why', () => {
    render(<CorrectionFlow {...props} activeSession={excelSession} />)

    expect(screen.getByRole('checkbox', { name: /attendance/i })).toBeDisabled()
    expect(screen.getByText("Attendance can't be corrected for an Excel-era week")).toBeInTheDocument()
    expect(screen.queryByText(/edit this week's punches/i)).not.toBeInTheDocument()
  })

  it('cannot select Attendance, so there is no Continue to punches', () => {
    render(<CorrectionFlow {...props} activeSession={excelSession} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    expect(screen.getByRole('checkbox', { name: /attendance/i })).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /continue to punches/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /recalculate & preview/i })).toBeDisabled()
  })

  it('still lets adjustments be corrected', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({
      ok: true,
      data: { payrollRunId: 'run-uuid-1', revisionId: 'revision-uuid-2', revisionNumber: 2, totals: DATA.totals, employeeCount: 0 },
    })

    render(<CorrectionFlow {...props} activeSession={excelSession} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /adjustments/i }))
    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    await waitFor(() =>
      expect(recalculateAndCreateRevisionAction).toHaveBeenCalledWith(
        expect.objectContaining({ correctionTypes: ['ADJUSTMENTS'], correctionSessionId: 'session-uuid-1' }),
      ),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1/correct/preview'))
  })
})
