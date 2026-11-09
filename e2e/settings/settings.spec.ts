import { test, expect } from '@playwright/test'
import prisma from '../utils/db'

// ─── About Settings E2E (F12: the payroll week start is locked to Thursday) ──────
// The Settings table uses a singleton row (id = "singleton") that is auto-created on first
// access via upsert. cleanupDatabase() intentionally does NOT truncate it. The page is read-only
// now: the week start shows Thursday with a lock, and there is nothing to save.

async function setStoredDay(day: string) {
  await prisma.settings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', payrollWeekStartDay: day as never },
    update: { payrollWeekStartDay: day as never },
  })
}

async function storedDay() {
  return (await prisma.settings.findUnique({ where: { id: 'singleton' } }))?.payrollWeekStartDay
}

test.beforeEach(async () => {
  await setStoredDay('THURSDAY')
})

test.afterAll(async () => {
  await setStoredDay('THURSDAY')
})

// ─── E2E-29: Payroll week start is locked to Thursday ────────────────────────

test.describe('E2E-29: Payroll week start is locked to Thursday', () => {
  test('shows Thursday as a locked, read-only value with no control to change it', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })

    const day = page.getByTestId('payroll-week-start-day')
    await expect(day).toBeVisible()
    await expect(day).toContainText('Thursday')
    await expect(day).toContainText('Locked')

    // Nothing on the page can change it
    await expect(page.locator('select')).toHaveCount(0)
    await expect(page.locator('select#payrollWeekStartDay')).toHaveCount(0)
    await expect(page.locator('main input, main textarea')).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Save Settings/ })).toHaveCount(0)
    await expect(page.getByText('The payroll week runs Thursday to Wednesday')).toBeVisible()
  })

  test('keeps the other read-only settings: currency and expiry threshold', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=₹ INR')).toBeVisible()
    await expect(page.locator('text=7 days')).toBeVisible()
    await expect(page.locator('text=Phase 2')).toBeVisible()
  })

  test('a stored value that is not Thursday is changed to Thursday when the page loads', async ({ page }) => {
    await setStoredDay('MONDAY')
    expect(await storedDay()).toBe('MONDAY')

    await page.goto('/settings')
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('payroll-week-start-day')).toContainText('Thursday')
    expect(await storedDay()).toBe('THURSDAY')
  })

  test('no keyboard or form route changes it: pressing Enter on the page submits nothing', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('form')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('payroll-week-start-day')).toContainText('Thursday')
    expect(await storedDay()).toBe('THURSDAY')
  })

  test('the week list follows the locked Thursday: week rows start on a Thursday', async ({ page }) => {
    await page.goto('/attendance')
    await expect(page.getByTestId('attendance-week-list')).toBeVisible({ timeout: 15000 })
    const ids = await page.locator('[data-testid^="week-row-"]').evaluateAll((rows) =>
      rows.map((r) => (r.getAttribute('data-testid') ?? '').replace('week-row-', '')),
    )
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(new Date(`${id}T00:00:00Z`).getUTCDay(), id).toBe(4)
    }
  })
})
