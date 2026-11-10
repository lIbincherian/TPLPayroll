import { test, expect, type Page } from '@playwright/test'
import prisma, { cleanupTestData, createEmployee, getAuditRows } from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  FULL_DAY,
  mockDay,
  setMockPunches,
  weekDates,
} from '../utils/etimeoffice-mock'
import { approveWeekInUi, closeEditor, openDay, openReview, runCron, setPairField, settled } from '../utils/attendance-ui'

// US-12.21: every attendance change is in the audit log, and the viewer can filter to it.

const week = expectedCompletedWeek()
const dates = weekDates(week.start)
const ANITA = 'E2E-HLP-9001'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request, browser }, testInfo) => {
  clearMockScenario()
  await cleanupTestData()
  await createEmployee({ employeeId: ANITA, employeeName: 'Anita Rao' })
  setMockPunches(mockDay('9001', dates[0], FULL_DAY))
  const loaded = await runCron(request)
  expect(loaded.body).toMatchObject({ outcome: 'LOADED' })

  // One edit and the approval, through the UI
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL })
  await openReview(page, week.start)
  await openDay(page, ANITA, dates[0])
  await setPairField(page, 2, 'out', '18:00')
  await closeEditor(page)
  await approveWeekInUi(page)
  await settled(page)
  await page.close()
})

test.afterAll(() => {
  clearMockScenario()
})

async function filterAudit(page: Page, entity: string, action = '') {
  await page.goto('/audit-log')
  await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 15000 })
  const selects = page.locator('select')
  await selects.nth(0).selectOption(entity)
  if (action) await selects.nth(1).selectOption(action)
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })
}

test.describe('Audit log viewer: attendance entries', () => {
  test('the entity filter offers the four attendance entities and the action filter the new actions', async ({ page }) => {
    await page.goto('/audit-log')
    await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 15000 })
    const entities = await page.locator('select').nth(0).locator('option').allTextContents()
    expect(entities).toEqual(
      expect.arrayContaining(['Attendance week', 'Attendance punch', 'Attendance decision', 'Attendance code']),
    )
    const actions = await page.locator('select').nth(1).locator('option').allTextContents()
    expect(actions).toEqual(expect.arrayContaining(['Sync', 'Pull', 'Approve', 'Reopen', 'Discard']))
  })

  test('the punch edit shows with its summary, and the original and new times in the details', async ({ page }) => {
    await settled(page)
    await filterAudit(page, 'ATTENDANCE_PUNCH')
    const rows = page.locator('tbody tr').filter({ hasText: 'Attendance punch' })
    await expect(rows.first()).toBeVisible()
    await expect(rows.first()).toContainText('UPDATE')
    // The summary names the change instead of "Unknown"
    await expect(rows.first()).toContainText(/17:47/)
    await expect(rows.first()).toContainText(/18:00/)
    await rows.first().click()
    await expect(page.locator('pre').first()).toContainText('17:47')
    await expect(page.locator('pre').first()).toContainText('18:00')
  })

  test('the week entries show the pull and the approval with their action badges', async ({ page }) => {
    await settled(page)
    await filterAudit(page, 'ATTENDANCE_WEEK')
    const body = page.locator('tbody')
    await expect(body).toContainText('Attendance week')
    await expect(body.locator('span', { hasText: /^APPROVE$/ })).toBeVisible()
    await expect(body.locator('span', { hasText: /^(SYNC|PULL)$/ }).first()).toBeVisible()

    // Filtering by action narrows it. The viewer shows one page (20 rows) of every Attendance week approval in
    // the database, newest first, so the expected count comes from the database: this spec's approval, and any
    // an updated snapshot of production holds, up to a page.
    await filterAudit(page, 'ATTENDANCE_WEEK', 'APPROVE')
    const approvals = await prisma.auditLog.count({ where: { entityType: 'ATTENDANCE_WEEK', actionType: 'APPROVE' } })
    expect(approvals).toBeGreaterThanOrEqual(1)
    await expect(page.locator('tbody tr').filter({ hasText: 'Attendance week' })).toHaveCount(Math.min(approvals, 20))
    await expect(page.locator('tbody')).not.toContainText('PULL')
  })

  test('the Employee filter shows none of the attendance entries', async ({ page }) => {
    await settled(page)
    await filterAudit(page, 'EMPLOYEE')
    await expect(page.locator('tbody')).not.toContainText('Attendance')
  })

  test('the log does not record who made the change', async () => {
    const rows = await getAuditRows('ATTENDANCE_PUNCH')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const keys = Object.keys(row.detailsJson as Record<string, unknown>)
      expect(keys.filter((k) => /user|actor|author|by/i.test(k))).toEqual([])
    }
  })
})
