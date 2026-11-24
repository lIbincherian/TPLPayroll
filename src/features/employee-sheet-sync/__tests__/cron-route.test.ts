// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ runScheduledSheetSync: vi.fn() }))
vi.mock('@/features/employee-sheet-sync/services/sync.service', () => ({
  runScheduledSheetSync: mocks.runScheduledSheetSync,
}))

import { GET, dynamic, maxDuration } from '@/app/api/cron/employee-sheet-sync/route'
import { SheetSyncError } from '@/features/employee-sheet-sync/types/employee-sheet-sync.types'
import vercel from '../../../../vercel.json'

const SECRET = 'local-cron-secret'
const call = (authorization?: string) =>
  GET(
    new NextRequest('http://localhost:3000/api/cron/employee-sheet-sync', {
      headers: authorization === undefined ? {} : { authorization },
    }),
  )

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('employee-sheet-sync cron route', () => {
  it('is dynamic with a 120s budget', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(maxDuration).toBe(120)
  })

  it.each([
    ['no header', undefined],
    ['wrong secret', 'Bearer nope'],
    ['no Bearer prefix', SECRET],
    ['empty', ''],
  ])('401 and no sync on %s', async (_l, header) => {
    const res = await call(header)
    expect(res.status).toBe(401)
    expect(mocks.runScheduledSheetSync).not.toHaveBeenCalled()
  })

  it('401 for every request when CRON_SECRET is unset', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await call('Bearer ')).status).toBe(401)
    expect((await call('Bearer undefined')).status).toBe(401)
    expect(mocks.runScheduledSheetSync).not.toHaveBeenCalled()
  })

  it('200 with the skip reason', async () => {
    mocks.runScheduledSheetSync.mockResolvedValue({ skipped: 'DISABLED' })
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, skipped: 'DISABLED' })
  })

  it('200 with the run counts', async () => {
    mocks.runScheduledSheetSync.mockResolvedValue({ runId: 'r', created: 1, updated: 2, skipped: 3 })
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, runId: 'r', created: 1, updated: 2, skipped: 3 })
  })

  it('returns 200 {ok:false, error: code} for a SheetSyncError', async () => {
    mocks.runScheduledSheetSync.mockRejectedValue(new SheetSyncError('SHEET_NOT_SHARED', 'private message'))
    const res = await call(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'SHEET_NOT_SHARED' })
  })

  it('returns UNEXPECTED without leaking the message', async () => {
    mocks.runScheduledSheetSync.mockRejectedValue(new Error('secret'))
    const body = await (await call(`Bearer ${SECRET}`)).json()
    expect(body).toEqual({ ok: false, error: 'UNEXPECTED' })
  })

  it('is scheduled in vercel.json at 30 23 * * *', () => {
    expect(vercel.crons).toContainEqual({ path: '/api/cron/employee-sheet-sync', schedule: '30 23 * * *' })
  })
})
