import { Metadata } from 'next'
import { AppShell } from '@/components/layout/AppShell'
import { PayrollHistorySearch } from '@/features/payroll-history/components/PayrollHistorySearch'
import { PayrollHistoryFilter } from '@/features/payroll-history/components/PayrollHistoryFilter'
import { PayrollHistoryTable } from '@/features/payroll-history/components/PayrollHistoryTable'
import type { PayrollHistoryRow } from '@/features/payroll-history/types/payroll-history.types'
import {
  searchPayrollHistory,
  getPayrollHistoryByWeek,
  getApprovedPayrollWeeks
} from '@/features/payroll-history/services/payroll-history.service'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Payroll History — TPL Payroll',
  description: 'View historical payroll data',
}

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function PayrollHistoryPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams
  const search = typeof resolvedParams.search === 'string' ? resolvedParams.search : undefined
  const week = typeof resolvedParams.week === 'string' ? resolvedParams.week : undefined

  // Fetch approved weeks for the filter dropdown
  const weeks = await getApprovedPayrollWeeks()

  let rows: PayrollHistoryRow[] = []

  if (search && week) {
    // If both are provided, we search by employee, then filter the results by week in memory
    // or we could just call getPayrollHistoryByWeek and filter by employee.
    const weekParts = week.split('_')
    const allForWeek = await getPayrollHistoryByWeek(weekParts[0], weekParts[1])
    const searchLower = search.toLowerCase()
    rows = allForWeek.filter(r => 
      r.employeeName.toLowerCase().includes(searchLower) || 
      r.employeeIdString.toLowerCase().includes(searchLower)
    )
  } else if (week) {
    const weekParts = week.split('_')
    rows = await getPayrollHistoryByWeek(weekParts[0], weekParts[1])
  } else if (search) {
    // We try by employee ID first, if no results, try by name.
    rows = await searchPayrollHistory({ employeeId: search })
    if (rows.length === 0) {
      rows = await searchPayrollHistory({ employeeName: search })
    }
  } else {
    // Default: Show the most recent approved week
    if (weeks.length > 0) {
      rows = await getPayrollHistoryByWeek(weeks[0].weekStart, weeks[0].weekEnd)
    }
  }

  return (
    <AppShell>
      <div className="space-y-8 w-full max-w-[1400px] mx-auto pb-16">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
          Payroll History
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4">
          <PayrollHistorySearch />
          <PayrollHistoryFilter weeks={weeks} />
        </div>

        <PayrollHistoryTable rows={rows} />
      </div>
    </AppShell>
  )
}
