import { test, expect, type Page } from '@playwright/test'
import prisma, {
  baseGridEmployeeCount,
  cleanupTestData,
  createEmployee,
  getAttendanceRecordHours,
  getAuditRows,
  getPunchRows,
  getWeekRow,
} from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  FULL_DAY,
  mockDay,
  setMockPunches,
  weekDates,
} from '../utils/etimeoffice-mock'
import {
  approveButton,
  approveWeekInUi,
  cellText,
  closeEditor,
  dayCell,
  openAttendance,
  openDay,
  openReview,
  runCron,
  setPairField,
  settled,
  weekRow,
} from '../utils/attendance-ui'

const week = expectedCompletedWeek()
const dates = weekDates(week.start)

const ANITA = 'E2E-HLP-9001' // a full day with overtime
const DEV = 'E2E-HLP-9004' // merged scans
const GITA = 'E2E-HLP-9036' // two scans eleven minutes apart
const HARI = 'E2E-HLP-9100' // a single punch: needs fixing
const ISHAAN = 'E2E-HLP-9010' // a short day: unusual
const JAYA = 'E2E-HLP-9011' // no punches at all

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  clearMockScenario()
  await cleanupTestData()
  await createEmployee({ employeeId: ANITA, employeeName: 'Anita Rao' })
  await createEmployee({ employeeId: DEV, employeeName: 'Dev Kapoor' })
  await createEmployee({ employeeId: GITA, employeeName: 'Gita Pillai' })
  await createEmployee({ employeeId: HARI, employeeName: 'Hari Prasad' })
  await createEmployee({ employeeId: ISHAAN, employeeName: 'Ishaan Verma' })
  await createEmployee({ employeeId: JAYA, employeeName: 'Jaya Nair' })

  setMockPunches([
    ...mockDay('9001', dates[0], FULL_DAY),
    ...mockDay('9004', dates[0], ['07:40', '07:50', '13:00', '13:50', '17:45', '17:46']),
    ...mockDay('9036', dates[0], ['07:40', '07:51']),
    ...mockDay('9100', dates[1], ['18:26']),
    ...mockDay('9010', dates[0], ['08:00', '11:10']),
  ])
  const loaded = await runCron(request)
  expect(loaded.body).toMatchObject({ outcome: 'LOADED' })
  // The load marks Jaya inactive for having no punches (issue #35); these tests need her on the grid as active.
  await prisma.employee.update({ where: { employeeId: JAYA }, data: { isActive: true } })
})

test.afterAll(() => {
  clearMockScenario()
})

/** The count shown on a filter chip. */
async function filterCount(page: Page, filter: 'needs' | 'nopunch' | 'unusual'): Promise<number> {
  const text = (await page.getByTestId(`filter-${filter}`).innerText()).trim()
  return Number(text.match(/(\d+)\s*$/)?.[1])
}

test.describe('E2E-11: Punches pair in time order and hours calculate per day', () => {
  test('07:40, 13:04, 13:56, 17:47 show as two pairs with 8.00 regular and 1.25 overtime', async ({ page }) => {
    await openReview(page, week.start)
    const text = await cellText(page, ANITA, dates[0])
    expect(text).toContain('07:40–13:04')
    expect(text).toContain('13:56–17:47')
    expect(text).toContain('8.00')
    expect(text).toContain('+1.25')

    await openDay(page, ANITA, dates[0])
    await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('07:40')
    await expect(page.getByTestId('editor-pair-1-out')).toHaveValue('13:04')
    await expect(page.getByTestId('editor-pair-2-in')).toHaveValue('13:56')
    await expect(page.getByTestId('editor-pair-2-out')).toHaveValue('17:47')
    await expect(page.getByTestId('editor-day-regular')).toHaveText('8.00')
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.25')
    await expect(page.getByTestId('editor-day-total')).toHaveText('9.25')
    // The week total for the employee
    await expect(page.getByTestId(`week-total-${ANITA}`)).toContainText('8.00')
    await expect(page.getByTestId(`week-total-${ANITA}`)).toContainText('+1.25')
  })

  test('the stored rows are in pair order', async () => {
    const punches = await getPunchRows(week.start, { employeeCode: ANITA })
    expect(punches.map((p) => [p.pairIndex, p.position, p.currentTime])).toEqual([
      [0, 'IN', '07:40'],
      [0, 'OUT', '13:04'],
      [1, 'IN', '13:56'],
      [1, 'OUT', '17:47'],
    ])
  })
})

test.describe('E2E-12: Scans within 10 minutes merge', () => {
  test('Six scans become 4 punches, the day shows Merged and the original scans are kept', async ({ page }) => {
    const punches = await getPunchRows(week.start, { employeeCode: DEV })
    expect(punches.map((p) => p.currentTime)).toEqual(['07:40', '13:00', '13:50', '17:45'])
    // Every scan is still stored: the kept punch holds the scans it absorbed
    const all = punches.flatMap((p) => [p.originalTime, ...p.mergedScans]).sort()
    expect(all).toEqual(['07:40', '07:50', '13:00', '13:50', '17:45', '17:46'])
    expect(punches.find((p) => p.originalTime === '07:40')?.mergedScans).toEqual(['07:50'])
    expect(punches.find((p) => p.originalTime === '17:45')?.mergedScans).toEqual(['17:46'])

    await openReview(page, week.start)
    await expect(dayCell(page, DEV, dates[0])).toHaveAttribute('data-merged', 'true')
    const text = await cellText(page, DEV, dates[0])
    expect(text).toContain('07:40–13:00')
    expect(text).toContain('13:50–17:45')

    await openDay(page, DEV, dates[0])
    await expect(page.getByTestId('editor-merged')).toBeVisible()
    await expect(page.getByTestId('editor-merged')).toContainText('07:40 07:50')
    await expect(page.getByTestId('editor-merged')).toContainText('17:45 17:46')
  })
})

test.describe('E2E-13: Scans outside the window stay separate', () => {
  test('07:40 and 07:51 are two punches forming one complete pair', async ({ page }) => {
    const punches = await getPunchRows(week.start, { employeeCode: GITA })
    expect(punches.map((p) => p.currentTime)).toEqual(['07:40', '07:51'])
    expect(punches.every((p) => p.mergedScans.length === 0)).toBe(true)

    await openReview(page, week.start)
    await expect(dayCell(page, GITA, dates[0])).not.toHaveAttribute('data-merged', 'true')
    await expect(dayCell(page, GITA, dates[0])).not.toHaveAttribute('data-needs-fixing', 'true')
    expect(await cellText(page, GITA, dates[0])).toContain('07:40–07:51')
    await openDay(page, GITA, dates[0])
    await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('07:40')
    await expect(page.getByTestId('editor-pair-1-out')).toHaveValue('07:51')
    await expect(page.getByTestId('editor-merged')).toHaveCount(0)
    await expect(page.getByTestId('editor-day-regular')).toHaveText('0.18')
  })
})

test.describe('E2E-14: Incomplete pair blocks approval', () => {
  test('a lone punch needs fixing; adding an OUT time clears it and enables Approve week', async ({ page }) => {
    await openReview(page, week.start)
    await expect(dayCell(page, HARI, dates[1])).toHaveAttribute('data-needs-fixing', 'true')
    expect(await filterCount(page, 'needs')).toBe(1)
    await expect(approveButton(page)).toBeDisabled()

    await openDay(page, HARI, dates[1])
    await expect(page.getByTestId('editor-needs-fixing')).toBeVisible()
    await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('18:26')
    await setPairField(page, 1, 'out', '19:30')
    await expect(page.getByTestId('editor-needs-fixing')).toHaveCount(0)
    await expect(page.getByTestId('editor-day-regular')).toHaveText('1.07')
    await closeEditor(page)

    expect(await filterCount(page, 'needs')).toBe(0)
    await expect(approveButton(page)).toBeEnabled()
  })

  test('deleting the stray punch also clears it and leaves the day at zero hours', async ({ page }) => {
    await openReview(page, week.start)
    expect(await filterCount(page, 'needs')).toBe(1)
    await openDay(page, HARI, dates[1])
    await page.getByTestId('editor-pair-1-delete').click()
    await expect(page.getByTestId('editor-save-status')).toContainText('Saved', { timeout: 10000 })
    await expect(page.getByTestId('editor-needs-fixing')).toHaveCount(0)
    await expect(page.getByTestId('editor-day-regular')).toHaveText('0.00')
    await closeEditor(page)

    expect(await filterCount(page, 'needs')).toBe(0)
    await expect(approveButton(page)).toBeEnabled()
    // The API row is kept (deleted, not removed), so the audit trail has the original
    await settled(page)
    const row = (await getPunchRows(week.start, { employeeCode: HARI }))[0]
    expect(row.originalTime).toBe('18:26')
    expect(row.currentTime).toBeNull()
  })
})

test.describe('E2E-15: Unusual complete days do not block approval', () => {
  test('a 3:10 day is highlighted and Approve week stays enabled', async ({ page }) => {
    // Fix the one incomplete day so only the highlight is left
    await prisma.attendancePunch.updateMany({
      where: { attendanceUploadId: (await getWeekRow(week.start))!.id, employee: { employeeId: HARI } },
      data: { currentTime: null },
    })
    await openReview(page, week.start)
    const cell = dayCell(page, ISHAAN, dates[0])
    await expect(cell).toHaveAttribute('data-unusual', 'true')
    await expect(cell).not.toHaveAttribute('data-needs-fixing', 'true')
    expect(await cellText(page, ISHAAN, dates[0])).toContain('08:00–11:10')
    expect(await filterCount(page, 'unusual')).toBeGreaterThanOrEqual(1)
    expect(await filterCount(page, 'needs')).toBe(0)
    await expect(approveButton(page)).toBeEnabled()

    await openDay(page, ISHAAN, dates[0])
    await expect(page.getByTestId('editor-unusual')).toContainText('Under 4 hours')
    await expect(page.getByTestId('editor-day-regular')).toHaveText('3.17')
  })
})

test.describe('E2E-16: No-punch employees are shown and can be entered by hand', () => {
  test('Jaya has no punches, does not block approval, and gets paid for a hand-entered day', async ({ page }) => {
    // Settle the incomplete day first so approval is possible
    await prisma.attendancePunch.updateMany({
      where: { attendanceUploadId: (await getWeekRow(week.start))!.id, employee: { employeeId: HARI } },
      data: { currentTime: null },
    })
    await openReview(page, week.start)
    // Jaya, and Hari whose only punch was deleted above, plus every real active employee in the base: the grid
    // lists them all and none of them has punches in this test week
    const realNoPunch = await baseGridEmployeeCount(week.start)
    expect(await filterCount(page, 'nopunch')).toBe(realNoPunch + 2)
    await page.getByTestId('filter-nopunch').click()
    await expect(page.getByTestId(`employee-row-${JAYA}`)).toBeVisible()
    await expect(page.getByTestId(`employee-row-${HARI}`)).toBeVisible()
    await expect(page.locator('[data-testid^="employee-row-"]')).toHaveCount(realNoPunch + 2)
    await expect(approveButton(page)).toBeEnabled()

    await openDay(page, JAYA, dates[2])
    await setPairField(page, 1, 'in', '08:00', { expectSaved: false })
    await setPairField(page, 1, 'out', '16:00')
    await expect(page.getByTestId('editor-day-regular')).toHaveText('8.00')
    await closeEditor(page)
    // She now has punches, so she leaves the "No punches" filter
    expect(await filterCount(page, 'nopunch')).toBe(realNoPunch + 1)
    await page.getByTestId('filter-all').click()
    expect(await cellText(page, JAYA, dates[2])).toContain('8.00')

    await approveWeekInUi(page)
    const hours = await getAttendanceRecordHours(week.start, JAYA)
    expect(hours).toHaveLength(7)
    expect(hours.find((h) => h.date === dates[2])).toMatchObject({ regularHours: 8, overtimeHours: 0 })
    expect(hours.reduce((sum, h) => sum + h.regularHours, 0)).toBe(8)
  })
})

test.describe('E2E-18: Editing keeps the original time', () => {
  test('17:47 -> 18:00 with no note saves, recalculates, shows Edited and is audited', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 2, 'out', '18:00')

    // Hours recalculate immediately (9.47 total: 8.00 regular, 1.47 overtime)
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.47')
    await expect(page.getByTestId('editor-day-regular')).toHaveText('8.00')
    // The Changes section shows the original beside the current time, and a note is optional
    const changes = page.getByTestId('editor-changes')
    await expect(changes).toContainText('17:47')
    await expect(changes).toContainText('18:00')
    await closeEditor(page)
    await expect(dayCell(page, ANITA, dates[0])).toHaveAttribute('data-edited', 'true')
    expect(await cellText(page, ANITA, dates[0])).toContain('13:56–18:00')

    await settled(page)
    const stored = (await getPunchRows(week.start, { employeeCode: ANITA })).find((p) => p.position === 'OUT' && p.pairIndex === 1)!
    expect(stored.originalTime).toBe('17:47')
    expect(stored.currentTime).toBe('18:00')
    expect(stored.note).toBeNull()

    const audit = (await getAuditRows('ATTENDANCE_PUNCH')).at(-1)!
    expect(audit.actionType).toBe('UPDATE')
    expect(audit.createdAt.getTime()).toBeGreaterThan(Date.now() - 5 * 60 * 1000)
    const details = JSON.stringify(audit.detailsJson)
    expect(details).toContain('17:47')
    expect(details).toContain('18:00')
    expect(details).toContain(ANITA)
  })

  test('a note is stored when given', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 2, 'out', '18:00')
    const note = page.getByTestId('editor-note-1')
    await note.fill('Forgot to scan out')
    await note.press('Enter')
    await expect(page.getByTestId('editor-save-status')).toContainText('Saved')
    await settled(page)
    const stored = (await getPunchRows(week.start, { employeeCode: ANITA })).find((p) => p.currentTime === '18:00')!
    expect(stored.note).toBe('Forgot to scan out')
    expect(stored.originalTime).toBe('17:47')
  })

  test('typing the original time back clears the Edited marker', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 2, 'out', '18:00')
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.47')
    await setPairField(page, 2, 'out', '17:47')
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.25')
    await closeEditor(page)
    await expect(dayCell(page, ANITA, dates[0])).not.toHaveAttribute('data-edited', 'true')
  })
})

test.describe('E2E-19: Invalid pairs cannot be saved', () => {
  test('an OUT before its IN is rejected and the saved punches stay', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 1, 'out', '07:00', { expectSaved: false })
    await expect(page.getByTestId('editor-error')).toBeVisible()
    await expect(page.getByTestId('editor-error')).toContainText('Not saved')
    // The hours are still from the last saved times
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.25')
    await closeEditor(page)

    await settled(page)
    const stored = await getPunchRows(week.start, { employeeCode: ANITA })
    expect(stored.map((p) => p.currentTime)).toEqual(['07:40', '13:04', '13:56', '17:47'])
    expect(stored.every((p) => p.currentTime === p.originalTime)).toBe(true)
  })

  test('two overlapping pairs are rejected', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    // Pair 2 would start at 12:00, inside 07:40-13:04
    await setPairField(page, 2, 'in', '12:00', { expectSaved: false })
    await expect(page.getByTestId('editor-error')).toBeVisible()
    await closeEditor(page)

    await settled(page)
    const stored = await getPunchRows(week.start, { employeeCode: ANITA })
    expect(stored.map((p) => p.currentTime)).toEqual(['07:40', '13:04', '13:56', '17:47'])
  })

  test('a time that is not a time is rejected', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 1, 'in', '25:00', { expectSaved: false })
    await expect(page.getByTestId('editor-error')).toBeVisible()
    await closeEditor(page)
    await settled(page)
    expect((await getPunchRows(week.start, { employeeCode: ANITA })).map((p) => p.currentTime)).toEqual([
      '07:40', '13:04', '13:56', '17:47',
    ])
    // A rejected edit writes no audit entry
    expect(await getAuditRows('ATTENDANCE_PUNCH')).toHaveLength(0)
  })
})

test.describe('E2E-20: Edits survive leaving the page', () => {
  test('after leaving and returning the edit is still there and the week is still Ready for review', async ({ page }) => {
    await openReview(page, week.start)
    await openDay(page, ANITA, dates[0])
    await setPairField(page, 2, 'out', '18:00')
    await closeEditor(page)

    await openAttendance(page)
    await expect(weekRow(page, week.start)).toHaveAttribute('data-status', 'REVIEW')

    await openReview(page, week.start)
    await expect(page.getByTestId('punch-review')).toHaveAttribute('data-status', 'REVIEW')
    await expect(dayCell(page, ANITA, dates[0])).toHaveAttribute('data-edited', 'true')
    expect(await cellText(page, ANITA, dates[0])).toContain('13:56–18:00')
    await expect(page.getByTestId(`week-total-${ANITA}`)).toContainText('+1.47')
  })
})
