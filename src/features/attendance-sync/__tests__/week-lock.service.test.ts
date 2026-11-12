// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import {
  assertNotSyncing,
  isSyncing,
  lockWeekRow,
  SYNC_IN_PROGRESS_MESSAGE,
} from '@/features/attendance-sync/services/week-lock.service'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'

// Fix round, shared design: every writer of a week takes `SELECT ... FOR UPDATE` on the week's
// AttendanceUpload row first, inside its interactive transaction. These tests pin the SQL, the
// row mapping and the TTL rule; the services that use it are tested where they live.

type QueryCall = { sql: string; values: unknown[] }

/** A transaction client whose `$queryRaw` records the tagged-template call and answers with `rows`. */
function txReturning(rows: unknown[]) {
  const calls: QueryCall[] = []
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return rows
  })
  return { tx: { $queryRaw } as never, calls, $queryRaw }
}

const ROW = {
  id: 'upload-1',
  source: 'ETIMEOFFICE',
  status: 'REVIEW',
  syncLockedAt: null,
  approvedAt: null,
  payrollWeekStartDate: new Date('2026-11-05T00:00:00Z'),
}

afterEach(() => vi.useRealTimers())

describe('lockWeekRow', () => {
  it('locks by id: one SELECT ... FOR UPDATE on the row, with the id as the only parameter', async () => {
    const { tx, calls } = txReturning([ROW])

    await lockWeekRow(tx, { id: 'upload-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe(
      'SELECT id, source, status, "syncLockedAt", "approvedAt", "payrollWeekStartDate" FROM "AttendanceUpload" WHERE id = ? FOR UPDATE',
    )
    expect(calls[0].values).toEqual(['upload-1'])
  })

  it('locks by week: the newest active row of that Thursday, FOR UPDATE, week start as the only parameter', async () => {
    const { tx, calls } = txReturning([ROW])
    const weekStart = new Date('2026-11-05T00:00:00Z')

    await lockWeekRow(tx, { weekStart })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe(
      'SELECT id, source, status, "syncLockedAt", "approvedAt", "payrollWeekStartDate" FROM "AttendanceUpload" ' +
        'WHERE "payrollWeekStartDate" = ? AND "isActiveForPayrollWeek" = true ORDER BY "uploadedAt" DESC LIMIT 1 FOR UPDATE',
    )
    expect(calls[0].values).toEqual([weekStart])
  })

  it('returns the row as a LockedWeekRow', async () => {
    const approvedAt = new Date('2026-11-12T08:00:00Z')
    const syncLockedAt = new Date('2026-11-12T08:01:00Z')
    const { tx } = txReturning([{ ...ROW, status: 'APPROVED', approvedAt, syncLockedAt }])

    await expect(lockWeekRow(tx, { id: 'upload-1' })).resolves.toEqual({
      id: 'upload-1',
      source: 'ETIMEOFFICE',
      status: 'APPROVED',
      syncLockedAt,
      approvedAt,
      payrollWeekStartDate: new Date('2026-11-05T00:00:00Z'),
    })
  })

  it('returns null when there is no (active) row', async () => {
    const { tx } = txReturning([])

    await expect(lockWeekRow(tx, { id: 'gone' })).resolves.toBeNull()
    await expect(lockWeekRow(tx, { weekStart: new Date('2026-11-05T00:00:00Z') })).resolves.toBeNull()
  })

  it('turns date columns that come back as strings into Dates, and keeps null as null', async () => {
    const { tx } = txReturning([
      {
        ...ROW,
        syncLockedAt: '2026-11-12T08:01:00.000Z',
        approvedAt: '2026-11-12T08:00:00.000Z',
        payrollWeekStartDate: '2026-11-05T00:00:00.000Z',
      },
    ])
    const mapped = (await lockWeekRow(tx, { id: 'upload-1' }))!
    expect(mapped.syncLockedAt).toBeInstanceOf(Date)
    expect(mapped.syncLockedAt!.toISOString()).toBe('2026-11-12T08:01:00.000Z')
    expect(mapped.approvedAt).toBeInstanceOf(Date)
    expect(mapped.payrollWeekStartDate).toBeInstanceOf(Date)
    expect(mapped.payrollWeekStartDate.toISOString()).toBe('2026-11-05T00:00:00.000Z')

    const { tx: txNulls } = txReturning([{ ...ROW, syncLockedAt: null, approvedAt: null }])
    const nulls = (await lockWeekRow(txNulls, { id: 'upload-1' }))!
    expect(nulls.syncLockedAt).toBeNull()
    expect(nulls.approvedAt).toBeNull()
  })

  it('uses only the client it is given (it never reaches for the global Prisma client)', async () => {
    const { tx, $queryRaw } = txReturning([ROW])
    await lockWeekRow(tx, { id: 'upload-1' })
    expect($queryRaw).toHaveBeenCalledTimes(1)
  })
})

describe('isSyncing', () => {
  const NOW = new Date('2026-11-12T08:00:00Z')

  it('is false when the week has no sync lock', () => {
    expect(isSyncing({ syncLockedAt: null }, NOW)).toBe(false)
  })

  it('is true while the lock is younger than SYNC_LOCK_TTL_MS', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - 1000) }, NOW)).toBe(true)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - (SYNC_LOCK_TTL_MS - 1)) }, NOW)).toBe(true)
  })

  it('is false once the lock is exactly TTL old or older (the lock can be taken over)', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS) }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS - 1) }, NOW)).toBe(false)
  })

  it('defaults `now` to the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - 60_000) })).toBe(true)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS - 60_000) })).toBe(false)
  })

  it('a lock in the future (clock skew) counts as syncing', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() + 5000) }, NOW)).toBe(true)
  })
})

// ─── Structure: the lock is only ever taken on a transaction client ───────────

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

describe('callers of lockWeekRow', () => {
  const SRC = path.resolve(__dirname, '../../..')
  const callers = sourceFiles(SRC).filter((file) => {
    if (file.endsWith(`${path.sep}week-lock.service.ts`)) return false
    return /\blockWeekRow\(/.test(readFileSync(file, 'utf8'))
  })

  it('exist in the writers of a week (edit, approve, reopen, pull, payroll approve, revision approve)', () => {
    const names = callers.map((file) => path.basename(file)).sort()
    expect(names).toEqual(
      expect.arrayContaining([
        'correction.service.ts',
        'payroll.service.ts',
        'punch-review.service.ts',
        'sync.service.ts',
        'week-approval.service.ts',
      ]),
    )
  })

  it('always pass the transaction client `tx` (a lock outside a transaction would be released at once)', () => {
    for (const file of callers) {
      const text = readFileSync(file, 'utf8')
      const calls = [...text.matchAll(/\blockWeekRow\(([^,)]*)/g)].map((m) => m[1].trim())
      expect(calls.length, file).toBeGreaterThan(0)
      for (const first of calls) expect(first, `${path.basename(file)} calls lockWeekRow(${first}, ...)`).toBe('tx')
    }
  })
})

// ─── Fix round 3, item 9: one place builds SYNC_IN_PROGRESS ───────────────────

describe('SYNC_IN_PROGRESS_MESSAGE', () => {
  it('is the copy the writers have always shown', () => {
    expect(SYNC_IN_PROGRESS_MESSAGE).toBe('A pull is running for this week. Wait for it to finish, then try again.')
  })
})

describe('assertNotSyncing', () => {
  const NOW = new Date('2026-11-12T08:00:00Z')
  const lockedFor = (ms: number) => ({ syncLockedAt: new Date(NOW.getTime() - ms) })

  it('throws an AttendanceSyncError SYNC_IN_PROGRESS carrying SYNC_IN_PROGRESS_MESSAGE while a fresh lock is held', () => {
    let thrown: unknown
    try {
      assertNotSyncing(lockedFor(1000), NOW)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AttendanceSyncError)
    expect(thrown).toMatchObject({
      name: 'AttendanceSyncError',
      code: 'SYNC_IN_PROGRESS',
      message: SYNC_IN_PROGRESS_MESSAGE,
    })
  })

  it('returns nothing and does not throw when no pull holds the week', () => {
    expect(assertNotSyncing({ syncLockedAt: null }, NOW)).toBeUndefined()
  })

  it('still throws one millisecond before the lock reaches the TTL', () => {
    expect(() => assertNotSyncing(lockedFor(SYNC_LOCK_TTL_MS - 1), NOW)).toThrow(SYNC_IN_PROGRESS_MESSAGE)
  })

  it('returns for a lock exactly TTL old and for an older one (a stale lock can be taken over)', () => {
    expect(() => assertNotSyncing(lockedFor(SYNC_LOCK_TTL_MS), NOW)).not.toThrow()
    expect(() => assertNotSyncing(lockedFor(SYNC_LOCK_TTL_MS + 1), NOW)).not.toThrow()
    expect(() => assertNotSyncing(lockedFor(60 * 60 * 1000), NOW)).not.toThrow()
  })

  it('honours the `now` it is given: the same lock refuses at one instant and passes at a later one', () => {
    const row = { syncLockedAt: new Date('2026-11-12T08:00:00Z') }

    expect(() => assertNotSyncing(row, new Date('2026-11-12T08:01:00Z'))).toThrow(SYNC_IN_PROGRESS_MESSAGE)
    expect(() => assertNotSyncing(row, new Date(row.syncLockedAt.getTime() + SYNC_LOCK_TTL_MS))).not.toThrow()
  })

  it('defaults `now` to the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    expect(() => assertNotSyncing({ syncLockedAt: new Date(NOW.getTime() - 60_000) })).toThrow(SYNC_IN_PROGRESS_MESSAGE)
    expect(() => assertNotSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS - 60_000) })).not.toThrow()
  })

  it('a lock in the future (clock skew) counts as syncing', () => {
    expect(() => assertNotSyncing({ syncLockedAt: new Date(NOW.getTime() + 5000) }, NOW)).toThrow(SYNC_IN_PROGRESS_MESSAGE)
  })

  it('throws exactly when isSyncing is true, across lock ages around the TTL', () => {
    for (const age of [0, 1, 1000, SYNC_LOCK_TTL_MS - 1, SYNC_LOCK_TTL_MS, SYNC_LOCK_TTL_MS + 1, SYNC_LOCK_TTL_MS * 10]) {
      const row = lockedFor(age)
      const throws = (() => {
        try {
          assertNotSyncing(row, NOW)
          return false
        } catch {
          return true
        }
      })()
      expect(throws, `lock age ${age} ms`).toBe(isSyncing(row, NOW))
    }
  })
})

describe('the SYNC_IN_PROGRESS copy lives in one place (item 9)', () => {
  const SRC = path.resolve(__dirname, '../../..')
  const files = sourceFiles(SRC)
  const text = (file: string) => readFileSync(file, 'utf8')
  const SERVICES = path.resolve(__dirname, '../services')
  const service = (name: string) => path.join(SERVICES, name)

  it('the full copy is written only in week-lock.service.ts (tests excluded)', () => {
    // WeekStatusBadge.tsx mentions "A pull is running for this week" in a doc comment, so match the whole sentence pair.
    const holders = files
      .filter((file) => text(file).includes('Wait for it to finish, then try again.'))
      .map((f) => path.basename(f))

    expect(holders).toEqual(['week-lock.service.ts'])
  })

  it('no writer spells the first half of the copy as a string literal either', () => {
    const literal = /['"`]A pull is running for this week/
    const holders = files.filter((file) => literal.test(text(file))).map((f) => path.basename(f))

    expect(holders).toEqual(['week-lock.service.ts'])
  })

  it.each(['employee-check.service.ts', 'punch-review.service.ts', 'week-approval.service.ts'])(
    '%s imports and calls assertNotSyncing and builds no SYNC_IN_PROGRESS error itself',
    (name) => {
      const source = text(service(name))

      expect(source).toMatch(/import\s*\{[^}]*\bassertNotSyncing\b[^}]*\}\s*from\s*'\.\/week-lock\.service'/)
      expect(source).toMatch(/\bassertNotSyncing\(/)
      expect(source).not.toContain("'SYNC_IN_PROGRESS'")
      expect(source).not.toMatch(/\bsyncInProgress\b/)
    },
  )

  it('no source file defines or calls a local syncInProgress helper any more', () => {
    const holders = files.filter((file) => /\bsyncInProgress\b/.test(text(file))).map((f) => path.basename(f))

    expect(holders).toEqual([])
  })

  it('only the shared assertion and the pull-vs-pull message in sync.service.ts construct a SYNC_IN_PROGRESS error', () => {
    const builds = /new AttendanceSyncError\(\s*'SYNC_IN_PROGRESS'/
    const holders = files.filter((file) => builds.test(text(file))).map((f) => path.basename(f)).sort()

    // week-lock builds the error for every writer; sync.service builds the different "already running" message
    // for a second pull of the same week.
    expect(holders).toEqual(['sync.service.ts', 'week-lock.service.ts'])
  })
})

// ─── Fix round 3, item 11: a strict null check, not `!= null` ─────────────────

describe('isSyncing with a null lock (item 11)', () => {
  const NOW = new Date('2026-11-12T08:00:00Z')

  it('a null syncLockedAt is not syncing', () => {
    expect(isSyncing({ syncLockedAt: null }, NOW)).toBe(false)
  })

  it('a fresh Date is syncing', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - 1000) }, NOW)).toBe(true)
  })

  it('week-lock.service.ts compares syncLockedAt strictly: `!== null`, never the loose `== null`', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/week-lock.service.ts'), 'utf8')

    expect(source).not.toMatch(/syncLockedAt\s*!=\s*null/)
    expect(source).not.toMatch(/syncLockedAt\s*==\s*null/)
    expect(source).toMatch(/syncLockedAt\s*!==\s*null/)
    expect(source).not.toMatch(/syncLockedAt\s*===\s*undefined/)
  })
})

// ─── The strict contract: the row always carries syncLockedAt (a Date or null) ─────────────────────

describe('isSyncing and assertNotSyncing keep the strict syncLockedAt contract', () => {
  const NOW = new Date('2026-11-12T08:00:00Z')

  it('a null lock is not syncing and does not throw', () => {
    expect(isSyncing({ syncLockedAt: null })).toBe(false)
    expect(() => assertNotSyncing({ syncLockedAt: null }, NOW)).not.toThrow()
  })

  it('a fresh lock still throws SYNC_IN_PROGRESS with the shared message', () => {
    const fresh = { syncLockedAt: new Date(NOW.getTime() - 1000) }

    expect(isSyncing(fresh, NOW)).toBe(true)
    let caught: unknown
    try {
      assertNotSyncing(fresh, NOW)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AttendanceSyncError)
    expect(caught).toMatchObject({ code: 'SYNC_IN_PROGRESS', message: SYNC_IN_PROGRESS_MESSAGE })
  })

  it('a lock older than the TTL does not block, and exactly the TTL old does not block either', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS - 1) }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS) }, NOW)).toBe(false)
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() - SYNC_LOCK_TTL_MS + 1) }, NOW)).toBe(true)
  })

  it('a lock dated in the future (a clock skew) still counts as running, not as absent', () => {
    expect(isSyncing({ syncLockedAt: new Date(NOW.getTime() + 60_000) }, NOW)).toBe(true)
  })

  it('week-lock.service.ts has no loose `== null` / `!= null` comparison anywhere', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/week-lock.service.ts'), 'utf8')

    expect(source).not.toMatch(/[^=!<>]==\s*null\b/)
    expect(source).not.toMatch(/!=\s*null\b/)
    expect(source).not.toMatch(/[^=!]==\s*undefined\b/)
    expect(source).not.toMatch(/!=\s*undefined\b/)
  })

  it('the parameter types require the column (checked by tsc): a row without syncLockedAt does not type-check', () => {
    // @ts-expect-error syncLockedAt is required: an absent column is not "not syncing"
    const noColumn: Parameters<typeof isSyncing>[0] = {}
    // @ts-expect-error undefined is not Date | null
    const undefinedLock: Parameters<typeof assertNotSyncing>[0] = { syncLockedAt: undefined }
    const nullLock: Parameters<typeof assertNotSyncing>[0] = { syncLockedAt: null }

    expect([noColumn, undefinedLock, nullLock]).toHaveLength(3)
  })
})
