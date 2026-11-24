// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    settings: { findUnique: vi.fn(), update: vi.fn() },
    employeeImportBatch: { create: vi.fn() },
    employee: { createMany: vi.fn(), update: vi.fn() },
    employeeWageHistory: { createMany: vi.fn() },
    auditLog: { createMany: vi.fn() },
  }
  return {
    tx,
    prisma: {
      settings: { findUnique: vi.fn() },
      employeeImportBatch: { create: vi.fn(), findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    fetchEmployeeSheet: vi.fn(),
    loadEmployeeSnapshot: vi.fn(),
    isEnabled: vi.fn(),
  }
})

vi.mock('@/lib/prisma', () => ({ default: m.prisma }))
vi.mock('../services/sheet.client', () => ({
  fetchEmployeeSheet: m.fetchEmployeeSheet,
  getSheetSourceConfig: () => ({ mode: 'FIXTURE', tab: 'Employee Master List' }),
}))
vi.mock('../services/snapshot.service', () => ({ loadEmployeeSnapshot: m.loadEmployeeSnapshot }))
vi.mock('@/features/settings/services/settings.service', () => ({ isEmployeeSheetSyncEnabled: m.isEnabled }))

import {
  applySheetSync,
  getLastSheetSync,
  previewSheetSync,
  recordFailedRun,
  runScheduledSheetSync,
} from '../services/sync.service'
import { SheetSyncError } from '../types/employee-sheet-sync.types'

const HEADER = ['Sr.', 'Employee ID', 'Employee Name', 'Designation', 'Salary', 'Date of Joining', 'Site']
const NEW_ROW = ['902', 'TPLGOADRV902', 'Joseph', 'DRIVER', '1000', '05/11/2026', 'Goa']
const VALUES = { header: HEADER, rows: [NEW_ROW] }
const sheetOk = { values: VALUES, mode: 'FIXTURE' as const, tab: 'Employee Master List' }

beforeEach(() => {
  vi.clearAllMocks()
  m.isEnabled.mockResolvedValue(true)
  m.fetchEmployeeSheet.mockResolvedValue(sheetOk)
  m.loadEmployeeSnapshot.mockResolvedValue([])
  m.prisma.$transaction.mockImplementation(async (fn: (tx: typeof m.tx) => unknown) => fn(m.tx))
  m.tx.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: null })
  m.tx.employeeImportBatch.create.mockResolvedValue({ id: 'run-1' })
  m.prisma.employeeImportBatch.create.mockResolvedValue({})
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

async function previewHash() {
  return (await previewSheetSync()).planHash
}

describe('previewSheetSync', () => {
  it('returns plan + hash and writes nothing, saves no run', async () => {
    const r = await previewSheetSync()
    expect(r.plan.creates).toHaveLength(1)
    expect(r.plan.mode).toBe('FIXTURE')
    expect(r.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(m.prisma.$transaction).not.toHaveBeenCalled()
    expect(m.prisma.employeeImportBatch.create).not.toHaveBeenCalled()
  })

  it('throws SYNC_DISABLED when off, without reading the sheet', async () => {
    m.isEnabled.mockResolvedValue(false)
    await expect(previewSheetSync()).rejects.toMatchObject({ code: 'SYNC_DISABLED' })
    expect(m.fetchEmployeeSheet).not.toHaveBeenCalled()
  })

  it('a read failure is thrown and not saved as a run', async () => {
    m.fetchEmployeeSheet.mockRejectedValue(new SheetSyncError('SHEET_NOT_SHARED', 'nope'))
    await expect(previewSheetSync()).rejects.toMatchObject({ code: 'SHEET_NOT_SHARED' })
    expect(m.prisma.employeeImportBatch.create).not.toHaveBeenCalled()
  })

  it('hash is stable for the same inputs', async () => {
    expect(await previewHash()).toBe(await previewHash())
  })
})

describe('applySheetSync (MANUAL)', () => {
  it('takes the advisory lock first, writes, and sets the first-apply flag', async () => {
    const hash = await previewHash()
    const r = await applySheetSync(hash)
    expect(r.status).toBe('APPLIED')
    const order = [
      m.tx.$executeRaw.mock.invocationCallOrder[0],
      m.tx.settings.findUnique.mock.invocationCallOrder[0],
      m.tx.employeeImportBatch.create.mock.invocationCallOrder[0],
      m.tx.employee.createMany.mock.invocationCallOrder[0],
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(m.tx.employeeImportBatch.create.mock.calls[0][0].data).toMatchObject({
      source: 'SHEET_SYNC',
      fileType: 'GOOGLE_SHEET',
      status: 'APPLIED',
      trigger: 'MANUAL',
      createdEmployeeCount: 1,
      updatedEmployeeCount: 0,
    })
    expect(m.tx.employeeWageHistory.createMany.mock.calls[0][0].data[0]).toMatchObject({
      changeSource: 'SHEET_SYNC',
      weeklySalary: 1000,
      employeeImportBatchId: 'run-1',
    })
    expect(m.tx.auditLog.createMany.mock.calls[0][0].data[0]).toMatchObject({
      actionType: 'CREATE',
      entityType: 'EMPLOYEE',
    })
    expect(m.tx.auditLog.createMany.mock.calls[0][0].data[0].detailsJson).toMatchObject({
      changeSource: 'SHEET_SYNC',
      runId: 'run-1',
    })
    expect(m.tx.settings.update).toHaveBeenCalledTimes(1)
  })

  it('does not set the flag again when it is already set', async () => {
    m.tx.settings.findUnique.mockResolvedValue({
      employeeSheetSyncEnabled: true,
      employeeSheetSyncFirstAppliedAt: new Date(),
    })
    await applySheetSync(await previewHash())
    expect(m.tx.settings.update).not.toHaveBeenCalled()
  })

  it('stale hash writes nothing and returns STALE with the new plan', async () => {
    const r = await applySheetSync('0'.repeat(64))
    expect(r.status).toBe('STALE')
    if (r.status === 'STALE') {
      expect(r.planHash).toMatch(/^[a-f0-9]{64}$/)
      expect(r.plan.creates).toHaveLength(1)
    }
    expect(m.tx.employeeImportBatch.create).not.toHaveBeenCalled()
    expect(m.tx.employee.createMany).not.toHaveBeenCalled()
    expect(m.tx.settings.update).not.toHaveBeenCalled()
    expect(m.prisma.employeeImportBatch.create).not.toHaveBeenCalled()
  })

  it('apply while disabled throws SYNC_DISABLED, writes nothing, records no FAILED run', async () => {
    m.tx.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: false, employeeSheetSyncFirstAppliedAt: null })
    await expect(applySheetSync('a'.repeat(64))).rejects.toMatchObject({ code: 'SYNC_DISABLED' })
    expect(m.tx.employee.createMany).not.toHaveBeenCalled()
    expect(m.prisma.employeeImportBatch.create).not.toHaveBeenCalled()
  })

  it('missing required header records a FAILED run outside the transaction and rethrows', async () => {
    m.fetchEmployeeSheet.mockResolvedValue({ ...sheetOk, values: { header: ['Sr.'], rows: [['1']] } })
    await expect(applySheetSync('a'.repeat(64))).rejects.toMatchObject({ code: 'MISSING_REQUIRED_HEADERS' })
    expect(m.prisma.$transaction).not.toHaveBeenCalled()
    expect(m.prisma.employeeImportBatch.create).toHaveBeenCalledTimes(1)
    const data = m.prisma.employeeImportBatch.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      status: 'FAILED',
      source: 'SHEET_SYNC',
      fileType: 'GOOGLE_SHEET',
      trigger: 'MANUAL',
      report: { error: 'MISSING_REQUIRED_HEADERS' },
    })
  })

  it('empty sheet and read errors record FAILED runs', async () => {
    m.fetchEmployeeSheet.mockRejectedValue(new SheetSyncError('AUTH_FAILED', 'denied'))
    await expect(applySheetSync('a'.repeat(64))).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(m.prisma.employeeImportBatch.create.mock.calls[0][0].data.report).toEqual({ error: 'AUTH_FAILED', message: 'denied' })
  })

  it('a write failure inside the tx propagates, records FAILED outside, and hides the raw error text', async () => {
    m.tx.employee.createMany.mockRejectedValueOnce(new Error('secret SQL detail'))
    await expect(applySheetSync(await previewHash())).rejects.toThrow('secret SQL detail')
    const data = m.prisma.employeeImportBatch.create.mock.calls[0][0].data
    expect(data.status).toBe('FAILED')
    expect(JSON.stringify(data.report)).not.toContain('secret SQL detail')
    expect(data.report.error).toBe('UNEXPECTED')
  })
})

describe('runScheduledSheetSync', () => {
  it('skips DISABLED without touching the sheet', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: false })
    expect(await runScheduledSheetSync()).toEqual({ skipped: 'DISABLED' })
    expect(m.fetchEmployeeSheet).not.toHaveBeenCalled()
  })

  it('skips DISABLED when there is no settings row', async () => {
    m.prisma.settings.findUnique.mockResolvedValue(null)
    expect(await runScheduledSheetSync()).toEqual({ skipped: 'DISABLED' })
  })

  it('skips NOT_FIRST_APPLIED before the first manual apply', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: null })
    expect(await runScheduledSheetSync()).toEqual({ skipped: 'NOT_FIRST_APPLIED' })
    expect(m.fetchEmployeeSheet).not.toHaveBeenCalled()
    expect(m.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('runs with no hash check, never touches the first-apply flag, records trigger SCHEDULED', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: new Date() })
    m.tx.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: null })
    const r = await runScheduledSheetSync()
    expect(r).toEqual({ runId: 'run-1', created: 1, updated: 0, skipped: 0 })
    expect(m.tx.employeeImportBatch.create.mock.calls[0][0].data.trigger).toBe('SCHEDULED')
    expect(m.tx.settings.update).not.toHaveBeenCalled()
  })

  it('records a FAILED SCHEDULED run on read failure and rethrows', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: new Date() })
    m.fetchEmployeeSheet.mockRejectedValue(new SheetSyncError('FETCH_FAILED', 'down'))
    await expect(runScheduledSheetSync()).rejects.toMatchObject({ code: 'FETCH_FAILED' })
    expect(m.prisma.employeeImportBatch.create.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', trigger: 'SCHEDULED' })
  })
})

describe('recordFailedRun', () => {
  it('never throws when the save itself fails', async () => {
    m.prisma.employeeImportBatch.create.mockRejectedValueOnce(new Error('db down'))
    await expect(recordFailedRun('MANUAL', new Error('x'))).resolves.toBeUndefined()
  })
})

describe('getLastSheetSync', () => {
  it('returns null when no run exists', async () => {
    m.prisma.employeeImportBatch.findFirst.mockResolvedValue(null)
    expect(await getLastSheetSync()).toBeNull()
    expect(m.prisma.employeeImportBatch.findFirst.mock.calls[0][0]).toMatchObject({ where: { source: 'SHEET_SYNC' } })
  })

  it('maps an applied run with skips and warning count', async () => {
    m.prisma.employeeImportBatch.findFirst.mockResolvedValue({
      id: 'r',
      importedAt: new Date('2026-11-24T10:00:00Z'),
      trigger: 'SCHEDULED',
      status: 'APPLIED',
      createdEmployeeCount: 2,
      updatedEmployeeCount: 3,
      rejectedRowCount: 1,
      report: { skips: [{ rowNumber: 4, reason: 'SR_INVALID' }], warnings: [{}, {}] },
    })
    expect(await getLastSheetSync()).toMatchObject({
      runId: 'r',
      trigger: 'SCHEDULED',
      status: 'APPLIED',
      created: 2,
      updated: 3,
      skipped: 1,
      warnings: 2,
      skips: [{ rowNumber: 4 }],
    })
  })

  it('maps a failed run with its error message', async () => {
    m.prisma.employeeImportBatch.findFirst.mockResolvedValue({
      id: 'r',
      importedAt: new Date(),
      trigger: null,
      status: 'FAILED',
      createdEmployeeCount: 0,
      updatedEmployeeCount: 0,
      rejectedRowCount: 0,
      report: { error: 'AUTH_FAILED', message: 'denied' },
    })
    expect(await getLastSheetSync()).toMatchObject({ status: 'FAILED', trigger: 'MANUAL', error: 'denied', skips: [], warnings: 0 })
  })
})
