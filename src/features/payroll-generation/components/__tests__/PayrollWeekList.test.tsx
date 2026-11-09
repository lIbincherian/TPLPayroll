import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('@/features/payroll-generation/services/payroll.service', () => ({
  getAvailablePayrollWeeks: vi.fn(),
}))

import { getAvailablePayrollWeeks } from '@/features/payroll-generation/services/payroll.service'
import { PayrollWeekList } from '@/features/payroll-generation/components/PayrollWeekList'
import type { PayrollWeekItem } from '@/features/payroll-generation/types/payroll.types'

function makeWeek(overrides: Partial<PayrollWeekItem> & { weekId: string }): PayrollWeekItem {
  const start = new Date(`${overrides.weekId}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000)
  return {
    weekStart: start,
    weekEnd: end,
    attendanceStatus: 'APPROVED',
    source: 'ETIMEOFFICE',
    matchedEmployeeCount: 3,
    totalRegularHours: 24,
    totalOvertimeHours: 0,
    payrollStatus: 'NOT_GENERATED',
    payrollRunId: null,
    canGenerate: true,
    ...overrides,
  }
}

/** Renders the (async server) component and returns the table row that shows this week. */
async function renderAndGetRow(week: PayrollWeekItem, label: string) {
  vi.mocked(getAvailablePayrollWeeks).mockResolvedValue([week])
  render(await PayrollWeekList())
  return screen.getByText(label).closest('tr') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PayrollWeekList: approved eTimeOffice week without payroll', () => {
  it('links the Approved badge to the punch review and offers a Generate link', async () => {
    const row = await renderAndGetRow(makeWeek({ weekId: '2026-11-05' }), '5 Nov 2026 – 11 Nov 2026')

    const badge = within(row).getByRole('link', { name: /approved/i })
    expect(badge).toHaveAttribute('href', '/attendance/2026-11-05/review')
    expect(within(row).getByRole('link', { name: 'Generate' })).toHaveAttribute('href', '/payroll/generate/2026-11-05')
    expect(within(row).getByText('Not generated')).toBeInTheDocument()
  })
})

describe('PayrollWeekList: attendance not approved (US-12.26)', () => {
  it('shows "Ready for review" for a week in review, linked to its review, and disables Generate with a reason', async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2026-11-05', attendanceStatus: 'REVIEW', canGenerate: false }),
      '5 Nov 2026 – 11 Nov 2026',
    )

    expect(within(row).getByRole('link', { name: 'Ready for review' })).toHaveAttribute(
      'href',
      '/attendance/2026-11-05/review',
    )
    // Disabled: not a link, carries the reason as its title.
    expect(within(row).queryByRole('link', { name: 'Generate' })).not.toBeInTheDocument()
    expect(within(row).getByText('Generate')).toHaveAttribute('title', "Approve this week's attendance first")
  })

  it('shows "Sync failed" linked to the Attendance page and asks to load the week first', async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2026-11-05', attendanceStatus: 'SYNC_FAILED', canGenerate: false }),
      '5 Nov 2026 – 11 Nov 2026',
    )

    expect(within(row).getByRole('link', { name: 'Sync failed' })).toHaveAttribute('href', '/attendance')
    expect(within(row).queryByRole('link', { name: 'Generate' })).not.toBeInTheDocument()
    expect(within(row).getByText('Generate')).toHaveAttribute('title', "Load this week's attendance first")
  })

  it('shows "No data" linked to the Attendance page and asks to load the week first', async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2026-11-05', attendanceStatus: 'NO_DATA', canGenerate: false, matchedEmployeeCount: 0 }),
      '5 Nov 2026 – 11 Nov 2026',
    )

    expect(within(row).getByRole('link', { name: 'No data' })).toHaveAttribute('href', '/attendance')
    expect(within(row).getByText('Generate')).toHaveAttribute('title', "Load this week's attendance first")
  })
})

describe('PayrollWeekList: Excel-era weeks (C6)', () => {
  it("shows an approved Excel-era week but disables Generate with \"Excel-era weeks can't start payroll\"", async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2025-03-06', source: 'EXCEL', canGenerate: false }),
      '6 Mar 2025 – 12 Mar 2025',
    )

    expect(within(row).getByRole('link', { name: /approved/i })).toBeInTheDocument()
    expect(within(row).queryByRole('link', { name: 'Generate' })).not.toBeInTheDocument()
    expect(within(row).getByText('Generate')).toHaveAttribute('title', "Excel-era weeks can't start payroll")
  })
})

describe('PayrollWeekList: weeks that already have payroll', () => {
  it('shows View linked to the payroll run, and no Generate', async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2026-11-05', payrollStatus: 'APPROVED', payrollRunId: 'run-123', canGenerate: false }),
      '5 Nov 2026 – 11 Nov 2026',
    )

    expect(within(row).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/payroll/run/run-123')
    expect(within(row).queryByText('Generate')).not.toBeInTheDocument()
  })

  it('shows a Revised badge for a revised run', async () => {
    const row = await renderAndGetRow(
      makeWeek({ weekId: '2026-11-05', payrollStatus: 'REVISED', payrollRunId: 'run-123', canGenerate: false }),
      '5 Nov 2026 – 11 Nov 2026',
    )

    expect(within(row).getByText('Revised')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'View' })).toBeInTheDocument()
  })

  it('keeps View for an Excel-era week with approved payroll (history stays reachable)', async () => {
    const row = await renderAndGetRow(
      makeWeek({
        weekId: '2025-03-06',
        source: 'EXCEL',
        payrollStatus: 'APPROVED',
        payrollRunId: 'run-old',
        canGenerate: false,
      }),
      '6 Mar 2025 – 12 Mar 2025',
    )

    expect(within(row).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/payroll/run/run-old')
  })
})

describe('PayrollWeekList: list states', () => {
  it('shows one row per week', async () => {
    vi.mocked(getAvailablePayrollWeeks).mockResolvedValue([
      makeWeek({ weekId: '2026-11-05' }),
      makeWeek({ weekId: '2026-10-29', attendanceStatus: 'REVIEW', canGenerate: false }),
    ])

    render(await PayrollWeekList())

    // 1 header row + 2 week rows
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('shows an empty state that points to the Attendance page', async () => {
    vi.mocked(getAvailablePayrollWeeks).mockResolvedValue([])

    render(await PayrollWeekList())

    expect(screen.getByText('No attendance weeks found.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Attendance' })).toHaveAttribute('href', '/attendance')
  })

  it('does not swallow a failure to load the weeks', async () => {
    vi.mocked(getAvailablePayrollWeeks).mockRejectedValue(new Error('db down'))

    await expect(PayrollWeekList()).rejects.toThrow('db down')
  })
})
