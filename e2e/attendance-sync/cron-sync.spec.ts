import { test, expect } from '@playwright/test'
import prisma, {
  cleanupDatabase,
  seedEmployeesForSync,
  seedReviewWeek,
  getWeekRow,
  getPunchRows,
  getAuditRows,
} from '../utils/db'
import {
  addDays,
  clearMockScenario,
  expectedCompletedWeek,
  mockDays,
  mockDay,
  FULL_DAY,
  setMockApiError,
  setMockEmpty,
  setMockHttpError,
  setMockPunches,
  setMockScenario,
  weekDates,
} from '../utils/etimeoffice-mock'
import { cronHeaders, openAttendance, runCron, weekRow } from '../utils/attendance-ui'

// The scheduled sync (Vercel Cron -> /api/cron/attendance-sync) against the in-app mock of
// eTimeOffice. The week it targets is the one that ended yesterday (IST), so every test derives
// it from the real clock.

const week = expectedCompletedWeek()
const dates = weekDates(week.start)

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupDatabase()
  await seedEmployeesForSync()
})

test.afterAll(async () => {
  clearMockScenario()
})

test.describe('E2E-01: Scheduled sync loads the completed week', () => {
  test('loads Thursday 00:00 to Wednesday 23:59 for all employees and shows Ready for review', async ({
    request,
    page,
  }) => {
    // No scenario: the mock answers the way eTimeOffice would, with punches for every day of the
    // REQUESTED range. So the loaded days prove the request window.
    const result = await runCron(request)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, outcome: 'LOADED' })

    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('REVIEW')
    expect(row?.source).toBe('ETIMEOFFICE')
    expect(row?.lastSyncedAt).not.toBeNull()
    expect(row?.lastSyncError).toBeNull()
    expect(row?.lastSyncTrigger).toBe('SCHEDULED')
    expect(row?.approvedAt).toBeNull()

    const punches = await getPunchRows(week.start, {})
    const loadedDates = [...new Set(punches.map((p) => p.date))].sort()
    expect(loadedDates).toEqual(dates)
    // Three codes, seven days, four punches each
    expect(punches).toHaveLength(3 * 7 * 4)
    expect(new Set(punches.map((p) => p.empCode))).toEqual(new Set(['0001', '0002', '0003']))

    await openAttendance(page)
    const listRow = weekRow(page, week.start)
    await expect(listRow).toHaveAttribute('data-status', 'REVIEW')
    await expect(listRow.getByTestId('week-status-badge')).toHaveText(/Ready for review/)
    // Not available to payroll until approved
    await page.goto('/payroll')
    const payrollRow = page.locator('tr', { hasText: 'Ready for review' }).first()
    await expect(payrollRow).toBeVisible()
    await expect(payrollRow.locator('span[title="Approve this week\'s attendance first"]')).toBeVisible()
    await expect(payrollRow.locator('a:has-text("Generate")')).toHaveCount(0)
    await page.goto(`/payroll/generate/${week.start}`)
    await expect(page.getByText("Attendance for this week isn't approved yet")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0)
  })

  test('writes a SYNC audit row for the load', async ({ request }) => {
    await runCron(request)
    const audit = await getAuditRows('ATTENDANCE_WEEK')
    expect(audit.length).toBeGreaterThan(0)
    expect(['SYNC', 'PULL']).toContain(audit[0].actionType)
    expect(JSON.stringify(audit[0].detailsJson)).toContain('LOADED')
  })

  test('drops punches that fall outside the week', async ({ request }) => {
    setMockPunches([
      ...mockDay('0001', dates[0], FULL_DAY),
      // one day before and one day after the window
      ...mockDay('0001', addDays(week.start, -1), ['08:00', '16:00']),
      ...mockDay('0001', addDays(week.end, 1), ['08:00', '16:00']),
    ])
    const result = await runCron(request)
    expect(result.body).toMatchObject({ ok: true, outcome: 'LOADED' })
    const punches = await getPunchRows(week.start, {})
    expect(new Set(punches.map((p) => p.date))).toEqual(new Set([dates[0]]))
    expect(punches).toHaveLength(4)
  })
})

test.describe('E2E-02: Sync route rejects a missing secret', () => {
  test('a request without the secret is rejected and nothing changes', async ({ request }) => {
    setMockPunches(mockDays('0001', dates))
    const response = await request.get('/api/cron/attendance-sync')
    expect(response.status()).toBe(401)
    expect(await prisma.attendanceUpload.count()).toBe(0)
    expect(await prisma.attendancePunch.count()).toBe(0)
    expect(await prisma.auditLog.count({ where: { entityType: { startsWith: 'ATTENDANCE_' } } })).toBe(0)
  })

  test('a wrong secret, a wrong scheme and an empty bearer are all rejected', async ({ request }) => {
    setMockPunches(mockDays('0001', dates))
    for (const authorization of ['Bearer not-the-secret', `Basic ${process.env.CRON_SECRET}`, 'Bearer ', process.env.CRON_SECRET ?? '']) {
      const response = await request.get('/api/cron/attendance-sync', { headers: { authorization } })
      expect(response.status(), `authorization "${authorization.slice(0, 6)}…"`).toBe(401)
    }
    expect(await prisma.attendanceUpload.count()).toBe(0)
    expect(await prisma.attendancePunch.count()).toBe(0)
  })

  test('the correct secret is accepted', async ({ request }) => {
    setMockPunches(mockDays('0001', dates))
    const response = await request.get('/api/cron/attendance-sync', { headers: cronHeaders() })
    expect(response.status()).toBe(200)
  })
})

test.describe('E2E-03: Failed sync offers Pull now', () => {
  test('an HTTP 500 shows Sync failed with the error and stores no punches', async ({ request, page }) => {
    setMockHttpError(500)
    const result = await runCron(request)
    // The route answers 200 so Vercel doesn't retry; the failure is recorded on the week.
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, outcome: 'FAILED', code: 'HTTP_STATUS' })

    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('SYNC_FAILED')
    expect(row?.lastSyncError).toBe('eTimeOffice returned HTTP 500.')
    expect(row?.syncLockedAt).toBeNull()
    expect(await getPunchRows(week.start, {})).toHaveLength(0)

    await openAttendance(page)
    const listRow = weekRow(page, week.start)
    await expect(listRow).toHaveAttribute('data-status', 'SYNC_FAILED')
    await expect(listRow.getByTestId('week-status-badge')).toHaveText(/Sync failed/)
    await expect(listRow.getByTestId('week-error')).toContainText('eTimeOffice returned HTTP 500.')
    await expect(page.getByTestId(`pull-now-${week.start}`)).toBeVisible()
  })

  test('a 200 with Error = true fails the sync with the vendor message', async ({ request, page }) => {
    setMockApiError('Invalid credentials')
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'API_ERROR' })
    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('SYNC_FAILED')
    expect(row?.lastSyncError).toBe('eTimeOffice reported an error: Invalid credentials')
    expect(await getPunchRows(week.start, {})).toHaveLength(0)

    await openAttendance(page)
    await expect(weekRow(page, week.start).getByTestId('week-error')).toContainText('Invalid credentials')
    await expect(page.getByTestId(`pull-now-${week.start}`)).toBeVisible()
  })

  test('a response that cannot be read fails the sync', async ({ request }) => {
    setMockScenario({ status: 200, body: 'this is not json {' })
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'UNPARSEABLE' })
    expect((await getWeekRow(week.start))?.lastSyncError).toBe("eTimeOffice sent a response we couldn't read.")
  })

  test('a row whose time cannot be read fails the whole sync and nothing is stored', async ({ request }) => {
    setMockScenario({
      status: 200,
      body: {
        Error: false,
        Msg: 'Success',
        PunchData: [
          { Name: 'A', Empcode: '0001', PunchDate: `${dates[0].split('-').reverse().join('/')} 07:40:00`, M_Flag: '', mcid: '1' },
          { Name: 'A', Empcode: '0001', PunchDate: 'garbage', M_Flag: '', mcid: '1' },
        ],
      },
    })
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'UNPARSEABLE' })
    expect(await getPunchRows(week.start, {})).toHaveLength(0)
    expect((await getWeekRow(week.start))?.status).toBe('SYNC_FAILED')
  })

  test('after the API recovers, Pull now loads the week', async ({ request, page }) => {
    setMockHttpError(500)
    await runCron(request)

    await openAttendance(page)
    await expect(weekRow(page, week.start)).toHaveAttribute('data-status', 'SYNC_FAILED')

    // eTimeOffice is back
    setMockPunches([...mockDays('0001', dates), ...mockDays('0004', dates)])
    await page.getByTestId(`pull-now-${week.start}`).click()

    await expect(weekRow(page, week.start)).toHaveAttribute('data-status', 'REVIEW', { timeout: 20000 })
    await expect(weekRow(page, week.start).getByTestId('week-status-badge')).toHaveText(/Ready for review/)
    await expect(weekRow(page, week.start).getByTestId('week-error')).toHaveCount(0)

    const row = await getWeekRow(week.start)
    expect(row?.lastSyncError).toBeNull()
    expect(row?.lastSyncTrigger).toBe('MANUAL')
    expect(await getPunchRows(week.start, {})).toHaveLength(2 * 7 * 4)
  })
})

test.describe('E2E-04: Empty response does not freeze the week', () => {
  test('a successful response with no punches shows Sync failed and keeps Pull now', async ({ request, page }) => {
    setMockEmpty()
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })

    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('SYNC_FAILED')
    expect(row?.lastSyncError).toBe('eTimeOffice returned no punches for this week.')
    expect(await getPunchRows(week.start, {})).toHaveLength(0)

    await openAttendance(page)
    await expect(weekRow(page, week.start).getByTestId('week-status-badge')).toHaveText(/Sync failed/)
    await expect(page.getByTestId(`pull-now-${week.start}`)).toBeVisible()
  })

  test('a response whose punches are all outside the week is treated as empty', async ({ request }) => {
    setMockPunches(mockDay('0001', '2020-01-02', FULL_DAY))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })
    expect(await getPunchRows(week.start, {})).toHaveLength(0)
  })
})

test.describe('E2E-05: Scheduled sync leaves an edited week alone', () => {
  test('keeps the edits, shows a newer-data notice and offers Pull now', async ({ request, page }) => {
    const employees = await prisma.employee.findMany({ where: { employeeId: 'TPLGOAHLP001' } })
    const anita = employees[0]
    // Pulled on Monday: one day of punches, the OUT edited from 17:47 to 18:00.
    const { id } = await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
          empCode: '0001',
          days: [{ date: dates[0], punches: FULL_DAY.map((time) => ({ time })) }],
        },
      ],
    })
    const edited = await prisma.attendancePunch.findFirstOrThrow({
      where: { attendanceUploadId: id, originalTime: '17:47' },
    })
    await prisma.attendancePunch.update({ where: { id: edited.id }, data: { currentTime: '18:00', note: 'Forgot to scan out' } })

    // Thursday: eTimeOffice now has the full week, and different times
    setMockPunches(mockDays('0001', dates, ['09:00', '17:00']))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ ok: true, outcome: 'SKIPPED_HAS_EDITS' })

    const after = await prisma.attendancePunch.findUniqueOrThrow({ where: { id: edited.id } })
    expect(after.originalTime).toBe('17:47')
    expect(after.currentTime).toBe('18:00')
    expect(after.note).toBe('Forgot to scan out')
    // Still the Monday pull: one day, not the full week
    expect(new Set((await getPunchRows(week.start, {})).map((p) => p.date))).toEqual(new Set([dates[0]]))

    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('REVIEW')
    expect(row?.staleNoticeAt).not.toBeNull()

    await openAttendance(page)
    await expect(weekRow(page, week.start).getByTestId('week-stale-notice')).toContainText('Newer data may be available')
    await expect(page.getByTestId(`pull-now-${week.start}`)).toBeVisible()

    const audit = await getAuditRows('ATTENDANCE_WEEK')
    expect(JSON.stringify(audit.map((a) => a.detailsJson))).toContain('SKIPPED_HAS_EDITS')
  })

  test('employee decisions also protect the week from the scheduled sync', async ({ request }) => {
    const inactive = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'TPLGOAHLP002' } })
    const { id } = await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: inactive.id, employeeId: inactive.employeeId, employeeName: inactive.employeeName },
          empCode: '0002',
          days: [{ date: dates[0], punches: [{ time: '08:00' }, { time: '16:00' }] }],
        },
      ],
    })
    await prisma.attendanceEmployeeDecision.create({
      data: { attendanceUploadId: id, employeeId: inactive.id, reason: 'INACTIVE', decision: 'APPROVED' },
    })
    setMockPunches(mockDays('0001', dates))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: id } })).toBe(1)
  })
})

test.describe('E2E-32: Scheduled sync replaces an unedited earlier pull', () => {
  test('the partial Monday pull is replaced by the full week', async ({ request, page }) => {
    const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'TPLGOAHLP001' } })
    // Monday: only the first two days had happened
    await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
          empCode: '0001',
          days: dates.slice(0, 2).map((date) => ({ date, punches: FULL_DAY.map((time) => ({ time })) })),
        },
      ],
    })
    expect(new Set((await getPunchRows(week.start, {})).map((p) => p.date)).size).toBe(2)

    setMockPunches(mockDays('0001', dates))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ ok: true, outcome: 'LOADED' })

    const punches = await getPunchRows(week.start, {})
    expect(new Set(punches.map((p) => p.date))).toEqual(new Set(dates))
    expect(punches).toHaveLength(7 * 4)
    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('REVIEW')
    expect(row?.staleNoticeAt).toBeNull()

    await openAttendance(page)
    await expect(weekRow(page, week.start).getByTestId('week-stale-notice')).toHaveCount(0)
  })
})
