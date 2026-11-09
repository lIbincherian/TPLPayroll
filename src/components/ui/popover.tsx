'use client'

import * as React from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'

// ── Root ──────────────────────────────────────────────────────────────────────

interface PopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

function Popover({ open, onOpenChange, children }: PopoverProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next: boolean) => onOpenChange?.(next)}>
      {children}
    </PopoverPrimitive.Root>
  )
}

// ── Trigger ───────────────────────────────────────────────────────────────────
// Pass `render={<Button … />}` to style the trigger as a button.

const PopoverTrigger = PopoverPrimitive.Trigger

// ── Content ───────────────────────────────────────────────────────────────────

interface PopoverContentProps extends Omit<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup>, 'children'> {
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  children: React.ReactNode
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, side = 'bottom', align = 'end', sideOffset = 8, children, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <PopoverPrimitive.Popup
          ref={ref}
          className={cn(
            'origin-[var(--transform-origin)] rounded-2xl border border-zinc-200/60 bg-white p-4 shadow-xl outline-none',
            'transition-[opacity,transform] duration-150 ease-out',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            'motion-reduce:transition-none',
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  ),
)
PopoverContent.displayName = 'PopoverContent'

// ── Title and close ───────────────────────────────────────────────────────────

const PopoverTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Title>
>(({ className, ...props }, ref) => (
  <PopoverPrimitive.Title ref={ref} className={cn('text-sm font-medium text-zinc-900', className)} {...props} />
))
PopoverTitle.displayName = 'PopoverTitle'

const PopoverClose = PopoverPrimitive.Close

export { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverClose }
