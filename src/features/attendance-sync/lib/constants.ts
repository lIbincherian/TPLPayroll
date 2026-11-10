// Tunable values live here so they can be adjusted against real data.

/** Payroll weeks run Thursday to Wednesday. JavaScript getUTCDay(): Sunday = 0, Thursday = 4. */
export const PAYROLL_WEEK_START_DOW = 4

/** A scan within this many minutes of the kept punch merges into it (inclusive). */
export const MERGE_WINDOW_MINUTES = 2

export const DAILY_REGULAR_HOURS = 8

/** A complete day under this many hours is highlighted as unusual. */
export const UNUSUAL_DAY_MIN_HOURS = 4

/** A single pair longer than this many hours is highlighted as unusual. */
export const UNUSUAL_SINGLE_PAIR_MAX_HOURS = 6

export const IST_TIME_ZONE = 'Asia/Kolkata'

export const API_FETCH_TIMEOUT_MS = 45000

export const SYNC_LOCK_TTL_MS = 5 * 60 * 1000

/** Upper bound for an interactive transaction that holds the week lock. */
export const TRANSACTION_TIMEOUT_MS = 30000

export const WEEK_LIST_LIMIT = 26
