import { test, expect } from '@playwright/test'
import JSZip from 'jszip'
import prisma, {
  baseGridEmployeeCount,
  cleanupTestData,
  createEmployee,
  getAttendanceRecordHours,
  getAuditRows,
  getRevisions,
  getWeekRow,
  seedApiWeek,
  seedReviewWeek,
} from '../utils/db'
import {
  approveButton,
  approveWeekInUi,
  dayCell,
  openAttendance,
  openDay,
  openReview,
  setPairField,
  settled,
  weekRow,
} from '../utils/attendance-ui'
import { addDays, expectedCompletedWeek, payrollWeekLabel, weekDates } from '../utils/etimeoffice-mock'
import { approvePayrollInUi, generateAndApprovePayroll, openPayrollSummary } from '../utils/payroll-ui'

// W is the last completed week: it has ended (so it can be approved on any run date) and it is always at the top
// of the week lists, which show only the newest weeks however many the real data holds. W_NEXT, the week after
// it, is the current week. Both are reserved for the specs: global setup removed the base's rows for them.
const W = expectedCompletedWeek().start
const W_NEXT = addDays(W, 7)
const dates = weekDates(W)

/** What the approval and payroll screens say about the left-out employees: the idle one plus every real active one. */
async function leftOutCount() {
  return 1 + (await baseGridEmployeeCount(W))
}

const WORKER = 'E2E-HLP-9001' // Anita Rao, works every day
const IDLE = 'E2E-HLP-9004' // Dev Kapoor, active but no punches

test.describe.configure({ mode: 'serial' })

/** Eight hours a day, two pairs: 08:00-12:00 and 13:00-17:00. */
const EIGHT_HOURS = [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }]

async function seedWeek() {
  await cleanupTestData()
  const worker = await createEmployee({ employeeId: WORKER, employeeName: 'Anita Rao' })
  const idle = await createEmployee({ employeeId: IDLE, employeeName: 'Dev Kapoor' })
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
  return { worker, idle }
}

test.beforeEach(async () => {
  await seedWeek()
})

test.describe('E2E-17: Zero-hour employees are left out', () => {
  test('the summary lists them, and after payroll there is no payroll row and no slip', async ({ page, request }) => {
    await openReview(page, W)
    await approveButton(page).click()
    await expect(page.getByTestId('approval-employees')).toHaveText('1')
    const idleRow = page.getByTestId(`left-out-${IDLE}`)
    await expect(idleRow).toBeVisible()
    // Approving marks the idle active employee inactive (issue #35), and the row says so.
    await expect(idleRow).toContainText('No punches, marked inactive')
    const leftOut = await leftOutCount()
    await expect(page.getByTestId('approval-left-out')).toContainText(`${leftOut} employee${leftOut === 1 ? '' : 's'} left out, no payslip`)
    await page.getByTestId('approve-confirm').click()
    await expect(page.getByTestId('approve-week-dialog')).toBeHidden({ timeout: 15000 })

    // Seven daily rows for the worker, none for the idle employee
    await settled(page)
    expect(await getAttendanceRecordHours(W, WORKER)).toHaveLength(7)
    expect(await getAttendanceRecordHours(W, IDLE)).toHaveLength(0)

    await generateAndApprovePayroll(page, W)
    await settled(page)
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })
    const rows = await prisma.payrollRunEmployee.findMany({ where: { payrollRunId: run.id }, include: { employee: true } })
    expect(rows.map((r) => r.employee.employeeId)).toEqual([WORKER])

    const response = await request.get(`/api/payroll/reports/${run.id}/slips`)
    expect(response.status()).toBe(200)
    const zip = await JSZip.loadAsync(await response.body())
    const pdfs = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith('.pdf'))
    expect(pdfs).toHaveLength(1)
    expect(pdfs[0]).toContain(WORKER)
    expect(pdfs.join(' ')).not.toContain(IDLE)
  })
})

test.describe('E2E-21: Payroll requires an approved week', () => {
  test('an unapproved week cannot start payroll; approving it opens payroll with the grid hours and locks the punches', async ({ page }) => {
    // Loaded but not approved
    await openAttendance(page)
    await expect(weekRow(page, W)).toHaveAttribute('data-status', 'REVIEW')
    await page.goto('/payroll')
    const payrollRow = page.locator('tr', { hasText: 'Ready for review' }).filter({ hasText: payrollWeekLabel({ start: W, end: addDays(W, 6) }) }).first()
    await expect(payrollRow).toBeVisible()
    await expect(payrollRow.locator('span[title="Approve this week\'s attendance first"]')).toBeVisible()
    await expect(payrollRow.locator('a:has-text("Generate")')).toHaveCount(0)

    await settled(page)
    await page.goto(`/payroll/generate/${W}`)
    await expect(page.getByText("Attendance for this week isn't approved yet")).toBeVisible()
    await expect(page.getByRole('link', { name: /Review punches/ })).toHaveAttribute('href', `/attendance/${W}/review`)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)

    // Approve: the grid says 40.00 regular hours (5 days x 8)
    await openReview(page, W)
    await expect(page.getByTestId('grand-total')).toContainText('40.00')
    await approveWeekInUi(page)

    // Payroll now accepts the week, with the same hours
    await settled(page)
    await page.goto(`/payroll/generate/${W}`)
    await expect(page.getByText(`Attendance approved: 1 employees, ${await leftOutCount()} left out`)).toBeVisible()
    await expect(page.locator('p:has-text("Total Regular Hrs") + p')).toHaveText('40.00')
    await expect(page.locator('p:has-text("Total Overtime Hrs") + p')).toHaveText('0.00')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
    const hours = await getAttendanceRecordHours(W, WORKER)
    expect(hours.reduce((sum, h) => sum + h.regularHours, 0)).toBe(40)

    // The week is locked: the editor opens read-only and the approve button is gone
    await openReview(page, W)
    await expect(page.getByTestId('punch-review')).toHaveAttribute('data-locked', 'true')
    await expect(approveButton(page)).toHaveCount(0)
    await openDay(page, WORKER, dates[0])
    await expect(page.getByTestId('editor-save-status')).toContainText('Read only')
    await expect(page.getByTestId('editor-pair-1-in')).toHaveText('08:00')
    await expect(page.locator('input[data-testid="editor-pair-1-in"]')).toHaveCount(0)
  })
})

test.describe('E2E-22: Reopen before payroll is approved', () => {
  test('reopen, edit a punch, approve again: no revision, and payroll uses the new hours', async ({ page }) => {
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    expect((await getWeekRow(W))?.status).toBe('APPROVED')
    expect((await getAttendanceRecordHours(W, WORKER)).find((h) => h.date === dates[0])).toMatchObject({
      regularHours: 8,
      overtimeHours: 0,
    })

    // Reopen: the week is editable again and not ready for payroll
    await page.getByTestId('reopen-week-button').click()
    await page.getByTestId('reopen-confirm').click()
    await expect(approveButton(page)).toBeVisible({ timeout: 15000 })
    await settled(page)
    expect((await getWeekRow(W))?.status).toBe('REVIEW')
    expect(await getAttendanceRecordHours(W, WORKER)).toHaveLength(0)
    await page.goto(`/payroll/generate/${W}`)
    await expect(page.getByText("Attendance for this week isn't approved yet")).toBeVisible()

    // Edit the first day's last punch, 17:00 -> 18:00 (9 hours, 1 overtime), and approve again
    await openReview(page, W)
    await openDay(page, WORKER, dates[0])
    await setPairField(page, 2, 'out', '18:00')
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.00')
    await page.getByTestId('editor-close').click()
    await approveWeekInUi(page)

    await settled(page)
    expect((await getAttendanceRecordHours(W, WORKER)).find((h) => h.date === dates[0])).toMatchObject({
      regularHours: 8,
      overtimeHours: 1,
    })
    // No revision was created by reopening or re-approving
    expect(await prisma.payrollRevision.count({ where: { payrollRun: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } } })).toBe(0)
    const events = (await getAuditRows('ATTENDANCE_WEEK')).map((a) => a.actionType)
    expect(events).toEqual(expect.arrayContaining(['APPROVE', 'REOPEN']))

    // Payroll uses the new hours
    await generateAndApprovePayroll(page, W)
    await settled(page)
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })
    const rows = await prisma.payrollRunEmployee.findMany({ where: { payrollRunId: run.id } })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].regularHours)).toBe(40)
    expect(Number(rows[0].overtimeHours)).toBe(1)
    // The only revision is the first approval of the payroll itself
    const revisions = await getRevisions(run.id)
    expect(revisions.map((r) => r.revisionNumber)).toEqual([1])
  })
})

test.describe('E2E-23: Reopen is unavailable after payroll is approved', () => {
  test('the week view has no Reopen and no Pull now, and points to Correct on the payroll run', async ({ page }) => {
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    await page.getByTestId('go-to-payroll').click()
    await expect(page.locator('h2:has-text("Verify Attendance")')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible()
    await page.getByRole('button', { name: /Continue to (Payroll )?Summary/ }).click()
    await approvePayrollInUi(page)
    await settled(page)

    await openReview(page, W)
    await expect(page.getByTestId('punch-review')).toHaveAttribute('data-locked', 'true')
    await expect(page.getByTestId('reopen-week-button')).toHaveCount(0)
    await expect(page.getByTestId('go-to-payroll')).toHaveCount(0)
    await expect(page.getByTestId('payroll-lock-note')).toContainText('use Correct on the payroll run')
    await expect(page.getByTestId('open-payroll-run')).toBeVisible()

    await openAttendance(page)
    await expect(weekRow(page, W)).toHaveAttribute('data-status', 'APPROVED')
    await expect(page.getByTestId(`pull-now-${W}`)).toHaveCount(0)

    // Corrections go through Correct on the payroll run
    await openReview(page, W)
    await page.getByTestId('open-payroll-run').click()
    await expect(page.getByRole('button', { name: 'Correct' })).toBeVisible({ timeout: 15000 })
    // The week stays approved
    expect((await getWeekRow(W))?.status).toBe('APPROVED')
  })
})

test.describe("E2E-38: A left-out employee's adjustments carry forward", () => {
  test('a pending 500 deduction is not applied and is pending in the next week they are paid', async ({ page }) => {
    const idle = await prisma.employee.findFirstOrThrow({ where: { employeeId: IDLE } })
    const worker = await prisma.employee.findFirstOrThrow({ where: { employeeId: WORKER } })
    const adjustment = await prisma.payrollAdjustment.create({
      data: {
        employeeId: idle.id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'ONE_TIME',
        amount: 500,
        reason: 'Advance recovery',
        startPayrollWeekStartDate: new Date(`${W}T00:00:00Z`),
        startPayrollWeekEndDate: new Date(`${addDays(W, 6)}T00:00:00Z`),
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    })
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adjustment.id,
        employeeId: idle.id,
        payrollWeekStartDate: new Date(`${W}T00:00:00Z`),
        payrollWeekEndDate: new Date(`${addDays(W, 6)}T00:00:00Z`),
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    })

    // Week W: the employee has zero hours, so they are left out
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    await openPayrollSummary(page, W)
    // Left out: the adjustment review step did not list their deduction, and the summary has only the worker
    await expect(page.locator('td', { hasText: 'Anita Rao' }).first()).toBeVisible()
    await expect(page.locator('td', { hasText: 'Dev Kapoor' })).toHaveCount(0)
    await approvePayrollInUi(page)
    await settled(page)

    const first = await prisma.payrollAdjustmentApplication.findMany({
      where: { payrollAdjustmentId: adjustment.id },
      orderBy: { payrollWeekStartDate: 'asc' },
    })
    // The deduction was not applied in week W...
    const inWeek = first.find((a) => a.payrollWeekStartDate.toISOString().slice(0, 10) === W)!
    expect(inWeek.approvalStatus).toBe('SKIPPED')
    expect(inWeek.payrollRunId).toBeNull()
    // ...and is pending in the next week
    const next = first.find((a) => a.payrollWeekStartDate.toISOString().slice(0, 10) === W_NEXT)
    expect(next).toBeDefined()
    expect(next!.approvalStatus).toBe('PENDING')
    expect(Number(next!.appliedAmount)).toBe(500)
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`) } })
    expect(Number(run.totalDeductions)).toBe(0)

    // The employee is paid in the next week: the deduction shows up in that week's adjustment review
    await seedApiWeek({
      weekStartISO: W_NEXT,
      employees: [worker, idle],
      days: [Array(7).fill({ reg: 8, ot: 0 }), Array(7).fill({ reg: 8, ot: 0 })],
      status: 'APPROVED',
    })
    await settled(page)
    await page.goto(`/payroll/generate/${W_NEXT}`)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.locator('h2:has-text("Review Adjustments")')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=Advance recovery')).toBeVisible()
    await expect(page.locator('text=Dev Kapoor').first()).toBeVisible()
  })
})
