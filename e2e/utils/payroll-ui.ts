import { expect, type Page } from '@playwright/test'
import { settled } from './attendance-ui'

// Steps of the payroll generation flow (/payroll/generate/[weekId]).

/** Open the flow for a week and step through attendance and adjustments to the payroll summary. */
export async function openPayrollSummary(page: Page, weekStart: string, opts: { approveAdjustments?: boolean } = {}) {
  await settled(page)
  await page.goto(`/payroll/generate/${weekStart}`)
  await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible({ timeout: 10000 })

  if (opts.approveAdjustments) {
    const approve = page.locator('button[aria-label="Approve"]')
    for (let i = 0; i < 10 && (await approve.count()) > 0; i++) {
      const before = await approve.count()
      await approve.first().click()
      await expect.poll(async () => approve.count(), { timeout: 8000 }).toBeLessThan(before)
    }
  }
  await page.getByRole('button', { name: /Continue to (Payroll )?Summary/ }).click()
  await expect(page.locator('h2:has-text("Payroll Summary")')).toBeVisible({ timeout: 15000 })
}

/** Approve the payroll run from the summary step. */
export async function approvePayrollInUi(page: Page) {
  await page.getByRole('button', { name: 'Approve Payroll' }).click()
  await expect(page.locator('text=Approve this payroll run?')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: 'Confirm Approval' }).click()
  await expect(page.locator('h2:has-text("Payroll Approved")')).toBeVisible({ timeout: 20000 })
}

export async function generateAndApprovePayroll(page: Page, weekStart: string, opts: { approveAdjustments?: boolean } = {}) {
  await openPayrollSummary(page, weekStart, opts)
  await approvePayrollInUi(page)
}
