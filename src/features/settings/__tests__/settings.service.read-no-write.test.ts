import { beforeEach, describe, expect, it, vi } from 'vitest'

// getSettings is read on every payroll page. It writes only when the row is missing or is not THURSDAY, so an
// ordinary read leaves the row (and its updatedAt) alone. The real-database counterpart is in
// src/__tests__/db/f12-final-fixes.db.test.ts.

vi.mock('@/lib/prisma', () => ({
  default: { settings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), create: vi.fn() } },
}))

import prisma from '@/lib/prisma'
import { getSettings, updateSettings } from '@/features/settings/services/settings.service'

const record = (payrollWeekStartDay: string) => ({ id: 'singleton', payrollWeekStartDay, updatedAt: new Date('2025-01-01') })

const writes = () => [
  ...vi.mocked(prisma.settings.upsert).mock.calls,
  ...vi.mocked(prisma.settings.update).mock.calls,
  ...vi.mocked(prisma.settings.create).mock.calls,
]

beforeEach(() => vi.clearAllMocks())

describe('getSettings: a read that finds Thursday writes nothing', () => {
  it('reads the singleton row once and returns it without any write', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(record('THURSDAY') as never)

    const result = await getSettings()

    expect(result).toEqual({ payrollWeekStartDay: 'THURSDAY', currency: 'INR', docExpiryThresholdDays: 7 })
    expect(prisma.settings.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.settings.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } })
    expect(writes()).toEqual([])
  })

  it('five reads in a row write nothing', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(record('THURSDAY') as never)

    for (let i = 0; i < 5; i++) await getSettings()

    expect(prisma.settings.findUnique).toHaveBeenCalledTimes(5)
    expect(writes()).toEqual([])
  })

  it('a request to "change" the week start to Thursday (a no-op) is a read as well', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(record('THURSDAY') as never)

    await updateSettings({ payrollWeekStartDay: 'THURSDAY' })

    expect(writes()).toEqual([])
  })
})

describe('getSettings: a read that finds anything else writes Thursday once', () => {
  it('no row yet: one upsert that creates the singleton, Thursday by default', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.settings.upsert).mockResolvedValue(record('THURSDAY') as never)

    const result = await getSettings()

    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      update: { payrollWeekStartDay: 'THURSDAY' },
      create: { id: 'singleton' },
    })
  })

  it.each(['MONDAY', 'FRIDAY', 'SUNDAY', '', 'thursday', 'Thursday', ' THURSDAY'])('a stored %j is changed to Thursday and Thursday is returned', async (stored) => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(record(stored) as never)
    vi.mocked(prisma.settings.upsert).mockResolvedValue(record('THURSDAY') as never)

    const result = await getSettings()

    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { payrollWeekStartDay: 'THURSDAY' } }))
  })

  it('after the heal, the next read is a plain read again', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValueOnce(record('MONDAY') as never).mockResolvedValue(record('THURSDAY') as never)
    vi.mocked(prisma.settings.upsert).mockResolvedValue(record('THURSDAY') as never)

    await getSettings()
    await getSettings()
    await getSettings()

    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1)
  })
})

describe('getSettings: failures', () => {
  it('a failing read propagates and nothing is written', async () => {
    vi.mocked(prisma.settings.findUnique).mockRejectedValue(new Error('database unavailable'))

    await expect(getSettings()).rejects.toThrow('database unavailable')
    expect(writes()).toEqual([])
  })

  it('a failing heal propagates instead of returning settings that were not saved', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(record('MONDAY') as never)
    vi.mocked(prisma.settings.upsert).mockRejectedValue(new Error('write failed'))

    await expect(getSettings()).rejects.toThrow('write failed')
  })
})
