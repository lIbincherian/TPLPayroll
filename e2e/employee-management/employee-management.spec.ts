import { test, expect } from '@playwright/test'
import prisma from '../../src/lib/prisma'
import { cleanupDatabase } from '../utils/db'

test.beforeAll(async () => {
  // 1. Cleanup existing database records
  await cleanupDatabase()

  // 2. Seed 12 employees with precise names, designations, sites, and statuses
  const employeesData = [
    { employeeId: 'EMP001', employeeName: 'Amit Sharma', designation: 'Security Officer', site: 'North Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP002', employeeName: 'Bala Krishnan', designation: 'Security Guard', site: 'South Gate', isActive: false, dateOfResignation: null },
    { employeeId: 'EMP003', employeeName: 'Chitra Nair', designation: 'Security Guard', site: 'East Gate', isActive: true, dateOfResignation: new Date('2025-03-01T00:00:00Z') },
    { employeeId: 'EMP004', employeeName: 'Deepak Sen', designation: 'Supervisor', site: 'North Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP005', employeeName: 'Esha Gupta', designation: 'Supervisor', site: 'South Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP006', employeeName: 'Farhan Syed', designation: 'Security Guard', site: 'East Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP007', employeeName: 'Gita Patel', designation: 'Security Guard', site: 'North Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP008', employeeName: 'Hari Prasad', designation: 'Security Officer', site: 'South Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP009', employeeName: 'Indira Devi', designation: 'Security Guard', site: 'East Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP010', employeeName: 'Jatin Shah', designation: 'Supervisor', site: 'North Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP011', employeeName: 'Kiran Rao', designation: 'Security Guard', site: 'South Gate', isActive: true, dateOfResignation: null },
    { employeeId: 'EMP012', employeeName: 'Lata Mangesh', designation: 'Security Guard', site: 'East Gate', isActive: true, dateOfResignation: null },
  ]

  for (const empData of employeesData) {
    await prisma.employee.create({
      data: {
        employeeId: empData.employeeId,
        employeeName: empData.employeeName,
        designation: empData.designation,
        site: empData.site,
        isActive: empData.isActive,
        dateOfResignation: empData.dateOfResignation,
        wageHistory: {
          create: {
            weeklySalary: 5000,
            hourlyRate: 100,
            effectiveFrom: new Date('2025-01-01T00:00:00Z'),
            changeSource: 'SEED',
          },
        },
      },
    })
  }
})

test.describe('E02: Sorting, Filtering, and Pagination E2E Tests', () => {

  test.beforeEach(async ({ page }) => {
    // Navigate to Team Directory page
    await page.goto('/employees')
    await expect(page.locator('h1:has-text("Team Directory")')).toBeVisible({ timeout: 10000 })
  })

  // ─── Column Sorting ───────────────────────────────────────────────────────
  test('E2E-02.1: Column sorting by Name ascending/descending', async ({ page }) => {
    // Default is sorting by Name ascending. Verify alphabetical names.
    // Top names: Amit Sharma, Bala Krishnan, Chitra Nair, Deepak Sen, ...
    const rows = page.locator('tbody tr')
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('Amit Sharma')
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('Bala Krishnan')

    // Click "Name" column header to toggle sorting to descending
    const nameHeader = page.locator('button:has-text("Name")')
    await nameHeader.click()
    await page.waitForTimeout(500) // wait for transition/debounce

    // Verify alphabetical names descending.
    // Alphabetically: Lata Mangesh, Kiran Rao, Jatin Shah, Indira Devi, ...
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('Lata Mangesh')
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('Kiran Rao')
    
    // Verify carets
    await expect(nameHeader.locator('svg')).toBeVisible()
  })

  test('E2E-02.2: Column sorting by ID ascending/descending', async ({ page }) => {
    // Click ID column header to sort by ID ascending
    const idHeader = page.locator('button:has-text("ID")')
    await idHeader.click()
    await page.waitForTimeout(500)

    const rows = page.locator('tbody tr')
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('EMP001')
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('EMP002')

    // Click ID column header again to sort by ID descending
    await idHeader.click()
    await page.waitForTimeout(500)

    // With 12 seeded employees, EMP012 is top, then EMP011, etc.
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('EMP012')
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('EMP011')
  })

  test('E2E-02.3: Sorting resets page to 1 and clears selections', async ({ page }) => {
    // Select first row checkbox
    const firstCheckbox = page.locator('tbody tr input[type="checkbox"]').first()
    await firstCheckbox.check()
    await expect(firstCheckbox).toBeChecked()

    // Sort by ID
    const idHeader = page.locator('button:has-text("ID")')
    await idHeader.click()
    await page.waitForTimeout(500)

    // Selection should be cleared
    await expect(firstCheckbox).not.toBeChecked()

    // Navigate to page 2 first
    const page2Button = page.locator('button:has-text("2")')
    await page2Button.click()
    await page.waitForTimeout(500)
    
    // Verify we are showing 11-12 of 12 (page 2)
    await expect(page.locator('text=Showing 11–12 of 12')).toBeVisible()

    // Click Name to sort
    const nameHeader = page.locator('button:has-text("Name")')
    await nameHeader.click()
    await page.waitForTimeout(500)

    // Verify page is reset to 1
    await expect(page.locator('text=Showing 1–10 of 12')).toBeVisible()
  })

  // ─── Categorical Filtering ────────────────────────────────────────────────
  test('E2E-02.4: Filters by Designation', async ({ page }) => {
    const designationFilter = page.locator('select#employee-designation-filter')
    await expect(designationFilter).toBeVisible()

    // Select "Security Officer"
    await designationFilter.selectOption('Security Officer')
    await page.waitForTimeout(500)

    // There should be exactly 2 security officers seeded (Amit Sharma, Hari Prasad)
    await expect(page.locator('text=Showing 1–2 of 2')).toBeVisible()
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('Amit Sharma')
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('Hari Prasad')
  })

  test('E2E-02.5: Filters by Site', async ({ page }) => {
    const siteFilter = page.locator('select#employee-site-filter')
    await expect(siteFilter).toBeVisible()

    // Select "East Gate"
    await siteFilter.selectOption('East Gate')
    await page.waitForTimeout(500)

    // East Gate has 4 employees (Chitra Nair, Farhan Syed, Indira Devi, Lata Mangesh)
    await expect(page.locator('text=Showing 1–4 of 4')).toBeVisible()
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(4)
  })

  test('E2E-02.6: Filters stack together with AND logic', async ({ page }) => {
    // Select Designation = "Supervisor" AND Site = "South Gate"
    const designationFilter = page.locator('select#employee-designation-filter')
    const siteFilter = page.locator('select#employee-site-filter')

    await designationFilter.selectOption('Supervisor')
    await siteFilter.selectOption('South Gate')
    await page.waitForTimeout(500)

    // Exactly 1 supervisor at South Gate (Esha Gupta)
    await expect(page.locator('text=Showing 1–1 of 1')).toBeVisible()
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('Esha Gupta')
  })

  test('E2E-02.7: Filters reset page to 1', async ({ page }) => {
    // Navigate to page 2 first
    const page2Button = page.locator('button:has-text("2")')
    await page2Button.click()

    await expect(page.locator('text=Showing 11–12 of 12')).toBeVisible({ timeout: 5000 })

    // Change Site filter
    const siteFilter = page.locator('select#employee-site-filter')
    await siteFilter.selectOption('North Gate')

    // Verify page resets to 1 (North Gate has 4 employees, showing 1-4 of 4)
    await expect(page.locator('text=Showing 1–4 of 4')).toBeVisible({ timeout: 5000 })
  })

  // ─── Dynamic Pagination ───────────────────────────────────────────────────
  test('E2E-02.8: Pagination controls and sliding window page range', async ({ page }) => {
    // Total count is 12 (shows Page 1 and Page 2 buttons)
    const page1Button = page.locator('button:has-text("1")')
    const page2Button = page.locator('button:has-text("2")')
    await expect(page1Button).toBeVisible()
    await expect(page2Button).toBeVisible()

    // Page 1 is active (styled with bg-emerald-50)
    await expect(page1Button).toHaveClass(/bg-emerald-50/)

    // Click Page 2 button
    await page2Button.click()

    // Table updates to page 2 (showing 11–12 of 12)
    await expect(page.locator('text=Showing 11–12 of 12')).toBeVisible({ timeout: 5000 })
    await expect(page2Button).toHaveClass(/bg-emerald-50/)
  })
})
