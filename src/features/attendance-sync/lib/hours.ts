import {
  DAILY_REGULAR_HOURS,
  UNUSUAL_DAY_MIN_HOURS,
  UNUSUAL_SINGLE_PAIR_MAX_HOURS,
} from './constants'
import { punchSetSignature } from './day-signature'
import { diffMinutes, normalizeTimeInput, round2, toMinutes } from './time'
import type {
  DayChange,
  DayValidation,
  DayView,
  HHmm,
  ISODate,
  PairView,
  PunchView,
  StoredPunchRow,
} from '../types/attendance-sync.types'

type CompletePair = { in: HHmm; out: HHmm }

function totalMinutes(pairs: CompletePair[]): number {
  return pairs.reduce((sum, pair) => sum + Math.max(0, diffMinutes(pair.in, pair.out)), 0)
}

/**
 * dailyTotal = sum(OUT − IN); regular = min(total, 8); overtime = max(0, total − 8).
 * Rounded to two decimals on the daily total. Only complete pairs are passed in.
 */
export function calculateDailyHours(pairs: CompletePair[]): {
  regularHours: number
  overtimeHours: number
  totalHours: number
} {
  const totalHours = round2(totalMinutes(pairs) / 60)
  return {
    regularHours: Math.min(totalHours, DAILY_REGULAR_HOURS),
    overtimeHours: round2(Math.max(0, totalHours - DAILY_REGULAR_HOURS)),
    totalHours,
  }
}

/** A complete day under UNUSUAL_DAY_MIN_HOURS, or with a single pair over UNUSUAL_SINGLE_PAIR_MAX_HOURS, is highlighted. */
export function isUnusualDay(pairs: CompletePair[]): { unusual: boolean; reason: string | null } {
  if (pairs.length === 0) return { unusual: false, reason: null }

  const minutes = totalMinutes(pairs)
  if (minutes < UNUSUAL_DAY_MIN_HOURS * 60) {
    return { unusual: true, reason: `Under ${UNUSUAL_DAY_MIN_HOURS} hours (${round2(minutes / 60).toFixed(2)})` }
  }

  const longPair = pairs.find((pair) => diffMinutes(pair.in, pair.out) > UNUSUAL_SINGLE_PAIR_MAX_HOURS * 60)
  if (longPair) {
    return { unusual: true, reason: `One pair over ${UNUSUAL_SINGLE_PAIR_MAX_HOURS} hours (${longPair.in}–${longPair.out})` }
  }

  return { unusual: false, reason: null }
}

type PairInput = { in: HHmm | null; out: HHmm | null; pairIndex?: number }

/**
 * Check a day's pairs before saving. Every time must be a real `HH:mm`, each OUT must be
 * after its IN (equal is rejected), and pairs must not overlap (touching is allowed).
 * A lone time of an incomplete pair may not sit strictly inside a complete pair.
 */
export function validateDayPairs(pairs: PairInput[]): DayValidation {
  const parsed: Array<{ pairIndex: number; in: HHmm | null; out: HHmm | null }> = []

  for (let i = 0; i < pairs.length; i++) {
    const pairIndex = pairs[i].pairIndex ?? i
    const values: Record<'in' | 'out', HHmm | null> = { in: null, out: null }

    for (const field of ['in', 'out'] as const) {
      const raw = pairs[i][field]
      if (raw === null) continue
      const time = normalizeTimeInput(raw)
      if (time === null) {
        return {
          valid: false,
          code: 'INVALID_TIME',
          pairIndex,
          field,
          message: `"${raw}" is not a valid time. Use HH:mm, for example 08:30.`,
        }
      }
      values[field] = time
    }

    if (values.in !== null && values.out !== null && toMinutes(values.out) <= toMinutes(values.in)) {
      return {
        valid: false,
        code: 'OUT_NOT_AFTER_IN',
        pairIndex,
        field: 'out',
        message: `OUT (${values.out}) must be after IN (${values.in}).`,
      }
    }

    if (values.in !== null || values.out !== null) parsed.push({ pairIndex, ...values })
  }

  const complete = parsed
    .filter((p): p is { pairIndex: number; in: HHmm; out: HHmm } => p.in !== null && p.out !== null)
    .sort((a, b) => toMinutes(a.in) - toMinutes(b.in))

  for (let i = 1; i < complete.length; i++) {
    if (toMinutes(complete[i].in) < toMinutes(complete[i - 1].out)) {
      return {
        valid: false,
        code: 'PAIRS_OVERLAP',
        pairIndex: complete[i].pairIndex,
        field: 'in',
        message: `Pair ${complete[i].in}–${complete[i].out} overlaps ${complete[i - 1].in}–${complete[i - 1].out}.`,
      }
    }
  }

  for (const lone of parsed.filter((p) => (p.in === null) !== (p.out === null))) {
    const field = lone.in !== null ? 'in' : 'out'
    const time = (lone.in ?? lone.out) as HHmm
    const minutes = toMinutes(time)
    const inside = complete.find((p) => minutes > toMinutes(p.in) && minutes < toMinutes(p.out))
    if (inside) {
      return {
        valid: false,
        code: 'PAIRS_OVERLAP',
        pairIndex: lone.pairIndex,
        field,
        message: `${time} falls inside the pair ${inside.in}–${inside.out}.`,
      }
    }
  }

  return { valid: true }
}

/** A day is edited when any punch's current time differs from its original. */
export function isEditedDay(
  punches: Array<{ original: HHmm | null; current: HHmm | null; source?: string }>,
): boolean {
  return punches.some((punch) => punch.original !== punch.current)
}

/** "07:40–13:04, 13:56–17:47" (en dash). Callers show "-" when there are no pairs. */
export function formatPunchesCell(pairs: CompletePair[]): string {
  return pairs.map((pair) => `${pair.in}–${pair.out}`).join(', ')
}

function asStringArray(value: unknown): HHmm[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function toPunchView(row: StoredPunchRow): PunchView {
  return {
    id: row.id,
    time: row.currentTime,
    original: row.originalTime,
    note: row.note,
    source: row.source === 'MANUAL' ? 'MANUAL' : 'API',
    mergedScans: asStringArray(row.mergedScansJson),
  }
}

/** Group a day's stored punches into pairs, ordered by pairIndex. */
export function pairsFromStoredPunches(rows: StoredPunchRow[]): PairView[] {
  const byIndex = new Map<number, { in: PunchView | null; out: PunchView | null }>()

  for (const row of rows) {
    const entry = byIndex.get(row.pairIndex) ?? { in: null, out: null }
    if (row.position === 'IN') entry.in = toPunchView(row)
    else if (row.position === 'OUT') entry.out = toPunchView(row)
    byIndex.set(row.pairIndex, entry)
  }

  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pairIndex, { in: inPunch, out: outPunch }]) => ({
      pairIndex,
      in: inPunch,
      out: outPunch,
      hours:
        inPunch?.time != null && outPunch?.time != null
          ? round2(diffMinutes(inPunch.time, outPunch.time) / 60)
          : 0,
    }))
}

function describeChanges(rows: StoredPunchRow[]): DayChange[] {
  const changes: DayChange[] = []
  for (const row of rows) {
    const base = { punchId: row.id, original: row.originalTime, current: row.currentTime, note: row.note }
    if (row.originalTime !== null && row.currentTime !== null && row.originalTime !== row.currentTime) {
      changes.push({ ...base, kind: 'EDITED' })
    } else if (row.source === 'MANUAL' && row.currentTime !== null) {
      changes.push({ ...base, kind: 'ADDED' })
    } else if (row.source === 'API' && row.originalTime !== null && row.currentTime === null) {
      changes.push({ ...base, kind: 'DELETED' })
    }
  }
  return changes
}

/** Everything the grid and the day editor show for one employee-day. */
export function buildDayView(date: ISODate, rows: StoredPunchRow[]): DayView {
  // Pairs whose punches were both deleted carry no information; the deletions show under Changes.
  const pairs = pairsFromStoredPunches(rows).filter(
    (pair) => (pair.in?.time ?? null) !== null || (pair.out?.time ?? null) !== null,
  )

  const completePairs: CompletePair[] = []
  let incomplete = false
  for (const pair of pairs) {
    const inTime = pair.in?.time ?? null
    const outTime = pair.out?.time ?? null
    if (inTime !== null && outTime !== null) completePairs.push({ in: inTime, out: outTime })
    else incomplete = true
  }

  const hours = calculateDailyHours(completePairs)
  // Only complete days are highlighted as unusual; an incomplete day is already under Needs fixing.
  const unusual = incomplete ? { unusual: false, reason: null } : isUnusualDay(completePairs)

  return {
    date,
    pairs,
    incomplete,
    regularHours: hours.regularHours,
    overtimeHours: hours.overtimeHours,
    totalHours: hours.totalHours,
    isEdited: isEditedDay(
      rows.map((row) => ({ original: row.originalTime, current: row.currentTime, source: row.source })),
    ),
    isMerged: rows.some((row) => asStringArray(row.mergedScansJson).length > 0),
    isUnusual: unusual.unusual,
    unusualReason: unusual.reason,
    changes: describeChanges(rows),
    signature: punchSetSignature(rows),
  }
}
