import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'

// US-12.35 AC2: /employees/new renders without any attendance upload session, and passes the
// return context from its search params to the form. The edit page does the same for returnTo.

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))

// A stand-in form that shows what the page passed it.
vi.mock('@/features/employee-management/components/EmployeeForm', () => ({
  EmployeeForm: (props: { mode: string; returnContext?: unknown; employee?: { employeeName: string } }) => (
    <div
      data-testid="employee-form"
      data-mode={props.mode}
      data-return-context={JSON.stringify(props.returnContext ?? null)}
      data-employee={props.employee?.employeeName ?? ''}
    />
  ),
}))

vi.mock('@/features/employee-management/services/employee.service', () => ({
  getEmployeeById: vi.fn(),
  getEmployeeWageHistory: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

import NewEmployeePage from '@/app/employees/new/page'
import EditEmployeePage from '@/app/employees/[id]/edit/page'
import { getEmployeeById, getEmployeeWageHistory } from '@/features/employee-management/services/employee.service'

const CHECK_PATH = '/attendance/2026-11-05/employee-check'

function returnContextOf(element: HTMLElement) {
  return JSON.parse(element.getAttribute('data-return-context') as string)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/employees/new', () => {
  it('renders the employee form with no search params at all (no upload session needed)', async () => {
    render(await NewEmployeePage({ searchParams: Promise.resolve({}) }))

    const form = screen.getByTestId('employee-form')
    expect(form).toHaveAttribute('data-mode', 'create')
    expect(returnContextOf(form)).toBeNull()
  })

  it('ignores a leftover attendanceSession parameter', async () => {
    render(await NewEmployeePage({ searchParams: Promise.resolve({ attendanceSession: 'abc-123' } as never) }))

    const form = screen.getByTestId('employee-form')
    expect(form).toHaveAttribute('data-mode', 'create')
    expect(returnContextOf(form)).toBeNull()
  })

  it('passes the return path, name and code from the employee check to the form', async () => {
    render(
      await NewEmployeePage({
        searchParams: Promise.resolve({ returnTo: CHECK_PATH, name: 'Empname0999', code: '0999' }),
      }),
    )

    expect(returnContextOf(screen.getByTestId('employee-form'))).toEqual({
      returnTo: CHECK_PATH,
      backLabel: 'Return to employee check',
      prefillName: 'Empname0999',
      employeeIdHint: 'Employee ID must end in 999 to match code 0999',
    })
  })

  it('drops a returnTo that leaves the app', async () => {
    render(
      await NewEmployeePage({
        searchParams: Promise.resolve({ returnTo: 'https://evil.example/attendance/x', name: 'Empname0999', code: '0999' }),
      }),
    )

    expect(returnContextOf(screen.getByTestId('employee-form'))).toBeNull()
  })

  it('does not import or call any attendance upload session code', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/employees/new/page.tsx'), 'utf8')

    expect(source).not.toMatch(/attendanceSession/i)
    expect(source).not.toMatch(/getAttendanceUploadSessionAction/)
    expect(source).not.toMatch(/attendance-upload/)
    expect(source).not.toMatch(/session\.actions/)
  })
})

describe('/employees/[id]/edit', () => {
  beforeEach(() => {
    vi.mocked(getEmployeeById).mockResolvedValue({ id: 'emp-1', employeeName: 'Kavitha Rajan' } as never)
    vi.mocked(getEmployeeWageHistory).mockResolvedValue([{ weeklySalary: 15000, hourlyRate: 70 }] as never)
  })

  it('renders the form with a back link to the employee check when returnTo is given', async () => {
    render(
      await EditEmployeePage({
        params: Promise.resolve({ id: 'emp-1' }),
        searchParams: Promise.resolve({ returnTo: CHECK_PATH }),
      }),
    )

    const form = screen.getByTestId('employee-form')
    expect(form).toHaveAttribute('data-mode', 'edit')
    expect(form).toHaveAttribute('data-employee', 'Kavitha Rajan')
    expect(returnContextOf(form)).toEqual({ returnTo: CHECK_PATH, backLabel: 'Return to employee check' })
  })

  it('renders the plain form without a returnTo or with a bad one', async () => {
    const { unmount } = render(
      await EditEmployeePage({ params: Promise.resolve({ id: 'emp-1' }), searchParams: Promise.resolve({}) }),
    )
    expect(returnContextOf(screen.getByTestId('employee-form'))).toBeNull()
    unmount()

    render(
      await EditEmployeePage({
        params: Promise.resolve({ id: 'emp-1' }),
        searchParams: Promise.resolve({ returnTo: '//evil.example/attendance/x' }),
      }),
    )
    expect(returnContextOf(screen.getByTestId('employee-form'))).toBeNull()
  })
})
