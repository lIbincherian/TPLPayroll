import { z } from 'zod'
import { toISODate, toUtcDate } from '../week'
import type {
  HHmm,
  ISODate,
  ParsedPunch,
  SyncClassification,
  SyncFailureCode,
} from '../../types/attendance-sync.types'

// The only module that knows eTimeOffice's response field names. Unknown fields
// (including the vendor's OverTime and WorkTime) are ignored and never read.

export const SYNC_FAILURE_COPY: Record<SyncFailureCode, string> = {
  HTTP_STATUS: 'eTimeOffice returned an error status.',
  API_ERROR: 'eTimeOffice reported an error.',
  UNPARSEABLE: "eTimeOffice sent a response we couldn't read.",
  EMPTY: 'eTimeOffice returned no punches for this week.',
  NETWORK: "Couldn't reach eTimeOffice.",
  TIMEOUT: "eTimeOffice didn't answer in time.",
  CONFIG_MISSING: "eTimeOffice login isn't configured.",
  SYNC_FAILED: "Couldn't save the pulled punches.",
  WEEK_CHANGED: 'The week was approved while the pull was running. Nothing was replaced.',
}

const MAX_API_MESSAGE_LENGTH = 200

const punchRowSchema = z
  .object({
    Empcode: z.string(),
    PunchDate: z.string(),
    Name: z.string().nullish(),
    mcid: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough()

const responseSchema = z
  .object({
    Error: z.boolean(),
    Msg: z.string().nullish(),
    PunchData: z.array(punchRowSchema).nullish(),
  })
  .passthrough()

const PUNCH_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::\d{2})?$/

/**
 * `dd/MM/yyyy HH:mm:ss` read as local wall-clock time. Seconds are dropped and no Date is
 * built from the time, so nothing shifts with the server timezone.
 */
export function parsePunchDate(value: string): { date: ISODate; time: HHmm } | null {
  const match = PUNCH_DATE_PATTERN.exec(value.trim())
  if (!match) return null
  const [, day, month, year, hours, minutes] = match
  if (parseInt(hours, 10) > 23 || parseInt(minutes, 10) > 59) return null

  const date = `${year}-${month}-${day}`
  const parsed = toUtcDate(date)
  if (Number.isNaN(parsed.getTime()) || toISODate(parsed) !== date) return null

  return { date, time: `${hours}:${minutes}` }
}

export function parsePunchResponse(
  body: unknown,
): { ok: true; punches: ParsedPunch[]; msg: string | null; error: boolean } | { ok: false; reason: string } {
  const result = responseSchema.safeParse(body)
  if (!result.success) return { ok: false, reason: 'Response does not match the expected shape' }

  const { Error: error, Msg: msg, PunchData } = result.data
  const message = msg?.trim() ? msg.trim() : null
  if (error) return { ok: true, punches: [], msg: message, error: true }

  const punches: ParsedPunch[] = []
  for (const row of PunchData ?? []) {
    const empCode = row.Empcode.trim()
    const when = parsePunchDate(row.PunchDate)
    if (!empCode || !when) return { ok: false, reason: 'A punch row could not be read' }

    punches.push({
      empCode,
      empName: row.Name?.trim() ? row.Name.trim() : null,
      date: when.date,
      time: when.time,
      mcid: row.mcid === null || row.mcid === undefined ? null : String(row.mcid),
    })
  }

  return { ok: true, punches, msg: message, error: false }
}

function failure(code: SyncFailureCode, message: string = SYNC_FAILURE_COPY[code]): SyncClassification {
  return { ok: false, code, message }
}

/** Turn an HTTP status and body into a loaded week or a user-facing failure. */
export function classifySyncResponse(input: { status: number; bodyText: string }): SyncClassification {
  if (input.status !== 200) return failure('HTTP_STATUS', `eTimeOffice returned HTTP ${input.status}.`)

  let body: unknown
  try {
    body = JSON.parse(input.bodyText)
  } catch {
    return failure('UNPARSEABLE')
  }

  const parsed = parsePunchResponse(body)
  if (!parsed.ok) return failure('UNPARSEABLE')

  if (parsed.error) {
    return failure(
      'API_ERROR',
      parsed.msg
        ? `eTimeOffice reported an error: ${parsed.msg.slice(0, MAX_API_MESSAGE_LENGTH)}`
        : SYNC_FAILURE_COPY.API_ERROR,
    )
  }

  if (parsed.punches.length === 0) return failure('EMPTY')
  return { ok: true, punches: parsed.punches }
}
