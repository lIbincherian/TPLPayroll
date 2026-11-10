import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupTestData,
  seedApprovedPayrollForCorrection,
  getAttendanceRecordHours,
  getCorrectionSessions,
  getPayrollRunStatus,
  getPunchRows,
  getRevisionEmployees,
  getRevisions,
} from '../utils/db'
import { clearMockScenario } from '../utils/etimeoffice-mock'
import { closeEditor, dayCell, openDay, setPairField, settled } from '../utils/attendance-ui'

// Fix round, items 1, 2 and 7: a stale preview cannot be approved, an employee who was deactivated
// after approval stays in the correction, and a correction that leaves an employee out carries their
// adjustment forward.
//
// Seed: week 17-23 Apr 2025, revision 1 current.
//   Anita Sharma  E2E-COR-9001  46 regular + 6 overtime hours (Thursday 17 Apr: 08:00-18:00), a 500 deduction
//   Rajesh Iyer   E2E-COR-9002  56 regular hours (08:00-16:00 every day)

const WEEK = '2025-04-17'
const NEXT_WEEK = '2025-04-24'
const ANITA = 'E2E-COR-9001'
const RAJESH = 'E2E-COR-9002'
const WEEK_DATES = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(`${WEEK}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  return d.toISOString().slice(0, 10)
})

let payrollRunId: string
let adjustmentApplicationId: string

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
  const seed = await seedApprovedPayrollForCorrection()
  payrollRunId = seed.payrollRunId
  adjustmentApplicationId = seed.adjustmentApplicationId
})

test.afterAll(() => {
  clearMockScenario()
})

const PUNCHES_URL = () => new RegExp(`/payroll/run/${payrollRunId}/correct/punches`)
const PREVIEW_URL = () => new RegExp(`/payroll/run/${payrollRunId}/correct/preview`)

/** Begin a correction, choose Attendance and land on the punch grid. */
async function startAttendanceCorrection(page: Page) {
  await settled(page)
  await page.goto(`/payroll/run/${payrollRunId}`)
  await page.getByRole('button', { name: 'Correct', exact: true }).click()
  await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })
  await page.locator('label:has-text("Attendance")').click()
  await page.getByRole('button', { name: /Continue to punches/ }).click()
  await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('punch-review')).toHaveAttribute('data-mode', 'CORRECTION')
}

/** Anita's Thursday OUT to `out`; `overtime` is the overtime the editor then shows. */
async function setAnitaThursdayOut(page: Page, out: string, overtime: string) {
  await openDay(page, ANITA, WEEK)
  await setPairField(page, 1, 'out', out)
  await expect(page.getByTestId('editor-day-overtime')).toHaveText(overtime)
  await closeEditor(page)
}

async function approvePunchesInUi(page: Page) {
  await expect(page.getByTestId('approve-week-button')).toHaveText('Approve punches')
  await page.getByTestId('approve-week-button').click()
  await expect(page.getByTestId('approval-employees')).not.toHaveText('', { timeout: 10000 })
  await page.getByTestId('approve-confirm').click()
  await expect(page).toHaveURL(PREVIEW_URL(), { timeout: 30000 })
  await expect(page.locator('text=Revision 1 stays current until you approve')).toBeVisible({ timeout: 15000 })
}

async function approveRevisionInUi(page: Page) {
  await page.getByRole('button', { name: 'Approve Revision' }).click()
  await page.getByRole('button', { name: 'Confirm Revision' }).click()
}

const onlySession = async () => {
  const sessions = await getCorrectionSessions(payrollRunId)
  expect(sessions).toHaveLength(1)
  return sessions[0]
}

test.describe('Item 1: a preview made from earlier punches cannot be approved', () => {
  test('Back, edit again, then the old preview URL sends you to the punches; approving again gives records that match the revision', async ({ page }) => {
    await startAttendanceCorrection(page)
    await setAnitaThursdayOut(page, '19:00', '3.00')
    await approvePunchesInUi(page)
    const previewUrl = page.url()
    await settled(page)
    expect((await onlySession()).draftRevisionId).toBeTruthy()

    // Back to the punches and change the same day again
    await page.getByRole('button', { name: /^back$/i }).click()
    await expect(page).toHaveURL(PUNCHES_URL(), { timeout: 20000 })
    await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })
    await setAnitaThursdayOut(page, '20:00', '4.00')
    await settled(page)
    expect((await onlySession()).draftRevisionId).toBeNull()

    // The preview of the earlier punches is gone: opening its URL shows the punches again
    await page.goto(previewUrl)
    await expect(page).toHaveURL(PUNCHES_URL(), { timeout: 20000 })
    await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })
    await expect(page.locator('text=Revision 1 stays current until you approve')).toHaveCount(0)
    await settled(page)
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({ overtimeHours: 2 })
    expect((await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK })).map((p) => p.currentTime)).toEqual(['08:00', '18:00'])

    // Approve the punches again: a new preview, then the revision
    await approvePunchesInUi(page)
    await approveRevisionInUi(page)
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    // One revision 1 (superseded) and one revision 2 (current): the stale draft did not pile up
    const revisions = await getRevisions(payrollRunId)
    expect(revisions).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED', isCurrent: false },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
    ])
    expect(revisions).toHaveLength(2)
    expect(await getPayrollRunStatus(payrollRunId)).toBe('REVISED')

    // The revision and the attendance records both carry the last edit (20:00 = 12 h = 8 + 4)
    const anita = (await getRevisionEmployees(revisions[1].id)).find((e) => e.employeeCode === ANITA)!
    expect(anita.regularHours).toBe(46)
    expect(anita.overtimeHours).toBe(8) // 6 before, +2 for the Thursday edit
    const hours = await getAttendanceRecordHours(WEEK, ANITA)
    expect(hours.find((h) => h.date === WEEK)).toMatchObject({ regularHours: 8, overtimeHours: 4 })
    expect(hours.reduce((sum, h) => sum + h.overtimeHours, 0)).toBe(anita.overtimeHours)
    expect(hours.reduce((sum, h) => sum + h.regularHours, 0)).toBe(anita.regularHours)
    expect((await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK })).find((p) => p.position === 'OUT')).toMatchObject({
      originalTime: '18:00',
      currentTime: '20:00',
    })
  })

  test('a preview left open in one tab is refused after the punches change in another, and sends you back to the punches', async ({ page, context }) => {
    await startAttendanceCorrection(page)
    await setAnitaThursdayOut(page, '19:00', '3.00')
    await approvePunchesInUi(page)
    await settled(page)

    // Another tab edits the same correction's punches
    const other = await context.newPage()
    await other.goto(`/payroll/run/${payrollRunId}/correct/punches`)
    await expect(other.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })
    await setAnitaThursdayOut(other, '20:00', '4.00')
    await settled(other)
    expect((await onlySession()).draftRevisionId).toBeNull()
    await other.close()

    // The first tab still shows the old preview; approving it is refused and the user is taken to the punches
    await approveRevisionInUi(page)
    await expect(page).toHaveURL(PUNCHES_URL(), { timeout: 30000 })
    await expect(page.getByTestId('punch-review')).toBeVisible({ timeout: 20000 })

    // Nothing was applied
    await settled(page)
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')
    const revisions = await getRevisions(payrollRunId)
    expect(revisions.find((r) => r.revisionNumber === 1)).toMatchObject({ status: 'APPROVED', isCurrent: true })
    expect(revisions.filter((r) => r.isCurrent)).toHaveLength(1)
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({ overtimeHours: 2 })
    expect((await onlySession()).status).toBe('IN_PROGRESS')

    // The edited punches approve normally from here
    await approvePunchesInUi(page)
    await approveRevisionInUi(page)
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)
    expect((await getAttendanceRecordHours(WEEK, ANITA)).find((h) => h.date === WEEK)).toMatchObject({ overtimeHours: 4 })
  })
})

test.describe('Item 2: an employee deactivated after approval stays in the correction', () => {
  test('the correction grid still lists them, accepts their edit, and the new revision keeps their records and pay', async ({ page }) => {
    await prisma.employee.update({ where: { employeeId: RAJESH }, data: { isActive: false } })

    await startAttendanceCorrection(page)
    // Listed and editable, and nothing waits for a decision
    await expect(dayCell(page, RAJESH, WEEK)).toBeVisible()
    await openDay(page, RAJESH, WEEK)
    await setPairField(page, 1, 'out', '17:00') // 08:00-16:00 -> 08:00-17:00: 9 hours, 1 overtime
    await expect(page.getByTestId('editor-day-overtime')).toHaveText('1.00')
    await closeEditor(page)
    await expect(page.getByTestId('approve-week-button')).toBeEnabled()

    await approvePunchesInUi(page)
    await approveRevisionInUi(page)
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    const revisions = await getRevisions(payrollRunId)
    expect(revisions).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED' },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
    ])
    const rajesh = (await getRevisionEmployees(revisions[1].id)).find((e) => e.employeeCode === RAJESH)
    expect(rajesh).toBeDefined()
    expect(rajesh!.overtimeHours).toBe(1)
    const hours = await getAttendanceRecordHours(WEEK, RAJESH)
    expect(hours).toHaveLength(7)
    expect(hours.find((h) => h.date === WEEK)).toMatchObject({ regularHours: 8, overtimeHours: 1 })
  })
})

test.describe("Item 7: an employee a correction leaves out has their adjustment carried forward", () => {
  test('deleting all of Anita\'s punches skips her 500 deduction and moves it to the next week', async ({ page }) => {
    await startAttendanceCorrection(page)

    // Delete the only pair of every day she worked (six days; Sunday has none)
    for (const date of WEEK_DATES) {
      const text = (await dayCell(page, ANITA, date).innerText()).replace(/\s+/g, ' ')
      if (!/\d{2}:\d{2}/.test(text)) continue
      await openDay(page, ANITA, date)
      await page.getByTestId('editor-pair-1-delete').click()
      await expect(page.getByTestId('editor-save-status')).toContainText('Saved', { timeout: 10000 })
      await closeEditor(page)
    }
    await expect(page.getByTestId('approve-week-button')).toBeEnabled()

    await approvePunchesInUi(page)
    await approveRevisionInUi(page)
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    const revisions = await getRevisions(payrollRunId)
    expect(revisions).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED' },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
    ])
    // Anita is not paid in revision 2; Rajesh is
    expect((await getRevisionEmployees(revisions[1].id)).map((e) => e.employeeCode)).toEqual([RAJESH])
    expect(await getAttendanceRecordHours(WEEK, ANITA)).toHaveLength(0)

    // Her deduction is not applied to this run any more: it was skipped and moved to the next week
    const application = await prisma.payrollAdjustmentApplication.findUniqueOrThrow({ where: { id: adjustmentApplicationId } })
    expect(application.approvalStatus).toBe('SKIPPED')
    expect(application.carriedForwardToPayrollWeekStartDate?.toISOString().slice(0, 10)).toBe(NEXT_WEEK)
    const carried = await prisma.payrollAdjustmentApplication.findMany({
      where: { payrollAdjustmentId: application.payrollAdjustmentId, payrollWeekStartDate: new Date(`${NEXT_WEEK}T00:00:00Z`) },
    })
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({ approvalStatus: 'PENDING', employeeId: application.employeeId })
    expect(Number(carried[0].appliedAmount)).toBe(500)
    const adjustment = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id: application.payrollAdjustmentId } })
    expect(adjustment.status).toBe('ACTIVE')
    expect(adjustment.skippedCarryForwardCount).toBe(1)

    // The run no longer carries a deduction for this week
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
    expect(Number(run.totalDeductions)).toBe(0)
  })
})
