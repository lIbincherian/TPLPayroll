import type { EmployeeReturnContext } from '../components/EmployeeForm'

// The attendance employee check sends people to /employees/new or /employees/[id]/edit with
// ?returnTo=…&name=…&code=… and expects them back afterwards. These helpers turn those search
// params into the form's return context.

const ALLOWED_RETURN_PATH = /^\/(attendance|payroll)\//
const BACK_LABEL = 'Return to employee check'

type Param = string | string[] | undefined

function first(value: Param): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Only in-app attendance and payroll paths are honoured; anything else is dropped. */
export function parseReturnTo(raw: Param): string | undefined {
  const value = first(raw)
  if (!value || !ALLOWED_RETURN_PATH.test(value) || value.includes('//', 1) || value.includes('\\')) return undefined
  return value
}

/** "Employee ID must end in 999 to match code 0999", for a numeric code. */
export function employeeIdHintForCode(code: string | undefined): string | undefined {
  if (!code || !/^\d+$/.test(code)) return undefined
  return `Employee ID must end in ${parseInt(code, 10)} to match code ${code}`
}

export function buildCreateReturnContext(params: {
  returnTo?: Param
  name?: Param
  code?: Param
}): EmployeeReturnContext | undefined {
  const returnTo = parseReturnTo(params.returnTo)
  if (!returnTo) return undefined
  return {
    returnTo,
    backLabel: BACK_LABEL,
    prefillName: first(params.name)?.trim() || undefined,
    employeeIdHint: employeeIdHintForCode(first(params.code)),
  }
}

export function buildEditReturnContext(params: { returnTo?: Param }): EmployeeReturnContext | undefined {
  const returnTo = parseReturnTo(params.returnTo)
  return returnTo ? { returnTo, backLabel: BACK_LABEL } : undefined
}
