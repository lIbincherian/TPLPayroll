import { API_FETCH_TIMEOUT_MS } from '../lib/constants'
import { classifySyncResponse, SYNC_FAILURE_COPY } from '../lib/etimeoffice/parser'
import {
  buildBasicAuthHeader,
  buildPunchRequestParams,
  buildPunchRequestUrl,
} from '../lib/etimeoffice/request'
import type { SyncClassification, SyncFailureCode, WeekRange } from '../types/attendance-sync.types'

// The ONLY module that reads ETIMEOFFICE_* environment variables. Nothing here logs or
// returns the login, the Authorization header or the base URL.

const DEFAULT_BASE_URL = 'https://api.etimeoffice.com/api/'

type EtimeofficeLogin = { corporateId: string; username: string; password: string }

export type EtimeofficeConfig =
  | { mode: 'LIVE'; baseUrl: string; login: EtimeofficeLogin }
  | { mode: 'MOCK'; baseUrl: string }
  | { mode: 'MISSING' }

/**
 * LIVE when the full login is set. MOCK (the in-app mock API) only when the corporate id is
 * unset and the app is not on Vercel. Anything else is MISSING, so production never
 * falls back to the mock.
 */
export function getEtimeofficeConfig(): EtimeofficeConfig {
  const corporateId = process.env.ETIMEOFFICE_CORPORATE_ID
  const username = process.env.ETIMEOFFICE_USERNAME
  const password = process.env.ETIMEOFFICE_PASSWORD

  if (corporateId && username && password) {
    return {
      mode: 'LIVE',
      baseUrl: process.env.ETIMEOFFICE_BASE_URL || DEFAULT_BASE_URL,
      login: { corporateId, username, password },
    }
  }

  if (!corporateId && !process.env.VERCEL) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    return { mode: 'MOCK', baseUrl: `${appUrl}/api/mock-etimeoffice/` }
  }

  return { mode: 'MISSING' }
}

/** True only when the in-app mock API may answer: the same rule that makes fetchPunchData call it. */
export function isMockEtimeofficeEnabled(): boolean {
  return getEtimeofficeConfig().mode === 'MOCK'
}

function failure(code: SyncFailureCode): SyncClassification {
  return { ok: false, code, message: SYNC_FAILURE_COPY[code] }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

export async function fetchPunchData(
  week: WeekRange,
  deps: { fetch: typeof fetch } = { fetch: globalThis.fetch },
): Promise<SyncClassification> {
  const config = getEtimeofficeConfig()
  if (config.mode === 'MISSING') return failure('CONFIG_MISSING')

  const url = buildPunchRequestUrl(config.baseUrl, buildPunchRequestParams(week))
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.mode === 'LIVE') headers.Authorization = buildBasicAuthHeader(config.login)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS)

  try {
    const response = await deps.fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    })
    const bodyText = await response.text()
    return classifySyncResponse({ status: response.status, bodyText })
  } catch (error) {
    return failure(isAbortError(error) ? 'TIMEOUT' : 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}
