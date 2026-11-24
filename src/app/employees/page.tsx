import { AppShell } from '@/components/layout/AppShell'
import { EmployeeListTable } from '@/features/employee-management/components/EmployeeListTable'
import { getLastSheetSync } from '@/features/employee-sheet-sync/services/sync.service'
import { getEmployeeSheetSyncState } from '@/features/settings/services/settings.service'

export const dynamic = 'force-dynamic'


export const metadata = {
  title: 'Team Directory — TPL Payroll',
  description: 'Browse, search, and manage all employee records.',
}

export default async function EmployeesPage() {
  const { enabled, firstApplied } = await getEmployeeSheetSyncState()
  // The last run is only shown while the sync is on; a failed read must not break the directory.
  const lastSheetSync = enabled ? await getLastSheetSync().catch(() => null) : null

  return (
    <AppShell>
      <EmployeeListTable
        sheetSyncEnabled={enabled}
        sheetSyncFirstApplied={firstApplied}
        lastSheetSync={lastSheetSync}
      />
    </AppShell>
  )
}
