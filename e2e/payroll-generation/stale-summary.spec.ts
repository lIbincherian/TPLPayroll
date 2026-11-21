import { test, expect } from '@playwright/test'
import prisma, {
  cleanupTestData,
  createEmployee,
  getAttendanceRecordHours,
  getWeekRow,
  seedReviewWeek,
} from '../utils/db'
import {
  approveButton,
  approveWeekInUi,
  closeEditor,
  openDay,
  openReview,
  setPairField,
  settled,
} from '../utils/attendance-ui'
import { weekDates } from '../utils/etimeoffice-mock'
import { openPayrollSummary } from '../utils/payroll-ui'

// Fix round, item 4: the payroll summary remembers which approval of the attendance it was built from.
// If the week is reopened and approved again (here with one more overtime hour) while the summary is
// open, approving it is refused, the user is sent back a step, and the recalculated summary then approves.

const W = '2025-09-25' // an ended week before the real data starts, so it can be approved on any run date
const dates = weekDates(W)
const WORKER = 'E2E-HLP-9001'
const CHANGED = 'Attendance for this week changed after this summary was calculated. Go back and recalculate.'

/** Eight hours a day, two pairs: 08:00-12:00 and 13:00-17:00. */
const EIGHT_HOURS = [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }]

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await cleanupTestData()
  const worker = await createEmployee({ employeeId: WORKER, employeeName: 'Anita Rao' })
  await seedReviewWeek({
    weekStartISO: W,
    rows: [
      {
        employee: { id: worker.id, employeeId: worker.employeeId, employeeName: worker.employeeName },
        empCode: '9001',
        days: dates.slice(0, 5).map((date) => ({ date, punches: EIGHT_HOURS })),
      },
    ],
  })
})

test.describe('E2E: a payroll summary for attendance that changed', () => {
  test('approving the old summary is refused; recalculating gives the new hours and then approves', async ({ page, context }) => {
    // Approve the week and open the summary (40 regular hours, nothing else)
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    await openPayrollSummary(page, W)
    // The Net Pay total is the last footer cell with an amount; Payment Date and Reference follow it empty.
    const totalCell = page.locator('tfoot td').filter({ hasText: '₹' }).last()
    const oldTotal = (await totalCell.innerText()).trim()
    const approvedBefore = (await getWeekRow(W))?.approvedAt

    // In another tab: reopen the week, add an overtime hour on the first day, approve again
    const other = await context.newPage()
    await openReview(other, W)
    await other.getByTestId('reopen-week-button').click()
    await other.getByTestId('reopen-confirm').click()
    await expect(approveButton(other)).toBeVisible({ timeout: 15000 })
    await openDay(other, WORKER, dates[0])
    await setPairField(other, 2, 'out', '18:00')
    await expect(other.getByTestId('editor-day-overtime')).toHaveText('1.00')
    await closeEditor(other)
    await approveWeekInUi(other)
    await settled(other)
    await other.close()
    const approvedAfter = (await getWeekRow(W))?.approvedAt
    expect(approvedAfter?.getTime()).toBeGreaterThan(approvedBefore!.getTime())

    // The summary on the first tab is the old one: approving it is refused
    await page.getByRole('button', { name: 'Approve Payroll' }).click()
    await page.getByRole('button', { name: 'Confirm Approval' }).click()
    await expect(page.getByRole('alert').filter({ hasText: CHANGED })).toBeVisible({ timeout: 15000 })
    // and it is back on the adjustments step, with no summary left to approve
    await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible()
    await expect(page.locator('h2:has-text("Payroll Summary")')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve Payroll' })).toHaveCount(0)
    await settled(page)
    expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })).toBe(0)

    // Calculate again: the new summary has the extra hour, the message is gone, and it approves
    await page.getByRole('button', { name: /Continue to (Payroll )?Summary/ }).click()
    await expect(page.locator('h2:has-text("Payroll Summary")')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(CHANGED)).toHaveCount(0)
    const newTotal = (await page.locator('tfoot td').filter({ hasText: '₹' }).last().innerText()).trim()
    expect(newTotal).not.toBe(oldTotal)
    await page.getByRole('button', { name: 'Approve Payroll' }).click()
    await page.getByRole('button', { name: 'Confirm Approval' }).click()
    await expect(page.locator('h2:has-text("Payroll Approved")')).toBeVisible({ timeout: 20000 })
    await settled(page)

    const run = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })
    const rows = await prisma.payrollRunEmployee.findMany({ where: { payrollRunId: run.id } })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].regularHours)).toBe(40)
    expect(Number(rows[0].overtimeHours)).toBe(1)
    expect((await getAttendanceRecordHours(W, WORKER)).find((h) => h.date === dates[0])).toMatchObject({ overtimeHours: 1 })
  })

  test('while the week is reopened, the open summary cannot be approved and the user is sent back', async ({ page, context }) => {
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    await openPayrollSummary(page, W)

    const other = await context.newPage()
    await openReview(other, W)
    await other.getByTestId('reopen-week-button').click()
    await other.getByTestId('reopen-confirm').click()
    await expect(approveButton(other)).toBeVisible({ timeout: 15000 })
    await settled(other)
    await other.close()
    expect((await getWeekRow(W))?.status).toBe('REVIEW')

    await page.getByRole('button', { name: 'Approve Payroll' }).click()
    await page.getByRole('button', { name: 'Confirm Approval' }).click()
    await expect(page.getByRole('alert').filter({ hasText: "Attendance for this week isn't approved yet" })).toBeVisible({ timeout: 15000 })
    // The flow reloaded the attendance: the week is no longer approved, so it is not ready and the user is on the
    // first step, which says why and links to the punches (not on the adjustments step, which needs approved attendance).
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible()
    await expect(page.getByRole('link', { name: /Review punches/ })).toHaveAttribute('href', `/attendance/${W}/review`)
    await expect(page.locator('h2:has-text("Review Adjustments")')).toHaveCount(0)
    await expect(page.locator('h2:has-text("Payroll Summary")')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve Payroll' })).toHaveCount(0)
    await settled(page)
    expect(await prisma.payrollRun.count({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })).toBe(0)
  })
})
