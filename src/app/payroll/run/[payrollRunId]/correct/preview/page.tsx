import { notFound, redirect } from 'next/navigation'
import prisma from '@/lib/prisma'
import { getActiveCorrection, getRevisionEmployees } from '@/features/payroll-correction/services/correction.service'
import { RevisedPreview } from '@/features/payroll-correction/components/RevisedPreview'
import { AppShell } from '@/components/layout/AppShell'

export const dynamic = 'force-dynamic'


interface Props {
  params: Promise<{ payrollRunId: string }>
}

export async function generateMetadata({ params }: Props) {
  const { payrollRunId } = await params
  return { title: `Revised Payroll Preview — ${payrollRunId} — TPL Payroll` }
}

function formatWeekRange(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  return `${start.toLocaleDateString('en-IN', opts)} – ${end.toLocaleDateString('en-IN', opts)}`
}

export default async function RevisedPreviewPage({ params }: Props) {
  const { payrollRunId } = await params

  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: {
        orderBy: { revisionNumber: 'desc' },
        take: 2,
      },
    },
  })

  if (!run) notFound()

  // The preview shows the draft. The current revision stays current until the draft is approved.
  const draftRevision = run.revisions.find((r) => r.status === 'DRAFT')
  const currentRevision = run.revisions.find((r) => r.isCurrent)

  if (!draftRevision) redirect(`/payroll/run/${payrollRunId}/correct`)
  if (!currentRevision) notFound()

  const weekLabel = formatWeekRange(run.payrollWeekStartDate, run.payrollWeekEndDate)

  // Fetch employee data with diffs against the current revision
  const employees = await getRevisionEmployees(draftRevision.id, currentRevision.id)

  // Draft totals
  const totals = {
    totalRegularHours: employees.reduce((s, e) => s + e.regularHours, 0),
    totalOvertimeHours: employees.reduce((s, e) => s + e.overtimeHours, 0),
    totalRegularPay: Number(draftRevision.totalRegularPay),
    totalOvertimePay: Number(draftRevision.totalOvertimePay),
    totalAdditions: Number(draftRevision.totalAdditions),
    totalDeductions: Number(draftRevision.totalDeductions),
    totalNetPayable: Number(draftRevision.totalNetPayable),
  }

  // Current revision totals for diff display
  const previousTotals = {
    totalRegularHours: 0,
    totalOvertimeHours: 0,
    totalRegularPay: Number(currentRevision.totalRegularPay),
    totalOvertimePay: Number(currentRevision.totalOvertimePay),
    totalAdditions: Number(currentRevision.totalAdditions),
    totalDeductions: Number(currentRevision.totalDeductions),
    totalNetPayable: Number(currentRevision.totalNetPayable),
  }

  // Back goes to the punches when this was an Attendance correction, otherwise to the reason step.
  const activeSession = await getActiveCorrection(payrollRunId)
  const editsPunches = !!activeSession?.hasPunchClone
  const backHref = editsPunches
    ? `/payroll/run/${payrollRunId}/correct/punches`
    : `/payroll/run/${payrollRunId}/correct`

  return (
    <AppShell>
      <RevisedPreview
        payrollRunId={payrollRunId}
        revisionId={draftRevision.id}
        revisionNumber={draftRevision.revisionNumber}
        currentRevisionNumber={currentRevision.revisionNumber}
        weekLabel={weekLabel}
        employees={employees}
        totals={totals}
        previousTotals={previousTotals}
        backHref={backHref}
        hasPunchEdits={editsPunches}
      />
    </AppShell>
  )
}
