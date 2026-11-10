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
