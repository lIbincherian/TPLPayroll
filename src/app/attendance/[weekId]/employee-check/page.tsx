import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { AppShell } from '@/components/layout/AppShell'
import { getEmployeeCheckAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { EmployeeCheck } from '@/features/attendance-sync/components/EmployeeCheck'
import { EmployeeCheckSkeleton } from '@/features/attendance-sync/components/EmployeeCheckSkeleton'
import { LoadErrorBanner } from '@/features/attendance-sync/components/LoadErrorBanner'
import { getAttendanceWeekStatus } from '@/features/attendance-sync/lib/review'
import { parseWeekId, toUtcDate } from '@/features/attendance-sync/lib/week'
import { getWeekByStart } from '@/features/attendance-sync/services/week-list.service'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Employee check — TPL Payroll',
}

interface Props {
  params: Promise<{ weekId: string }>
}

async function EmployeeCheckContent({ weekId, weekStart }: { weekId: string; weekStart: string }) {
  const row = await getWeekByStart(toUtcDate(weekStart))
  if (!row) redirect('/attendance')
  // Excel-era weeks have no codes to check; their read-only view is the review page.
  if (row.source === 'EXCEL') redirect(`/attendance/${weekId}/review`)

  const status = getAttendanceWeekStatus(row)
  // Nothing was loaded for this week, so there is nothing to check.
  if (status === 'NO_DATA' || status === 'SYNC_FAILED') redirect('/attendance')

  const result = await getEmployeeCheckAction(weekId)
  if (!result.ok) return <LoadErrorBanner message="Couldn't load the employee check." />
  return <EmployeeCheck initial={result.data} status={status} />
}

export default async function EmployeeCheckPage({ params }: Props) {
  const { weekId } = await params
  const week = parseWeekId(weekId)
  if (!week) notFound()

  return (
    <AppShell>
      <Suspense fallback={<EmployeeCheckSkeleton />}>
        <EmployeeCheckContent weekId={weekId} weekStart={week.start} />
      </Suspense>
    </AppShell>
  )
}
