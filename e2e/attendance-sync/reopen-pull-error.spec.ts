import { test, expect } from '@playwright/test'
import prisma, { cleanupDatabase, createEmployee, getWeekRow, seedReviewWeek } from '../utils/db'
import { approveButton, approveWeekInUi, openAttendance, openReview, settled, weekRow } from '../utils/attendance-ui'
import { weekDates } from '../utils/etimeoffice-mock'

// Fix round 3, item 7: a pull that loses the race to an approval records "The week was approved while the
// pull was running" on the week. After a reopen (or an approval) that message is no longer actionable, but
// the week list still showed "Last pull failed: ..." on the reopened week. Approve and reopen now clear it.

const W = '2026-10-15' // an ended week
const dates = weekDates(W)
const WEEK_CHANGED = 'The week was approved while the pull was running. Nothing was replaced.'
const EIGHT_HOURS = [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }]

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await cleanupDatabase()
  const worker = await createEmployee({ employeeId: 'TPLGOAHLP001', employeeName: 'Anita Rao' })
  await seedReviewWeek({
    weekStartISO: W,
    rows: [
      {
        employee: { id: worker.id, employeeId: worker.employeeId, employeeName: worker.employeeName },
        empCode: '0001',
        days: dates.slice(0, 3).map((date) => ({ date, punches: EIGHT_HOURS })),
      },
    ],
  })
})

test.describe('E2E: a pull error from before an approval or reopen is not shown afterwards', () => {
  test('the error shows on the review week, and is gone after approving and reopening', async ({ page }) => {
    // A pull that lost the race left its failure on the week.
    await prisma.attendanceUpload.updateMany({
      where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`), isActiveForPayrollWeek: true },
      data: { lastSyncError: WEEK_CHANGED, lastSyncAttemptAt: new Date() },
    })
    await openAttendance(page)
    await expect(weekRow(page, W).getByTestId('week-error')).toContainText(`Last pull failed: ${WEEK_CHANGED}`)

    // Approve: the error is cleared in the same step.
    await openReview(page, W)
    await approveWeekInUi(page)
    await settled(page)
    expect((await getWeekRow(W))?.status).toBe('APPROVED')
    expect((await getWeekRow(W))?.lastSyncError).toBeNull()

    // A pull that loses the race to the approval writes the error onto the APPROVED week...
    await prisma.attendanceUpload.updateMany({
      where: { payrollWeekStartDate: new Date(`${W}T00:00:00Z`), isActiveForPayrollWeek: true },
      data: { lastSyncError: WEEK_CHANGED },
    })
    // ...and reopening the week must not bring it back.
    await openReview(page, W)
    await page.getByTestId('reopen-week-button').click()
    await page.getByTestId('reopen-confirm').click()
    await expect(approveButton(page)).toBeVisible({ timeout: 15000 })
    await settled(page)

    const row = await getWeekRow(W)
    expect(row?.status).toBe('REVIEW')
    expect(row?.lastSyncError).toBeNull()
    await openAttendance(page)
    await expect(weekRow(page, W)).toHaveAttribute('data-status', 'REVIEW')
    await expect(weekRow(page, W).getByTestId('week-error')).toHaveCount(0)
    await expect(page.getByText('Last pull failed')).toHaveCount(0)
  })
})
