import { test, expect } from '@playwright/test'
import prisma, { addDaysISO, cleanupTestData, createEmployee, seedApiWeek, utcDate } from '../utils/db'
import { settled } from '../utils/attendance-ui'

// Issue #38: an adjustment can be cancelled from the weekly adjustment review. Once cancelled it is not offered
// in the next week's review, and its detail page shows it as Cancelled.

const W1 = '2025-10-09' // ended weeks before the real data starts
const W2 = addDaysISO(W1, 7)
const WORKER = 'E2E-ADJ-9101'
const REASON = 'Uniform recovery to cancel'

test.describe.configure({ mode: 'serial' })

let adjustmentId: string

test.beforeAll(async () => {
  await cleanupTestData()
  const worker = await createEmployee({ employeeId: WORKER, employeeName: 'Cancel Review Worker' })
  const day = { reg: 8, ot: 0 }
  for (const week of [W1, W2]) {
    await seedApiWeek({ weekStartISO: week, employees: [worker], days: [Array(7).fill(day)] })
  }

  const adjustment = await prisma.payrollAdjustment.create({
    data: {
      employeeId: worker.id,
      adjustmentType: 'DEDUCTION',
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'FIXED_WEEKS',
      totalRecurrenceWeeks: 2,
      amount: 300,
      reason: REASON,
      startPayrollWeekStartDate: utcDate(W1),
      startPayrollWeekEndDate: utcDate(addDaysISO(W1, 6)),
      status: 'ACTIVE',
      skippedCarryForwardCount: 0,
    },
  })
  adjustmentId = adjustment.id
  for (const week of [W1, W2]) {
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adjustment.id,
        employeeId: worker.id,
        payrollWeekStartDate: utcDate(week),
        payrollWeekEndDate: utcDate(addDaysISO(week, 6)),
        appliedAmount: 300,
        approvalStatus: 'PENDING',
      },
    })
  }
})

test.afterAll(async () => {
  await cleanupTestData()
})

async function openAdjustmentReview(page: import('@playwright/test').Page, weekStart: string) {
  await settled(page)
  await page.goto(`/payroll/generate/${weekStart}`)
  await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible({ timeout: 10000 })
}

test('cancelling in the weekly review stops the adjustment for later weeks', async ({ page }) => {
  await openAdjustmentReview(page, W1)
  const row = page.locator('tbody tr', { hasText: REASON })
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Cancel adjustment' }).click()
  await expect(page.getByText('Cancel this adjustment for good?')).toBeVisible()
  await page.getByRole('button', { name: 'Yes, cancel it' }).click()
  await expect(row.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: /Continue to Payroll Summary/ })).toBeEnabled()

  const stored = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } })
  expect(stored.status).toBe('CANCELLED')
  expect(
    await prisma.payrollAdjustmentApplication.count({
      where: { payrollAdjustmentId: adjustmentId, approvalStatus: 'PENDING' },
    }),
  ).toBe(0)

  await openAdjustmentReview(page, W2)
  await expect(page.locator('tbody tr', { hasText: REASON })).toHaveCount(0)

  await page.goto(`/adjustments/${adjustmentId}`)
  await expect(page.locator('h1:has-text("Adjustment Detail")')).toBeVisible()
  await expect(page.getByTestId('history-cancelled-entry')).toContainText('Cancelled')
  await expect(page.getByText('Pending', { exact: true })).toHaveCount(0)
})
