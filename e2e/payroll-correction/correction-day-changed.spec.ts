import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupDatabase,
  getAuditRows,
  getCorrectionSessions,
  getPunchRows,
  seedApprovedPayrollForCorrection,
} from '../utils/db'
import { clearMockScenario } from '../utils/etimeoffice-mock'
import { closeEditor, openDay, setPairField, settled } from '../utils/attendance-ui'

// Round 4, item 1 in a correction: every save carries the version of the day its editor was opened on.
// Two tabs are open on the same correction's punch grid. One adds a hand-entered pair to the copy; the
// other, opened before that save, then edits the first pair. Without the version the stale tab's save
// would delete the pair it never saw; now it is refused, reloads to the latest times, and the pair survives.
//
// Seed: week 17-23 Apr 2025. Anita Sharma (EMP-COR-001) has one pair on Thursday 17 Apr: 08:00-18:00.

const WEEK = '2025-04-17'
const ANITA = 'EMP-COR-001'
const DAY_CHANGED =
  'This day was changed in another tab or by a pull, so your change was not saved. It now shows the latest times. Enter your change again.'

let payrollRunId: string

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupDatabase()
  const seed = await seedApprovedPayrollForCorrection()
  payrollRunId = seed.payrollRunId
})

test.afterAll(() => {
  clearMockScenario()
})

/** Start an attendance correction from the payroll run page and land on the punch grid. */
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

async function openAnita(page: Page) {
  await openDay(page, ANITA, WEEK)
  await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('08:00')
  await expect(page.getByTestId('editor-pair-1-out')).toHaveValue('18:00')
}

const summary = (rows: Awaited<ReturnType<typeof getPunchRows>>) =>
  rows.map((r) => `${r.pairIndex}${r.position}:${r.currentTime}:${r.source}`)

test('a stale tab on a correction is refused, the hand-entered pair of the copy survives, and the change saves on the second try', async ({ page, context }) => {
  await startAttendanceCorrection(page)
  const session = (await getCorrectionSessions(payrollRunId)).find((s) => s.status === 'IN_PROGRESS')!
  expect(session).toBeDefined()

  const stale = await context.newPage()
  await stale.goto(page.url())
  await expect(stale.getByTestId('punch-review')).toHaveAttribute('data-mode', 'CORRECTION', { timeout: 20000 })
  await openAnita(page)
  await openAnita(stale) // opened on the day with one pair, before the second one exists

  // Tab A adds a second pair, 19:00-20:00, to the copy.
  await page.getByTestId('editor-add-pair').click()
  await setPairField(page, 2, 'in', '19:00')
  await setPairField(page, 2, 'out', '20:00')
  await settled(page)
  const copyBefore = await getPunchRows(WEEK, { correctionId: session.id, employeeCode: ANITA, date: WEEK })
  expect(summary(copyBefore)).toEqual(['0IN:08:00:API', '0OUT:18:00:API', '1IN:19:00:MANUAL', '1OUT:20:00:MANUAL'])

  // Tab B, which still holds one pair, changes the OUT of the first.
  await setPairField(stale, 1, 'out', '17:30', { expectSaved: false })
  await expect(stale.getByTestId('editor-day-changed')).toBeVisible({ timeout: 10000 })
  await expect(stale.getByTestId('editor-day-changed')).toHaveText(DAY_CHANGED)
  await settled(stale)

  // The stale editor shows the copy as it is now; its own edit was dropped.
  await expect(stale.getByTestId('editor-pair-2-in')).toHaveValue('19:00')
  await expect(stale.getByTestId('editor-pair-2-out')).toHaveValue('20:00')
  await expect(stale.getByTestId('editor-pair-1-out')).toHaveValue('18:00')

  // The copy still has both hand-entered punches, nothing was deleted, and the live punches never moved.
  expect(summary(await getPunchRows(WEEK, { correctionId: session.id, employeeCode: ANITA, date: WEEK }))).toEqual(summary(copyBefore))
  expect(await getAuditRows('ATTENDANCE_PUNCH', 'DELETE')).toHaveLength(0)
  expect(summary(await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK }))).toEqual(['0IN:08:00:API', '0OUT:18:00:API'])

  // The same edit entered again, on the reloaded day, saves; the second pair is still there.
  await setPairField(stale, 1, 'out', '17:30')
  await settled(stale)
  const copyAfter = await getPunchRows(WEEK, { correctionId: session.id, employeeCode: ANITA, date: WEEK })
  expect(copyAfter).toHaveLength(4)
  expect(summary(copyAfter)).toEqual(['0IN:08:00:API', '0OUT:17:30:API', '1IN:19:00:MANUAL', '1OUT:20:00:MANUAL'])
  expect(await getAuditRows('ATTENDANCE_PUNCH', 'DELETE')).toHaveLength(0)
  expect(summary(await getPunchRows(WEEK, { employeeCode: ANITA, date: WEEK }))).toEqual(['0IN:08:00:API', '0OUT:18:00:API'])

  await closeEditor(page)
  await closeEditor(stale)
  await stale.close()
  expect(await prisma.payrollCorrectionSession.count({ where: { payrollRunId, status: 'IN_PROGRESS' } })).toBe(1)
})
