import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupTestData,
  seedApprovedPayrollForCorrection,
  getAttendanceRecordHours,
  getAuditRows,
  getCorrectionSessions,
  getPayrollRunStatus,
  getPunchRows,
  getRevisionEmployees,
  getRevisions,
  getWeekRow,
} from '../utils/db'
import { clearMockScenario, mockDay, setMockPunches } from '../utils/etimeoffice-mock'
import { closeEditor, openDay, setPairField, settled } from '../utils/attendance-ui'

// Payroll correction (F08), reworked by F12: attendance is corrected in the punch grid, the current
// revision stays in effect until the new one is approved, and no file upload is involved.
//
// Seed: week 17-23 Apr 2025, revision 1 current.
//   Anita Sharma  E2E-COR-9001  46 regular + 6 overtime hours (Thursday 17 Apr: 08:00-18:00, 8 + 2)
//   Rajesh Iyer   E2E-COR-9002  56 regular hours

const WEEK = '2025-04-17'
const ANITA = 'E2E-COR-9001'
const RAJESH = 'E2E-COR-9002'

let payrollRunId: string
let revisionId: string

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
  const seed = await seedApprovedPayrollForCorrection()
  payrollRunId = seed.payrollRunId
  revisionId = seed.revisionId
})

test.afterAll(() => {
  clearMockScenario()
})

async function beginCorrection(page: Page) {
  await settled(page)
  await page.goto(`/payroll/run/${payrollRunId}`)
  await page.getByRole('button', { name: 'Correct', exact: true }).click()
  await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })
}

/** Start an attendance correction (reason optional) and land on the punch grid. */
async function startAttendanceCorrection(page: Page, reason?: string) {
  await beginCorrection(page)
  if (reason) await page.fill('#correction-reason', reason)
  await page.locator('label:has-text("Attendance")').click()
  await page.getByRole('button', { name: /Continue to punches/ }).click()
  await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('punch-review')).toHaveAttribute('data-mode', 'CORRECTION')
}

/** Change Anita's Thursday OUT from 18:00 to 19:00 (11 hours: overtime 2 -> 3). */
async function editAnitaThursday(page: Page) {
  await openDay(page, ANITA, WEEK)
  await setPairField(page, 1, 'out', '19:00')
  await expect(page.getByTestId('editor-day-overtime')).toHaveText('3.00')
  await closeEditor(page)
}

async function approvePunchesInUi(page: Page) {
  await expect(page.getByTestId('approve-week-button')).toHaveText('Approve punches')
  await page.getByTestId('approve-week-button').click()
  await expect(page.getByTestId('approval-employees')).not.toHaveText('', { timeout: 10000 })
  await page.getByTestId('approve-confirm').click()
  await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
}

async function approveRevisionInUi(page: Page) {
  await page.getByRole('button', { name: 'Approve Revision' }).click()
  await page.getByRole('button', { name: 'Confirm Revision' }).click()
  await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
}

test.describe('Payroll run page', () => {
  test('shows the Correct button and the Approved (Revision 1) badge', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Approved (Revision 1)')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Correct', exact: true })).toBeVisible()
    // The old button label is gone
    await expect(page.getByRole('button', { name: 'Correct Payroll' })).toHaveCount(0)
    await expect(page.locator('text=Anita Sharma')).toBeVisible()
    await expect(page.locator('text=Rajesh Iyer')).toBeVisible()
    // The week's attendance is one click away
    await expect(page.locator(`main a[href="/attendance/${WEEK}/review"]`)).toHaveText('Attendance')
  })

  test('the correction page offers no file upload', async ({ page }) => {
    await beginCorrection(page)
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
    await expect(page.getByText('Attendance', { exact: false }).first()).toBeVisible()
    await expect(page.locator('label:has-text("Attendance")')).toContainText("Edit this week's punches")
    // Primary button changes with the selection
    await expect(page.getByRole('button', { name: /Recalculate/ })).toBeVisible()
    await page.locator('label:has-text("Attendance")').click()
    await expect(page.getByRole('button', { name: /Continue to punches/ })).toBeVisible()
  })
})

test.describe('E2E-24: Correct an approved week', () => {
  test('revision 1 stays current during the edit; approving punches then the revision creates revision 2', async ({ page }) => {
    // The API must not be called: if it were, the live punches would be replaced by this
    setMockPunches(mockDay('9001', WEEK, ['09:00', '10:00'], 'Anita Sharma'))

    await startAttendanceCorrection(page) // reason left blank
    await expect(page.getByTestId('correction-banner')).toBeVisible()
    await editAnitaThursday(page)

    // During the edit nothing changes in the approved data
    await settled(page)
    expect(await getRevisions(payrollRunId)).toMatchObject([{ revisionNumber: 1, status: 'APPROVED', isCurrent: true }])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({
      regularHours: 8,
      overtimeHours: 2,
    })
    const live = await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK })
    expect(live.map((p) => p.currentTime)).toEqual(['08:00', '18:00'])

    // Approve the punches: the preview shows revision 2 while revision 1 is still current
    await approvePunchesInUi(page)
    await expect(page.locator('text=Revision 1 stays current until you approve')).toBeVisible()
    await settled(page)
    const draft = await getRevisions(payrollRunId)
    expect(draft).toMatchObject([
      { revisionNumber: 1, status: 'APPROVED', isCurrent: true },
      { revisionNumber: 2, status: 'DRAFT', isCurrent: false, correctionReason: null },
    ])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')

    // Approve the revised payroll
    await approveRevisionInUi(page)
    await settled(page)
    const after = await getRevisions(payrollRunId)
    expect(after).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED', isCurrent: false },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true, correctionReason: null },
    ])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('REVISED')

    // Revision 2 carries the corrected hours: 7 overtime hours for Anita
    const anita = (await getRevisionEmployees(after[1].id)).find((e) => e.employeeCode === ANITA)!
    expect(anita.regularHours).toBe(46)
    expect(anita.overtimeHours).toBe(7)
    expect((await getRevisionEmployees(after[0].id)).find((e) => e.employeeCode === ANITA)!.overtimeHours).toBe(6)

    // The approved attendance and live punches now hold the correction; the API original stays
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({
      regularHours: 8,
      overtimeHours: 3,
    })
    const corrected = await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK })
    expect(corrected.find((p) => p.position === 'OUT')).toMatchObject({ originalTime: '18:00', currentTime: '19:00' })
    expect((await getWeekRow(WEEK))?.status).toBe('APPROVED')
    // No leftover clone rows
    const sessions = await getCorrectionSessions(payrollRunId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].status).toBe('APPLIED')
    expect(await getPunchRows(WEEK, { correctionId: sessions[0].id })).toHaveLength(0)

    // The API was not called: the pulled-looking punches never replaced the week
    expect(await getAuditRows('ATTENDANCE_WEEK', 'PULL')).toHaveLength(0)
    expect(await getAuditRows('ATTENDANCE_WEEK', 'SYNC')).toHaveLength(0)

    // Revision history shows both, and the run reads Revision 2
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Approved (Revision 2)')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=Revision History')).toBeVisible()
    await expect(page.getByText('Current', { exact: true })).toBeVisible()
    await expect(page.getByText('Superseded', { exact: true })).toBeVisible()
  })

  test('a reason typed on the first step is stored on the new revision', async ({ page }) => {
    await startAttendanceCorrection(page, 'Wrong OUT time for E2E-COR-9001')
    await expect(page.getByTestId('correction-reason')).toContainText('Wrong OUT time for E2E-COR-9001')
    await editAnitaThursday(page)
    await approvePunchesInUi(page)
    await approveRevisionInUi(page)
    await settled(page)
    const revisions = await getRevisions(payrollRunId)
    expect(revisions[1].correctionReason).toBe('Wrong OUT time for E2E-COR-9001')
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Wrong OUT time for E2E-COR-9001')).toBeVisible({ timeout: 10000 })
  })

  test('punches with an incomplete pair cannot be approved in a correction', async ({ page }) => {
    await startAttendanceCorrection(page)
    await openDay(page, ANITA, WEEK)
    // Leave only the IN of the pair: a punch without a pair
    await page.getByTestId('editor-pair-1-out-clear').click()
    await expect(page.getByTestId('editor-needs-fixing')).toBeVisible({ timeout: 10000 })
    await closeEditor(page)
    await expect(page.getByTestId('approve-week-button')).toBeDisabled()
    await settled(page)
    expect(await getRevisions(payrollRunId)).toHaveLength(1)
  })

  test('an open correction can be resumed from the run page', async ({ page }) => {
    await startAttendanceCorrection(page)
    await editAnitaThursday(page)
    await settled(page)
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Correction in progress')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Correct', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: 'Resume' }).click()
    await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })
    // Only one session exists: resuming does not start a second one
    await settled(page)
    expect(await getCorrectionSessions(payrollRunId)).toHaveLength(1)
  })
})

test.describe('E2E-25: Abandoned correction changes nothing', () => {
  test('the edits are discarded, approved data and revision 1 are unchanged, and the audit log keeps the edits', async ({ page }) => {
    await startAttendanceCorrection(page)
    await editAnitaThursday(page)
    await settled(page)
    const editAudit = await getAuditRows('ATTENDANCE_PUNCH')
    expect(editAudit.length).toBeGreaterThanOrEqual(1)
    const before = {
      hours: await getAttendanceRecordHours(WEEK),
      punches: await getPunchRows(WEEK, {}),
    }

    // Abandon from the grid banner (it counts the changed days a moment after each save)
    await expect(page.getByTestId('correction-banner')).toContainText('1 day changed', { timeout: 10000 })
    await page.getByTestId('cancel-correction').click()
    await expect(page.getByTestId('discard-correction-dialog')).toBeVisible()
    await page.getByTestId('discard-correction').click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    // Approved hours, live punches and revision 1 are exactly as before
    expect(await getAttendanceRecordHours(WEEK)).toEqual(before.hours)
    expect(await getPunchRows(WEEK, {})).toEqual(before.punches)
    expect(await getRevisions(payrollRunId)).toMatchObject([{ revisionNumber: 1, status: 'APPROVED', isCurrent: true }])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')
    const sessions = await getCorrectionSessions(payrollRunId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].status).toBe('ABANDONED')
    // The draft copy of the punches is gone
    expect(await getPunchRows(WEEK, { correctionId: sessions[0].id })).toHaveLength(0)

    // The audit log keeps the edit entries, and a DISCARD entry marks them as discarded
    const stillThere = await getAuditRows('ATTENDANCE_PUNCH')
    expect(stillThere.map((a) => a.id)).toEqual(expect.arrayContaining(editAudit.map((a) => a.id)))
    const discard = (await getAuditRows('ATTENDANCE_WEEK', 'DISCARD')).at(-1)
    expect(discard).toBeDefined()
    const details = JSON.stringify(discard!.detailsJson)
    expect(details).toContain('18:00')
    expect(details).toContain('19:00')

    // And the run page offers Correct again, not Resume
    await expect(page.getByRole('button', { name: 'Correct', exact: true })).toBeVisible()
  })

  test('the first step can be cancelled too and nothing is created', async ({ page }) => {
    await beginCorrection(page)
    await page.getByRole('button', { name: 'Cancel Correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 20000 })
    await settled(page)
    expect(await getRevisions(payrollRunId)).toHaveLength(1)
    const sessions = await getCorrectionSessions(payrollRunId)
    expect(sessions.every((s) => s.status === 'ABANDONED')).toBe(true)
  })

  test('cancelling from the revised preview discards the draft revision', async ({ page }) => {
    await startAttendanceCorrection(page)
    await editAnitaThursday(page)
    await approvePunchesInUi(page)
    await settled(page)
    expect(await getRevisions(payrollRunId)).toHaveLength(2)

    await page.getByRole('button', { name: 'Cancel correction' }).click()
    await page.getByRole('button', { name: 'Discard correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)
    expect(await getRevisions(payrollRunId)).toMatchObject([{ revisionNumber: 1, status: 'APPROVED', isCurrent: true }])
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({ overtimeHours: 2 })
  })
})

test.describe('E2E-39: Adjustment-only correction skips the grid', () => {
  test('selecting only Adjustments goes straight to the revised preview', async ({ page }) => {
    await beginCorrection(page)
    await page.fill('#correction-reason', 'Advance recovery was applied in error')
    await page.locator('label:has-text("Adjustments")').click()
    await expect(page.locator('text=Advance recovery seed')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('text=Pending').first()).toBeVisible()
    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(page.locator('text=Skipped')).toBeVisible({ timeout: 8000 })

    // Recalculate & Preview, not Continue to punches
    await expect(page.getByRole('button', { name: /Continue to punches/ })).toHaveCount(0)
    await page.getByRole('button', { name: /Recalculate/ }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
    await expect(page.getByTestId('punch-review')).toHaveCount(0)
    await settled(page)
    // No punch copy was made
    expect((await getCorrectionSessions(payrollRunId))[0].status).toBe('IN_PROGRESS')
    expect(
      await prisma.attendancePunch.count({ where: { correctionId: { not: null }, attendanceUpload: { payrollWeekStartDate: new Date(`${WEEK}T00:00:00Z`) } } }),
    ).toBe(0)

    // E2E-40: the draft exists but revision 1 is still current
    expect(await getRevisions(payrollRunId)).toMatchObject([
      { revisionNumber: 1, status: 'APPROVED', isCurrent: true },
      { revisionNumber: 2, status: 'DRAFT', isCurrent: false, correctionReason: 'Advance recovery was applied in error' },
    ])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')

    await approveRevisionInUi(page)
    await settled(page)
    expect(await getRevisions(payrollRunId)).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED', isCurrent: false },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
    ])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('REVISED')
    // The deduction is gone from revision 2: Anita's net rose by 500
    const [first, second] = await getRevisions(payrollRunId)
    expect(second.netPayable).toBe(first.netPayable + 500)
    expect(revisionId).toBe(first.id)
  })

  test('a correction with no reason and Employee data selected also creates revision 2', async ({ page }) => {
    await beginCorrection(page)
    await page.click('text=Employee data updated')
    await page.getByRole('button', { name: /Recalculate/ }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
    await approveRevisionInUi(page)
    await settled(page)
    const revisions = await getRevisions(payrollRunId)
    expect(revisions).toHaveLength(2)
    expect(revisions[1]).toMatchObject({ revisionNumber: 2, isCurrent: true, correctionReason: null })
    expect(await getPayrollRunStatus(payrollRunId)).toBe('REVISED')
  })
})

test.describe('E2E-40: The current revision stays current until approval', () => {
  test('recalculating leaves revision 1 current; approving the preview swaps them', async ({ page }) => {
    await beginCorrection(page)
    await page.click('text=Employee data updated')
    await page.getByRole('button', { name: /Recalculate/ }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
    await settled(page)

    // On the revised preview revision 1 is still current
    const current = await prisma.payrollRevision.findMany({ where: { payrollRunId, isCurrent: true } })
    expect(current.map((r) => r.revisionNumber)).toEqual([1])
    // The history table on the run page shows only the current revision, not the draft
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Approved (Revision 1)')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Draft', { exact: true })).toHaveCount(0)

    await page.goto(`/payroll/run/${payrollRunId}/correct/preview`)
    await approveRevisionInUi(page)
    await settled(page)
    const after = await prisma.payrollRevision.findMany({ where: { payrollRunId }, orderBy: { revisionNumber: 'asc' } })
    expect(after.map((r) => [r.revisionNumber, r.isCurrent, r.status])).toEqual([
      [1, false, 'SUPERSEDED'],
      [2, true, 'APPROVED'],
    ])
  })
})
