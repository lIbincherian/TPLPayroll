import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupTestData,
  createEmployee,
  seedApiWeek,
  seedEmployeesForSync,
  seedReviewWeek,
  getAuditRows,
  getDecisionRows,
  getPunchRows,
  getWeekRow,
} from '../utils/db'
import {
  addDays,
  clearMockScenario,
  expectedCompletedWeek,
  expectedCurrentWeek,
  FULL_DAY,
  mockDay,
  mockDays,
  setMockApiError,
  setMockEmpty,
  setMockHttpError,
  setMockPunches,
  weekDates,
} from '../utils/etimeoffice-mock'
import { openAttendance, openDay, openReview, setPairField, weekRow } from '../utils/attendance-ui'

const completed = expectedCompletedWeek()
const current = expectedCurrentWeek()
const completedDates = weekDates(completed.start)
/** A Thursday before production started (2026-05-14): no row exists for it, in the base or the list. */
const PAST_PICKER_WEEK = '2026-04-30'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
})

test.afterAll(() => {
  clearMockScenario()
})

/** A sonner toast with this text. */
function toast(page: Page, text: RegExp | string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first()
}

/** Pick a week in the "Load a past week" popover, stepping back through the months if needed. */
async function chooseWeekInPicker(page: Page, weekStart: string): Promise<void> {
  await page.getByTestId('load-past-week-button').click()
  const row = page.getByTestId(`week-picker-row-${weekStart}`)
  for (let i = 0; i < 12 && !(await row.isVisible()); i++) {
    await page.getByRole('button', { name: 'Previous month' }).click()
  }
  await expect(row).toBeVisible()
  if (await row.getAttribute('data-disabled')) return
  await row.click()
}

/**
 * The week from E2E-30 / E2E-31: 12 edited days (11 seeded, 1 edited in the grid) and one
 * employee decision, plus the audit row of the grid edit.
 */
async function seedWeekWithEditsAndDecision(page: Page) {
  const emps = await seedEmployeesForSync()
  const lite = (code: string) => {
    const e = emps[code]
    return { id: e.id, employeeId: e.employeeId, employeeName: e.employeeName }
  }
  const { id } = await seedReviewWeek({
    weekStartISO: completed.start,
    rows: [
      {
        employee: lite('E2E-HLP-9001'),
        empCode: '9001',
        days: completedDates.slice(0, 6).map((date) => ({ date, punches: FULL_DAY.map((time) => ({ time })) })),
      },
      {
        employee: lite('E2E-HLP-9004'),
        empCode: '9004',
        days: completedDates.slice(0, 6).map((date) => ({ date, punches: FULL_DAY.map((time) => ({ time })) })),
      },
      {
        employee: lite('E2E-HLP-9002'),
        empCode: '9002',
        days: [{ date: completedDates[0], punches: [{ time: '08:00' }, { time: '16:00' }] }],
      },
    ],
  })
  // 11 edited days: the last OUT of each day moved from 17:47 to 18:00
  const edit = async (employeeCode: string, dayCount: number) => {
    await prisma.attendancePunch.updateMany({
      where: {
        attendanceUploadId: id,
        originalTime: '17:47',
        employee: { employeeId: employeeCode },
        punchDate: { in: completedDates.slice(0, dayCount).map((d) => new Date(`${d}T00:00:00Z`)) },
      },
      data: { currentTime: '18:00' },
    })
  }
  await edit('E2E-HLP-9001', 6)
  await edit('E2E-HLP-9004', 5)
  await prisma.attendanceEmployeeDecision.create({
    data: { attendanceUploadId: id, employeeId: emps['E2E-HLP-9002'].id, reason: 'INACTIVE', decision: 'APPROVED' },
  })
  // The 12th edited day, through the grid, so the audit log has a real edit entry
  await openReview(page, completed.start)
  await openDay(page, 'E2E-HLP-9004', completedDates[5])
  await setPairField(page, 2, 'out', '18:00')
  return id
}

test.describe('E2E-06: Any unapproved week can be pulled manually', () => {
  test('a week still in progress can be pulled and is not locked', async ({ page }) => {
    await seedEmployeesForSync()
    setMockPunches(mockDay('9001', current.start, FULL_DAY))

    await openAttendance(page)
    const row = weekRow(page, current.start)
    // No row yet: the week list always carries the in-progress week
    await expect(row).toHaveAttribute('data-status', 'NO_DATA')
    await expect(row.getByTestId('week-status-badge')).toHaveText(/In progress/)
    await page.getByTestId(`pull-now-${current.start}`).click()

    await expect(row).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await expect(row.getByTestId('week-status-badge')).toHaveText(/Ready for review/)

    const week = await getWeekRow(current.start)
    expect(week?.status).toBe('REVIEW')
    expect(week?.approvedAt).toBeNull()
    expect(await getPunchRows(current.start, {})).toHaveLength(4)

    // Not locked: the grid is editable and a day opens an editor with input fields
    await openReview(page, current.start)
    await expect(page.getByTestId('punch-review')).not.toHaveAttribute('data-locked', /.*/)
    await openDay(page, 'E2E-HLP-9001', current.start)
    await expect(page.getByTestId('editor-pair-1-in')).toBeEditable()
  })

  test('a past week with no data is loaded from the "Load a past week" picker', async ({ page }) => {
    await seedEmployeesForSync()
    // A week before the real data starts (the test namespace): it has no row, and no real week is in its place.
    // The list shows only the newest weeks, so the row of this old week is not looked for there; the picker's
    // own result (the "Loaded" toast) and the stored week prove the pull.
    const pastStart = PAST_PICKER_WEEK
    setMockPunches(mockDays('9001', weekDates(pastStart)))

    await openAttendance(page)
    await expect(weekRow(page, pastStart)).toHaveCount(0)
    await chooseWeekInPicker(page, pastStart)
    await expect(page.getByTestId('week-picker-selected')).not.toHaveText('Choose a week')
    await page.getByTestId('week-picker-pull').click()

    await expect(toast(page, /Loaded/)).toBeVisible({ timeout: 20000 })
    const week = await getWeekRow(pastStart)
    expect(week?.status).toBe('REVIEW')
    expect(week?.approvedAt).toBeNull()
    expect(await getPunchRows(pastStart, {})).toHaveLength(7 * 4)
  })

  test('the picker blocks a week that has not started', async ({ page }) => {
    await openAttendance(page)
    const nextWeek = addDays(current.start, 7)
    await page.getByTestId('load-past-week-button').click()
    // Future weeks are in the next month at most; step forward until the row shows
    const row = page.getByTestId(`week-picker-row-${nextWeek}`)
    for (let i = 0; i < 2 && !(await row.isVisible()); i++) {
      const next = page.getByRole('button', { name: 'Next month' })
      if (await next.isDisabled()) break
      await next.click()
    }
    if (await row.isVisible()) await expect(row).toHaveAttribute('data-disabled', 'true')
    // Whatever the calendar shows, a week that has not started has no Pull now
    await page.keyboard.press('Escape')
    await expect(page.getByTestId(`pull-now-${nextWeek}`)).toHaveCount(0)
  })

  test('a week that already has data can be pulled again without a warning when nothing was edited', async ({ page }) => {
    const emps = await seedEmployeesForSync()
    const anita = emps['E2E-HLP-9001']
    await seedReviewWeek({
      weekStartISO: completed.start,
      rows: [
        {
          employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
          empCode: '9001',
          days: [{ date: completedDates[0], punches: FULL_DAY.map((time) => ({ time })) }],
        },
      ],
    })
    setMockPunches(mockDays('9001', completedDates))

    await openAttendance(page)
    await page.getByTestId(`pull-now-${completed.start}`).click()
    await expect(page.getByTestId('pull-warning-dialog')).toHaveCount(0)
    // Wait for the pull to finish in the UI before reading the database (the local Postgres
    // handles one busy client at a time)
    await expect(toast(page, /Loaded/)).toBeVisible({ timeout: 20000 })
    expect(await getPunchRows(completed.start, {})).toHaveLength(7 * 4)
  })
})

test.describe('E2E-30: A new pull replaces the previous pull after a warning', () => {
  test('warns, replaces the punches, clears decisions and keeps the discarded edits in the audit log', async ({ page }) => {
    const editRowsBefore = (await getAuditRows()).length
    await seedWeekWithEditsAndDecision(page)
    const auditBefore = await getAuditRows('ATTENDANCE_PUNCH')
    expect(auditBefore.length).toBeGreaterThanOrEqual(1)
    expect((await getAuditRows()).length).toBeGreaterThan(editRowsBefore)

    // The new pull has different punches
    setMockPunches([
      ...mockDays('9001', completedDates, ['09:00', '17:00']),
      ...mockDays('9004', completedDates.slice(0, 3), ['09:00', '17:00']),
      ...mockDay('9002', completedDates[0], ['08:00', '16:00']),
    ])

    await openAttendance(page)
    await page.getByTestId(`pull-now-${completed.start}`).click()
    const dialog = page.getByTestId('pull-warning-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('pull-warning-text')).toHaveText('This will discard 12 edited days and your employee decisions.')

    // Cancel: nothing changes
    await page.getByTestId('pull-warning-cancel').click()
    await expect(dialog).toBeHidden()
    expect((await getPunchRows(completed.start, {})).filter((p) => p.currentTime === '18:00')).toHaveLength(12)
    expect(await getDecisionRows(completed.start)).toHaveLength(1)

    // Confirm: replaced
    await page.getByTestId(`pull-now-${completed.start}`).click()
    await page.getByTestId('pull-warning-confirm').click()
    await expect(toast(page, /Loaded/)).toBeVisible({ timeout: 20000 })
    expect(await getPunchRows(completed.start, {})).toHaveLength(7 * 2 + 3 * 2 + 2)

    const punches = await getPunchRows(completed.start, {})
    expect(punches.some((p) => p.originalTime === '17:47')).toBe(false)
    expect(punches.every((p) => p.currentTime === p.originalTime)).toBe(true)
    expect(await getDecisionRows(completed.start)).toHaveLength(0)
    expect((await getWeekRow(completed.start))?.status).toBe('REVIEW')

    // Employee decisions must be made again
    await page.goto(`/attendance/${completed.start}/employee-check`)
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toHaveAttribute('data-decision', 'NONE')

    // The audit log keeps the discarded edits: the earlier edit entry is still there, and the pull entry lists them
    const auditAfter = await getAuditRows('ATTENDANCE_PUNCH')
    expect(auditAfter.map((a) => a.id)).toEqual(expect.arrayContaining(auditBefore.map((a) => a.id)))
    const pull = (await getAuditRows('ATTENDANCE_WEEK', 'PULL')).at(-1)
    const details = pull?.detailsJson as {
      discarded?: { editedDays: number; decisions: number; edits: Array<{ original: string | null; current: string | null }> }
    }
    expect(details.discarded?.editedDays).toBe(12)
    expect(details.discarded?.decisions).toBe(1)
    expect(details.discarded?.edits.length).toBeGreaterThanOrEqual(12)
    expect(details.discarded?.edits.every((e) => e.original === '17:47' && e.current === '18:00')).toBe(true)
  })
})

test.describe('E2E-31: A failed pull changes nothing', () => {
  for (const scenario of [
    { name: 'the API fails with HTTP 500', set: () => setMockHttpError(500), message: 'eTimeOffice returned HTTP 500.' },
    { name: 'the API answers Error = true', set: () => setMockApiError('Login blocked'), message: 'eTimeOffice reported an error: Login blocked' },
    { name: 'the API returns no punches', set: () => setMockEmpty(), message: 'eTimeOffice returned no punches for this week.' },
  ]) {
    test(`existing punches, edits and decisions stay when ${scenario.name}`, async ({ page }) => {
      await seedWeekWithEditsAndDecision(page)
      const before = await getPunchRows(completed.start, {})
      const decisionsBefore = await getDecisionRows(completed.start)
      scenario.set()

      await openAttendance(page)
      await page.getByTestId(`pull-now-${completed.start}`).click()
      await page.getByTestId('pull-warning-confirm').click()

      // The error is shown on the week
      await expect(weekRow(page, completed.start).getByTestId('week-error')).toContainText(scenario.message, { timeout: 20000 })
      await expect(weekRow(page, completed.start)).toHaveAttribute('data-status', 'REVIEW')

      // And nothing else moved
      const after = await getPunchRows(completed.start, {})
      expect(after).toEqual(before)
      expect(await getDecisionRows(completed.start)).toEqual(decisionsBefore)
      const row = await getWeekRow(completed.start)
      expect(row?.status).toBe('REVIEW')
      expect(row?.lastSyncError).toBe(scenario.message)
      expect(row?.syncLockedAt).toBeNull()
      // 12 days are still edited
      expect(after.filter((p) => p.originalTime !== p.currentTime)).toHaveLength(12)
    })
  }
})

test.describe('E2E-33: Approved weeks cannot be pulled', () => {
  // The last completed week: ended (so it can be pulled once reopened) and always at the top of the week list,
  // which shows only the newest weeks, however many weeks the real data holds.
  const approvedWeek = completed.start

  test('an approved week has no Pull now; after Reopen it has', async ({ page }) => {
    const anita = await createEmployee({ employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' })
    const dev = await createEmployee({ employeeId: 'E2E-HLP-9004', employeeName: 'Dev Kapoor' })
    const day = { reg: 8, ot: 0 }
    await seedApiWeek({
      weekStartISO: approvedWeek,
      employees: [anita, dev],
      days: [Array(7).fill(day), Array(7).fill(day)],
      status: 'APPROVED',
    })

    await openAttendance(page)
    const row = weekRow(page, approvedWeek)
    await expect(row).toHaveAttribute('data-status', 'APPROVED')
    await expect(page.getByTestId(`pull-now-${approvedWeek}`)).toHaveCount(0)
    // The picker refuses it too
    await page.getByTestId('load-past-week-button').click()
    const pickerRow = page.getByTestId(`week-picker-row-${approvedWeek}`)
    for (let i = 0; i < 4 && !(await pickerRow.isVisible()); i++) {
      await page.getByRole('button', { name: 'Previous month' }).click()
    }
    await expect(pickerRow).toHaveAttribute('data-disabled', 'true')
    await page.keyboard.press('Escape')

    // Reopen from the week's view
    await page.getByTestId(`view-link-${approvedWeek}`).click()
    await expect(page.getByTestId('punch-review')).toHaveAttribute('data-locked', 'true')
    await page.getByTestId('reopen-week-button').click()
    await expect(page.getByTestId('reopen-week-dialog')).toBeVisible()
    await page.getByTestId('reopen-confirm').click()
    await expect(page.getByTestId('approve-week-button')).toBeVisible({ timeout: 15000 })
    expect((await getWeekRow(approvedWeek))?.status).toBe('REVIEW')

    await openAttendance(page)
    await expect(weekRow(page, approvedWeek)).toHaveAttribute('data-status', 'REVIEW')
    await expect(page.getByTestId(`pull-now-${approvedWeek}`)).toBeVisible()
  })
})

test.describe('E2E-34: Approve week waits until the week has ended', () => {
  test('the current week can be pulled and reviewed but not approved', async ({ page }) => {
    await seedEmployeesForSync()
    // A clean week: complete pairs only, every code matched
    setMockPunches(mockDay('9001', current.start, FULL_DAY))

    await openAttendance(page)
    await page.getByTestId(`pull-now-${current.start}`).click()
    await expect(weekRow(page, current.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await expect(weekRow(page, current.start).getByTestId('week-details')).toContainText('Can be approved from')

    await openReview(page, current.start)
    // No incomplete pairs, no codes to fix...
    await expect(page.getByTestId('filter-needs')).toContainText('0')
    await expect(page.getByTestId('approve-week-button')).toBeDisabled()
    // ...and the only reason is that the week has not ended
    await page.getByTestId('approve-week-button').locator('xpath=..').hover()
    await expect(page.getByTestId('approve-blockers')).toContainText("This week hasn't ended yet")
    await expect(page.getByTestId('approve-blockers')).not.toContainText('Needs fixing')
  })
})
