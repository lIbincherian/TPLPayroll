// @vitest-environment node
//
// Real-database tests for the F13 apply path (applySyncPlan, the advisory lock, audit rows, wage history).
//
//   F13_TEST_DB_URL=postgres://postgres:postgres@localhost:5432/f13_test_tmp npx vitest run src/__tests__/db/f13-apply.db.test.ts
//
// Skipped (and reported as skipped) when F13_TEST_DB_URL is not set. The URL must point at localhost, at a database with
// the migrations applied. Rows use their own employees (TPLF13T7xxx, numbers 7101-7199) and are removed afterwards; the
// Settings row is put back as it was. Run with --no-file-parallelism next to other DB test files.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const URL = process.env.F13_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal

if (URL !== '' && !isLocal) {
  describe('F13 apply (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F13_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

const HEADER = ['Sr.', 'Employee ID', 'Employee Name', 'Designation', 'Salary', 'Date of Joining', 'Active', 'Phone', 'Site', 'Bank Account No.', 'Date of Resignation']
const row = (o: Record<string, string> = {}) =>
  HEADER.map((h) => ({
    'Sr.': '7101',
    'Employee ID': 'TPLF13T7101',
    'Employee Name': 'Test One',
    Designation: 'MASON',
    Salary: '800',
    'Date of Joining': '01/11/2026',
    Active: '',
    Phone: '9000000001',
    Site: 'Goa',
    'Bank Account No.': '"0009201700065570"',
    'Date of Resignation': '',
    ...o,
  })[h] as string)

const TODAY = new Date('2026-11-24T00:00:00.000Z')

describe.skipIf(!enabled)('F13 apply (real database)', { timeout: 120000 }, () => {
  let prisma: PrismaClient
  let applySyncPlan: typeof import('@/features/employee-sheet-sync/services/apply.service').applySyncPlan
  let updateEmployee: typeof import('@/features/employee-management/services/employee.service').updateEmployee
  let originalSettings: { employeeSheetSyncEnabled: boolean; employeeSheetSyncFirstAppliedAt: Date | null } | null = null

  const apply = (rows: string[][], over: Record<string, unknown> = {}) =>
    applySyncPlan({
      values: { header: HEADER, rows },
      tab: 'Employee Master List',
      mode: 'FIXTURE',
      trigger: 'MANUAL',
      expectedHash: null,
      today: TODAY,
      ...over,
    } as never)

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { employeeId: { startsWith: 'TPLF13T' } }, select: { id: true } })
    const ids = emps.map((e) => e.id)
    await prisma.auditLog.deleteMany({ where: { entityType: 'EMPLOYEE', entityId: { in: ids } } })
    await prisma.employeeWageHistory.deleteMany({ where: { employeeId: { in: ids } } })
    await prisma.employee.deleteMany({ where: { id: { in: ids } } })
    await prisma.employeeImportBatch.deleteMany({ where: { source: 'SHEET_SYNC' } })
  }

  async function setSettings(enabledFlag: boolean, firstApplied: Date | null = null) {
    await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: { employeeSheetSyncEnabled: enabledFlag, employeeSheetSyncFirstAppliedAt: firstApplied },
      create: { id: 'singleton', employeeSheetSyncEnabled: enabledFlag, employeeSheetSyncFirstAppliedAt: firstApplied },
    })
  }

  beforeAll(async () => {
    process.env.DIRECT_DATABASE_URL = URL
    process.env.DATABASE_URL = URL
    prisma = (await import('@/lib/prisma')).default
    ;({ applySyncPlan } = await import('@/features/employee-sheet-sync/services/apply.service'))
    ;({ updateEmployee } = await import('@/features/employee-management/services/employee.service'))
    const s = await prisma.settings.findUnique({ where: { id: 'singleton' } })
    originalSettings = s ? { employeeSheetSyncEnabled: s.employeeSheetSyncEnabled, employeeSheetSyncFirstAppliedAt: s.employeeSheetSyncFirstAppliedAt } : null
    await cleanup()
  }, 60000)

  afterAll(async () => {
    await cleanup()
    if (originalSettings) await setSettings(originalSettings.employeeSheetSyncEnabled, originalSettings.employeeSheetSyncFirstAppliedAt)
    else await prisma.settings.deleteMany({ where: { id: 'singleton' } })
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await cleanup()
    await setSettings(true, null)
  })

  it('creates an employee, an open SHEET_SYNC wage row, an audit row and an APPLIED run; keeps leading zeros and the raw Sr.', async () => {
    const r = await apply([row()])
    expect(r.status).toBe('APPLIED')
    const e = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    expect(e).toMatchObject({ employeeName: 'Test One', designation: 'MASON', phone: '9000000001', site: 'Goa', isActive: true, serialNumber: '7101', bankAccount: '0009201700065570' })
    expect(e.dateOfJoining?.toISOString()).toBe('2026-11-01T00:00:00.000Z')

    const wages = await prisma.employeeWageHistory.findMany({ where: { employeeId: e.id } })
    expect(wages).toHaveLength(1)
    expect(wages[0]).toMatchObject({ changeSource: 'SHEET_SYNC', effectiveTo: null })
    expect(Number(wages[0].weeklySalary)).toBe(800)
    expect(Number(wages[0].hourlyRate)).toBe(100)
    expect(wages[0].effectiveFrom.toISOString()).toBe('2026-11-01T00:00:00.000Z')

    const run = await prisma.employeeImportBatch.findFirstOrThrow({ where: { source: 'SHEET_SYNC' } })
    expect(run).toMatchObject({ status: 'APPLIED', trigger: 'MANUAL', fileType: 'GOOGLE_SHEET', createdEmployeeCount: 1, updatedEmployeeCount: 0 })
    expect(wages[0].employeeImportBatchId).toBe(run.id)
    expect(e.employeeImportBatchId).toBe(run.id)

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'EMPLOYEE', entityId: e.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0].actionType).toBe('CREATE')
    expect(audit[0].detailsJson).toMatchObject({ changeSource: 'SHEET_SYNC', runId: run.id, employeeId: 'TPLF13T7101', salary: 800 })
  })

  it('updates changed fields only, clears blanks, writes one UPDATE audit row, leaves status/wage/Employee ID/serialNumber alone', async () => {
    await apply([row()])
    const before = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    await prisma.employee.update({ where: { id: before.id }, data: { isActive: false } })

    const r = await apply([row({ Site: 'Pune', Phone: '', Salary: '999', Active: 'Active', 'Date of Resignation': '10/11/2026' })])
    expect(r.status).toBe('APPLIED')
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: before.id } })
    expect(after).toMatchObject({ site: 'Pune', phone: null, isActive: false, employeeId: 'TPLF13T7101', serialNumber: '7101' })
    expect(after.dateOfResignation?.toISOString()).toBe('2026-11-10T00:00:00.000Z')

    const wages = await prisma.employeeWageHistory.findMany({ where: { employeeId: before.id } })
    expect(wages).toHaveLength(1)
    expect(Number(wages[0].weeklySalary)).toBe(800)

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'EMPLOYEE', entityId: before.id, actionType: 'UPDATE' } })
    expect(audit).toHaveLength(1)
    const changes = (audit[0].detailsJson as { changes: Array<{ field: string }>; changeSource: string }).changes.map((c) => c.field).sort()
    expect(changes).toEqual(['dateOfResignation', 'phone', 'site'])
    expect((audit[0].detailsJson as { changeSource: string }).changeSource).toBe('SHEET_SYNC')
  })

  it('a second identical apply writes no update and no audit row', async () => {
    await apply([row()])
    await apply([row()])
    const e = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    expect(await prisma.auditLog.count({ where: { entityType: 'EMPLOYEE', entityId: e.id } })).toBe(1)
    expect(await prisma.employeeWageHistory.count({ where: { employeeId: e.id } })).toBe(1)
  })

  it('does not touch app-only employees', async () => {
    const solo = await prisma.employee.create({ data: { employeeId: 'TPLF13TTEST', employeeName: 'Solo', designation: 'X', site: 'Keep' } })
    await apply([row()])
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: solo.id } })).site).toBe('Keep')
    expect(await prisma.auditLog.count({ where: { entityType: 'EMPLOYEE', entityId: solo.id } })).toBe(0)
  })

  it('STALE: a wrong hash writes nothing at all', async () => {
    const r = await apply([row()], { expectedHash: '0'.repeat(64) })
    expect(r.status).toBe('STALE')
    expect(await prisma.employee.count({ where: { employeeId: { startsWith: 'TPLF13T' } } })).toBe(0)
    expect(await prisma.employeeImportBatch.count({ where: { source: 'SHEET_SYNC' } })).toBe(0)
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).employeeSheetSyncFirstAppliedAt).toBeNull()
  })

  it('a matching hash applies', async () => {
    const stale = await apply([row()], { expectedHash: '0'.repeat(64) })
    if (stale.status !== 'STALE') throw new Error('expected STALE')
    const ok = await apply([row()], { expectedHash: stale.planHash })
    expect(ok.status).toBe('APPLIED')
  })

  it('SYNC_DISABLED: throws and writes nothing', async () => {
    await setSettings(false)
    await expect(apply([row()])).rejects.toMatchObject({ code: 'SYNC_DISABLED' })
    expect(await prisma.employee.count({ where: { employeeId: { startsWith: 'TPLF13T' } } })).toBe(0)
    expect(await prisma.employeeImportBatch.count({ where: { source: 'SHEET_SYNC' } })).toBe(0)
  })

  it('first-apply flag: set by MANUAL once, never by SCHEDULED, never cleared', async () => {
    await apply([row()], { trigger: 'SCHEDULED' })
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).employeeSheetSyncFirstAppliedAt).toBeNull()
    await apply([row({ Site: 'A' })], { trigger: 'MANUAL' })
    const first = (await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).employeeSheetSyncFirstAppliedAt
    expect(first).not.toBeNull()
    await apply([row({ Site: 'B' })], { trigger: 'MANUAL' })
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).employeeSheetSyncFirstAppliedAt?.getTime()).toBe(first!.getTime())
  })

  it('a missing required header throws before any write', async () => {
    await expect(
      applySyncPlan({ values: { header: ['Sr.'], rows: [['1']] }, tab: 't', mode: 'FIXTURE', trigger: 'MANUAL', expectedHash: null, today: TODAY }),
    ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_HEADERS' })
    expect(await prisma.employeeImportBatch.count({ where: { source: 'SHEET_SYNC' } })).toBe(0)
  })

  it('a failure in the middle rolls EVERYTHING back (creates, run row, flag)', async () => {
    await apply([row()], { trigger: 'SCHEDULED' }) // existing employee 7101
    await prisma.employeeImportBatch.deleteMany({ where: { source: 'SHEET_SYNC' } })
    const runsBefore = await prisma.employeeImportBatch.count({ where: { source: 'SHEET_SYNC' } })

    // Row A creates 7102; row B updates 7101 with a NUL byte, which Postgres rejects after the creates ran.
    const newRow = row({ 'Sr.': '7102', 'Employee ID': 'TPLF13T7102', 'Employee Name': 'Test Two' })
    const bad = row({ Site: 'bad\u0000site' })
    await expect(apply([newRow, bad])).rejects.toThrow()

    expect(await prisma.employee.count({ where: { employeeId: 'TPLF13T7102' } })).toBe(0)
    expect(await prisma.employeeImportBatch.count({ where: { source: 'SHEET_SYNC' } })).toBe(runsBefore)
    expect(await prisma.auditLog.count({ where: { actionType: 'CREATE', entityType: 'EMPLOYEE', detailsJson: { path: ['employeeId'], equals: 'TPLF13T7102' } } })).toBe(0)
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: 'singleton' } })).employeeSheetSyncFirstAppliedAt).toBeNull()
  })

  it('two concurrent applies are serialised by the advisory lock: one employee, no unique-violation', async () => {
    const results = await Promise.allSettled([apply([row()]), apply([row()])])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await prisma.employee.count({ where: { employeeId: 'TPLF13T7101' } })).toBe(1)
    const e = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    expect(await prisma.employeeWageHistory.count({ where: { employeeId: e.id, effectiveTo: null } })).toBe(1)
    const runs = await prisma.employeeImportBatch.findMany({ where: { source: 'SHEET_SYNC' } })
    expect(runs.map((r) => r.createdEmployeeCount).sort()).toEqual([0, 1])
  })

  it('the partial index stops a second open wage row, and the app wage-change path still works with it', async () => {
    await apply([row()])
    const e = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    await expect(
      prisma.employeeWageHistory.create({
        data: { employeeId: e.id, weeklySalary: 900, hourlyRate: 112.5, effectiveFrom: new Date(), changeSource: 'MANUAL' },
      }),
    ).rejects.toThrow()

    // Sync is on: only non-sheet fields may change. A wage change closes the old row and opens one new row.
    await updateEmployee(e.id, { salary: 950 })
    const open = await prisma.employeeWageHistory.findMany({ where: { employeeId: e.id, effectiveTo: null } })
    expect(open).toHaveLength(1)
    expect(Number(open[0].weeklySalary)).toBe(950)
    expect(await prisma.employeeWageHistory.count({ where: { employeeId: e.id } })).toBe(2)
  })

  it('the real server guard blocks a sheet-owned edit while on, and allows it once the switch is off', async () => {
    await apply([row()])
    const e = await prisma.employee.findUniqueOrThrow({ where: { employeeId: 'TPLF13T7101' } })
    await expect(updateEmployee(e.id, { site: 'Elsewhere' })).rejects.toMatchObject({ code: 'SHEET_MANAGED' })
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).site).toBe('Goa')
    await setSettings(false)
    await updateEmployee(e.id, { site: 'Elsewhere' })
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).site).toBe('Elsewhere')
  })
})
