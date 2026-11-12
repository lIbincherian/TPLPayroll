// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AttendanceUpload } from '@prisma/client'
import { assertNotSyncing, isSyncing, type LockedWeekRow } from '@/features/attendance-sync/services/week-lock.service'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'

// isSyncing and assertNotSyncing take `{ syncLockedAt: Date | null }`: the column is REQUIRED. A row cut down
// by a partial select must not count as "not syncing" and skip the pull guard without a sound.
//
// The `@ts-expect-error` lines are the type-level half of this contract. Vitest does not type-check, so they
// bite under `tsc --noEmit`: if the parameter were loosened back to an optional column, the directive would be
// unused and tsc would fail on this file.

const NOW = new Date('2026-11-12T08:00:00Z')

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('the parameter type of isSyncing and assertNotSyncing (checked by tsc)', () => {
  it('is exactly { syncLockedAt: Date | null }', () => {
    const isSyncingParam: Equal<Parameters<typeof isSyncing>[0], { syncLockedAt: Date | null }> = true
    const assertParam: Equal<Parameters<typeof assertNotSyncing>[0], { syncLockedAt: Date | null }> = true

    expect([isSyncingParam, assertParam]).toEqual([true, true])
  })

  it('refuses a row without the column, an explicit undefined and a partial select', () => {
    const calls = [
      // @ts-expect-error syncLockedAt is required: an absent column is not "not syncing"
      () => isSyncing({}),
      // @ts-expect-error undefined is not Date | null
      () => isSyncing({ syncLockedAt: undefined }),
      // @ts-expect-error syncLockedAt is required
      () => assertNotSyncing({}),
      // @ts-expect-error undefined is not Date | null
      () => assertNotSyncing({ syncLockedAt: undefined }),
      // @ts-expect-error a row cut down by a partial select has no syncLockedAt
      () => isSyncing({ id: 'upload-1', status: 'REVIEW' } satisfies Pick<AttendanceUpload, 'id' | 'status'>),
      // @ts-expect-error a string is not a Date
      () => isSyncing({ syncLockedAt: '2026-11-12T07:59:00Z' }),
    ]

    expect(calls).toHaveLength(6) // never invoked: the point is that none of them compiles
  })

  it('accepts what the services pass: a null lock, a Date, a full upload row and a locked-row result', () => {
    const upload = { syncLockedAt: null } as AttendanceUpload
    const locked: LockedWeekRow = {
      id: 'upload-1',
      source: 'ETIMEOFFICE',
      status: 'REVIEW',
      syncLockedAt: new Date(NOW.getTime() - 1000),
      approvedAt: null,
      payrollWeekStartDate: new Date('2026-11-05T00:00:00Z'),
    }

    expect(isSyncing({ syncLockedAt: null }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - 1000) }, NOW)).toBe(true)
    expect(isSyncing(upload, NOW)).toBe(false)
    expect(isSyncing(locked, NOW)).toBe(true)
    expect(() => assertNotSyncing(upload, NOW)).not.toThrow()
    expect(() => assertNotSyncing(locked, NOW)).toThrow(expect.objectContaining({ code: 'SYNC_IN_PROGRESS' }))
  })
})

describe('a row that is missing the column does not pass the guard silently', () => {
  // These rows only exist through a cast; the types above stop them at compile time.
  const noColumn = { id: 'upload-1', status: 'REVIEW' } as unknown as { syncLockedAt: Date | null }
  const explicitUndefined = { syncLockedAt: undefined } as unknown as { syncLockedAt: Date | null }

  const outcome = (run: () => unknown) => {
    try {
      return run()
    } catch {
      return 'threw'
    }
  }

  it.each([
    ['a row without the column', noColumn],
    ['an explicit undefined', explicitUndefined],
  ])('isSyncing does not answer "not syncing" for %s', (_label, row) => {
    expect(outcome(() => isSyncing(row, NOW))).not.toBe(false)
  })

  it.each([
    ['a row without the column', noColumn],
    ['an explicit undefined', explicitUndefined],
  ])('assertNotSyncing does not let %s through', (_label, row) => {
    expect(() => assertNotSyncing(row, NOW)).toThrow()
  })

  it('a null lock is the one way to say "not syncing", and an old lock is not a lock either', () => {
    expect(isSyncing({ syncLockedAt: null }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS) }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS + 1) }, NOW)).toBe(true)
  })
})
