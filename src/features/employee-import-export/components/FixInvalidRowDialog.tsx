'use client'

import { useForm } from 'react-hook-form'
import { SpinnerGap, X } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { applyRowFix } from '@/features/employee-import-export/utils/row-fix.utils'
import type {
  InvalidImportRow,
  ValidImportRow,
  ImportRowErrorCode,
  FixRowFormValues,
} from '@/features/employee-import-export/types/import-export.types'

// ─── Error label map ──────────────────────────────────────────────────────────

const ERROR_LABELS: Record<ImportRowErrorCode, string> = {
  MISSING_EMPLOYEE_ID: 'Missing Employee ID',
  MISSING_EMPLOYEE_NAME: 'Missing Name',
  MISSING_DESIGNATION: 'Missing Designation',
  MISSING_SALARY: 'Missing Daily Wage',
  MISSING_ACTIVE: 'Missing Status',
  INVALID_SALARY: 'Invalid Daily Wage',
  INVALID_ACTIVE_VALUE: 'Invalid Status value',
}

// ─── Which errors require which fields ───────────────────────────────────────

function needsEmployeeId(errors: ImportRowErrorCode[]) {
  return errors.includes('MISSING_EMPLOYEE_ID')
}
function needsEmployeeName(errors: ImportRowErrorCode[]) {
  return errors.includes('MISSING_EMPLOYEE_NAME')
}
function needsDesignation(errors: ImportRowErrorCode[]) {
  return errors.includes('MISSING_DESIGNATION')
}
function needsSalary(errors: ImportRowErrorCode[]) {
  return errors.includes('MISSING_SALARY') || errors.includes('INVALID_SALARY')
}
function needsActive(errors: ImportRowErrorCode[]) {
  return errors.includes('MISSING_ACTIVE') || errors.includes('INVALID_ACTIVE_VALUE')
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface FixInvalidRowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invalidRow: InvalidImportRow
  existingEmployeeIds: Set<string>
  onRowFixed: (fixedRow: ValidImportRow) => void
}

// ─── Input style constants ────────────────────────────────────────────────────

const inputClass =
  'w-full border border-zinc-200 rounded-lg px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 transition-colors'
const labelClass = 'text-sm font-medium text-zinc-700 mb-1.5 block'

// ─── Component ────────────────────────────────────────────────────────────────

export function FixInvalidRowDialog({
  open,
  onOpenChange,
  invalidRow,
  existingEmployeeIds,
  onRowFixed,
}: FixInvalidRowDialogProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FixRowFormValues>()

  const rowErrors = invalidRow.errors
  const partial = invalidRow.partialData

  // Context chips: fields that are present in partialData but NOT in errors
  const contextChips: { label: string; value: string }[] = []

  if (partial.employeeId && !needsEmployeeId(rowErrors)) {
    contextChips.push({ label: 'Emp ID', value: partial.employeeId })
  }
  if (partial.employeeName && !needsEmployeeName(rowErrors)) {
    contextChips.push({ label: 'Name', value: partial.employeeName })
  }
  if (partial.designation && !needsDesignation(rowErrors)) {
    contextChips.push({ label: 'Designation', value: partial.designation })
  }
  if (partial.salary !== undefined && !needsSalary(rowErrors)) {
    contextChips.push({ label: 'Daily Wage', value: `₱${partial.salary.toLocaleString()}` })
  }
  if (partial.isActive !== undefined && !needsActive(rowErrors)) {
    contextChips.push({ label: 'Status', value: partial.isActive ? 'Active' : 'Inactive' })
  }

  function onSubmit(values: FixRowFormValues) {
    const result = applyRowFix(invalidRow, values, existingEmployeeIds)

    if (Array.isArray(result)) {
      // result is ImportRowErrorCode[]
      const resultErrors = result as ImportRowErrorCode[]
      // Map error codes to field-level errors
      if (resultErrors.includes('MISSING_EMPLOYEE_ID')) {
        setError('employeeId', { message: 'Employee ID is required' })
      }
      if (resultErrors.includes('MISSING_EMPLOYEE_NAME')) {
        setError('employeeName', { message: 'Employee Name is required' })
      }
      if (resultErrors.includes('MISSING_DESIGNATION')) {
        setError('designation', { message: 'Designation is required' })
      }
      if (resultErrors.includes('MISSING_SALARY') || resultErrors.includes('INVALID_SALARY')) {
        setError('salary', { message: 'Must be a positive number' })
      }
      if (resultErrors.includes('MISSING_ACTIVE')) {
        setError('isActive', { message: 'Status is required' })
      }
      return
    }

    // result is ValidImportRow
    onRowFixed(result as ValidImportRow)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md w-full shadow-[0_20px_40px_-15px_rgba(0,0,0,0.08)] border border-zinc-200/60"
      >
        {/* Header */}
        <DialogHeader className="mb-0">
          <div className="flex items-start justify-between">
            <DialogTitle>Fix Row {invalidRow.rowNumber}</DialogTitle>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-zinc-400 hover:text-zinc-600 transition-colors -mt-0.5 -mr-1 p-1 rounded-lg hover:bg-zinc-100"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <DialogDescription className="leading-relaxed mb-4">
            Enter the missing information to include this row in the import.
          </DialogDescription>
        </DialogHeader>

        {/* Error badges */}
        <div className="flex flex-wrap gap-1.5 mb-5">
          {rowErrors.map((code) => (
            <span
              key={code}
              className="bg-rose-50 text-rose-700 rounded-full text-xs px-2.5 py-0.5 font-medium"
            >
              {ERROR_LABELS[code] ?? code}
            </span>
          ))}
        </div>

        {/* Context strip */}
        {contextChips.length > 0 && (
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wider text-zinc-400 mb-2">Already present</p>
            <div className="flex flex-wrap gap-1.5">
              {contextChips.map((chip) => (
                <span
                  key={chip.label}
                  className="bg-zinc-100 rounded px-2 py-0.5 text-sm font-mono text-zinc-600"
                >
                  {chip.value}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Editable fields */}
        <form onSubmit={handleSubmit(onSubmit)} id="fix-row-form">
          <div className="space-y-4 mt-4">
            {needsEmployeeId(rowErrors) && (
              <div>
                <label htmlFor="fix-employeeId" className={labelClass}>Employee ID</label>
                <input
                  {...register('employeeId')}
                  id="fix-employeeId"
                  type="text"
                  placeholder="e.g. EMP-001"
                  className={inputClass}
                />
                {errors.employeeId && (
                  <p role="alert" className="text-xs text-rose-600 mt-1">{errors.employeeId.message}</p>
                )}
              </div>
            )}

            {needsEmployeeName(rowErrors) && (
              <div>
                <label htmlFor="fix-employeeName" className={labelClass}>Employee Name</label>
                <input
                  {...register('employeeName')}
                  id="fix-employeeName"
                  type="text"
                  placeholder="Full name"
                  className={inputClass}
                />
                {errors.employeeName && (
                  <p role="alert" className="text-xs text-rose-600 mt-1">{errors.employeeName.message}</p>
                )}
              </div>
            )}

            {needsDesignation(rowErrors) && (
              <div>
                <label htmlFor="fix-designation" className={labelClass}>Designation</label>
                <input
                  {...register('designation')}
                  id="fix-designation"
                  type="text"
                  placeholder="e.g. Security Guard"
                  className={inputClass}
                />
                {errors.designation && (
                  <p role="alert" className="text-xs text-rose-600 mt-1">{errors.designation.message}</p>
                )}
              </div>
            )}

            {needsSalary(rowErrors) && (
              <div>
                <label htmlFor="fix-salary" className={labelClass}>Daily Wage (PHP)</label>
                <input
                  {...register('salary')}
                  id="fix-salary"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className={inputClass}
                />
                <p className="text-xs text-zinc-400 mt-1">Must be a positive number</p>
                {errors.salary && (
                  <p role="alert" className="text-xs text-rose-600 mt-1">{errors.salary.message}</p>
                )}
              </div>
            )}

            {needsActive(rowErrors) && (
              <div>
                <span className={labelClass}>Status</span>
                <div className="flex items-center gap-4 mt-1" role="group" aria-label="Status">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      {...register('isActive')}
                      id="fix-isActive-true"
                      type="radio"
                      value="true"
                      className="accent-emerald-600 w-4 h-4"
                    />
                    <span className="text-sm text-zinc-700">Active</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      {...register('isActive')}
                      id="fix-isActive-false"
                      type="radio"
                      value="false"
                      className="accent-emerald-600 w-4 h-4"
                    />
                    <span className="text-sm text-zinc-700">Inactive</span>
                  </label>
                </div>
                {errors.isActive && (
                  <p role="alert" className="text-xs text-rose-600 mt-1">{errors.isActive.message}</p>
                )}
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <DialogFooter className="flex justify-end gap-3 pt-5 mt-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-zinc-700 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="fix-row-form"
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors active:scale-[0.98]"
          >
            {isSubmitting && <SpinnerGap size={14} className="animate-spin" />}
            Apply Fix
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
