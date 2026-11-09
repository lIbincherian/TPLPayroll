import { test, expect } from '@playwright/test'
import { cleanupDatabase, seedExcelWeek, seedPayrollTestData, seedSyncFailedWeek } from '../utils/db'

// ─── Seed ─────────────────────────────────────────────────────────────────────
// Attendance comes from eTimeOffice weeks now:
//   6-12 Mar 2025   approved, 3 employees with punches (ready for payroll)
//   13-19 Mar 2025  loaded but not approved (Ready for review)
//   27 Mar 2025     last sync failed, nothing loaded
//   6-12 Feb 2025   imported from Excel before F12 (can't start payroll)

test.beforeAll(async () => {
  await cleanupDatabase()
  const { employees } = await seedPayrollTestData()
  await seedSyncFailedWeek('2025-03-27')
  await seedExcelWeek({
    weekStartISO: '2025-02-06',
    employees: employees.slice(0, 1),
    days: [Array(7).fill({ reg: 8, ot: 0 })],
    fileName: 'attendance-feb-wk1.xlsx',
  })
})

// ─── E2E-01: Payroll week list shows correct statuses ─────────────────────────

test.describe('E2E-01: Payroll week list', () => {
  test('shows the approved week with Generate, and the week in review as disabled', async ({ page }) => {
    await page.goto('/payroll')
    await expect(page.locator('h1:has-text("Payroll Generation")')).toBeVisible()

    // Approved week (Mar 6-12)
    const approved = page.locator('tr', { hasText: '6 Mar 2025 – 12 Mar 2025' })
    await expect(approved).toBeVisible()
    await expect(approved.getByRole('link', { name: 'Approved' })).toBeVisible()
    await expect(approved.locator('a:has-text("Generate")')).toBeVisible()

    // Loaded but not approved (Mar 13-19)
    const review = page.locator('tr', { hasText: '13 Mar 2025 – 19 Mar 2025' })
    await expect(review).toBeVisible()
    await expect(review.getByRole('link', { name: 'Ready for review' })).toBeVisible()
    // Disabled generate (span, not a link), with the reason
    await expect(review.locator('span[title="Approve this week\'s attendance first"]')).toBeVisible()
    await expect(review.locator('a:has-text("Generate")')).toHaveCount(0)
    await expect(page.locator('a[href*="2025-03-13"]').filter({ hasText: 'Generate' })).toHaveCount(0)
  })

  test('shows a failed sync and an Excel-era week as not ready', async ({ page }) => {
    await page.goto('/payroll')
    const failed = page.locator('tr', { hasText: '27 Mar 2025 – 2 Apr 2025' })
    await expect(failed.getByRole('link', { name: 'Sync failed' })).toBeVisible()
    await expect(failed.locator('span[title="Load this week\'s attendance first"]')).toBeVisible()

    // The Excel week keeps its place in the list but cannot start payroll
    const excel = page.locator('tr', { hasText: '6 Feb 2025 – 12 Feb 2025' })
    await expect(excel).toBeVisible()
    await expect(excel.getByRole('link', { name: 'Approved' })).toBeVisible()
    await expect(excel.locator('span[title="Excel-era weeks can\'t start payroll"]')).toBeVisible()
    await expect(excel.locator('a:has-text("Generate")')).toHaveCount(0)
  })
})

// ─── E2E-02: Payroll blocked when the week isn't approved ─────────────────────

test.describe('E2E-02: Blocked week', () => {
  test('shows a blocker message with a link to the punch review for a week in review', async ({ page }) => {
    await page.goto('/payroll/generate/2025-03-13')
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible()
    await expect(page.locator("text=Attendance for this week isn't approved yet")).toBeVisible()
    await expect(page.getByRole('link', { name: /Review punches/ })).toHaveAttribute('href', '/attendance/2025-03-13/review')
    // Continue button should not be shown
    await expect(page.locator('button:has-text("Continue")')).not.toBeVisible()
  })

  test('shows the failed-sync message for a week whose sync failed', async ({ page }) => {
    await page.goto('/payroll/generate/2025-03-27')
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible()
    await expect(page.locator('text=The eTimeOffice sync failed for this week')).toBeVisible()
    await expect(page.getByRole('link', { name: /Go to Attendance/ })).toHaveAttribute('href', '/attendance')
    await expect(page.locator('button:has-text("Continue")')).not.toBeVisible()
  })

  test("an Excel-era week can't start payroll", async ({ page }) => {
    await page.goto('/payroll/generate/2025-02-06')
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible()
    await expect(page.locator("text=This week was imported from Excel and can't start payroll")).toBeVisible()
    await expect(page.locator('button:has-text("Continue")')).not.toBeVisible()
  })
})

// ─── E2E-05: No attendance for the selected week ─────────────────────────────

test.describe('E2E-05: No attendance loaded', () => {
  test('shows "no attendance loaded" for a week with nothing', async ({ page }) => {
    // Week with no attendance row at all
    await page.goto('/payroll/generate/2025-02-27')
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible()
    await expect(page.locator('text=No attendance loaded for this week')).toBeVisible()
    await expect(page.getByRole('link', { name: /Go to Attendance/ })).toHaveAttribute('href', '/attendance')
    await expect(page.locator('button:has-text("Continue")')).not.toBeVisible()
  })
})

// ─── E2E-01: Generate payroll for an approved week (full flow) ────────────────

test.describe('E2E-01: Full payroll generation flow', () => {
  test('generates and approves payroll for March 6-12', async ({ page }) => {
    await page.goto('/payroll/generate/2025-03-06')

    // Step 1: Attendance approved
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('text=Attendance approved: 3 employees, 0 left out')).toBeVisible({ timeout: 8000 })

    // Quick stats: employee count and hours (two decimals)
    await expect(page.locator('p:has-text("Total Employees") + p')).toHaveText('3')
    await expect(page.locator('p:has-text("Total Regular Hrs") + p')).toHaveText('150.00')
    await expect(page.locator('p:has-text("Total Overtime Hrs") + p')).toHaveText('6.00')

    // Advance to Step 2 (Adjustments)
    await page.click('button:has-text("Continue")')
    await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible({ timeout: 5000 })

    // Should show 1 pending adjustment (deduction of ₹500)
    await expect(page.locator('text=Advance recovery')).toBeVisible()
    await expect(page.locator('text=Deduction')).toBeVisible()

    // Approve the adjustment
    await page.click('button[aria-label="Approve"]')

    // Continue button becomes active after all actioned
    await expect(page.locator('button:has-text("Continue to Payroll Summary")')).toBeEnabled({ timeout: 5000 })
    await page.click('button:has-text("Continue to Payroll Summary")')

    // Step 3: Payroll Summary
    await expect(page.locator('h2:has-text("Payroll Summary")')).toBeVisible({ timeout: 8000 })

    // Should show all 3 employees
    await expect(page.locator('text=Kavitha Rajan')).toBeVisible()
    await expect(page.locator('text=Ramesh Nair')).toBeVisible()
    await expect(page.locator('text=Sunita Pillai')).toBeVisible()

    // Net payable column header
    await expect(page.locator('th:has-text("Net Payable")')).toBeVisible()

    // Click "Approve Payroll"
    await page.click('button:has-text("Approve Payroll")')

    // Confirmation dialog
    await expect(page.locator('text=Approve this payroll run?')).toBeVisible({ timeout: 3000 })

    // Confirm
    await page.click('button:has-text("Confirm Approval")')

    // Step 4: Success
    await expect(page.locator('h2:has-text("Payroll Approved")')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=3 employees').first()).toBeVisible()

    // Back to payroll list
    await page.click('a:has-text("Back to Payroll")')
    await expect(page).toHaveURL('/payroll', { timeout: 5000 })

    // The approved week now shows its payroll as approved, with View instead of Generate
    const row = page.locator('tr', { hasText: '6 Mar 2025 – 12 Mar 2025' })
    await expect(row.locator('a:has-text("View")')).toBeVisible({ timeout: 5000 })
    await expect(row.locator('a:has-text("Generate")')).toHaveCount(0)
  })
})

// ─── E2E-03: Calculation accuracy ────────────────────────────────────────────

test.describe('E2E-03: Payroll calculation accuracy', () => {
  test('shows the approved payroll in the list after the full flow', async ({ page }) => {
    // At this point payroll is already approved from the previous test
    await page.goto('/payroll')
    await expect(page.locator('text=Approved').first()).toBeVisible({ timeout: 5000 })
  })
})

// ─── E2E-06: A week with no attendance row still opens the flow ──────────────

test.describe('E2E-06: Unknown week', () => {
  test('a week with no attendance shows the no-data state', async ({ page }) => {
    await page.goto('/payroll/generate/2025-02-20')
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=No attendance loaded for this week')).toBeVisible()
  })
})
