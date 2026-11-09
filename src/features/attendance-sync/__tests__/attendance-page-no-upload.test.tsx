import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AttendanceWeekList } from '@/features/attendance-sync/components/AttendanceWeekList'
import type { AttendanceWeekListItem } from '@/features/attendance-sync/types/attendance-sync.types'

// US-12.34 AC1/AC4 and E2E-28: rendered, the Attendance page offers no file input or dropzone,
// whatever state the weeks are in, and each week offers the action for its state.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/attendance',
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

vi.mock('@/features/attendance-sync/actions/attendance-sync.actions', () => ({
  getPullWarningAction: vi.fn(),
  pullWeekAction: vi.fn(),
}))

// jsdom has no matchMedia, which the week picker's media query hook reads.
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

function week(weekStart: string, weekEnd: string, overrides: Partial<AttendanceWeekListItem> = {}): AttendanceWeekListItem {
  return {
    weekId: weekStart,
    week: { start: weekStart, end: weekEnd },
    source: 'ETIMEOFFICE',
    status: 'REVIEW',
    isSyncing: false,
    uploadId: `upload-${weekStart}`,
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

const WEEKS: AttendanceWeekListItem[] = [
  // No data yet: a virtual row with Pull now.
  week('2026-11-05', '2026-11-11', { source: null, status: 'NO_DATA', uploadId: null }),
  // The sync failed.
  week('2026-10-29', '2026-11-04', { status: 'SYNC_FAILED', lastSyncError: 'eTimeOffice returned HTTP 500.' }),
  // Loaded, waiting for review.
  week('2026-10-22', '2026-10-28', { status: 'REVIEW', employeeCount: 12 }),
  // Approved attendance.
  week('2026-10-15', '2026-10-21', { status: 'APPROVED', employeeCount: 12, totalRegularHours: 480, totalOvertimeHours: 12.5, canPullNow: false, canReopen: true }),
  // An Excel-era week, read-only.
  week('2026-10-08', '2026-10-14', { source: 'EXCEL', status: 'APPROVED', fileName: 'attendance-08Oct.xlsx', canPullNow: false }),
]

describe('Attendance page — no upload control', () => {
  it('renders no file input in any week state', () => {
    const { container } = render(<AttendanceWeekList weeks={WEEKS} todayISO="2026-11-12" />)

    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(container.querySelector('input[accept]')).toBeNull()
    expect(container.querySelector('form[enctype="multipart/form-data"]')).toBeNull()
  })

  it('renders no dropzone or drag-and-drop prompt', () => {
    const { container } = render(<AttendanceWeekList weeks={WEEKS} todayISO="2026-11-12" />)

    expect(screen.queryByText(/drag and drop/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/drop (your|a) file/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/browse files/i)).not.toBeInTheDocument()
    expect(container.querySelector('[data-testid*="dropzone"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /upload/i })).not.toBeInTheDocument()
  })

  it('renders no file input on an empty list either', () => {
    const { container } = render(<AttendanceWeekList weeks={[]} todayISO="2026-11-12" />)

    expect(screen.getByTestId('week-list-empty')).toBeInTheDocument()
    expect(container.querySelector('input[type="file"]')).toBeNull()
  })

  it('shows each week its own sync state instead (US-12.34 AC4)', () => {
    render(<AttendanceWeekList weeks={WEEKS} todayISO="2026-11-12" />)

    expect(screen.getByTestId('week-row-2026-11-05')).toHaveAttribute('data-status', 'NO_DATA')
    expect(screen.getByTestId('week-row-2026-10-29')).toHaveAttribute('data-status', 'SYNC_FAILED')
    expect(screen.getByTestId('week-row-2026-10-22')).toHaveAttribute('data-status', 'REVIEW')
    expect(screen.getByTestId('week-row-2026-10-15')).toHaveAttribute('data-status', 'APPROVED')
    expect(screen.getByTestId('week-row-2026-10-08')).toHaveAttribute('data-source', 'EXCEL')
    // The failure is shown with its error and Pull now is on offer.
    expect(screen.getByTestId('pull-now-2026-10-29')).toBeInTheDocument()
    expect(screen.getByText('eTimeOffice returned HTTP 500.')).toBeInTheDocument()
  })

  it('offers Pull now on weeks that can be pulled and not on approved or Excel-era weeks', () => {
    render(<AttendanceWeekList weeks={WEEKS} todayISO="2026-11-12" />)

    expect(screen.getByTestId('pull-now-2026-11-05')).toBeInTheDocument()
    expect(screen.getByTestId('pull-now-2026-10-22')).toBeInTheDocument()
    expect(screen.queryByTestId('pull-now-2026-10-15')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pull-now-2026-10-08')).not.toBeInTheDocument()
  })
})
