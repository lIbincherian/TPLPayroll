'use client'

import { useState, type KeyboardEvent, type MutableRefObject } from 'react'
import { ArrowsMerge, PencilSimple, Plus, Warning } from '@phosphor-icons/react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatDayHeader, formatHours, formatHoursTotal } from '../lib/format'
import { dayAriaLabel, getCellPairs, isIncompletePair, pairText, describeDay, type GridFilter } from '../lib/review-view'
import type { DayView, GridEmployee, ISODate, PairView, PunchReview } from '../types/attendance-sync.types'

export const cellKey = (employeeId: string, date: ISODate): string => `${employeeId}|${date}`

const HEADER = 'text-xs font-medium uppercase tracking-wider text-zinc-500 font-sans'

// ─── One pair, one line ───────────────────────────────────────────────────────

function PairLine({ pair }: { pair: PairView }) {
  if (!isIncompletePair(pair)) return <span className="block truncate text-zinc-800">{pairText(pair)}</span>

  return (
    <span className="block truncate text-zinc-800">
      {pair.in?.time ?? <span className="text-rose-600">--:--</span>}–
      {pair.out?.time ?? <span className="text-rose-600">--:--</span>}
    </span>
  )
}

// ─── A day cell ───────────────────────────────────────────────────────────────

function cellTooltip(day: DayView): string[] {
  const lines: string[] = []
  if (day.incomplete) lines.push('Needs fixing: a punch has no pair')
  if (day.isUnusual && day.unusualReason) lines.push(day.unusualReason)
  if (getCellPairs(day).hiddenCount > 0) lines.push(...describeDay(day))
  if (day.isMerged) lines.push('Merged scans')
  if (day.isEdited) lines.push('Edited')
  return lines
}

interface DayCellProps {
  employee: GridEmployee
  day: DayView
  dimmed: boolean
  isOpen: boolean
  tabbable: boolean
  setRef: (element: HTMLButtonElement | null) => void
  onOpen: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onFocus: () => void
}

function DayCell({ employee, day, dimmed, isOpen, tabbable, setRef, onOpen, onKeyDown, onFocus }: DayCellProps) {
  const { pairs, hiddenCount } = getCellPairs(day)
  const hasPunches = pairs.length > 0
  const overtime = day.overtimeHours > 0
  const tooltip = cellTooltip(day)

  const button = (
    <button
      ref={setRef}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={dayAriaLabel(employee, day)}
      data-testid={`day-cell-${employee.employeeCode}-${day.date}`}
      data-needs-fixing={day.incomplete || undefined}
      data-unusual={day.isUnusual || undefined}
      data-edited={day.isEdited || undefined}
      data-merged={day.isMerged || undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cn(
        'group block h-[47px] w-full overflow-hidden px-2 py-[3px] text-left outline-none transition-colors',
        'hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500',
        day.incomplete && 'bg-rose-50 ring-1 ring-inset ring-rose-200 hover:bg-rose-100/70',
        !day.incomplete && day.isUnusual && 'bg-amber-50/70 hover:bg-amber-100/60',
        isOpen && 'ring-2 ring-inset ring-emerald-500',
      )}
    >
      {hasPunches ? (
        <>
          {pairs.map((pair) => (
            <PairLine key={pair.pairIndex} pair={pair} />
          ))}
          {pairs.length === 1 && <span className="block h-[14px]" />}
          <span className="flex items-center justify-between gap-1 text-zinc-500">
            <span className="truncate">
              {formatHours(day.regularHours)}
              {overtime && <span className="ml-1 font-medium text-zinc-900">+{formatHours(day.overtimeHours)}</span>}
              {hiddenCount > 0 && (
                <span className="ml-1 rounded bg-zinc-200/70 px-1 text-[10px] text-zinc-600">+{hiddenCount}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {!day.incomplete && day.isUnusual && (
                <Warning size={12} weight="fill" className="text-amber-600" aria-label="Unusual" />
              )}
              {day.isMerged && <ArrowsMerge size={12} className="text-zinc-500" aria-label="Merged" />}
              {day.isEdited && <PencilSimple size={12} className="text-sky-600" aria-label="Edited" />}
            </span>
          </span>
        </>
      ) : (
        <span className="flex h-full items-center text-zinc-400" aria-hidden>
          <span className="group-hover:hidden group-focus-visible:hidden">—</span>
          <Plus size={12} className="hidden group-hover:block group-focus-visible:block" />
        </span>
      )}
    </button>
  )

  return (
    <td role="gridcell" className={cn('h-12 border-b border-zinc-200/60 p-0 align-top', dimmed && 'opacity-40')}>
      {tooltip.length > 0 ? (
        <Tooltip
          content={
            <span className="block space-y-0.5 font-mono">
              {tooltip.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
          }
        >
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </td>
  )
}

// ─── PunchGridTable ───────────────────────────────────────────────────────────

interface PunchGridTableProps {
  review: PunchReview
  employees: GridEmployee[]
  filter: GridFilter
  /** The day open in the editor, if any. */
  openCell: { employeeId: ISODate | string; date: ISODate } | null
  cellRefs: MutableRefObject<Map<string, HTMLButtonElement>>
  onOpenDay: (employeeId: string, date: ISODate) => void
}

/** The week at a glance: one row per employee, one column per day, totals pinned on every edge. */
export function PunchGridTable({ review, employees, filter, openCell, cellRefs, onOpenDay }: PunchGridTableProps) {
  const { dates } = review
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const firstKey = employees[0] ? cellKey(employees[0].employeeId, dates[0]) : null
  const tabbableKey = focusKey && cellRefs.current.has(focusKey) ? focusKey : firstKey

  function moveFocus(rowIndex: number, colIndex: number, event: KeyboardEvent<HTMLButtonElement>) {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    let nextRow = rowIndex
    let nextCol = colIndex
    if (event.key in deltas) {
      nextRow += deltas[event.key][0]
      nextCol += deltas[event.key][1]
    } else if (event.key === 'Home') {
      nextCol = 0
    } else if (event.key === 'End') {
      nextCol = dates.length - 1
    } else {
      return
    }
    const employee = employees[nextRow]
    const date = dates[nextCol]
    if (!employee || !date) return
    event.preventDefault()
    const target = cellRefs.current.get(cellKey(employee.employeeId, date))
    target?.focus()
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return (
    <table
      role="grid"
      aria-label="Punch review"
      aria-rowcount={employees.length + 2}
      aria-colcount={dates.length + 2}
      data-testid="punch-grid"
      className="w-full min-w-[1012px] table-fixed border-separate border-spacing-0 font-mono text-[11px] leading-[14px] tabular-nums"
    >
      <colgroup>
        <col style={{ width: 168 }} />
        {dates.map((date) => (
          <col key={date} />
        ))}
        <col style={{ width: 88 }} />
      </colgroup>

      <thead>
        <tr role="row" className="h-8">
          <th
            scope="col"
            className={cn(HEADER, 'sticky left-0 top-0 z-30 border-b border-zinc-200 bg-zinc-50 px-3 text-left')}
          >
            Employee
          </th>
          {dates.map((date) => {
            const { weekday, day } = formatDayHeader(date)
            return (
              <th
                key={date}
                scope="col"
                data-testid={`day-header-${date}`}
                className={cn(HEADER, 'sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50 px-2 text-left')}
              >
                {weekday} {day}
              </th>
            )
          })}
          <th
            scope="col"
            className={cn(
              HEADER,
              'sticky right-0 top-0 z-30 border-b border-l border-zinc-200 bg-zinc-50 px-2 text-right',
            )}
          >
            Week
            <span className="block text-[10px] normal-case tracking-normal text-zinc-500">Reg / OT</span>
          </th>
        </tr>
      </thead>

      <tbody>
        {employees.map((employee, rowIndex) => (
          <tr key={employee.employeeId} role="row" data-testid={`employee-row-${employee.employeeCode}`}>
            <th
              scope="row"
              className="sticky left-0 z-10 h-12 border-b border-r border-zinc-200/60 bg-zinc-50 px-3 text-left align-middle font-sans"
            >
              <span className="block truncate text-xs font-medium text-zinc-900" title={employee.employeeName}>
                {employee.employeeName}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-zinc-500">{employee.employeeCode}</span>
                {employee.tag !== 'ACTIVE' && (
                  <span
                    className="rounded-full bg-zinc-200/70 px-1.5 text-[10px] font-medium text-zinc-600"
                    data-testid={`employee-tag-${employee.employeeCode}`}
                  >
                    {employee.tag === 'INACTIVE_APPROVED' ? 'Inactive' : 'Resigned'}
                  </span>
                )}
              </span>
            </th>

            {employee.days.map((day, colIndex) => {
              const key = cellKey(employee.employeeId, day.date)
              const dimmed =
                (filter === 'needs' && !day.incomplete) || (filter === 'unusual' && !day.isUnusual)
              return (
                <DayCell
                  key={day.date}
                  employee={employee}
                  day={day}
                  dimmed={dimmed}
                  isOpen={openCell?.employeeId === employee.employeeId && openCell.date === day.date}
                  tabbable={key === tabbableKey}
                  setRef={(element) => {
                    if (element) cellRefs.current.set(key, element)
                    else cellRefs.current.delete(key)
                  }}
                  onOpen={() => onOpenDay(employee.employeeId, day.date)}
                  onKeyDown={(event) => moveFocus(rowIndex, colIndex, event)}
                  onFocus={() => setFocusKey(key)}
                />
              )
            })}

            <td
              role="gridcell"
              data-testid={`week-total-${employee.employeeCode}`}
              className="sticky right-0 z-10 h-12 border-b border-l border-zinc-200/60 bg-zinc-50 px-2 text-right align-middle font-medium text-zinc-700"
            >
              <span className="block">{formatHoursTotal(employee.totalRegularHours)}</span>
              <span className="block text-zinc-500">+{formatHoursTotal(employee.totalOvertimeHours)}</span>
            </td>
          </tr>
        ))}
      </tbody>

      <tfoot>
        <tr role="row" className="h-10" data-testid="grid-totals">
          <th
            scope="row"
            className={cn(
              HEADER,
              'sticky bottom-0 left-0 z-30 border-t border-zinc-200 bg-zinc-50 px-3 text-left normal-case tracking-normal',
            )}
          >
            All employees
          </th>
          {review.totals.byDay.map((total) => (
            <td
              key={total.date}
              data-testid={`day-total-${total.date}`}
              className="sticky bottom-0 z-20 border-t border-zinc-200 bg-zinc-50 px-2 font-medium text-zinc-700"
            >
              <span className="block">{formatHoursTotal(total.regular)}</span>
              <span className="block text-zinc-500">+{formatHoursTotal(total.overtime)}</span>
            </td>
          ))}
          <td
            data-testid="grand-total"
            className="sticky bottom-0 right-0 z-30 border-l border-t border-zinc-200 bg-zinc-50 px-2 text-right font-medium text-zinc-900"
          >
            <span className="block">{formatHoursTotal(review.totals.regular)}</span>
            <span className="block text-zinc-500">+{formatHoursTotal(review.totals.overtime)}</span>
          </td>
        </tr>
      </tfoot>
    </table>
  )
}
