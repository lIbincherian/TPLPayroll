'use client'

import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, FloppyDisk, Circle } from '@phosphor-icons/react'
import {
  CreateEmployeeSchema,
  UpdateEmployeeSchema,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
  type EmployeeRecord,
} from '@/features/employee-management/types/employee.types'
import {
  createEmployeeAction,
  updateEmployeeAction,
} from '@/features/employee-management/actions/employee.actions'
import { computeHourlyRate } from '@/features/employee-management/utils/wage'
import {
  isWageEffectiveTooFarAhead,
  WAGE_EFFECTIVE_TOO_FAR_AHEAD,
} from '@/features/employee-management/lib/wage-effective-from'

// ─── Types ───────────────────────────────────────────────────────────────────

type Mode = 'create' | 'edit'

/** Where the form came from, so it can pre-fill, show a matching back link, and return there after saving. */
export interface EmployeeReturnContext {
  /** An /attendance or /payroll path to go back to after saving. */
  returnTo: string
  /** Label of the back link, e.g. "Return to employee check". */
  backLabel: string
  /** Pre-fills the Employee Name when creating. */
  prefillName?: string
  /** Shown under the Employee ID when creating, e.g. why the ID must end in certain digits. */
  employeeIdHint?: string
}

interface EmployeeFormProps {
  mode: Mode
  /** Populated when mode = 'edit' */
  employee?: EmployeeRecord
  /** Current daily wage — from wage history, passed in on edit */
  currentSalary?: number
  /** Stored hourly rate — kept while the daily wage is unchanged, so it may differ from daily / 8 */
  currentHourlyRate?: number
  /** Present when the form was opened from another screen (the attendance employee check).
   * Re-routes the back link and the post-save navigation back there. */
  returnContext?: EmployeeReturnContext
}

// ─── Internal form value shape ────────────────────────────────────────────────
// We accept date strings in the form, convert to Date before submit.

type FormValues = {
  employeeId: string
  employeeName: string
  designation: string
  designationShort: string
  nationalId: string
  aadhaarId: string
  policeVerificationId: string
  phone: string
  dateOfBirth: string
  dateOfJoining: string
  site: string
  healthCardId: string
  gPay: string
  bankAccount: string
  dateOfResignation: string
  isActive: boolean
  salary: string
  wageEffectiveFrom: string
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toDateOrUndefined(val: string): Date | undefined {
  if (!val || val.trim() === '') return undefined
  const d = new Date(val)
  return isNaN(d.getTime()) ? undefined : d
}

function toDateOrNull(val: string): Date | null {
  return toDateOrUndefined(val) ?? null
}

function toTrimmedOrNull(val: string): string | null {
  const trimmed = val.trim()
  return trimmed === '' ? null : trimmed
}

// ─── Field wrapper ────────────────────────────────────────────────────────────

function FieldWrapper({
  label,
  required,
  error,
  warning,
  hint,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  warning?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium uppercase tracking-wider text-zinc-400">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      {children}
      {error && (
        <p className="text-xs text-rose-600 mt-0.5">{error}</p>
      )}
      {!error && warning && (
        <p className="text-xs text-amber-700 mt-0.5">{warning}</p>
      )}
      {!error && !warning && hint && (
        <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>
      )}
    </div>
  )
}

// ─── Input classes ────────────────────────────────────────────────────────────

const inputCls =
  'w-full px-3 py-2 text-sm text-zinc-900 rounded-xl bg-white border border-zinc-200/60 ' +
  'focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ' +
  'transition-colors duration-200 placeholder:text-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-500 disabled:cursor-not-allowed'

const errorInputCls =
  'w-full px-3 py-2 text-sm text-zinc-900 rounded-xl bg-white border border-rose-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 ' +
  'transition-colors duration-200 placeholder:text-zinc-400'

// ─── Switch ───────────────────────────────────────────────────────────────────

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-emerald-500/30 ${
        checked ? 'bg-emerald-600' : 'bg-zinc-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EmployeeForm({
  mode,
  employee,
  currentSalary,
  currentHourlyRate,
  returnContext,
}: EmployeeFormProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const isEdit = mode === 'edit'
  const pageTitle = isEdit
    ? `Edit — ${employee?.employeeName ?? 'Employee'}`
    : 'Add Employee'

  const defaultValues: FormValues = {
    employeeId: employee?.employeeId ?? '',
    employeeName: employee?.employeeName ?? returnContext?.prefillName ?? '',
    designation: employee?.designation ?? '',
    designationShort: employee?.designationShort ?? '',
    nationalId: employee?.nationalId ?? '',
    aadhaarId: employee?.aadhaarId ?? '',
    policeVerificationId: employee?.policeVerificationId ?? '',
    phone: employee?.phone ?? '',
    dateOfBirth: employee?.dateOfBirth
      ? new Date(employee.dateOfBirth).toISOString().split('T')[0]
      : '',
    dateOfJoining: employee?.dateOfJoining
      ? new Date(employee.dateOfJoining).toISOString().split('T')[0]
      : '',
    site: employee?.site ?? '',
    healthCardId: employee?.healthCardId ?? '',
    gPay: employee?.gPay ?? '',
    bankAccount: employee?.bankAccount ?? '',
    dateOfResignation: employee?.dateOfResignation
      ? new Date(employee.dateOfResignation).toISOString().split('T')[0]
      : '',
    isActive: employee?.isActive ?? true,
    salary: currentSalary !== undefined ? String(currentSalary) : '',
    wageEffectiveFrom: '',
  }

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues })

  const isActive = watch('isActive')
  const dailyWage = parseFloat(watch('salary'))
  const computedHourlyRate =
    !isNaN(dailyWage) && dailyWage >= 0 ? computeHourlyRate(dailyWage) : null
  // On edit, an unchanged daily wage keeps the stored rate; only a new wage gets daily / 8.
  const keepsStoredRate = currentHourlyRate !== undefined && dailyWage === currentSalary
  const shownHourlyRate = keepsStoredRate ? currentHourlyRate : computedHourlyRate
  let hourlyRateHint = 'Daily wage ÷ 8 hours'
  if (keepsStoredRate) {
    hourlyRateHint = 'Current rate. Recalculated if the daily wage changes'
  } else if (currentHourlyRate !== undefined && computedHourlyRate !== null) {
    hourlyRateHint = `New rate (daily wage ÷ 8), was ₹${currentHourlyRate.toFixed(2)}`
  }
  const wageEffectiveFrom = watch('wageEffectiveFrom')
  const dateOfJoining = watch('dateOfJoining')
  // Non-blocking: both are yyyy-mm-dd strings, so they compare as dates.
  const wageStartsBeforeJoining = !!wageEffectiveFrom && !!dateOfJoining && wageEffectiveFrom < dateOfJoining

  async function onSubmit(data: FormValues) {
    setServerError(null)
    setIsSubmitting(true)
    try {
      const salaryNum = parseFloat(data.salary)

      if (isEdit && employee) {
        const payload: UpdateEmployeeInput = {
          employeeName: data.employeeName || undefined,
          designation: data.designation || undefined,
          designationShort: toTrimmedOrNull(data.designationShort),
          nationalId: toTrimmedOrNull(data.nationalId),
          aadhaarId: toTrimmedOrNull(data.aadhaarId),
          policeVerificationId: toTrimmedOrNull(data.policeVerificationId),
          phone: toTrimmedOrNull(data.phone),
          dateOfBirth: toDateOrNull(data.dateOfBirth),
          dateOfJoining: toDateOrNull(data.dateOfJoining),
          site: toTrimmedOrNull(data.site),
          healthCardId: toTrimmedOrNull(data.healthCardId),
          gPay: toTrimmedOrNull(data.gPay),
          bankAccount: toTrimmedOrNull(data.bankAccount),
          dateOfResignation: toDateOrNull(data.dateOfResignation),
          isActive: data.isActive,
          salary: isNaN(salaryNum) ? undefined : salaryNum,
        }
        // Client-side validate update schema
        const parsed = UpdateEmployeeSchema.safeParse(payload)
        if (!parsed.success) {
          setServerError(parsed.error.issues[0]?.message ?? 'Validation error')
          return
        }
        const result = await updateEmployeeAction(employee.id, payload)
        if (!result.ok) {
          setServerError(result.error)
          return
        }
        router.push(returnContext?.returnTo ?? `/employees/${employee.id}`)
      } else {
        const payload: CreateEmployeeInput = {
          wageEffectiveFrom: toDateOrUndefined(data.wageEffectiveFrom),
          employeeId: data.employeeId,
          employeeName: data.employeeName,
          designation: data.designation,
          designationShort: data.designationShort || undefined,
          nationalId: data.nationalId || undefined,
          aadhaarId: data.aadhaarId || undefined,
          policeVerificationId: data.policeVerificationId || undefined,
          phone: data.phone || undefined,
          dateOfBirth: toDateOrUndefined(data.dateOfBirth),
          dateOfJoining: toDateOrUndefined(data.dateOfJoining),
          site: data.site || undefined,
          healthCardId: data.healthCardId || undefined,
          gPay: data.gPay || undefined,
          bankAccount: data.bankAccount || undefined,
          dateOfResignation: toDateOrUndefined(data.dateOfResignation),
          isActive: data.isActive,
          salary: salaryNum,
        }
        const parsed = CreateEmployeeSchema.safeParse(payload)
        if (!parsed.success) {
          setServerError(parsed.error.issues[0]?.message ?? 'Validation error')
          return
        }
        const result = await createEmployeeAction(payload)
        if (!result.ok) {
          if (result.code === 'DUPLICATE_EMPLOYEE_ID') {
            setServerError(`Employee ID "${data.employeeId}" already exists`)
          } else {
            setServerError(result.error)
          }
          return
        }
        if (returnContext) {
          router.push(returnContext.returnTo)
          return
        }
        router.push(`/employees/${result.data.id}`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-0">
      {/* ── Back link ───────────────────────────────────────────────────────── */}
      {returnContext ? (
        <button
          type="button"
          onClick={() => router.push(returnContext.returnTo)}
          className="inline-flex items-center gap-1.5 text-sm text-emerald-600 hover:text-emerald-800 transition-colors duration-200 mb-6"
        >
          <ArrowLeft size={16} />
          {returnContext.backLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => router.push('/employees')}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors duration-200 mb-6"
        >
          <ArrowLeft size={16} />
          Back to directory
        </button>
      )}

      {/* ── Page title ──────────────────────────────────────────────────────── */}
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900 mb-8">
        {pageTitle}
      </h1>

      {/* ── Server error banner ─────────────────────────────────────────────── */}
      {serverError && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <Circle weight="fill" size={8} className="mt-1.5 shrink-0 text-rose-500" />
          <p className="text-sm text-rose-700">{serverError}</p>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-0" noValidate>

        {/* ── Section: Personal Details ────────────────────────────────────── */}
        <div className="border-t border-zinc-200/60 pt-8 pb-10">
          <p className="text-sm font-medium text-zinc-900 mb-6">Personal Details</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">

            <FieldWrapper label="Employee ID" required error={errors.employeeId?.message}>
              <input
                {...register('employeeId', { required: 'Employee ID is required' })}
                disabled={isEdit}
                placeholder="EMP-042"
                className={errors.employeeId ? errorInputCls : inputCls}
              />
              {returnContext?.employeeIdHint && !isEdit && (
                <p className="text-xs text-zinc-500 mt-0.5" data-testid="employee-id-hint">
                  {returnContext.employeeIdHint}
                </p>
              )}
            </FieldWrapper>

            <FieldWrapper label="Employee Name" required error={errors.employeeName?.message}>
              <input
                {...register('employeeName', { required: 'Employee Name is required' })}
                placeholder="Lakshmi Venkatesh"
                className={errors.employeeName ? errorInputCls : inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Designation" required error={errors.designation?.message}>
              <input
                {...register('designation', { required: 'Designation is required' })}
                placeholder="Guard"
                className={errors.designation ? errorInputCls : inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Designation Short" error={errors.designationShort?.message}>
              <input
                {...register('designationShort')}
                placeholder="GRD"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="National ID" error={errors.nationalId?.message}>
              <input
                {...register('nationalId')}
                placeholder="XXXXX-1234567-X"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Aadhaar ID" error={errors.aadhaarId?.message}>
              <input
                {...register('aadhaarId')}
                placeholder="XXXX XXXX XXXX"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Date of Birth" error={errors.dateOfBirth?.message}>
              <input
                {...register('dateOfBirth')}
                type="date"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Phone" error={errors.phone?.message}>
              <input
                {...register('phone')}
                placeholder="+91 98765 43210"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Date of Joining" error={errors.dateOfJoining?.message}>
              <input
                {...register('dateOfJoining')}
                type="date"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Site" error={errors.site?.message}>
              <input
                {...register('site')}
                placeholder="North Gate"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Police Verification ID" error={errors.policeVerificationId?.message}>
              <input
                {...register('policeVerificationId')}
                placeholder="PV-XXXXXXXX"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Health Card ID" error={errors.healthCardId?.message}>
              <input
                {...register('healthCardId')}
                placeholder="HC-XXXXXXXX"
                className={inputCls}
              />
            </FieldWrapper>

          </div>
        </div>

        {/* ── Section: Compensation ────────────────────────────────────────── */}
        <div className="border-t border-zinc-200/60 pt-8 pb-10">
          <p className="text-sm font-medium text-zinc-900 mb-6">Compensation</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">

            <FieldWrapper label="Daily Wage (₹)" required error={errors.salary?.message}>
              <input
                {...register('salary', { required: 'Daily wage is required' })}
                aria-label="Daily Wage (₹)"
                type="number"
                step="0.01"
                min="0"
                placeholder="800"
                className={`${errors.salary ? errorInputCls : inputCls} font-mono tabular-nums`}
              />
            </FieldWrapper>

            <div className="flex flex-col gap-1.5">
              <span id="hourly-rate-label" className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Hourly Rate (₹)
              </span>
              <output
                data-testid="computed-hourly-rate"
                aria-labelledby="hourly-rate-label"
                aria-describedby="hourly-rate-hint"
                className="py-2 text-sm text-zinc-900 font-mono tabular-nums"
              >
                {shownHourlyRate !== null ? `₹${shownHourlyRate.toFixed(2)}` : '—'}
              </output>
              <p id="hourly-rate-hint" data-testid="hourly-rate-hint" className="text-xs text-zinc-500">{hourlyRateHint}</p>
            </div>

            {!isEdit && (
              <FieldWrapper
                label="Wage effective from"
                error={errors.wageEffectiveFrom?.message}
                warning={wageStartsBeforeJoining ? 'Earlier than the date of joining' : undefined}
                hint="Leave blank to use the date of joining, or the 1st of this month."
              >
                <input
                  {...register('wageEffectiveFrom', {
                    validate: (val) => {
                      const date = toDateOrUndefined(val)
                      return date && isWageEffectiveTooFarAhead(date) ? WAGE_EFFECTIVE_TOO_FAR_AHEAD : true
                    },
                  })}
                  type="date"
                  aria-label="Wage effective from"
                  className={errors.wageEffectiveFrom ? errorInputCls : inputCls}
                />
              </FieldWrapper>
            )}

          </div>
        </div>

        {/* ── Section: Payment Details ─────────────────────────────────────── */}
        <div className="border-t border-zinc-200/60 pt-8 pb-10">
          <p className="text-sm font-medium text-zinc-900 mb-6">Payment Details</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">

            <FieldWrapper label="GPay Number" error={errors.gPay?.message}>
              <input
                {...register('gPay')}
                placeholder="+91 98765 43210"
                className={inputCls}
              />
            </FieldWrapper>

            <FieldWrapper label="Bank Account" error={errors.bankAccount?.message}>
              <input
                {...register('bankAccount')}
                placeholder="HDFC xxxxxx1234"
                className={inputCls}
              />
            </FieldWrapper>

          </div>
        </div>

        {/* ── Section: Status ──────────────────────────────────────────────── */}
        <div className="border-t border-zinc-200/60 pt-8 pb-10">
          <p className="text-sm font-medium text-zinc-900 mb-6">Status</p>
          <div className="flex flex-wrap items-start gap-x-12 gap-y-6">

            {/* Active toggle */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Active<span className="ml-0.5 text-rose-500">*</span>
              </span>
              <div className="flex items-center gap-3 pt-1">
                <Controller
                  control={control}
                  name="isActive"
                  render={({ field }) => (
                    <Switch checked={field.value} onChange={field.onChange} />
                  )}
                />
                <span className="text-sm text-zinc-600">
                  {isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>

            {/* Date of Resignation */}
            <FieldWrapper label="Date of Resignation" error={errors.dateOfResignation?.message}>
              <input
                {...register('dateOfResignation')}
                type="date"
                className={inputCls}
                style={{ width: '200px' }}
              />
              <p className="text-xs text-zinc-400 mt-0.5">
                Independent of active status
              </p>
            </FieldWrapper>

          </div>
        </div>

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <div className="border-t border-zinc-200/60 pt-8 flex justify-end items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200/60 rounded-xl hover:bg-zinc-50 transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          >
            Cancel
          </button>

          <button
            type="submit"
            disabled={isSubmitting}
            className="relative inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-70 rounded-xl transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] overflow-hidden"
          >
            {isSubmitting ? (
              <>
                {/* Shimmer loading bar inside button */}
                <span
                  className="absolute inset-0 skeleton-shimmer opacity-30 pointer-events-none"
                  aria-hidden
                />
                <span className="opacity-60">Saving…</span>
              </>
            ) : (
              <>
                <FloppyDisk size={16} weight="bold" />
                {isEdit ? 'Save Changes' : 'Save Employee'}
              </>
            )}
          </button>
        </div>

      </form>
    </div>
  )
}
