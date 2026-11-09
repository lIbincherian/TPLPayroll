'use client'

import * as React from 'react'
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { cn } from '@/lib/utils'

// Thin wrappers over the Base UI collapsible. The panel is shown or hidden with no height
// animation, so it never shifts the layout mid-transition.

function Collapsible({ className, ...props }: React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root className={className} {...props} />
}

const CollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.Trigger
    ref={ref}
    className={cn(
      'group/collapsible flex items-center gap-1.5 rounded-md text-sm font-medium text-zinc-700 outline-none',
      'transition-colors hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500/40',
      className,
    )}
    {...props}
  />
))
CollapsibleTrigger.displayName = 'CollapsibleTrigger'

const CollapsiblePanel = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Panel>
>(({ className, ...props }, ref) => <CollapsiblePrimitive.Panel ref={ref} className={className} {...props} />)
CollapsiblePanel.displayName = 'CollapsiblePanel'

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
