// Pure value parsing for the Employee Master sheet. No database, no network.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

/** Empty, whitespace, X, Y (any case) and formula errors such as #N/A are "no value". */
export function isBlankMarker(raw: string | null | undefined): boolean {
  if (raw == null) return true
  const value = raw.trim()
  if (value === '') return true
  if (/^[xy]$/i.test(value)) return true
  return value.startsWith('#')
}

/** Trim, and strip one pair of surrounding quotes ("…", '…', “…”). Leading zeros are kept. */
export function cleanIdText(raw: string): string {
  let value = raw.trim()
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”']]
  for (const [open, close] of pairs) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(open.length, value.length - close.length).trim()
      break
    }
  }
  return value
}

/** Free text: trimmed, null when it is a blank marker. */
export function cleanText(raw: string): string | null {
  return isBlankMarker(raw) ? null : raw.trim()
}

/** Identifier-like text (phone, bank account, Aadhaar…): quotes stripped, null when blank. */
export function cleanIdField(raw: string): string | null {
  if (isBlankMarker(raw)) return null
  const value = cleanIdText(raw)
  return isBlankMarker(value) ? null : value
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`
}

export type DateParse = { ok: true; value: string } | { ok: false }

/**
 * Day first only: DD/MM/YYYY, D/M/YYYY, DD/MM/YY (20YY), DD-MM-YYYY, "D Month YYYY", "D Mon YYYY".
 * ISO dates, month-first dates and impossible dates are rejected.
 */
export function parseDayFirstDate(raw: string): DateParse {
  const text = cleanIdText(raw)

  const numeric = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(text)
  if (numeric) {
    const day = parseInt(numeric[1], 10)
    const month = parseInt(numeric[3], 10)
    const year = numeric[4].length === 2 ? 2000 + parseInt(numeric[4], 10) : parseInt(numeric[4], 10)
    const iso = toIso(year, month, day)
    return iso ? { ok: true, value: iso } : { ok: false }
  }

  const named = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(text)
  if (named) {
    const month = MONTHS[named[2].toLowerCase()]
    if (!month) return { ok: false }
    const iso = toIso(parseInt(named[3], 10), month, parseInt(named[1], 10))
    return iso ? { ok: true, value: iso } : { ok: false }
  }

  return { ok: false }
}

/** A plain positive number (decimals allowed). Commas, units and text are invalid. */
export function parseSalary(raw: string): number | null {
  const text = cleanIdText(raw)
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** wa.me links and +91 / 91 prefixes become the 10-digit number; anything else is kept as written. */
export function parseWhatsapp(raw: string): string | null {
  if (isBlankMarker(raw)) return null
  const text = cleanIdText(raw)
  if (isBlankMarker(text)) return null

  const link = /^(?:https?:\/\/)?(?:www\.)?wa\.me\/\+?(\d+)/i.exec(text)
  const digits = link ? link[1] : text.replace(/[\s-]/g, '').replace(/^\+/, '')
  if (/^91\d{10}$/.test(digits)) return digits.slice(2)
  if (link && /^\d{10}$/.test(digits)) return digits
  if (!link && /^\d{10}$/.test(digits) && /^[+\d\s-]+$/.test(text)) return digits
  return text
}

export type ActiveParse = { ok: true; value: boolean | null } | { ok: false }

/** Active / Inactive (any case). Blank is { ok: true, value: null }; anything else is not ok. */
export function parseActive(raw: string): ActiveParse {
  if (isBlankMarker(raw)) return { ok: true, value: null }
  const text = raw.trim().toLowerCase()
  if (text === 'active') return { ok: true, value: true }
  if (text === 'inactive') return { ok: true, value: false }
  return { ok: false }
}
