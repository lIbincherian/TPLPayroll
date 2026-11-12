import { MERGE_WINDOW_MINUTES } from './constants'
import { matchEmployeeCode } from './matching'
import { diffMinutes } from './time'
import { toUtcDate } from './week'
import type {
  AttendancePunchCreate,
  CodeExceptionLite,
  CodeMatch,
  EmployeeLite,
  HHmm,
  ParsedPunch,
  WeekRange,
} from '../types/attendance-sync.types'

/**
 * Merge duplicate scans. The first scan is kept; a later scan within the merge window
 * of the *kept* punch (inclusive) merges into it; otherwise it becomes the new kept punch.
 * `mergedInto[kept]` lists only the scans absorbed into that punch; `originals` is every
 * scan, sorted, so nothing is lost.
 */
export function mergeScans(scans: HHmm[]): {
  punches: HHmm[]
  merged: boolean
  mergedInto: Record<HHmm, HHmm[]>
  originals: HHmm[]
} {
  const originals = [...scans].sort()
  const punches: HHmm[] = []
  const mergedInto: Record<HHmm, HHmm[]> = {}
  let kept: HHmm | null = null

  for (const scan of originals) {
    if (kept !== null && diffMinutes(kept, scan) <= MERGE_WINDOW_MINUTES) {
      ;(mergedInto[kept] ??= []).push(scan)
      continue
    }
    kept = scan
    punches.push(scan)
  }

  return { punches, merged: Object.keys(mergedInto).length > 0, mergedInto, originals }
}

/** Sort and pair in order: (0,1), (2,3), … An odd count leaves the last punch incomplete. */
export function pairPunches(punches: HHmm[]): {
  pairs: Array<{ in: HHmm; out: HHmm }>
  incomplete: HHmm | null
} {
  const sorted = [...punches].sort()
  const pairs: Array<{ in: HHmm; out: HHmm }> = []
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    pairs.push({ in: sorted[i], out: sorted[i + 1] })
  }
  return { pairs, incomplete: sorted.length % 2 === 1 ? sorted[sorted.length - 1] : null }
}

interface ScanGroup {
  employeeId: string | null
  date: string
  match: CodeMatch
  scans: Array<{ time: HHmm; empCode: string; mcid: string | null }>
}

/**
 * Turn the parsed API punches into stored rows. Punches are grouped per employee (or per
 * unresolved code) and day, merged, then paired. Punches outside the week are dropped.
 */
export function buildPunchRowsFromParsed(
  parsed: ParsedPunch[],
  employees: EmployeeLite[],
  exceptions: CodeExceptionLite[],
  week: WeekRange,
): Array<Omit<AttendancePunchCreate, 'attendanceUploadId'>> {
  const matchByCode = new Map<string, CodeMatch>()
  const nameByCode = new Map<string, string | null>()
  const groups = new Map<string, ScanGroup>()

  for (const punch of parsed) {
    if (punch.date < week.start || punch.date > week.end) continue

    let match = matchByCode.get(punch.empCode)
    if (!match) {
      match = matchEmployeeCode(punch.empCode, employees, exceptions)
      matchByCode.set(punch.empCode, match)
    }
    if (!nameByCode.get(punch.empCode)) nameByCode.set(punch.empCode, punch.empName)

    const employeeId = match.status === 'MATCHED' ? match.employee.id : null
    const key = `${employeeId ?? `code:${punch.empCode}`}|${punch.date}`
    let group = groups.get(key)
    if (!group) {
      group = { employeeId, date: punch.date, match, scans: [] }
      groups.set(key, group)
    }
    group.scans.push({ time: punch.time, empCode: punch.empCode, mcid: punch.mcid })
  }

  const rows: Array<Omit<AttendancePunchCreate, 'attendanceUploadId'>> = []

  for (const group of groups.values()) {
    const { punches, mergedInto } = mergeScans(group.scans.map((s) => s.time))
    const { pairs, incomplete } = pairPunches(punches)

    const build = (time: HHmm, pairIndex: number, position: 'IN' | 'OUT') => {
      const scan = group.scans.find((s) => s.time === time) ?? group.scans[0]
      const absorbed = mergedInto[time]
      return {
        employeeId: group.employeeId,
        empCode: scan.empCode,
        empName: nameByCode.get(scan.empCode) ?? null,
        matchStatus: group.match.status,
        punchDate: toUtcDate(group.date),
        pairIndex,
        position,
        source: 'API' as const,
        originalTime: time,
        currentTime: time,
        note: null,
        mergedScansJson: absorbed && absorbed.length > 0 ? absorbed : null,
        mcid: scan.mcid,
      }
    }

    pairs.forEach((pair, index) => {
      rows.push(build(pair.in, index, 'IN'))
      rows.push(build(pair.out, index, 'OUT'))
    })
    if (incomplete !== null) rows.push(build(incomplete, pairs.length, 'IN'))
  }

  return rows
}
