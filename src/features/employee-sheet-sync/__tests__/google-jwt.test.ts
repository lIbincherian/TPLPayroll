// @vitest-environment node
import { createVerify, generateKeyPairSync } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_TOKEN_URL,
  SHEETS_READONLY_SCOPE,
  fetchAccessToken,
  normalizePrivateKey,
  signServiceAccountJwt,
} from '../lib/google-jwt'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('signServiceAccountJwt', () => {
  it('produces a verifiable RS256 JWT with the expected claims', () => {
    const jwt = signServiceAccountJwt('svc@proj.iam.gserviceaccount.com', privateKey, SHEETS_READONLY_SCOPE, 1_700_000_000)
    const [h, c, s] = jwt.split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decode(c)).toEqual({
      iss: 'svc@proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))
    expect(ok).toBe(true)
  })

  it('accepts a key whose newlines are literal backslash-n sequences', () => {
    const escaped = privateKey.replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expect(normalizePrivateKey(escaped)).toBe(privateKey)
    const jwt = signServiceAccountJwt('a@b', escaped, SHEETS_READONLY_SCOPE, 1)
    const [h, c, s] = jwt.split('.')
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('throws on a garbage key', () => {
    expect(() => signServiceAccountJwt('a@b', 'not a key', SHEETS_READONLY_SCOPE, 1)).toThrow()
  })
})

describe('fetchAccessToken', () => {
  it('posts the jwt-bearer grant and returns the access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'tok123' }), { status: 200 }))
    const token = await fetchAccessToken('a@b', privateKey, fetchImpl as unknown as typeof fetch)
    expect(token).toBe('tok123')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(GOOGLE_TOKEN_URL)
    expect(init.method).toBe('POST')
    const body = init.body as URLSearchParams
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('assertion')?.split('.')).toHaveLength(3)
  })

  it('maps a refused token request to AUTH_FAILED without echoing the key or response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"invalid_grant","secret":"leak"}', { status: 400 }))
    await expect(fetchAccessToken('a@b', privateKey, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })
    const err = await fetchAccessToken('a@b', privateKey, fetchImpl as unknown as typeof fetch).catch((e) => e)
    expect(err.message).not.toContain('leak')
    expect(err.message).not.toContain('PRIVATE KEY')
  })

  it('maps a bad key to AUTH_FAILED and does not call fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchAccessToken('a@b', 'garbage', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a network failure to FETCH_FAILED', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(fetchAccessToken('a@b', privateKey, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
  })

  it('maps a 200 with no access_token to AUTH_FAILED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(fetchAccessToken('a@b', privateKey, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    })
  })
})
