import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { trailingNumber } from '@/features/attendance-sync/lib/matching'
import { DATE_FIELDS, SHEET_OWNED_FIELDS } from '../lib/columns'
import type { EmployeeSnapshot, FieldValue, SheetOwnedField } from '../types/employee-sheet-sync.types'

type Db = Pick<Prisma.TransactionClient, 'employee'>

function toFieldValue(field: SheetOwnedField, value: unknown): FieldValue {
  if (value === null || value === undefined) return null
  if (DATE_FIELDS.has(field)) return (value as Date).toISOString().slice(0, 10)
  const text = String(value).trim()
  return text === '' ? null : text
}

/** Every employee with the fields the sheet owns and the daily wage of the open wage row. */
export async function loadEmployeeSnapshot(db: Db = prisma): Promise<EmployeeSnapshot[]> {
  const select: Record<string, boolean | object> = {
    id: true,
    employeeId: true,
    employeeName: true,
    isActive: true,
    wageHistory: { where: { effectiveTo: null }, select: { weeklySalary: true }, take: 1 },
  }
  for (const field of SHEET_OWNED_FIELDS) select[field] = true

  const rows = (await db.employee.findMany({ select, orderBy: { employeeId: 'asc' } })) as unknown as Array<
    Record<string, unknown> & {
      id: string
      employeeId: string
      employeeName: string
      isActive: boolean
      wageHistory: Array<{ weeklySalary: unknown }>
    }
  >

  return rows.map((row) => {
    const fields = {} as Record<SheetOwnedField, FieldValue>
    for (const field of SHEET_OWNED_FIELDS) fields[field] = toFieldValue(field, row[field])
    return {
      id: row.id,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      number: trailingNumber(row.employeeId),
      isActive: row.isActive,
      openWage: row.wageHistory[0] ? Number(row.wageHistory[0].weeklySalary) : null,
      fields,
    }
  })
}
