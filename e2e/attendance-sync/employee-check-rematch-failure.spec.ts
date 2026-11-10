import { test, expect, type Page, type Route } from '@playwright/test'
import prisma, { cleanupTestData, seedEmployeesForSync, getPunchRows } from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  FULL_DAY,
  mockDay,
  mockDays,
  setMockPunches,
  weekDates,
} from '../utils/etimeoffice-mock'
import { runCron, settled } from '../utils/attendance-ui'

// Opening the employee check re-matches the open codes. Each code commits on its own, so a run that fails
// part-way may already have linked some of them: the page has to reload after a failed attempt too, or it keeps
// listing a code as unresolved that is already linked. The failing run is simulated in the browser: the request is
// answered with a network failure, or (second test) the server refuses it for real because a pull holds the week,
// and in both cases the part-way link is written to the database first, the way the real run would have.

const week = expectedCompletedWeek()
const dates = weekDates(week.start)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  clearMockScenario()
  await cleanupTestData()
  await seedEmployeesForSync()
  // 9999 matches nobody and 9007 matches two employees: both stay on the employee check.
  setMockPunches([
    ...mockDay('9036', dates[0], FULL_DAY, 'Empname9036'),
    ...mockDays('9999', [dates[0], dates[1]], ['08:00', '12:00'], 'Gita Pillai'),
    ...mockDay('9007', dates[0], FULL_DAY, 'Empname9007'),
  ])
  expect((await runCron(request)).body).toMatchObject({ outcome: 'LOADED' })
})

test.afterAll(() => {
  clearMockScenario()
})

/** What a run that linked code 9999 before it failed would have left behind. */
async function linkCode9999() {
  const employee = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'E2E-HLP-9036' } })
  await prisma.attendancePunch.updateMany({ where: { empCode: '9999' }, data: { employeeId: employee.id, matchStatus: 'MATCHED' } })
}

async function openCheckWith(page: Page, onFirstAction: (route: Route) => Promise<void>) {
  let actions = 0
  await page.route('**/attendance/**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    actions++
    // The first action the page sends is the re-match it runs on arrival; every later one is passed through.
    if (actions === 1) return onFirstAction(route)
    return route.continue()
  })
  await settled(page)
  await page.goto(`/attendance/${week.start}/employee-check`)
  await expect(page.getByTestId('employee-check')).toBeVisible({ timeout: 15000 })
  return { actions: () => actions }
}

test.describe('E2E: the employee check after a re-match that failed part-way', () => {
  test('the request is lost: the page reloads anyway, so the code the run linked is no longer listed, and the error is shown', async ({ page }) => {
    const seen = await openCheckWith(page, async (route) => {
      await linkCode9999()
      await route.abort('failed')
    })

    await expect(page.getByTestId('employee-check-error')).toContainText("Couldn't reach the server. Try again.", { timeout: 15000 })
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0) // the reload shows it as linked
    await expect(page.getByTestId('code-row-9007')).toBeVisible()
    expect(seen.actions()).toBeGreaterThanOrEqual(2) // the failed re-match, then the reload
    await settled(page)
    expect((await getPunchRows(week.start, { empCode: '9999' })).every((p) => p.employeeCode === 'E2E-HLP-9036')).toBe(true)
  })

  test('the server refuses it (a pull holds the week): the same, with the server\'s own message', async ({ page }) => {
    const seen = await openCheckWith(page, async (route) => {
      await linkCode9999()
      await prisma.attendanceUpload.updateMany({ where: { payrollWeekStartDate: new Date(`${week.start}T00:00:00Z`) }, data: { syncLockedAt: new Date() } })
      await route.continue()
    })

    await expect(page.getByTestId('employee-check-error')).toContainText('A pull is running for this week.', { timeout: 15000 })
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await expect(page.getByTestId('code-row-9007')).toBeVisible()
    expect(seen.actions()).toBeGreaterThanOrEqual(2)
  })

  test('with nothing wrong the page also reloads, and shows no error', async ({ page }) => {
    const seen = await openCheckWith(page, async (route) => route.continue())

    await expect(page.getByTestId('code-row-9999')).toBeVisible({ timeout: 15000 })
    await expect.poll(() => seen.actions(), { timeout: 15000 }).toBeGreaterThanOrEqual(2) // the re-match, then the reload
    await expect(page.getByTestId('employee-check-error')).toHaveCount(0)
    await expect(page.getByText('Rechecking codes…')).toHaveCount(0)
  })
})
