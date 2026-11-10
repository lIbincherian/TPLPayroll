// The test namespace: where the e2e specs' own data lives, apart from the real-data base.
//
// The e2e database is seeded with a production snapshot first (see global-setup.ts), and each spec then adds
// its own small, predictable data on top. For that to be safe the spec data must never touch a real row and
// the real rows must never reach a spec's assertions. Three namespaces keep them apart:
//
//   Employees   ID "E2E-<TAG>-<9000 + n>"        e.g. testEmployeeId('HLP', 1) = "E2E-HLP-9001"
//               The "E2E-" prefix is what cleanup deletes by. The trailing number is in 9000-9999, a range no
//               real employee uses (real IDs end in 1-3 digits), so an eTimeOffice code in the test range can
//               never match a real person, and a real code can never match a test employee.
//   Codes       testCode(n) = "9000 + n"          e.g. testCode(1) = "9001"  (eTimeOffice codes the mock sends)
//   Weeks       three zones the snapshot does not contain:
//                 PRE      before PRE_HISTORY_END (production started 2026-05-14)
//                 FUTURE   from FAR_FUTURE_START
//                 RESERVED the last completed and the current Thursday-Wednesday week and every week after
//                          (global setup deletes the real rows there, so the cron and Pull now specs, which
//                          always target "now", can use them)
//
// Everything a spec seeds is in one of these, so cleaning a namespace is a delete by prefix or by week zone:
// the base survives every spec. global-setup.ts checks the snapshot against these rules.

export const TEST_EMPLOYEE_PREFIX = 'E2E-'
export const TEST_NUMBER_BASE = 9000

/** Employee ID of a test employee: its site tag and a number in the test range. */
export function testEmployeeId(tag: string, n: number): string {
  return `${TEST_EMPLOYEE_PREFIX}${tag}-${TEST_NUMBER_BASE + n}`
}

/** The eTimeOffice code that matches testEmployeeId(*, n): the trailing number, four digits. */
export function testCode(n: number): string {
  return String(TEST_NUMBER_BASE + n)
}

/** Weeks before this (exclusive) belong to the test namespace. The real data starts on 2026-05-14. */
export const PRE_HISTORY_END = '2026-05-01'
/** Weeks from this date on belong to the test namespace. */
export const FAR_FUTURE_START = '2040-01-01'

/** True for a code in the test range: four digits starting with 9. */
export function isTestCode(code: string): boolean {
  return /^9\d{3}$/.test(code)
}
