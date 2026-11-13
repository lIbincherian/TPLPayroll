import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusChangesNotice } from '@/features/attendance-sync/components/StatusChangesNotice'

const anita = { id: 'emp-1', employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' }
const bala = { id: 'emp-2', employeeId: 'E2E-HLP-9002', employeeName: 'Bala Singh' }

describe('StatusChangesNotice', () => {
  it('reads as one sentence, with a space before "when this week was approved"', () => {
    render(<StatusChangesNotice changes={{ markedInactive: [anita], reactivated: [bala] }} />)

    expect(screen.getByText(/when this week was approved/).closest('summary')?.textContent).toContain(
      '1 employee marked inactive, 1 reactivated when this week was approved.',
    )
  })

  it('lists the names under their change', () => {
    render(<StatusChangesNotice changes={{ markedInactive: [anita], reactivated: [bala] }} />)
    const notice = screen.getByTestId('status-changes-notice')

    expect(notice).toHaveTextContent('Marked inactiveAnita Rao (E2E-HLP-9001)')
    expect(notice).toHaveTextContent('ReactivatedBala Singh (E2E-HLP-9002)')
  })

  it('renders nothing when nobody changed', () => {
    const { container } = render(<StatusChangesNotice changes={{ markedInactive: [], reactivated: [] }} />)

    expect(container).toBeEmptyDOMElement()
  })
})
