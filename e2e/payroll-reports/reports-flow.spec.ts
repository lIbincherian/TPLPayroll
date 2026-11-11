import { test, expect } from '@playwright/test'
import {
  cleanupDatabase,
  seedApprovedPayrollData,
  getInvoiceSnapshotCount,
  getCleanedSnapshotCount,
} from '../utils/db'

let payrollRunId: string

test.beforeAll(async () => {
  try {
    await cleanupDatabase()
    const seed = await seedApprovedPayrollData()
    payrollRunId = seed.payrollRunId
    console.log('Using payrollRunId:', payrollRunId);
  } catch (err) {
    throw err;
  }
})

// ─── E2E-01: Generate dual-format payroll summary ─────────────────────────────

test.describe('E2E-01: Dual-format payroll summary API', () => {
  test('GET /api/payroll/reports/:id/summary (default) returns a valid Excel sheet', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/summary`)

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    const body = await response.body()
    // Every valid XLSX (ZIP) file starts with the PK header bytes
    expect(body[0]).toBe(0x50) // 'P'
    expect(body[1]).toBe(0x4B) // 'K'
  })

  test('GET /api/payroll/reports/:id/summary?format=xlsx returns a valid Excel sheet', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/summary?format=xlsx`)

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    const body = await response.body()
    expect(body[0]).toBe(0x50) // 'P'
    expect(body[1]).toBe(0x4B) // 'K'
  })

  test('GET /api/payroll/reports/:id/summary?format=pdf returns a valid PDF', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/summary?format=pdf`)

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/pdf')

    const body = await response.body()
    // Every valid PDF starts with the %PDF header
    expect(body.toString('ascii', 0, 4)).toBe('%PDF')
  })

  test('Content-Disposition header names the file correctly based on format', async ({ request }) => {
    const responseXlsx = await request.get(`/api/payroll/reports/${payrollRunId}/summary?format=xlsx`)
    expect(responseXlsx.headers()['content-disposition']).toMatch(/filename="payroll_summary_.*\.xlsx"/)

    const responsePdf = await request.get(`/api/payroll/reports/${payrollRunId}/summary?format=pdf`)
    expect(responsePdf.headers()['content-disposition']).toMatch(/filename="payroll_summary_.*\.pdf"/)
  })

  test('returns 404 for a non-existent payrollRunId', async ({ request }) => {
    const response = await request.get('/api/payroll/reports/non-existent-run-id/summary')
    expect(response.status()).toBe(404)
    const body = await response.json()
    expect(body.code).toBe('PAYROLL_RUN_NOT_FOUND')
  })
})

// ─── E2E-02: Generate payroll slips ZIP ───────────────────────────────────────

test.describe('E2E-02: Payroll slips ZIP API', () => {
  test('GET /api/payroll/reports/:id/slips returns a valid ZIP', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/slips`)

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/zip')

    const body = await response.body()
    // ZIP magic bytes: PK (0x50 0x4B 0x03 0x04)
    expect(body[0]).toBe(0x50) // 'P'
    expect(body[1]).toBe(0x4B) // 'K'
  })

  test('returns 404 for a non-existent payrollRunId', async ({ request }) => {
    const response = await request.get('/api/payroll/reports/non-existent-run-id/slips')
    expect(response.status()).toBe(404)
  })
})

// ─── E2E-04: ZIP file naming follows pattern ──────────────────────────────────

test.describe('E2E-04: ZIP filename pattern', () => {
  test('Content-Disposition matches payroll_slips_<startDate>_<endDate>.zip', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/slips`)
    const disposition = response.headers()['content-disposition']

    // e.g. filename="payroll_slips_03Apr_09Apr.zip"
    expect(disposition).toMatch(/filename="payroll_slips_\d{2}[A-Za-z]{3}_\d{2}[A-Za-z]{3}\.zip"/)
  })

  test('filename matches the seeded week (Apr 3–9 2025)', async ({ request }) => {
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/slips`)
    const disposition = response.headers()['content-disposition']
    expect(disposition).toContain('payroll_slips_03Apr_09Apr.zip')
  })
})

// ─── E2E-05: InvoiceSnapshot data is stored ───────────────────────────────────

test.describe('E2E-05: InvoiceSnapshot records', () => {
  test('calling the slips endpoint creates one InvoiceSnapshot per employee', async ({ request }) => {
    // Trigger ZIP generation (creates snapshots as a side-effect)
    const response = await request.get(`/api/payroll/reports/${payrollRunId}/slips`)
    expect(response.status()).toBe(200)

    // 2 employees seeded → 2 snapshots
    const count = await getInvoiceSnapshotCount(payrollRunId)
    expect(count).toBe(2)
  })

  test('snapshots are idempotent — re-generating does not duplicate records', async ({ request }) => {
    await request.get(`/api/payroll/reports/${payrollRunId}/slips`)
    await request.get(`/api/payroll/reports/${payrollRunId}/slips`)

    const count = await getInvoiceSnapshotCount(payrollRunId)
    expect(count).toBe(2)
  })
})

// ─── E2E-06: Temporary files are cleaned up ───────────────────────────────────

test.describe('E2E-06: Cleanup endpoint', () => {
  test('POST /cleanup sets temporaryFileDeletedAt on all snapshots', async ({ request }) => {
    // Ensure snapshots exist first
    await request.get(`/api/payroll/reports/${payrollRunId}/slips`)

    const cleanupResponse = await request.post(
      `/api/payroll/reports/${payrollRunId}/cleanup`,
    )
    expect(cleanupResponse.status()).toBe(200)
    const body = await cleanupResponse.json()
    expect(body.ok).toBe(true)

    // All snapshots should now have a cleanup timestamp
    const cleaned = await getCleanedSnapshotCount(payrollRunId)
    expect(cleaned).toBe(2)
  })
})

// ─── UI: Payroll run detail page shows ReportSection ─────────────────────────

test.describe('UI: Payroll run detail page', () => {
  test('navigating to /payroll/run/:id shows the Reports section', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)

    await expect(page.locator('text=Approved')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('text=Reports')).toBeVisible()
    await expect(page.getByRole('button', { name: /Download Summary/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Generate & Download ZIP/i })).toBeVisible()
  })

  test('clicking Download Summary directly triggers Excel download', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.waitForSelector('text=Reports', { timeout: 8000 })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.getByRole('button', { name: /Download Summary/i }).click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  })

  test('opening dropdown and selecting PDF triggers PDF download', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.waitForSelector('text=Reports', { timeout: 8000 })

    // Open dropdown by clicking the caret button
    await page.getByRole('button', { name: /Select summary report format/i }).click()

    // Click PDF option inside the dropdown
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.getByRole('button', { name: /Download as PDF/i }).click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.pdf$/)
  })

  test('opening dropdown and selecting Excel triggers Excel download', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.waitForSelector('text=Reports', { timeout: 8000 })

    // Open dropdown by clicking the caret button
    await page.getByRole('button', { name: /Select summary report format/i }).click()

    // Click Excel option inside the dropdown
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.getByRole('button', { name: /Download as Excel/i }).click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  })

  test('clicking Generate & Download ZIP shows a progress bar and triggers download', async ({
    page,
  }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.waitForSelector('text=Reports', { timeout: 8000 })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.getByRole('button', { name: /Generate & Download ZIP/i }).click(),
    ])

    // Progress bar appears while loading
    await expect(page.locator('.bg-emerald-500.rounded-full')).toBeVisible({ timeout: 3000 })

    expect(download.suggestedFilename()).toMatch(/\.zip$/)
  })

  test('shows payroll summary table with employee data', async ({ page }) => {
    await page.goto(`/payroll/run/${payrollRunId}`)
    await page.waitForSelector('text=Payroll Summary', { timeout: 8000 })

    await expect(page.locator('text=Meera Krishnan')).toBeVisible()
    await expect(page.locator('text=Vijay Kumar')).toBeVisible()
    await expect(page.locator('text=EMP-RPT-001')).toBeVisible()
    await expect(page.locator('text=EMP-RPT-002')).toBeVisible()
  })

  test('returns 404 for a non-existent payroll run', async ({ page }) => {
    const response = await page.goto('/payroll/run/non-existent-id')
    expect(response?.status()).toBe(404)
  })
})
