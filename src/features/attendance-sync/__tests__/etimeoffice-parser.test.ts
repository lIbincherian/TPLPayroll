import { describe, it, expect } from 'vitest'
import {
  classifySyncResponse,
  parsePunchDate,
  parsePunchResponse,
  SYNC_FAILURE_COPY,
} from '../lib/etimeoffice/parser'

const row = (overrides: Record<string, unknown> = {}) => ({
  Name: 'Empname0036',
  Empcode: '0036',
  PunchDate: '05/11/2026 07:40:00',
  M_Flag: '',
  mcid: '1',
  ...overrides,
})

const okBody = (rows: unknown[] = [row()], extra: Record<string, unknown> = {}) => ({
  Error: false,
  Msg: 'Success',
  IsAdmin: true,
  PunchData: rows,
  ...extra,
})

describe('parsePunchDate (US-12.3)', () => {
  it('keeps the wall-clock time and drops seconds', () => {
    expect(parsePunchDate('05/11/2026 07:40:00')).toEqual({ date: '2026-11-05', time: '07:40' })
  })

  it('does not change with the server timezone', () => {
    const original = process.env.TZ
    try {
      for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = tz
        expect(parsePunchDate('05/11/2026 07:40:59')).toEqual({ date: '2026-11-05', time: '07:40' })
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })

  it('accepts a value without seconds', () => {
    expect(parsePunchDate('05/11/2026 17:47')).toEqual({ date: '2026-11-05', time: '17:47' })
  })

  it('accepts midnight and 23:59', () => {
    expect(parsePunchDate('11/11/2026 00:00:00')).toEqual({ date: '2026-11-11', time: '00:00' })
    expect(parsePunchDate('11/11/2026 23:59:59')).toEqual({ date: '2026-11-11', time: '23:59' })
  })

  it('reads dd/MM/yyyy (day first)', () => {
    expect(parsePunchDate('12/11/2026 08:00:00')).toEqual({ date: '2026-11-12', time: '08:00' })
  })

  it.each([
    ['an ISO date', '2026-11-05 07:40:00'],
    ['a one-digit day', '5/11/2026 07:40:00'],
    ['a missing time', '05/11/2026'],
    ['a T separator', '05/11/2026T07:40:00'],
    ['hour 24', '05/11/2026 24:00:00'],
    ['minute 60', '05/11/2026 07:60:00'],
    ['a non-existent date', '31/02/2026 07:40:00'],
    ['month 13', '05/13/2026 07:40:00'],
    ['an empty string', ''],
    ['garbage', 'not a date'],
  ])('rejects %s', (_label, value) => {
    expect(parsePunchDate(value)).toBeNull()
  })
})

describe('parsePunchResponse', () => {
  it('parses rows into punches', () => {
    const result = parsePunchResponse(okBody([row(), row({ Empcode: '0001', Name: 'Other', PunchDate: '06/11/2026 08:00:00', mcid: 7 })]))
    expect(result).toEqual({
      ok: true,
      error: false,
      msg: 'Success',
      punches: [
        { empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time: '07:40', mcid: '1' },
        { empCode: '0001', empName: 'Other', date: '2026-11-06', time: '08:00', mcid: '7' },
      ],
    })
  })

  it('ignores vendor hour values: the parsed punch has no overtime or work time (US-12.3)', () => {
    const result = parsePunchResponse(okBody([row({ OverTime: '05:00', WorkTime: '12:00' })]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.punches[0]).sort()).toEqual(['date', 'empCode', 'empName', 'mcid', 'time'])
      expect(JSON.stringify(result.punches[0])).not.toMatch(/05:00|12:00|OverTime|WorkTime/)
    }
  })

  it('trims Empcode', () => {
    const result = parsePunchResponse(okBody([row({ Empcode: '  0036  ' })]))
    expect(result.ok && result.punches[0].empCode).toBe('0036')
  })

  it('maps a missing or blank name to null', () => {
    const noName = parsePunchResponse(okBody([row({ Name: undefined })]))
    const blank = parsePunchResponse(okBody([row({ Name: '   ' })]))
    expect(noName.ok && noName.punches[0].empName).toBeNull()
    expect(blank.ok && blank.punches[0].empName).toBeNull()
  })

  it('maps a missing mcid to null and stringifies a numeric mcid', () => {
    const none = parsePunchResponse(okBody([row({ mcid: undefined })]))
    const nul = parsePunchResponse(okBody([row({ mcid: null })]))
    const num = parsePunchResponse(okBody([row({ mcid: 12 })]))
    expect(none.ok && none.punches[0].mcid).toBeNull()
    expect(nul.ok && nul.punches[0].mcid).toBeNull()
    expect(num.ok && num.punches[0].mcid).toBe('12')
  })

  it('accepts a null or missing PunchData as no punches', () => {
    expect(parsePunchResponse({ Error: false, Msg: 'Success', PunchData: null })).toMatchObject({ ok: true, punches: [] })
    expect(parsePunchResponse({ Error: false })).toMatchObject({ ok: true, punches: [] })
  })

  it('returns the Msg and error flag when Error is true, without reading rows', () => {
    const result = parsePunchResponse({ Error: true, Msg: ' Invalid credentials ', PunchData: [row({ PunchDate: 'bad' })] })
    expect(result).toEqual({ ok: true, punches: [], msg: 'Invalid credentials', error: true })
  })

  it('treats a blank Msg as null', () => {
    expect(parsePunchResponse({ Error: true, Msg: '   ' })).toMatchObject({ msg: null, error: true })
  })

  it('passes through unknown top-level fields without failing', () => {
    expect(parsePunchResponse({ Error: false, SomethingNew: 1, PunchData: [row({ Extra: 'x' })] }).ok).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an array', []],
    ['a missing Error flag', { PunchData: [] }],
    ['a non-boolean Error', { Error: 'false', PunchData: [] }],
    ['a non-array PunchData', { Error: false, PunchData: 'x' }],
    ['a row without Empcode', { Error: false, PunchData: [{ PunchDate: '05/11/2026 07:40:00' }] }],
    ['a row without PunchDate', { Error: false, PunchData: [{ Empcode: '0036' }] }],
    ['a numeric Empcode', { Error: false, PunchData: [row({ Empcode: 36 })] }],
  ])('fails on %s', (_label, body) => {
    expect(parsePunchResponse(body).ok).toBe(false)
  })

  it('fails the whole response when one row has an unparseable PunchDate', () => {
    const result = parsePunchResponse(okBody([row(), row({ PunchDate: '2026-11-05T07:40:00' })]))
    expect(result).toEqual({ ok: false, reason: 'A punch row could not be read' })
  })

  it('fails the whole response when a row has a blank Empcode', () => {
    expect(parsePunchResponse(okBody([row({ Empcode: '   ' })])).ok).toBe(false)
  })
})

describe('classifySyncResponse (US-12.4)', () => {
  it('fails on a non-200 status with the status in the error', () => {
    const result = classifySyncResponse({ status: 500, bodyText: '' })
    expect(result).toEqual({ ok: false, code: 'HTTP_STATUS', message: 'eTimeOffice returned HTTP 500.' })
  })

  it.each([301, 400, 401, 403, 404, 502])('fails on status %i regardless of body', (status) => {
    const result = classifySyncResponse({ status, bodyText: JSON.stringify(okBody()) })
    expect(result).toMatchObject({ ok: false, code: 'HTTP_STATUS', message: `eTimeOffice returned HTTP ${status}.` })
  })

  it('fails on Error = true with the Msg in the copy', () => {
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify({ Error: true, Msg: 'Invalid credentials' }) })
    expect(result).toEqual({ ok: false, code: 'API_ERROR', message: 'eTimeOffice reported an error: Invalid credentials' })
  })

  it('uses generic copy for Error = true with no Msg', () => {
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify({ Error: true }) })
    expect(result).toEqual({ ok: false, code: 'API_ERROR', message: 'eTimeOffice reported an error.' })
  })

  it('truncates a very long Msg', () => {
    const msg = 'x'.repeat(500)
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify({ Error: true, Msg: msg }) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe(`eTimeOffice reported an error: ${'x'.repeat(200)}`)
    }
  })

  it('fails on a body that is not valid JSON', () => {
    const result = classifySyncResponse({ status: 200, bodyText: '<html>Bad gateway</html>' })
    expect(result).toEqual({ ok: false, code: 'UNPARSEABLE', message: "eTimeOffice sent a response we couldn't read." })
  })

  it('fails on an empty body', () => {
    expect(classifySyncResponse({ status: 200, bodyText: '' })).toMatchObject({ ok: false, code: 'UNPARSEABLE' })
  })

  it('fails on JSON that does not match the expected shape', () => {
    expect(classifySyncResponse({ status: 200, bodyText: '{"hello":"world"}' })).toMatchObject({
      ok: false,
      code: 'UNPARSEABLE',
    })
  })

  it('fails on a row that cannot be parsed', () => {
    const bodyText = JSON.stringify(okBody([row({ PunchDate: 'nope' })]))
    expect(classifySyncResponse({ status: 200, bodyText })).toMatchObject({ ok: false, code: 'UNPARSEABLE' })
  })

  it('fails on an empty punch list', () => {
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify(okBody([])) })
    expect(result).toEqual({ ok: false, code: 'EMPTY', message: 'eTimeOffice returned no punches for this week.' })
  })

  it('fails on a null punch list', () => {
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify({ Error: false, PunchData: null }) })
    expect(result).toMatchObject({ ok: false, code: 'EMPTY' })
  })

  it('succeeds with the punches', () => {
    const result = classifySyncResponse({ status: 200, bodyText: JSON.stringify(okBody()) })
    expect(result).toEqual({
      ok: true,
      punches: [{ empCode: '0036', empName: 'Empname0036', date: '2026-11-05', time: '07:40', mcid: '1' }],
    })
  })

  it('does not leak raw body text into a failure message', () => {
    const result = classifySyncResponse({ status: 200, bodyText: 'secret-token-abc <html>' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('secret-token-abc')
  })
})

describe('SYNC_FAILURE_COPY', () => {
  it('has the documented copy for failures that do not come from the response', () => {
    expect(SYNC_FAILURE_COPY.NETWORK).toBe("Couldn't reach eTimeOffice.")
    expect(SYNC_FAILURE_COPY.TIMEOUT).toBe("eTimeOffice didn't answer in time.")
    expect(SYNC_FAILURE_COPY.CONFIG_MISSING).toBe("eTimeOffice login isn't configured.")
  })

  it('has copy for every failure code, none empty', () => {
    for (const code of ['HTTP_STATUS', 'API_ERROR', 'UNPARSEABLE', 'EMPTY', 'NETWORK', 'TIMEOUT', 'CONFIG_MISSING', 'SYNC_FAILED'] as const) {
      expect(SYNC_FAILURE_COPY[code].length).toBeGreaterThan(0)
    }
  })
})
