import { notFound } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, PencilSimple, FileText, Package } from '@phosphor-icons/react/dist/ssr'
import prisma from '@/lib/prisma'
import { ReportSection } from '@/features/payroll-reports/components/ReportSection'
import { RevisionHistoryTable } from '@/features/payroll-correction/components/RevisionHistoryTable'
import {
  getActiveCorrection,
  getRevisionHistory,
} from '@/features/payroll-correction/services/correction.service'
import { beginPayrollCorrectionAction } from '@/features/payroll-correction/actions/correction.actions'
import { AppShell } from '@/components/layout/AppShell'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

export const dynamic = 'force-dynamic'


interface Props {
  params: Promise<{ payrollRunId: string }>
}

export async function generateMetadata({ params }: Props) {
  const { payrollRunId } = await params
  return { title: `Payroll Run — ${payrollRunId} — TPL Payroll` }
}

function formatWeekRange(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  return `${start.toLocaleDateString('en-IN', opts)} – ${end.toLocaleDateString('en-IN', opts)}`
}

export default async function PayrollRunPage({ params }: Props) {
  const { payrollRunId } = await params

  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: {
        where: { isCurrent: true },
        take: 1,
      },
      runEmployees: {
        include: {
          employee: {
            select: {
              employeeId: true,
              employeeName: true,
              designation: true,
              site: true,
              gPay: true,
              bankAccount: true,
            },
          },
        },
        orderBy: { employee: { employeeId: 'asc' } },
      },
    },
  })

  if (!run || (run.status !== 'APPROVED' && run.status !== 'REVISED')) notFound()

  const weekLabel = formatWeekRange(run.payrollWeekStartDate, run.payrollWeekEndDate)
  const currentRevision = run.revisions[0]
  const revisionNumber = currentRevision?.revisionNumber ?? run.currentRevisionNumber

  // Get current revision's employee records (use the latest revision)
  let currentEmployees = run.runEmployees
  if (currentRevision) {
    const revisionEmployees = await prisma.payrollRunEmployee.findMany({
      where: { payrollRevisionId: currentRevision.id },
      include: {
        employee: {
          select: {
            employeeId: true,
            employeeName: true,
            designation: true,
            site: true,
            gPay: true,
            bankAccount: true,
          },
        },
      },
      orderBy: { employee: { employeeId: 'asc' } },
    })
    if (revisionEmployees.length > 0) {
      currentEmployees = revisionEmployees
    }
  }

  const employeeCount = currentEmployees.length

  // Fetch revision history
  const revisions = await getRevisionHistory(payrollRunId)

  // A correction left open (for example by closing the tab) is resumed, not started again
  const activeCorrection = await getActiveCorrection(payrollRunId)
  const attendanceWeekId = run.payrollWeekStartDate.toISOString().slice(0, 10)

  // Use current revision totals if available
  const displayTotals = currentRevision
    ? {
        totalRegularPay: Number(currentRevision.totalRegularPay),
        totalOvertimePay: Number(currentRevision.totalOvertimePay),
        totalAdditions: Number(currentRevision.totalAdditions),
        totalDeductions: Number(currentRevision.totalDeductions),
        totalNetPayable: Number(currentRevision.totalNetPayable),
      }
    : {
        totalRegularPay: Number(run.totalRegularPay),
        totalOvertimePay: Number(run.totalOvertimePay),
        totalAdditions: Number(run.totalAdditions),
        totalDeductions: Number(run.totalDeductions),
        totalNetPayable: Number(run.totalNetPayable),
      }

  return (
    <AppShell>
      <main className="mx-auto max-w-4xl px-4 py-12">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 mb-2">
          <CheckCircle size={28} weight="fill" className="text-emerald-500 mt-0.5 shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              Payroll — {weekLabel}
            </h1>
            <span className="mt-1 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Approved (Revision {revisionNumber})
            </span>
          </div>
        </div>

        {/* ── Stats ───────────────────────────────────────────────────── */}
        <div className="mt-6 flex gap-8">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Employees</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900">
              {employeeCount}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Net Payable</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900">
              ₹{formatNetPay(displayTotals.totalNetPayable)}
            </p>
          </div>
        </div>

        {/* ── Action bar ──────────────────────────────────────────────── */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {activeCorrection ? (
            <div className="flex items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              <PencilSimple size={14} className="text-amber-500" />
              <span>Correction in progress</span>
              <Link
                href={`/payroll/run/${payrollRunId}/correct`}
                className="font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
              >
                Resume
              </Link>
            </div>
          ) : (
            <form action={beginPayrollCorrectionAction.bind(null, payrollRunId)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 active:scale-[0.98]"
              >
                <PencilSimple size={14} />
                Correct
              </button>
            </form>
          )}
          <Link
            href={`/attendance/${attendanceWeekId}/review`}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-[background-color,transform] duration-150 ease-out hover:bg-zinc-50 active:scale-[0.98]"
          >
            Attendance
          </Link>
        </div>

        {/* ── Reports ─────────────────────────────────────────────────── */}
        <ReportSection payrollRunId={payrollRunId} employeeCount={employeeCount} />

        {/* ── Revision History ────────────────────────────────────────── */}
        <RevisionHistoryTable revisions={revisions} />

        {/* ── Payroll Summary table ────────────────────────────────────── */}
        <section className="border-t border-zinc-200/60 pt-8 mt-8">
          <p className="text-sm font-medium text-zinc-900 mb-4">Current Payroll Summary</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-zinc-200">
                  {['ID', 'Employee', 'GPay', 'Bank', 'Net Pay'].map(
                    (h) => (
                      <th
                        key={h}
                        className="pb-2 pr-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 last:text-right"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {currentEmployees.map((re) => (
                  <tr key={re.id} className="hover:bg-zinc-50/50">
                    <td className="py-2 pr-4 text-zinc-700">{re.employee.employeeId}</td>
                    <td className="py-2 pr-4 font-sans text-zinc-900">{re.employee.employeeName}</td>
                    <td className="py-2 pr-4 text-zinc-500">{re.employee.gPay ?? '—'}</td>
                    <td className="py-2 pr-4 text-zinc-500">{re.employee.bankAccount ?? '—'}</td>
                    <td className="py-2 text-right font-semibold text-zinc-900">₹{formatNetPay(Number(re.netPayable))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-200">
                  <td colSpan={4} className="py-2 pr-4 text-xs font-medium uppercase tracking-wider text-zinc-400">
                    Totals
                  </td>
                  <td className="py-2 text-right font-bold text-zinc-900">
                    ₹{formatNetPay(displayTotals.totalNetPayable)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* ── Back link ────────────────────────────────────────────────── */}
        <div className="mt-8">
          <Link
            href="/payroll"
            className="text-sm text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-700 hover:underline"
          >
            ← Back to Payroll
          </Link>
        </div>
      </main>
    </AppShell>
  )
}
