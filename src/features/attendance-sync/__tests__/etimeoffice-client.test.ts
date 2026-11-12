// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPunchData, isMockEtimeofficeEnabled } from '../services/etimeoffice.client'
import { API_FETCH_TIMEOUT_MS } from '../lib/constants'

const week = { start: '2026-11-05', end: '2026-11-11' }

const ENV_KEYS = [
  'ETIMEOFFICE_CORPORATE_ID',
  'ETIMEOFFICE_USERNAME',
  'ETIMEOFFICE_PASSWORD',
  'ETIMEOFFICE_BASE_URL',
  'NEXT_PUBLIC_APP_URL',
  'VERCEL',
] as const

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) vi.stubEnv(key, values[key] as string)
}

const LIVE_ENV = {
  ETIMEOFFICE_CORPORATE_ID: 'corp-secret-id',
  ETIMEOFFICE_USERNAME: 'user-secret-name',
  ETIMEOFFICE_PASSWORD: 'pass-secret-word',
}

const goodBody = {
  Error: false,
  Msg: 'Success',
  PunchData: [
    { Name: 'Empname0036', Empcode: '0036', PunchDate: '05/11/2026 07:40:00', M_Flag: '', mcid: '1' },
    { Name: 'Empname0036', Empcode: '0036', PunchDate: '05/11/2026 17:47:00', M_Flag: '', mcid: '1' },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

beforeEach(() => {
  // Start every test from a clean slate; individual tests set what they need.
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined as unknown as string)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// The login is read by one module-private function, so the configuration is checked through what it decides:
// where fetchPunchData sends the request, with or without the Authorization header, or that it sends none.
async function sendRequest() {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
  const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
  const [url, init] = (fetchMock.mock.calls[0] ?? []) as [string | undefined, { headers: Record<string, string> } | undefined]
  return { result, fetchMock, url, headers: init?.headers }
}

describe('configuration (through fetchPunchData)', () => {
  it('is LIVE when the full login is set: the default base URL, with the Authorization header', async () => {
    setEnv(LIVE_ENV)
    const { url, headers } = await sendRequest()
    expect(url?.startsWith('https://api.etimeoffice.com/api/')).toBe(true)
    expect(headers?.Authorization).toBe(
      'Basic ' + Buffer.from('corp-secret-id:user-secret-name:pass-secret-word:True').toString('base64'),
    )
    expect(isMockEtimeofficeEnabled()).toBe(false)
  })

  it('uses ETIMEOFFICE_BASE_URL when set', async () => {
    setEnv({ ...LIVE_ENV, ETIMEOFFICE_BASE_URL: 'https://example.test/api/' })
    const { url, headers } = await sendRequest()
    expect(url?.startsWith('https://example.test/api/')).toBe(true)
    expect(headers?.Authorization).toBeDefined()
  })

  it('is LIVE even on Vercel when the login is complete', async () => {
    setEnv({ ...LIVE_ENV, VERCEL: '1' })
    const { result, headers } = await sendRequest()
    expect(result.ok).toBe(true)
    expect(headers?.Authorization).toBeDefined()
  })

  it('is MOCK locally when the corporate id is unset, using NEXT_PUBLIC_APP_URL, with no Authorization header', async () => {
    setEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3100' })
    const { url, headers } = await sendRequest()
    expect(url?.startsWith('http://localhost:3100/api/mock-etimeoffice/')).toBe(true)
    expect(headers).not.toHaveProperty('Authorization')
    expect(isMockEtimeofficeEnabled()).toBe(true)
  })

  it('defaults the mock base URL to http://localhost:3000', async () => {
    setEnv({})
    const { url } = await sendRequest()
    expect(url?.startsWith('http://localhost:3000/api/mock-etimeoffice/')).toBe(true)
    expect(isMockEtimeofficeEnabled()).toBe(true)
  })

  it('is MISSING on Vercel without a login: no request, and production never falls back to the mock', async () => {
    setEnv({ VERCEL: '1' })
    const { result, fetchMock } = await sendRequest()
    expect(result).toEqual({ ok: false, code: 'CONFIG_MISSING', message: "eTimeOffice login isn't configured." })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(isMockEtimeofficeEnabled()).toBe(false)
  })

  it('is MISSING when the corporate id is set but the username or password is not', async () => {
    setEnv({ ETIMEOFFICE_CORPORATE_ID: 'corp', ETIMEOFFICE_USERNAME: 'user' })
    expect((await sendRequest()).result).toMatchObject({ ok: false, code: 'CONFIG_MISSING' })
    setEnv({ ETIMEOFFICE_CORPORATE_ID: 'corp', ETIMEOFFICE_PASSWORD: 'pass' })
    expect((await sendRequest()).result).toMatchObject({ ok: false, code: 'CONFIG_MISSING' })
    expect(isMockEtimeofficeEnabled()).toBe(false)
  })

  it('treats empty strings as unset', async () => {
    setEnv({ ETIMEOFFICE_CORPORATE_ID: '', ETIMEOFFICE_USERNAME: '', ETIMEOFFICE_PASSWORD: '', VERCEL: '1' })
    const { result, fetchMock } = await sendRequest()
    expect(result).toMatchObject({ ok: false, code: 'CONFIG_MISSING' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchPunchData: configuration', () => {
  it('returns CONFIG_MISSING and makes no request when the login is not configured on Vercel', async () => {
    setEnv({ VERCEL: '1' })
    const fetchMock = vi.fn()
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, code: 'CONFIG_MISSING', message: "eTimeOffice login isn't configured." })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchPunchData: LIVE mode', () => {
  beforeEach(() => setEnv(LIVE_ENV))

  it('requests DownloadPunchDataMCID for the whole week with Basic auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
    await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin + parsed.pathname).toBe('https://api.etimeoffice.com/api/DownloadPunchDataMCID')
    expect(parsed.searchParams.get('Empcode')).toBe('ALL')
    expect(parsed.searchParams.get('FromDate')).toBe('05/11/2026_00:00')
    expect(parsed.searchParams.get('ToDate')).toBe('11/11/2026_23:59')
    expect(init.method).toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers.Authorization).toBe(
      'Basic ' + Buffer.from('corp-secret-id:user-secret-name:pass-secret-word:True').toString('base64'),
    )
  })

  it('returns the parsed punches on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({
      ok: true,
      punches: [
        { empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time: '07:40', mcid: '1' },
        { empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time: '17:47', mcid: '1' },
      ],
    })
  })

  it('fails with HTTP_STATUS on a non-200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('Server exploded', 500))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })
  })

  it('fails with API_ERROR when Error is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Error: true, Msg: 'Bad login' }))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, code: 'API_ERROR', message: 'eTimeOffice reported an error: Bad login' })
  })

  it('fails with EMPTY when there are no punches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Error: false, Msg: 'Success', PunchData: [] }))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false, code: 'EMPTY' })
  })

  it('fails with UNPARSEABLE on an HTML body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('<html>gateway</html>'))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false, code: 'UNPARSEABLE' })
  })

  it('fails with NETWORK when fetch throws, without echoing the error text', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError('connect ECONNREFUSED https://api.etimeoffice.com Authorization: Basic abc123'))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, code: 'NETWORK', message: "Couldn't reach eTimeOffice." })
  })

  it('fails with NETWORK when reading the body throws', async () => {
    const broken = { status: 200, text: () => Promise.reject(new Error('stream reset')) }
    const fetchMock = vi.fn().mockResolvedValue(broken)
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false, code: 'NETWORK' })
  })

  it('treats a TimeoutError like a timeout', async () => {
    const error = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const fetchMock = vi.fn().mockRejectedValue(error)
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' })
  })

  it('never puts the login, the header or the base URL in a result, success or failure', async () => {
    const scenarios: Array<() => Promise<Response>> = [
      () => Promise.resolve(jsonResponse(goodBody)),
      () => Promise.resolve(jsonResponse('boom corp-secret-id user-secret-name pass-secret-word', 500)),
      () => Promise.resolve(jsonResponse({ Error: true, Msg: 'rejected' })),
      () => Promise.reject(new Error('corp-secret-id pass-secret-word')),
    ]
    for (const scenario of scenarios) {
      const result = await fetchPunchData(week, { fetch: vi.fn(scenario) as unknown as typeof fetch })
      const text = JSON.stringify(result)
      for (const secret of ['corp-secret-id', 'user-secret-name', 'pass-secret-word', 'Basic ', 'api.etimeoffice.com']) {
        expect(text).not.toContain(secret)
      }
    }
  })

  it('does not log the login or the Authorization header', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ]
    await fetchPunchData(week, { fetch: vi.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch })
    await fetchPunchData(week, { fetch: vi.fn().mockResolvedValue(jsonResponse(goodBody)) as unknown as typeof fetch })
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    for (const secret of ['corp-secret-id', 'user-secret-name', 'pass-secret-word', 'Basic ']) {
      expect(logged).not.toContain(secret)
    }
  })

  it('uses globalThis.fetch when no dependency is injected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await fetchPunchData(week)
      expect(result.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('fetchPunchData: MOCK mode', () => {
  it('calls the in-app mock without an Authorization header', async () => {
    setEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3100' })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0]
    expect((url as string).startsWith('http://localhost:3100/api/mock-etimeoffice/DownloadPunchDataMCID?')).toBe(true)
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.headers.Accept).toBe('application/json')
  })
})

describe('fetchPunchData: timeout', () => {
  /** A fetch that never answers; it rejects with an AbortError when the signal aborts. */
  function hangingFetch() {
    return vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        })
      }),
    )
  }

  beforeEach(() => {
    setEnv(LIVE_ENV)
    vi.useFakeTimers()
  })

  it('aborts after 45 seconds and returns TIMEOUT', async () => {
    expect(API_FETCH_TIMEOUT_MS).toBe(45000)
    const fetchMock = hangingFetch()
    let settled = false
    const promise = fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch }).then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(API_FETCH_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await promise
    expect(result).toEqual({ ok: false, code: 'TIMEOUT', message: "eTimeOffice didn't answer in time." })
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('clears the timer after a successful response so nothing aborts later', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(goodBody))
    const result = await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(result.ok).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer after a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await fetchPunchData(week, { fetch: fetchMock as unknown as typeof fetch })
    expect(vi.getTimerCount()).toBe(0)
  })
})
