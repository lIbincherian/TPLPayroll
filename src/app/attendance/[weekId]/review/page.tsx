import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { AppShell } from '@/components/layout/AppShell'
import { ExcelWeekView } from '@/features/attendance-sync/components/ExcelWeekView'
import { LoadErrorBanner } from '@/features/attendance-sync/components/LoadErrorBanner'
import { PunchReviewGrid } from '@/features/attendance-sync/components/PunchReviewGrid'
import { ReviewGridSkeleton } from '@/features/attendance-sync/components/ReviewGridSkeleton'
import { StatusChangesNotice } from '@/features/attendance-sync/components/StatusChangesNotice'
import { getAttendanceWeekStatus } from '@/features/attendance-sync/lib/review'
import { parseWeekId, toISODate, toUtcDate } from '@/features/attendance-sync/lib/week'
import { getExcelWeekData } from '@/features/attendance-sync/services/excel-week.service'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { getWeekStatusChanges } from '@/features/attendance-sync/services/status-changes.service'
import { getWeekByStart } from '@/features/attendance-sync/services/week-list.service'
import { AttendanceSyncError, type LiveReview } from '@/features/attendance-sync/types/attendance-sync.types'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Punch review — TPL Payroll',
}

interface Props {
  params: Promise<{ weekId: string }>
}

/** Any real calendar date. Excel-era weeks could start on a day other than Thursday. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = toUtcDate(value)
  return !Number.isNaN(date.getTime()) && toISODate(date) === value
}

async function ReviewContent({ weekId }: { weekId: string }) {
  const row = await getWeekByStart(toUtcDate(weekId))
  if (!row) {
    // No week by that start: a real Thursday just has nothing loaded yet; anything else isn't a payroll week.
    if (!parseWeekId(weekId)) notFound()
    redirect('/attendance')
  }

  // Excel-era weeks open a read-only view: hours per day, no pull, reopen or edit.
  if (row.source === 'EXCEL') {
    const data = await getExcelWeekData(row)
    if (!data) notFound()
    return <ExcelWeekView data={data} />
  }

  if (!parseWeekId(weekId)) notFound()

  // Nothing was loaded for this week, so there is nothing to review.
  const status = getAttendanceWeekStatus(row)
  if (status === 'NO_DATA' || status === 'SYNC_FAILED') redirect('/attendance')

  let review: LiveReview
  try {
    review = await getPunchReview(weekId, { kind: 'LIVE' })
  } catch (e) {
    if (e instanceof AttendanceSyncError) return <LoadErrorBanner message="Couldn't load this week's punches." />
    throw e
  }

  // Codes that match no employee are fixed first; the grid can't be finished without them.
  if (review.status === 'REVIEW' && review.counts.unresolvedCodes > 0) {
    redirect(`/attendance/${weekId}/employee-check`)
  }

  // Only an approved week has made status changes; a reopened week shows them again once re-approved.
  const statusChanges = review.status === 'APPROVED' ? await getWeekStatusChanges(review.week.start) : null
  return (
    <PunchReviewGrid
      initialReview={review}
      backHref="/attendance"
      backLabel="Attendance"
      title="Punch review"
      notice={statusChanges && <StatusChangesNotice changes={statusChanges} />}
      markedInactiveCount={statusChanges?.markedInactive.length ?? 0}
    />
  )
}

export default async function ReviewPage({ params }: Props) {
  const { weekId } = await params
  if (!isCalendarDate(weekId)) notFound()

  return (
    <AppShell>
      <Suspense fallback={<ReviewGridSkeleton />}>
        <ReviewContent weekId={weekId} />
      </Suspense>
    </AppShell>
  )
}
