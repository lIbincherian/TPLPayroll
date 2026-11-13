import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EmployeeForm, type EmployeeReturnContext } from '@/features/employee-management/components/EmployeeForm'
import type { EmployeeRecord } from '@/features/employee-management/types/employee.types'
import { createEmployeeAction, updateEmployeeAction } from '@/features/employee-management/actions/employee.actions'

// US-12.35 AC3 / spec §2.9: opened from the employee check, the form pre-fills the name, shows a
// back link and an Employee ID hint, and returns to the check after saving. Without a return
// context it behaves as before.

const push = vi.fn()
const back = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back }),
}))

vi.mock('@/features/employee-management/actions/employee.actions', () => ({
  createEmployeeAction: vi.fn(),
  updateEmployeeAction: vi.fn(),
}))

const RETURN_TO = '/attendance/2026-11-05/employee-check'

const context: EmployeeReturnContext = {
  returnTo: RETURN_TO,
  backLabel: 'Return to employee check',
  prefillName: 'Empname0999',
  employeeIdHint: 'Employee ID must end in 999 to match code 0999',
}

function placeholder(text: string) {
  return screen.getByPlaceholderText(text) as HTMLInputElement
}

function fillRequiredCreateFields(employeeId: string) {
  fireEvent.change(placeholder('EMP-042'), { target: { value: employeeId } })
  fireEvent.change(placeholder('Guard'), { target: { value: 'Guard' } })
  fireEvent.change(placeholder('14375'), { target: { value: '15000' } })
  fireEvent.change(placeholder('68.75'), { target: { value: '70' } })
}

const existingEmployee = {
  id: 'emp-uuid-1',
  employeeId: 'TPLGOAHLP007',
  employeeName: 'Kavitha Rajan',
  designation: 'Guard',
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
} as unknown as EmployeeRecord

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EmployeeForm — create from the employee check', () => {
  it('pre-fills the Employee Name from eTimeOffice and shows the Employee ID hint', () => {
    render(<EmployeeForm mode="create" returnContext={context} />)

    expect(placeholder('Lakshmi Venkatesh').value).toBe('Empname0999')
    expect(screen.getByTestId('employee-id-hint')).toHaveTextContent('Employee ID must end in 999 to match code 0999')
  })

  it('shows "Return to employee check" instead of "Back to directory", and the link returns there', () => {
    render(<EmployeeForm mode="create" returnContext={context} />)

    expect(screen.queryByText('Back to directory')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /return to employee check/i }))

    expect(push).toHaveBeenCalledWith(RETURN_TO)
  })

  it('goes back to the employee check, not to the new profile, after saving', async () => {
    vi.mocked(createEmployeeAction).mockResolvedValue({ ok: true, data: { id: 'new-emp-id' } } as never)
    render(<EmployeeForm mode="create" returnContext={context} />)

    fillRequiredCreateFields('TPLGOAHLP999')
    fireEvent.click(screen.getByRole('button', { name: /save employee/i }))

    await waitFor(() => expect(createEmployeeAction).toHaveBeenCalledTimes(1))
    expect(createEmployeeAction).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'TPLGOAHLP999', employeeName: 'Empname0999', designation: 'Guard', salary: 15000, hourlyRate: 70 }),
    )
    await waitFor(() => expect(push).toHaveBeenCalledWith(RETURN_TO))
    expect(push).not.toHaveBeenCalledWith('/employees/new-emp-id')
    // The return path carries no query parameters.
    expect(push.mock.calls.at(-1)?.[0]).not.toContain('?')
  })

  it('stays on the form and shows the error when the save fails', async () => {
    vi.mocked(createEmployeeAction).mockResolvedValue({ ok: false, error: 'Employee ID "TPLGOAHLP999" already exists', code: 'DUPLICATE_EMPLOYEE_ID' } as never)
    render(<EmployeeForm mode="create" returnContext={context} />)

    fillRequiredCreateFields('TPLGOAHLP999')
    fireEvent.click(screen.getByRole('button', { name: /save employee/i }))

    expect(await screen.findByText('Employee ID "TPLGOAHLP999" already exists')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})

describe('EmployeeForm — create without a return context', () => {
  it('shows "Back to directory", no pre-filled name and no hint', () => {
    render(<EmployeeForm mode="create" />)

    expect(screen.getByRole('button', { name: /back to directory/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /return to employee check/i })).not.toBeInTheDocument()
    expect(placeholder('Lakshmi Venkatesh').value).toBe('')
    expect(screen.queryByTestId('employee-id-hint')).not.toBeInTheDocument()
  })

  it('opens the new profile after saving', async () => {
    vi.mocked(createEmployeeAction).mockResolvedValue({ ok: true, data: { id: 'new-emp-id' } } as never)
    render(<EmployeeForm mode="create" />)

    fireEvent.change(placeholder('Lakshmi Venkatesh'), { target: { value: 'New Person' } })
    fillRequiredCreateFields('TPLGOAHLP100')
    fireEvent.click(screen.getByRole('button', { name: /save employee/i }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/employees/new-emp-id'))
  })
})

describe('EmployeeForm — edit from the employee check', () => {
  const editContext: EmployeeReturnContext = { returnTo: RETURN_TO, backLabel: 'Return to employee check' }

  it('shows the back link to the employee check and no Employee ID hint', () => {
    render(<EmployeeForm mode="edit" employee={existingEmployee} currentSalary={15000} currentHourlyRate={70} returnContext={editContext} />)

    expect(screen.getByRole('button', { name: /return to employee check/i })).toBeInTheDocument()
    expect(screen.queryByTestId('employee-id-hint')).not.toBeInTheDocument()
    expect(placeholder('Lakshmi Venkatesh').value).toBe('Kavitha Rajan')
  })

  it('returns to the employee check after saving a corrected employee', async () => {
    vi.mocked(updateEmployeeAction).mockResolvedValue({ ok: true, data: {} } as never)
    render(<EmployeeForm mode="edit" employee={existingEmployee} currentSalary={15000} currentHourlyRate={70} returnContext={editContext} />)

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateEmployeeAction).toHaveBeenCalledWith('emp-uuid-1', expect.any(Object)))
    await waitFor(() => expect(push).toHaveBeenCalledWith(RETURN_TO))
  })

  it('opens the employee profile after saving when there is no return context', async () => {
    vi.mocked(updateEmployeeAction).mockResolvedValue({ ok: true, data: {} } as never)
    render(<EmployeeForm mode="edit" employee={existingEmployee} currentSalary={15000} currentHourlyRate={70} />)

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/employees/emp-uuid-1'))
  })
})

describe('EmployeeForm — clearing an optional field on edit (issue #36)', () => {
  it('sends gPay: null when GPay Number is cleared', async () => {
    vi.mocked(updateEmployeeAction).mockResolvedValue({ ok: true, data: {} } as never)
    const withGPay = { ...existingEmployee, gPay: '9876543210' } as EmployeeRecord
    render(<EmployeeForm mode="edit" employee={withGPay} currentSalary={15000} currentHourlyRate={70} />)

    // Phone and GPay share a placeholder; GPay is the second field.
    const gPayInput = screen.getAllByPlaceholderText('+91 98765 43210')[1] as HTMLInputElement
    expect(gPayInput.value).toBe('9876543210')
    fireEvent.change(gPayInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() =>
      expect(updateEmployeeAction).toHaveBeenCalledWith('emp-uuid-1', expect.objectContaining({ gPay: null })),
    )
  })
})
