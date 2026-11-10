import { test, expect, type Page } from '@playwright/test'
import { restoreRowsFromBase } from './base-restore'
import { auditCounts, employeeTotals, latestPayrollTotal, pendingAdjustmentApplications, realDataLoaded } from './snapshot'

// The employee directory, dashboard, settings and audit log viewer on the real data. Counts, totals and
// pagination come from the snapshot files; no name is read out or printed.

test.skip(() => !realDataLoaded(), 'needs the real-data base (e2e/prod-snapshot/ loaded by global setup)')

const PAGE_SIZE = 10

/** Collect server errors (HTTP 5xx) and uncaught page errors while a page loads. */
function watchServerErrors(page: Page) {
  const errors: string[] = []
  page.on('response', (response) => {
    if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
  })
  page.on('pageerror', () => errors.push('uncaught page error'))
  return errors
}

// ─── Employee directory ───────────────────────────────────────────────────────

test.describe('Employee directory', () => {
  test('paginates through every employee in the snapshot', async ({ page }) => {
    const { total } = employeeTotals()
    const pages = Math.ceil(total / PAGE_SIZE)
    await page.goto('/employees')
    await expect(page.locator('h1:has-text("Team Directory")')).toBeVisible()
    await expect(page.locator(`text=Showing 1–${Math.min(PAGE_SIZE, total)} of ${total}`)).toBeVisible({ timeout: 15000 })
    await expect(page.locator('tbody tr')).toHaveCount(Math.min(PAGE_SIZE, total))

    // Page 2, then the last page by its number, then back with Previous
    await page.getByRole('button', { name: '2', exact: true }).click()
    await expect(page.locator(`text=Showing ${PAGE_SIZE + 1}–${Math.min(2 * PAGE_SIZE, total)} of ${total}`)).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: String(pages), exact: true }).click()
    const lastRows = total - (pages - 1) * PAGE_SIZE
    await expect(page.locator(`text=Showing ${(pages - 1) * PAGE_SIZE + 1}–${total} of ${total}`)).toBeVisible({ timeout: 10000 })
    await expect(page.locator('tbody tr')).toHaveCount(lastRows)
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await page.getByRole('button', { name: 'Previous page' }).click()
    await expect(page.locator(`text=Showing ${(pages - 2) * PAGE_SIZE + 1}–${(pages - 1) * PAGE_SIZE} of ${total}`)).toBeVisible({ timeout: 10000 })
  })

  test('the status filter splits the directory into the snapshot\'s active, inactive and resigned employees', async ({ page }) => {
    const totals = employeeTotals()
    expect(totals.active + totals.inactive + totals.resigned).toBe(totals.total)
    await page.goto('/employees')
    await expect(page.locator('h1:has-text("Team Directory")')).toBeVisible()

    for (const [value, count] of [['ACTIVE', totals.active], ['INACTIVE', totals.inactive], ['RESIGNED', totals.resigned]] as const) {
      await page.locator('select#employee-status-filter').selectOption(value)
      if (count === 0) {
        await expect(page.locator('tbody tr')).toHaveCount(1) // the empty state
      } else {
        await expect(page.locator(`text=Showing 1–${Math.min(PAGE_SIZE, count)} of ${count}`)).toBeVisible({ timeout: 10000 })
      }
    }
  })
})

// ─── Dashboard and settings ───────────────────────────────────────────────────

test.describe('Dashboard and settings', () => {
  const card = (page: Page, label: string) => page.locator('a', { hasText: label }).locator('span.font-mono')

  test('the dashboard loads with no server error and its four cards match the snapshot', async ({ page }) => {
    const errors = watchServerErrors(page)
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible()
    await expect(page.getByText('Something went wrong')).toHaveCount(0)

    await expect(card(page, 'Active Team Members')).toHaveText(String(employeeTotals().activeFlag), { timeout: 15000 })
    const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 })
    await expect(card(page, 'Latest Payroll Total')).toHaveText(money.format(latestPayrollTotal()))
    // Excel-era weeks are never counted; the base has no eTimeOffice week waiting for review
    await expect(card(page, 'Attendance Awaiting Review')).toHaveText('0')
    await expect(card(page, 'Awaiting Adjustments')).toHaveText(String(pendingAdjustmentApplications()))
    expect(errors).toEqual([])
  })

  test('every main page loads without a server error', async ({ page }) => {
    const errors = watchServerErrors(page)
    for (const [path, heading] of [
      ['/employees', 'Team Directory'],
      ['/attendance', 'Attendance'],
      ['/payroll', 'Payroll Generation'],
      ['/history', 'Payroll History'],
      ['/adjustments', 'Payroll Adjustments'],
      ['/audit-log', 'Audit Log'],
    ] as const) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBeLessThan(500)
      await expect(page.locator(`h1:has-text("${heading}")`).first(), path).toBeVisible({ timeout: 15000 })
    }
    expect(errors).toEqual([])
  })

  test.describe('settings', () => {
    // The settings page upserts its row (updatedAt moves even when the day is already Thursday); put the base row back.
    test.afterAll(async () => {
      if (realDataLoaded()) await restoreRowsFromBase('Settings', `id = $1`, ['singleton'])
    })

    test('the settings page loads with no server error and shows the locked Thursday', async ({ page }) => {
      const errors = watchServerErrors(page)
      const response = await page.goto('/settings')
      expect(response?.status()).toBe(200)
      await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('payroll-week-start-day')).toContainText('Thursday')
      expect(errors).toEqual([])
    })
  })
})

// ─── Audit log ────────────────────────────────────────────────────────────────

test.describe('Audit log viewer', () => {
  // A log row has five cells; the expanded-detail row has one, and a loading skeleton row has pulse blocks
  const rowsOnPage = (page: Page) => page.locator('tbody tr:has(td:nth-child(5)):not(:has(.animate-pulse))')

  test('the filters narrow the real rows to the snapshot\'s counts, and the pages add up', async ({ page }) => {
    const { total, byPair } = auditCounts()
    expect(total).toBeGreaterThan(0)
    await page.goto('/audit-log')
    await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 10000 })
    await expect(rowsOnPage(page).first()).toBeVisible({ timeout: 10000 })
    await expect(rowsOnPage(page)).toHaveCount(Math.min(20, total))

    const selects = page.locator('select')
    for (const [pair, count] of byPair) {
      const [entity, action] = pair.split('/')
      await selects.nth(0).selectOption(entity)
      await selects.nth(1).selectOption(action)
      if (count === 0) continue
      await expect(rowsOnPage(page).first()).toBeVisible({ timeout: 10000 })
      await expect(rowsOnPage(page), pair).toHaveCount(Math.min(20, count))
      // Every row on the page carries the chosen action
      await expect(rowsOnPage(page).locator('td:nth-child(2) span', { hasText: new RegExp('^' + action + '$') })).toHaveCount(
        Math.min(20, count),
      )
      const lastPage = Math.ceil(count / 20)
      if (lastPage > 1) {
        await page.getByRole('button', { name: String(lastPage), exact: true }).click()
        await expect(rowsOnPage(page), `${pair} last page`).toHaveCount(count - (lastPage - 1) * 20, { timeout: 10000 })
      }
    }
  })
})
