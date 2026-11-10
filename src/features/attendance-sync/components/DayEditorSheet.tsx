'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  ArrowsMerge,
  CaretLeft,
  CaretRight,
  Plus,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { savePunchEditAction } from '../actions/attendance-sync.actions'
import {
  draftFromDay,
  hasUnsavedChanges,
  isEmptyDraftPair,
  nextPairIndex,
  normalizeDraft,
  reconcileDraft,
  toSavePairs,
  toValidationPairs,
  type DraftPair,
} from '../lib/day-draft'
import { formatHours, formatIstTime, formatDayLong } from '../lib/format'
import { validateDayPairs } from '../lib/hours'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type {
  DayView,
  GridEmployee,
  ISODate,
  PairView,
  ReviewMode,
  SavePunchEditResult,
} from '../types/attendance-sync.types'

type Field = 'in' | 'out'
type FieldError = { pairIndex: number; field: Field; message: string }
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'invalid' }
  | { kind: 'reloaded' }
  | { kind: 'failed'; message: string }

const LABEL = 'text-xs font-medium uppercase tracking-wider text-zinc-500'

/**
 * What reloading a day after a DAY_CHANGED refusal found: its latest view; `null` when the reload itself
 * failed (the editor stays open and offers a retry); or `'gone'` when the employee or the day is no longer in
 * the review. For `'gone'` the grid has already closed the editor, and the editor needs to hear that now, not
 * on the render that follows, or it would flag the header "Not saved" for a day nobody is editing.
 */
export type DayReload = DayView | null | 'gone'

// ─── Time field ───────────────────────────────────────────────────────────────

interface TimeFieldProps {
  value: string
  edited: boolean
  invalid: boolean
  label: string
  testId: string
  inputRef?: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onCommit: () => void
  onClear: () => void
}

function TimeField({ value, edited, invalid, label, testId, inputRef, onChange, onCommit, onClear }: TimeFieldProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      onCommit()
    }
  }

  return (
    <div className="group/field relative">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder="--:--"
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={handleKeyDown}
        className={[
          'h-9 w-20 rounded-xl border bg-white text-center font-mono text-sm tabular-nums text-zinc-900 outline-none transition-colors md:h-9 max-md:h-11 max-md:w-24',
          'placeholder:text-zinc-400 focus:ring-2',
          invalid
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-500/20'
            : edited
              ? 'border-sky-300 bg-sky-50/40 focus:border-emerald-500 focus:ring-emerald-500/20'
              : 'border-zinc-200/60 focus:border-emerald-500 focus:ring-emerald-500/20',
        ].join(' ')}
      />
      {value !== '' && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Delete ${label}`}
          data-testid={`${testId}-clear`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClear}
          className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 group-focus-within/field:opacity-100 group-hover/field:opacity-100 max-md:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

// ─── Editor body ──────────────────────────────────────────────────────────────

interface EditorBodyProps {
  weekId: ISODate
  mode: ReviewMode
  employee: GridEmployee
  day: DayView
  readOnly: boolean
  firstFieldRef: RefObject<HTMLInputElement | null>
  canStepPrevious: boolean
  canStepNext: boolean
  onStep: (direction: 'previous' | 'next') => void
  onClose: () => void
  onSaved: (result: SavePunchEditResult) => void
  /** Tells the grid header whether the last save worked. */
  onSaveFailed: (failed: boolean) => void
  /** The day was changed elsewhere: reload it and return what that found (see DayReload). */
  onDayChanged: () => Promise<DayReload>
}

function EditorBody({
  weekId,
  mode,
  employee,
  day,
  readOnly,
  firstFieldRef,
  canStepPrevious,
  canStepNext,
  onStep,
  onClose,
  onSaved,
  onSaveFailed,
  onDayChanged,
}: EditorBodyProps) {
  const [draft, setDraftState] = useState<DraftPair[]>(() => draftFromDay(day))
  const [notes, setNotesState] = useState<Record<string, string>>({})
  const [error, setError] = useState<FieldError | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  // Refs mirror state so a blur right after a keystroke still sees the latest values.
  const draftRef = useRef(draft)
  const notesRef = useRef(notes)
  const savedDayRef = useRef(day)
  // The version of the day the draft was built on. It follows the draft, not the `day` prop: the grid can
  // reload `day` underneath an editor whose draft is still the old one. It changes only after a successful
  // save and after a DAY_CHANGED reset.
  const baseSignatureRef = useRef(day.signature)
  const savingRef = useRef(false)
  const rerunRef = useRef(false)
  // Set once the editor has closed or moved on (this body unmounted, or the grid reported the day gone). A
  // save still in flight then leaves this body's own state alone, and a blur or Enter from an input that is
  // going away must not start another one, least of all with the draft and base signature the server just
  // refused. A failed in-flight save is still reported to the grid (onSaveFailed is the grid's setter), so
  // the header never claims an edit was saved after the user stepped to another day or closed the editor.
  const closedRef = useRef(false)
  // Set only when a DAY_CHANGED reload found the employee or day gone: the grid has already closed the
  // editor and cleared its header, so nothing about this save is reported any more.
  const goneRef = useRef(false)

  useEffect(() => {
    closedRef.current = false // a development remount reuses the refs
    goneRef.current = false
    return () => {
      closedRef.current = true
    }
  }, [])

  useEffect(() => {
    savedDayRef.current = day
  }, [day])

  const setDraft = useCallback((next: DraftPair[]) => {
    draftRef.current = next
    setDraftState(next)
  }, [])

  const setNotes = useCallback((next: Record<string, string>) => {
    notesRef.current = next
    setNotesState(next)
  }, [])

  const commit = useCallback(async () => {
    if (readOnly || closedRef.current) return
    if (savingRef.current) {
      rerunRef.current = true
      return
    }

    const validation = validateDayPairs(toValidationPairs(draftRef.current))
    if (!validation.valid) {
      setError({ pairIndex: validation.pairIndex, field: validation.field, message: validation.message })
      setSaveState({ kind: 'invalid' })
      return
    }
    setError(null)

    const normalized = normalizeDraft(draftRef.current)
    setDraft(normalized)
    if (!hasUnsavedChanges(savedDayRef.current, normalized, notesRef.current)) {
      setSaveState((state) => (state.kind === 'invalid' ? { kind: 'idle' } : state))
      return
    }

    savingRef.current = true
    setSaveState({ kind: 'saving' })
    try {
      const res = await savePunchEditAction({
        weekId,
        employeeId: employee.employeeId,
        date: day.date,
        mode,
        baseSignature: baseSignatureRef.current,
        pairs: toSavePairs(normalized, notesRef.current),
      })

      if (res.ok) {
        savedDayRef.current = res.data.day
        baseSignatureRef.current = res.data.day.signature
        if (!closedRef.current) {
          setDraft(reconcileDraft(res.data.day, draftRef.current, normalized))
          setSaveState({ kind: 'saved', at: res.data.savedAt })
        }
        onSaveFailed(false)
        onSaved(res.data)
      } else if (res.validation && !res.validation.valid) {
        if (!closedRef.current) {
          setError({ pairIndex: res.validation.pairIndex, field: res.validation.field, message: res.validation.message })
          setSaveState({ kind: 'invalid' })
        }
      } else if (res.code === 'DAY_CHANGED') {
        const fresh = await onDayChanged()
        rerunRef.current = false // what was typed against the stale day is dropped
        if (fresh === 'gone') {
          // The grid closed the editor, told the user, and cleared its header; React has not unmounted this body yet.
          closedRef.current = true
          goneRef.current = true
          return
        }
        if (fresh && !closedRef.current) {
          savedDayRef.current = fresh
          baseSignatureRef.current = fresh.signature
          setDraft(draftFromDay(fresh))
          setNotes({})
          setError(null)
          setSaveState({ kind: 'reloaded' })
          onSaveFailed(false)
        } else {
          // The reload failed, or the editor is no longer here to show the reloaded day: nothing was saved.
          if (!closedRef.current) setSaveState({ kind: 'failed', message: res.error })
          onSaveFailed(true)
        }
      } else {
        if (!closedRef.current) setSaveState({ kind: 'failed', message: res.error })
        onSaveFailed(true)
      }
    } catch {
      if (!closedRef.current) {
        setSaveState({ kind: 'failed', message: "Couldn't save. Your last saved times are unchanged." })
      }
      if (!goneRef.current) onSaveFailed(true)
    } finally {
      savingRef.current = false
      if (rerunRef.current) {
        rerunRef.current = false
        void commit()
      }
    }
  }, [readOnly, weekId, employee.employeeId, day.date, mode, onSaved, onSaveFailed, onDayChanged, setDraft, setNotes])

  function updateField(pairIndex: number, field: Field, value: string) {
    setDraft(
      draftRef.current.map((pair) =>
        pair.pairIndex === pairIndex ? { ...pair, [field]: { ...pair[field], value } } : pair,
      ),
    )
    if (error?.pairIndex === pairIndex && error.field === field) setError(null)
  }

  function clearField(pairIndex: number, field: Field) {
    updateField(pairIndex, field, '')
    void commit()
  }

  function removePair(pairIndex: number) {
    const remaining = draftRef.current.filter((pair) => pair.pairIndex !== pairIndex)
    setDraft(remaining.length > 0 ? remaining : [{ pairIndex, in: { value: '' }, out: { value: '' } }])
    setError(null)
    void commit()
  }

  function addPair() {
    setDraft([...draftRef.current, { pairIndex: nextPairIndex(savedDayRef.current, draftRef.current), in: { value: '' }, out: { value: '' } }])
  }

  function commitNote(punchId: string, note: string) {
    setNotes({ ...notesRef.current, [punchId]: note })
    void commit()
  }

  const savedPair = (pairIndex: number): PairView | undefined => day.pairs.find((p) => p.pairIndex === pairIndex)
  const isEditedSide = (punch: { original: string | null; time: string | null } | null | undefined) =>
    Boolean(punch) && punch!.original !== punch!.time
  const mergedPunches = day.pairs.flatMap((pair) => [pair.in, pair.out]).filter((p) => p && p.mergedScans.length > 0)
  const lastSavedText = saveState.kind === 'saved' ? formatIstTime(saveState.at) : null

  return (
    <div className="flex min-h-full flex-1 flex-col" data-testid="day-editor">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SheetTitle className="truncate" data-testid="editor-employee-name">
            {employee.employeeName}
          </SheetTitle>
          <SheetDescription className="mt-1 font-mono" data-testid="editor-day-label">
            {employee.employeeCode} · {formatDayLong(day.date)}
          </SheetDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous day"
            disabled={!canStepPrevious}
            onClick={() => onStep('previous')}
            data-testid="editor-previous"
          >
            <CaretLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next day"
            disabled={!canStepNext}
            onClick={() => onStep('next')}
            data-testid="editor-next"
          >
            <CaretRight size={14} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close editor" onClick={onClose} data-testid="editor-close">
            <X size={14} />
          </Button>
        </div>
      </div>

      {(day.isEdited || day.isMerged || day.isUnusual) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {day.isEdited && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">Edited</span>
          )}
          {day.isMerged && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">Merged</span>
          )}
          {day.isUnusual && (
            <span
              className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              data-testid="editor-unusual"
            >
              Unusual: {day.unusualReason}
            </span>
          )}
        </div>
      )}

      {/* Day totals */}
      <dl className="mt-4 flex divide-x divide-zinc-200 border-b border-t border-zinc-200/60 py-3">
        {[
          ['regular', 'Regular', day.regularHours],
          ['overtime', 'Overtime', day.overtimeHours],
          ['total', 'Total', day.totalHours],
        ].map(([id, label, hours]) => (
          <div key={id as string} className="flex-1 px-4 first:pl-0">
            <dt className={LABEL}>{label as string}</dt>
            <dd
              className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-zinc-900"
              data-testid={`editor-day-${id as string}`}
            >
              {formatHours(hours as number)}
            </dd>
          </div>
        ))}
      </dl>

      {/* Incomplete pair banner */}
      {day.incomplete && (
        <div
          role="status"
          data-testid="editor-needs-fixing"
          className="mt-4 rounded-xl border border-rose-200/60 bg-rose-50 p-3"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-rose-700">
            <WarningCircle size={16} className="shrink-0" />
            Needs fixing: this punch has no pair.
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            If a punch was the OUT, enter it as OUT and add the IN.
          </p>
        </div>
      )}

      {/* Pairs */}
      <div className="mt-4">
        {day.pairs.length === 0 && draft.every(isEmptyDraftPair) && (
          <p className="mb-3 text-sm text-zinc-500">No punches on this day.</p>
        )}

        {readOnly ? (
          <ul className="space-y-2" data-testid="editor-pairs">
            {day.pairs.length === 0 && <li className="text-sm text-zinc-500">No punches on this day.</li>}
            {day.pairs.map((pair, index) => (
              <li key={pair.pairIndex} className="flex items-center gap-3 font-mono text-sm tabular-nums text-zinc-900">
                <span className="w-4 text-xs text-zinc-500">{index + 1}</span>
                <span data-testid={`editor-pair-${index + 1}-in`}>{pair.in?.time ?? '--:--'}</span>
                <span className="text-zinc-400">–</span>
                <span data-testid={`editor-pair-${index + 1}-out`}>{pair.out?.time ?? '--:--'}</span>
                <span className="ml-auto text-zinc-500">{pair.in?.time && pair.out?.time ? formatHours(pair.hours) : '—'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div data-testid="editor-pairs">
            <div className="mb-1 grid grid-cols-[1.25rem_5rem_0.75rem_5rem_1fr_1.75rem] items-center gap-x-2 max-md:grid-cols-[1.25rem_6rem_0.75rem_6rem_1fr_1.75rem]">
              <span />
              <span className={`${LABEL} text-center`}>In</span>
              <span />
              <span className={`${LABEL} text-center`}>Out</span>
              <span className={`${LABEL} text-right`}>Hours</span>
              <span />
            </div>
            <ul className="space-y-2">
              {draft.map((pair, index) => {
                const saved = savedPair(pair.pairIndex)
                const rowError = error?.pairIndex === pair.pairIndex ? error : null
                const number = index + 1
                return (
                  <li key={pair.pairIndex}>
                    <div className="grid grid-cols-[1.25rem_5rem_0.75rem_5rem_1fr_1.75rem] items-center gap-x-2 max-md:grid-cols-[1.25rem_6rem_0.75rem_6rem_1fr_1.75rem]">
                      <span className="text-xs text-zinc-500">{number}</span>
                      <TimeField
                        value={pair.in.value}
                        edited={isEditedSide(saved?.in)}
                        invalid={rowError?.field === 'in'}
                        label={`Pair ${number} IN`}
                        testId={`editor-pair-${number}-in`}
                        inputRef={index === 0 ? firstFieldRef : undefined}
                        onChange={(value) => updateField(pair.pairIndex, 'in', value)}
                        onCommit={() => void commit()}
                        onClear={() => clearField(pair.pairIndex, 'in')}
                      />
                      <span className="text-center text-zinc-400">–</span>
                      <TimeField
                        value={pair.out.value}
                        edited={isEditedSide(saved?.out)}
                        invalid={rowError?.field === 'out'}
                        label={`Pair ${number} OUT`}
                        testId={`editor-pair-${number}-out`}
                        onChange={(value) => updateField(pair.pairIndex, 'out', value)}
                        onCommit={() => void commit()}
                        onClear={() => clearField(pair.pairIndex, 'out')}
                      />
                      <span
                        className="text-right font-mono text-sm tabular-nums text-zinc-500"
                        data-testid={`editor-pair-${number}-hours`}
                      >
                        {saved?.in?.time && saved.out?.time ? formatHours(saved.hours) : '—'}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete pair ${number}`}
                        onClick={() => removePair(pair.pairIndex)}
                        data-testid={`editor-pair-${number}-delete`}
                        className="text-zinc-500 hover:text-rose-600"
                      >
                        <Trash size={14} />
                      </Button>
                    </div>
                    {rowError && (
                      <div role="alert" data-testid="editor-error" className="mt-1.5 pl-7">
                        <p className="flex items-start gap-1.5 text-xs text-rose-600">
                          <WarningCircle size={14} className="mt-px shrink-0" />
                          {rowError.message}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500">Not saved. Hours are from the last saved times.</p>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 text-emerald-700 hover:text-emerald-800"
              onClick={addPair}
              data-testid="editor-add-pair"
            >
              <Plus size={14} />
              Add pair
            </Button>
          </div>
        )}
      </div>

      {/* Changes */}
      {day.changes.length > 0 && (
        <section className="mt-5 border-t border-zinc-200/60 pt-4" data-testid="editor-changes">
          <h3 className="mb-2 text-sm font-medium text-zinc-900">Changes</h3>
          <div className="mb-1 grid grid-cols-[4rem_4.5rem_1fr] gap-x-3">
            <span className={LABEL}>Original</span>
            <span className={LABEL}>Current</span>
            <span className={LABEL}>{readOnly ? 'Note' : 'Note (optional)'}</span>
          </div>
          <ul className="space-y-2">
            {day.changes.map((change, index) => (
              <li key={change.punchId} className="grid grid-cols-[4rem_4.5rem_1fr] items-center gap-x-3">
                <span className="font-mono text-sm tabular-nums text-zinc-500 line-through">
                  {change.original ?? '—'}
                </span>
                <span
                  className={
                    change.current === null
                      ? 'text-sm text-rose-600'
                      : 'font-mono text-sm tabular-nums text-zinc-900'
                  }
                >
                  {change.current ?? 'Deleted'}
                </span>
                {readOnly ? (
                  <span className="text-xs text-zinc-600">{change.note ?? ''}</span>
                ) : (
                  <input
                    type="text"
                    aria-label={`Note for the ${change.current ?? change.original} punch`}
                    data-testid={`editor-note-${index + 1}`}
                    maxLength={500}
                    value={notes[change.punchId] ?? change.note ?? ''}
                    onChange={(event) => setNotes({ ...notesRef.current, [change.punchId]: event.target.value })}
                    onBlur={(event) => commitNote(change.punchId, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitNote(change.punchId, event.currentTarget.value)
                    }}
                    placeholder="Why was this changed?"
                    className="h-8 min-w-0 rounded-lg border border-zinc-200/60 bg-white px-2 text-xs text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Merged scans */}
      {day.isMerged && (
        <section className="mt-5" data-testid="editor-merged">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
            <ArrowsMerge size={14} />
            Merged scans
          </h3>
          <p className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-zinc-600">
            {mergedPunches.map((punch) => {
              const kept = punch!.original ?? punch!.time
              return (
                <span key={punch!.id}>
                  {[kept, ...punch!.mergedScans].sort().join(' ')} → {kept}
                </span>
              )
            })}
          </p>
        </section>
      )}

      {/* Footer */}
      <div className="mt-auto pt-6" role="status" aria-live="polite" data-testid="editor-save-status">
        {saveState.kind === 'saving' && <p className="text-xs text-zinc-500">Saving…</p>}
        {saveState.kind === 'saved' && <p className="text-xs text-zinc-500">Saved {lastSavedText}</p>}
        {saveState.kind === 'reloaded' && (
          <p className="text-xs text-amber-700" data-testid="editor-day-changed">
            This day was changed in another tab or by a pull, so your change was not saved. It now shows the latest
            times. Enter your change again.
          </p>
        )}
        {saveState.kind === 'failed' && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-rose-600">
            {saveState.message || "Couldn't save. Your last saved times are unchanged."}
            <Button size="xs" variant="outline" onClick={() => void commit()} data-testid="editor-retry">
              Try again
            </Button>
          </p>
        )}
        {saveState.kind === 'idle' && readOnly && <p className="text-xs text-zinc-500">Read only</p>}
      </div>
    </div>
  )
}

// ─── DayEditorSheet ───────────────────────────────────────────────────────────

interface DayEditorSheetProps {
  open: boolean
  onClose: () => void
  weekId: ISODate
  mode: ReviewMode
  employee: GridEmployee | null
  day: DayView | null
  readOnly: boolean
  canStepPrevious: boolean
  canStepNext: boolean
  onStep: (direction: 'previous' | 'next') => void
  onSaved: (employeeId: string, date: ISODate, result: SavePunchEditResult) => void
  onSaveFailed: (failed: boolean) => void
  /** Reloads the review after a DAY_CHANGED refusal and says what it found for the day (see DayReload). */
  onDayChanged: (employeeId: string, date: ISODate) => Promise<DayReload>
}

/**
 * The panel for one employee-day. On a laptop it sits beside the grid without dimming it, so
 * the grid updates live; on a phone it takes the whole screen. Edits save as you go.
 */
export function DayEditorSheet({
  open,
  onClose,
  weekId,
  mode,
  employee,
  day,
  readOnly,
  canStepPrevious,
  canStepNext,
  onStep,
  onSaved,
  onSaveFailed,
  onDayChanged,
}: DayEditorSheetProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const firstFieldRef = useRef<HTMLInputElement>(null)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      modal={!isDesktop}
      disablePointerDismissal
    >
      <SheetContent
        side="right"
        overlay={!isDesktop}
        initialFocus={readOnly ? true : firstFieldRef}
        finalFocus={false}
        data-testid="day-editor-sheet"
        className="max-md:max-w-none"
      >
        {employee && day && (
          <EditorBody
            key={`${employee.employeeId}|${day.date}`}
            weekId={weekId}
            mode={mode}
            employee={employee}
            day={day}
            readOnly={readOnly}
            firstFieldRef={firstFieldRef}
            canStepPrevious={canStepPrevious}
            canStepNext={canStepNext}
            onStep={onStep}
            onClose={onClose}
            onSaved={(result) => onSaved(employee.employeeId, day.date, result)}
            onSaveFailed={onSaveFailed}
            onDayChanged={() => onDayChanged(employee.employeeId, day.date)}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
