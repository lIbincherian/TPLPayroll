import { describe, it, expect } from 'vitest'
import { getPickerWeekState } from '../lib/week-picker'
import type { AttendanceWeekListItem } from '../types/attendance-sync.types'

const today = '2026-11-12'

function item(overrides: Partial<AttendanceWeekListItem> = {}): AttendanceWeekListItem {
  return {
    weekId: '2026-11-05',
    week: { start: '2026-11-05', end: '2026-11-11' },
    source: 'ETIMEOFFICE',
    status: 'NO_DATA',
    isSyncing: false,
    uploadId: null,
    employeeCount: 0,
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
    ...overrides,
  }
}

describe('getPickerWeekState (C2)', () => {
  it('disables a week that has not started', () => {
    const state = getPickerWeekState('2026-11-19', undefined, today)
    expect(state).toMatchObject({ disabled: true, hint: 'Not started' })
    expect(state.reason).toBeTruthy()
  })

  it('allows a week that started today (in progress)', () => {
    expect(getPickerWeekState('2026-11-12', undefined, today)).toEqual({ disabled: false })
  })

  it('allows a past week with no row', () => {
    expect(getPickerWeekState('2026-10-01', undefined, today)).toEqual({ disabled: false })
  })

  it('disables an Excel-era week', () => {
    expect(getPickerWeekState('2026-10-01', item({ source: 'EXCEL', status: 'APPROVED' }), today)).toMatchObject({
      disabled: true,
      hint: 'Excel',
    })
  })

  it.each(['APPROVED', 'REVISED'] as const)('disables a week whose payroll is %s', (payrollStatus) => {
    expect(getPickerWeekState('2026-11-05', item({ status: 'APPROVED', payrollStatus }), today)).toMatchObject({
      disabled: true,
      hint: 'Payroll approved',
    })
  })

  it('disables an approved week and tells the user to reopen it', () => {
    const state = getPickerWeekState('2026-11-05', item({ status: 'APPROVED' }), today)
    expect(state).toMatchObject({ disabled: true, hint: 'Approved' })
    expect(state.reason).toMatch(/Reopen/)
  })

  it('disables a week while a pull is running', () => {
    expect(getPickerWeekState('2026-11-05', item({ status: 'REVIEW', isSyncing: true }), today)).toMatchObject({
      disabled: true,
      hint: 'Pulling',
    })
  })

  it('allows a week with data and hints "Has data"', () => {
    expect(getPickerWeekState('2026-11-05', item({ status: 'REVIEW' }), today)).toEqual({
      disabled: false,
      hint: 'Has data',
    })
  })

  it('allows an in-progress week row and hints "In progress"', () => {
    expect(
      getPickerWeekState('2026-11-12', item({ weekId: '2026-11-12', status: 'NO_DATA', hasEnded: false }), today),
    ).toEqual({ disabled: false, hint: 'In progress' })
  })

  it('allows a past week that failed to sync with no hint', () => {
    expect(getPickerWeekState('2026-11-05', item({ status: 'SYNC_FAILED' }), today)).toEqual({ disabled: false })
  })
})
