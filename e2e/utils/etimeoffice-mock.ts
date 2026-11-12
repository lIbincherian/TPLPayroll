import fs from 'fs'
import os from 'os'
import path from 'path'
import { isTestCode } from './test-namespace'

// Steers the in-app mock eTimeOffice API (src/app/api/mock-etimeoffice/DownloadPunchDataMCID).
// The app server and the Playwright process run on the same machine, so a scenario file in
// the OS temp directory is how a test decides what "eTimeOffice" answers with.

const SCENARIO_DIR = path.join(os.tmpdir(), 'tpl-payroll-mock-etimeoffice')
const SCENARIO_FILE = path.join(SCENARIO_DIR, 'scenario.json')

export interface MockScenario {
  status: number
  body: unknown
  delayMs?: number
}

/** One row of the vendor's `PunchData` array. */
export interface MockPunchRow {
  Name: string
  Empcode: string
  PunchDate: string
  M_Flag: string
  mcid: string
}

export function setMockScenario(scenario: MockScenario): void {
  fs.mkdirSync(SCENARIO_DIR, { recursive: true })
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(scenario))
}

export function clearMockScenario(): void {
  try {
    fs.unlinkSync(SCENARIO_FILE)
  } catch {
    // already gone
  }
}

/** A 200 response carrying these punches. */
export function setMockPunches(rows: MockPunchRow[]): void {
  setMockScenario({ status: 200, body: { Error: false, Msg: 'Success', IsAdmin: true, PunchData: rows } })
}

/** The API answers 500. */
export function setMockHttpError(status = 500): void {
  setMockScenario({ status, body: { Error: true, Msg: 'Internal Server Error' } })
}

/** The API answers 200 with `Error: true`. */
export function setMockApiError(msg = 'Invalid credentials'): void {
  setMockScenario({ status: 200, body: { Error: true, Msg: msg, PunchData: null } })
}

/** The API answers 200, no error, no punches. */
export function setMockEmpty(): void {
  setMockScenario({ status: 200, body: { Error: false, Msg: 'Success', IsAdmin: true, PunchData: [] } })
}

// ─── Punch row builders ──────────────────────────────────────────────────────

/** "2026-11-05" + "07:40" -> "05/11/2026 07:40:00". */
export function toApiPunchDate(isoDate: string, time: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year} ${time}:00`
}

/**
 * One employee-day of scans, as the API sends them. The code must be in the test range (9xxx, see
 * test-namespace.ts), so a mocked scan can never match a real employee in the real-data base.
 */
export function mockDay(code: string, isoDate: string, times: string[], name = `Empname${code}`): MockPunchRow[] {
  if (!isTestCode(code)) {
    throw new Error(`mock code "${code}" is outside the test range 9000-9999; a real employee could match it`)
  }
  return times.map((time) => ({
    Name: name,
    Empcode: code,
    PunchDate: toApiPunchDate(isoDate, time),
    M_Flag: 'I',
    mcid: '1',
  }))
}

export const FULL_DAY = ['07:40', '13:04', '13:56', '17:47']

/** The same scans on several days. */
export function mockDays(code: string, isoDates: string[], times: string[] = FULL_DAY, name?: string): MockPunchRow[] {
  return isoDates.flatMap((date) => mockDay(code, date, times, name))
}

// ─── Dates (IST, never the local timezone) ───────────────────────────────────

const ISTDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function todayInIST(now: Date = new Date()): string {
  return ISTDate.format(now)
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay()
}

/**
 * The Thursday-Wednesday week the scheduled sync targets: the week that ended yesterday
 * (IST). Duplicates getCompletedPayrollWeek so the cron spec works on any real date.
 */
export function expectedCompletedWeek(now: Date = new Date()): { start: string; end: string } {
  const yesterday = addDays(todayInIST(now), -1)
  const sinceWednesday = (dayOfWeek(yesterday) - 3 + 7) % 7
  const end = addDays(yesterday, -sinceWednesday)
  return { start: addDays(end, -6), end }
}

/** The Thursday-Wednesday week that contains today (IST). */
export function expectedCurrentWeek(now: Date = new Date()): { start: string; end: string } {
  const today = todayInIST(now)
  const sinceThursday = (dayOfWeek(today) - 4 + 7) % 7
  const start = addDays(today, -sinceThursday)
  return { start, end: addDays(start, 6) }
}

/** The label the attendance screens show: "5 Nov – 11 Nov 2026" (start year only across a year end). */
export function weekLabel(week: { start: string; end: string }): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    })
  const sameYear = week.start.slice(0, 4) === week.end.slice(0, 4)
  return `${fmt(week.start, !sameYear)} – ${fmt(week.end, true)}`
}

/** The label the payroll week list shows: "6 Mar 2025 – 12 Mar 2025" (both dates carry the year). */
export function payrollWeekLabel(week: { start: string; end: string }): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
  return `${fmt(week.start)} – ${fmt(week.end)}`
}
