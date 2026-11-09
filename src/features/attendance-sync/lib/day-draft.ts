import { normalizeTimeInput } from './time'
import type { DayView, PairView, SavePair } from '../types/attendance-sync.types'

// The day editor keeps what the user is typing as a draft. These pure helpers turn a saved
// day into a draft, a draft into the payload for savePunchEditAction, and tell whether a draft
// differs from what is saved. No React, no I/O.

export interface DraftSide {
  /** The stored punch this field edits; absent for a time typed into a new pair. */
  punchId?: string
  /** What is in the input box, exactly as typed. */
  value: string
}

export interface DraftPair {
  /** Stable React key and the pair's index in storage. */
  pairIndex: number
  in: DraftSide
  out: DraftSide
}

const isBlank = (value: string): boolean => value.trim() === ''

export function isEmptyDraftPair(pair: DraftPair): boolean {
  return isBlank(pair.in.value) && isBlank(pair.out.value) && !pair.in.punchId && !pair.out.punchId
}

/** The index a new pair should take: one past every pair on the day. */
export function nextPairIndex(day: DayView, draft: DraftPair[] = []): number {
  const indices = [...day.pairs.map((p) => p.pairIndex), ...draft.map((p) => p.pairIndex)]
  return indices.length === 0 ? 0 : Math.max(...indices) + 1
}

function draftFromPair(pair: PairView): DraftPair {
  return {
    pairIndex: pair.pairIndex,
    in: { punchId: pair.in?.id, value: pair.in?.time ?? '' },
    out: { punchId: pair.out?.id, value: pair.out?.time ?? '' },
  }
}

/** A saved day as an editable draft. An empty day gets one blank pair, ready to type in. */
export function draftFromDay(day: DayView): DraftPair[] {
  if (day.pairs.length === 0) {
    return [{ pairIndex: nextPairIndex(day), in: { value: '' }, out: { value: '' } }]
  }
  return day.pairs.map(draftFromPair)
}

/**
 * After a save, rebuild the draft from the saved day. What the user typed while the request
 * was in flight is kept: a field whose text changed since `sent` was captured is left alone,
 * and so are pairs added meanwhile and blank rows they are about to type into.
 */
export function reconcileDraft(day: DayView, current: DraftPair[], sent: DraftPair[]): DraftPair[] {
  const currentByIndex = new Map(current.map((p) => [p.pairIndex, p]))
  const sentByIndex = new Map(sent.map((p) => [p.pairIndex, p]))

  const keep = (savedSide: DraftSide, currentSide?: DraftSide, sentSide?: DraftSide): DraftSide =>
    currentSide && sentSide && currentSide.value !== sentSide.value
      ? { punchId: savedSide.punchId, value: currentSide.value }
      : savedSide

  const saved = day.pairs.map((pair) => {
    const base = draftFromPair(pair)
    const cur = currentByIndex.get(pair.pairIndex)
    const snt = sentByIndex.get(pair.pairIndex)
    return { ...base, in: keep(base.in, cur?.in, snt?.in), out: keep(base.out, cur?.out, snt?.out) }
  })

  const extras = current.filter(
    (pair) => !saved.some((s) => s.pairIndex === pair.pairIndex) && (isEmptyDraftPair(pair) || !sentByIndex.has(pair.pairIndex)),
  )
  const combined = [...saved, ...extras]
  return combined.length > 0 ? combined : draftFromDay(day)
}

/** Fixes `1747` to `17:47` where it can; leaves unreadable text alone for validation to report. */
export function normalizeSide(side: DraftSide): DraftSide {
  if (isBlank(side.value)) return { ...side, value: '' }
  return { ...side, value: normalizeTimeInput(side.value) ?? side.value.trim() }
}

export function normalizeDraft(draft: DraftPair[]): DraftPair[] {
  return draft.map((pair) => ({ ...pair, in: normalizeSide(pair.in), out: normalizeSide(pair.out) }))
}

/** Raw times for `validateDayPairs`. A pair with neither time is ignored there. */
export function toValidationPairs(draft: DraftPair[]): Array<{ pairIndex: number; in: string | null; out: string | null }> {
  return draft.map((pair) => ({
    pairIndex: pair.pairIndex,
    in: isBlank(pair.in.value) ? null : pair.in.value.trim(),
    out: isBlank(pair.out.value) ? null : pair.out.value.trim(),
  }))
}

/**
 * The whole day, as savePunchEditAction expects it. A pair left out is deleted, so every pair
 * that still has a time or a stored punch is sent. `notes` maps a punch id to its edited note.
 */
export function toSavePairs(draft: DraftPair[], notes: Record<string, string>): SavePair[] {
  const side = (s: DraftSide) => ({
    punchId: s.punchId,
    time: isBlank(s.value) ? null : (normalizeTimeInput(s.value) ?? s.value.trim()),
    note: s.punchId && s.punchId in notes ? notes[s.punchId] : undefined,
  })

  return draft
    .filter((pair) => !isEmptyDraftPair(pair))
    .map((pair) => ({ pairIndex: pair.pairIndex, in: side(pair.in), out: side(pair.out) }))
}

function savedTimes(day: DayView): string {
  return JSON.stringify(
    day.pairs.map((p) => [p.pairIndex, p.in?.time ?? null, p.out?.time ?? null]),
  )
}

function draftTimes(draft: DraftPair[]): string {
  return JSON.stringify(
    draft
      .filter((p) => !isBlank(p.in.value) || !isBlank(p.out.value))
      .map((p) => [p.pairIndex, isBlank(p.in.value) ? null : p.in.value, isBlank(p.out.value) ? null : p.out.value]),
  )
}

/** Notes the user has edited that differ from what is stored. */
function noteChanged(day: DayView, notes: Record<string, string>): boolean {
  const saved = new Map<string, string>()
  for (const pair of day.pairs) {
    for (const punch of [pair.in, pair.out]) if (punch) saved.set(punch.id, punch.note ?? '')
  }
  for (const change of day.changes) saved.set(change.punchId, change.note ?? '')
  return Object.entries(notes).some(([punchId, note]) => (saved.get(punchId) ?? '') !== note.trim())
}

/** Whether saving would change anything. An unchanged draft needs no request. */
export function hasUnsavedChanges(day: DayView, draft: DraftPair[], notes: Record<string, string>): boolean {
  return savedTimes(day) !== draftTimes(normalizeDraft(draft)) || noteChanged(day, notes)
}
