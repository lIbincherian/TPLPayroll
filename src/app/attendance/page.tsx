import { Suspense } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { getAttendanceWeeksAction } from '@/features/attendance-sync/actions/attendance-sync.actions'
import { AttendancePageHeader } from '@/features/attendance-sync/components/AttendancePageHeader'
import { AttendanceWeekList } from '@/features/attendance-sync/components/AttendanceWeekList'
import { LoadErrorBanner } from '@/features/attendance-sync/components/LoadErrorBanner'
import { WeekListSkeleton } from '@/features/attendance-sync/components/WeekListSkeleton'
import { todayInIST } from '@/features/attendance-sync/lib/week'

export const dynamic = 'force-dynamic'
// Pull now runs as a server action on this page and waits for eTimeOffice (up to 45 s).
// 45 s API timeout + 30 s save transaction + reads; must stay under SYNC_LOCK_TTL_MS (300 s) so a
// running pull never loses its lock, and under the Vercel Hobby cap (300 s with Fluid compute).
export const maxDuration = 120

export const metadata = {
  title: 'Attendance — TPL Payroll',
}

async function AttendanceWeeks() {
  const result = await getAttendanceWeeksAction()
  if (!result.ok) {
    return (
      <>
        <AttendancePageHeader />
        <LoadErrorBanner message="Couldn't load attendance weeks." />
      </>
    )
  }
  return <AttendanceWeekList weeks={result.data} todayISO={todayInIST()} />
}

export default function AttendancePage() {
  return (
    <AppShell>
      <Suspense fallback={<WeekListSkeleton />}>
        <AttendanceWeeks />
      </Suspense>
    </AppShell>
  )
}
