import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { AttendanceWeekList } from '@/features/attendance-sync/components/AttendanceWeekList'
import type { AttendanceWeekListItem } from '@/features/attendance-sync/types/attendance-sync.types'

// "Newer data may be available. Pull now ..." is shown only where Pull now is possible: the week is in REVIEW
// or SYNC_FAILED, and the list says canPullNow. Never on an approved week, one whose payroll is approved, an
// Excel-era week, one that is syncing right now, or a week with no stale notice to show.

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

const NOTICE = 'Newer data may be available. Pull now to replace this week, discarding your edits.'
const STALE = '2026-11-12T00:30:00.000Z'

function week(overrides: Partial<AttendanceWeekListItem> = {}): AttendanceWeekListItem {
  return {
    weekId: '2026-11-05',
    week: { start: '2026-11-05', end: '2026-11-11' },
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
    staleNoticeAt: STALE,
    fileName: null,
    payrollStatus: 'NOT_GENERATED',
    payrollRunId: null,
    canPullNow: true,
    canReopen: false,
    hasEnded: true,
    ...overrides,
  }
}

function renderWeek(overrides: Partial<AttendanceWeekListItem> = {}) {
  render(<AttendanceWeekList weeks={[week(overrides)]} todayISO="2026-11-12" />)
  return screen.getByTestId('week-row-2026-11-05')
}

describe('the "newer data" notice', () => {
  it('shows on a week in REVIEW that can be pulled', () => {
    const row = renderWeek()

    expect(within(row).getByTestId('week-stale-notice')).toHaveTextContent(NOTICE)
    expect(within(row).getByTestId('pull-now-2026-11-05')).toBeInTheDocument()
  })

  it('shows on a SYNC_FAILED week that can be pulled (a failed pull left a notice from before)', () => {
    const row = renderWeek({ status: 'SYNC_FAILED', lastSyncError: 'eTimeOffice returned HTTP 500.' })

    expect(within(row).getByTestId('week-stale-notice')).toBeInTheDocument()
    expect(within(row).getByTestId('pull-now-2026-11-05')).toBeInTheDocument()
  })

  it('does not show on an APPROVED week (an approved week cannot be pulled), even if a notice is stored', () => {
    const row = renderWeek({ status: 'APPROVED', canPullNow: false, canReopen: true })

    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
    expect(within(row).queryByText(/Newer data may be available/)).not.toBeInTheDocument()
    expect(within(row).queryByTestId('pull-now-2026-11-05')).not.toBeInTheDocument()
  })

  it('does not show once the week\'s payroll is approved or revised (Pull now is gone), whatever the attendance status', () => {
    for (const payrollStatus of ['APPROVED', 'REVISED'] as const) {
      const { unmount } = render(<AttendanceWeekList weeks={[week({ status: 'REVIEW', payrollStatus, canPullNow: false })]} todayISO="2026-11-12" />)
      expect(screen.queryByTestId('week-stale-notice')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('does not show when Pull now is not on offer for any other reason (syncing now)', () => {
    const row = renderWeek({ isSyncing: true, canPullNow: false })

    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
  })

  it('does not show on an Excel-era week', () => {
    const row = renderWeek({ source: 'EXCEL', status: 'APPROVED', canPullNow: false, fileName: 'attendance.xlsx' })

    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
  })

  it('does not show on a week with no data (NO_DATA)', () => {
    const row = renderWeek({ source: null, status: 'NO_DATA', uploadId: null })

    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
  })

  it('does not show when there is no stale notice, even where Pull now is possible', () => {
    const row = renderWeek({ staleNoticeAt: null })

    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
    expect(within(row).getByTestId('pull-now-2026-11-05')).toBeInTheDocument()
  })

  it('shows beside "Last pull failed" on a REVIEW week that has both', () => {
    const row = renderWeek({ lastSyncError: 'eTimeOffice returned HTTP 500.', lastSyncAttemptAt: '2026-11-12T01:00:00.000Z' })

    const errors = within(row).getAllByTestId('week-error')
    expect(errors.map((e) => e.textContent).join(' ')).toContain('Last pull failed: eTimeOffice returned HTTP 500.')
    expect(within(row).getByTestId('week-stale-notice')).toBeInTheDocument()
  })

  it('"Last pull failed" still shows on a REVIEW week that can no longer be pulled, without the notice', () => {
    const row = renderWeek({ lastSyncError: 'eTimeOffice returned HTTP 500.', canPullNow: false, payrollStatus: 'APPROVED' })

    expect(within(row).getByTestId('week-error')).toHaveTextContent('Last pull failed: eTimeOffice returned HTTP 500.')
    expect(within(row).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
  })

  it('shows once per week in a list, only on the weeks that qualify', () => {
    render(
      <AttendanceWeekList
        weeks={[
          week({ weekId: '2026-11-12', week: { start: '2026-11-12', end: '2026-11-18' }, uploadId: 'u3' }),
          week({ weekId: '2026-11-05', uploadId: 'u2', status: 'APPROVED', canPullNow: false }),
          week({ weekId: '2026-10-29', week: { start: '2026-10-29', end: '2026-11-04' }, uploadId: 'u1', status: 'SYNC_FAILED' }),
        ]}
        todayISO="2026-11-12"
      />,
    )

    expect(screen.getAllByTestId('week-stale-notice')).toHaveLength(2)
    expect(within(screen.getByTestId('week-row-2026-11-05')).queryByTestId('week-stale-notice')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('week-row-2026-11-12')).getByTestId('week-stale-notice')).toBeInTheDocument()
    expect(within(screen.getByTestId('week-row-2026-10-29')).getByTestId('week-stale-notice')).toBeInTheDocument()
  })
})
