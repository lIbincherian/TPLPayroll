import { createSign } from 'crypto'
import { SheetSyncError } from '../types/employee-sheet-sync.types'

// Service-account auth for the Google Sheets API, with no extra dependency: an RS256 JWT signed with
// node:crypto is exchanged for an access token. Nothing here logs the key, the JWT or the token.

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const TOKEN_TIMEOUT_MS = 30_000

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Env vars usually hold the key with literal "\n" sequences. */
export function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n')
}

export function signServiceAccountJwt(
  clientEmail: string,
  privateKeyPem: string,
  scope: string,
  nowSec: number,
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  )
  const unsigned = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(normalizePrivateKey(privateKeyPem))
  return `${unsigned}.${base64Url(signature)}`
}

export async function fetchAccessToken(
  clientEmail: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  let assertion: string
  try {
    assertion = signServiceAccountJwt(clientEmail, privateKeyPem, SHEETS_READONLY_SCOPE, Math.floor(Date.now() / 1000))
  } catch {
    // Do not echo the underlying error: it can name the key format.
    throw new SheetSyncError('AUTH_FAILED', "Google Sheets sign-in failed: the private key isn't valid.")
  }

  let response: Response
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new SheetSyncError('FETCH_FAILED', "Couldn't reach Google to sign in. Try again.")
  }

  if (!response.ok) {
    throw new SheetSyncError('AUTH_FAILED', 'Google Sheets sign-in was refused. Check the service account credentials.')
  }

  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new SheetSyncError('AUTH_FAILED', 'Google Sheets sign-in returned no access token.')
  }
  return body.access_token
}
