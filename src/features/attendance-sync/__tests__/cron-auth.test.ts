// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isAuthorizedCronRequest } from '../lib/cron-auth'

const SECRET = 'local-cron-secret'

function request(authorization?: string): Request {
  return new Request('http://localhost:3000/api/cron/attendance-sync', {
    headers: authorization === undefined ? {} : { authorization },
  })
}

describe('isAuthorizedCronRequest (US-12.2)', () => {
  it('rejects a request with no secret header', () => {
    expect(isAuthorizedCronRequest(request(), SECRET)).toBe(false)
  })

  it('rejects a wrong secret of the same length', () => {
    expect(isAuthorizedCronRequest(request('Bearer local-cron-secreX'), SECRET)).toBe(false)
  })

  it('rejects a wrong secret of a different length (no timingSafeEqual throw)', () => {
    expect(isAuthorizedCronRequest(request('Bearer short'), SECRET)).toBe(false)
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}-and-more`), SECRET)).toBe(false)
  })

  it('accepts the correct secret', () => {
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(true)
  })

  it('requires the Bearer scheme', () => {
    expect(isAuthorizedCronRequest(request(SECRET), SECRET)).toBe(false)
    expect(isAuthorizedCronRequest(request(`Basic ${SECRET}`), SECRET)).toBe(false)
    expect(isAuthorizedCronRequest(request(`bearer ${SECRET}`), SECRET)).toBe(false)
  })

  it('fails closed when the secret is unset or empty', () => {
    expect(isAuthorizedCronRequest(request('Bearer undefined'), undefined)).toBe(false)
    expect(isAuthorizedCronRequest(request('Bearer '), '')).toBe(false)
    expect(isAuthorizedCronRequest(request('Bearer'), '')).toBe(false)
    expect(isAuthorizedCronRequest(request(), '')).toBe(false)
  })

  it('does not accept the secret from a query string', () => {
    const req = new Request(`http://localhost:3000/api/cron/attendance-sync?secret=${SECRET}`)
    expect(isAuthorizedCronRequest(req, SECRET)).toBe(false)
  })

  it('handles multibyte header values without throwing', () => {
    expect(isAuthorizedCronRequest(request('Bearer é'), SECRET)).toBe(false)
  })
})
