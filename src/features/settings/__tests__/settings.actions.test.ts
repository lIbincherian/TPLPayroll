import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock the service ─────────────────────────────────────────────────────────
vi.mock('@/features/settings/services/settings.service', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

import { getSettings, updateSettings } from '@/features/settings/services/settings.service'
import { getSettingsAction, updateSettingsAction } from '@/features/settings/actions/settings.actions'
import { SettingsServiceError } from '@/features/settings/types/settings.types'
import type { AppSettings } from '@/features/settings/types/settings.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeAppSettings = (payrollWeekStartDay: AppSettings['payrollWeekStartDay'] = 'THURSDAY'): AppSettings => ({
  payrollWeekStartDay,
  currency: 'INR',
  docExpiryThresholdDays: 7,
})

// ─────────────────────────────────────────────────────────────────────────────
// getSettingsAction
// ─────────────────────────────────────────────────────────────────────────────

describe('getSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok result wrapping AppSettings', async () => {
    // GIVEN service returns THURSDAY settings
    vi.mocked(getSettings).mockResolvedValue(makeAppSettings('THURSDAY'))

    // WHEN
    const result = await getSettingsAction()

    // THEN result is ok with correct shape
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.payrollWeekStartDay).toBe('THURSDAY')
      expect(result.data.currency).toBe('INR')
      expect(result.data.docExpiryThresholdDays).toBe(7)
    }
  })

  it('returns ok: false when service throws unexpectedly', async () => {
    // GIVEN service throws generic error
    vi.mocked(getSettings).mockRejectedValue(new Error('DB connection failed'))

    // WHEN
    const result = await getSettingsAction()

    // THEN result is an error
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('An unexpected error occurred')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// updateSettingsAction
// ─────────────────────────────────────────────────────────────────────────────

describe('updateSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('with THURSDAY (the locked value) returns ok result', async () => {
    // GIVEN service returns THURSDAY settings
    vi.mocked(updateSettings).mockResolvedValue(makeAppSettings('THURSDAY'))

    // WHEN
    const result = await updateSettingsAction({ payrollWeekStartDay: 'THURSDAY' })

    // THEN result is ok with THURSDAY
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.payrollWeekStartDay).toBe('THURSDAY')
    }
  })

  it('returns { ok: false } with WEEK_START_LOCKED for a change to the week start (US-12.36)', async () => {
    // GIVEN service rejects the change because the week start is locked
    vi.mocked(updateSettings).mockRejectedValue(
      new SettingsServiceError('WEEK_START_LOCKED', 'The payroll week start is locked to Thursday and cannot be changed.'),
    )

    // WHEN
    const result = await updateSettingsAction({ payrollWeekStartDay: 'MONDAY' })

    // THEN result is an error carrying the lock code
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('WEEK_START_LOCKED')
    }
  })

  it('propagates SettingsServiceError from service as { ok: false }', async () => {
    // GIVEN service throws a SettingsServiceError
    vi.mocked(updateSettings).mockRejectedValue(
      new SettingsServiceError('VALIDATION_ERROR', 'Invalid day value'),
    )

    // WHEN
    const result = await updateSettingsAction({ payrollWeekStartDay: 'THURSDAY' })

    // THEN result is an error with code
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid day value')
      expect(result.code).toBe('VALIDATION_ERROR')
    }
  })

  it('propagates generic error as { ok: false } without code', async () => {
    // GIVEN service throws a generic error
    vi.mocked(updateSettings).mockRejectedValue(new Error('Unexpected DB error'))

    // WHEN
    const result = await updateSettingsAction({ payrollWeekStartDay: 'FRIDAY' })

    // THEN result is a generic error
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('An unexpected error occurred')
    }
  })
})
