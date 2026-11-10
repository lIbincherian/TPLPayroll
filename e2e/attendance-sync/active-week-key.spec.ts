import { test, expect } from '@playwright/test'
import prisma, {
  cleanupTestData,
  countTestUploads,
  createEmployee,
  inTestWeekZone,
  seedApiWeek,
  seedApprovedPayrollForCorrection,
  seedExcelWeek,
  seedPayrollTestData,
  seedReviewWeek,
  seedSyncFailedWeek,
} from '../utils/db'

// Fix round, item 5: the database allows one active attendance row per week (AttendanceUpload.activeWeekStart
// is unique). Every e2e seed that creates an active week must set that column, or the seeds would no
// longer match what the app itself creates.

const W = '2025-09-25' // a week before the real data starts (the test namespace)
const day = { reg: 8, ot: 0 }

const seeds: Array<[string, () => Promise<unknown>]> = [
  [
    'seedApiWeek',
    async () => {
      const emp = await createEmployee({ employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' })
      await seedApiWeek({ weekStartISO: W, employees: [emp], days: [Array(7).fill(day)] })
    },
  ],
  [
    'seedExcelWeek',
    async () => {
      const emp = await createEmployee({ employeeId: 'E2E-HLP-9001', employeeName: 'Anita Rao' })
      await seedExcelWeek({ weekStartISO: W, employees: [emp], days: [Array(7).fill(day)] })
    },
  ],
  ['seedSyncFailedWeek', async () => void (await seedSyncFailedWeek(W))],
  ['seedReviewWeek', async () => void (await seedReviewWeek({ weekStartISO: W, rows: [] }))],
  ['seedApprovedPayrollForCorrection', async () => void (await seedApprovedPayrollForCorrection())],
  ['seedPayrollTestData', async () => void (await seedPayrollTestData())],
]

test.describe.configure({ mode: 'serial' })

for (const [name, seed] of seeds) {
  test(`${name} stores activeWeekStart = payrollWeekStartDate on every active week, and the week then refuses a second active row`, async () => {
    await cleanupTestData()
    await seed()

    // Only the weeks the seed created (the test week zones); the real data's weeks are not this test's business
    const uploads = await prisma.attendanceUpload.findMany({ where: inTestWeekZone() })
    const active = uploads.filter((u) => u.isActiveForPayrollWeek)
    expect(active.length, `${name} seeded no active upload`).toBeGreaterThan(0)
    for (const upload of active) {
      expect(upload.activeWeekStart?.toISOString(), `${name}: ${upload.id}`).toBe(upload.payrollWeekStartDate.toISOString())
    }

    const first = active[0]
    await expect(
      prisma.attendanceUpload.create({
        data: {
          source: 'ETIMEOFFICE',
          payrollWeekSource: 'ETIMEOFFICE',
          status: 'SYNC_FAILED',
          isActiveForPayrollWeek: true,
          activeWeekStart: first.payrollWeekStartDate,
          payrollWeekStartDate: first.payrollWeekStartDate,
          payrollWeekEndDate: first.payrollWeekEndDate,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await countTestUploads()).toBe(uploads.length)
  })
}
