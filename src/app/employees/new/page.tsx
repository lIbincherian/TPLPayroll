import { AppShell } from '@/components/layout/AppShell'
import { EmployeeForm } from '@/features/employee-management/components/EmployeeForm'
import { buildCreateReturnContext } from '@/features/employee-management/lib/return-context'

export const dynamic = 'force-dynamic'


export const metadata = {
  title: 'Add Employee — TPL Payroll',
  description: 'Create a new employee record in the master database.',
}

interface Props {
  // The attendance employee check sends returnTo, the eTimeOffice name and the code.
  searchParams: Promise<{ returnTo?: string; name?: string; code?: string }>
}

export default async function NewEmployeePage({ searchParams }: Props) {
  const { returnTo, name, code } = await searchParams

  return (
    <AppShell>
      <EmployeeForm mode="create" returnContext={buildCreateReturnContext({ returnTo, name, code })} />
    </AppShell>
  )
}
