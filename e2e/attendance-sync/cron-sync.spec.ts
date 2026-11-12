import { test, expect } from '@playwright/test'
import prisma, {
  auditSince,
  cleanupTestData,
  countTestPunches,
  countTestUploads,
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
  payrollWeekLabel,
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
  await cleanupTestData()
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
    // Three codes, seven days, four punches each. 0001-0003 are the mock's own default codes, not test data:
    // in the real-data base they may link to real employees (their rows are in the reserved week and go with it).
    expect(punches).toHaveLength(3 * 7 * 4)
    expect(new Set(punches.map((p) => p.empCode))).toEqual(new Set(['0001', '0002', '0003']))

    await openAttendance(page)
    const listRow = weekRow(page, week.start)
    await expect(listRow).toHaveAttribute('data-status', 'REVIEW')
    await expect(listRow.getByTestId('week-status-badge')).toHaveText(/Ready for review/)
    // Not available to payroll until approved
    await page.goto('/payroll')
    const payrollRow = page.locator('tr', { hasText: 'Ready for review' }).filter({ hasText: payrollWeekLabel(week) }).first()
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
      ...mockDay('9001', dates[0], FULL_DAY),
      // one day before and one day after the window
      ...mockDay('9001', addDays(week.start, -1), ['08:00', '16:00']),
      ...mockDay('9001', addDays(week.end, 1), ['08:00', '16:00']),
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
    setMockPunches(mockDays('9001', dates))
    const response = await request.get('/api/cron/attendance-sync')
    expect(response.status()).toBe(401)
    expect(await countTestUploads()).toBe(0)
    expect(await countTestPunches()).toBe(0)
    expect(await prisma.auditLog.count({ where: { ...auditSince(), entityType: { startsWith: 'ATTENDANCE_' } } })).toBe(0)
  })

  test('a wrong secret, a wrong scheme and an empty bearer are all rejected', async ({ request }) => {
    setMockPunches(mockDays('9001', dates))
    for (const authorization of ['Bearer not-the-secret', `Basic ${process.env.CRON_SECRET}`, 'Bearer ', process.env.CRON_SECRET ?? '']) {
      const response = await request.get('/api/cron/attendance-sync', { headers: { authorization } })
      expect(response.status(), `authorization "${authorization.slice(0, 6)}…"`).toBe(401)
    }
    expect(await countTestUploads()).toBe(0)
    expect(await countTestPunches()).toBe(0)
  })

  test('the correct secret is accepted', async ({ request }) => {
    setMockPunches(mockDays('9001', dates))
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
          { Name: 'A', Empcode: '9001', PunchDate: `${dates[0].split('-').reverse().join('/')} 07:40:00`, M_Flag: '', mcid: '1' },
          { Name: 'A', Empcode: '9001', PunchDate: 'garbage', M_Flag: '', mcid: '1' },
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
    setMockPunches([...mockDays('9001', dates), ...mockDays('9004', dates)])
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
    setMockPunches(mockDay('9001', '2020-01-02', FULL_DAY))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'FAILED', code: 'EMPTY' })
    expect(await getPunchRows(week.start, {})).toHaveLength(0)
  })
})

test.describe('E2E-05: Scheduled sync leaves an edited week alone', () => {
  test('keeps the edits, shows a newer-data notice and offers Pull now', async ({ request, page }) => {
    const employees = await prisma.employee.findMany({ where: { employeeId: 'E2E-HLP-9001' } })
    const anita = employees[0]
    // Pulled on Monday: one day of punches, the OUT edited from 17:47 to 18:00.
    const { id } = await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
          empCode: '9001',
          days: [{ date: dates[0], punches: FULL_DAY.map((time) => ({ time })) }],
        },
      ],
    })
    const edited = await prisma.attendancePunch.findFirstOrThrow({
      where: { attendanceUploadId: id, originalTime: '17:47' },
    })
    await prisma.attendancePunch.update({ where: { id: edited.id }, data: { currentTime: '18:00', note: 'Forgot to scan out' } })

    // Thursday: eTimeOffice now has the full week, and different times
    setMockPunches(mockDays('9001', dates, ['09:00', '17:00']))
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
    const inactive = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'E2E-HLP-9002' } })
    const { id } = await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: inactive.id, employeeId: inactive.employeeId, employeeName: inactive.employeeName },
          empCode: '9002',
          days: [{ date: dates[0], punches: [{ time: '08:00' }, { time: '16:00' }] }],
        },
      ],
    })
    await prisma.attendanceEmployeeDecision.create({
      data: { attendanceUploadId: id, employeeId: inactive.id, reason: 'INACTIVE', decision: 'APPROVED' },
    })
    setMockPunches(mockDays('9001', dates))
    const result = await runCron(request)
    expect(result.body).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS' })
    expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: id } })).toBe(1)
  })
})

test.describe('E2E-32: Scheduled sync replaces an unedited earlier pull', () => {
  test('the partial Monday pull is replaced by the full week', async ({ request, page }) => {
    const anita = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'E2E-HLP-9001' } })
    // Monday: only the first two days had happened
    await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: anita.id, employeeId: anita.employeeId, employeeName: anita.employeeName },
          empCode: '9001',
          days: dates.slice(0, 2).map((date) => ({ date, punches: FULL_DAY.map((time) => ({ time })) })),
        },
      ],
    })
    expect(new Set((await getPunchRows(week.start, {})).map((p) => p.date)).size).toBe(2)

    setMockPunches(mockDays('9001', dates))
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

// Fix round 3, item 4: the scheduled pull checks for edits and decisions before it calls the API (no
// lock), so an edit or a decision that lands while the call is running used to be replaced. The replace
// transaction now looks again under the week lock and, for a scheduled pull, leaves the week alone.
// The screens refuse edits while a pull runs (see pull-lock.spec.ts), so the change is written directly
// to the database, which is what an edit that slipped in just before the pull took its lock looks like.
test.describe('E2E-05 (round 3): an edit or decision that lands while the scheduled pull waits for the API', () => {
  const ANITA = 'E2E-HLP-9001'

  async function seedUntouchedWeek(employeeCode = ANITA, empCode = '9001') {
    const employee = await prisma.employee.findFirstOrThrow({ where: { employeeId: employeeCode } })
    return seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: employee.id, employeeId: employee.employeeId, employeeName: employee.employeeName },
          empCode,
          days: [{ date: dates[0], punches: FULL_DAY.map((time) => ({ time })) }],
        },
      ],
    })
  }

  /** Start the scheduled sync against a slow API and wait until the server holds the sync lock. */
  async function startSlowScheduledPull(request: Parameters<typeof runCron>[0], delayMs = 6000) {
    setMockScenario({
      status: 200,
      body: { Error: false, Msg: 'Success', IsAdmin: true, PunchData: mockDays('9001', dates, ['09:00', '17:00']) },
      delayMs,
    })
    const pending = runCron(request)
    await expect
      .poll(async () => (await getWeekRow(week.start))?.syncLockedAt ?? null, { timeout: 20000, intervals: [200] })
      .not.toBeNull()
    return { pending }
  }

  test('a punch edited during the call survives: SKIPPED_HAS_EDITS, notice shown, one SYNC audit row, no failure recorded', async ({ request, page }) => {
    test.setTimeout(90000)
    const { id } = await seedUntouchedWeek()
    const mondayPunches = await getPunchRows(week.start, {})
    expect(mondayPunches).toHaveLength(4)

    const { pending } = await startSlowScheduledPull(request)
    const outPunch = await prisma.attendancePunch.findFirstOrThrow({ where: { attendanceUploadId: id, originalTime: '17:47' } })
    await prisma.attendancePunch.update({ where: { id: outPunch.id }, data: { currentTime: '18:00', note: 'Edited during the pull' } })

    const result = await pending
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, outcome: 'SKIPPED_HAS_EDITS' })

    // The edit is intact and the earlier pull's punches were not replaced by the 09:00/17:00 ones.
    const after = await prisma.attendancePunch.findUniqueOrThrow({ where: { id: outPunch.id } })
    expect(after).toMatchObject({ originalTime: '17:47', currentTime: '18:00', note: 'Edited during the pull' })
    const punches = await getPunchRows(week.start, {})
    expect(punches).toHaveLength(4)
    expect(new Set(punches.map((p) => p.date))).toEqual(new Set([dates[0]]))
    expect(punches.some((p) => p.currentTime === '09:00')).toBe(false)

    // The week: still in review, the stale notice is set, the sync lock is released, and it is not a failure.
    const row = await getWeekRow(week.start)
    expect(row?.status).toBe('REVIEW')
    expect(row?.staleNoticeAt).not.toBeNull()
    expect(row?.syncLockedAt).toBeNull()
    expect(row?.lastSyncError).toBeNull()

    // Exactly one audit row for the run, saying it was skipped because of the edit.
    const audit = (await getAuditRows('ATTENDANCE_WEEK')).filter((a) => a.actionType === 'SYNC' || a.actionType === 'PULL')
    expect(audit).toHaveLength(1)
    expect(audit[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS', trigger: 'SCHEDULED', editedDays: 1, decisions: 0 })
    expect(JSON.stringify(audit.map((a) => a.detailsJson))).not.toContain('FAILED')

    await openAttendance(page)
    await expect(weekRow(page, week.start).getByTestId('week-stale-notice')).toContainText('Newer data may be available')
    await expect(weekRow(page, week.start).getByTestId('week-error')).toHaveCount(0)
    await expect(page.getByTestId(`pull-now-${week.start}`)).toBeVisible()
  })

  test('an employee decision recorded during the call also leaves the week alone', async ({ request }) => {
    test.setTimeout(90000)
    const inactive = await prisma.employee.findFirstOrThrow({ where: { employeeId: 'E2E-HLP-9002' } })
    const { id } = await seedReviewWeek({
      weekStartISO: week.start,
      rows: [
        {
          employee: { id: inactive.id, employeeId: inactive.employeeId, employeeName: inactive.employeeName },
          empCode: '9002',
          days: [{ date: dates[0], punches: [{ time: '08:00' }, { time: '16:00' }] }],
        },
      ],
    })
    expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: id } })).toBe(0)

    const { pending } = await startSlowScheduledPull(request)
    await prisma.attendanceEmployeeDecision.create({
      data: { attendanceUploadId: id, employeeId: inactive.id, reason: 'INACTIVE', decision: 'APPROVED' },
    })

    const result = await pending
    expect(result.body).toMatchObject({ ok: true, outcome: 'SKIPPED_HAS_EDITS' })
    expect(await prisma.attendanceEmployeeDecision.count({ where: { attendanceUploadId: id } })).toBe(1)
    expect(await getPunchRows(week.start, {})).toHaveLength(2) // the earlier pull is still there
    const row = await getWeekRow(week.start)
    expect(row?.staleNoticeAt).not.toBeNull()
    expect(row?.syncLockedAt).toBeNull()
    const audit = (await getAuditRows('ATTENDANCE_WEEK')).filter((a) => a.actionType === 'SYNC')
    expect(audit).toHaveLength(1)
    expect(audit[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS', editedDays: 0, decisions: 1 })
  })

  test('contrast: with nothing changed during the call the same slow pull replaces the week', async ({ request }) => {
    test.setTimeout(90000)
    await seedUntouchedWeek()

    const { pending } = await startSlowScheduledPull(request, 3000)
    const result = await pending

    expect(result.body).toMatchObject({ ok: true, outcome: 'LOADED' })
    const punches = await getPunchRows(week.start, {})
    expect(new Set(punches.map((p) => p.date))).toEqual(new Set(dates))
    const row = await getWeekRow(week.start)
    expect(row?.staleNoticeAt).toBeNull()
    expect(row?.syncLockedAt).toBeNull()
  })
})
