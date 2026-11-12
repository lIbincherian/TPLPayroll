import { describe, it, expect, vi, beforeEach } from 'vitest'

// The correction server actions (F12): beginning a correction opens a session and redirects,
// starting an attendance correction copies punches and redirects to the punches page, and
// abandoning returns a result instead of redirecting. Service errors come back as { ok: false }.

vi.mock('@/features/payroll-correction/services/correction.service', () => ({
  initiateCorrection: vi.fn(),
  recalculateAndCreateRevision: vi.fn(),
  approveRevision: vi.fn(),
  getRevisionHistory: vi.fn(),
  getRevisionEmployees: vi.fn(),
  beginCorrection: vi.fn(),
  startAttendanceCorrection: vi.fn(),
  approveCorrectionPunches: vi.fn(),
  abandonCorrection: vi.fn(),
}))

// next/navigation's redirect() works by throwing; keep that behaviour so the tests see where it went.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

import {
  beginCorrection,
  startAttendanceCorrection,
  approveCorrectionPunches,
  abandonCorrection,
  approveRevision,
  recalculateAndCreateRevision,
} from '@/features/payroll-correction/services/correction.service'
import {
  beginPayrollCorrectionAction,
  startAttendanceCorrectionAction,
  approveCorrectionPunchesAction,
  abandonCorrectionAction,
  approveRevisionAction,
  recalculateAndCreateRevisionAction,
} from '@/features/payroll-correction/actions/correction.actions'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'
import { redirect } from 'next/navigation'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('beginPayrollCorrectionAction', () => {
  it('opens the correction, then redirects to the correction flow', async () => {
    vi.mocked(beginCorrection).mockResolvedValue({ sessionId: 's-1', resumed: false, correctionTypes: [] })

    await expect(beginPayrollCorrectionAction('run-1')).rejects.toThrow('NEXT_REDIRECT:/payroll/run/run-1/correct')

    expect(beginCorrection).toHaveBeenCalledWith('run-1')
    expect(redirect).toHaveBeenCalledWith('/payroll/run/run-1/correct')
  })

  it('does not redirect when the run cannot be corrected', async () => {
    vi.mocked(beginCorrection).mockRejectedValue(
      new CorrectionServiceError('CANNOT_CORRECT_UNAPPROVED_PAYROLL', 'Cannot correct payroll with status "DRAFT"'),
    )

    await expect(beginPayrollCorrectionAction('run-1')).rejects.toThrow('Cannot correct payroll')
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe('startAttendanceCorrectionAction', () => {
  it('saves the reason and types, then redirects to the punches page', async () => {
    vi.mocked(startAttendanceCorrection).mockResolvedValue({ sessionId: 's-1', weekId: '2026-11-05' })

    await expect(
      startAttendanceCorrectionAction('run-1', { reason: null, types: ['ATTENDANCE'] }),
    ).rejects.toThrow('NEXT_REDIRECT:/payroll/run/run-1/correct/punches')

    expect(startAttendanceCorrection).toHaveBeenCalledWith('run-1', { reason: null, types: ['ATTENDANCE'] })
  })

  it("returns the Excel-era error as { ok: false } with its code and does not redirect", async () => {
    vi.mocked(startAttendanceCorrection).mockRejectedValue(
      new CorrectionServiceError('EXCEL_ERA_ATTENDANCE_CORRECTION', "Attendance can't be corrected for an Excel-era week"),
    )

    const result = await startAttendanceCorrectionAction('run-1', { reason: null, types: ['ATTENDANCE'] })

    expect(result).toEqual({
      ok: false,
      error: "Attendance can't be corrected for an Excel-era week",
      code: 'EXCEL_ERA_ATTENDANCE_CORRECTION',
    })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('returns a generic error for an unexpected failure', async () => {
    vi.mocked(startAttendanceCorrection).mockRejectedValue(new Error('db down'))

    const result = await startAttendanceCorrectionAction('run-1', { reason: null, types: ['ATTENDANCE'] })

    expect(result).toEqual({ ok: false, error: 'An unexpected error occurred', code: undefined })
  })
})

describe('approveCorrectionPunchesAction', () => {
  it('builds the draft, then redirects to the preview', async () => {
    vi.mocked(approveCorrectionPunches).mockResolvedValue({
      payrollRunId: 'run-1',
      revisionId: 'rev-2',
      revisionNumber: 2,
      totals: {} as never,
      employeeCount: 3,
    })

    await expect(approveCorrectionPunchesAction('run-1')).rejects.toThrow('NEXT_REDIRECT:/payroll/run/run-1/correct/preview')
  })

  it('shows the incomplete-pair error and stays on the punches page', async () => {
    vi.mocked(approveCorrectionPunches).mockRejectedValue(
      new CorrectionServiceError('CORRECTION_HAS_INCOMPLETE_PAIRS', '2 day(s) still have an incomplete pair. Fix or delete them first.'),
    )

    const result = await approveCorrectionPunchesAction('run-1')

    expect(result).toMatchObject({ ok: false, code: 'CORRECTION_HAS_INCOMPLETE_PAIRS' })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('maps an attendance error from the punch review the same way', async () => {
    vi.mocked(approveCorrectionPunches).mockRejectedValue(new AttendanceSyncError('CORRECTION_NOT_ACTIVE', 'No correction'))

    const result = await approveCorrectionPunchesAction('run-1')

    expect(result).toEqual({ ok: false, error: 'No correction', code: 'CORRECTION_NOT_ACTIVE' })
  })
})

describe('abandonCorrectionAction', () => {
  it('returns the result and does not redirect (the client navigates)', async () => {
    vi.mocked(abandonCorrection).mockResolvedValue({ sessionId: 's-1', discardedEdits: 2 })

    const result = await abandonCorrectionAction('run-1')

    expect(result).toEqual({ ok: true, data: { sessionId: 's-1', discardedEdits: 2 } })
    expect(abandonCorrection).toHaveBeenCalledWith('run-1')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('returns CORRECTION_NOT_ACTIVE when there is nothing to abandon', async () => {
    vi.mocked(abandonCorrection).mockRejectedValue(
      new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'No correction is in progress for this payroll run'),
    )

    const result = await abandonCorrectionAction('run-1')

    expect(result).toMatchObject({ ok: false, code: 'CORRECTION_NOT_ACTIVE' })
  })
})

describe('approveRevisionAction', () => {
  it('returns REVISION_NOT_DRAFT for a revision that is not a draft', async () => {
    vi.mocked(approveRevision).mockRejectedValue(new CorrectionServiceError('REVISION_NOT_DRAFT', 'Only a draft revision can be approved'))

    const result = await approveRevisionAction('rev-1')

    expect(result).toEqual({ ok: false, error: 'Only a draft revision can be approved', code: 'REVISION_NOT_DRAFT' })
  })

  it('returns the approved revision', async () => {
    const approvedAt = new Date('2026-11-12T10:00:00Z')
    vi.mocked(approveRevision).mockResolvedValue({ revisionId: 'rev-2', revisionNumber: 2, status: 'APPROVED', approvedAt })

    const result = await approveRevisionAction('rev-2')

    expect(result).toEqual({ ok: true, data: { revisionId: 'rev-2', revisionNumber: 2, status: 'APPROVED', approvedAt } })
  })
})

describe('recalculateAndCreateRevisionAction', () => {
  it('passes the correction session through to the service', async () => {
    vi.mocked(recalculateAndCreateRevision).mockResolvedValue({
      payrollRunId: 'run-1',
      revisionId: 'rev-2',
      revisionNumber: 2,
      totals: {} as never,
      employeeCount: 1,
    })

    await recalculateAndCreateRevisionAction({
      payrollRunId: 'run-1',
      correctionReason: null,
      correctionTypes: ['ADJUSTMENTS'],
      correctionSessionId: 's-1',
    })

    expect(recalculateAndCreateRevision).toHaveBeenCalledWith(expect.objectContaining({ correctionSessionId: 's-1' }))
  })
})
