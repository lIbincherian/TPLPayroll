import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  prisma: { settings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() } },
  updateSettingsAction: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({ default: m.prisma }))
vi.mock('@/features/settings/actions/settings.actions', () => ({ updateSettingsAction: m.updateSettingsAction }))

import { SettingsForm } from '@/features/settings/components/SettingsForm'
import {
  getEmployeeSheetSyncState,
  getSettings,
  isEmployeeSheetSyncEnabled,
  updateSettings,
} from '@/features/settings/services/settings.service'
import { UpdateSettingsSchema, type AppSettings } from '@/features/settings/types/settings.types'

const OFF: AppSettings = {
  payrollWeekStartDay: 'THURSDAY',
  currency: 'INR',
  docExpiryThresholdDays: 7,
  employeeSheetSyncEnabled: false,
  employeeSheetSyncFirstAppliedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SettingsForm sheet sync switch', () => {
  it('renders an off switch and the not-applied-yet note', () => {
    render(<SettingsForm initialSettings={OFF} />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Employee Master sheet sync')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-first-applied')).toHaveTextContent('Not applied yet')
  })

  it('shows the first-applied time once set', () => {
    render(<SettingsForm initialSettings={{ ...OFF, employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: '2026-11-24T10:00:00.000Z' }} />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('sheet-sync-first-applied')).toHaveTextContent('First applied')
  })

  it('toggling saves via updateSettingsAction and reflects the result', async () => {
    m.updateSettingsAction.mockResolvedValue({ ok: true, data: { ...OFF, employeeSheetSyncEnabled: true } })
    render(<SettingsForm initialSettings={OFF} />)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    expect(m.updateSettingsAction).toHaveBeenCalledWith({ employeeSheetSyncEnabled: true })
  })

  it('a failed save leaves the switch as it was and shows the error', async () => {
    m.updateSettingsAction.mockResolvedValue({ ok: false, error: 'Nope' })
    render(<SettingsForm initialSettings={OFF} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByTestId('sheet-sync-setting-error')).toHaveTextContent('Nope')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('a thrown save shows a network error', async () => {
    m.updateSettingsAction.mockRejectedValue(new Error('x'))
    render(<SettingsForm initialSettings={OFF} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByTestId('sheet-sync-setting-error')).toBeInTheDocument()
  })

  it('still offers no week-start control', () => {
    render(<SettingsForm initialSettings={OFF} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('settings service (F13)', () => {
  it('isEmployeeSheetSyncEnabled is read-only and false with no row', async () => {
    m.prisma.settings.findUnique.mockResolvedValue(null)
    expect(await isEmployeeSheetSyncEnabled()).toBe(false)
    expect(m.prisma.settings.upsert).not.toHaveBeenCalled()
    expect(m.prisma.settings.update).not.toHaveBeenCalled()
  })

  it('reads true only for exactly true', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true })
    expect(await isEmployeeSheetSyncEnabled()).toBe(true)
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: false })
    expect(await isEmployeeSheetSyncEnabled()).toBe(false)
  })

  it('getEmployeeSheetSyncState reports enabled and firstApplied without writing', async () => {
    m.prisma.settings.findUnique.mockResolvedValue({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: new Date() })
    expect(await getEmployeeSheetSyncState()).toEqual({ enabled: true, firstApplied: true })
    m.prisma.settings.findUnique.mockResolvedValue(null)
    expect(await getEmployeeSheetSyncState()).toEqual({ enabled: false, firstApplied: false })
    expect(m.prisma.settings.upsert).not.toHaveBeenCalled()
  })

  it('getSettings exposes the new fields (ISO date)', async () => {
    const at = new Date('2026-11-24T10:00:00.000Z')
    m.prisma.settings.findUnique.mockResolvedValue({
      id: 'singleton',
      payrollWeekStartDay: 'THURSDAY',
      employeeSheetSyncEnabled: true,
      employeeSheetSyncFirstAppliedAt: at,
    })
    expect(await getSettings()).toMatchObject({ employeeSheetSyncEnabled: true, employeeSheetSyncFirstAppliedAt: at.toISOString() })
  })

  it('updateSettings toggles the switch via upsert and keeps Thursday', async () => {
    m.prisma.settings.upsert.mockResolvedValue({
      payrollWeekStartDay: 'THURSDAY',
      employeeSheetSyncEnabled: true,
      employeeSheetSyncFirstAppliedAt: null,
    })
    const r = await updateSettings({ employeeSheetSyncEnabled: true })
    expect(r.employeeSheetSyncEnabled).toBe(true)
    const arg = m.prisma.settings.upsert.mock.calls[0][0]
    expect(arg.update).toMatchObject({ employeeSheetSyncEnabled: true, payrollWeekStartDay: 'THURSDAY' })
    expect(arg.update).not.toHaveProperty('employeeSheetSyncFirstAppliedAt')
  })

  it('turning the switch off never clears firstAppliedAt', async () => {
    m.prisma.settings.upsert.mockResolvedValue({ payrollWeekStartDay: 'THURSDAY', employeeSheetSyncEnabled: false, employeeSheetSyncFirstAppliedAt: new Date() })
    await updateSettings({ employeeSheetSyncEnabled: false })
    expect(m.prisma.settings.upsert.mock.calls[0][0].update).not.toHaveProperty('employeeSheetSyncFirstAppliedAt')
  })

  it('still rejects a non-Thursday week start, and an empty request', async () => {
    await expect(updateSettings({ payrollWeekStartDay: 'MONDAY' })).rejects.toMatchObject({ code: 'WEEK_START_LOCKED' })
    await expect(updateSettings({} as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(m.prisma.settings.upsert).not.toHaveBeenCalled()
  })

  it('schema rejects a non-boolean switch value', () => {
    expect(UpdateSettingsSchema.safeParse({ employeeSheetSyncEnabled: 'yes' }).success).toBe(false)
    expect(UpdateSettingsSchema.safeParse({ employeeSheetSyncEnabled: true }).success).toBe(true)
  })
})
