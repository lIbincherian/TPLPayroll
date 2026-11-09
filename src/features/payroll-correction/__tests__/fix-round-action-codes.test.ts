import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix round, items 1 and 4: the new refusal codes reach the screens through the server actions
// (the preview goes back on REVISION_STALE, the payroll flow goes back on ATTENDANCE_CHANGED), so
// the actions must carry the code, not just the message.

vi.mock('@/features/payroll-correction/services/correction.service', () => ({
  initiateCorrection: vi.fn(),
  reverseAdjustmentApplication: vi.fn(),
  approveSkippedAdjustment: vi.fn(),
  recalculateAndCreateRevision: vi.fn(),
  approveRevision: vi.fn(),
  getRevisionHistory: vi.fn(),
  getRevisionEmployees: vi.fn(),
  beginCorrection: vi.fn(),
  startAttendanceCorrection: vi.fn(),
  approveCorrectionPunches: vi.fn(),
  abandonCorrection: vi.fn(),
}))
vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  getAvailablePayrollWeeks: vi.fn(),
  checkAttendanceReadiness: vi.fn(),
  getPendingAdjustmentsForWeek: vi.fn(),
  calculatePayroll: vi.fn(),
  approvePayroll: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

import { approveRevision } from '@/features/payroll-correction/services/correction.service'
import { approveRevisionAction } from '@/features/payroll-correction/actions/correction.actions'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import { approvePayroll, calculatePayroll } from '@/features/payroll-generation/services/payroll.service'
import { approvePayrollAction, calculatePayrollAction } from '@/features/payroll-generation/actions/payroll.actions'
import { PayrollServiceError } from '@/features/payroll-generation/types/payroll.types'
import type { PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('approveRevisionAction', () => {
  it('returns REVISION_STALE with its message', async () => {
    vi.mocked(approveRevision).mockRejectedValue(
      new CorrectionServiceError('REVISION_STALE', 'This preview is out of date: the punches changed after it was calculated. Approve the punches again.'),
    )

    await expect(approveRevisionAction('draft-1')).resolves.toEqual({
      ok: false,
      error: 'This preview is out of date: the punches changed after it was calculated. Approve the punches again.',
      code: 'REVISION_STALE',
    })
  })

  it('returns CORRECTION_NOT_ACTIVE with its code', async () => {
    vi.mocked(approveRevision).mockRejectedValue(
      new CorrectionServiceError('CORRECTION_NOT_ACTIVE', 'This correction is no longer in progress.'),
    )

    await expect(approveRevisionAction('draft-1')).resolves.toMatchObject({ ok: false, code: 'CORRECTION_NOT_ACTIVE' })
  })

  it('does not leak the message of an unexpected error', async () => {
    vi.mocked(approveRevision).mockRejectedValue(new Error('password authentication failed for user "postgres"'))

    const result = await approveRevisionAction('draft-1')

    expect(result).toEqual({ ok: false, error: 'An unexpected error occurred', code: undefined })
  })
})

describe('payroll actions', () => {
  const summary = {
    weekStart: new Date('2026-11-05T00:00:00Z'),
    weekEnd: new Date('2026-11-11T00:00:00Z'),
    attendanceApprovedAt: new Date('2026-11-12T08:00:00Z'),
    employees: [],
    totals: {},
  } as unknown as PayrollSummary

  it('approvePayrollAction returns ATTENDANCE_CHANGED with its message', async () => {
    vi.mocked(approvePayroll).mockRejectedValue(
      new PayrollServiceError('ATTENDANCE_CHANGED', 'Attendance for this week changed after this summary was calculated. Go back and recalculate.'),
    )

    await expect(approvePayrollAction(summary)).resolves.toEqual({
      ok: false,
      error: 'Attendance for this week changed after this summary was calculated. Go back and recalculate.',
      code: 'ATTENDANCE_CHANGED',
    })
    expect(approvePayroll).toHaveBeenCalledWith(summary)
  })

  it('approvePayrollAction returns ATTENDANCE_NOT_APPROVED with its code', async () => {
    vi.mocked(approvePayroll).mockRejectedValue(
      new PayrollServiceError('ATTENDANCE_NOT_APPROVED', "Attendance for this week isn't approved yet"),
    )

    await expect(approvePayrollAction(summary)).resolves.toMatchObject({ ok: false, code: 'ATTENDANCE_NOT_APPROVED' })
  })

  it('calculatePayrollAction returns the summary with the approval time of the attendance', async () => {
    vi.mocked(calculatePayroll).mockResolvedValue(summary)

    const result = await calculatePayrollAction(summary.weekStart, summary.weekEnd)

    expect(result).toEqual({ ok: true, data: summary })
    expect(result.ok && result.data.attendanceApprovedAt).toEqual(new Date('2026-11-12T08:00:00Z'))
  })
})
