'use client'

import * as React from 'react'
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog'
import { cn } from '@/lib/utils'

// ── Root ──────────────────────────────────────────────────────────────────────
// A side or bottom panel built on the Dialog primitive.
//   modal={true}  traps focus and shows an overlay (mobile, full-screen use)
//   modal={false} leaves the page behind it usable, so a grid can update live next to it

interface SheetProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** @default true */
  modal?: boolean
  /** Stop a click outside the panel from closing it. @default false */
  disablePointerDismissal?: boolean
  children: React.ReactNode
}

function Sheet({ open, onOpenChange, modal = true, disablePointerDismissal, children }: SheetProps) {
  return (
    <SheetPrimitive.Root
      open={open}
      modal={modal}
      disablePointerDismissal={disablePointerDismissal}
      onOpenChange={(next: boolean) => onOpenChange?.(next)}
    >
      {children}
    </SheetPrimitive.Root>
  )
}

// ── Content ───────────────────────────────────────────────────────────────────

type SheetSide = 'right' | 'bottom'

const SIDE_CLASSES: Record<SheetSide, string> = {
  right:
    'inset-y-0 right-0 w-full max-w-[440px] rounded-l-2xl data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
  bottom:
    'inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-2xl data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full',
}

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Popup> {
  side?: SheetSide
  /** Dim the page behind the sheet. Use with `modal`. */
  overlay?: boolean
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  ({ className, children, side = 'right', overlay = false, ...props }, ref) => (
    <SheetPrimitive.Portal>
      {overlay && <SheetPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/30" />}
      <SheetPrimitive.Popup
        ref={ref}
        className={cn(
          'fixed z-40 flex flex-col overflow-y-auto bg-white p-6 shadow-[0_0_40px_-12px_rgba(0,0,0,0.25)] outline-none',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  ),
)
SheetContent.displayName = 'SheetContent'

// ── Parts ─────────────────────────────────────────────────────────────────────

const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-tight tracking-tight text-zinc-900', className)}
    {...props}
  />
))
SheetTitle.displayName = 'SheetTitle'

const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn('text-xs text-zinc-400', className)} {...props} />
))
SheetDescription.displayName = 'SheetDescription'

const SheetClose = SheetPrimitive.Close

export { Sheet, SheetContent, SheetTitle, SheetDescription, SheetClose }
