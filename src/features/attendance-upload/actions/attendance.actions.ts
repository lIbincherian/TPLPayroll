'use server'

import * as XLSX from 'xlsx'
import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import {
  createPresignedUploadUrl,
  downloadFileAsBuffer,
  deleteFile,
  fileExists,
  ATTENDANCE_BUCKET,
} from '@/lib/supabase-storage'
import { validateAttendanceFile } from '@/features/attendance-upload/services/file-validator.service'
import { detectPayrollWeek } from '@/features/attendance-upload/services/week-detector.service'
import { parseAttendanceWorkbook } from '@/features/attendance-upload/services/workbook-parser.service'
import { matchEmployees } from '@/features/attendance-upload/services/employee-matcher.service'
import { computeImportSummary } from '@/features/attendance-upload/services/import-summary.service'
import {
  createAttendanceUpload,
  replaceAttendanceUpload,
} from '@/features/attendance-upload/services/upload.service'
import {
  createUploadSession,
  loadUploadSession,
  type SessionDecisions,
} from '@/features/attendance-upload/services/upload-session.service'
import type {
  ActionResult,
  MatchedAttendanceRecord,
  MatchStatus,
  PayrollWeekSource,
  PayrollWeekDetectionResult,
  ImportSummary,
  VerificationDecision,
} from '@/features/attendance-upload/types/attendance.types'
import { getBlockKey } from '@/features/attendance-upload/types/attendance.types'

// ─── getPresignedUploadUrlAction ──────────────────────────────────────────────
// Step 1 of the new upload flow: browser requests a presigned PUT URL, then
// uploads the Excel file directly to Supabase Storage — never through Vercel.

export interface PresignedUploadResult {
  signedUrl: string
  storageKey: string
  token: string
}

export async function getPresignedUploadUrlAction(
  fileName: string
): Promise<ActionResult<PresignedUploadResult>> {
  const validation = validateAttendanceFile(fileName)
  if (!validation.ok) {
    return {
      ok: false,
      error: 'Unsupported file type. Please upload .xls or .xlsx.',
      code: validation.error,
    }
  }

  try {
    const storageKey = `attendance/${randomUUID()}_${fileName}`
    const result = await createPresignedUploadUrl(ATTENDANCE_BUCKET, storageKey)
    return { ok: true, data: result }
  } catch (err) {
    console.error('[getPresignedUploadUrlAction] Failed to create presigned URL:', err)
    return { ok: false, error: 'Failed to prepare upload. Please try again.' }
  }
}

// ─── Shared: download + parse helpers ────────────────────────────────────────

async function downloadAndParseWorkbook(
  storageKey: string
): Promise<{ wb: XLSX.WorkBook } | { error: string }> {
  let buffer: Buffer
  try {
    buffer = await downloadFileAsBuffer(ATTENDANCE_BUCKET, storageKey)
  } catch (err) {
    console.error('[attendance.actions] Failed to download from Storage:', err)
    return { error: 'Could not retrieve the uploaded file. Please upload again.' }
  }

  try {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    return { wb }
  } catch {
    return { error: 'Failed to parse the file. Ensure it is a valid Excel workbook.' }
  }
}

// ─── parseFromStorageAction ───────────────────────────────────────────────────
// Step 2 of the upload flow: server downloads from Storage, parses, detects week.
// Returns a lean result — records[] are NOT returned here (week may be MANUAL_REQUIRED).

export interface ParseFromStorageResult {
  storageKey: string
  fileName: string
  fileType: string
  payrollWeek: PayrollWeekDetectionResult
  records: MatchedAttendanceRecord[]
  summary: ImportSummary
}

export async function parseFromStorageAction(
  storageKey: string,
  fileName: string,
  fileType: string
): Promise<ActionResult<ParseFromStorageResult>> {
  const parsed = await downloadAndParseWorkbook(storageKey)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const { wb } = parsed

  const payrollWeek = detectPayrollWeek(wb, fileName)

  if (payrollWeek.source === 'MANUAL_REQUIRED') {
    const { blocks } = parseAttendanceWorkbook(wb)
    return {
      ok: true,
      data: {
        storageKey,
        fileName,
        fileType,
        payrollWeek,
        records: [],
        summary: {
          total: blocks.length,
          matched: 0,
          unmatched: 0,
          inactive: 0,
          resignedBeforeWeek: 0,
          rejectedUnmatched: 0,
          needsVerification: 0,
          errors: 0,
          isBlocked: true,
        },
      },
    }
  }

  const employees = await prisma.employee.findMany()
  const weekStart = new Date(payrollWeek.start + 'T00:00:00Z')
  const weekEnd = new Date(payrollWeek.end + 'T00:00:00Z')
  const { blocks } = parseAttendanceWorkbook(wb)
  const records = matchEmployees(blocks, employees, weekStart, weekEnd)
  const summary = computeImportSummary(records)

  return {
    ok: true,
    data: { storageKey, fileName, fileType, payrollWeek, records, summary },
  }
}

// ─── parseFromStorageWithDatesAction ─────────────────────────────────────────
// Used after manual week selection: re-downloads from Storage, parses with
// user-supplied dates.

export async function parseFromStorageWithDatesAction(
  storageKey: string,
  payrollWeekStartDate: string, // YYYY-MM-DD
  payrollWeekEndDate: string,
  fileName: string,
  fileType: string
): Promise<ActionResult<ParseFromStorageResult>> {
  const inStorage = await fileExists(ATTENDANCE_BUCKET, storageKey)
  if (!inStorage) {
    return {
      ok: false,
      error: 'Uploaded file no longer available. Please upload again.',
      code: 'FILE_NOT_FOUND',
    }
  }

  const parsed = await downloadAndParseWorkbook(storageKey)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const { wb } = parsed

  const { blocks } = parseAttendanceWorkbook(wb)
  const employees = await prisma.employee.findMany()
  const weekStart = new Date(payrollWeekStartDate + 'T00:00:00Z')
  const weekEnd = new Date(payrollWeekEndDate + 'T00:00:00Z')
  const records = matchEmployees(blocks, employees, weekStart, weekEnd)
  const summary = computeImportSummary(records)

  return {
    ok: true,
    data: {
      storageKey,
      fileName,
      fileType,
      payrollWeek: { source: 'MANUAL', start: payrollWeekStartDate, end: payrollWeekEndDate },
      records,
      summary,
    },
  }
}

// ─── getRecordsFromStorageAction ──────────────────────────────────────────────
// Called by the client hydration effect after session resume.
// Fetches records WITHOUT going through an RSC prop — response size has no 4.5 MB cap.

export async function getRecordsFromStorageAction(
  storageKey: string,
  payrollWeekStartDate: string,
  payrollWeekEndDate: string,
  fileName: string,
  fileType: string
): Promise<ActionResult<{ records: MatchedAttendanceRecord[]; summary: ImportSummary }>> {
  const result = await parseFromStorageWithDatesAction(
    storageKey,
    payrollWeekStartDate,
    payrollWeekEndDate,
    fileName,
    fileType
  )
  if (!result.ok) return result
  return { ok: true, data: { records: result.data.records, summary: result.data.summary } }
}

// ─── finalizeAttendanceUploadAction ──────────────────────────────────────────

export interface FinalizeUploadInput {
  storageKey: string
  fileName: string
  fileType: string
  payrollWeekStartDate: string // ISO date string YYYY-MM-DD
  payrollWeekEndDate: string
  payrollWeekSource: PayrollWeekSource
  verificationDecisions?: Record<string, VerificationDecision>
  manualMatchDecisions?: Record<string, string>
  rejectedBlockKeys?: string[]
}

export async function finalizeAttendanceUploadAction(
  input: FinalizeUploadInput
): Promise<ActionResult<{ uploadId: string }>> {
  const {
    storageKey,
    fileName,
    fileType,
    payrollWeekStartDate,
    payrollWeekEndDate,
    payrollWeekSource,
    verificationDecisions = {},
    manualMatchDecisions = {},
    rejectedBlockKeys = [],
  } = input

  // Always re-parse server-side — records never travel as Server Action arguments.
  const parsed = await parseFromStorageWithDatesAction(
    storageKey,
    payrollWeekStartDate,
    payrollWeekEndDate,
    fileName,
    fileType
  )
  if (!parsed.ok) return { ok: false, error: parsed.error, code: parsed.code }

  const weekStart = new Date(payrollWeekStartDate + 'T00:00:00Z')
  const weekEnd = new Date(payrollWeekEndDate + 'T00:00:00Z')
  const rejectedKeySet = new Set(rejectedBlockKeys)

  // Apply manual matches and rejections to UNMATCHED records
  const recordsWithManualMatches = parsed.data.records.map((r) => {
    if (r.matchStatus !== 'UNMATCHED') return r
    const blockKey = getBlockKey(r)
    const matchedId = manualMatchDecisions[blockKey]
    if (matchedId) {
      return {
        ...r,
        employeeDbId: matchedId,
        matchStatus: 'MANUALLY_MATCHED' as MatchStatus,
        isBlocking: false,
      }
    }
    if (rejectedKeySet.has(blockKey)) {
      return {
        ...r,
        matchStatus: 'REJECTED_UNMATCHED' as MatchStatus,
        isBlocking: false,
      }
    }
    return r
  })

  // Merge verification decisions onto records
  const recordsWithDecisions = recordsWithManualMatches.map((r) =>
    r.employeeDbId && verificationDecisions[r.employeeDbId]
      ? { ...r, verificationDecision: verificationDecisions[r.employeeDbId] }
      : r
  )

  const recomputedSummary = computeImportSummary(recordsWithDecisions)
  const status = recomputedSummary.isBlocked ? 'ERRORS' : 'READY'

  // Check for existing upload for this week
  const existing = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      isActiveForPayrollWeek: true,
    },
  })

  if (existing) {
    const result = await replaceAttendanceUpload({
      previousUpload: existing,
      storageKey,
      newFileName: fileName,
      fileType,
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      payrollWeekSource,
      status,
      records: recordsWithDecisions,
      payrollWeekStartISO: payrollWeekStartDate,
    })
    return { ok: true, data: { uploadId: result.uploadId } }
  }

  const result = await createAttendanceUpload({
    storageKey,
    newFileName: fileName,
    fileType,
    payrollWeekStartDate: weekStart,
    payrollWeekEndDate: weekEnd,
    payrollWeekSource,
    status,
    records: recordsWithDecisions,
    payrollWeekStartISO: payrollWeekStartDate,
  })
  return { ok: true, data: { uploadId: result.uploadId } }
}

// ─── getEmployeesForMatchingAction ────────────────────────────────────────────

export interface EmployeeOption {
  id: string
  employeeId: string
  employeeName: string
}

export async function getEmployeesForMatchingAction(): Promise<ActionResult<EmployeeOption[]>> {
  const employees = await prisma.employee.findMany({
    select: { id: true, employeeId: true, employeeName: true },
    orderBy: { employeeName: 'asc' },
  })
  return { ok: true, data: employees }
}

// ─── getAttendanceUploadsAction ───────────────────────────────────────────────

export interface AttendanceUploadRow {
  id: string
  fileName: string
  payrollWeekStartDate: string
  payrollWeekEndDate: string
  status: string
  uploadedAt: string
}

export async function getAttendanceUploadsAction(): Promise<ActionResult<AttendanceUploadRow[]>> {
  const uploads = await prisma.attendanceUpload.findMany({
    where: { isActiveForPayrollWeek: true },
    orderBy: { payrollWeekStartDate: 'desc' },
    take: 20,
  })

  return {
    ok: true,
    data: uploads.map((u) => ({
      id: u.id,
      fileName: u.fileName ?? '',
      payrollWeekStartDate: u.payrollWeekStartDate.toISOString().slice(0, 10),
      payrollWeekEndDate: u.payrollWeekEndDate.toISOString().slice(0, 10),
      status: u.status,
      uploadedAt: u.uploadedAt.toISOString(),
    })),
  }
}

// ─── getAttendanceUploadPreviewAction ─────────────────────────────────────────

export interface AttendancePreviewData {
  upload: AttendanceUploadRow
  records: {
    id: string
    employeeName: string
    employeeId: string
    totalRegularHours: number
    totalOvertimeHours: number
    sourceSheetName: string | null
  }[]
}

export async function getAttendanceUploadPreviewAction(
  uploadId: string
): Promise<ActionResult<AttendancePreviewData>> {
  const upload = await prisma.attendanceUpload.findUnique({
    where: { id: uploadId },
  })
  if (!upload) return { ok: false, error: 'Upload not found' }

  // Re-parse from Supabase Storage to show ALL records (matched and unmatched)
  if (upload.sourceStorageKey) {
    try {
      const parsed = await downloadAndParseWorkbook(upload.sourceStorageKey)
      if (!('error' in parsed)) {
        const { wb } = parsed
        const { blocks } = parseAttendanceWorkbook(wb)
        const employees = await prisma.employee.findMany()
        const records = matchEmployees(
          blocks,
          employees,
          upload.payrollWeekStartDate,
          upload.payrollWeekEndDate
        )

        // Overlay saved verification decisions from DB
        const savedRows = await prisma.attendanceRecord.findMany({
          where: { attendanceUploadId: uploadId },
          select: { sourceSheetName: true, sourceEmployeeBlockIndex: true, verificationDecision: true },
        })
        const savedByBlockKey = new Map<string, { verificationDecision: string | null }>()
        for (const row of savedRows) {
          const key = `${row.sourceSheetName ?? ''}||${row.sourceEmployeeBlockIndex}`
          if (!savedByBlockKey.has(key)) {
            savedByBlockKey.set(key, { verificationDecision: row.verificationDecision })
          }
        }

        return {
          ok: true,
          data: {
            upload: {
              id: upload.id,
              fileName: upload.fileName ?? '',
              payrollWeekStartDate: upload.payrollWeekStartDate.toISOString().slice(0, 10),
              payrollWeekEndDate: upload.payrollWeekEndDate.toISOString().slice(0, 10),
              status: upload.status,
              uploadedAt: upload.uploadedAt.toISOString(),
            },
            records: records.map((r, i) => {
              const blockKey = `${r.sourceSheetName ?? ''}||${r.sourceEmployeeBlockIndex}`
              const saved = savedByBlockKey.get(blockKey)
              const matchStatus =
                r.matchStatus === 'UNMATCHED' && saved ? 'MANUALLY_MATCHED' : r.matchStatus
              return {
                id: `preview-${i}`,
                employeeName: r.employeeName,
                employeeId: r.employeeDbId || '—',
                totalRegularHours: r.totalRegularHours,
                totalOvertimeHours: r.totalOvertimeHours,
                sourceSheetName: r.sourceSheetName,
                matchStatus,
                isBlocking: matchStatus === 'UNMATCHED',
                verificationDecision: saved?.verificationDecision ?? null,
              }
            }),
          },
        }
      }
    } catch (err) {
      console.error('Failed to re-parse upload from Storage for preview:', err)
    }
  }

  // Fallback to saved DB records if Storage key is missing (legacy rows)
  const records = await prisma.attendanceRecord.findMany({
    where: { attendanceUploadId: uploadId },
    include: { employee: { select: { id: true, employeeId: true, employeeName: true } } },
    distinct: ['employeeId'],
    orderBy: { sourceSheetName: 'asc' },
  })

  const grouped = new Map<string, (typeof records)[0][]>()
  for (const r of records) {
    const key = r.employeeId
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(r)
  }

  const summaryRows = Array.from(grouped.entries()).map(([, recs]) => {
    const first = recs[0]
    const totalRegular = recs.reduce((sum, r) => sum + Number(r.regularHours), 0)
    const totalOT = recs.reduce((sum, r) => sum + Number(r.overtimeHours), 0)
    return {
      id: first.id,
      employeeName: first.employee.employeeName,
      employeeId: first.employee.id,
      totalRegularHours: Math.round(totalRegular * 100) / 100,
      totalOvertimeHours: Math.round(totalOT * 100) / 100,
      sourceSheetName: first.sourceSheetName,
      matchStatus: 'MATCHED' as const,
      isBlocking: false,
    }
  })

  return {
    ok: true,
    data: {
      upload: {
        id: upload.id,
        fileName: upload.fileName ?? '',
        payrollWeekStartDate: upload.payrollWeekStartDate.toISOString().slice(0, 10),
        payrollWeekEndDate: upload.payrollWeekEndDate.toISOString().slice(0, 10),
        status: upload.status,
        uploadedAt: upload.uploadedAt.toISOString(),
      },
      records: summaryRows,
    },
  }
}

// ─── createAttendanceUploadSessionAction ─────────────────────────────────────

export interface CreateUploadSessionInput {
  storageKey: string
  fileName: string
  fileType: string
  payrollWeekStartDate: string // YYYY-MM-DD
  payrollWeekEndDate: string
  payrollWeekSource: PayrollWeekSource
  verificationDecisions: Record<string, VerificationDecision>
  manualMatchDecisions: Record<string, string>
  rejectedBlockKeys: string[]
  pendingBlockKey: string
  pendingSheetEmployeeName: string
}

export async function createAttendanceUploadSessionAction(
  input: CreateUploadSessionInput
): Promise<ActionResult<{ sessionId: string; pendingSheetEmployeeName: string }>> {
  const decisions: SessionDecisions = {
    verificationDecisions: input.verificationDecisions,
    manualMatchDecisions: input.manualMatchDecisions,
    rejectedBlockKeys: input.rejectedBlockKeys,
  }

  // Store the pending sheet name inside decisionsJson under a reserved key
  const decisionsForStore = {
    ...decisions,
    _pendingSheetEmployeeName: input.pendingSheetEmployeeName,
  } as SessionDecisions & { _pendingSheetEmployeeName: string }

  const session = await createUploadSession({
    storageKey: input.storageKey,
    fileName: input.fileName,
    fileType: input.fileType,
    weekStart: input.payrollWeekStartDate,
    weekEnd: input.payrollWeekEndDate,
    weekSource: input.payrollWeekSource,
    decisions: decisionsForStore,
    pendingBlockKey: input.pendingBlockKey,
  })

  return {
    ok: true,
    data: {
      sessionId: session.id,
      pendingSheetEmployeeName: input.pendingSheetEmployeeName,
    },
  }
}

// ─── getAttendanceUploadSessionAction ────────────────────────────────────────

export async function getAttendanceUploadSessionAction(
  sessionId: string
): Promise<ActionResult<{ pendingSheetEmployeeName: string }>> {
  const session = await loadUploadSession(sessionId)
  if (!session) {
    return {
      ok: false,
      error: 'Upload session expired. Please re-upload the attendance file.',
      code: 'SESSION_EXPIRED',
    }
  }
  const stored = session.decisions as SessionDecisions & { _pendingSheetEmployeeName?: string }
  return {
    ok: true,
    data: {
      pendingSheetEmployeeName: stored._pendingSheetEmployeeName ?? '',
    },
  }
}

// ─── resumeAttendanceUploadSessionAction ─────────────────────────────────────
// Returns lean metadata only — NO records[].
// The client hydration effect calls getRecordsFromStorageAction separately.
// This keeps the RSC prop tiny (no 4.5 MB crash).

export interface ResumedSessionMetadata {
  storageKey: string
  fileName: string
  fileType: string
  payrollWeekStartDate: string
  payrollWeekEndDate: string
  payrollWeekSource: PayrollWeekSource
  verificationDecisions: Record<string, VerificationDecision>
  manualMatchDecisions: Record<string, string>
  rejectedBlockKeys: string[]
}

export async function resumeAttendanceUploadSessionAction(
  sessionId: string,
  newEmployeeId: string
): Promise<ActionResult<ResumedSessionMetadata>> {
  const session = await loadUploadSession(sessionId)
  if (!session) {
    return {
      ok: false,
      error: 'Upload session expired. Please re-upload the attendance file.',
      code: 'SESSION_EXPIRED',
    }
  }

  // Link the new employee to the pending blockKey
  const manualMatchDecisions = {
    ...session.decisions.manualMatchDecisions,
    [session.pendingBlockKey]: newEmployeeId,
  }

  // Return ONLY lean metadata — records are fetched client-side via getRecordsFromStorageAction
  return {
    ok: true,
    data: {
      storageKey: session.storageKey,
      fileName: session.fileName,
      fileType: session.fileType,
      payrollWeekStartDate: session.weekStart,
      payrollWeekEndDate: session.weekEnd,
      payrollWeekSource: session.weekSource,
      verificationDecisions: session.decisions.verificationDecisions ?? {},
      manualMatchDecisions,
      rejectedBlockKeys: session.decisions.rejectedBlockKeys ?? [],
    },
  }
}
