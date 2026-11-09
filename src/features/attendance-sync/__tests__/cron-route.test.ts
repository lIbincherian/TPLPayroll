// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The route must not reach the API client, the sync service or the database on a rejected
// request. Everything it could touch is mocked and asserted untouched.
const mocks = vi.hoisted(() => ({
  runScheduledSync: vi.fn(),
  fetchPunchData: vi.fn(),
  prismaAccess: vi.fn(),
}))

vi.mock('@/features/attendance-sync/services/sync.service', () => ({
  runScheduledSync: mocks.runScheduledSync,
  syncWeek: vi.fn(),
  pullNow: vi.fn(),
}))

vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({
  fetchPunchData: mocks.fetchPunchData,
  getEtimeofficeConfig: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        mocks.prismaAccess(String(prop))
        return vi.fn()
      },
    },
  ),
}))

import { GET, dynamic, maxDuration } from '@/app/api/cron/attendance-sync/route'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'

const SECRET = 'local-cron-secret'

function call(authorization?: string) {
  return GET(
    new NextRequest('http://localhost:3000/api/cron/attendance-sync', {
      headers: authorization === undefined ? {} : { authorization },
    }),
  )
}

function expectNothingTouched() {
  expect(mocks.runScheduledSync).not.toHaveBeenCalled()
  expect(mocks.fetchPunchData).not.toHaveBeenCalled()
  expect(mocks.prismaAccess).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  mocks.runScheduledSync.mockReset()
  mocks.fetchPunchData.mockReset()
  mocks.prismaAccess.mockReset()
})

describe('sync route does nothing on a rejected request (US-12.2)', () => {
  it('rejects a request with no authorization header', async () => {
    const response = await call()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
    expectNothingTouched()
  })

  it('rejects a wrong secret', async () => {
    const response = await call('Bearer not-the-secret')
    expect(response.status).toBe(401)
    expectNothingTouched()
  })

  it('rejects a secret without the Bearer scheme', async () => {
    const response = await call(SECRET)
    expect(response.status).toBe(401)
    expectNothingTouched()
  })

  it('fails closed when CRON_SECRET is not configured', async () => {
    vi.stubEnv('CRON_SECRET', undefined as unknown as string)
    const response = await call('Bearer undefined')
    expect(response.status).toBe(401)
    expectNothingTouched()
  })

  it('fails closed when CRON_SECRET is empty', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const response = await call('Bearer ')
    expect(response.status).toBe(401)
    expectNothingTouched()
  })

  it('does not reveal anything about the sync in the rejection body', async () => {
    const body = JSON.stringify(await (await call('Bearer wrong')).json())
    expect(body).not.toMatch(/outcome|week|punch|secret/i)
  })
})

describe('sync route with a valid secret', () => {
  it('runs the scheduled sync and returns its outcome', async () => {
    mocks.runScheduledSync.mockResolvedValue({ outcome: 'LOADED', punchCount: 12, discarded: null })
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, outcome: 'LOADED', punchCount: 12, discarded: null })
    expect(mocks.runScheduledSync).toHaveBeenCalledTimes(1)
  })

  it('reports a skipped week as ok', async () => {
    mocks.runScheduledSync.mockResolvedValue({ outcome: 'SKIPPED_HAS_EDITS' })
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, outcome: 'SKIPPED_HAS_EDITS' })
  })

  it('reports a failed pull in the body, still with 200 (the failure is recorded on the week)', async () => {
    mocks.runScheduledSync.mockResolvedValue({ outcome: 'FAILED', code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, outcome: 'FAILED', code: 'HTTP_STATUS' })
  })

  it('returns 200 with ok:false and the error code for an AttendanceSyncError', async () => {
    mocks.runScheduledSync.mockRejectedValue(new AttendanceSyncError('SYNC_IN_PROGRESS', 'A pull for this week is already running.'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: 'SYNC_IN_PROGRESS' })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('returns 200 with ok:false UNEXPECTED for any other error, without leaking its message', async () => {
    mocks.runScheduledSync.mockRejectedValue(new Error('database password is hunter2'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: false, error: 'UNEXPECTED' })
    expect(JSON.stringify(body)).not.toContain('hunter2')
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('route configuration', () => {
  it('is dynamic and allows 120 seconds', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(maxDuration).toBe(120)
  })
})
