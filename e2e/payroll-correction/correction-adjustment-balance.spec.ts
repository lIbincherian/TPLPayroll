import { test, expect, type Page } from '@playwright/test'
import prisma, {
  cleanupTestData,
  seedApprovedPayrollForCorrection,
  getCorrectionSessions,
  getPayrollRunStatus,
  getRevisionEmployees,
  getRevisions,
} from '../utils/db'
import { clearMockScenario } from '../utils/etimeoffice-mock'
import { settled } from '../utils/attendance-ui'

// Final fix round, the correction's money path through the browser.
//
// While a correction is open, approving or skipping an adjustment only changes its status. The balance of the
// adjustment moves once, when the revision is approved, from how the application was before the correction
// against how it ends up. Abandoning moves nothing.
//
// Seed: week 17-23 Apr 2025, revision 1 current (see seedApprovedPayrollForCorrection).
//   Anita Sharma  E2E-COR-9001  3250 gross, a 500 deduction applied by the original approval -> net 2750
//   Rajesh Iyer   E2E-COR-9002  4200 gross, no deduction applied -> net 4200
// This spec turns Anita's seeded deduction into a TOTAL_BALANCE one of 2000 at 500 a week (1500 left after the 500 it
// applied), and gives Rajesh a 500-a-week deduction of 2000 that nobody approved (PENDING, 2000 left).

const WEEK = '2025-04-17'
const NEXT_WEEK = '2025-04-24'
const ANITA = 'E2E-COR-9001'
const RAJESH = 'E2E-COR-9002'

let payrollRunId: string
let anitaAdjustmentId: string
let anitaApplicationId: string
let rajeshAdjustmentId: string
let rajeshApplicationId: string

test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  clearMockScenario()
  await cleanupTestData()
  const seed = await seedApprovedPayrollForCorrection()
  payrollRunId = seed.payrollRunId
  anitaApplicationId = seed.adjustmentApplicationId
  anitaAdjustmentId = (await prisma.payrollAdjustmentApplication.findUniqueOrThrow({ where: { id: anitaApplicationId } })).payrollAdjustmentId
  await prisma.payrollAdjustment.update({
    where: { id: anitaAdjustmentId },
    data: { recurrenceType: 'RECURRING', recurrenceEndType: 'TOTAL_BALANCE', totalBalance: 2000, remainingBalance: 1500 },
  })

  const rajesh = await prisma.employee.findFirstOrThrow({ where: { employeeId: RAJESH } })
  const created = await prisma.payrollAdjustment.create({
    data: {
      employeeId: rajesh.id,
      adjustmentType: 'DEDUCTION',
      recurrenceType: 'RECURRING',
      recurrenceEndType: 'TOTAL_BALANCE',
      amount: 500,
      totalBalance: 2000,
      remainingBalance: 2000,
      reason: 'Uniform recovery seed',
      startPayrollWeekStartDate: new Date(`${WEEK}T00:00:00.000Z`),
      startPayrollWeekEndDate: new Date('2025-04-23T00:00:00.000Z'),
      status: 'ACTIVE',
      skippedCarryForwardCount: 0,
    },
  })
  rajeshAdjustmentId = created.id
  rajeshApplicationId = (
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: created.id,
        employeeId: rajesh.id,
        payrollWeekStartDate: new Date(`${WEEK}T00:00:00.000Z`),
        payrollWeekEndDate: new Date('2025-04-23T00:00:00.000Z'),
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    })
  ).id
})

test.afterAll(() => {
  clearMockScenario()
})

const adjustment = async (id: string) => {
  const row = await prisma.payrollAdjustment.findUniqueOrThrow({ where: { id } })
  return {
    status: row.status,
    remaining: row.remainingBalance === null ? null : Number(row.remainingBalance),
    carried: row.skippedCarryForwardCount,
  }
}
const application = async (id: string) => {
  const row = await prisma.payrollAdjustmentApplication.findUniqueOrThrow({ where: { id } })
  return {
    status: row.approvalStatus,
    amount: Number(row.appliedAmount),
    carriedTo: row.carriedForwardToPayrollWeekStartDate?.toISOString().slice(0, 10) ?? null,
  }
}
const nextWeekApplications = (adjustmentId: string) =>
  prisma.payrollAdjustmentApplication.findMany({ where: { payrollAdjustmentId: adjustmentId, payrollWeekStartDate: new Date(`${NEXT_WEEK}T00:00:00.000Z`) } })
const applicationCount = (adjustmentId: string) => prisma.payrollAdjustmentApplication.count({ where: { payrollAdjustmentId: adjustmentId } })

const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) })

/** Click Correct, tick Adjustments and wait for the week's applications. */
async function openAdjustments(page: Page, reason: string) {
  await settled(page)
  await page.goto(`/payroll/run/${payrollRunId}`)
  await page.getByRole('button', { name: 'Correct', exact: true }).click()
  await expect(page.locator('h1:has-text("Payroll Correction")')).toBeVisible({ timeout: 15000 })
  await page.fill('#correction-reason', reason)
  await page.locator('label:has-text("Adjustments")').click()
  await expect(row(page, 'Anita Sharma')).toBeVisible({ timeout: 8000 })
  await expect(row(page, 'Rajesh Iyer')).toBeVisible()
}

async function recalculate(page: Page) {
  await page.getByRole('button', { name: /Recalculate/ }).click()
  await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}/correct/preview`), { timeout: 30000 })
  await settled(page)
}

test.describe('Adjustment balances move once, when the revision is approved', () => {
  test('skip an applied deduction and approve a pending one: nothing moves while the correction is open, then each balance settles once', async ({ page }) => {
    // Before: Anita 1500 left (the 500 applied, APPROVED); Rajesh 2000 left (PENDING).
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })

    await openAdjustments(page, 'Anita deduction was wrong, Rajesh uniform recovery was missed')
    // The week's applications are reset to Pending for re-evaluation (a status only).
    await expect(row(page, 'Anita Sharma').getByText('Pending')).toBeVisible()
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Skip' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Skipped')).toBeVisible({ timeout: 8000 })
    await row(page, 'Rajesh Iyer').getByRole('button', { name: 'Approve' }).click()
    await expect(row(page, 'Rajesh Iyer').getByText('Approved')).toBeVisible({ timeout: 8000 })

    // The statuses changed; the balances, the status of the adjustments and the carry-forward did not.
    await settled(page)
    expect(await application(anitaApplicationId)).toEqual({ status: 'SKIPPED', amount: 500, carriedTo: null })
    expect(await application(rajeshApplicationId)).toEqual({ status: 'APPROVED', amount: 500, carriedTo: null })
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })
    expect(await applicationCount(anitaAdjustmentId)).toBe(1)
    expect(await applicationCount(rajeshAdjustmentId)).toBe(1)

    // Recalculate: the draft pays Anita no deduction and Rajesh 500 ...
    await recalculate(page)
    const draft = (await getRevisions(payrollRunId)).find((r) => r.status === 'DRAFT')!
    const draftNet = Object.fromEntries((await getRevisionEmployees(draft.id)).map((e) => [e.employeeCode, e.netPayable]))
    expect(draftNet).toEqual({ [ANITA]: 3250, [RAJESH]: 3700 })
    // ... and still no balance has moved.
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')

    // Approve the revision: both settle.
    await page.getByRole('button', { name: 'Approve Revision' }).click()
    await page.getByRole('button', { name: 'Confirm Revision' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    // Anita: the 500 is given back (2000 left) and the instalment is carried to next week, counted once.
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 1 })
    expect(await application(anitaApplicationId)).toEqual({ status: 'SKIPPED', amount: 500, carriedTo: NEXT_WEEK })
    const carried = await nextWeekApplications(anitaAdjustmentId)
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({ approvalStatus: 'PENDING', employeeId: (await prisma.employee.findFirstOrThrow({ where: { employeeId: ANITA } })).id })
    expect(Number(carried[0].appliedAmount)).toBe(500)
    // Rajesh: the 500 is taken off (1500 left); nothing is carried.
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await application(rajeshApplicationId)).toEqual({ status: 'APPROVED', amount: 500, carriedTo: null })
    expect(await nextWeekApplications(rajeshAdjustmentId)).toHaveLength(0)

    // The revision and the run agree with the balances: 500 deducted in total (Rajesh's), Anita paid in full.
    const revisions = await getRevisions(payrollRunId)
    expect(revisions).toMatchObject([
      { revisionNumber: 1, status: 'SUPERSEDED', isCurrent: false },
      { revisionNumber: 2, status: 'APPROVED', isCurrent: true },
    ])
    const net = Object.fromEntries((await getRevisionEmployees(revisions[1].id)).map((e) => [e.employeeCode, e.netPayable]))
    expect(net).toEqual({ [ANITA]: 3250, [RAJESH]: 3700 })
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
    expect(run.status).toBe('REVISED')
    expect(Number(run.totalDeductions)).toBe(500)
  })

  test('a COMPLETED one-time deduction that is skipped becomes ACTIVE again when the revision is approved, and not before', async ({ page }) => {
    // A real weekly approval completes a one-time adjustment; the seed leaves it ACTIVE.
    await prisma.payrollAdjustment.update({ where: { id: anitaAdjustmentId }, data: { recurrenceType: 'ONE_TIME', recurrenceEndType: null, totalBalance: null, remainingBalance: null, status: 'COMPLETED' } })

    await openAdjustments(page, 'The one-time deduction should not have been taken')
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Skip' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Skipped')).toBeVisible({ timeout: 8000 })
    await recalculate(page)
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'COMPLETED', remaining: null, carried: 0 }) // not yet

    await page.getByRole('button', { name: 'Approve Revision' }).click()
    await page.getByRole('button', { name: 'Confirm Revision' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: null, carried: 1 })
    expect(await application(anitaApplicationId)).toEqual({ status: 'SKIPPED', amount: 500, carriedTo: NEXT_WEEK })
    expect(await nextWeekApplications(anitaAdjustmentId)).toHaveLength(1)
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
    expect(Number(run.totalDeductions)).toBe(0)
  })
})

test.describe('An abandoned correction moves nothing', () => {
  test('after skipping, approving and recalculating, cancelling from the preview puts every status back and every balance is as it was', async ({ page }) => {
    await openAdjustments(page, 'This will be discarded')
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Skip' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Skipped')).toBeVisible({ timeout: 8000 })
    await row(page, 'Rajesh Iyer').getByRole('button', { name: 'Approve' }).click()
    await expect(row(page, 'Rajesh Iyer').getByText('Approved')).toBeVisible({ timeout: 8000 })
    await recalculate(page)
    await expect(page.getByText('Revision 1 stays current until you approve')).toBeVisible({ timeout: 15000 })

    // No punch edits to lose, so there is nothing to confirm: cancelling discards the correction at once.
    await page.getByRole('button', { name: 'Cancel correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    // Anita's application is APPROVED again with its 500, Rajesh's PENDING again; neither balance moved; nothing was carried.
    expect(await application(anitaApplicationId)).toEqual({ status: 'APPROVED', amount: 500, carriedTo: null })
    expect(await application(rajeshApplicationId)).toEqual({ status: 'PENDING', amount: 500, carriedTo: null })
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })
    expect(await applicationCount(anitaAdjustmentId)).toBe(1)
    expect(await applicationCount(rajeshAdjustmentId)).toBe(1)
    // The draft is gone, revision 1 is still the current one, the run is untouched.
    expect(await getRevisions(payrollRunId)).toMatchObject([{ revisionNumber: 1, status: 'APPROVED', isCurrent: true }])
    expect(await getPayrollRunStatus(payrollRunId)).toBe('APPROVED')
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
    expect(Number(run.totalDeductions)).toBe(500)
    const sessions = await getCorrectionSessions(payrollRunId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].status).toBe('ABANDONED')
    await expect(page.getByRole('button', { name: 'Correct', exact: true })).toBeVisible()
  })

  test('cancelling from the first step, with a skip clicked and no recalculation, also moves nothing', async ({ page }) => {
    await openAdjustments(page, 'Never mind')
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Skip' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Skipped')).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: 'Cancel Correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 20000 })
    await settled(page)

    expect(await application(anitaApplicationId)).toEqual({ status: 'APPROVED', amount: 500, carriedTo: null })
    expect(await application(rajeshApplicationId)).toEqual({ status: 'PENDING', amount: 500, carriedTo: null })
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })
    expect(await getRevisions(payrollRunId)).toHaveLength(1)
    expect((await getCorrectionSessions(payrollRunId))[0].status).toBe('ABANDONED')
  })

  test('a new correction after an abandoned one starts from the restored state: re-approving what was applied moves nothing', async ({ page }) => {
    await openAdjustments(page, 'First try')
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Skip' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Skipped')).toBeVisible({ timeout: 8000 })
    await page.getByRole('button', { name: 'Cancel Correction' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 20000 })
    await settled(page)

    await openAdjustments(page, 'Second try')
    await row(page, 'Anita Sharma').getByRole('button', { name: 'Approve' }).click()
    await expect(row(page, 'Anita Sharma').getByText('Approved')).toBeVisible({ timeout: 8000 })
    await recalculate(page)
    await page.getByRole('button', { name: 'Approve Revision' }).click()
    await page.getByRole('button', { name: 'Confirm Revision' }).click()
    await expect(page).toHaveURL(new RegExp(`/payroll/run/${payrollRunId}$`), { timeout: 30000 })
    await settled(page)

    // Anita's deduction was applied before and is approved again: the balance stays at 1500, nothing carried.
    expect(await adjustment(anitaAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 1500, carried: 0 })
    expect(await application(anitaApplicationId)).toEqual({ status: 'APPROVED', amount: 500, carriedTo: null })
    expect(await applicationCount(anitaAdjustmentId)).toBe(1)
    // Rajesh's was left PENDING in this correction: not applied before, not applied now.
    expect(await adjustment(rajeshAdjustmentId)).toEqual({ status: 'ACTIVE', remaining: 2000, carried: 0 })
    expect(await application(rajeshApplicationId)).toEqual({ status: 'PENDING', amount: 500, carriedTo: null })
  })
})
