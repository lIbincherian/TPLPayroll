import type { WeekRange } from '../../types/attendance-sync.types'

// Everything that depends on how eTimeOffice wants its request built lives here.
// Open items (see the feature spec): the auth string and URL encoding are unverified
// until real credentials exist. Each is one function to change.

const ENDPOINT = 'DownloadPunchDataMCID'

function toApiDate(iso: string, time: string): string {
  const [year, month, day] = iso.split('-')
  return `${day}/${month}/${year}_${time}`
}

/** `dd/MM/yyyy_HH:mm`, Thursday 00:00 to Wednesday 23:59, all employees. */
export function buildPunchRequestParams(week: WeekRange): { Empcode: 'ALL'; FromDate: string; ToDate: string } {
  return {
    Empcode: 'ALL',
    FromDate: toApiDate(week.start, '00:00'),
    ToDate: toApiDate(week.end, '23:59'),
  }
}

/** HTTP Basic, Base64 of `Corporateid:Username:Password:True` (the documented format). */
export function buildBasicAuthHeader(login: { corporateId: string; username: string; password: string }): string {
  const credentials = `${login.corporateId}:${login.username}:${login.password}:True`
  return `Basic ${Buffer.from(credentials).toString('base64')}`
}

export function buildPunchRequestUrl(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl.replace(/\/?$/, '/')}${ENDPOINT}?${new URLSearchParams(params).toString()}`
}
