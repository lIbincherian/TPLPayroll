'use client'

import { useState, useCallback, useEffect } from 'react'
import { CurrencyCircleDollar, SpinnerGap } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { bulkUpdateHourlyRateAction } from '@/features/employee-management/actions/employee.actions'
import { getEmployeeWageHistoryAction } from '@/features/employee-management/actions/employee.actions'
import type { EmployeeListItem } from '@/features/employee-management/types/employee.types'
import { computeHourlyRate } from '@/features/employee-management/utils/wage'

interface BulkRateDialogProps {
  employees: EmployeeListItem[]
  onClose: () => void
  onComplete: () => void
}

interface EmployeeRateInfo {
  id: string
  employeeId: string
  employeeName: string
  currentWage: number | null
}

export function BulkRateDialog({ employees, onClose, onComplete }: BulkRateDialogProps) {
  const today = new Date()
  const [rateValue, setRateValue] = useState('')
  const [dateValue, setDateValue] = useState(today.toISOString().split('T')[0])
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [employeeRates, setEmployeeRates] = useState<EmployeeRateInfo[]>([])

  // Fetch current daily wages on mount
  useEffect(() => {
    async function fetchRates() {
      const rates: EmployeeRateInfo[] = []
      for (const emp of employees) {
        const result = await getEmployeeWageHistoryAction(emp.id)
        if (result.ok && result.data.length > 0) {
          rates.push({
            id: emp.id,
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            currentWage: Number(result.data[0].weeklySalary),
          })
        } else {
          rates.push({
            id: emp.id,
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            currentWage: null,
          })
        }
      }
      setEmployeeRates(rates)
      setIsLoading(false)
    }
    fetchRates()
  }, [employees])

  const parsedWage = parseFloat(rateValue)
  const computedRate = !isNaN(parsedWage) && parsedWage > 0 ? computeHourlyRate(parsedWage) : null

  const handleConfirm = useCallback(async () => {
    const wage = parseFloat(rateValue)
    if (isNaN(wage) || wage <= 0) {
      setError('Enter a daily wage greater than 0')
      return
    }

    setError(null)
    setIsProcessing(true)

    const input: {
      ids: string[]
      newDailyWage: number
      effectiveFrom?: Date
    } = {
      ids: employees.map((e) => e.id),
      newDailyWage: wage,
    }

    if (dateValue) {
      input.effectiveFrom = new Date(dateValue)
    }

    const result = await bulkUpdateHourlyRateAction(input)

    setIsProcessing(false)

    if (result.ok) {
      const { succeeded, skipped, failed } = result.data
      if (failed === 0) {
        let msg = `Daily wage updated for ${succeeded} employee${succeeded !== 1 ? 's' : ''}`
        if (skipped > 0) msg += ` (${skipped} already at ₹${wage})`
        toast.success(msg)
      } else {
        toast.warning(`${succeeded} succeeded, ${failed} failed`)
      }
    } else {
      toast.error(result.error)
    }

    onComplete()
  }, [rateValue, dateValue, employees, onComplete])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-rate-title"
    >
      {/* Backdrop */}
      <div
        className="dialog-backdrop absolute inset-0 bg-zinc-900/40 backdrop-blur-sm"
        onClick={isProcessing ? undefined : onClose}
      />

      {/* Panel — wider for rate column */}
      <div className="dialog-enter relative z-10 w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl border border-zinc-200/60">
        {/* Icon badge */}
        <div className="mb-4 inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-50">
          <CurrencyCircleDollar size={20} weight="fill" className="text-emerald-600" />
        </div>

        {/* Title */}
        <h2 id="bulk-rate-title" className="text-base font-semibold text-zinc-900 mb-2">
          Change daily wage for {employees.length} employee{employees.length !== 1 ? 's' : ''}
        </h2>

        {/* Description */}
        <p className="text-sm text-zinc-500 mb-4">
          Set a new daily wage and effective date. The hourly rate is the daily wage ÷ 8. Employees already at this wage are skipped.
        </p>

        {/* Employee list with current rates */}
        <div className="max-h-[180px] overflow-y-auto rounded-lg bg-zinc-50 border border-zinc-100 p-3 mb-4 scrollbar-thin scrollbar-thumb-zinc-200">
          {isLoading ? (
            <div className="flex items-center gap-2 py-2">
              <SpinnerGap size={14} className="animate-spin text-zinc-400" />
              <span className="text-sm text-zinc-400">Loading current wages...</span>
            </div>
          ) : (
            employeeRates.map((emp) => (
              <div key={emp.id} className="flex items-center justify-between gap-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-400">{emp.employeeId}</span>
                  <span className="text-sm text-zinc-700">{emp.employeeName}</span>
                </div>
                <span className="font-mono text-xs text-zinc-400">
                  ₹{emp.currentWage?.toFixed(2) ?? '—'}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Processing state */}
        {isProcessing ? (
          <div className="mb-4">
            <div className="w-full h-1.5 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className="h-1.5 rounded-full bg-emerald-500 progress-pulse"
                style={{ width: '100%' }}
              />
            </div>
            <p className="text-sm text-zinc-500 text-center mt-2">Processing...</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* New Daily Wage */}
            <div>
              <label htmlFor="bulk-rate-input" className="block text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5">
                New Daily Wage (₹) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={rateValue}
                onChange={(e) => { setRateValue(e.target.value); setError(null) }}
                className="w-full px-3 py-2 text-sm rounded-xl bg-white border border-zinc-200/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 transition-colors duration-200"
                id="bulk-rate-input"
              />
              <p className="text-xs text-zinc-500 mt-1" id="bulk-rate-hourly">
                Hourly rate: <span className="font-mono text-zinc-700" data-testid="bulk-computed-hourly-rate">{computedRate !== null ? `₹${computedRate.toFixed(2)}` : '—'}</span>
              </p>
              {error && (
                <p className="text-rose-600 text-xs mt-1">{error}</p>
              )}
            </div>

            {/* Effective From */}
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5">
                Effective From
              </label>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl bg-white border border-zinc-200/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 transition-colors duration-200"
                id="bulk-rate-date"
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={isProcessing}
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200/60 rounded-xl hover:bg-zinc-50 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isProcessing || isLoading}
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors duration-200 active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed inline-flex items-center gap-2"
            id="bulk-rate-confirm"
          >
            {isProcessing && <SpinnerGap size={14} className="animate-spin" />}
            {isProcessing ? 'Processing...' : 'Update Wages'}
          </button>
        </div>
      </div>
    </div>
  )
}
