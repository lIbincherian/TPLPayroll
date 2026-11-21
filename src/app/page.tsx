import {
  UsersIcon,
  CurrencyInrIcon,
  WarningIcon,
  ClockIcon,
} from '@phosphor-icons/react/dist/ssr'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { DashboardCardSkeleton } from '@/components/dashboard/DashboardCardSkeleton'
import { DashboardError } from '@/components/dashboard/DashboardError'
import { AppShell } from '@/components/layout/AppShell'
import {
  countActiveEmployees,
  getLatestPayrollTotal,
  countAttendanceWeeksAwaitingReview,
  countPendingAdjustmentApprovals,
} from '@/services/dashboard.service'
import { Suspense } from 'react'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

export const dynamic = 'force-dynamic'


export const metadata = {
  title: 'Dashboard — TPL Payroll',
  description: 'Overview of key operational metrics for the current payroll period.',
}

async function DashboardMetrics() {
  let activeEmployees: number
  let payrollTotal: number
  let attendanceErrors: number
  let pendingApprovals: number

  try {
    ;[activeEmployees, payrollTotal, attendanceErrors, pendingApprovals] =
      await Promise.all([
        countActiveEmployees(),
        getLatestPayrollTotal(),
        countAttendanceWeeksAwaitingReview(),
        countPendingAdjustmentApprovals(),
      ])
  } catch {
    return <DashboardError />
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {/* Row 1: Asymmetric 2fr / 1fr */}
      <div
        className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4 md:gap-6"
      >
        <DashboardCard
          label="Active Team Members"
          value={String(activeEmployees)}
          icon={<UsersIcon size={20} weight="regular" />}
          href="/employees"
          index={0}
          className="[--icon-color:theme(colors.emerald.500)]"
        />
        <DashboardCard
          label="Latest Payroll Total"
          value={`₹${formatNetPay(payrollTotal)}`}
          icon={<CurrencyInrIcon size={20} weight="regular" />}
          href="/payroll"
          index={1}
        />
      </div>

      {/* Row 2: Equal 2-column */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        <DashboardCard
          label="Attendance Awaiting Review"
          value={String(attendanceErrors)}
          icon={<WarningIcon size={20} weight="regular" className="text-amber-500" />}
          href="/attendance"
          index={2}
        />
        <DashboardCard
          label="Awaiting Adjustments"
          value={String(pendingApprovals)}
          icon={<ClockIcon size={20} weight="regular" />}
          href="/adjustments"
          index={3}
        />
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4 md:gap-6">
        <DashboardCardSkeleton />
        <DashboardCardSkeleton />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        <DashboardCardSkeleton />
        <DashboardCardSkeleton />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-6 md:gap-8">
        {/* Page header */}
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
          Dashboard
        </h1>

        {/* Metric grid — streamed via Suspense */}
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardMetrics />
        </Suspense>
      </div>
    </AppShell>
  )
}
