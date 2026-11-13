import { test, expect, type Page } from '@playwright/test'
import prisma, { cleanupTestData, createEmployee } from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  FULL_DAY,
  mockDays,
  setMockPunches,
  weekDates,
} from '../utils/etimeoffice-mock'
import { openAttendance, openReview, pullWeekFromList, settled } from '../utils/attendance-ui'

const completed = expectedCompletedWeek()
const dates = weekDates(completed.start)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
})

test.afterAll(() => {
  clearMockScenario()
})

function toast(page: Page, text: RegExp | string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first()
}

test.describe('Employee status follows the pulled week (issue #35)', () => {
  test('a pull marks an absent employee inactive and reactivates an inactive one with punches', async ({ page }) => {
    const absent = await createEmployee({ employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' })
    const back = await createEmployee({ employeeId: 'E2E-HLP-9002', employeeName: 'Bala Singh', isActive: false })
    setMockPunches(mockDays('9002', dates.slice(0, 2), FULL_DAY, 'Empname9002'))

    await openAttendance(page)
    await pullWeekFromList(page, completed.start)

    // The base may hold other active employees with no punches, so only the reactivated count is exact.
    await expect(toast(page, /employees? marked inactive, 1 reactivated\./)).toBeVisible({ timeout: 20000 })

    await settled(page)
    const statuses = await prisma.employee.findMany({
      where: { id: { in: [absent.id, back.id] } },
      select: { id: true, isActive: true },
    })
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: absent.id, isActive: false },
        { id: back.id, isActive: true },
      ]),
    )
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'EMPLOYEE', entityId: { in: [absent.id, back.id] } },
      select: { detailsJson: true },
    })
    expect(audits).toHaveLength(2)
    for (const audit of audits) expect(audit.detailsJson).toMatchObject({ changeSource: 'AUTO_ATTENDANCE' })

    // The reactivated employee needs no decision on the employee check.
    await page.goto(`/attendance/${completed.start}/employee-check`)
    await expect(page.getByTestId('employee-check')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toHaveCount(0)

    await openReview(page, completed.start)
    const notice = page.getByTestId('status-changes-notice')
    await expect(notice).toContainText(/employees? marked inactive, 1 reactivated/)
    await expect(notice).toContainText('Anita Rao')
    await expect(notice).toContainText('Bala Singh')

    await page.goto('/employees')
    await page.locator('#employee-search').fill('E2E-HLP-900')
    await expect(page.locator('tbody tr').filter({ hasText: 'Anita Rao' })).toContainText('Inactive')
    await expect(page.locator('tbody tr').filter({ hasText: 'Bala Singh' })).not.toContainText('Inactive')
  })
})
