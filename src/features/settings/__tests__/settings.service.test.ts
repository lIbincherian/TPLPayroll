import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    settings: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import { getSettings, updateSettings } from '@/features/settings/services/settings.service'
import { SettingsServiceError } from '@/features/settings/types/settings.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeSettingsRecord = (payrollWeekStartDay = 'THURSDAY') => ({
  id: 'singleton',
  payrollWeekStartDay,
  updatedAt: new Date('2025-01-01'),
})

// ─────────────────────────────────────────────────────────────────────────────
// US-10.1: getSettings
// ─────────────────────────────────────────────────────────────────────────────

describe('getSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns THURSDAY with fixed currency and expiry threshold', async () => {
    // GIVEN existing record with THURSDAY
    vi.mocked(prisma.settings.upsert).mockResolvedValue(makeSettingsRecord('THURSDAY') as never)

    // WHEN
    const result = await getSettings()

    // THEN payrollWeekStartDay is THURSDAY with fixed fields
    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    expect(result.currency).toBe('INR')
    expect(result.docExpiryThresholdDays).toBe(7)
  })

  it('self-heals a stored non-Thursday value by upserting THURSDAY (F12 lock)', async () => {
    // GIVEN the upsert is asked to write THURSDAY over whatever is stored
    vi.mocked(prisma.settings.upsert).mockResolvedValue(makeSettingsRecord('THURSDAY') as never)

    // WHEN
    await getSettings()

    // THEN the update branch sets THURSDAY
    expect(prisma.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        update: { payrollWeekStartDay: 'THURSDAY' },
      }),
    )
  })

  it('returns defaults (THURSDAY) when no record exists (upsert creates it)', async () => {
    // GIVEN upsert creates a new record with default THURSDAY
    vi.mocked(prisma.settings.upsert).mockResolvedValue(makeSettingsRecord('THURSDAY') as never)

    // WHEN
    const result = await getSettings()

    // THEN payrollWeekStartDay defaults to THURSDAY
    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    expect(prisma.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        create: { id: 'singleton' },
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-10.2: updateSettings
// ─────────────────────────────────────────────────────────────────────────────

describe('updateSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a change to the week start and makes no database write (US-12.36)', async () => {
    // GIVEN the payroll week start is Thursday
    // WHEN a change to MONDAY is requested
    const rejection = updateSettings({ payrollWeekStartDay: 'MONDAY' })
    await expect(rejection).rejects.toBeInstanceOf(SettingsServiceError)
    await expect(rejection).rejects.toMatchObject({ code: 'WEEK_START_LOCKED' })

    // THEN prisma.settings.update is not called
    expect(prisma.settings.update).not.toHaveBeenCalled()
  })

  it('treats a request for THURSDAY as a no-op that returns the current settings', async () => {
    // GIVEN THURSDAY is stored
    vi.mocked(prisma.settings.upsert).mockResolvedValue(makeSettingsRecord('THURSDAY') as never)

    // WHEN THURSDAY is requested
    const result = await updateSettings({ payrollWeekStartDay: 'THURSDAY' })

    // THEN the current settings come back and nothing is updated
    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    expect(prisma.settings.update).not.toHaveBeenCalled()
  })

  it('throws INVALID_DAY error when given invalid day', async () => {
    // GIVEN an invalid day value
    // WHEN
    await expect(
      updateSettings({ payrollWeekStartDay: 'FUNDAY' as never }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })

    // THEN prisma is not called
    expect(prisma.settings.update).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-12.36: the payroll week start is locked to Thursday
// ─────────────────────────────────────────────────────────────────────────────

describe('updateSettings — week start lock (F12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const)(
    'rejects %s with WEEK_START_LOCKED and touches no table',
    async (day) => {
      await expect(updateSettings({ payrollWeekStartDay: day })).rejects.toMatchObject({
        name: 'SettingsServiceError',
        code: 'WEEK_START_LOCKED',
        message: expect.stringMatching(/locked to Thursday/i),
      })

      // AC4: a rejected request makes no database change (no update, and not even the self-heal upsert).
      expect(prisma.settings.update).not.toHaveBeenCalled()
      expect(prisma.settings.upsert).not.toHaveBeenCalled()
    },
  )

  it('rejects an unknown day name with VALIDATION_ERROR, not WEEK_START_LOCKED, and writes nothing', async () => {
    await expect(updateSettings({ payrollWeekStartDay: 'funday' as never })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(updateSettings({ payrollWeekStartDay: 'thursday' as never })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(updateSettings({} as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(updateSettings({ payrollWeekStartDay: undefined } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    expect(prisma.settings.update).not.toHaveBeenCalled()
    expect(prisma.settings.upsert).not.toHaveBeenCalled()
  })

  it('a request for THURSDAY returns the stored settings through the self-healing read, with no update', async () => {
    vi.mocked(prisma.settings.upsert).mockResolvedValue(makeSettingsRecord('THURSDAY') as never)

    const result = await updateSettings({ payrollWeekStartDay: 'THURSDAY' })

    expect(result).toEqual({ payrollWeekStartDay: 'THURSDAY', currency: 'INR', docExpiryThresholdDays: 7 })
    expect(prisma.settings.update).not.toHaveBeenCalled()
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1)
  })

  it('getSettings writes THURSDAY over a stored non-Thursday value and returns Thursday', async () => {
    // The upsert's update branch is what fixes a stored MONDAY; the database returns the row after the write.
    vi.mocked(prisma.settings.upsert).mockImplementation((async (args: { update: { payrollWeekStartDay: string } }) =>
      makeSettingsRecord(args.update.payrollWeekStartDay)) as never)

    const result = await getSettings()

    expect(result.payrollWeekStartDay).toBe('THURSDAY')
    const args = vi.mocked(prisma.settings.upsert).mock.calls[0][0]
    expect(args.update).toEqual({ payrollWeekStartDay: 'THURSDAY' })
  })
})
