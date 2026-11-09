import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupDatabase,
  getAuditRows,
  getPunchRows,
  getWeekRow,
  seedEmployeesForSync,
  seedReviewWeek,
} from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  FULL_DAY,
  mockDays,
  setMockScenario,
  weekDates,
} from '../utils/etimeoffice-mock'
import { approveButton, approveWeekInUi, openAttendance, openDay, openReview, setPairField, settled } from '../utils/attendance-ui'

// Fix round, item 3: while a pull is running, approving and editing the week are refused ("A pull is
// running for this week"); a pull never replaces a week that was approved while the API call ran.
// The mock eTimeOffice API answers after `delayMs`, which keeps the pull "running" long enough.

const completed = expectedCompletedWeek()
const completedDates = weekDates(completed.start)
const ANITA = 'TPLGOAHLP001'
const PULL_RUNNING = 'A pull is running for this week. Wait for it to finish, then try again.'
const WEEK_CHANGED = 'The week was approved while the pull was running. Nothing was replaced.'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupDatabase()
})

test.afterAll(() => {
  clearMockScenario()
})

/** A sonner toast with this text. */
function toast(page: Page, text: RegExp | string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first()
}

/** An ended week in review with Anita's punches on three days, and the mock API answering slowly. */
async function seedWeekAndSlowApi(delayMs: number) {
  const emps = await seedEmployeesForSync()
  const anita = emps[ANITA]
  const { id } = await seedReviewWeek({
    weekStartISO: completed.start,
    rows: [
      {
        employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
        empCode: '0001',
        days: completedDates.slice(0, 3).map((date) => ({ date, punches: FULL_DAY.map((time) => ({ time })) })),
      },
    ],
  })
  setMockScenario({
    status: 200,
    body: { Error: false, Msg: 'Success', IsAdmin: true, PunchData: mockDays('0001', completedDates) },
    delayMs,
  })
  return id
}

/** Click Pull now and wait until the server holds the sync lock. */
async function startPull(page: Page) {
  await openAttendance(page)
  await page.getByTestId(`pull-now-${completed.start}`).click()
  await expect
    .poll(async () => (await getWeekRow(completed.start))?.syncLockedAt ?? null, { timeout: 20000, intervals: [300] })
    .not.toBeNull()
}

test.describe('Approve and edit are refused while a pull is running', () => {
  test('both say a pull is running and change nothing; once the pull is done the week can be approved', async ({ page, context }) => {
    test.setTimeout(150000)
    const weekId = await seedWeekAndSlowApi(25000)

    await startPull(page)

    // A second tab opens the week while the pull is waiting for the API
    const other = await context.newPage()
    await openReview(other, completed.start)

    // Approve: the dialog opens, the confirmation is refused
    await expect(approveButton(other)).toBeEnabled()
    await approveButton(other).click()
    await expect(other.getByTestId('approve-week-dialog')).toBeVisible()
    await expect(other.getByTestId('approval-employees')).not.toHaveText('', { timeout: 10000 })
    await other.getByTestId('approve-confirm').click()
    await expect(other.getByTestId('approve-error')).toContainText(PULL_RUNNING, { timeout: 15000 })
    await other.getByTestId('approve-cancel').click()
    await expect(other.getByTestId('approve-week-dialog')).toBeHidden()

    // Edit: the save is refused with the same message and the punch is unchanged
    await openDay(other, ANITA, completedDates[0])
    await setPairField(other, 2, 'out', '18:00', { expectSaved: false })
    await expect(other.getByTestId('editor-save-status')).toContainText(PULL_RUNNING, { timeout: 15000 })

    // The pull is still running, so none of that changed the week
    const during = await getWeekRow(completed.start)
    expect(during?.status).toBe('REVIEW')
    expect(during?.syncLockedAt).not.toBeNull()
    expect((await getPunchRows(completed.start, {})).filter((p) => p.currentTime === '18:00')).toHaveLength(0)
    expect((await getAuditRows('ATTENDANCE_WEEK', 'APPROVE')).length).toBe(0)
    expect((await getAuditRows('ATTENDANCE_PUNCH')).length).toBe(0)
    expect(await prisma.attendanceRecord.count({ where: { attendanceUploadId: weekId } })).toBe(0)

    // The pull finishes and replaces the punches
    await expect(toast(page, /Loaded/)).toBeVisible({ timeout: 60000 })
    await settled(page)
    const after = await getWeekRow(completed.start)
    expect(after?.syncLockedAt).toBeNull()
    expect(after?.status).toBe('REVIEW')
    expect(await getPunchRows(completed.start, {})).toHaveLength(7 * 4)

    // Now approving works
    await openReview(other, completed.start)
    await approveWeekInUi(other)
    await settled(other)
    expect((await getWeekRow(completed.start))?.status).toBe('APPROVED')
    expect((await getAuditRows('ATTENDANCE_WEEK', 'APPROVE')).length).toBe(1)
  })
})

test.describe('A pull does not replace a week that was approved while the API call was running', () => {
  test('the week stays approved, its punches stay, and the pull reports why', async ({ page }) => {
    test.setTimeout(120000)
    const weekId = await seedWeekAndSlowApi(12000)
    const punchesBefore = await getPunchRows(completed.start, {})
    expect(punchesBefore).toHaveLength(3 * 4)

    await startPull(page)

    // Someone approves the week behind the pull's back (the sync lock is not a guard for writers that
    // do not check it, and the pull must still notice). Done directly, as the screens now refuse it.
    await prisma.attendanceUpload.update({ where: { id: weekId }, data: { status: 'APPROVED', approvedAt: new Date() } })

    await expect(toast(page, new RegExp(WEEK_CHANGED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible({ timeout: 60000 })
    await settled(page)

    const after = await getWeekRow(completed.start)
    expect(after?.status).toBe('APPROVED')
    expect(after?.syncLockedAt).toBeNull()
    expect(after?.lastSyncError).toBe(WEEK_CHANGED)
    // Nothing was replaced
    expect(await getPunchRows(completed.start, {})).toEqual(punchesBefore)
    const pulls = await getAuditRows('ATTENDANCE_WEEK', 'PULL')
    expect(pulls).toHaveLength(1)
    expect(pulls[0].detailsJson).toMatchObject({ outcome: 'FAILED', code: 'WEEK_CHANGED' })
  })
})
