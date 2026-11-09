'use client'

import { useState } from 'react'
import { CaretDown, PencilSimple, Warning } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { formatDayShort, formatHoursTotal, formatHours, plural } from '../lib/format'
import { describeDay } from '../lib/review-view'
import type { GridEmployee, ISODate } from '../types/attendance-sync.types'

interface PunchMobileListProps {
  employees: GridEmployee[]
  onOpenDay: (employeeId: string, date: ISODate) => void
}

/**
 * The phone version of the grid: a list of employees, each opening to its seven days. For quick
 * fixes; a full review is meant for a laptop.
 */
export function PunchMobileList({ employees, onOpenDay }: PunchMobileListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <ul className="divide-y divide-zinc-200/60 border-t border-zinc-200/60" data-testid="punch-mobile-list">
      {employees.map((employee) => {
        const needsFixing = employee.days.filter((d) => d.incomplete).length
        const unusual = employee.days.filter((d) => d.isUnusual).length
        const expanded = expandedId === employee.employeeId

        return (
          <li key={employee.employeeId} data-testid={`mobile-employee-${employee.employeeCode}`}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedId(expanded ? null : employee.employeeId)}
              className="flex w-full items-center gap-3 px-1 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-900">{employee.employeeName}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="font-mono text-zinc-500">{employee.employeeCode}</span>
                  {needsFixing > 0 && (
                    <span className="font-medium text-rose-600">{plural(needsFixing, 'day')} Needs fixing</span>
                  )}
                  {needsFixing === 0 && unusual > 0 && <span className="text-amber-700">Unusual</span>}
                </span>
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-zinc-700">
                <span className="block font-medium">{formatHoursTotal(employee.totalRegularHours)}</span>
                <span className="block text-zinc-500">+{formatHoursTotal(employee.totalOvertimeHours)}</span>
              </span>
              <CaretDown size={14} className={cn('shrink-0 text-zinc-500 transition-transform', expanded && 'rotate-180')} />
            </button>

            {expanded && (
              <ul className="mb-2 space-y-1 pl-1">
                {employee.days.map((day) => {
                  const pairs = describeDay(day)
                  return (
                    <li key={day.date}>
                      <button
                        type="button"
                        onClick={() => onOpenDay(employee.employeeId, day.date)}
                        data-testid={`mobile-day-${employee.employeeCode}-${day.date}`}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-500',
                          day.incomplete ? 'bg-rose-50' : day.isUnusual ? 'bg-amber-50/70' : 'hover:bg-zinc-100',
                        )}
                      >
                        <span className="w-20 shrink-0 text-xs text-zinc-600">{formatDayShort(day.date)}</span>
                        <span className="min-w-0 flex-1 font-mono text-xs tabular-nums text-zinc-800">
                          {pairs.length > 0 ? pairs.join(', ') : <span className="text-zinc-400">—</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-zinc-600">
                          {day.isEdited && <PencilSimple size={12} className="text-sky-600" aria-label="Edited" />}
                          {!day.incomplete && day.isUnusual && (
                            <Warning size={12} weight="fill" className="text-amber-600" aria-label="Unusual" />
                          )}
                          {pairs.length > 0 ? formatHours(day.regularHours + day.overtimeHours) : ''}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
