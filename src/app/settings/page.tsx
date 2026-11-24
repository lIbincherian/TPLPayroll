import { AppShell } from '@/components/layout/AppShell'
import { SettingsForm } from '@/features/settings/components/SettingsForm'
import { getSettingsAction } from '@/features/settings/actions/settings.actions'
import type { AppSettings } from '@/features/settings/types/settings.types'

export const dynamic = 'force-dynamic'


export const metadata = { title: 'Settings — TPL Payroll' }

const DEFAULT_SETTINGS: AppSettings = {
  payrollWeekStartDay: 'THURSDAY',
  currency: 'INR',
  docExpiryThresholdDays: 7,
  employeeSheetSyncEnabled: false,
  employeeSheetSyncFirstAppliedAt: null,
}

export default async function SettingsPage() {
  const result = await getSettingsAction()
  const settings = result.ok ? result.data : DEFAULT_SETTINGS

  return (
    <AppShell>
      <div className="space-y-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Settings</h1>
        <SettingsForm initialSettings={settings} />
      </div>
    </AppShell>
  )
}
