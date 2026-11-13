import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AdjustmentReviewTable } from '@/features/payroll-adjustments/components/AdjustmentReviewTable'
import {
  approveAdjustmentApplicationAction,
  cancelAdjustmentAction,
  skipAdjustmentApplicationAction,
} from '@/features/payroll-adjustments/actions/adjustment.actions'
import type { WeeklyReviewItem } from '@/features/payroll-adjustments/types/adjustment.types'

vi.mock('@/features/payroll-adjustments/actions/adjustment.actions', () => ({
  approveAdjustmentApplicationAction: vi.fn(),
  skipAdjustmentApplicationAction: vi.fn(),
  cancelAdjustmentAction: vi.fn(),
}))

const approve = vi.mocked(approveAdjustmentApplicationAction)
const skip = vi.mocked(skipAdjustmentApplicationAction)
const cancel = vi.mocked(cancelAdjustmentAction)

function item(n: number): WeeklyReviewItem {
  return {
    applicationId: `app-${n}`,
    adjustmentId: `adj-${n}`,
    employeeId: `emp-${n}`,
    employeeName: `Worker ${n}`,
    employeeCode: `E${n}`,
    adjustmentType: 'DEDUCTION',
    amount: 100,
    appliedAmount: 100,
    reason: `Reason ${n}`,
    recurrenceType: 'RECURRING',
    approvalStatus: 'PENDING',
    payrollWeekStartDate: new Date('2025-10-09'),
    payrollWeekEndDate: new Date('2025-10-15'),
  }
}

function rowOf(name: string) {
  return screen.getByText(name).closest('tr') as HTMLElement
}

function renderTable(items = [item(1), item(2)]) {
  const onComplete = vi.fn()
  render(
    <AdjustmentReviewTable
      items={items}
      weekStartDate={new Date('2025-10-09')}
      weekEndDate={new Date('2025-10-15')}
      onComplete={onComplete}
    />,
  )
  return onComplete
}

async function cancelRow(name: string) {
  fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'Cancel adjustment' }))
  fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
  await waitFor(() => expect(within(rowOf(name)).getByText('Cancelled')).toBeTruthy())
}

beforeEach(() => {
  vi.clearAllMocks()
  approve.mockResolvedValue({ ok: true, data: undefined } as never)
  skip.mockResolvedValue({ ok: true, data: undefined } as never)
  cancel.mockResolvedValue({ ok: true, data: undefined } as never)
})

describe('AdjustmentReviewTable: cancel adjustment', () => {
  it('opens a confirmation that Keep adjustment dismisses without changes', () => {
    renderTable()
    fireEvent.click(within(rowOf('Worker 1')).getByRole('button', { name: 'Cancel adjustment' }))
    expect(screen.getByText('Cancel this adjustment for good?')).toBeTruthy()
    expect(screen.getByText(/remove any pending applications/)).toBeTruthy()
    expect(screen.getByText(/already-approved applications will remain/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep adjustment' }))
    expect(screen.queryByText('Cancel this adjustment for good?')).toBeNull()
    expect(cancel).not.toHaveBeenCalled()
    expect(within(rowOf('Worker 1')).getByRole('button', { name: 'Cancel adjustment' })).toBeTruthy()
  })

  it('cancels the adjustment by its id and shows the row as Cancelled with no actions', async () => {
    renderTable()
    await cancelRow('Worker 1')
    expect(cancel).toHaveBeenCalledWith('adj-1')
    expect(within(rowOf('Worker 1')).queryAllByRole('button')).toHaveLength(0)
  })

  it('shows a refused cancel and leaves the row actionable', async () => {
    cancel.mockResolvedValue({ ok: false, error: 'A correction is open for one of its weeks.' } as never)
    renderTable()
    fireEvent.click(within(rowOf('Worker 1')).getByRole('button', { name: 'Cancel adjustment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A correction is open'))
    expect(within(rowOf('Worker 1')).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(rowOf('Worker 1')).queryByText('Cancelled')).toBeNull()
  })

  it('leaves cancelled rows out of Approve All and Skip All', async () => {
    renderTable([item(1), item(2), item(3)])
    await cancelRow('Worker 1')
    fireEvent.click(within(rowOf('Worker 2')).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(within(rowOf('Worker 2')).getByText('Skipped')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Approve All/ }))
    await waitFor(() => expect(within(rowOf('Worker 3')).getByText('Approved')).toBeTruthy())
    expect(approve).toHaveBeenCalledTimes(1)
    expect(approve).toHaveBeenCalledWith('app-3')

    fireEvent.click(screen.getByRole('button', { name: /Skip All/ }))
    expect(skip).toHaveBeenCalledTimes(1)
    expect(within(rowOf('Worker 1')).getByText('Cancelled')).toBeTruthy()
  })

  it('unlocks Continue once every row is approved, skipped or cancelled', async () => {
    const onComplete = renderTable()
    const next = screen.getByRole('button', { name: 'Continue to Payroll Summary' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)

    await cancelRow('Worker 1')
    expect(next.disabled).toBe(true)
    fireEvent.click(within(rowOf('Worker 2')).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(next.disabled).toBe(false))
    fireEvent.click(next)
    expect(onComplete).toHaveBeenCalledWith({ 'app-1': 'CANCELLED', 'app-2': 'APPROVED' })
  })

  it('explains both skip and cancel in the note', () => {
    renderTable()
    expect(screen.getByText(/Skipped adjustments will carry forward to the next week/)).toBeTruthy()
    expect(screen.getByText(/Cancelled adjustments stop and won.t be offered again/)).toBeTruthy()
  })
})

describe('AdjustmentReviewTable: cancel confirmation focus', () => {
  it('focuses Keep adjustment on open and returns focus to the row button on Keep and Escape', () => {
    renderTable()
    const trigger = within(rowOf('Worker 1')).getByRole('button', { name: 'Cancel adjustment' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this adjustment for good?' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep adjustment' }))

    fireEvent.click(screen.getByRole('button', { name: 'Keep adjustment' }))
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(dialog).toBeTruthy()
  })

  it('returns focus to the row button after a refused cancel and clears the error when reopened', async () => {
    cancel.mockResolvedValue({ ok: false, error: 'A correction is open.' } as never)
    renderTable()
    const trigger = within(rowOf('Worker 1')).getByRole('button', { name: 'Cancel adjustment' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
