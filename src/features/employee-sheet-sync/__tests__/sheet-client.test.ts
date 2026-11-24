// @vitest-environment node
import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEmployeeSheet, getSheetSourceConfig } from '../services/sheet.client'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const ESCAPED_KEY = privateKey.replace(/\n/g, '\\n')
const EMAIL = 'svc-secret@proj.iam.gserviceaccount.com'
const SHEET_ID = 'sheet-id-abc'

function live() {
  vi.stubEnv('GOOGLE_SHEETS_CLIENT_EMAIL', EMAIL)
  vi.stubEnv('GOOGLE_SHEETS_PRIVATE_KEY', ESCAPED_KEY)
  vi.stubEnv('EMPLOYEE_SHEET_ID', SHEET_ID)
}

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tkn-secret' }), { status: 200 })

function fetchSeq(...responses: Array<Response | Error>) {
  const f = vi.fn()
  for (const r of responses) {
    if (r instanceof Error) f.mockRejectedValueOnce(r)
    else f.mockResolvedValueOnce(r)
  }
  return f as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_SHEETS_CLIENT_EMAIL', '')
  vi.stubEnv('GOOGLE_SHEETS_PRIVATE_KEY', '')
  vi.stubEnv('EMPLOYEE_SHEET_ID', '')
  vi.stubEnv('EMPLOYEE_SHEET_TAB', '')
  vi.stubEnv('VERCEL', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getSheetSourceConfig', () => {
  it('FIXTURE when email unset and not on Vercel; default tab', () => {
    expect(getSheetSourceConfig()).toEqual({ mode: 'FIXTURE', tab: 'Employee Master List' })
  })
  it('UNCONFIGURED on Vercel with no credentials', () => {
    vi.stubEnv('VERCEL', '1')
    expect(getSheetSourceConfig().mode).toBe('UNCONFIGURED')
  })
  it('LIVE with full credentials; custom tab', () => {
    live()
    vi.stubEnv('EMPLOYEE_SHEET_TAB', 'Other Tab')
    expect(getSheetSourceConfig()).toEqual({ mode: 'LIVE', tab: 'Other Tab', sheetId: SHEET_ID })
  })
  it('partial credentials are UNCONFIGURED even off Vercel (never the fixture)', () => {
    vi.stubEnv('GOOGLE_SHEETS_CLIENT_EMAIL', EMAIL)
    expect(getSheetSourceConfig().mode).toBe('UNCONFIGURED')
  })
  it('email + key but no sheet id is UNCONFIGURED', () => {
    vi.stubEnv('GOOGLE_SHEETS_CLIENT_EMAIL', EMAIL)
    vi.stubEnv('GOOGLE_SHEETS_PRIVATE_KEY', ESCAPED_KEY)
    expect(getSheetSourceConfig().mode).toBe('UNCONFIGURED')
  })
  it('credentials present on Vercel are still LIVE', () => {
    live()
    vi.stubEnv('VERCEL', '1')
    expect(getSheetSourceConfig().mode).toBe('LIVE')
  })
})

describe('fetchEmployeeSheet', () => {
  it('fixture mode returns the fixture without any fetch', async () => {
    const f = vi.fn()
    const r = await fetchEmployeeSheet({ fetch: f as unknown as typeof fetch })
    expect(f).not.toHaveBeenCalled()
    expect(r.mode).toBe('FIXTURE')
    expect(r.values.header).toContain('Employee ID')
    expect(r.values.rows.length).toBeGreaterThan(0)
  })

  it('fixture returns a fresh copy each time', async () => {
    const a = await fetchEmployeeSheet()
    a.values.rows.pop()
    const b = await fetchEmployeeSheet()
    expect(b.values.rows.length).toBe(a.values.rows.length + 1)
  })

  it('unconfigured throws NOT_CONFIGURED with the spec message', async () => {
    vi.stubEnv('VERCEL', '1')
    await expect(fetchEmployeeSheet()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: "Google Sheets access isn't configured.",
    })
  })

  it('live: reads only the quoted tab with FORMATTED_VALUE and a bearer token', async () => {
    live()
    vi.stubEnv('EMPLOYEE_SHEET_TAB', "Tab's Name")
    const f = fetchSeq(tokenOk(), new Response(JSON.stringify({ values: [['Sr.', 'Employee ID'], ['1', 'X1'], ['2']] }), { status: 200 }))
    const r = await fetchEmployeeSheet({ fetch: f })
    expect(r.mode).toBe('LIVE')
    expect(r.values.header).toEqual(['Sr.', 'Employee ID'])
    expect(r.values.rows).toEqual([['1', 'X1'], ['2']])
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(url).toContain(`/spreadsheets/${SHEET_ID}/values/`)
    expect(url).toContain(encodeURIComponent("'Tab''s Name'"))
    expect(url).toContain('valueRenderOption=FORMATTED_VALUE')
    expect(url).toContain('dateTimeRenderOption=FORMATTED_STRING')
    expect(init.headers.Authorization).toBe('Bearer tkn-secret')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    [403, 'SHEET_NOT_SHARED'],
    [404, 'SHEET_NOT_FOUND'],
    [500, 'FETCH_FAILED'],
    [429, 'FETCH_FAILED'],
  ])('maps HTTP %i to %s and leaks no secrets', async (status, code) => {
    live()
    const f = fetchSeq(tokenOk(), new Response('body', { status }))
    const err = await fetchEmployeeSheet({ fetch: f }).catch((e) => e)
    expect(err.code).toBe(code)
    for (const secret of [EMAIL, 'tkn-secret', SHEET_ID, 'PRIVATE KEY']) expect(err.message).not.toContain(secret)
  })

  it('400 "Unable to parse range" maps to TAB_NOT_FOUND', async () => {
    live()
    const f = fetchSeq(tokenOk(), new Response('{"error":{"message":"Unable to parse range: Foo"}}', { status: 400 }))
    await expect(fetchEmployeeSheet({ fetch: f })).rejects.toMatchObject({ code: 'TAB_NOT_FOUND' })
  })

  it('other 400 maps to FETCH_FAILED', async () => {
    live()
    const f = fetchSeq(tokenOk(), new Response('bad', { status: 400 }))
    await expect(fetchEmployeeSheet({ fetch: f })).rejects.toMatchObject({ code: 'FETCH_FAILED' })
  })

  it('empty values array maps to EMPTY_SHEET; missing values too', async () => {
    live()
    await expect(
      fetchEmployeeSheet({ fetch: fetchSeq(tokenOk(), new Response('{"values":[]}', { status: 200 })) }),
    ).rejects.toMatchObject({ code: 'EMPTY_SHEET' })
    await expect(
      fetchEmployeeSheet({ fetch: fetchSeq(tokenOk(), new Response('{}', { status: 200 })) }),
    ).rejects.toMatchObject({ code: 'EMPTY_SHEET' })
  })

  it('network failure and timeout map to FETCH_FAILED', async () => {
    live()
    await expect(fetchEmployeeSheet({ fetch: fetchSeq(tokenOk(), new Error('boom')) })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    const err = await fetchEmployeeSheet({ fetch: fetchSeq(tokenOk(), timeout) }).catch((e) => e)
    expect(err.code).toBe('FETCH_FAILED')
    expect(err.message).toMatch(/too long/i)
  })

  it('token failure surfaces AUTH_FAILED', async () => {
    live()
    const f = fetchSeq(new Response('no', { status: 401 }))
    await expect(fetchEmployeeSheet({ fetch: f })).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('coerces numeric cells to strings', async () => {
    live()
    const f = fetchSeq(tokenOk(), new Response(JSON.stringify({ values: [['Sr.'], [1], [null]] }), { status: 200 }))
    const r = await fetchEmployeeSheet({ fetch: f })
    expect(r.values.rows).toEqual([['1'], ['']])
  })
})
