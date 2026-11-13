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
import { approveWeekInUi, openAttendance, openReview, pullWeekFromList, settled } from '../utils/attendance-ui'

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

async function statusOf(ids: string[]) {
  return prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true } })
}

test.describe('Employee status follows the approved week (issue #35)', () => {
  test('a pull changes no status; approving the week marks an absent employee inactive and reactivates an approved inactive one', async ({
    page,
  }) => {
    const absent = await createEmployee({ employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' })
    const back = await createEmployee({ employeeId: 'E2E-HLP-9002', employeeName: 'Bala Singh', isActive: false })
    setMockPunches(mockDays('9002', dates.slice(0, 2), FULL_DAY, 'Empname9002'))

    // The pull loads the punches but leaves every employee as they were.
    await openAttendance(page)
    await pullWeekFromList(page, completed.start)
    await expect(toast(page, /Loaded/)).toBeVisible({ timeout: 20000 })
    await settled(page)
    expect(await statusOf([absent.id, back.id])).toEqual(
      expect.arrayContaining([
        { id: absent.id, isActive: true },
        { id: back.id, isActive: false },
      ]),
    )

    // The inactive employee with punches needs a decision before the week can be approved.
    await page.goto(`/attendance/${completed.start}/employee-check`)
    await expect(page.getByTestId('employee-check')).toBeVisible({ timeout: 15000 })
    await page.getByTestId('decision-approve-E2E-HLP-9002').click()
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toHaveAttribute('data-decision', 'APPROVED')

    await openReview(page, completed.start)
    await expect(page.getByTestId('status-changes-notice')).toHaveCount(0)

    // The approve dialog previews the changes before anything is written.
    await page.getByTestId('approve-week-button').click()
    const preview = page.getByTestId('approval-status-changes')
    await expect(preview).toContainText(/employees? marked inactive, 1 reactivated\./, { timeout: 10000 })
    await expect(preview).toContainText('Bala Singh')
    await expect(page.getByTestId('left-out-E2E-HLP-9001')).toContainText('No punches, marked inactive')
    await page.getByTestId('approve-confirm').click()
    await expect(page.getByTestId('approve-week-dialog')).toBeHidden({ timeout: 15000 })

    // The base may hold other active employees with no punches, so only the reactivated count is exact.
    await expect(toast(page, /employees? marked inactive, 1 reactivated\./)).toBeVisible({ timeout: 20000 })
    await settled(page)
    expect(await statusOf([absent.id, back.id])).toEqual(
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

    await openReview(page, completed.start)
    const notice = page.getByTestId('status-changes-notice')
    await expect(notice).toContainText(/employees? marked inactive, 1 reactivated when this week was approved\./)
    await expect(notice).toContainText('Anita Rao')
    await expect(notice).toContainText('Bala Singh')
    await expect(page.getByTestId('approved-summary')).toContainText(/marked inactive \(no punches\)/)

    // Reopening hides the notice without a reload; approving again changes nobody but brings it back.
    await page.getByTestId('reopen-week-button').click()
    await page.getByTestId('reopen-confirm').click()
    await expect(notice).toHaveCount(0, { timeout: 15000 })
    await approveWeekInUi(page)
    await expect(notice).toContainText('Anita Rao', { timeout: 15000 })
    await expect(page.getByTestId('approved-summary')).toContainText(/marked inactive \(no punches\)/)

    await page.goto('/employees')
    await page.locator('#employee-search').fill('E2E-HLP-900')
    await expect(page.locator('tbody tr').filter({ hasText: 'Anita Rao' })).toContainText('Inactive')
    await expect(page.locator('tbody tr').filter({ hasText: 'Bala Singh' })).not.toContainText('Inactive')
  })
})
