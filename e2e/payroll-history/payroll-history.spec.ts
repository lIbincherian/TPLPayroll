import { test, expect } from '@playwright/test'
import { cleanupTestData, seedApprovedPayrollData } from '../utils/db'
import { expectedCompletedWeek } from '../utils/etimeoffice-mock'

// The history page opens on the most recent approved week. The real-data base ends before the reserved weeks, so
// a run in the last completed week is that most recent week: the default view shows exactly this spec's rows.
const WEEK = expectedCompletedWeek().start

let payrollRunId: string

test.beforeAll(async () => {
  try {
    await cleanupTestData()
    const seed = await seedApprovedPayrollData({ weekStartISO: WEEK })
    payrollRunId = seed.payrollRunId
  } catch (err: any) {
    throw err
  }
})

test.describe('F09: Payroll History E2E', () => {
  test('navigates to history page and shows seeded data', async ({ page }) => {
    await page.goto('/history')
    
    await expect(page.locator('h1:has-text("Payroll History")')).toBeVisible()
    
    // Seeded employees from seedApprovedPayrollData
    await expect(page.locator('text=Meera Krishnan')).toBeVisible()
    await expect(page.locator('text=Vijay Kumar')).toBeVisible()
  })

  test('searches by employee name', async ({ page }) => {
    await page.goto('/history')
    
    // Enter search query
    const searchInput = page.getByPlaceholder('Search by employee name or ID...')
    await searchInput.fill('Meera Krishnan')
    
    // Wait for debounce and reload
    await page.waitForTimeout(500)
    
    // Meera should be visible, Vijay should not
    await expect(page.locator('text=Meera Krishnan')).toBeVisible()
    await expect(page.locator('text=Vijay Kumar')).not.toBeVisible()
  })

  test('searches by employee ID', async ({ page }) => {
    await page.goto('/history')
    
    const searchInput = page.getByPlaceholder('Search by employee name or ID...')
    await searchInput.fill('E2E-RPT-9002')
    
    await page.waitForTimeout(500)
    
    await expect(page.locator('text=Vijay Kumar')).toBeVisible()
    await expect(page.locator('text=Meera Krishnan')).not.toBeVisible()
  })

  test('views detailed payroll record', async ({ page }) => {
    await page.goto('/history')
    
    // Click on Meera's record
    await page.locator('text=Meera Krishnan').first().click()
    
    // Should navigate to detail view
    await expect(page).toHaveURL(/\/history\/[a-zA-Z0-9-]+/)
    
    // Expect employee name as header
    await expect(page.locator('h1:has-text("Meera Krishnan")')).toBeVisible()
    
    // Expect attendance data
    await expect(page.locator('h2:has-text("Attendance")')).toBeVisible()
    
    // Seeded data check: 46 regular hours, 6 overtime hours
    await expect(page.locator('text=46.00').first()).toBeVisible()
    await expect(page.locator('text=6.00').first()).toBeVisible()
    
    // Expect Earnings block
    await expect(page.locator('h2:has-text("Earnings")')).toBeVisible()
    
    // Net Payable should be visible (seeded as 2750)
    await expect(page.locator('text=₹2,750.00').first()).toBeVisible()
  })
})
