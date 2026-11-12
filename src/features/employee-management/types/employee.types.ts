import { z } from 'zod'

// ─── Status ───────────────────────────────────────────────────────────────────

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'RESIGNED'

// ─── Zod schemas (shared client + server validation) ──────────────────────────

export const CreateEmployeeSchema = z.object({
  employeeId: z.string().min(1, 'Employee ID is required'),
  employeeName: z.string().min(1, 'Employee Name is required'),
  designation: z.string().min(1, 'Designation is required'),
  designationShort: z.string().optional(),
  nationalId: z.string().optional(),
  aadhaarId: z.string().optional(),
  policeVerificationId: z.string().optional(),
  phone: z.string().optional(),
  dateOfBirth: z.date().optional().nullable(),
  dateOfJoining: z.date().optional().nullable(),
  site: z.string().optional(),
  healthCardId: z.string().optional(),
  gPay: z.string().optional(),
  bankAccount: z.string().optional(),
  dateOfResignation: z.date().optional().nullable(),
  isActive: z.boolean().default(true),
  salary: z.number({ error: 'Daily wage is required' }).min(0),
})

export type CreateEmployeeInput = z.infer<typeof CreateEmployeeSchema>

export const UpdateEmployeeSchema = CreateEmployeeSchema.partial().omit({
  employeeId: true,
})

export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeSchema>

// ─── Bulk action schemas ──────────────────────────────────────────────────────

export const BulkStatusUpdateSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one employee must be selected'),
  status: z.enum(['RESIGNED', 'INACTIVE']),
  dateOfResignation: z.date().optional(),
}).refine(
  (data) => data.status !== 'RESIGNED' || data.dateOfResignation != null,
  { message: 'Date of Resignation is required', path: ['dateOfResignation'] },
)

export type BulkStatusUpdateInput = z.infer<typeof BulkStatusUpdateSchema>

export const BulkHourlyRateUpdateSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one employee must be selected'),
  newDailyWage: z.number().gt(0, 'Daily wage must be greater than 0'),
  effectiveFrom: z.date().optional(),
})

export type BulkHourlyRateUpdateInput = z.infer<typeof BulkHourlyRateUpdateSchema>

export interface BulkOperationResult {
  succeeded: number
  skipped: number
  failed: number
  errors: { employeeId: string; error: string }[]
}

// ─── List / pagination ────────────────────────────────────────────────────────

export type SortableField = 'employeeId' | 'employeeName' | 'designation' | 'site' | 'status'

export interface EmployeeListOptions {
  page?: number
  limit?: number
  search?: string
  status?: EmployeeStatus | 'ALL'
  sortBy?: SortableField
  sortOrder?: 'asc' | 'desc'
  designation?: string
  site?: string
}

export interface EmployeeListItem {
  id: string
  employeeId: string
  employeeName: string
  designation: string
  designationShort: string | null
  site: string | null
  isActive: boolean
  dateOfResignation: Date | null
  status: EmployeeStatus
}

export interface PaginatedEmployeeList {
  employees: EmployeeListItem[]
  totalCount: number
  page: number
  limit: number
}

// ─── Full employee record (profile) ───────────────────────────────────────────

export interface EmployeeRecord {
  id: string
  employeeId: string
  employeeName: string
  designation: string
  designationShort: string | null
  nationalId: string | null
  aadhaarId: string | null
  policeVerificationId: string | null
  phone: string | null
  dateOfBirth: Date | null
  dateOfJoining: Date | null
  healthCardId: string | null
  gPay: string | null
  bankAccount: string | null
  dateOfResignation: Date | null
  site: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

// ─── Wage history ─────────────────────────────────────────────────────────────

export interface WageHistoryEntry {
  id: string
  employeeId: string
  weeklySalary: number
  hourlyRate: number
  effectiveFrom: Date
  effectiveTo: Date | null
  changeSource: string
}

// ─── Service errors ───────────────────────────────────────────────────────────

export class EmployeeServiceError extends Error {
  constructor(
    public readonly code: 'DUPLICATE_EMPLOYEE_ID' | 'EMPLOYEE_NOT_FOUND' | 'VALIDATION_ERROR',
    message: string,
  ) {
    super(message)
    this.name = 'EmployeeServiceError'
  }
}
