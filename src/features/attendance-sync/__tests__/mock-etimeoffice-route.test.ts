// @vitest-environment node
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/mock-etimeoffice/DownloadPunchDataMCID/route'
import { classifySyncResponse } from '../lib/etimeoffice/parser'
import { buildPunchRequestParams, buildPunchRequestUrl } from '../lib/etimeoffice/request'

// The route reads a scenario file from the OS temp directory. Tests never touch the real
// file (e2e runs share it): fs.readFileSync is intercepted for that one path only.
const SCENARIO_PATH = path.join(os.tmpdir(), 'tpl-payroll-mock-etimeoffice', 'scenario.json')
const realReadFileSync = fs.readFileSync.bind(fs)

let scenario: string | null = null
let scenarioReads: string[] = []

function request(week = { start: '2026-11-05', end: '2026-11-11' }) {
  const url = buildPunchRequestUrl('http://localhost:3000/api/mock-etimeoffice/', buildPunchRequestParams(week))
  return new NextRequest(url)
}

beforeEach(() => {
  scenario = null
  scenarioReads = []
  vi.stubEnv('ETIMEOFFICE_CORPORATE_ID', undefined as unknown as string)
  vi.stubEnv('VERCEL', undefined as unknown as string)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file) === SCENARIO_PATH) {
      scenarioReads.push(String(file))
      if (scenario === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return scenario
    }
    return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof fs.readFileSync)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mock eTimeOffice route: gate', () => {
  it('returns 403 when a real corporate id is configured', async () => {
    vi.stubEnv('ETIMEOFFICE_CORPORATE_ID', 'real-corp')
    const response = await GET(request())
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('Mock eTimeOffice disabled')
  })

  it('returns 403 on Vercel', async () => {
    vi.stubEnv('VERCEL', '1')
    expect((await GET(request())).status).toBe(403)
  })

  it('does not read the scenario file when disabled', async () => {
    vi.stubEnv('ETIMEOFFICE_CORPORATE_ID', 'real-corp')
    scenario = JSON.stringify({ status: 200, body: { Error: false } })
    await GET(request())
    expect(scenarioReads).toEqual([])
  })
})

describe('mock eTimeOffice route: default scenario', () => {
  beforeEach(() => {
    // Sunday 8 Nov 2026, 10:30 IST: days up to the 8th have happened.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-08T05:00:00Z'))
  })

  it('returns three employees with four punches on every day up to today', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ Error: false, Msg: 'Success' })
    // 5, 6, 7, 8 Nov x 3 codes x 4 punches
    expect(body.PunchData).toHaveLength(4 * 3 * 4)
    expect(new Set(body.PunchData.map((p: { Empcode: string }) => p.Empcode))).toEqual(new Set(['0001', '0002', '0003']))
    expect(body.PunchData[0]).toEqual({
      Name: 'Empname0001',
      Empcode: '0001',
      PunchDate: '05/11/2026 07:40:00',
      M_Flag: '',
      mcid: '1',
    })
    const day = body.PunchData
      .filter((p: { Empcode: string; PunchDate: string }) => p.Empcode === '0002' && p.PunchDate.startsWith('06/11/2026'))
      .map((p: { PunchDate: string }) => p.PunchDate.slice(11, 16))
    expect(day).toEqual(['07:40', '13:04', '13:56', '17:47'])
  })

  it('never returns days after today', async () => {
    const body = await (await GET(request())).json()
    const dates = new Set(body.PunchData.map((p: { PunchDate: string }) => p.PunchDate.slice(0, 10)))
    expect(dates).toEqual(new Set(['05/11/2026', '06/11/2026', '07/11/2026', '08/11/2026']))
  })

  it('stays inside the requested range', async () => {
    const body = await (await GET(request({ start: '2026-11-06', end: '2026-11-07' }))).json()
    const dates = new Set(body.PunchData.map((p: { PunchDate: string }) => p.PunchDate.slice(0, 10)))
    expect(dates).toEqual(new Set(['06/11/2026', '07/11/2026']))
  })

  it('returns no punches for a week that has not started', async () => {
    const body = await (await GET(request({ start: '2026-11-12', end: '2026-11-18' }))).json()
    expect(body).toMatchObject({ Error: false, PunchData: [] })
    expect(classifySyncResponse({ status: 200, bodyText: JSON.stringify(body) })).toMatchObject({ ok: false, code: 'EMPTY' })
  })

  it('produces a body the sync parser accepts', async () => {
    const text = await (await GET(request())).text()
    const result = classifySyncResponse({ status: 200, bodyText: text })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.punches).toHaveLength(48)
  })

  it('rejects a request without valid dates', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/mock-etimeoffice/DownloadPunchDataMCID?Empcode=ALL'))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ Error: true, Msg: 'Invalid FromDate or ToDate' })
  })

  it('rejects a malformed date', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/mock-etimeoffice/DownloadPunchDataMCID?FromDate=2026-11-05&ToDate=2026-11-11'),
    )
    expect(response.status).toBe(400)
  })
})

describe('mock eTimeOffice route: scenario file', () => {
  it('reads scenario.json from the OS temp directory', async () => {
    await GET(request())
    expect(scenarioReads).toEqual([SCENARIO_PATH])
    expect(SCENARIO_PATH.endsWith(path.join('tpl-payroll-mock-etimeoffice', 'scenario.json'))).toBe(true)
  })

  it('returns the scenario status and JSON body', async () => {
    scenario = JSON.stringify({ status: 500, body: { Error: true, Msg: 'Boom' } })
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ Error: true, Msg: 'Boom' })
  })

  it('returns a string body as-is, so a scenario can serve unparseable text', async () => {
    scenario = JSON.stringify({ status: 200, body: '<html>not json</html>' })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<html>not json</html>')
  })

  it('serves a scenario with punches that the sync parser accepts', async () => {
    scenario = JSON.stringify({
      status: 200,
      body: {
        Error: false,
        Msg: 'Success',
        PunchData: [{ Name: 'Empname0999', Empcode: '0999', PunchDate: '06/11/2026 18:26:00', M_Flag: '', mcid: '1' }],
      },
    })
    const text = await (await GET(request())).text()
    expect(classifySyncResponse({ status: 200, bodyText: text })).toEqual({
      ok: true,
      punches: [{ empCode: '0999', empName: 'Empname0999', date: '2026-11-06', time: '18:26', mcid: '1' }],
    })
  })

  it('serves an empty scenario body (Error false, no punches)', async () => {
    scenario = JSON.stringify({ status: 200, body: { Error: false, Msg: 'Success', PunchData: [] } })
    const text = await (await GET(request())).text()
    expect(classifySyncResponse({ status: 200, bodyText: text })).toMatchObject({ ok: false, code: 'EMPTY' })
  })

  it('waits delayMs before answering', async () => {
    vi.useFakeTimers()
    scenario = JSON.stringify({ status: 200, body: { Error: false, PunchData: [] }, delayMs: 5000 })
    let done = false
    const promise = GET(request()).then((r) => {
      done = true
      return r
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await promise).status).toBe(200)
    expect(done).toBe(true)
  })

  it('falls back to the default scenario when the file is not valid JSON', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-08T05:00:00Z'))
    scenario = '{ not json'
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect((await response.json()).PunchData.length).toBeGreaterThan(0)
  })
})
