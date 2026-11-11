import { z } from 'zod'

// ─── Enums ─────────────────────────────────────────────────────────────────

export type AdjustmentType = 'DEDUCTION' | 'ADDITION'
export type RecurrenceType = 'ONE_TIME' | 'RECURRING'
export type RecurrenceEndType = 'END_WEEK' | 'FIXED_WEEKS' | 'TOTAL_BALANCE'
export type AdjustmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'SKIPPED'

// ─── Zod schema ─────────────────────────────────────────────────────────────

export const CreateAdjustmentSchema = z.object({
  employeeId: z.string().min(1, 'Employee is required'),
  adjustmentType: z.enum(['DEDUCTION', 'ADDITION']),
  amount: z.number({ error: 'Amount is required' }).positive('Amount must be positive'),
  reason: z.string().min(1, 'Reason is required'),
  recurrenceType: z.enum(['ONE_TIME', 'RECURRING']),
  startPayrollWeekStartDate: z.date(),
  startPayrollWeekEndDate: z.date(),
  recurrenceEndType: z.enum(['END_WEEK', 'FIXED_WEEKS', 'TOTAL_BALANCE']).optional().nullable(),
  endPayrollWeekStartDate: z.date().optional().nullable(),
  endPayrollWeekEndDate: z.date().optional().nullable(),
  totalRecurrenceWeeks: z.number().int().positive().optional().nullable(),
  totalBalance: z.number().positive().optional().nullable(),
})

export type CreateAdjustmentInput = z.infer<typeof CreateAdjustmentSchema>

// ─── Update schema (same shape minus employeeId) ─────────────────────────────

export const UpdateAdjustmentSchema = z.object({
  adjustmentType: z.enum(['DEDUCTION', 'ADDITION']),
  amount: z.number({ error: 'Amount is required' }).positive('Amount must be positive'),
  reason: z.string().min(1, 'Reason is required'),
  recurrenceType: z.enum(['ONE_TIME', 'RECURRING']),
  startPayrollWeekStartDate: z.date(),
  startPayrollWeekEndDate: z.date(),
  recurrenceEndType: z.enum(['END_WEEK', 'FIXED_WEEKS', 'TOTAL_BALANCE']).optional().nullable(),
  endPayrollWeekStartDate: z.date().optional().nullable(),
  endPayrollWeekEndDate: z.date().optional().nullable(),
  totalRecurrenceWeeks: z.number().int().positive().optional().nullable(),
  totalBalance: z.number().positive().optional().nullable(),
})

export type UpdateAdjustmentInput = z.infer<typeof UpdateAdjustmentSchema>

// ─── List / pagination ────────────────────────────────────────────────────────

export interface AdjustmentListOptions {
  page?: number
  limit?: number
  search?: string
  status?: AdjustmentStatus | 'ALL'
  type?: AdjustmentType | 'ALL'
}

export interface AdjustmentListItem {
  id: string
  employeeId: string
  employeeName: string
  employeeCode: string
  adjustmentType: AdjustmentType
  recurrenceType: RecurrenceType
  amount: number
  reason: string
  status: AdjustmentStatus
  skippedCarryForwardCount: number
  startPayrollWeekStartDate: Date
  startPayrollWeekEndDate: Date
  createdAt: Date
}

export interface PaginatedAdjustmentList {
  adjustments: AdjustmentListItem[]
  totalCount: number
  page: number
  limit: number
}

// ─── Application record ───────────────────────────────────────────────────────

export interface AdjustmentApplicationRecord {
  id: string
  payrollAdjustmentId: string
  employeeId: string
  payrollWeekStartDate: Date
  payrollWeekEndDate: Date
  appliedAmount: number
  approvalStatus: ApprovalStatus
  approvedAt: Date | null
  appliedAt: Date | null
  skippedAt: Date | null
  carriedForwardToPayrollWeekStartDate: Date | null
  isReversed: boolean
}

// ─── Detail record ────────────────────────────────────────────────────────────

export interface AdjustmentDetailRecord {
  id: string
  employeeId: string
  employeeName: string
  employeeCode: string
  adjustmentType: AdjustmentType
  recurrenceType: RecurrenceType
  amount: number
  reason: string
  status: AdjustmentStatus
  startPayrollWeekStartDate: Date
  startPayrollWeekEndDate: Date
  endPayrollWeekStartDate: Date | null
  endPayrollWeekEndDate: Date | null
  totalRecurrenceWeeks: number | null
  totalBalance: number | null
  remainingBalance: number | null
  recurrenceEndType: RecurrenceEndType | null
  skippedCarryForwardCount: number
  createdAt: Date
  applications: AdjustmentApplicationRecord[]
}

// ─── Weekly review ────────────────────────────────────────────────────────────

export interface WeeklyReviewItem {
  applicationId: string
  adjustmentId: string
  employeeId: string
  employeeName: string
  employeeCode: string
  adjustmentType: AdjustmentType
  amount: number
  appliedAmount: number
  reason: string
  recurrenceType: RecurrenceType
  approvalStatus: ApprovalStatus
  payrollWeekStartDate: Date
  payrollWeekEndDate: Date
}

// ─── Service errors ───────────────────────────────────────────────────────────

export class AdjustmentServiceError extends Error {
  constructor(
    public readonly code:
      | 'VALIDATION_ERROR'
      | 'EMPLOYEE_NOT_FOUND'
      | 'ADJUSTMENT_NOT_FOUND'
      | 'APPLICATION_NOT_FOUND'
      | 'INVALID_APPROVAL_STATUS'
      | 'EDIT_NOT_ALLOWED'
      | 'CANCEL_NOT_ALLOWED'
      | 'CORRECTION_IN_PROGRESS'
      | 'ADJUSTMENT_NOT_APPLICABLE',
    message: string,
  ) {
    super(message)
    this.name = 'AdjustmentServiceError'
  }
}
