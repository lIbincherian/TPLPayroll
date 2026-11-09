// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import { isSyncing, lockWeekRow } from '@/features/attendance-sync/services/week-lock.service'

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
