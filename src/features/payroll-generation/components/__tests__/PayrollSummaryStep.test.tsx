import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { PayrollSummaryStep } from '@/features/payroll-generation/components/PayrollSummaryStep'
import type { EmployeePayrollRow, PayrollSummary } from '@/features/payroll-generation/types/payroll.types'

function employee(code: string, phone: string | null): EmployeePayrollRow {
  return {
    employeeId: `id-${code}`,
    employeeCode: code,
    employeeName: `Name ${code}`,
    designation: 'Guard',
    designationShort: null,
    site: null,
    gPay: null,
    phone,
    bankAccount: 'ACC1',
    weeklySalaryUsed: 2500,
    hourlyRateUsed: 62.5,
    regularHours: 40,
    overtimeHours: 2,
    regularPay: 2500,
    overtimePay: 125,
    grossPay: 2625,
    additions: 100,
    deductions: 50,
    netPayable: 2675,
  }
}

const SUMMARY: PayrollSummary = {
  weekStart: new Date('2026-11-05T00:00:00.000Z'),
  weekEnd: new Date('2026-11-11T00:00:00.000Z'),
  attendanceApprovedAt: new Date('2026-11-12T08:00:00.000Z'),
  employees: [employee('TPLGOASHT231', '9123456780'), employee('TPLGOASHT232', '  ')],
  totals: {
    totalEmployees: 2,
    totalRegularHours: 80,
    totalOvertimeHours: 4,
    totalRegularPay: 5000,
    totalOvertimePay: 250,
    totalGrossPay: 5250,
    totalAdditions: 200,
    totalDeductions: 100,
    totalNetPayable: 5350,
  },
}

function renderStep() {
  render(
    <PayrollSummaryStep weekLabel="5 – 11 Nov 2026" summary={SUMMARY} onBack={vi.fn()} onApprove={vi.fn()} />,
  )
  return screen.getByRole('table')
}

describe('PayrollSummaryStep', () => {
  it('shows the 15 payment columns in order and no Bank Acct.', () => {
    const table = renderStep()
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toEqual([
      'Sl No.',
      'Emp ID',
      'Emp Name',
      'GPay No.',
      'WhatsApp No.',
      'Paid Name (if diff.)',
      'Salary from',
      'Salary to',
      'Reg. Hrs Pay',
      'Overtime Hrs Pay',
      'Additions',
      'Deductions',
      'Net Pay',
      'Payment Date',
      'Payment Reference',
    ])
    expect(table.parentElement?.className).toContain('overflow-x-auto')
  })

  it('fills each row with Sl No., phone, UTC salary dates and the payment reference', () => {
    const table = renderStep()
    const [, first, second] = within(table).getAllByRole('row')
    const cells = within(first).getAllByRole('cell').map((td) => td.textContent)
    expect(cells).toEqual([
      '1',
      'TPLGOASHT231',
      'Name TPLGOASHT231',
      '—',
      '9123456780',
      '',
      '05 Nov 2026',
      '11 Nov 2026',
      '₹2,500.00',
      '₹125.00',
      '₹100.00',
      '₹50.00',
      '₹2,675.00',
      '',
      '2026-45-TPLGOASHT231',
    ])
    const secondCells = within(second).getAllByRole('cell').map((td) => td.textContent)
    expect(secondCells[0]).toBe('2')
    expect(secondCells[4]).toBe('—')
  })

  it('totals the pay columns under their headers', () => {
    const table = renderStep()
    const totalsRow = within(table).getAllByRole('row').at(-1)!
    const cells = within(totalsRow).getAllByRole('cell')
    expect(cells.map((td) => td.textContent)).toEqual([
      'Total',
      '₹5,000.00',
      '₹250.00',
      '₹200.00',
      '₹100.00',
      '₹5,350.00',
      '',
    ])
    expect(cells[0].getAttribute('colspan')).toBe('8')
  })
})
