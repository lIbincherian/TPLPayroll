'use client'

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

// A searchable employee picker (by name or Employee ID). Copied from the attendance-upload
// verification dialog and given keyboard support and combobox semantics.

export interface EmployeeOption {
  id: string
  employeeId: string
  employeeName: string
}

interface EmployeeComboboxProps {
  employees: EmployeeOption[]
  selectedId: string | null
  onSelect: (id: string) => void
  disabled?: boolean
  placeholder?: string
  'aria-label': string
  /** Prefix for data-testid: `${testId}` on the input, `${testId}-option-${employeeId}` on options. */
  testId?: string
  className?: string
}

const MAX_RESULTS = 30

export function EmployeeCombobox({
  employees,
  selectedId,
  onSelect,
  disabled,
  placeholder = 'Search employee…',
  'aria-label': ariaLabel,
  testId,
  className,
}: EmployeeComboboxProps) {
  const listId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const selected = employees.find((e) => e.id === selectedId) ?? null

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? employees.filter(
          (e) => e.employeeName.toLowerCase().includes(needle) || e.employeeId.toLowerCase().includes(needle),
        )
      : employees
    return matches.slice(0, MAX_RESULTS)
  }, [employees, query])

  function choose(option: EmployeeOption) {
    onSelect(option.id)
    setQuery('')
    setOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter' && open && results[activeIndex]) {
      event.preventDefault()
      choose(results[activeIndex])
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative min-w-0', className)}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[activeIndex] ? `${listId}-${results[activeIndex].id}` : undefined}
        autoComplete="off"
        data-testid={testId}
        disabled={disabled}
        placeholder={selected ? selected.employeeName : placeholder}
        value={open ? query : (selected?.employeeName ?? '')}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
          if (!open) setOpen(true)
        }}
        onFocus={() => {
          setOpen(true)
          setQuery('')
          setActiveIndex(0)
        }}
        onKeyDown={handleKeyDown}
        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500"
      />

      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 min-w-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-zinc-500">No employees found</li>
          ) : (
            results.map((employee, index) => (
              <li
                key={employee.id}
                id={`${listId}-${employee.id}`}
                role="option"
                aria-selected={employee.id === selectedId}
                data-testid={testId ? `${testId}-option-${employee.employeeId}` : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(employee)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                  index === activeIndex ? 'bg-zinc-100' : 'hover:bg-zinc-50',
                )}
              >
                <span className="truncate font-medium text-zinc-900">{employee.employeeName}</span>
                <span className="shrink-0 font-mono text-xs text-zinc-500">{employee.employeeId}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
