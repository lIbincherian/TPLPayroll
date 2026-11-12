import { describe, it, expect } from 'vitest'
import {
  buildBasicAuthHeader,
  buildPunchRequestParams,
  buildPunchRequestUrl,
} from '../lib/etimeoffice/request'

describe('buildPunchRequestParams (US-12.3)', () => {
  it('formats the week range', () => {
    expect(buildPunchRequestParams({ start: '2026-11-05', end: '2026-11-11' })).toEqual({
      Empcode: 'ALL',
      FromDate: '05/11/2026_00:00',
      ToDate: '11/11/2026_23:59',
    })
  })

  it('formats a week that spans a month and year boundary', () => {
    expect(buildPunchRequestParams({ start: '2026-12-31', end: '2027-01-06' })).toEqual({
      Empcode: 'ALL',
      FromDate: '31/12/2026_00:00',
      ToDate: '06/01/2027_23:59',
    })
  })

  it('always requests every employee', () => {
    expect(buildPunchRequestParams({ start: '2026-10-01', end: '2026-10-07' }).Empcode).toBe('ALL')
  })
})

describe('buildBasicAuthHeader (US-12.3)', () => {
  it('encodes the login in the documented order', () => {
    const header = buildBasicAuthHeader({ corporateId: 'corp', username: 'user', password: 'pass' })
    expect(header).toBe('Basic ' + Buffer.from('corp:user:pass:True').toString('base64'))
  })

  it('decodes back to Corporateid:Username:Password:True', () => {
    const header = buildBasicAuthHeader({ corporateId: 'support', username: 'support', password: 'support@1' })
    const decoded = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8')
    expect(decoded).toBe('support:support:support@1:True')
  })

  it('starts with "Basic "', () => {
    expect(buildBasicAuthHeader({ corporateId: 'a', username: 'b', password: 'c' })).toMatch(/^Basic [A-Za-z0-9+/=]+$/)
  })
})

describe('buildPunchRequestUrl', () => {
  const params = { Empcode: 'ALL', FromDate: '05/11/2026_00:00', ToDate: '11/11/2026_23:59' }

  it('appends the endpoint to a base URL with a trailing slash', () => {
    const url = buildPunchRequestUrl('https://api.etimeoffice.com/api/', params)
    expect(url.startsWith('https://api.etimeoffice.com/api/DownloadPunchDataMCID?')).toBe(true)
  })

  it('adds the missing trailing slash to the base URL', () => {
    const url = buildPunchRequestUrl('https://api.etimeoffice.com/api', params)
    expect(url.startsWith('https://api.etimeoffice.com/api/DownloadPunchDataMCID?')).toBe(true)
  })

  it('does not double the slash', () => {
    expect(buildPunchRequestUrl('http://localhost:3000/api/mock-etimeoffice/', params)).not.toContain('//DownloadPunchDataMCID')
  })

  it('round-trips the parameters through the query string', () => {
    const url = new URL(buildPunchRequestUrl('https://api.etimeoffice.com/api/', params))
    expect(url.searchParams.get('Empcode')).toBe('ALL')
    expect(url.searchParams.get('FromDate')).toBe('05/11/2026_00:00')
    expect(url.searchParams.get('ToDate')).toBe('11/11/2026_23:59')
  })
})
