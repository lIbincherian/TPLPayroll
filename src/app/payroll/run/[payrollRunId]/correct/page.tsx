import { notFound, redirect } from 'next/navigation'
import { initiateCorrection, getActiveCorrection } from '@/features/payroll-correction/services/correction.service'
import { CorrectionFlow } from '@/features/payroll-correction/components/CorrectionFlow'
import { CorrectionServiceError } from '@/features/payroll-correction/types/correction.types'
import { AppShell } from '@/components/layout/AppShell'

export const dynamic = 'force-dynamic'


interface Props {
  params: Promise<{ payrollRunId: string }>
}

export async function generateMetadata({ params }: Props) {
  const { payrollRunId } = await params
  return { title: `Correct Payroll — ${payrollRunId} — TPL Payroll` }
}

function formatWeekRange(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  return `${start.toLocaleDateString('en-IN', opts)} – ${end.toLocaleDateString('en-IN', opts)}`
}

export default async function PayrollCorrectionPage({ params }: Props) {
  const { payrollRunId } = await params

  let data
  try {
    data = await initiateCorrection(payrollRunId)
  } catch (e) {
    if (e instanceof CorrectionServiceError) {
      if (e.code === 'PAYROLL_RUN_NOT_FOUND') notFound()
      if (e.code === 'CANNOT_CORRECT_UNAPPROVED_PAYROLL') {
        return (
          <AppShell>
            <main className="mx-auto max-w-4xl px-4 py-12">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
                Cannot Correct Payroll
              </h1>
              <p className="mt-2 text-sm text-zinc-500">
                This payroll run has not been approved yet and cannot be corrected.
              </p>
            </main>
          </AppShell>
        )
      }
    }
    throw e
  }

  // A correction starts from the Correct button on the payroll run, which opens (or resumes)
  // the session. Without one there is nothing to edit here.
  const activeSession = await getActiveCorrection(payrollRunId)
  if (!activeSession) redirect(`/payroll/run/${payrollRunId}`)

  const weekLabel = `Week ${formatWeekRange(data.weekStart, data.weekEnd)}`

  return (
    <AppShell>
      <CorrectionFlow data={data} weekLabel={weekLabel} activeSession={activeSession} />
    </AppShell>
  )
}
