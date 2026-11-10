import { test, expect } from '@playwright/test'
import { addDays, expectedCompletedWeek, expectedCurrentWeek, payrollWeekLabel } from '../utils/etimeoffice-mock'
import { activeWeeks, approvedRuns, realDataLoaded } from './snapshot'

// The attendance and payroll week lists on the real data. Every week of the snapshot is an Excel-era week with
// an approved payroll run, so the lists must show them as read-only approved weeks and must not offer Pull now,
// Review or Generate for them. The lists show only the newest weeks (26), plus the two weeks that always have a
// row (the last completed and the current one); the snapshot decides which weeks those are.

test.skip(() => !realDataLoaded(), 'needs the real-data base (e2e/prod-snapshot/ loaded by global setup)')

const LIST_LIMIT = 26

function shownWeeks() {
  const completed = expectedCompletedWeek()
  const current = expectedCurrentWeek()
  const real = activeWeeks().slice(0, LIST_LIMIT)
  const alwaysThere = [current, completed].filter((w) => !real.some((r) => r.weekStart === w.start))
  return { real, alwaysThere }
}

test('the attendance list shows the newest snapshot weeks as read-only Excel weeks', async ({ page }) => {
  const { real, alwaysThere } = shownWeeks()
  expect(real.length).toBeGreaterThan(0)

  await page.goto('/attendance')
  await expect(page.getByTestId('attendance-week-list')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid^="week-row-"]')).toHaveCount(real.length + alwaysThere.length)

  for (const week of real) {
    const row = page.getByTestId(`week-row-${week.weekStart}`)
    await expect(row, `week ${week.weekStart}`).toHaveAttribute('data-source', 'EXCEL')
    await expect(row, `week ${week.weekStart}`).toHaveAttribute('data-status', 'APPROVED')
    await expect(page.getByTestId(`pull-now-${week.weekStart}`)).toHaveCount(0)
    await expect(page.getByTestId(`review-link-${week.weekStart}`)).toHaveCount(0)
    await expect(page.getByTestId(`view-link-${week.weekStart}`)).toBeVisible()
  }
  // The two always-present weeks have no data in the base (global setup reserved them): not loaded yet
  for (const week of alwaysThere) {
    await expect(page.getByTestId(`week-row-${week.start}`)).toHaveAttribute('data-status', 'NO_DATA')
  }
})

test('the payroll week list shows every snapshot week as approved and offers no Generate', async ({ page }) => {
  const { real, alwaysThere } = shownWeeks()
  const runByWeek = new Map(approvedRuns().map((r) => [r.weekStart, r]))

  await page.goto('/payroll')
  await expect(page.locator('h1:has-text("Payroll Generation")')).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(real.length + alwaysThere.length)

  for (const week of real) {
    const row = page.locator('tr', { hasText: payrollWeekLabel({ start: week.weekStart, end: addDays(week.weekStart, 6) }) })
    await expect(row, `week ${week.weekStart}`).toBeVisible()
    await expect(row.getByRole('link', { name: 'Approved' })).toBeVisible()
    await expect(row.locator('a:has-text("Generate")')).toHaveCount(0)
    // A week with an approved run links to it
    if (runByWeek.has(week.weekStart)) await expect(row.locator('a:has-text("View")')).toBeVisible()
  }
  // And nowhere on the page is there a way to start a payroll
  await expect(page.locator('a:has-text("Generate")')).toHaveCount(0)
})
