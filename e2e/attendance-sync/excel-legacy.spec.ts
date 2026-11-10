import { test, expect } from '@playwright/test'
import JSZip from 'jszip'
import prisma, { cleanupTestData, getAttendanceRecordHours, getWeekRow, seedApprovedPayrollData } from '../utils/db'
import { openAttendance, settled, weekRow } from '../utils/attendance-ui'
import { expectedCompletedWeek } from '../utils/etimeoffice-mock'
import { extractPdfFlatText } from '../utils/pdf'

// Weeks imported through the old Excel upload stay readable after F12 removes the upload: here the last completed
// week (always at the top of the week list, which shows only the newest weeks, and the newest approved week for
// the history page), two employees, an approved payroll run (revision 1). The real Excel weeks in the base are
// covered by the real-data suite.
//   Meera Krishnan  E2E-RPT-9001  46 regular + 6 overtime
//   Vijay Kumar     E2E-RPT-9002  56 regular

const WEEK = expectedCompletedWeek().start

let payrollRunId: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await cleanupTestData()
  const seed = await seedApprovedPayrollData({ source: 'EXCEL', weekStartISO: WEEK })
  payrollRunId = seed.payrollRunId
})

test.describe('E2E-27: Past Excel weeks stay readable', () => {
  test('the week list reads it as approved, names the file, and offers no Pull now or Reopen', async ({ page }) => {
    await openAttendance(page)
    const row = weekRow(page, WEEK)
    await expect(row).toHaveAttribute('data-source', 'EXCEL')
    await expect(row).toHaveAttribute('data-status', 'APPROVED')
    await expect(row.getByTestId('week-status-badge')).toHaveText(/Approved/)
    await expect(row.getByTestId('week-details')).toContainText('Excel upload')
    await expect(row.getByTestId('week-details')).toContainText('attendance-apr-wk1.xlsx')
    await expect(page.getByTestId(`pull-now-${WEEK}`)).toHaveCount(0)
    await expect(page.getByTestId(`review-link-${WEEK}`)).toHaveCount(0)
    await expect(page.getByTestId(`view-link-${WEEK}`)).toBeVisible()
  })

  test('the picker will not pull an Excel week', async ({ page }) => {
    await openAttendance(page)
    await page.getByTestId('load-past-week-button').click()
    const row = page.getByTestId(`week-picker-row-${WEEK}`)
    for (let i = 0; i < 40 && !(await row.isVisible()); i++) {
      await page.getByRole('button', { name: 'Previous month' }).click()
    }
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-disabled', 'true')
  })

  test('the read-only view shows the daily hours unchanged and has no edit, approve, pull or reopen', async ({ page }) => {
    await settled(page)
    await page.goto(`/attendance/${WEEK}/review`)
    await expect(page.getByTestId('excel-week-view')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('excel-read-only-note')).toBeVisible()
    await expect(page.getByTestId('excel-source')).toContainText('attendance-apr-wk1.xlsx')
    await expect(page.getByTestId('excel-row-E2E-RPT-9001')).toContainText('Meera Krishnan')
    await expect(page.getByTestId('excel-row-E2E-RPT-9002')).toContainText('Vijay Kumar')
    // Hours as imported: 46 + 6 and 56
    await expect(page.getByTestId('excel-row-E2E-RPT-9001')).toContainText('46.00')
    await expect(page.getByTestId('excel-row-E2E-RPT-9002')).toContainText('56.00')

    for (const id of ['approve-week-button', 'reopen-week-button', 'punch-grid', 'day-editor']) {
      await expect(page.getByTestId(id)).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: /pull now/i })).toHaveCount(0)
    await expect(page.locator('input')).toHaveCount(0)
  })

  test('the employee check redirects to the read-only view for an Excel week', async ({ page }) => {
    await page.goto(`/attendance/${WEEK}/employee-check`)
    await expect(page).toHaveURL(new RegExp(`/attendance/${WEEK}/review$`))
    await expect(page.getByTestId('excel-week-view')).toBeVisible()
  })

  test('the data is unchanged and the payroll run and history still open', async ({ page }) => {
    const hours = await getAttendanceRecordHours(WEEK)
    expect(hours).toHaveLength(14)
    expect(hours.filter((h) => h.employeeCode === 'E2E-RPT-9001').reduce((s, h) => s + h.regularHours, 0)).toBe(46)
    expect(hours.filter((h) => h.employeeCode === 'E2E-RPT-9001').reduce((s, h) => s + h.overtimeHours, 0)).toBe(6)
    const row = await getWeekRow(WEEK)
    expect(row?.source).toBe('EXCEL')
    expect(row?.status).toBe('READY')
    expect(row?.fileName).toBe('attendance-apr-wk1.xlsx')
    expect(await prisma.attendancePunch.count({ where: { attendanceUploadId: row!.id } })).toBe(0)

    await page.goto('/history')
    await expect(page.locator('h1:has-text("Payroll History")')).toBeVisible()
    await expect(page.locator('text=Meera Krishnan')).toBeVisible()
    await settled(page)
    await page.goto(`/payroll/run/${payrollRunId}`)
    await expect(page.locator('text=Approved (Revision 1)')).toBeVisible({ timeout: 10000 })
    // The run's attendance link opens the read-only view
    await page.locator(`main a[href="/attendance/${WEEK}/review"]`).click()
    await expect(page.getByTestId('excel-week-view')).toBeVisible({ timeout: 15000 })
  })

  test('slips keep the six-column layout: BN, AN and OT In/Out and no Punches column', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/slips`)
    expect(response.status()).toBe(200)
    const zip = await JSZip.loadAsync(await response.body())
    const pdfs = Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.pdf'))
    expect(pdfs).toHaveLength(2)
    for (const name of pdfs) {
      const text = extractPdfFlatText(await zip.files[name].async('nodebuffer'))
      for (const header of ['BN In', 'BN Out', 'AN In', 'AN Out', 'OT In', 'OT Out']) {
        expect(text, `${name} should have "${header}"`).toContain(header)
      }
      expect(text, name).not.toContain('Punches')
      expect(text, name).toContain('Reg Hrs')
    }
  })

  test('the correction flow offers adjustments but not an attendance correction', async ({ page }) => {
    await settled(page)
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.getByRole('button', { name: 'Correct', exact: true }).click()
    await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })

    const attendance = page.locator('label:has-text("Attendance")')
    await expect(attendance.locator('input[type="checkbox"]')).toBeDisabled()
    await expect(attendance).toContainText("Attendance can't be corrected for an Excel-era week")

    // Adjustment-only corrections still work on the Excel-era run
    await page.click('text=Employee data updated')
    await page.getByRole('button', { name: /Recalculate/ }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
    await page.getByRole('button', { name: 'Approve Revision' }).click()
    await page.getByRole('button', { name: 'Confirm Revision' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await expect(page.locator('text=Approved (Revision 2)')).toBeVisible({ timeout: 10000 })
  })
})

test.describe('E2E-28: Excel upload is gone', () => {
  test('the Attendance page offers no file upload', async ({ page }) => {
    await openAttendance(page)
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
    await expect(page.getByText(/drop .*file|drag .*file|choose .*file/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /upload/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /upload/i })).toHaveCount(0)
    // What the page offers instead: the sync state of each week
    await expect(page.getByTestId('load-past-week-button')).toBeVisible()
  })

  test('the correction flow offers no file upload', async ({ page }) => {
    await settled(page)
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.getByRole('button', { name: 'Correct', exact: true }).click()
    await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
    await expect(page.getByText(/upload/i)).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel Correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 20000 })
  })

  test('the previous upload routes no longer exist', async ({ page, request }) => {
    for (const path of [
      `/attendance/${WEEK}/preview`,
      '/attendance/some-upload-id/preview',
      '/attendance/upload',
    ]) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(404)
    }
    // The old preview page is not served in the browser either
    await settled(page)
    const response = await page.goto('/attendance/some-upload-id/preview')
    expect(response?.status()).toBe(404)
  })

  test('/employees/new works without an upload session, and ignores a leftover session parameter', async ({ page }) => {
    await settled(page)
    await page.goto('/employees/new')
    await expect(page.getByPlaceholder('EMP-042')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: 'Save Employee' })).toBeVisible()
    await expect(page.getByText(/upload|attendance preview/i)).toHaveCount(0)

    await page.goto('/employees/new?attendanceSession=leftover-session-id')
    await expect(page.getByPlaceholder('EMP-042')).toBeVisible({ timeout: 15000 })
    await expect(page.getByPlaceholder('Lakshmi Venkatesh')).toHaveValue('')
    await expect(page.getByRole('button', { name: /Return to/ })).toHaveCount(0)
  })

  test('an external returnTo is ignored on /employees/new', async ({ page }) => {
    await settled(page)
    await page.goto('/employees/new?returnTo=https://evil.example/&name=Someone')
    await expect(page.getByPlaceholder('EMP-042')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: /Return to/ })).toHaveCount(0)
  })
})
