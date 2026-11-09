'use client'

import * as React from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'

// A month calendar whose rows are Thursday–Wednesday weeks. Clicking any day selects its
// whole row. Dates are 'YYYY-MM-DD' strings and all arithmetic is UTC, so the result never
// depends on the viewer's time zone.

const WEEK_START_DOW = 4 // Thursday
const DAY_HEADERS = ['Th', 'Fr', 'Sa', 'Su', 'Mo', 'Tu', 'We']

export interface WeekCalendarWeekState {
  disabled: boolean
  /** Why the week can't be chosen. Shown as a tooltip. */
  reason?: string
  /** Short note at the end of the row, e.g. "Has data". */
  hint?: string
}

interface WeekCalendarProps {
  /** The month shown, 'YYYY-MM'. */
  month: string
  onMonthChange: (month: string) => void
  /** Thursday of the selected week. */
  selectedWeekStart: string | null
  onSelectWeek: (weekStart: string) => void
  getWeekState: (weekStart: string) => WeekCalendarWeekState
  weekLabel: (weekStart: string) => string
  canGoPrevious?: boolean
  canGoNext?: boolean
  testIdPrefix?: string
}

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function addDays(iso: string, days: number): string {
  const date = toUtc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthIndex - 1 + delta, 1))
  return date.toISOString().slice(0, 7)
}

/** The Thursday-start rows that cover the month, each as seven ISO dates. */
function buildWeeks(month: string): string[][] {
  const first = `${month}-01`
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const offset = (toUtc(first).getUTCDay() - WEEK_START_DOW + 7) % 7

  const weeks: string[][] = []
  for (let start = addDays(first, -offset); start <= lastDay; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)))
  }
  return weeks
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function WeekCalendar({
  month,
  onMonthChange,
  selectedWeekStart,
  onSelectWeek,
  getWeekState,
  weekLabel,
  canGoPrevious = true,
  canGoNext = true,
  testIdPrefix = 'week-calendar',
}: WeekCalendarProps) {
  const weeks = React.useMemo(() => buildWeeks(month), [month])

  return (
    <div data-testid={testIdPrefix}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          disabled={!canGoPrevious}
          aria-label="Previous month"
          className="flex size-7 items-center justify-center rounded-lg text-zinc-500 outline-none transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:pointer-events-none disabled:opacity-30"
        >
          <CaretLeft size={14} />
        </button>
        <p className="text-sm font-medium text-zinc-900" aria-live="polite" data-testid={`${testIdPrefix}-month`}>
          {MONTH_FORMAT.format(toUtc(`${month}-01`))}
        </p>
        <button
          type="button"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          disabled={!canGoNext}
          aria-label="Next month"
          className="flex size-7 items-center justify-center rounded-lg text-zinc-500 outline-none transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:pointer-events-none disabled:opacity-30"
        >
          <CaretRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-[repeat(7,2rem)_1fr] px-1 pb-1" aria-hidden>
        {DAY_HEADERS.map((label) => (
          <span key={label} className="text-center text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            {label}
          </span>
        ))}
        <span />
      </div>

      <div role="listbox" aria-label="Weeks" className="flex flex-col gap-0.5">
        {weeks.map((days) => {
          const weekStart = days[0]
          const state = getWeekState(weekStart)
          const selected = weekStart === selectedWeekStart
          const row = (
            <div
              role="option"
              aria-selected={selected}
              aria-disabled={state.disabled}
              aria-label={`${weekLabel(weekStart)}${state.disabled && state.reason ? `. ${state.reason}` : ''}`}
              tabIndex={state.disabled ? -1 : 0}
              data-testid={`${testIdPrefix}-row-${weekStart}`}
              data-disabled={state.disabled ? 'true' : undefined}
              data-selected={selected ? 'true' : undefined}
              onClick={() => {
                if (!state.disabled) onSelectWeek(weekStart)
              }}
              onKeyDown={(event) => {
                if (state.disabled) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectWeek(weekStart)
                }
              }}
              className={cn(
                'grid w-full grid-cols-[repeat(7,2rem)_1fr] items-center rounded-lg px-1 py-0.5 text-sm outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-emerald-500/50',
                state.disabled
                  ? 'cursor-not-allowed text-zinc-300'
                  : selected
                    ? 'cursor-pointer bg-emerald-50 text-emerald-700'
                    : 'cursor-pointer text-zinc-700 hover:bg-zinc-100',
              )}
            >
              {days.map((iso) => (
                <span
                  key={iso}
                  className={cn(
                    'py-1 text-center font-mono text-xs tabular-nums',
                    iso.slice(0, 7) !== month && !selected && 'opacity-40',
                  )}
                >
                  {Number(iso.slice(8, 10))}
                </span>
              ))}
              <span className="truncate pl-2 text-[11px] text-zinc-400">{state.hint}</span>
            </div>
          )

          return (
            <Tooltip key={weekStart} content={state.disabled ? state.reason : undefined} side="right">
              {row}
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

export { WeekCalendar }
