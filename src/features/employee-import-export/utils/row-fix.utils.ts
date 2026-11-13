import { normalizeEmployeeId } from './normalize'
import type {
  InvalidImportRow,
  ValidImportRow,
  ImportRowErrorCode,
  FixRowFormValues,
} from '@/features/employee-import-export/types/import-export.types'

export function applyRowFix(
  invalidRow: InvalidImportRow,
  formValues: FixRowFormValues,
  existingEmployeeIds: Set<string>
): ValidImportRow | ImportRowErrorCode[] {
  const errors: ImportRowErrorCode[] = []

  // Resolve each required field: form value (for errored fields) takes priority over partialData
  const rawEmployeeId =
    (formValues.employeeId?.trim() || invalidRow.partialData.employeeId) ?? null
  const employeeId = rawEmployeeId ? normalizeEmployeeId(rawEmployeeId) : null
  const employeeName =
    (formValues.employeeName?.trim() || invalidRow.partialData.employeeName) ?? null
  const designation =
    (formValues.designation?.trim() || invalidRow.partialData.designation) ?? null

  // Daily wage
  let salary: number | null = invalidRow.partialData.salary ?? null
  if (formValues.salary !== undefined) {
    const parsed = Number(formValues.salary)
    salary = !isNaN(parsed) && parsed >= 0 ? parsed : null
  }

  // isActive
  let isActive: boolean | null = invalidRow.partialData.isActive ?? null
  if (formValues.isActive !== undefined) {
    isActive = formValues.isActive === 'true'
  }

  // Validate
  if (!employeeId) errors.push('MISSING_EMPLOYEE_ID')
  if (!employeeName) errors.push('MISSING_EMPLOYEE_NAME')
  if (!designation) errors.push('MISSING_DESIGNATION')
  if (salary === null) {
    errors.push(formValues.salary !== undefined ? 'INVALID_SALARY' : 'MISSING_SALARY')
  }
  if (isActive === null) errors.push('MISSING_ACTIVE')

  if (errors.length > 0) return errors

  const action = existingEmployeeIds.has(employeeId!) ? 'UPDATE' : 'CREATE'

  return {
    rowNumber: invalidRow.rowNumber,
    action,
    source: 'fixed',
    data: {
      serialNumber: invalidRow.partialData.serialNumber ?? null,
      employeeId: employeeId!,
      employeeName: employeeName!,
      nationalId: invalidRow.partialData.nationalId ?? null,
      designation: designation!,
      dateOfJoining: invalidRow.partialData.dateOfJoining ?? null,
      aadhaarId: invalidRow.partialData.aadhaarId ?? null,
      policeVerificationId: invalidRow.partialData.policeVerificationId ?? null,
      salary: salary!,
      phone: invalidRow.partialData.phone ?? null,
      dateOfBirth: invalidRow.partialData.dateOfBirth ?? null,
      healthCardId: invalidRow.partialData.healthCardId ?? null,
      gPay: invalidRow.partialData.gPay ?? null,
      bankAccount: invalidRow.partialData.bankAccount ?? null,
      dateOfResignation: invalidRow.partialData.dateOfResignation ?? null,
      site: invalidRow.partialData.site ?? null,
      isActive: isActive!,
      designationShort: invalidRow.partialData.designationShort ?? null,
    },
  }
}
