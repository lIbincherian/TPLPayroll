import { test, expect, type Page, type Route } from '@playwright/test'
import prisma, { cleanupTestData, createEmployee, seedReviewWeek } from '../utils/db'
import { cellText, openDay, openReview, setPairField, settled } from '../utils/attendance-ui'
import { weekDates } from '../utils/etimeoffice-mock'

// The grid header says "Saved 10:42" or "Not saved" for the LAST save. A save that is still in flight when the
// user steps to another day or closes the editor must still set it (a failure used to be swallowed, so the user
// could believe the edit was saved), and a day that leaves the review during a DAY_CHANGED reload must not set it
// at all (the grid has already closed the editor and told the user). After the editor has closed, a DAY_CHANGED
// refusal is a failed save and is never reloaded. The save request is held in the browser until the test
// releases it, so the editor can be left while the save is genuinely in flight.

const W = '2025-10-09' // an ended week before the real data starts
const dates = weekDates(W)
const ANITA = 'E2E-HLP-9001'
const JAYA = 'E2E-HLP-9011' // stays in the review in every test
const DAY = dates[0] // Anita's punches are on this day; the next day (dates[1]) has none

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await cleanupTestData()
  const anita = await createEmployee({ employeeId: ANITA, employeeName: 'Anita Rao' })
  await createEmployee({ employeeId: JAYA, employeeName: 'Jaya Nair' })
  await seedReviewWeek({
    weekStartISO: W,
    rows: [
      {
        employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
        empCode: '9001',
        days: [{ date: DAY, punches: [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }] }],
      },
    ],
  })
})

const anitaDay = async () => {
  const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: ANITA } })
  return prisma.attendancePunch.findMany({
    where: { employeeId: anita.id, punchDate: new Date(`${DAY}T00:00:00Z`) },
    orderBy: [{ pairIndex: 'asc' }, { position: 'asc' }],
  })
}
const lastOut = async () => (await anitaDay()).find((r) => r.pairIndex === 1 && r.position === 'OUT')!.currentTime

const isSaveRequest = (route: Route) => route.request().method() === 'POST' && (route.request().postData() ?? '').includes('baseSignature')
const isReviewReload = (route: Route) => route.request().method() === 'POST' && !(route.request().postData() ?? '').includes('baseSignature') && (route.request().postData() ?? '').includes('LIVE')

/**
 * Hold the first save request of the page in the browser until the test lets it through or drops it. Dropping it
 * means the network is down: every save request after it is dropped too, including the copy of the edit that the
 * blur queued behind the held save, which the editor still sends once after it has closed.
 */
async function holdFirstSave(page: Page) {
  let arrived!: () => void
  const saveArrived = new Promise<void>((resolve) => (arrived = resolve))
  let decide!: (what: 'continue' | 'abort') => void
  const decision = new Promise<'continue' | 'abort'>((resolve) => (decide = resolve))
  let held = false
  let networkDown = false
  const saves = { count: 0 }
  await page.route('**/attendance/**', async (route) => {
    if (isSaveRequest(route)) {
      saves.count++
      if (!held) {
        held = true
        arrived()
        networkDown = (await decision) === 'abort'
      }
      if (networkDown) return route.abort('failed')
    }
    return route.continue()
  })
  return { saveArrived, release: decide, saves }
}

/** Open Anita's first day, type a new last OUT and wait until that save request is held. */
async function startHeldSave(page: Page) {
  await openReview(page, W)
  const hold = await holdFirstSave(page)
  await openDay(page, ANITA, DAY)
  await setPairField(page, 2, 'out', '17:30', { expectSaved: false })
  await hold.saveArrived
  return hold
}

async function stepToNextDay(page: Page) {
  const before = await page.getByTestId('editor-day-label').innerText()
  await page.getByTestId('editor-next').click()
  await expect(page.getByTestId('editor-day-label')).not.toHaveText(before)
  await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('') // the next day has no punches
}

test.describe('E2E: a save still in flight when the user steps to the next day', () => {
  test('the request is lost: the header says "Not saved" and nothing was stored', async ({ page }) => {
    const hold = await startHeldSave(page)

    await stepToNextDay(page)
    await expect(page.getByTestId('saved-status')).toHaveCount(0) // nothing has failed yet
    hold.release('abort')

    await expect(page.getByTestId('saved-status')).toHaveText('Not saved')
    await expect(page.getByTestId('day-editor')).toBeVisible() // the editor of the next day is still open
    await expect(page.getByTestId('editor-retry')).toHaveCount(0) // and carries nothing of the lost save
    await settled(page)
    expect(await lastOut()).toBe('17:00')
    // The held save, and the copy of it that clicking Next queued by blurring the field; both were lost.
    expect(hold.saves.count).toBe(2)
  })

  test('the server refuses it because the day changed meanwhile: the header says "Not saved" and the review is not reloaded under the editor that is open now', async ({ page }) => {
    const hold = await startHeldSave(page)
    await stepToNextDay(page)
    let reloads = 0
    await page.route('**/attendance/**', (route) => {
      if (isReviewReload(route)) reloads++
      return route.fallback()
    })

    // Another tab edits the day while this save is held.
    const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: ANITA } })
    await prisma.attendancePunch.updateMany({ where: { employeeId: anita.id, punchDate: new Date(`${DAY}T00:00:00Z`), pairIndex: 1, position: 'OUT' }, data: { currentTime: '17:10' } })
    hold.release('continue')

    await expect(page.getByTestId('saved-status')).toHaveText('Not saved')
    await settled(page)
    await page.waitForTimeout(500) // a reload would have landed by now
    // A reload could close the editor the user has open now, so the closed editor does not ask for one.
    expect(reloads).toBe(0)
    expect(await cellText(page, ANITA, DAY)).toContain('17:00')
    await expect(page.getByTestId('day-editor')).toBeVisible()
    await expect(page.getByTestId('editor-day-changed')).toHaveCount(0) // the open editor is for the next day
    expect(await lastOut()).toBe('17:10') // nothing of the refused save
  })

  test('it lands: the grid shows it on the day it was made on, the header says "Saved", never "Not saved"', async ({ page }) => {
    const hold = await startHeldSave(page)
    await stepToNextDay(page)

    hold.release('continue')

    await expect.poll(() => cellText(page, ANITA, DAY), { timeout: 10000 }).toContain('17:30')
    await expect(page.getByTestId('saved-status')).toContainText('Saved')
    await expect(page.getByTestId('saved-status')).not.toContainText('Not saved')
    await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('') // still the next day's editor
    await settled(page)
    expect(await lastOut()).toBe('17:30')
  })
})

test.describe('E2E: a save still in flight when the user closes the editor', () => {
  test('the request is lost after the editor closed: the header says "Not saved"', async ({ page }) => {
    const hold = await startHeldSave(page)

    await page.getByTestId('editor-close').click()
    await expect(page.getByTestId('day-editor')).toBeHidden()
    await expect(page.getByTestId('saved-status')).toHaveCount(0)
    hold.release('abort')

    await expect(page.getByTestId('saved-status')).toHaveText('Not saved')
    await settled(page)
    expect(await lastOut()).toBe('17:00')
  })
})

test.describe('E2E: the employee leaves the review while a refused save is being reloaded', () => {
  test('the editor closes, the user is told once, the header does not say "Not saved", and no second save is sent', async ({ page }) => {
    await openReview(page, W)
    await openDay(page, ANITA, DAY)
    const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: ANITA } })
    // Another tab changed the day, so this tab's save will be refused as DAY_CHANGED.
    await prisma.attendancePunch.updateMany({ where: { employeeId: anita.id, punchDate: new Date(`${DAY}T00:00:00Z`), pairIndex: 1, position: 'OUT' }, data: { currentTime: '17:10' } })
    let saves = 0
    let reloads = 0
    await page.route('**/attendance/**', async (route) => {
      if (isSaveRequest(route)) saves++
      else if (isReviewReload(route)) {
        reloads++
        // Between the refusal and the reload Anita is deactivated, so the reload no longer lists her.
        if (reloads === 1) await prisma.employee.update({ where: { id: anita.id }, data: { isActive: false } })
      }
      return route.continue()
    })

    await setPairField(page, 2, 'out', '17:30', { expectSaved: false })

    await expect(page.getByText("That employee is no longer in this week's review.")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('day-editor')).toBeHidden()
    await expect(page.getByTestId(`employee-row-${ANITA}`)).toHaveCount(0)
    await expect(page.getByTestId(`employee-row-${JAYA}`)).toBeVisible()
    await settled(page)
    await page.waitForTimeout(500) // a late "Not saved" would have landed by now
    await expect(page.getByText('Not saved')).toHaveCount(0)
    expect(saves).toBe(1)
    expect(reloads).toBe(1)
    expect(await lastOut()).toBe('17:10') // nothing of the refused save was stored
  })
})
