'use client'

import * as React from 'react'
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cn } from '@/lib/utils'

// ── Single-select group ───────────────────────────────────────────────────────
// A row of pills where exactly one is always pressed. Pressing the active pill again keeps
// it selected instead of clearing the group.

interface ToggleGroupProps<Value extends string> {
  value: Value
  onValueChange: (value: Value) => void
  'aria-label': string
  className?: string
  children: React.ReactNode
}

function ToggleGroup<Value extends string>({
  value,
  onValueChange,
  className,
  children,
  ...props
}: ToggleGroupProps<Value>) {
  return (
    <ToggleGroupPrimitive<Value>
      value={[value]}
      onValueChange={(next) => {
        if (next.length > 0) onValueChange(next[0])
      }}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive>
  )
}

// ── Item ──────────────────────────────────────────────────────────────────────

const ToggleGroupItem = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive>
>(({ className, ...props }, ref) => (
  <TogglePrimitive
    ref={ref}
    className={cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs text-zinc-600 outline-none',
      'transition-colors duration-150 hover:bg-zinc-200/60 focus-visible:ring-2 focus-visible:ring-emerald-500/50',
      'data-[pressed]:bg-zinc-900 data-[pressed]:text-white data-[pressed]:hover:bg-zinc-900',
      className,
    )}
    {...props}
  />
))
ToggleGroupItem.displayName = 'ToggleGroupItem'

export { ToggleGroup, ToggleGroupItem }
