import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { SettingsForm } from '../SettingsForm'
import type { AppSettings } from '@/features/settings/types/settings.types'

// US-12.36 AC1/AC2: the payroll week start shows Thursday, read-only. Nothing on the page
// can change it, so there is no form, no field and no Save.

const THURSDAY: AppSettings = { payrollWeekStartDay: 'THURSDAY', currency: 'INR', docExpiryThresholdDays: 7 }

describe('SettingsForm — payroll week start is read-only', () => {
  it('shows Thursday as the payroll week start', () => {
    render(<SettingsForm initialSettings={THURSDAY} />)

    expect(screen.getByTestId('payroll-week-start-day')).toHaveTextContent('Thursday')
    expect(screen.getByText('Payroll Week Start Day')).toBeInTheDocument()
  })

  it('marks it as locked and explains the Thursday to Wednesday week', () => {
    render(<SettingsForm initialSettings={THURSDAY} />)

    expect(within(screen.getByTestId('payroll-week-start-day')).getByText('Locked')).toBeInTheDocument()
    expect(screen.getByText(/thursday to wednesday/i)).toBeInTheDocument()
  })

  it('offers no control that could change it', () => {
    const { container } = render(<SettingsForm initialSettings={THURSDAY} />)

    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('shows the fixed display defaults read-only too', () => {
    render(<SettingsForm initialSettings={THURSDAY} />)

    expect(screen.getByText('₹ INR')).toBeInTheDocument()
    expect(screen.getByText(/7 days/)).toBeInTheDocument()
  })

  it('only displays the value it is given: locking is the service job, and getSettings heals to Thursday', () => {
    render(<SettingsForm initialSettings={{ ...THURSDAY, payrollWeekStartDay: 'MONDAY' }} />)

    expect(screen.getByTestId('payroll-week-start-day')).toHaveTextContent('Monday')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
