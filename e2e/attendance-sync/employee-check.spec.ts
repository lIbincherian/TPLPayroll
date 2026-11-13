import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupTestData,
  seedEmployeesForSync,
  getAttendanceRecordHours,
  getCodeExceptions,
  getDecisionRows,
  getPunchRows,
  getAuditRows,
  getWeekRow,
} from '../utils/db'
import {
  clearMockScenario,
  expectedCompletedWeek,
  expectedCurrentWeek,
  FULL_DAY,
  mockDay,
  mockDays,
  setMockPunches,
  weekDates,
  type MockPunchRow,
} from '../utils/etimeoffice-mock'
import { approveWeekInUi, openAttendance, openReview, pullWeekFromList, runCron, settled, weekRow } from '../utils/attendance-ui'

const week = expectedCompletedWeek()
const dates = weekDates(week.start)
const current = expectedCurrentWeek()

test.describe.configure({ mode: 'serial' })

/**
 * The punches eTimeOffice returns for the week:
 *  9036 -> E2E-HLP-9036 (matched on the number; the name is not used)
 *  9999 -> nobody, but it carries the NAME of an existing employee (a name must never match)
 *  9007 -> E2E-HLP-9007 and E2E-SUP-9007 (duplicate)
 *  9100 -> E2E-HLP-9100 (four digits)
 *  9002 -> E2E-HLP-9002, inactive; 9003 -> E2E-HLP-9003, resigned before the week
 */
function weekScans(extra: MockPunchRow[] = []): MockPunchRow[] {
  return [
    ...mockDay('9036', dates[0], FULL_DAY, 'Empname9036'),
    ...mockDays('9999', [dates[0], dates[1]], ['08:00', '12:00'], 'Gita Pillai'),
    ...mockDay('9007', dates[0], FULL_DAY, 'Empname9007'),
    ...mockDay('9100', dates[0], ['08:00', '16:00'], 'Empname9100'),
    ...mockDay('9002', dates[0], ['08:00', '16:00'], 'Empname9002'),
    ...mockDay('9003', dates[1], ['08:00', '16:00'], 'Empname9003'),
    ...extra,
  ]
}

async function loadWeek(request: Parameters<typeof runCron>[0], extra: MockPunchRow[] = []) {
  setMockPunches(weekScans(extra))
  const result = await runCron(request)
  expect(result.body).toMatchObject({ outcome: 'LOADED' })
}

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
  await seedEmployeesForSync()
})

test.afterAll(() => {
  clearMockScenario()
})

async function openEmployeeCheck(page: Page, weekStart = week.start) {
  await settled(page)
  await page.goto(`/attendance/${weekStart}/employee-check`)
  await expect(page.getByTestId('employee-check')).toBeVisible({ timeout: 15000 })
}

/** Search by Employee ID: the picker lists at most 30 matches, and a name like "Dev" also matches real employees. */
async function chooseExistingEmployee(page: Page, code: string, employeeId: string) {
  const input = page.getByTestId(`match-existing-${code}`)
  await input.click()
  await input.fill(employeeId)
  await page.getByTestId(`match-existing-${code}-option-${employeeId}`).click()
}

test.describe('E2E-07: Employee code matches on number', () => {
  test('9036 is linked to E2E-HLP-9036 and the name plays no part', async ({ request }) => {
    await loadWeek(request)
    const punches = await getPunchRows(week.start, { empCode: '9036' })
    expect(punches).toHaveLength(4)
    expect(new Set(punches.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9036']))
    expect(new Set(punches.map((p) => p.matchStatus))).toEqual(new Set(['MATCHED']))

    // 9999 arrives with the name of an existing employee ("Gita Pillai" is E2E-HLP-9036) and is NOT linked to them
    const unknown = await getPunchRows(week.start, { empCode: '9999' })
    expect(unknown.length).toBeGreaterThan(0)
    expect(new Set(unknown.map((p) => p.employeeCode))).toEqual(new Set([null]))
    expect(new Set(unknown.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
  })
})

test.describe('E2E-09: Four-digit codes match in full', () => {
  test('9100 is linked to the employee whose ID ends in 9100, not to one ending in 100 or 910', async ({ request }) => {
    await loadWeek(request)
    const punches = await getPunchRows(week.start, { empCode: '9100' })
    expect(punches).toHaveLength(2)
    expect(new Set(punches.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9100']))
    expect(new Set(punches.map((p) => p.matchStatus))).toEqual(new Set(['MATCHED']))
  })
})

test.describe('E2E-08: Unknown or duplicate code stops at the employee check', () => {
  test('both codes are listed with eTimeOffice names, and the punch review cannot be opened', async ({ request, page }) => {
    await loadWeek(request)

    await openAttendance(page)
    const row = weekRow(page, week.start)
    await expect(row.getByTestId('week-details')).toContainText('2 codes to fix')
    await row.getByTestId(`review-link-${week.start}`).click()
    // A week with codes to fix opens the employee check, not the grid
    await expect(page).toHaveURL(new RegExp(`/attendance/${week.start}/employee-check$`))

    const unknown = page.getByTestId('code-row-9999')
    await expect(unknown).toHaveAttribute('data-status', 'UNKNOWN')
    await expect(unknown).toContainText('Gita Pillai')
    await expect(unknown).toContainText('Matches no employee')
    await expect(unknown.getByTestId('add-new-employee-9999')).toBeVisible()

    const duplicate = page.getByTestId('code-row-9007')
    await expect(duplicate).toHaveAttribute('data-status', 'DUPLICATE')
    await expect(duplicate).toContainText('Empname9007')
    await expect(duplicate).toContainText('Matches 2 employees')
    await expect(duplicate.getByTestId('edit-id-E2E-HLP-9007')).toBeVisible()
    await expect(duplicate.getByTestId('edit-id-E2E-SUP-9007')).toBeVisible()

    await expect(page.getByTestId('summary-unknown')).toHaveText('1')
    await expect(page.getByTestId('summary-duplicate')).toHaveText('1')
    // No guess: nothing was applied to either code
    await settled(page)
    expect((await getPunchRows(week.start, { empCode: '9999' })).every((p) => p.employeeCode === null)).toBe(true)
    expect((await getPunchRows(week.start, { empCode: '9007' })).every((p) => p.employeeCode === null)).toBe(true)

    // The review cannot be reached while a code is unresolved
    await expect(page.getByTestId('employee-check-continue')).toHaveAttribute('aria-disabled', 'true')
    await page.goto(`/attendance/${week.start}/review`)
    await expect(page).toHaveURL(new RegExp(`/attendance/${week.start}/employee-check$`))
    await expect(page.getByTestId('punch-review')).toHaveCount(0)
  })
})

test.describe('E2E-10: Inactive and resigned employees need a decision', () => {
  test('a rejected employee is left out of the week, an approved one is paid', async ({ request, page }) => {
    await loadWeek(request)
    // The pull reactivates an inactive employee with punches (issue #35); set them inactive again to test the decision.
    await prisma.employee.update({ where: { employeeId: 'E2E-HLP-9002' }, data: { isActive: false } })
    await openEmployeeCheck(page)

    // Both appear with Approve and Reject
    for (const code of ['E2E-HLP-9002', 'E2E-HLP-9003']) {
      const row = page.getByTestId(`decision-row-${code}`)
      await expect(row).toHaveAttribute('data-decision', 'NONE')
      await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible()
      await expect(row.getByRole('button', { name: 'Reject' })).toBeVisible()
    }
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toContainText('Inactive')
    await expect(page.getByTestId('decision-row-E2E-HLP-9003')).toContainText('Resigned')
    // An inactive employee WITHOUT punches never appears
    await expect(page.getByTestId('summary-decisions-left')).toHaveText('2')

    await page.getByTestId('decision-reject-E2E-HLP-9002').click()
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toHaveAttribute('data-decision', 'REJECTED')
    await page.getByTestId('decision-approve-E2E-HLP-9003').click()
    await expect(page.getByTestId('decision-row-E2E-HLP-9003')).toHaveAttribute('data-decision', 'APPROVED')
    await expect(page.getByTestId('summary-decisions-left')).toHaveText('0')
    await settled(page)
    expect(await getDecisionRows(week.start)).toEqual(
      expect.arrayContaining([
        { employeeCode: 'E2E-HLP-9002', reason: 'INACTIVE', decision: 'REJECTED' },
        { employeeCode: 'E2E-HLP-9003', reason: 'RESIGNED_BEFORE_WEEK', decision: 'APPROVED' },
      ]),
    )

    // Settle the two unresolved codes so the week can be approved
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-always-9999').click()
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await chooseExistingEmployee(page, '9007', 'E2E-HLP-9007')
    await expect(page.getByTestId('code-row-9007')).toHaveCount(0)
    await expect(page.getByTestId('employee-check-resolved')).toBeVisible()

    // Approved employee is in the grid (tagged), rejected one is not
    await page.getByTestId('employee-check-continue').click()
    await expect(page.getByTestId('punch-review')).toBeVisible()
    await expect(page.getByTestId('employee-row-E2E-HLP-9003')).toBeVisible()
    await expect(page.getByTestId('employee-tag-E2E-HLP-9003')).toHaveText('Resigned')
    await expect(page.getByTestId('employee-row-E2E-HLP-9002')).toHaveCount(0)

    // The approval summary lists the rejected employee as left out; approving writes no hours for them
    await page.getByTestId('approve-week-button').click()
    await expect(page.getByTestId('approval-employees')).not.toHaveText('')
    await expect(page.getByTestId('left-out-E2E-HLP-9002')).toContainText('Rejected in employee check')
    await page.getByTestId('approve-cancel').click()
    await approveWeekInUi(page)

    await settled(page)
    expect(await getAttendanceRecordHours(week.start, 'E2E-HLP-9002')).toHaveLength(0)
    const resigned = await getAttendanceRecordHours(week.start, 'E2E-HLP-9003')
    expect(resigned.reduce((sum, r) => sum + r.regularHours, 0)).toBe(8)
  })
})

test.describe('E2E-35: Unknown code can be added as a new employee', () => {
  test('creating the employee returns to the check and the code is linked to them', async ({ request, page }) => {
    await loadWeek(request)
    await openEmployeeCheck(page)

    await page.getByTestId('add-new-employee-9999').click()
    await expect(page).toHaveURL(/\/employees\/new\?/)
    const url = new URL(page.url())
    expect(url.searchParams.get('returnTo')).toBe(`/attendance/${week.start}/employee-check`)
    expect(url.searchParams.get('code')).toBe('9999')

    // Form is prefilled with the name eTimeOffice has, a hint explains the ID, and there is a way back
    await expect(page.getByPlaceholder('Lakshmi Venkatesh')).toHaveValue('Gita Pillai')
    await expect(page.getByTestId('employee-id-hint')).toContainText('9999')
    await expect(page.getByRole('button', { name: /Return to employee check/ })).toBeVisible()

    await page.getByPlaceholder('EMP-042').fill('E2E-HLP-9999')
    await page.getByPlaceholder('Guard').first().fill('Security Guard')
    await page.getByPlaceholder('14375').fill('14375')
    await page.getByPlaceholder('68.75').fill('68.75')
    await page.getByRole('button', { name: 'Save Employee' }).click()

    // Back on the employee check, with the code matched again
    await expect(page).toHaveURL(new RegExp(`/attendance/${week.start}/employee-check$`), { timeout: 15000 })
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0, { timeout: 15000 })
    await expect(page.getByTestId('employee-check')).toBeVisible()

    await settled(page)
    const punches = await getPunchRows(week.start, { empCode: '9999' })
    expect(punches.length).toBeGreaterThan(0)
    expect(new Set(punches.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9999']))
    expect(new Set(punches.map((p) => p.matchStatus))).toEqual(new Set(['MATCHED']))
  })

  test('a typo in the new ID leaves the code unresolved', async ({ request, page }) => {
    await loadWeek(request)
    await openEmployeeCheck(page)
    await page.getByTestId('add-new-employee-9999').click()
    await page.getByPlaceholder('EMP-042').fill('E2E-HLP-9099')
    await page.getByPlaceholder('Guard').first().fill('Security Guard')
    await page.getByPlaceholder('14375').fill('14375')
    await page.getByPlaceholder('68.75').fill('68.75')
    await page.getByRole('button', { name: 'Save Employee' }).click()

    await expect(page).toHaveURL(new RegExp(`/attendance/${week.start}/employee-check$`), { timeout: 15000 })
    // Still unresolved: 099 is not 999
    await expect(page.getByTestId('code-row-9999')).toBeVisible()
    await settled(page)
    expect((await getPunchRows(week.start, { empCode: '9999' })).every((p) => p.employeeCode === null)).toBe(true)
  })
})

test.describe('E2E-36: Unknown code can be matched and the link is saved', () => {
  test('the punches follow the chosen employee, and later pulls apply the saved link', async ({ request, page }) => {
    await loadWeek(request, mockDay('9999', current.start, ['08:00', '16:00'], 'Empname9999'))
    await openEmployeeCheck(page)

    await chooseExistingEmployee(page, '9999', 'E2E-HLP-9004')
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await expect(page.getByText('Saved for future weeks too.')).toBeVisible()

    await settled(page)
    const punches = await getPunchRows(week.start, { empCode: '9999' })
    expect(new Set(punches.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9004']))
    expect(await getCodeExceptions()).toEqual([{ empCode: '9999', kind: 'MATCH', employeeCode: 'E2E-HLP-9004' }])

    // The same week is pulled again (scheduled sync replaces an unedited pull): the link applies without asking
    const again = await runCron(request)
    expect(again.body).toMatchObject({ outcome: 'LOADED' })
    await settled(page)
    const afterPull = await getPunchRows(week.start, { empCode: '9999' })
    expect(new Set(afterPull.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9004']))
    await openEmployeeCheck(page)
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)

    // A later week is pulled from the list: still no question
    await openAttendance(page)
    await page.getByTestId(`pull-now-${current.start}`).click()
    await expect(weekRow(page, current.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await settled(page)
    const later = await getPunchRows(current.start, { empCode: '9999' })
    expect(later).toHaveLength(2)
    expect(new Set(later.map((p) => p.employeeCode))).toEqual(new Set(['E2E-HLP-9004']))
    await openEmployeeCheck(page, current.start)
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
  })

  test('the audit log records the match', async ({ request, page }) => {
    await loadWeek(request)
    await openEmployeeCheck(page)
    await chooseExistingEmployee(page, '9999', 'E2E-HLP-9004')
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await settled(page)
    const audit = await getAuditRows('ATTENDANCE_CODE')
    expect(audit.length).toBeGreaterThan(0)
    expect(JSON.stringify(audit.at(-1)?.detailsJson)).toContain('9999')
  })
})

test.describe('E2E-37: Unknown code can be ignored and the choice is saved', () => {
  test('ignored for every week: punches are left out of review and payroll, and the code stays ignored', async ({ request, page }) => {
    await loadWeek(request, mockDay('9999', current.start, ['08:00', '16:00'], 'Empname9999'))
    await openEmployeeCheck(page)

    await page.getByTestId('ignore-code-9999').click()
    // A confirmation first: ignoring leaves the punches out of payroll, for this week or for every week
    await expect(page.getByTestId('ignore-week-9999')).toBeVisible()
    await expect(page.getByTestId('ignore-always-9999')).toBeVisible()
    await page.getByTestId('cancel-ignore-9999').click()
    await expect(page.getByTestId('code-row-9999')).toBeVisible()
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-always-9999').click()

    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()
    await expect(page.getByTestId('ignored-scope-9999')).toHaveText('Every week')
    await settled(page)
    expect(await getCodeExceptions()).toEqual([{ empCode: '9999', kind: 'IGNORE', employeeCode: null }])
    const punches = await getPunchRows(week.start, { empCode: '9999' })
    expect(new Set(punches.map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))
    expect(new Set(punches.map((p) => p.employeeCode))).toEqual(new Set([null]))

    // Not in the review grid
    await settleOthers(page)
    await openReview(page, week.start)
    await expect(page.getByTestId('punch-review')).toBeVisible()
    await expect(page.locator('[data-testid^="employee-row-"]')).not.toHaveCount(0)
    await expect(page.getByText('Empname9999')).toHaveCount(0)

    // A later pull ignores it without asking
    await openAttendance(page)
    await page.getByTestId(`pull-now-${current.start}`).click()
    await expect(weekRow(page, current.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await settled(page)
    const later = await getPunchRows(current.start, { empCode: '9999' })
    expect(later).toHaveLength(2)
    expect(new Set(later.map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))
    await openEmployeeCheck(page, current.start)
    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()

    // After approval nothing is paid for it
    await openEmployeeCheck(page)
    await page.getByTestId('employee-check-continue').click()
    await approveWeekInUi(page)
    // 036, 1000, 007, 002 and 003 each worked one 8-hour day (036 and 007 with 1.25 h overtime);
    // the 2 x 4 hours of the ignored code are in nobody's hours
    await settled(page)
    const records = await getAttendanceRecordHours(week.start)
    expect(records.reduce((sum, r) => sum + r.regularHours, 0)).toBe(40)
    expect(records.reduce((sum, r) => sum + r.overtimeHours, 0)).toBe(2.5)
  })

  test('ignored for this week only: nothing is saved for later, a later week and a re-pull ask about the code again', async ({ request, page }) => {
    await loadWeek(request, mockDay('9999', current.start, ['08:00', '16:00'], 'Empname9999'))
    await openEmployeeCheck(page)

    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-week-9999').click()

    await expect(page.getByTestId('code-row-9999')).toHaveCount(0)
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()
    await expect(page.getByTestId('ignored-scope-9999')).toHaveText('This week only')
    await expect(toast(page, 'Code 9999 ignored for this week')).toBeVisible()
    await settled(page)
    expect(await getCodeExceptions()).toEqual([])
    const ignored = await getPunchRows(week.start, { empCode: '9999' })
    expect(new Set(ignored.map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))
    expect(new Set(ignored.map((p) => p.employeeCode))).toEqual(new Set([null]))

    // A later week is pulled: the code is asked about again
    await openAttendance(page)
    await page.getByTestId(`pull-now-${current.start}`).click()
    await expect(weekRow(page, current.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await settled(page)
    const later = await getPunchRows(current.start, { empCode: '9999' })
    expect(later).toHaveLength(2)
    expect(new Set(later.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
    await openEmployeeCheck(page, current.start)
    await expect(page.getByTestId('code-row-9999')).toBeVisible()
    await expect(page.getByTestId('ignored-code-9999')).toHaveCount(0)

    // Pull now on the week where it was ignored: the warning counts the code, and Cancel keeps it ignored
    await openAttendance(page)
    await page.getByTestId(`pull-now-${week.start}`).click()
    await expect(page.getByTestId('pull-warning-dialog')).toBeVisible()
    await expect(page.getByTestId('pull-warning-text')).toHaveText('This will discard 1 code ignored for this week.')
    await page.getByTestId('pull-warning-cancel').click()
    await expect(page.getByTestId('pull-warning-dialog')).toBeHidden()
    await settled(page)
    const kept = await getPunchRows(week.start, { empCode: '9999' })
    expect(new Set(kept.map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))

    // Confirm: the week is replaced, the toast says what was discarded, and the code is a code to fix again
    await pullWeekFromList(page, week.start, { confirmDiscard: true })
    await expect(toast(page, /Discarded 1 code ignored for this week/)).toBeVisible({ timeout: 20000 })
    await settled(page)
    const again = await getPunchRows(week.start, { empCode: '9999' })
    expect(again.length).toBeGreaterThan(0)
    expect(new Set(again.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
    expect(await getCodeExceptions()).toEqual([])
    await openEmployeeCheck(page)
    await expect(page.getByTestId('code-row-9999')).toHaveAttribute('data-status', 'UNKNOWN')
    await expect(page.getByTestId('ignored-code-9999')).toHaveCount(0)
  })

  test('ignored for every week, then stopped after confirming: the code is back under Codes to fix, and later pulls ask about it', async ({ request, page }) => {
    await loadWeek(request, mockDay('9999', current.start, ['08:00', '16:00'], 'Empname9999'))
    await openEmployeeCheck(page)
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-always-9999').click()
    await expect(page.getByTestId('ignored-scope-9999')).toHaveText('Every week')
    await settled(page)
    expect(await getCodeExceptions()).toEqual([{ empCode: '9999', kind: 'IGNORE', employeeCode: null }])

    // Stopping an every-week ignore asks first, and Cancel changes nothing
    await page.getByTestId('unignore-9999').click()
    await expect(page.getByRole('alertdialog', { name: 'Stop ignoring code 9999' })).toContainText('Stop ignoring 9999 in future weeks too?')
    await page.getByTestId('cancel-unignore-9999').click()
    await expect(page.getByTestId('confirm-unignore-9999')).toHaveCount(0)
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()
    await settled(page)
    expect(await getCodeExceptions()).toHaveLength(1)
    expect(new Set((await getPunchRows(week.start, { empCode: '9999' })).map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))

    // Confirm: the code is a code to fix again, with its punches, and the saved ignore is gone
    await page.getByTestId('unignore-9999').click()
    await page.getByTestId('confirm-unignore-9999').click()
    await expect(page.getByTestId('code-row-9999')).toHaveAttribute('data-status', 'UNKNOWN')
    await expect(page.getByTestId('code-row-9999')).toContainText('Gita Pillai')
    await expect(page.getByTestId('ignored-code-9999')).toHaveCount(0)
    await expect(toast(page, 'Code 9999 is back under Codes to fix')).toBeVisible()
    await expect(page.getByTestId('summary-unknown')).toHaveText('1') // 9999 is the only unknown code of the week
    await settled(page)
    expect(await getCodeExceptions()).toEqual([])
    const back = await getPunchRows(week.start, { empCode: '9999' })
    expect(back.length).toBeGreaterThan(0)
    expect(new Set(back.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
    expect(new Set(back.map((p) => p.employeeCode))).toEqual(new Set([null]))
    const audit = (await getAuditRows('ATTENDANCE_CODE', 'DELETE')).at(-1)
    expect(JSON.stringify(audit?.detailsJson)).toContain('"undoneScope":"ALWAYS"')

    // A later pull no longer skips the code
    await openAttendance(page)
    await page.getByTestId(`pull-now-${current.start}`).click()
    await expect(weekRow(page, current.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await settled(page)
    const later = await getPunchRows(current.start, { empCode: '9999' })
    expect(later).toHaveLength(2)
    expect(new Set(later.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
    await openEmployeeCheck(page, current.start)
    await expect(page.getByTestId('code-row-9999')).toBeVisible()
  })

  test('stopping a week-only ignore needs no confirmation: the code is back under Codes to fix at once', async ({ request, page }) => {
    await loadWeek(request)
    await openEmployeeCheck(page)
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-week-9999').click()
    await expect(page.getByTestId('ignored-scope-9999')).toHaveText('This week only')

    await page.getByTestId('unignore-9999').click()

    await expect(page.getByTestId('code-row-9999')).toHaveAttribute('data-status', 'UNKNOWN')
    await expect(page.getByTestId('confirm-unignore-9999')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByTestId('ignored-code-9999')).toHaveCount(0)
    await expect(toast(page, 'Code 9999 is back under Codes to fix')).toBeVisible()
    await settled(page)
    expect(await getCodeExceptions()).toEqual([])
    const punches = await getPunchRows(week.start, { empCode: '9999' })
    expect(punches).toHaveLength(4) // 9999 has two scans on each of two days
    expect(new Set(punches.map((p) => p.matchStatus))).toEqual(new Set(['UNKNOWN']))
  })

  test('the pull warning lists a week-ignored code beside the employee decisions', async ({ request, page }) => {
    await loadWeek(request)
    // The pull reactivates an inactive employee with punches (issue #35); set them inactive again to test the decision.
    await prisma.employee.update({ where: { employeeId: 'E2E-HLP-9002' }, data: { isActive: false } })
    await openEmployeeCheck(page)
    await page.getByTestId('decision-reject-E2E-HLP-9002').click()
    await expect(page.getByTestId('decision-row-E2E-HLP-9002')).toHaveAttribute('data-decision', 'REJECTED')
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-week-9999').click()
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()
    await settled(page)

    await openAttendance(page)
    await page.getByTestId(`pull-now-${week.start}`).click()

    await expect(page.getByTestId('pull-warning-text')).toHaveText(
      'This will discard your employee decisions and 1 code ignored for this week.',
    )
    await page.getByTestId('pull-warning-cancel').click()
    await settled(page)
    expect(await getDecisionRows(week.start)).toHaveLength(1)
  })

  test('the scheduled sync leaves a week with a week-only ignore alone, and replaces one that only has an every-week ignore', async ({ request, page }) => {
    await loadWeek(request)
    await openEmployeeCheck(page)
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-week-9999').click()
    await expect(page.getByTestId('ignored-code-9999')).toBeVisible()
    await settled(page)

    const skipped = await runCron(request)
    expect(skipped.body).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS' })
    await settled(page)
    expect(new Set((await getPunchRows(week.start, { empCode: '9999' })).map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))
    expect((await getWeekRow(week.start))?.staleNoticeAt).not.toBeNull()

    // Stop ignoring for this week only, then ignore for every week: nothing is lost by a pull any more
    await page.getByTestId('unignore-9999').click()
    await expect(page.getByTestId('code-row-9999')).toBeVisible()
    await page.getByTestId('ignore-code-9999').click()
    await page.getByTestId('ignore-always-9999').click()
    await expect(page.getByTestId('ignored-scope-9999')).toHaveText('Every week')
    await settled(page)

    const replaced = await runCron(request)
    expect(replaced.body).toMatchObject({ outcome: 'LOADED' })
    await settled(page)
    expect(new Set((await getPunchRows(week.start, { empCode: '9999' })).map((p) => p.matchStatus))).toEqual(new Set(['IGNORED']))
    expect(await getCodeExceptions()).toEqual([{ empCode: '9999', kind: 'IGNORE', employeeCode: null }])
  })
})

/** A sonner toast with this text. */
function toast(page: Page, text: RegExp | string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first()
}

/** Resolve the other open items of the week (duplicate code, decisions) so the review opens. */
async function settleOthers(page: Page) {
  await openEmployeeCheck(page)
  if (await page.getByTestId('code-row-9007').isVisible()) {
    await chooseExistingEmployee(page, '9007', 'E2E-HLP-9007')
    await expect(page.getByTestId('code-row-9007')).toHaveCount(0)
  }
  for (const code of ['E2E-HLP-9002', 'E2E-HLP-9003']) {
    const approve = page.getByTestId(`decision-approve-${code}`)
    if (await approve.isVisible()) {
      await approve.click()
      await expect(page.getByTestId(`decision-row-${code}`)).toHaveAttribute('data-decision', 'APPROVED')
    }
  }
  await expect(page.getByTestId('employee-check-resolved')).toBeVisible()
}
