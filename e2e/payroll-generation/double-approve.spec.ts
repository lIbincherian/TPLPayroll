import { test, expect, type Page } from '@playwright/test'
import prisma, { cleanupDatabase, createEmployee, seedReviewWeek } from '../utils/db'
import { approveWeekInUi, openReview, settled } from '../utils/attendance-ui'
import { weekDates } from '../utils/etimeoffice-mock'
import { approvePayrollInUi, openPayrollSummary } from '../utils/payroll-ui'

// Fix round 3, item 1: approving a payroll must never leave two approved runs for one week. Two tabs
// open the same summary; whichever approves second is told the payroll is already approved, the summary
// stays on screen, and the database holds one run (PayrollRun.approvedWeekStart is unique too).

const W = '2026-10-01' // an ended week, so it can be approved on any run date
const dates = weekDates(W)
const WORKER = 'TPLGOAHLP001'
const ALREADY = 'Payroll for this week is already approved'

const EIGHT_HOURS = [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }]

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await cleanupDatabase()
  const worker = await createEmployee({ employeeId: WORKER, employeeName: 'Anita Rao' })
  await seedReviewWeek({
    weekStartISO: W,
    rows: [
      {
        employee: { id: worker.id, employeeId: worker.employeeId, employeeName: worker.employeeName },
        empCode: '0001',
        days: dates.slice(0, 5).map((date) => ({ date, punches: EIGHT_HOURS })),
      },
    ],
  })
})

async function approveAttendanceAndOpenTwoSummaries(page: Page, context: import('@playwright/test').BrowserContext) {
  await openReview(page, W)
  await approveWeekInUi(page)
  await settled(page)
  await openPayrollSummary(page, W)
  const other = await context.newPage()
  await openPayrollSummary(other, W)
  return other
}

async function expectOneRun() {
  const weekStart = new Date(`${W}T00:00:00Z`)
  const runs = await prisma.payrollRun.findMany({ where: { payrollWeekStartDate: weekStart } })
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ status: 'APPROVED', currentRevisionNumber: 1 })
  expect(runs[0].approvedWeekStart?.toISOString()).toBe(weekStart.toISOString())
  expect(await prisma.payrollRevision.count({ where: { payrollRunId: runs[0].id } })).toBe(1)
  const rows = await prisma.payrollRunEmployee.findMany({ where: { payrollRunId: runs[0].id } })
  expect(rows).toHaveLength(1)
  expect(Number(rows[0].regularHours)).toBe(40)
}

test.describe('E2E: two tabs approve the same payroll summary', () => {
  test('the second tab, approving after the first, is told the payroll is already approved and keeps its summary', async ({ page, context }) => {
    const other = await approveAttendanceAndOpenTwoSummaries(page, context)

    await approvePayrollInUi(page) // the first tab wins
    await settled(page)

    await other.getByRole('button', { name: 'Approve Payroll' }).click()
    await other.getByRole('button', { name: 'Confirm Approval' }).click()
    await expect(other.getByText(ALREADY)).toBeVisible({ timeout: 15000 })
    // It is not an attendance change: the summary stays, nothing sends the user back a step.
    await expect(other.locator('h2:has-text("Payroll Summary")')).toBeVisible()
    await expect(other.locator('h2:has-text("Payroll Approved")')).toHaveCount(0)
    await settled(other)

    await expectOneRun()
  })

  test('both tabs confirming at the same moment: exactly one is approved, the other is told it already is, and there is one run', async ({
    page,
    context,
  }) => {
    const other = await approveAttendanceAndOpenTwoSummaries(page, context)

    // Open both confirmation dialogs first, then confirm in both at once.
    await page.getByRole('button', { name: 'Approve Payroll' }).click()
    await other.getByRole('button', { name: 'Approve Payroll' }).click()
    await expect(page.locator('text=Approve this payroll run?')).toBeVisible()
    await expect(other.locator('text=Approve this payroll run?')).toBeVisible()
    await Promise.all([
      page.getByRole('button', { name: 'Confirm Approval' }).click(),
      other.getByRole('button', { name: 'Confirm Approval' }).click(),
    ])

    const outcome = async (p: Page) => {
      if ((await p.locator('h2:has-text("Payroll Approved")').count()) > 0) return 'approved'
      if ((await p.getByText(ALREADY).count()) > 0) return 'already-approved'
      return 'pending'
    }
    await expect
      .poll(async () => (await Promise.all([outcome(page), outcome(other)])).filter((o) => o === 'pending').length, {
        timeout: 30000,
        intervals: [300],
      })
      .toBe(0)
    const outcomes = (await Promise.all([outcome(page), outcome(other)])).sort()
    expect(outcomes).toEqual(['already-approved', 'approved'])

    await settled(page)
    await settled(other)
    await expectOneRun()
  })
})
