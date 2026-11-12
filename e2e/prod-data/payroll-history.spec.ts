import { test, expect } from '@playwright/test'
import { approvedRuns, realDataLoaded, snapshotRows } from './snapshot'

// Payroll history on the real data: every approved run in the snapshot is listed, and each week shows exactly
// its current revision's payroll rows. Expectations come from the snapshot files; no name, ID or amount is
// written here or printed.

test.skip(() => !realDataLoaded(), 'needs the real-data base (e2e/prod-snapshot/ loaded by global setup)')
test.describe.configure({ mode: 'serial' })

test('the week filter offers every approved week of the snapshot, newest first', async ({ page }) => {
  const weeks = [...new Set(approvedRuns().map((r) => r.weekStart))]
  expect(weeks.length).toBeGreaterThan(0)

  await page.goto('/history')
  await expect(page.locator('h1:has-text("Payroll History")')).toBeVisible()
  const options = page.locator('select option')
  // "All Weeks" and then one option per distinct approved week
  await expect(options).toHaveCount(weeks.length + 1)
  const values = await options.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
  expect(values.slice(1).map((v) => v.slice(0, 10))).toEqual(weeks)
})

test('each approved week lists exactly the rows of its current revision', async ({ page }) => {
  test.setTimeout(300000)
  const runs = approvedRuns()
  const mismatches: string[] = []
  for (const run of runs) {
    expect(run.currentRevisionId, 'an approved run has a current revision').not.toBeNull()
    const week = encodeURIComponent(`${run.weekStart}T00:00:00.000Z_${run.weekEnd}T00:00:00.000Z`)
    await page.goto(`/history?week=${week}`)
    await expect(page.locator('h1:has-text("Payroll History")')).toBeVisible()
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
    const shown = await page.locator('tbody tr').count()
    if (shown !== run.currentEmployeeCount) mismatches.push(`${run.weekStart}: shown ${shown}, snapshot ${run.currentEmployeeCount}`)
  }
  expect(mismatches, 'weeks whose row count differs from the snapshot').toEqual([])
})

test('searching a real employee ID finds that employee in every week they were paid', async ({ page }) => {
  // The employee with the most payroll rows in current revisions: a search must return all of them
  const currentRevisions = new Set(approvedRuns().map((r) => r.currentRevisionId))
  const runIds = new Set(approvedRuns().map((r) => r.id))
  const perEmployee = new Map<string, number>()
  for (const row of snapshotRows('PayrollRunEmployee')) {
    if (runIds.has(row.payrollRunId) && currentRevisions.has(row.payrollRevisionId)) {
      perEmployee.set(row.employeeId, (perEmployee.get(row.employeeId) ?? 0) + 1)
    }
  }
  const [employeeKey, rowCount] = [...perEmployee.entries()].sort((a, b) => b[1] - a[1])[0]
  const code = snapshotRows('Employee').find((e) => e.id === employeeKey)!.employeeId as string

  // The page matches the search text anywhere in an Employee ID, so expect every employee whose ID contains it
  const matching = new Set(
    snapshotRows('Employee')
      .filter((e) => (e.employeeId as string).toLowerCase().includes(code.toLowerCase()))
      .map((e) => e.id as string),
  )
  let expected = 0
  for (const [key, count] of perEmployee) if (matching.has(key)) expected += count
  expect(expected).toBeGreaterThanOrEqual(rowCount)

  await page.goto(`/history?search=${encodeURIComponent(code)}`)
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  expect(await page.locator('tbody tr').count()).toBe(expected)
})
