'use client'

import * as React from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '@/lib/utils'

// ── Provider ──────────────────────────────────────────────────────────────────
// Shares the open delay between tooltips, so moving across a grid of cells opens the
// next tooltip straight away instead of waiting again.

function TooltipProvider({
  delay = 250,
  closeDelay = 0,
  children,
}: {
  delay?: number
  closeDelay?: number
  children: React.ReactNode
}) {
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
// One element in, one tooltip out. `children` becomes the trigger. A disabled button does
// not fire hover events, so wrap it in a span (tabIndex 0) and pass the span instead.

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactElement<Record<string, unknown>>
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Renders the children with no tooltip. */
  disabled?: boolean
  className?: string
}

function Tooltip({ content, children, side = 'top', align = 'center', disabled, className }: TooltipProps) {
  if (disabled || content === null || content === undefined || content === '') return children

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} className="z-[60]">
          <TooltipPrimitive.Popup
            className={cn(
              'max-w-72 origin-[var(--transform-origin)] rounded-lg bg-zinc-900 px-2 py-1 text-xs leading-snug text-white shadow-md',
              'transition-[opacity,transform] duration-150 ease-out',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              'motion-reduce:transition-none',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipProvider }
