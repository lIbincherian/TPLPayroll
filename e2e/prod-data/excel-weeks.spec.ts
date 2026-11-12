import { test, expect } from '@playwright/test'
import JSZip from 'jszip'
import { extractPdfFlatText } from '../utils/pdf'
import { restoreRowsFromBase } from './base-restore'
import { activeWeeks, approvedRuns, realDataLoaded, weekHours } from './snapshot'

// An Excel-era week on the real data: the newest snapshot week that has an approved payroll run. It opens
// read-only (no Pull, Reopen, approval, editing or attendance correction), the payroll run links back to it,
// and the slips ZIP keeps the six-column layout of that era. Every expectation is derived from the snapshot;
// no name is read out or printed.

test.skip(() => !realDataLoaded(), 'needs the real-data base (e2e/prod-snapshot/ loaded by global setup)')
test.describe.configure({ mode: 'serial' })

function target() {
  const runs = new Map(approvedRuns().map((r) => [r.weekStart, r]))
  const week = activeWeeks().find((w) => runs.has(w.weekStart))
  if (!week) throw new Error('the snapshot has no Excel week with an approved payroll run')
  return { week, run: runs.get(week.weekStart)! }
}

// The slips download rebuilds that run's invoice snapshots; put the base's rows back so the base stays exact.
test.afterAll(async () => {
  if (realDataLoaded()) await restoreRowsFromBase('InvoiceSnapshot', '"payrollRunId" = $1', [target().run.id])
})

test('the week opens read-only: its hours are shown, with no approve, reopen, pull or editing', async ({ page }) => {
  const { week } = target()
  const hours = weekHours(week.uploadId)

  await page.goto(`/attendance/${week.weekStart}/review`)
  await expect(page.getByTestId('excel-week-view')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('excel-read-only-note')).toBeVisible()
  if (week.fileName) await expect(page.getByTestId('excel-source')).toContainText(week.fileName)

  // The summary and the grid agree with the snapshot's attendance records for the week
  await expect(page.getByTestId('excel-employees')).toHaveText(String(hours.employees))
  const grouped = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  await expect(page.getByTestId('excel-regular')).toHaveText(grouped.format(hours.regular))
  await expect(page.getByTestId('excel-overtime')).toHaveText(grouped.format(hours.overtime))
  await expect(page.locator('[data-testid^="excel-row-"]')).toHaveCount(hours.employees)

  for (const id of ['approve-week-button', 'reopen-week-button', 'punch-grid', 'day-editor']) {
    await expect(page.getByTestId(id)).toHaveCount(0)
  }
  await expect(page.getByRole('button', { name: /pull now/i })).toHaveCount(0)
  await expect(page.locator('input')).toHaveCount(0)
})

test('the employee check sends an Excel week to the read-only view', async ({ page }) => {
  const { week } = target()
  await page.goto(`/attendance/${week.weekStart}/employee-check`)
  await expect(page).toHaveURL(new RegExp(`/attendance/${week.weekStart}/review$`))
  await expect(page.getByTestId('excel-week-view')).toBeVisible()
})

test('the payroll run links to the read-only week, which links back to the run', async ({ page }) => {
  const { week, run } = target()
  await page.goto(`/payroll/run/${run.id}`)
  await expect(page.getByRole('button', { name: 'Correct', exact: true })).toBeVisible({ timeout: 15000 })
  await page.locator(`main a[href="/attendance/${week.weekStart}/review"]`).click()
  await expect(page.getByTestId('excel-week-view')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('open-payroll-run')).toHaveAttribute('href', `/payroll/run/${run.id}`)
})

test('the slips ZIP has one slip per paid employee and keeps the six-column layout, no Punches column', async ({ request }) => {
  const { run } = target()
  const response = await request.get(`/api/payroll/reports/${run.id}/slips`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/zip')

  const zip = await JSZip.loadAsync(await response.body())
  const pdfs = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith('.pdf'))
  expect(pdfs).toHaveLength(run.currentEmployeeCount)

  // Reading every PDF adds minutes for no more coverage: the layout is the same for all, check a spread
  const sample = pdfs.filter((_, i) => i % Math.max(1, Math.floor(pdfs.length / 8)) === 0).slice(0, 8)
  for (const [index, name] of sample.entries()) {
    const text = extractPdfFlatText(await zip.files[name].async('nodebuffer'))
    for (const header of ['BN In', 'BN Out', 'AN In', 'AN Out', 'OT In', 'OT Out', 'Reg Hrs']) {
      expect(text.includes(header), `slip #${index} has "${header}"`).toBe(true)
    }
    expect(text.includes('Punches'), `slip #${index} has no Punches column`).toBe(false)
  }
})
