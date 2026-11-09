import type { AttendanceUpload } from '@prisma/client'
import prisma from '@/lib/prisma'
import { SYNC_LOCK_TTL_MS, WEEK_LIST_LIMIT } from '../lib/constants'
import { getReviewGridEmployees } from '../lib/matching'
import {
  buildGridEmployees,
  canPullNow,
  canReopenWeek,
  countEmployeeCheckIssues,
  getAttendanceWeekStatus,
  getNeedsFixingDays,
  getPayrollEmployees,
} from '../lib/review'
import { round2 } from '../lib/time'
import {
  addDaysISO,
  getCurrentPayrollWeek,
  getWeekDates,
  hasWeekEnded,
  parseWeekId,
  toISODate,
  toUtcDate,
  todayInIST,
  weekFromStartISO,
} from '../lib/week'
import {
  AttendanceSyncError,
  type AttendanceSource,
  type AttendanceWeekListItem,
  type EmployeeDecisionValue,
  type EmployeeLite,
  type ISODate,
  type StoredPunchRow,
  type WeekPayrollStatus,
  type WeekRange,
} from '../types/attendance-sync.types'

const EMPLOYEE_LITE_SELECT = {
  id: true,
  employeeId: true,
  employeeName: true,
  isActive: true,
  dateOfResignation: true,
} as const

export async function getWeekByStart(weekStart: Date): Promise<AttendanceUpload | null> {
  return prisma.attendanceUpload.findFirst({
    where: { payrollWeekStartDate: weekStart, isActiveForPayrollWeek: true },
    orderBy: { uploadedAt: 'desc' },
  })
}

/**
 * The active row for an API week, creating a placeholder when there is none. The
 * placeholder starts as SYNC_FAILED and shows as "Pulling…" while its sync lock is held.
 * Excel-era weeks are read-only and never become API weeks.
 */
export async function getOrCreateApiWeekRow(week: WeekRange): Promise<AttendanceUpload> {
  const existing = await getWeekByStart(toUtcDate(week.start))
  if (existing) {
    if (existing.source === 'EXCEL') {
      throw new AttendanceSyncError('EXCEL_ERA_WEEK', "This week was imported from Excel and can't be pulled.")
    }
    return existing
  }

  return prisma.attendanceUpload.create({
    data: {
      source: 'ETIMEOFFICE',
      payrollWeekSource: 'ETIMEOFFICE',
      status: 'SYNC_FAILED',
      fileName: null,
      fileType: null,
      payrollWeekStartDate: toUtcDate(week.start),
      payrollWeekEndDate: toUtcDate(week.end),
      isActiveForPayrollWeek: true,
    },
  })
}

/**
 * Resolve a `weekId` route param to its API-week row. Anything that isn't a Thursday is
 * INVALID_WEEK, a week with no row is WEEK_NOT_READY, and an Excel-era week is read-only.
 */
export async function requireApiWeek(weekId: string): Promise<{ upload: AttendanceUpload; week: WeekRange }> {
  const week = parseWeekId(weekId)
  if (!week) throw new AttendanceSyncError('INVALID_WEEK', 'A payroll week starts on a Thursday.')

  const upload = await getWeekByStart(toUtcDate(week.start))
  if (!upload) throw new AttendanceSyncError('WEEK_NOT_READY', 'No attendance has been loaded for this week.')
  if (upload.source === 'EXCEL') {
    throw new AttendanceSyncError('EXCEL_ERA_WEEK', 'This week was imported from Excel and is read-only.')
  }
  return { upload, week }
}

interface UploadStats {
  employeeCount: number
  totalRegularHours: number
  totalOvertimeHours: number
  unresolvedCodes: number
  pendingDecisions: number
  needsFixingDays: number
}

const EMPTY_STATS: UploadStats = {
  employeeCount: 0,
  totalRegularHours: 0,
  totalOvertimeHours: 0,
  unresolvedCodes: 0,
  pendingDecisions: 0,
  needsFixingDays: 0,
}

/** Counts for weeks in review, computed from the live punches (about 4k rows per week). */
async function computeReviewStats(reviewUploads: AttendanceUpload[]): Promise<Map<string, UploadStats>> {
  const stats = new Map<string, UploadStats>()
  if (reviewUploads.length === 0) return stats

  const uploadIds = reviewUploads.map((u) => u.id)
  const [employees, decisions, punches] = await Promise.all([
    prisma.employee.findMany({ select: EMPLOYEE_LITE_SELECT }) as Promise<EmployeeLite[]>,
    prisma.attendanceEmployeeDecision.findMany({
      where: { attendanceUploadId: { in: uploadIds } },
      select: { attendanceUploadId: true, employeeId: true, decision: true },
    }),
    prisma.attendancePunch.findMany({
      where: { attendanceUploadId: { in: uploadIds }, correctionId: null },
      select: {
        id: true,
        attendanceUploadId: true,
        employeeId: true,
        empCode: true,
        matchStatus: true,
        punchDate: true,
        pairIndex: true,
        position: true,
        source: true,
        originalTime: true,
        currentTime: true,
        note: true,
        mergedScansJson: true,
      },
    }),
  ])

  for (const upload of reviewUploads) {
    const week: WeekRange = {
      start: toISODate(upload.payrollWeekStartDate),
      end: toISODate(upload.payrollWeekEndDate),
    }
    const uploadDecisions = decisions
      .filter((d) => d.attendanceUploadId === upload.id)
      .map((d) => ({ employeeId: d.employeeId, decision: d.decision as EmployeeDecisionValue }))
    const uploadPunches = punches.filter((p) => p.attendanceUploadId === upload.id)

    const eligible = getReviewGridEmployees(employees, uploadDecisions, week)
    const grid = buildGridEmployees(eligible, uploadPunches as Array<StoredPunchRow & { employeeId: string | null; punchDate: Date }>, getWeekDates(week))
    const payrollEmployees = getPayrollEmployees({ employees: grid })
    const issues = countEmployeeCheckIssues({ week, employees, punches: uploadPunches, decisions: uploadDecisions })

    stats.set(upload.id, {
      employeeCount: payrollEmployees.length,
      totalRegularHours: round2(payrollEmployees.reduce((sum, e) => sum + e.totalRegularHours, 0)),
      totalOvertimeHours: round2(payrollEmployees.reduce((sum, e) => sum + e.totalOvertimeHours, 0)),
      unresolvedCodes: issues.unresolvedCodes,
      pendingDecisions: issues.pendingDecisions,
      needsFixingDays: getNeedsFixingDays(grid).length,
    })
  }

  return stats
}

/** Employee count and hours for approved (and Excel-era) weeks, from `AttendanceRecord`. */
async function computeRecordStats(uploadIds: string[]): Promise<Map<string, UploadStats>> {
  const stats = new Map<string, UploadStats>()
  if (uploadIds.length === 0) return stats

  const [employeeGroups, hourSums] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ['attendanceUploadId', 'employeeId'],
      where: { attendanceUploadId: { in: uploadIds } },
    }),
    prisma.attendanceRecord.groupBy({
      by: ['attendanceUploadId'],
      where: { attendanceUploadId: { in: uploadIds } },
      _sum: { regularHours: true, overtimeHours: true },
    }),
  ])

  const employeeCounts = new Map<string, number>()
  for (const group of employeeGroups) {
    employeeCounts.set(group.attendanceUploadId, (employeeCounts.get(group.attendanceUploadId) ?? 0) + 1)
  }

  for (const id of uploadIds) {
    const sums = hourSums.find((h) => h.attendanceUploadId === id)
    stats.set(id, {
      ...EMPTY_STATS,
      employeeCount: employeeCounts.get(id) ?? 0,
      totalRegularHours: Number(sums?._sum.regularHours ?? 0),
      totalOvertimeHours: Number(sums?._sum.overtimeHours ?? 0),
    })
  }

  return stats
}

/**
 * The week list: active uploads (both sources), plus virtual rows for the current
 * in-progress week and the last completed week when they have no row yet, so Pull now
 * always has a target.
 */
export async function listAttendanceWeeks(todayISO: ISODate = todayInIST()): Promise<AttendanceWeekListItem[]> {
  const now = new Date()

  const uploads = await prisma.attendanceUpload.findMany({
    where: { isActiveForPayrollWeek: true },
    orderBy: { payrollWeekStartDate: 'desc' },
    take: WEEK_LIST_LIMIT,
  })

  const currentWeek = getCurrentPayrollWeek(todayISO)
  const completedWeek = weekFromStartISO(addDaysISO(currentWeek.start, -7))
  const present = new Set(uploads.map((u) => toISODate(u.payrollWeekStartDate)))
  const virtualWeeks = [currentWeek, completedWeek].filter((w) => !present.has(w.start))

  const weekStarts = [
    ...uploads.map((u) => u.payrollWeekStartDate),
    ...virtualWeeks.map((w) => toUtcDate(w.start)),
  ]
  const payrollRuns = await prisma.payrollRun.findMany({
    where: { payrollWeekStartDate: { in: weekStarts }, status: { in: ['APPROVED', 'REVISED'] } },
    select: { id: true, payrollWeekStartDate: true, status: true },
  })
  const runByWeek = new Map(payrollRuns.map((r) => [toISODate(r.payrollWeekStartDate), r]))

  const inReview = (u: AttendanceUpload) => getAttendanceWeekStatus(u) === 'REVIEW'
  const approved = (u: AttendanceUpload) => getAttendanceWeekStatus(u) === 'APPROVED'
  const [reviewStats, recordStats] = await Promise.all([
    computeReviewStats(uploads.filter(inReview)),
    computeRecordStats(uploads.filter(approved).map((u) => u.id)),
  ])

  const toItem = (week: WeekRange, upload: AttendanceUpload | null): AttendanceWeekListItem => {
    const run = runByWeek.get(week.start) ?? null
    const payrollStatus: WeekPayrollStatus = run ? (run.status === 'REVISED' ? 'REVISED' : 'APPROVED') : 'NOT_GENERATED'
    const source: AttendanceSource | null = upload ? (upload.source === 'EXCEL' ? 'EXCEL' : 'ETIMEOFFICE') : null
    const status = getAttendanceWeekStatus(upload)
    const stats = (upload && (reviewStats.get(upload.id) ?? recordStats.get(upload.id))) || EMPTY_STATS
    const isSyncing = upload?.syncLockedAt != null && now.getTime() - upload.syncLockedAt.getTime() < SYNC_LOCK_TTL_MS

    return {
      weekId: week.start,
      week,
      source,
      status,
      isSyncing,
      uploadId: upload?.id ?? null,
      ...stats,
      lastSyncError: upload?.lastSyncError ?? null,
      lastSyncAttemptAt: upload?.lastSyncAttemptAt?.toISOString() ?? null,
      lastSyncedAt: upload?.lastSyncedAt?.toISOString() ?? null,
      staleNoticeAt: upload?.staleNoticeAt?.toISOString() ?? null,
      fileName: upload?.fileName ?? null,
      payrollStatus,
      payrollRunId: run?.id ?? null,
      canPullNow: canPullNow({ source, status, payrollStatus, isSyncing, start: week.start }, todayISO),
      canReopen: canReopenWeek({ source, status, payrollStatus }),
      hasEnded: hasWeekEnded(week, todayISO),
    }
  }

  return [
    ...uploads.map((u) => toItem({ start: toISODate(u.payrollWeekStartDate), end: toISODate(u.payrollWeekEndDate) }, u)),
    ...virtualWeeks.map((w) => toItem(w, null)),
  ].sort((a, b) => (a.weekId < b.weekId ? 1 : a.weekId > b.weekId ? -1 : 0))
}
