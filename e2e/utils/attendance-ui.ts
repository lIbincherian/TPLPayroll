import 'dotenv/config'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

// Shared steps for the attendance-sync specs: the cron route, the week list, the punch grid and
// the day editor. Everything goes through test ids so styling changes don't break the specs.

export function cronHeaders(): Record<string, string> {
  return { authorization: `Bearer ${process.env.CRON_SECRET}` }
}

export interface CronResult {
  status: number
  body: Record<string, unknown>
}

/** Call the scheduled sync the way Vercel Cron does. */
export async function runCron(request: APIRequestContext): Promise<CronResult> {
  const response = await request.get('/api/cron/attendance-sync', { headers: cronHeaders() })
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> }
}

// ─── Week list ───────────────────────────────────────────────────────────────

export function weekRow(page: Page, weekStart: string): Locator {
  return page.getByTestId(`week-row-${weekStart}`)
}

export async function openAttendance(page: Page): Promise<void> {
  await page.goto('/attendance')
  await expect(page.getByTestId('attendance-week-list')).toBeVisible({ timeout: 15000 })
}

/** Click Pull now on a week row; confirm the discard warning when one appears. */
export async function pullWeekFromList(page: Page, weekStart: string, opts: { confirmDiscard?: boolean } = {}) {
  await page.getByTestId(`pull-now-${weekStart}`).click()
  if (opts.confirmDiscard) {
    await expect(page.getByTestId('pull-warning-dialog')).toBeVisible()
    await page.getByTestId('pull-warning-confirm').click()
  }
}

// ─── Review grid ─────────────────────────────────────────────────────────────

export async function openReview(page: Page, weekStart: string): Promise<void> {
  await page.goto(`/attendance/${weekStart}/review`)
  await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 15000 })
}

export function dayCell(page: Page, employeeCode: string, date: string): Locator {
  return page.getByTestId(`day-cell-${employeeCode}-${date}`)
}

export async function openDay(page: Page, employeeCode: string, date: string): Promise<void> {
  await dayCell(page, employeeCode, date).click()
  await expect(page.getByTestId('day-editor')).toBeVisible()
  await expect(page.getByTestId('editor-day-label')).toContainText(employeeCode)
}

/** Type a time into a pair field and commit it (Enter), then wait for the save to land. */
export async function setPairField(
  page: Page,
  pair: number,
  field: 'in' | 'out',
  value: string,
  opts: { expectSaved?: boolean } = {},
): Promise<void> {
  const input = page.getByTestId(`editor-pair-${pair}-${field}`)
  await input.fill(value)
  await input.press('Enter')
  if (opts.expectSaved !== false) {
    await expect(page.getByTestId('editor-save-status')).toContainText('Saved', { timeout: 10000 })
  }
}

export async function closeEditor(page: Page): Promise<void> {
  await page.getByTestId('editor-close').click()
  await expect(page.getByTestId('day-editor')).toBeHidden()
}

export function approveButton(page: Page): Locator {
  return page.getByTestId('approve-week-button')
}

/** Approve a week from the review grid: open the dialog, wait for the summary, confirm. */
export async function approveWeekInUi(page: Page): Promise<void> {
  await expect(approveButton(page)).toBeEnabled()
  await approveButton(page).click()
  const dialog = page.getByTestId('approve-week-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('approval-employees')).not.toHaveText('', { timeout: 10000 })
  await page.getByTestId('approve-confirm').click()
  await expect(dialog).toBeHidden({ timeout: 15000 })
}

/** The seven hours texts of a day cell: "08:00–16:00" lines and the "8.00" totals line. */
export async function cellText(page: Page, employeeCode: string, date: string): Promise<string> {
  return ((await dayCell(page, employeeCode, date).innerText()) ?? '').replace(/\s+/g, ' ').trim()
}
