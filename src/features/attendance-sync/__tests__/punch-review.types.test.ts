// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))
vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

import prisma from '@/lib/prisma'
import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'
import type { CorrectionGridActions, PunchReviewGridProps } from '@/features/attendance-sync/components/PunchReviewGrid'
import type { CorrectionReview, LiveReview, ReviewMode } from '@/features/attendance-sync/types/attendance-sync.types'
import { freezeClock, makeEmployee, makeRun, makeSession, makeUpload, resetDb, serveUpload, type Db } from './service-fixtures'

// Round 3, item 10: the type of the review says whether it is a live review or a correction review, and
// PunchReviewGrid's props tie that to the actions: a correction review must come with its actions, a live
// one must not. `npx tsc --noEmit` checks every line below (tests are in tsconfig's include); an unused
// `@ts-expect-error` is itself a compile error, so each negative case fails the build if the types loosen.
// vitest does not type-check, so the runtime assertions only prove the values and the wiring.

const db = prisma as unknown as Db
const WEEK_ID = '2026-11-05'
const SRC = path.resolve(__dirname, '../../..')
const read = (relative: string) => readFileSync(path.join(SRC, relative), 'utf8')

const asha = makeEmployee({ id: 'emp-36', employeeId: 'TPLGOAHLP036', employeeName: 'Asha Rao' })

beforeEach(() => {
  resetDb(db)
  freezeClock('2026-11-13T03:00:00Z')
  serveUpload(db, makeUpload({ id: 'upload-1', status: 'APPROVED' }))
  db.employee.findMany.mockResolvedValue([asha])
  db.payrollRun.findFirst.mockResolvedValue(makeRun())
  db.payrollCorrectionSession.findUnique.mockResolvedValue(makeSession())
})

// ─── Type-level helpers ───────────────────────────────────────────────────────

type Extends<A, B> = [A] extends [B] ? true : false
type CorrectionMode = Extract<ReviewMode, { kind: 'CORRECTION' }>

// What the compiler infers for each mode, without calling anything.
type FromLive = Awaited<ReturnType<typeof getPunchReview<{ kind: 'LIVE' }>>>
type FromCorrection = Awaited<ReturnType<typeof getPunchReview<CorrectionMode>>>

const liveIsLiveReview: Extends<FromLive, LiveReview> = true
const correctionIsCorrectionReview: Extends<FromCorrection, CorrectionReview> = true
// The two kinds of review are different types, in both directions.
const liveIsNotCorrectionReview: Extends<LiveReview, CorrectionReview> = false
const correctionIsNotLiveReview: Extends<CorrectionReview, LiveReview> = false
const fromLiveIsNotCorrection: Extends<FromLive, CorrectionReview> = false
const fromCorrectionIsNotLive: Extends<FromCorrection, LiveReview> = false

describe('the review types (compile time)', () => {
  it('infers LiveReview and CorrectionReview from the mode that is passed', () => {
    expect([
      liveIsLiveReview,
      correctionIsCorrectionReview,
      liveIsNotCorrectionReview,
      correctionIsNotLiveReview,
      fromLiveIsNotCorrection,
      fromCorrectionIsNotLive,
    ]).toEqual([true, true, false, false, false, false])
  })
})

// ─── getPunchReview: the mode flows through to the result ─────────────────────

describe('getPunchReview returns a review typed by its mode', () => {
  const correctionMode = { kind: 'CORRECTION', payrollRunId: 'run-1', correctionId: 'session-1', revisionNumber: 2 } as const

  it('no mode, and the LIVE mode, give a LiveReview', async () => {
    const byDefault: LiveReview = await getPunchReview(WEEK_ID)
    const explicit: LiveReview = await getPunchReview(WEEK_ID, { kind: 'LIVE' })

    expect(byDefault.mode).toEqual({ kind: 'LIVE' })
    expect(explicit.mode).toEqual({ kind: 'LIVE' })
  })

  it('a CORRECTION mode gives a CorrectionReview whose mode fields are readable without a cast', async () => {
    const review: CorrectionReview = await getPunchReview(WEEK_ID, {
      kind: 'CORRECTION',
      payrollRunId: 'run-1',
      correctionId: 'session-1',
      revisionNumber: 2,
    })
    const fromConst: CorrectionReview = await getPunchReview(WEEK_ID, correctionMode)

    // These property reads only compile when the result is narrowed to the correction variant.
    expect(review.mode.correctionId).toBe('session-1')
    expect(review.mode.payrollRunId).toBe('run-1')
    expect(review.mode.revisionNumber).toBe(2)
    expect(fromConst.mode.correctionId).toBe('session-1')
  })

  it('a review of one kind is not accepted as the other kind', async () => {
    const live = await getPunchReview(WEEK_ID)
    const correction = await getPunchReview(WEEK_ID, correctionMode)

    // @ts-expect-error a live review is not a correction review
    const asCorrection: CorrectionReview = live
    // @ts-expect-error a correction review is not a live review
    const asLive: LiveReview = correction

    expect(asCorrection.mode.kind).toBe('LIVE')
    expect(asLive.mode.kind).toBe('CORRECTION')
  })

  it('a mode that is only known to be a ReviewMode gives a review that is neither (the caller must narrow first)', async () => {
    const unknownKind = { kind: 'LIVE' } as ReviewMode
    const review = await getPunchReview(WEEK_ID, unknownKind)

    // @ts-expect-error the kind is not known, so this may not be treated as a live review
    const asLive: LiveReview = review
    // @ts-expect-error nor as a correction review
    const asCorrection: CorrectionReview = review

    expect(asLive.mode.kind).toBe('LIVE')
    expect(asCorrection.mode.kind).toBe('LIVE')
  })

  it('what the service returns can be handed to the grid as it is, and nothing wider can', async () => {
    const live = await getPunchReview(WEEK_ID)
    const correction = await getPunchReview(WEEK_ID, correctionMode)
    const wide = await getPunchReview(WEEK_ID, { kind: 'LIVE' } as ReviewMode)
    const actions: CorrectionGridActions = {
      reason: 'wrong time',
      onApprove: async () => undefined,
      onAbandon: async () => ({ ok: true, data: null }),
    }
    const base = { backHref: '/', backLabel: 'Back', title: 'Punches' }

    const liveProps: PunchReviewGridProps = { ...base, initialReview: live }
    const correctionProps: PunchReviewGridProps = { ...base, initialReview: correction, correction: actions }
    // @ts-expect-error a review of unknown kind fits neither shape of the props
    const wideProps: PunchReviewGridProps = { ...base, initialReview: wide }
    // @ts-expect-error a correction review without its actions
    const noActions: PunchReviewGridProps = { ...base, initialReview: correction }
    // @ts-expect-error a live review with correction actions
    const strayActions: PunchReviewGridProps = { ...base, initialReview: live, correction: actions }
    // @ts-expect-error the approve action takes the payroll run id (a string)
    const wrongApprove: PunchReviewGridProps = { ...base, initialReview: correction, correction: { ...actions, onApprove: async (id: number) => { void id; return undefined } } }
    // @ts-expect-error the reason is part of the actions, even when it is null
    const noReason: PunchReviewGridProps = { ...base, initialReview: correction, correction: { onApprove: actions.onApprove, onAbandon: actions.onAbandon } }

    expect([liveProps, correctionProps, wideProps, noActions, strayActions, wrongApprove, noReason]).toHaveLength(7)
  })
})

// ─── The grid has no runtime fallback for a missing action ────────────────────

describe('PunchReviewGrid.tsx has no runtime fallback for missing correction actions', () => {
  const grid = read('features/attendance-sync/components/PunchReviewGrid.tsx')

  it('has no stand-in action and no "reload and try again" message for a missing action', () => {
    expect(grid).not.toMatch(/correctionActionMissing/)
    expect(grid).not.toMatch(/Reload the page and try again/)
    expect(grid).not.toMatch(/Couldn't complete that/)
  })

  it('has none of the old optional props (onApproveCorrection, onAbandonCorrection, correctionReason)', () => {
    expect(grid).not.toMatch(/onApproveCorrection/)
    expect(grid).not.toMatch(/onAbandonCorrection/)
    expect(grid).not.toMatch(/correctionReason/)
  })

  it('never asserts the actions into existence with `!` and never falls back with `??` to another function', () => {
    expect(grid).not.toMatch(/\bcorrection!/)
    expect(grid).not.toMatch(/\bcorrection\)!/)
    expect(grid).not.toMatch(/props\.correction!/)
    expect(grid).not.toMatch(/correction\.on(Approve|Abandon)!/)
    expect(grid).not.toMatch(/correction\.on(Approve|Abandon)\s*\?\?/)
    expect(grid).not.toMatch(/\?\?\s*correction/)
  })

  it('declares the props as a union that ties the review kind to the actions', () => {
    expect(grid).toMatch(/initialReview: LiveReview; correction\?: undefined/)
    expect(grid).toMatch(/initialReview: CorrectionReview; correction: CorrectionGridActions/)
  })

  it('does not import payroll-correction (the page injects the actions)', () => {
    // (the doc comment on onApprove names the feature; only an import would be a problem)
    expect(grid).not.toMatch(/from\s+['"][^'"]*payroll-correction/)
    expect(grid).not.toMatch(/import\(\s*['"][^'"]*payroll-correction/)
  })
})

describe('the pages that mount the grid', () => {
  const correctionPage = read('app/payroll/run/[payrollRunId]/correct/punches/page.tsx')
  const livePage = read('app/attendance/[weekId]/review/page.tsx')

  it('the correction page passes reason, approve and abandon together, and its review needs no cast', () => {
    expect(correctionPage).toMatch(/correction=\{\{[\s\S]*?reason:[\s\S]*?onApprove: approveCorrectionPunchesAction[\s\S]*?onAbandon: abandonCorrectionAction[\s\S]*?\}\}/)
    expect(correctionPage).toMatch(/let review: CorrectionReview/)
    expect(correctionPage).not.toMatch(/\bas (CorrectionReview|LiveReview|PunchReview)\b/)
  })

  it('the live page passes no correction actions, reads the review from the service typed as LiveReview, and needs no cast', () => {
    expect(livePage).not.toMatch(/\bcorrection=/)
    expect(livePage).not.toMatch(/Correction(Punches)?Action/)
    expect(livePage).toMatch(/let review: LiveReview/)
    expect(livePage).toMatch(/getPunchReview\(weekId, \{ kind: 'LIVE' \}\)/)
    expect(livePage).not.toMatch(/getPunchReviewAction/)
    expect(livePage).not.toMatch(/\bas (CorrectionReview|LiveReview|PunchReview)\b/)
  })
})
