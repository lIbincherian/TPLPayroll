// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/features/attendance-sync/services/employee-check.service', () => ({
  getEmployeeCheck: vi.fn(),
  rematchWeekCodes: vi.fn(),
  matchCodeToEmployee: vi.fn(),
  ignoreCode: vi.fn(),
  setEmployeeDecision: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/punch-review.service', () => ({
  getPunchReview: vi.fn(),
  savePunchEdit: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/sync.service', () => ({
  getPullWarning: vi.fn(),
  pullNow: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/week-approval.service', () => ({
  approveWeek: vi.fn(),
  getApprovalSummary: vi.fn(),
  reopenWeek: vi.fn(),
}))
vi.mock('@/features/attendance-sync/services/week-list.service', () => ({
  listAttendanceWeeks: vi.fn(),
}))

import { revalidatePath } from 'next/cache'
import {
  approveWeekAction,
  getApprovalSummaryAction,
  getAttendanceWeeksAction,
  getEmployeeCheckAction,
  getPullWarningAction,
  getPunchReviewAction,
  ignoreCodeAction,
  matchCodeAction,
  pullWeekAction,
  reopenWeekAction,
  rematchWeekCodesAction,
  savePunchEditAction,
  setEmployeeDecisionAction,
} from '@/features/attendance-sync/actions/attendance-sync.actions'
import {
  getEmployeeCheck,
  ignoreCode,
  matchCodeToEmployee,
  rematchWeekCodes,
  setEmployeeDecision,
} from '@/features/attendance-sync/services/employee-check.service'
import { getPunchReview, savePunchEdit } from '@/features/attendance-sync/services/punch-review.service'
import { getPullWarning, pullNow } from '@/features/attendance-sync/services/sync.service'
import { approveWeek, getApprovalSummary, reopenWeek } from '@/features/attendance-sync/services/week-approval.service'
import { listAttendanceWeeks } from '@/features/attendance-sync/services/week-list.service'
import { AttendanceSyncError, type SavePunchEditInput } from '@/features/attendance-sync/types/attendance-sync.types'

const WEEK_ID = '2026-11-05'
const revalidate = vi.mocked(revalidatePath)

const services = {
  listAttendanceWeeks: vi.mocked(listAttendanceWeeks),
  getPullWarning: vi.mocked(getPullWarning),
  pullNow: vi.mocked(pullNow),
  getEmployeeCheck: vi.mocked(getEmployeeCheck),
  rematchWeekCodes: vi.mocked(rematchWeekCodes),
  matchCodeToEmployee: vi.mocked(matchCodeToEmployee),
  ignoreCode: vi.mocked(ignoreCode),
  setEmployeeDecision: vi.mocked(setEmployeeDecision),
  getPunchReview: vi.mocked(getPunchReview),
  savePunchEdit: vi.mocked(savePunchEdit),
  getApprovalSummary: vi.mocked(getApprovalSummary),
  approveWeek: vi.mocked(approveWeek),
  reopenWeek: vi.mocked(reopenWeek),
}

const SUMMARY = {
  employeeCount: 2,
  totalRegularHours: 16,
  totalOvertimeHours: 1.25,
  editedDays: 0,
  editedDayDetails: [],
  leftOut: [],
}

const validEdit: SavePunchEditInput = {
  weekId: WEEK_ID,
  employeeId: 'emp-36',
  date: '2026-11-05',
  mode: { kind: 'LIVE' },
  baseSignature: '4.1abc2def3',
  pairs: [{ pairIndex: 0, in: { punchId: 'p-0', time: '07:40' }, out: { punchId: 'p-1', time: '13:04' } }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const expectRevalidated = () => {
  expect(revalidate).toHaveBeenCalledWith('/attendance')
  expect(revalidate).toHaveBeenCalledWith('/payroll')
  expect(revalidate).toHaveBeenCalledTimes(2)
}

// ─── Error mapping ────────────────────────────────────────────────────────────

describe('error mapping', () => {
  it('turns an AttendanceSyncError into { ok: false, error, code }', async () => {
    services.pullNow.mockRejectedValue(new AttendanceSyncError('WEEK_APPROVED', 'This week is approved. Reopen it before pulling.'))

    await expect(pullWeekAction(WEEK_ID)).resolves.toEqual({
      ok: false,
      error: 'This week is approved. Reopen it before pulling.',
      code: 'WEEK_APPROVED',
    })
  })

  it('hides unexpected errors behind a generic message, without a code, and logs them', async () => {
    services.pullNow.mockRejectedValue(new Error('connection string postgres://user:secret@host'))

    const result = await pullWeekAction(WEEK_ID)

    expect(result).toEqual({ ok: false, error: 'An unexpected error occurred', code: undefined })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(console.error).toHaveBeenCalled()
  })

  it('carries the DayValidation of a VALIDATION_ERROR so the editor can mark the field', async () => {
    const validation = { valid: false, code: 'OUT_NOT_AFTER_IN', pairIndex: 1, field: 'out', message: 'OUT (07:00) must be after IN (08:00).' } as const
    services.savePunchEdit.mockRejectedValue(new AttendanceSyncError('VALIDATION_ERROR', validation.message, validation))

    const result = await savePunchEditAction(validEdit)

    expect(result).toEqual({ ok: false, error: validation.message, code: 'VALIDATION_ERROR', validation })
  })

  it('omits `validation` for a VALIDATION_ERROR without a DayValidation payload', async () => {
    services.savePunchEdit.mockRejectedValue(new AttendanceSyncError('VALIDATION_ERROR', 'That date is not in this payroll week.'))

    const result = await savePunchEditAction(validEdit)

    expect(result).toEqual({ ok: false, error: 'That date is not in this payroll week.', code: 'VALIDATION_ERROR' })
    expect(result).not.toHaveProperty('validation')
  })

  it('does not attach `validation` to other error codes, even with details', async () => {
    services.approveWeek.mockRejectedValue(
      new AttendanceSyncError('WEEK_NOT_READY', "This week can't be approved yet.", { blockers: ['NEEDS_FIXING'] }),
    )

    const result = await approveWeekAction(WEEK_ID)

    expect(result).toEqual({ ok: false, error: "This week can't be approved yet.", code: 'WEEK_NOT_READY' })
  })
})

// ─── Input validation: server actions are public endpoints ────────────────────

describe('input validation', () => {
  const bad = ['', 'garbage', '2026-11-5', '05/11/2026', "2026-11-05'; DROP TABLE x;--"]

  it.each(bad)('rejects a malformed week id %j before reaching any service', async (weekId) => {
    const invalid = { ok: false, error: 'The request was not valid.', code: 'VALIDATION_ERROR' }

    await expect(getPullWarningAction(weekId)).resolves.toEqual(invalid)
    await expect(pullWeekAction(weekId)).resolves.toEqual(invalid)
    await expect(getEmployeeCheckAction(weekId)).resolves.toEqual(invalid)
    await expect(rematchWeekCodesAction(weekId)).resolves.toEqual(invalid)
    await expect(matchCodeAction(weekId, '0999', 'emp-1')).resolves.toEqual(invalid)
    await expect(ignoreCodeAction(weekId, '0999')).resolves.toEqual(invalid)
    await expect(setEmployeeDecisionAction(weekId, 'emp-1', 'APPROVED')).resolves.toEqual(invalid)
    await expect(getPunchReviewAction(weekId)).resolves.toEqual(invalid)
    await expect(getApprovalSummaryAction(weekId)).resolves.toEqual(invalid)
    await expect(approveWeekAction(weekId)).resolves.toEqual(invalid)
    await expect(reopenWeekAction(weekId)).resolves.toEqual(invalid)

    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled()
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('rejects an empty code or employee id for match, ignore and decision', async () => {
    await expect(matchCodeAction(WEEK_ID, '', 'emp-1')).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    await expect(matchCodeAction(WEEK_ID, '0999', '')).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    await expect(ignoreCodeAction(WEEK_ID, '')).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    await expect(setEmployeeDecisionAction(WEEK_ID, '', 'APPROVED')).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(services.matchCodeToEmployee).not.toHaveBeenCalled()
    expect(services.ignoreCode).not.toHaveBeenCalled()
    expect(services.setEmployeeDecision).not.toHaveBeenCalled()
  })

  it('rejects a decision other than APPROVED or REJECTED', async () => {
    const result = await setEmployeeDecisionAction(WEEK_ID, 'emp-1', 'MAYBE' as never)

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(services.setEmployeeDecision).not.toHaveBeenCalled()
  })

  it('rejects a malformed review mode', async () => {
    await expect(getPunchReviewAction(WEEK_ID, { kind: 'ELSEWHERE' } as never)).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    await expect(
      getPunchReviewAction(WEEK_ID, { kind: 'CORRECTION', payrollRunId: 'run-1' } as never),
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    await expect(getApprovalSummaryAction(WEEK_ID, { kind: 'CORRECTION' } as never)).resolves.toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(services.getPunchReview).not.toHaveBeenCalled()
    expect(services.getApprovalSummary).not.toHaveBeenCalled()
  })

  describe('savePunchEditAction', () => {
    it.each([
      ['a negative pair index', { pairs: [{ pairIndex: -1, in: { time: '08:00' }, out: { time: '16:00' } }] }],
      ['a fractional pair index', { pairs: [{ pairIndex: 1.5, in: { time: '08:00' }, out: { time: '16:00' } }] }],
      ['more than 100 pairs', { pairs: Array.from({ length: 101 }, (_, i) => ({ pairIndex: i, in: { time: null }, out: { time: null } })) }],
      ['a time over 10 characters', { pairs: [{ pairIndex: 0, in: { time: '08:00:00.000Z' }, out: { time: '16:00' } }] }],
      ['a note over 1000 characters', { pairs: [{ pairIndex: 0, in: { time: '08:00', note: 'x'.repeat(1001) }, out: { time: '16:00' } }] }],
      ['a missing side', { pairs: [{ pairIndex: 0, in: { time: '08:00' } }] }],
      ['a bad date', { date: '5 Nov' }],
      ['an empty employee id', { employeeId: '' }],
      ['a bad week id', { weekId: 'x' }],
    ])('rejects %s', async (_label, override) => {
      const result = await savePunchEditAction({ ...validEdit, ...override } as SavePunchEditInput)

      expect(result).toEqual({ ok: false, error: 'The request was not valid.', code: 'VALIDATION_ERROR' })
      expect(services.savePunchEdit).not.toHaveBeenCalled()
    })

    it('passes a valid edit to the service, in correction mode too', async () => {
      services.savePunchEdit.mockResolvedValue({ savedAt: 'now' } as never)
      const correction = { ...validEdit, mode: { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 's-1', revisionNumber: 2 } } as SavePunchEditInput

      await expect(savePunchEditAction(validEdit)).resolves.toEqual({ ok: true, data: { savedAt: 'now' } })
      await savePunchEditAction(correction)

      expect(services.savePunchEdit).toHaveBeenNthCalledWith(1, validEdit)
      expect(services.savePunchEdit).toHaveBeenNthCalledWith(2, correction)
    })

    it('accepts blank, null and omitted notes', async () => {
      services.savePunchEdit.mockResolvedValue({} as never)
      const edit = {
        ...validEdit,
        pairs: [{ pairIndex: 0, in: { time: '08:00', note: null }, out: { time: '16:00', note: '' } }, { pairIndex: 1, in: { time: null }, out: { time: null } }],
      } as SavePunchEditInput

      await expect(savePunchEditAction(edit)).resolves.toMatchObject({ ok: true })
    })

    it('does not revalidate any page after a save (the grid updates from the response)', async () => {
      services.savePunchEdit.mockResolvedValue({} as never)

      await savePunchEditAction(validEdit)

      expect(revalidate).not.toHaveBeenCalled()
    })
  })
})

// ─── Read actions ─────────────────────────────────────────────────────────────

describe('read actions return ok with the service result and never revalidate', () => {
  it('getAttendanceWeeksAction', async () => {
    services.listAttendanceWeeks.mockResolvedValue([{ weekId: WEEK_ID }] as never)

    await expect(getAttendanceWeeksAction()).resolves.toEqual({ ok: true, data: [{ weekId: WEEK_ID }] })
  })

  it('getPullWarningAction', async () => {
    services.getPullWarning.mockResolvedValue({ hasData: true, editedDays: 12, decisions: 3 })

    await expect(getPullWarningAction(WEEK_ID)).resolves.toEqual({ ok: true, data: { hasData: true, editedDays: 12, decisions: 3 } })
    expect(services.getPullWarning).toHaveBeenCalledWith(WEEK_ID)
  })

  it('getEmployeeCheckAction', async () => {
    services.getEmployeeCheck.mockResolvedValue({ weekId: WEEK_ID } as never)

    await expect(getEmployeeCheckAction(WEEK_ID)).resolves.toEqual({ ok: true, data: { weekId: WEEK_ID } })
  })

  it('rematchWeekCodesAction', async () => {
    const matched = { matched: [{ empCode: '0999', employeeId: 'emp-999', employeeCode: 'TPLGOAHLP999' }], stillUnresolved: [] }
    services.rematchWeekCodes.mockResolvedValue(matched)

    await expect(rematchWeekCodesAction(WEEK_ID)).resolves.toEqual({ ok: true, data: matched })
  })

  it('getPunchReviewAction defaults to live mode and passes a correction mode through', async () => {
    services.getPunchReview.mockResolvedValue({ weekId: WEEK_ID } as never)

    await getPunchReviewAction(WEEK_ID)
    await getPunchReviewAction(WEEK_ID, { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 's-1', revisionNumber: 2 })

    expect(services.getPunchReview).toHaveBeenNthCalledWith(1, WEEK_ID, { kind: 'LIVE' })
    expect(services.getPunchReview).toHaveBeenNthCalledWith(2, WEEK_ID, { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 's-1', revisionNumber: 2 })
  })

  it('getApprovalSummaryAction', async () => {
    services.getApprovalSummary.mockResolvedValue(SUMMARY)

    await expect(getApprovalSummaryAction(WEEK_ID)).resolves.toEqual({ ok: true, data: SUMMARY })
    expect(services.getApprovalSummary).toHaveBeenCalledWith(WEEK_ID, { kind: 'LIVE' })
  })

  it('none of them revalidate a page', async () => {
    services.listAttendanceWeeks.mockResolvedValue([])
    services.getPullWarning.mockResolvedValue({ hasData: false, editedDays: 0, decisions: 0 })
    services.getEmployeeCheck.mockResolvedValue({} as never)
    services.rematchWeekCodes.mockResolvedValue({ matched: [], stillUnresolved: [] })
    services.getPunchReview.mockResolvedValue({} as never)
    services.getApprovalSummary.mockResolvedValue(SUMMARY)

    await getAttendanceWeeksAction()
    await getPullWarningAction(WEEK_ID)
    await getEmployeeCheckAction(WEEK_ID)
    await rematchWeekCodesAction(WEEK_ID)
    await getPunchReviewAction(WEEK_ID)
    await getApprovalSummaryAction(WEEK_ID)

    expect(revalidate).not.toHaveBeenCalled()
  })

  it('read actions map service failures too', async () => {
    services.getEmployeeCheck.mockRejectedValue(new AttendanceSyncError('EXCEL_ERA_WEEK', 'read-only'))
    services.listAttendanceWeeks.mockRejectedValue(new Error('boom'))

    await expect(getEmployeeCheckAction(WEEK_ID)).resolves.toMatchObject({ ok: false, code: 'EXCEL_ERA_WEEK' })
    await expect(getAttendanceWeeksAction()).resolves.toMatchObject({ ok: false, error: 'An unexpected error occurred' })
  })
})

// ─── Write actions: revalidation ──────────────────────────────────────────────

describe('pullWeekAction', () => {
  it('pulls the week, then revalidates /attendance and /payroll', async () => {
    services.pullNow.mockResolvedValue({ outcome: 'LOADED', punchCount: 4, discarded: null })

    await expect(pullWeekAction(WEEK_ID)).resolves.toEqual({ ok: true, data: { outcome: 'LOADED', punchCount: 4, discarded: null } })

    expect(services.pullNow).toHaveBeenCalledWith(WEEK_ID)
    expectRevalidated()
  })

  it('returns a failed pull as data (the week page shows the error) and still revalidates', async () => {
    services.pullNow.mockResolvedValue({ outcome: 'FAILED', code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })

    await expect(pullWeekAction(WEEK_ID)).resolves.toMatchObject({ ok: true, data: { outcome: 'FAILED', code: 'HTTP_STATUS' } })
    expectRevalidated()
  })

  it('does not revalidate when the pull throws', async () => {
    services.pullNow.mockRejectedValue(new AttendanceSyncError('SYNC_IN_PROGRESS', 'A pull for this week is already running.'))

    await expect(pullWeekAction(WEEK_ID)).resolves.toMatchObject({ ok: false, code: 'SYNC_IN_PROGRESS' })
    expect(revalidate).not.toHaveBeenCalled()
  })
})

describe('approveWeekAction', () => {
  it('approves, serialises the approval time to ISO and revalidates /attendance and /payroll', async () => {
    const approvedAt = new Date('2026-11-13T03:00:00Z')
    services.approveWeek.mockResolvedValue({ approvedAt, summary: SUMMARY })

    await expect(approveWeekAction(WEEK_ID)).resolves.toEqual({
      ok: true,
      data: { approvedAt: '2026-11-13T03:00:00.000Z', summary: SUMMARY },
    })
    expectRevalidated()
  })

  it('maps WEEK_NOT_READY and does not revalidate', async () => {
    services.approveWeek.mockRejectedValue(new AttendanceSyncError('WEEK_NOT_READY', 'not ready', { blockers: ['NEEDS_FIXING'] }))

    await expect(approveWeekAction(WEEK_ID)).resolves.toEqual({ ok: false, error: 'not ready', code: 'WEEK_NOT_READY' })
    expect(revalidate).not.toHaveBeenCalled()
  })
})

describe('reopenWeekAction', () => {
  it('reopens, serialises the time to ISO and revalidates', async () => {
    services.reopenWeek.mockResolvedValue({ reopenedAt: new Date('2026-11-13T04:00:00Z') })

    await expect(reopenWeekAction(WEEK_ID)).resolves.toEqual({ ok: true, data: { reopenedAt: '2026-11-13T04:00:00.000Z' } })
    expectRevalidated()
  })

  it('refuses once payroll is approved (PAYROLL_ALREADY_APPROVED) without revalidating', async () => {
    services.reopenWeek.mockRejectedValue(new AttendanceSyncError('PAYROLL_ALREADY_APPROVED', 'Use Correct on the payroll run.'))

    await expect(reopenWeekAction(WEEK_ID)).resolves.toMatchObject({ ok: false, code: 'PAYROLL_ALREADY_APPROVED' })
    expect(revalidate).not.toHaveBeenCalled()
  })
})

describe('employee check write actions', () => {
  it('matchCodeAction matches, returns the count and revalidates', async () => {
    services.matchCodeToEmployee.mockResolvedValue({ linkedPunches: 4 })

    await expect(matchCodeAction(WEEK_ID, '0999', 'emp-36')).resolves.toEqual({ ok: true, data: { linkedPunches: 4 } })
    expect(services.matchCodeToEmployee).toHaveBeenCalledWith(WEEK_ID, '0999', 'emp-36')
    expectRevalidated()
  })

  it('ignoreCodeAction ignores and revalidates', async () => {
    services.ignoreCode.mockResolvedValue({ ignoredPunches: 4 })

    await expect(ignoreCodeAction(WEEK_ID, '0999')).resolves.toEqual({ ok: true, data: { ignoredPunches: 4 } })
    expect(services.ignoreCode).toHaveBeenCalledWith(WEEK_ID, '0999')
    expectRevalidated()
  })

  it('setEmployeeDecisionAction records the decision and revalidates', async () => {
    services.setEmployeeDecision.mockResolvedValue({ decision: 'REJECTED' })

    await expect(setEmployeeDecisionAction(WEEK_ID, 'emp-2', 'REJECTED')).resolves.toEqual({ ok: true, data: { decision: 'REJECTED' } })
    expect(services.setEmployeeDecision).toHaveBeenCalledWith(WEEK_ID, 'emp-2', 'REJECTED')
    expectRevalidated()
  })

  it.each([
    ['matchCodeAction', () => matchCodeAction(WEEK_ID, '0999', 'emp-36'), 'matchCodeToEmployee'],
    ['ignoreCodeAction', () => ignoreCodeAction(WEEK_ID, '0999'), 'ignoreCode'],
    ['setEmployeeDecisionAction', () => setEmployeeDecisionAction(WEEK_ID, 'emp-2', 'APPROVED'), 'setEmployeeDecision'],
  ] as const)('%s maps a locked week to { ok: false, code: WEEK_LOCKED } without revalidating', async (_name, run, service) => {
    services[service].mockRejectedValue(new AttendanceSyncError('WEEK_LOCKED', 'This week is approved.'))

    await expect(run()).resolves.toEqual({ ok: false, error: 'This week is approved.', code: 'WEEK_LOCKED' })
    expect(revalidate).not.toHaveBeenCalled()
  })
})
