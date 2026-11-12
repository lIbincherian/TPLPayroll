import { test, expect, type Page } from '@playwright/test'
import { cleanupTestData, seedAdjustmentTestData, seedApprovedPayrollData, seedReviewWeek, seedSyncFailedWeek } from '../utils/db'
import { settled } from '../utils/attendance-ui'
import { addDays, expectedCompletedWeek, expectedCurrentWeek } from '../utils/etimeoffice-mock'

// The dashboard's four cards count rows across the whole database. With the real-data base underneath, an
// absolute number would be the base's, so this spec reads each card before it seeds anything and asserts the
// CHANGE its own rows cause: the base's share cancels out, and the spec does not know or print it.

const completed = expectedCompletedWeek()
const current = expectedCurrentWeek()
const FAR_FUTURE_FAILED = '2040-01-05'

test.describe.configure({ mode: 'serial' })

const card = (page: Page, label: string) => page.locator('a', { hasText: label }).locator('span.font-mono')

async function readCards(page: Page) {
  await page.goto('/')
  await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible()
  await expect(card(page, 'Active Team Members')).toBeVisible({ timeout: 15000 })
  const count = async (label: string) => Number((await card(page, label).innerText()).trim())
  // The cards prefetch the pages they link to; read or write the database only once those requests are done
  await settled(page)
  return {
    active: await count('Active Team Members'),
    awaitingReview: await count('Attendance Awaiting Review'),
    adjustments: await count('Awaiting Adjustments'),
    latestTotal: (await card(page, 'Latest Payroll Total').innerText()).trim(),
  }
}

test('the cards move by exactly what this spec adds, whatever the base holds', async ({ page }) => {
  await cleanupTestData()
  const before = await readCards(page)

  // Two active employees and an approved payroll run in the last completed week (the newest run, so it is
  // the "latest payroll total": 6,950.00), one active employee with one pending adjustment, one week in
  // review and one whose sync failed.
  // approved "now": newer than any approval the base holds, so this run is the latest payroll total
  await seedApprovedPayrollData({ weekStartISO: completed.start, approvedAt: new Date() })
  await seedAdjustmentTestData()
  await seedReviewWeek({ weekStartISO: current.start, rows: [] })
  await seedSyncFailedWeek(FAR_FUTURE_FAILED)

  const after = await readCards(page)
  expect(after.active).toBe(before.active + 3)
  expect(after.awaitingReview).toBe(before.awaitingReview + 2)
  expect(after.adjustments).toBe(before.adjustments + 1)
  expect(after.latestTotal).toBe('₹6,950.00')

  // Cleanup removes exactly what was added: the cards are back to what the base alone gave
  await cleanupTestData()
  const restored = await readCards(page)
  expect(restored).toEqual(before)
  expect(addDays(completed.start, 7)).toBe(current.start)
})
