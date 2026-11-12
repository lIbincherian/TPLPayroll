'use client'

import { useMemo, useState } from 'react'
import { CalendarBlank } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { WeekCalendar } from './WeekCalendar'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { getPickerWeekState } from '../lib/week-picker'
import { addDaysISO, formatWeekLabel, getCurrentPayrollWeek, weekFromStartISO } from '../lib/week'
import type { AttendanceWeekListItem, ISODate } from '../types/attendance-sync.types'

// ─── Picker body ──────────────────────────────────────────────────────────────

interface PickerBodyProps {
  weeks: AttendanceWeekListItem[]
  todayISO: ISODate
  onCancel: () => void
  onConfirm: (weekStart: ISODate) => void
}

function PickerBody({ weeks, todayISO, onCancel, onConfirm }: PickerBodyProps) {
  const defaultMonth = useMemo(
    () => addDaysISO(getCurrentPayrollWeek(todayISO).start, -7).slice(0, 7),
    [todayISO],
  )
  const [month, setMonth] = useState(defaultMonth)
  const [selected, setSelected] = useState<ISODate | null>(null)

  const byWeek = useMemo(() => new Map(weeks.map((w) => [w.weekId, w])), [weeks])
  const weekLabel = (start: ISODate) => formatWeekLabel(weekFromStartISO(start))

  return (
    <div data-testid="load-past-week-popover">
      <WeekCalendar
        month={month}
        onMonthChange={setMonth}
        selectedWeekStart={selected}
        onSelectWeek={setSelected}
        getWeekState={(start) => getPickerWeekState(start, byWeek.get(start), todayISO)}
        weekLabel={weekLabel}
        canGoPrevious={month > '2020-01'}
        canGoNext={month < todayISO.slice(0, 7)}
        testIdPrefix="week-picker"
      />

      <p className="mt-3 min-h-5 font-mono text-sm tabular-nums text-zinc-700" data-testid="week-picker-selected">
        {selected ? weekLabel(selected) : <span className="font-sans text-zinc-500">Choose a week</span>}
      </p>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="rounded-xl" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={selected === null}
          onClick={() => selected && onConfirm(selected)}
          data-testid="week-picker-pull"
          className="rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/40 disabled:opacity-100"
        >
          Pull now
        </Button>
      </div>
    </div>
  )
}

// ─── LoadPastWeekPicker ───────────────────────────────────────────────────────

interface LoadPastWeekPickerProps {
  weeks: AttendanceWeekListItem[]
  /** Today in IST. */
  todayISO: ISODate
  disabled?: boolean
  /** Starts the pull flow for the chosen week. */
  onPull: (weekStart: ISODate) => void
}

/** "Load a past week": a week calendar in a popover, or a bottom sheet on a phone. */
export function LoadPastWeekPicker({ weeks, todayISO, disabled, onPull }: LoadPastWeekPickerProps) {
  const [open, setOpen] = useState(false)
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const triggerContent = (
    <>
      <CalendarBlank size={14} />
      Load a past week
    </>
  )
  const triggerClass = 'rounded-xl'

  const body = (
    <PickerBody
      weeks={weeks}
      todayISO={todayISO}
      onCancel={() => setOpen(false)}
      onConfirm={(weekStart) => {
        setOpen(false)
        onPull(weekStart)
      }}
    />
  )

  if (!isDesktop) {
    return (
      <>
        <Button
          variant="outline"
          disabled={disabled}
          className={triggerClass}
          onClick={() => setOpen(true)}
          data-testid="load-past-week-button"
        >
          {triggerContent}
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" overlay>
            <SheetTitle className="mb-4 text-sm font-medium">Load a past week</SheetTitle>
            {open && body}
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" disabled={disabled} className={triggerClass} data-testid="load-past-week-button" />
        }
      >
        {triggerContent}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem]">
        <PopoverTitle className="mb-3">Load a past week</PopoverTitle>
        {body}
      </PopoverContent>
    </Popover>
  )
}
