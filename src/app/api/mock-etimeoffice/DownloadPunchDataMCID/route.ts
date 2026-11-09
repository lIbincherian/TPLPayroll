import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { addDaysISO, todayInIST } from '@/features/attendance-sync/lib/week'

export const dynamic = 'force-dynamic'

// In-app stand-in for eTimeOffice's DownloadPunchDataMCID, used in local dev and e2e only.
// Disabled whenever a real login is configured or the app runs on Vercel.
//
// e2e tests steer it by writing `scenario.json` to the OS temp directory:
//   { status: number, body: unknown, delayMs?: number }
// Without that file it returns three employees (codes 0001-0003) with one full day of
// punches for every day in the requested range up to today.

const SCENARIO_FILE = path.join(os.tmpdir(), 'tpl-payroll-mock-etimeoffice', 'scenario.json')
const DEFAULT_CODES = ['0001', '0002', '0003']
const DEFAULT_TIMES = ['07:40', '13:04', '13:56', '17:47']
const API_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})_\d{2}:\d{2}$/

interface Scenario {
  status: number
  body: unknown
  delayMs?: number
}

function readScenario(): Scenario | null {
  try {
    return JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8')) as Scenario
  } catch {
    return null
  }
}

function apiDateToISO(value: string | null): string | null {
  const match = value ? API_DATE_PATTERN.exec(value) : null
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

function buildDefaultBody(from: string, to: string) {
  const today = todayInIST()
  const punches: Array<Record<string, string>> = []

  for (let day = from; day <= to && day <= today; day = addDaysISO(day, 1)) {
    const [year, month, date] = day.split('-')
    for (const code of DEFAULT_CODES) {
      for (const time of DEFAULT_TIMES) {
        punches.push({
          Name: `Empname${code}`,
          Empcode: code,
          PunchDate: `${date}/${month}/${year} ${time}:00`,
          M_Flag: '',
          mcid: '1',
        })
      }
    }
  }

  return { Error: false, Msg: 'Success', IsAdmin: true, PunchData: punches }
}

export async function GET(request: NextRequest) {
  if (process.env.ETIMEOFFICE_CORPORATE_ID || process.env.VERCEL) {
    return new NextResponse('Mock eTimeOffice disabled', { status: 403 })
  }

  const scenario = readScenario()
  if (scenario) {
    if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs))
    const text = typeof scenario.body === 'string' ? scenario.body : JSON.stringify(scenario.body)
    return new NextResponse(text, { status: scenario.status, headers: { 'Content-Type': 'application/json' } })
  }

  const { searchParams } = new URL(request.url)
  const from = apiDateToISO(searchParams.get('FromDate'))
  const to = apiDateToISO(searchParams.get('ToDate'))
  if (!from || !to) {
    return NextResponse.json({ Error: true, Msg: 'Invalid FromDate or ToDate' }, { status: 400 })
  }

  return NextResponse.json(buildDefaultBody(from, to))
}
