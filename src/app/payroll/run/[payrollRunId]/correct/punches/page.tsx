import { notFound, redirect } from 'next/navigation'
import prisma from '@/lib/prisma'
import { AppShell } from '@/components/layout/AppShell'
import {
  abandonCorrectionAction,
  approveCorrectionPunchesAction,
} from '@/features/payroll-correction/actions/correction.actions'
import { getActiveCorrection } from '@/features/payroll-correction/services/correction.service'
import { PunchReviewGrid } from '@/features/attendance-sync/components/PunchReviewGrid'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ payrollRunId: string }>
}

export async function generateMetadata({ params }: Props) {
  const { payrollRunId } = await params
  return { title: `Correct Punches — ${payrollRunId} — TPL Payroll` }
}

export default async function CorrectionPunchesPage({ params }: Props) {
  const { payrollRunId } = await params

  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    select: { id: true, status: true, currentRevisionNumber: true },
  })
  if (!run || (run.status !== 'APPROVED' && run.status !== 'REVISED')) notFound()

  // The punches are only editable once "Continue to punches" has copied them for this correction.
  const session = await getActiveCorrection(payrollRunId)
  if (!session || !session.hasPunchClone) redirect(`/payroll/run/${payrollRunId}/correct`)

  let review
  try {
    review = await getPunchReview(session.weekId, {
      kind: 'CORRECTION',
      payrollRunId,
      correctionId: session.sessionId,
      revisionNumber: run.currentRevisionNumber,
    })
  } catch (e) {
    if (e instanceof AttendanceSyncError) redirect(`/payroll/run/${payrollRunId}/correct`)
    throw e
  }

  return (
    <AppShell>
      <PunchReviewGrid
        initialReview={review}
        backHref={`/payroll/run/${payrollRunId}/correct`}
        backLabel="Reason"
        title="Correct punches"
        correctionReason={session.correctionReason}
        onApproveCorrection={approveCorrectionPunchesAction}
        onAbandonCorrection={abandonCorrectionAction}
      />
    </AppShell>
  )
}
