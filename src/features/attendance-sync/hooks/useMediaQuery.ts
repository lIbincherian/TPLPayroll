'use client'

import { useSyncExternalStore } from 'react'

/**
 * Tracks a CSS media query. The server render and the first client render use
 * `serverValue`, so hydration matches; the real value applies right after.
 */
export function useMediaQuery(query: string, serverValue = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  )
}
