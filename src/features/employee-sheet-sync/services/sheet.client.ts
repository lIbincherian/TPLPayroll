import fixture from '../fixtures/employee-master.fixture.json'
import { fetchAccessToken } from '../lib/google-jwt'
import {
  SheetSyncError,
  type SheetSourceMode,
  type SheetValues,
} from '../types/employee-sheet-sync.types'

// The ONLY module that reads GOOGLE_SHEETS_* and EMPLOYEE_SHEET_* environment variables. Server-only by
// convention (the `server-only` package is not installed; nothing client-side imports this file). It never
// logs or returns the service account email, the private key, the token or the sheet id.

export const DEFAULT_SHEET_TAB = 'Employee Master List'
const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets/'
const FETCH_TIMEOUT_MS = 30_000

export type SheetSourceConfig =
  | { mode: 'LIVE'; tab: string; sheetId: string }
  | { mode: 'FIXTURE'; tab: string }
  | { mode: 'UNCONFIGURED'; tab: string }

type LiveCredentials = { clientEmail: string; privateKey: string; sheetId: string }

function readLiveCredentials(): LiveCredentials | null {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY
  const sheetId = process.env.EMPLOYEE_SHEET_ID
  if (clientEmail && privateKey && sheetId) return { clientEmail, privateKey, sheetId }
  return null
}

/**
 * LIVE when the full credentials and the sheet id are set. FIXTURE only when the service account email is
 * unset and the app is not on Vercel (local dev and e2e), so production never falls back to the fixture.
 * Anything else, including partial credentials, is UNCONFIGURED.
 */
export function getSheetSourceConfig(): SheetSourceConfig {
  const tab = process.env.EMPLOYEE_SHEET_TAB || DEFAULT_SHEET_TAB
  const live = readLiveCredentials()
  if (live) return { mode: 'LIVE', tab, sheetId: live.sheetId }
  if (!process.env.GOOGLE_SHEETS_CLIENT_EMAIL && !process.env.VERCEL) return { mode: 'FIXTURE', tab }
  return { mode: 'UNCONFIGURED', tab }
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** True only for a Postgres URL whose host is this machine. Unset or unreadable counts as not local. */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return LOCAL_DB_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface FetchedSheet {
  values: SheetValues
  mode: SheetSourceMode
  tab: string
}

function toSheetValues(grid: string[][]): SheetValues {
  const [header = [], ...rows] = grid
  return { header: header.map((c) => String(c ?? '')), rows: rows.map((r) => r.map((c) => String(c ?? ''))) }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** Reads the one tab. Throws SheetSyncError; the messages carry no secrets. */
export async function fetchEmployeeSheet(
  deps: { fetch: typeof fetch } = { fetch: globalThis.fetch },
): Promise<FetchedSheet> {
  const config = getSheetSourceConfig()

  if (config.mode === 'UNCONFIGURED') {
    throw new SheetSyncError('NOT_CONFIGURED', "Google Sheets access isn't configured.")
  }

  if (config.mode === 'FIXTURE') {
    // The fixture is sample data: never let it reach a shared (Staging or Production) database.
    if (!isLocalDatabaseUrl(process.env.DATABASE_URL)) {
      throw new SheetSyncError(
        'FIXTURE_NOT_LOCAL',
        "Google Sheets access isn't configured, and the built-in sample sheet only runs against a local database.",
      )
    }
    return {
      values: { header: [...fixture.header], rows: fixture.rows.map((r) => [...r]) },
      mode: 'FIXTURE',
      tab: config.tab,
    }
  }

  const credentials = readLiveCredentials()
  if (!credentials) throw new SheetSyncError('NOT_CONFIGURED', "Google Sheets access isn't configured.")

  const token = await fetchAccessToken(credentials.clientEmail, credentials.privateKey, deps.fetch)

  // The quoted tab name is the whole range, so only that tab is read.
  const range = encodeURIComponent(`'${config.tab.replace(/'/g, "''")}'`)
  const url =
    `${SHEETS_BASE_URL}${encodeURIComponent(credentials.sheetId)}/values/${range}` +
    '?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING'

  let response: Response
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (error) {
    throw new SheetSyncError(
      'FETCH_FAILED',
      isAbortError(error) ? 'Google Sheets took too long to answer. Try again.' : "Couldn't reach Google Sheets. Try again.",
    )
  }

  if (response.status === 403) {
    throw new SheetSyncError('SHEET_NOT_SHARED', 'The sheet is not shared with the service account. Share it (view only) and try again.')
  }
  if (response.status === 404) {
    throw new SheetSyncError('SHEET_NOT_FOUND', "Google Sheets can't find the spreadsheet. Check the sheet id.")
  }
  if (response.status === 400) {
    const text = await response.text().catch(() => '')
    if (/unable to parse range/i.test(text)) {
      throw new SheetSyncError('TAB_NOT_FOUND', `The sheet has no tab named "${config.tab}".`)
    }
    throw new SheetSyncError('FETCH_FAILED', `Google Sheets rejected the request (${response.status}).`)
  }
  if (!response.ok) {
    throw new SheetSyncError('FETCH_FAILED', `Google Sheets returned an error (${response.status}).`)
  }

  const body = (await response.json().catch(() => null)) as { values?: unknown } | null
  if (!body || !Array.isArray(body.values) || body.values.length === 0) {
    throw new SheetSyncError('EMPTY_SHEET', 'The Employee Master sheet is empty.')
  }
  return { values: toSheetValues(body.values as string[][]), mode: 'LIVE', tab: config.tab }
}
