import type { HHmm } from '../types/attendance-sync.types'

/**
 * Accepts `HH:mm`, `H:mm`, `HHmm` and `Hmm` and returns zero-padded `HH:mm`.
 * Anything outside 00:00–23:59 (or not shaped like a time) is null.
 */
export function normalizeTimeInput(raw: string): HHmm | null {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function toMinutes(time: HHmm): number {
  const [hours, minutes] = time.split(':')
  return parseInt(hours, 10) * 60 + parseInt(minutes, 10)
}

/** Minutes from `a` to `b` (positive when `b` is later). */
export function diffMinutes(a: HHmm, b: HHmm): number {
  return toMinutes(b) - toMinutes(a)
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
