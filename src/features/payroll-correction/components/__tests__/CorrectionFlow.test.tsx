import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CorrectionFlow } from '../CorrectionFlow'
import type {
  CorrectionSessionInfo,
  InitiateCorrectionResult,
} from '@/features/payroll-correction/types/correction.types'
import {
  recalculateAndCreateRevisionAction,
  startAttendanceCorrectionAction,
} from '@/features/payroll-correction/actions/correction.actions'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
    back: vi.fn(),
  }),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  recalculateAndCreateRevisionAction: vi.fn(),
  startAttendanceCorrectionAction: vi.fn(),
  abandonCorrectionAction: vi.fn(),
  approveAdjustmentInCorrectionAction: vi.fn(),
}))

vi.mock('@/features/payroll-adjustments/actions/adjustment.actions', () => ({
  skipAdjustmentApplicationAction: vi.fn(),
}))

// ─── Fixture ──────────────────────────────────────────────────────────────────

const MOCK_CORRECTION_DATA: InitiateCorrectionResult = {
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

const MOCK_SESSION: CorrectionSessionInfo = {
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

describe('CorrectionFlow — Attendance correction edits punches, no upload (F12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Test 1: no file upload is offered ────────────────────────────────────
  it('offers no file upload when the Attendance correction option is checked', () => {
    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" activeSession={MOCK_SESSION} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    expect(screen.queryByText(/Drag and drop your attendance file here/i)).not.toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    expect(screen.getByText(/Edit this week's punches/i)).toBeInTheDocument()
  })

  // ── Test 2: Continue to punches when Attendance is selected ──────────────
  it('shows "Continue to punches" when Attendance is selected and starts the attendance correction', async () => {
    vi.mocked(startAttendanceCorrectionAction).mockResolvedValue({ ok: true, data: { sessionId: 'session-uuid-1' } })

    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" activeSession={MOCK_SESSION} />)

    // Nothing selected: the primary button is the disabled "Recalculate & Preview"
    expect(screen.getByRole('button', { name: /recalculate & preview/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    expect(screen.queryByRole('button', { name: /recalculate & preview/i })).not.toBeInTheDocument()
    const continueBtn = screen.getByRole('button', { name: /continue to punches/i })
    expect(continueBtn).not.toBeDisabled()

    fireEvent.click(continueBtn)

    await waitFor(() => {
      expect(startAttendanceCorrectionAction).toHaveBeenCalledWith('run-uuid-1', {
        reason: null,
        types: ['ATTENDANCE'],
      })
    })
    expect(recalculateAndCreateRevisionAction).not.toHaveBeenCalled()
  })

  // ── Test 3: other corrections still recalculate straight to the preview ──
  it('recalculates and opens the preview when Attendance is not selected', async () => {
    vi.mocked(recalculateAndCreateRevisionAction).mockResolvedValue({
      ok: true,
      data: {
        payrollRunId: 'run-uuid-1',
        revisionId: 'revision-uuid-2',
        revisionNumber: 2,
        totals: MOCK_CORRECTION_DATA.totals,
        employeeCount: 0,
      },
    })

    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" activeSession={MOCK_SESSION} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /employee data updated/i }))
    fireEvent.click(screen.getByRole('button', { name: /recalculate & preview/i }))

    await waitFor(() => {
      expect(recalculateAndCreateRevisionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          payrollRunId: 'run-uuid-1',
          correctionTypes: ['EMPLOYEE_DATA'],
          correctionSessionId: 'session-uuid-1',
        }),
      )
      expect(push).toHaveBeenCalledWith('/payroll/run/run-uuid-1/correct/preview')
    })
    expect(startAttendanceCorrectionAction).not.toHaveBeenCalled()
  })
})
