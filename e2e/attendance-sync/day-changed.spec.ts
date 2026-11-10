import { test, expect, type Page } from '@playwright/test'
import prisma, { cleanupDatabase, createEmployee, getAuditRows, seedReviewWeek } from '../utils/db'
import { closeEditor, openDay, openReview, setPairField, settled } from '../utils/attendance-ui'
import { weekDates } from '../utils/etimeoffice-mock'

// Fix round 3, item 5: savePunchEdit builds its writes from a snapshot read before the week lock. Two
// saves of the same empty slot used to both create a punch (a duplicate MANUAL IN), and a pull that
// replaced the day between the read and the write made the save fail with "An unexpected error occurred".
// Now the transaction re-reads the day under the lock and refuses with DAY_CHANGED when it moved.
// Round 4, item 1: every save also carries the version of the day its editor was opened on, so a tab
// opened before another tab's save is refused as well, and its editor reloads to the latest times.

const W = '2026-10-08' // an ended week, so nothing else is going on in it
const dates = weekDates(W)
const ANITA = 'TPLGOAHLP001'
const JAYA = 'TPLGOAHLP011' // no punches at all
const DAY = dates[2]
const DAY_CHANGED =
  'This day was changed in another tab or by a pull, so your change was not saved. It now shows the latest times. Enter your change again.'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await cleanupDatabase()
  const anita = await createEmployee({ employeeId: ANITA, employeeName: 'Anita Rao' })
  await createEmployee({ employeeId: JAYA, employeeName: 'Jaya Nair' })
  await seedReviewWeek({
    weekStartISO: W,
    rows: [
      {
        employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
        empCode: '0001',
        days: [{ date: dates[0], punches: [{ time: '08:00' }, { time: '12:00' }, { time: '13:00' }, { time: '17:00' }] }],
      },
    ],
  })
})

const jayaPunches = async () => {
  const jaya = await prisma.employee.findFirstOrThrow({ where: { employeeId: JAYA } })
  return prisma.attendancePunch.findMany({
    where: { employeeId: jaya.id, punchDate: new Date(`${DAY}T00:00:00Z`) },
    orderBy: [{ pairIndex: 'asc' }, { position: 'asc' }],
  })
}

const saveStatus = (page: Page) => page.getByTestId('editor-save-status')

async function openEmptyDay(page: Page) {
  await openReview(page, W)
  await openDay(page, JAYA, DAY)
  await expect(page.getByTestId('editor-pair-1-in')).toHaveValue('')
}

test.describe('E2E: two tabs save the same empty day', () => {
  test('saved at the same moment: one IN punch is stored, and the tab that lost the race is refused and shows the saved time', async ({ page, context }) => {
    const other = await context.newPage()
    await openEmptyDay(page)
    await openEmptyDay(other)

    const fill = async (p: Page) => {
      const input = p.getByTestId('editor-pair-1-in')
      await input.fill('08:00')
      await input.press('Enter')
    }
    await Promise.all([fill(page), fill(other)])

    const settledText = (p: Page) => saveStatus(p).innerText()
    await expect
      .poll(async () => (await Promise.all([settledText(page), settledText(other)])).every((t) => /Saved|changed in another tab|Couldn't|unexpected/i.test(t)), {
        timeout: 20000,
        intervals: [200],
      })
      .toBe(true)
    const texts = await Promise.all([settledText(page), settledText(other)])

    // Whatever happened, the day holds exactly one IN punch at 08:00 (no duplicate MANUAL punch).
    const punches = await jayaPunches()
    expect(punches).toHaveLength(1)
    expect(punches[0]).toMatchObject({ position: 'IN', pairIndex: 0, currentTime: '08:00', source: 'MANUAL' })

    // Both tabs opened the same empty day, so whichever saved second is always refused: one tab saved,
    // the other was told, in the words of the screen, that its change was not saved.
    for (const text of texts) expect(text).toMatch(/Saved|This day was changed in another tab/)
    expect(texts.filter((t) => /Saved/.test(t))).toHaveLength(1)
    const refused = texts.filter((t) => t.includes('This day was changed in another tab'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain(DAY_CHANGED)
    // The refused tab reloaded the day, so its field now shows the time the other tab saved.
    const refusedPage = /Saved/.test(texts[0]) ? other : page
    await expect(refusedPage.getByTestId('editor-pair-1-in')).toHaveValue('08:00')

    // One CREATE audit row for the punch, not two.
    const created = (await getAuditRows('ATTENDANCE_PUNCH')).filter((a) => a.actionType === 'CREATE')
    expect(created).toHaveLength(1)
    await other.close()
  })

  test('saved one after the other, the second tab is refused and reloads; entering its change again saves', async ({ page, context }) => {
    const other = await context.newPage()
    await openEmptyDay(page)
    await openEmptyDay(other)

    await setPairField(page, 1, 'in', '08:00') // first tab saves
    await settled(page)
    await setPairField(other, 1, 'in', '09:30', { expectSaved: false }) // second tab, opened before that save
    await expect(other.getByTestId('editor-day-changed')).toBeVisible({ timeout: 10000 })
    await expect(other.getByTestId('editor-day-changed')).toHaveText(DAY_CHANGED)
    await expect(saveStatus(other)).not.toContainText(/unexpected/i)
    await settled(other)

    // Nothing of the stale tab was saved: the punch is still the first tab's, and the stale tab shows it.
    const afterRefusal = await jayaPunches()
    expect(afterRefusal).toHaveLength(1)
    expect(afterRefusal[0]).toMatchObject({ position: 'IN', currentTime: '08:00', source: 'MANUAL' })
    await expect(other.getByTestId('editor-pair-1-in')).toHaveValue('08:00')

    // Entering the change again, on the reloaded day, saves.
    await setPairField(other, 1, 'in', '09:30')
    await settled(other)
    const punches = await jayaPunches()
    expect(punches).toHaveLength(1)
    expect(punches[0]).toMatchObject({ position: 'IN', currentTime: '09:30', source: 'MANUAL' })
    await closeEditor(page)
    await other.close()
  })
})

test.describe('E2E: a tab opened before another tab saved a different pair', () => {
  const anitaPunches = async () => {
    const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: ANITA } })
    return prisma.attendancePunch.findMany({
      where: { employeeId: anita.id, punchDate: new Date(`${dates[0]}T00:00:00Z`) },
      orderBy: [{ pairIndex: 'asc' }, { position: 'asc' }],
    })
  }
  const summary = (rows: Awaited<ReturnType<typeof anitaPunches>>) =>
    rows.map((r) => `${r.pairIndex}${r.position}:${r.currentTime}:${r.source}`)

  async function openAnita(page: Page) {
    await openReview(page, W)
    await openDay(page, ANITA, dates[0])
    await expect(page.getByTestId('editor-pair-2-out')).toHaveValue('17:00')
  }

  test('the stale tab is refused instead of deleting the third pair, reloads to the latest times, and its change saves on the second try', async ({ page, context }) => {
    const stale = await context.newPage()
    await openAnita(page)
    await openAnita(stale) // opened on the day with two pairs, before the third one exists

    // Tab A adds a third pair, 18:00-19:00.
    await page.getByTestId('editor-add-pair').click()
    await setPairField(page, 3, 'in', '18:00')
    await setPairField(page, 3, 'out', '19:00')
    await settled(page)
    expect(summary(await anitaPunches())).toEqual([
      '0IN:08:00:API', '0OUT:12:00:API', '1IN:13:00:API', '1OUT:17:00:API', '2IN:18:00:MANUAL', '2OUT:19:00:MANUAL',
    ])

    // Tab B still holds two pairs and changes the second OUT.
    await setPairField(stale, 2, 'out', '17:30', { expectSaved: false })
    await expect(stale.getByTestId('editor-day-changed')).toBeVisible({ timeout: 10000 })
    await expect(stale.getByTestId('editor-day-changed')).toHaveText(DAY_CHANGED)
    await settled(stale)

    // The editor of the stale tab now shows the latest times, including the third pair; its own change was dropped.
    await expect(stale.getByTestId('editor-pair-3-in')).toHaveValue('18:00')
    await expect(stale.getByTestId('editor-pair-3-out')).toHaveValue('19:00')
    await expect(stale.getByTestId('editor-pair-2-out')).toHaveValue('17:00')

    // In the database: both hand-entered punches are still there, nothing was deleted, nothing of tab B was saved.
    expect(summary(await anitaPunches())).toEqual([
      '0IN:08:00:API', '0OUT:12:00:API', '1IN:13:00:API', '1OUT:17:00:API', '2IN:18:00:MANUAL', '2OUT:19:00:MANUAL',
    ])
    expect(await getAuditRows('ATTENDANCE_PUNCH', 'DELETE')).toHaveLength(0)

    // Entering the change again, on the reloaded day, saves, and the third pair is still there.
    await setPairField(stale, 2, 'out', '17:30')
    await settled(stale)
    const after = await anitaPunches()
    expect(after).toHaveLength(6)
    expect(summary(after)).toContain('1OUT:17:30:API')
    expect(summary(after)).toEqual(expect.arrayContaining(['2IN:18:00:MANUAL', '2OUT:19:00:MANUAL']))
    expect(await getAuditRows('ATTENDANCE_PUNCH', 'DELETE')).toHaveLength(0)

    // The first tab's grid is not touched by the refusal.
    await expect(page.getByTestId('editor-day-changed')).toHaveCount(0)
    await closeEditor(stale)
    await stale.close()
  })
})
