import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr'
import prisma from '@/lib/prisma'
import { AppShell } from '@/components/layout/AppShell'
import { getActiveCorrection } from '@/features/payroll-correction/services/correction.service'
import { CorrectionPunchesActions } from '@/features/payroll-correction/components/CorrectionPunchesActions'
import { CorrectionPunchesList } from '@/features/payroll-correction/components/CorrectionPunchesList'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import { formatWeekLabel } from '@/features/attendance-sync/lib/week'
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
      <main className="mx-auto max-w-6xl px-4 py-12">
        <Link
          href={`/payroll/run/${payrollRunId}/correct`}
          className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-700"
        >
          <ArrowLeft size={16} />
          Reason
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Correct punches</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {formatWeekLabel(review.week)} · Revision {run.currentRevisionNumber} current
        </p>

        <div className="mt-6 space-y-6">
          <CorrectionPunchesActions
            payrollRunId={payrollRunId}
            currentRevisionNumber={run.currentRevisionNumber}
            needsFixingDays={review.counts.needsFixingDays}
            reason={session.correctionReason}
          />
          <CorrectionPunchesList review={review} />
        </div>
      </main>
    </AppShell>
  )
}
