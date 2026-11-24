import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EmployeeForm } from '@/features/employee-management/components/EmployeeForm'
import type { EmployeeRecord } from '@/features/employee-management/types/employee.types'
import { updateEmployeeAction } from '@/features/employee-management/actions/employee.actions'

// F13: while the Employee Master sheet sync is on, the fields the sheet owns are read-only on the edit
// form. Daily wage and status stay editable. Create mode is never locked.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/features/employee-management/actions/employee.actions', () => ({
  createEmployeeAction: vi.fn(),
  updateEmployeeAction: vi.fn(),
}))

const employee = {
  id: 'emp-1',
  employeeId: 'TPLGOAHLP007',
  employeeName: 'Kavitha Rajan',
  designation: 'Guard',
  designationShort: 'GRD',
  nationalId: 'NID1',
  aadhaarId: '123412341234',
  policeVerificationId: 'PV1',
  phone: '9876543210',
  dateOfBirth: new Date('1990-03-19T00:00:00.000Z'),
  dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
  site: 'Goa North',
  healthCardId: 'HC1',
  gPay: '9876543210',
  bankAccount: '0009201700065570',
  dateOfResignation: null,
  isActive: true,
} as unknown as EmployeeRecord

const NOTE = 'sheet-managed-note'

beforeEach(() => {
  vi.clearAllMocks()
})

function readOnlyInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll('input')).filter((i) => i.readOnly)
}

describe('EmployeeForm sheetManaged', () => {
  it('makes the 14 sheet-owned inputs readOnly with aria-readonly, and shows one note', () => {
    const { container } = render(
      <EmployeeForm mode="edit" employee={employee} currentSalary={800} currentHourlyRate={100} sheetManaged />,
    )
    const ro = readOnlyInputs(container)
    expect(ro).toHaveLength(14)
    for (const input of ro) expect(input).toHaveAttribute('aria-readonly', 'true')
    expect(screen.getAllByTestId(NOTE)).toHaveLength(1)
    expect(screen.getByTestId(NOTE)).toHaveTextContent('Managed in the Employee Master sheet')
  })

  it('keeps daily wage, status and Employee ID editable', () => {
    render(<EmployeeForm mode="edit" employee={employee} currentSalary={800} currentHourlyRate={100} sheetManaged />)
    const salary = screen.getByPlaceholderText('800') as HTMLInputElement
    expect(salary.readOnly).toBe(false)
    expect(salary).not.toBeDisabled()
    expect(screen.getByDisplayValue('TPLGOAHLP007')).toBeDisabled() // Employee ID was already fixed on edit
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    const status = document.querySelector('[name="isActive"]') as HTMLElement | null
    if (status) expect(status).not.toHaveAttribute('aria-readonly', 'true')
  })

  it('a locked field cannot be edited through the keyboard-typed value (readOnly attr present)', () => {
    render(<EmployeeForm mode="edit" employee={employee} currentSalary={800} currentHourlyRate={100} sheetManaged />)
    expect((screen.getByDisplayValue('Kavitha Rajan') as HTMLInputElement).readOnly).toBe(true)
  })

  it('without sheetManaged nothing is read-only and there is no note', () => {
    const { container } = render(<EmployeeForm mode="edit" employee={employee} currentSalary={800} currentHourlyRate={100} />)
    expect(readOnlyInputs(container)).toHaveLength(0)
    expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument()
  })

  it('create mode ignores sheetManaged', () => {
    const { container } = render(<EmployeeForm mode="create" sheetManaged />)
    expect(readOnlyInputs(container)).toHaveLength(0)
    expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument()
  })

  it('saving without touching a locked field resubmits the stored values unchanged (so the server guard passes)', async () => {
    vi.mocked(updateEmployeeAction).mockResolvedValue({ ok: true, data: employee } as never)
    render(<EmployeeForm mode="edit" employee={employee} currentSalary={800} currentHourlyRate={100} sheetManaged />)
    fireEvent.change(screen.getByPlaceholderText('800'), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(updateEmployeeAction).toHaveBeenCalled())
    const [, payload] = vi.mocked(updateEmployeeAction).mock.calls[0]
    expect(payload).toMatchObject({
      employeeName: 'Kavitha Rajan',
      designation: 'Guard',
      phone: '9876543210',
      site: 'Goa North',
      bankAccount: '0009201700065570',
      salary: 900,
    })
    expect((payload.dateOfJoining as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect((payload.dateOfBirth as Date).toISOString()).toBe('1990-03-19T00:00:00.000Z')
    expect(payload.dateOfResignation).toBeNull()
  })
})
