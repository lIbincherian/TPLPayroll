import { test, expect } from '@playwright/test'
import prisma, { cleanupTestData, seedApiWeek } from '../utils/db'
import { openPayrollSummary } from '../utils/payroll-ui'
import { testEmployeeId } from '../utils/test-namespace'

// #37: an employee onboarded today with an earlier "Wage effective from" date is paid for the earlier week
// they have attendance in. Without the date the first wage row would start today and payroll for that week
// would find no wage. WEEK is a pre-history test week (a Thursday), so it never touches the real data.
const WEEK = '2026-04-02'
const EMPLOYEE_ID = testEmployeeId('WEF', 1)
const NAME = 'Meera Wagefrom'

test.beforeAll(async () => {
  await cleanupTestData()
})

test.afterAll(async () => {
  await cleanupTestData()
})

test('onboarding with an earlier wage effective date includes the employee in that week\'s payroll', async ({ page }) => {
  await page.goto('/employees/new')
  await page.getByPlaceholder('EMP-042').fill(EMPLOYEE_ID)
  await page.getByPlaceholder('Lakshmi Venkatesh').fill(NAME)
  await page.getByPlaceholder('Guard').fill('Guard')
  await page.getByPlaceholder('800').fill('800')
  await page.getByLabel('Wage effective from').fill(WEEK)
  await page.getByRole('button', { name: 'Save Employee' }).click()
  await expect(page).toHaveURL(/\/employees\/[0-9a-f-]{36}$/, { timeout: 30000 })

  const employee = await prisma.employee.findUniqueOrThrow({
    where: { employeeId: EMPLOYEE_ID },
    include: { wageHistory: true },
  })
  expect(employee.wageHistory.map((w) => w.effectiveFrom.toISOString())).toEqual([`${WEEK}T00:00:00.000Z`])

  await seedApiWeek({
    weekStartISO: WEEK,
    employees: [employee],
    days: [Array(7).fill({ reg: 8, ot: 0 })],
  })

  await openPayrollSummary(page, WEEK)
  await expect(page.locator(`text=${NAME}`)).toBeVisible()
})
