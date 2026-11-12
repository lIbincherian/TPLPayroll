import { describe, it, expect, vi, beforeEach } from 'vitest'

// US-12.36 AC3/AC4: a direct call to updateSettingsAction is rejected and the database is untouched.
// Unlike settings.actions.test.ts, the real service runs here and only Prisma is mocked.

vi.mock('@/lib/prisma', () => ({
  default: {
    settings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import { updateSettingsAction } from '@/features/settings/actions/settings.actions'

describe('updateSettingsAction — week start lock (real service)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('returns { ok: false } with WEEK_START_LOCKED for MONDAY and makes no database change', async () => {
    const result = await updateSettingsAction({ payrollWeekStartDay: 'MONDAY' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('WEEK_START_LOCKED')
      expect(result.error).toMatch(/locked to Thursday/i)
    }
    expect(prisma.settings.update).not.toHaveBeenCalled()
    expect(prisma.settings.upsert).not.toHaveBeenCalled()
  })

  it('returns { ok: false } with VALIDATION_ERROR for a value that is not a day', async () => {
    const result = await updateSettingsAction({ payrollWeekStartDay: 'FUNDAY' as never })

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(prisma.settings.update).not.toHaveBeenCalled()
  })

  it('returns the current Thursday settings for THURSDAY, without an update', async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ id: 'singleton', payrollWeekStartDay: 'THURSDAY' } as never)

    const result = await updateSettingsAction({ payrollWeekStartDay: 'THURSDAY' })

    expect(result).toEqual({ ok: true, data: { payrollWeekStartDay: 'THURSDAY', currency: 'INR', docExpiryThresholdDays: 7 } })
    expect(prisma.settings.update).not.toHaveBeenCalled()
    expect(prisma.settings.upsert).not.toHaveBeenCalled()
  })
})
