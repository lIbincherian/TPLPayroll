import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttendanceVerificationStep } from '@/features/payroll-generation/components/AttendanceVerificationStep'
import type { AttendanceReadinessResult } from '@/features/payroll-generation/types/payroll.types'

const WEEK_ID = '2026-11-05'
const WEEK_LABEL = '5 Nov 2026 – 11 Nov 2026'

function renderStep(readiness: AttendanceReadinessResult, onContinue = vi.fn()) {
  render(
    <AttendanceVerificationStep
      weekId={WEEK_ID}
      weekLabel={WEEK_LABEL}
      readiness={readiness}
      onContinue={onContinue}
    />,
  )
  return onContinue
}

const READY: AttendanceReadinessResult = {
  ready: true,
  matchedEmployeeCount: 3,
  leftOutCount: 0,
  totalRegularHours: 24,
  totalOvertimeHours: 3.75,
}

describe('AttendanceVerificationStep: approved attendance (US-12.26)', () => {
  it('says how many employees are in and how many are left out', () => {
    renderStep(READY)

    expect(screen.getByText('Attendance approved: 3 employees, 0 left out')).toBeInTheDocument()
  })

  it('shows the left-out count from the approval', () => {
    renderStep({ ...READY, matchedEmployeeCount: 5, leftOutCount: 2 })

    expect(screen.getByText('Attendance approved: 5 employees, 2 left out')).toBeInTheDocument()
  })

  it('shows the totals with two decimals', () => {
    renderStep({ ...READY, totalRegularHours: 8, totalOvertimeHours: 1.25 })

    expect(screen.getByText('8.00')).toBeInTheDocument()
    expect(screen.getByText('1.25')).toBeInTheDocument()
    expect(screen.getByText('Total Employees').nextElementSibling).toHaveTextContent('3')
  })

  it('shows the week label', () => {
    renderStep(READY)

    expect(screen.getByText(WEEK_LABEL)).toBeInTheDocument()
  })

  it('offers Continue and calls onContinue when it is clicked', () => {
    const onContinue = renderStep(READY)

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('has no not-ready message and no link to attendance', () => {
    renderStep(READY)

    expect(screen.queryByText(/isn't approved yet/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('AttendanceVerificationStep: attendance not ready', () => {
  it("shows \"Attendance for this week isn't approved yet\" with a link to the punch review for a week in review", () => {
    renderStep({ ready: false, reason: 'NOT_APPROVED' })

    expect(screen.getByText("Attendance for this week isn't approved yet")).toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', `/attendance/${WEEK_ID}/review`)
    expect(link).toHaveTextContent('Review punches')
  })

  it('shows "No attendance loaded for this week" with a link to the Attendance page when there is no data', () => {
    renderStep({ ready: false, reason: 'NO_DATA' })

    expect(screen.getByText('No attendance loaded for this week')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/attendance')
    expect(screen.getByRole('link')).toHaveTextContent('Go to Attendance')
  })

  it('tells the user the eTimeOffice sync failed and links to the Attendance page', () => {
    renderStep({ ready: false, reason: 'SYNC_FAILED' })

    expect(screen.getByText('The eTimeOffice sync failed for this week')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/attendance')
  })

  it("says an Excel-era week can't start payroll and links to the Attendance page", () => {
    renderStep({ ready: false, reason: 'EXCEL_ERA' })

    expect(screen.getByText("This week was imported from Excel and can't start payroll")).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/attendance')
  })

  it.each(['NO_DATA', 'SYNC_FAILED', 'NOT_APPROVED', 'EXCEL_ERA'] as const)(
    'offers no Continue button and no hours totals when the reason is %s',
    (reason) => {
      renderStep({ ready: false, reason })

      expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Total Regular Hrs')).not.toBeInTheDocument()
      expect(screen.queryByText(/Attendance approved/)).not.toBeInTheDocument()
    },
  )

  it('builds the review link from the week id it is given', () => {
    render(
      <AttendanceVerificationStep
        weekId="2026-10-29"
        weekLabel="29 Oct 2026 – 4 Nov 2026"
        readiness={{ ready: false, reason: 'NOT_APPROVED' }}
        onContinue={vi.fn()}
      />,
    )

    expect(screen.getByRole('link')).toHaveAttribute('href', '/attendance/2026-10-29/review')
  })
})
