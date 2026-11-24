import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { EmployeeProfile } from '@/features/employee-management/components/EmployeeProfile'
import { EMPTY_SHEET_PROFILE } from '@/features/employee-management/lib/sheet-profile'
import type { EmployeeRecord } from '@/features/employee-management/types/employee.types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/features/employee-management/actions/employee.actions', () => ({
  deactivateEmployeeAction: vi.fn(),
  updateEmployeeAction: vi.fn(),
}))

function make(over: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: 'e1',
    employeeId: 'TPLGOAMSN001',
    serialNumber: null,
    employeeName: 'Ravi',
    designation: 'MASON',
    designationShort: null,
    nationalId: null,
    aadhaarId: null,
    policeVerificationId: null,
    phone: null,
    dateOfBirth: null,
    dateOfJoining: null,
    site: null,
    healthCardId: null,
    gPay: null,
    bankAccount: null,
    dateOfResignation: null,
    isActive: true,
    ...EMPTY_SHEET_PROFILE,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...over,
  } as EmployeeRecord
}

describe('EmployeeProfile sheet sections', () => {
  it('shows no sheet sections when every new field is empty', () => {
    render(<EmployeeProfile employee={make()} wageHistory={[]} />)
    expect(screen.queryByTestId('employee-sheet-sections')).not.toBeInTheDocument()
  })

  it('shows sensitive fields on the detail page and only sections that hold data', () => {
    render(
      <EmployeeProfile
        employee={make({ panNumber: 'ABCDE1234F', bankName: 'HDFC', ifscCode: 'HDFC0001234', homeState: 'Kerala' })}
        wageHistory={[]}
      />,
    )
    const box = screen.getByTestId('employee-sheet-sections')
    expect(within(box).getByText('Identity & documents')).toBeInTheDocument()
    expect(within(box).getByText('Bank')).toBeInTheDocument()
    expect(within(box).getByText('Home')).toBeInTheDocument()
    expect(within(box).queryByText('Contact & emergency')).not.toBeInTheDocument()
    expect(within(box).queryByText('Other')).not.toBeInTheDocument()
    expect(within(box).getByText('ABCDE1234F')).toBeInTheDocument()
    expect(within(box).getByText('HDFC0001234')).toBeInTheDocument()
  })

  it('https Drive links open in a new tab with noopener noreferrer', () => {
    render(<EmployeeProfile employee={make({ photoUrl: 'https://drive.google.com/file/d/abc/view' })} wageHistory={[]} />)
    const link = screen.getByRole('link', { name: /open in drive/i })
    expect(link).toHaveAttribute('href', 'https://drive.google.com/file/d/abc/view')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
    expect(link.getAttribute('rel')).toMatch(/noreferrer/)
  })

  it.each(['javascript:alert(1)', 'http://drive.google.com/x', 'data:text/html,<script>1</script>', 'ftp://x/y', 'drive.google.com/x'])(
    'never links %s; it is plain text',
    (url) => {
      render(<EmployeeProfile employee={make({ photoUrl: url })} wageHistory={[]} />)
      expect(screen.queryByRole('link', { name: /open in drive/i })).not.toBeInTheDocument()
      expect(screen.getByText(url)).toBeInTheDocument()
      expect(document.querySelector(`a[href="${url}"]`)).toBeNull()
    },
  )
})
