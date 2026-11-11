import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import {
  deleteFile,
  ATTENDANCE_BUCKET,
} from '@/lib/supabase-storage'
import type { AttendanceUpload, Prisma } from '@prisma/client'
import type {
  MatchedAttendanceRecord,
  PayrollWeekSource,
  AttendanceUploadResult,
} from '@/features/attendance-upload/types/attendance.types'

// ─── createAttendanceUpload ───────────────────────────────────────────────────

export interface CreateUploadParams {
  storageKey: string             // Supabase Storage key (replaces newFilePath)
  newFileName: string
  fileType: string
  payrollWeekStartDate: Date
  payrollWeekEndDate: Date
  payrollWeekSource: PayrollWeekSource
  status: string
  records: MatchedAttendanceRecord[]
  payrollWeekStartISO: string // YYYY-MM-DD
}

export async function createAttendanceUpload(
  params: CreateUploadParams
): Promise<AttendanceUploadResult> {
  const {
    storageKey,
    newFileName,
    fileType,
    payrollWeekStartDate,
    payrollWeekEndDate,
    payrollWeekSource,
    status,
    records,
    payrollWeekStartISO,
  } = params

  const uploadId = randomUUID()
  const rowsToInsert = buildAttendanceRecords(uploadId, records, payrollWeekStartISO)

  const promises: Prisma.PrismaPromise<unknown>[] = [
    prisma.attendanceUpload.create({
      data: {
        id: uploadId,
        fileName: newFileName,
        fileType,
        payrollWeekStartDate,
        payrollWeekEndDate,
        payrollWeekSource,
        status,
        isActiveForPayrollWeek: true,
        sourceStorageKey: storageKey,
      },
    }),
  ]

  if (rowsToInsert.length > 0) {
    promises.push(prisma.attendanceRecord.createMany({ data: rowsToInsert }))
  }

  await prisma.$transaction(promises, { timeout: 30000 })

  return {
    uploadId,
    payrollWeekStartDate,
    payrollWeekEndDate,
    payrollWeekSource,
    status,
    isActiveForPayrollWeek: true,
  }
}

// ─── replaceAttendanceUpload ──────────────────────────────────────────────────

export interface ReplaceUploadParams extends CreateUploadParams {
  previousUpload: AttendanceUpload
}

export async function replaceAttendanceUpload(
  params: ReplaceUploadParams
): Promise<AttendanceUploadResult> {
  const { previousUpload, ...createParams } = params

  // Best-effort delete of the old file from Supabase Storage.
  // This runs outside the DB transaction — if it fails the DB row is still updated.
  if (previousUpload.sourceStorageKey) {
    void deleteFile(ATTENDANCE_BUCKET, previousUpload.sourceStorageKey).catch((err) => {
      console.error('[upload.service] Failed to delete old storage file:', err)
    })
  }

  const uploadId = randomUUID()
  const rowsToInsert = buildAttendanceRecords(
    uploadId,
    createParams.records,
    createParams.payrollWeekStartISO
  )

  const promises: Prisma.PrismaPromise<unknown>[] = [
    // Deactivate old upload
    prisma.attendanceUpload.update({
      where: { id: previousUpload.id },
      data: { isActiveForPayrollWeek: false },
    }),
    // Create new upload as active
    prisma.attendanceUpload.create({
      data: {
        id: uploadId,
        fileName: createParams.newFileName,
        fileType: createParams.fileType,
        payrollWeekStartDate: createParams.payrollWeekStartDate,
        payrollWeekEndDate: createParams.payrollWeekEndDate,
        payrollWeekSource: createParams.payrollWeekSource,
        status: createParams.status,
        isActiveForPayrollWeek: true,
        sourceStorageKey: createParams.storageKey,
      },
    }),
  ]

  if (rowsToInsert.length > 0) {
    promises.push(prisma.attendanceRecord.createMany({ data: rowsToInsert }))
  }

  await prisma.$transaction(promises, { timeout: 30000 })

  return {
    uploadId,
    payrollWeekStartDate: createParams.payrollWeekStartDate,
    payrollWeekEndDate: createParams.payrollWeekEndDate,
    payrollWeekSource: createParams.payrollWeekSource,
    status: createParams.status,
    isActiveForPayrollWeek: true,
  }
}

// ─── buildAttendanceRecords ────────────────────────────────────────────────────

function buildAttendanceRecords(
  uploadId: string,
  records: MatchedAttendanceRecord[],
  payrollWeekStartISO: string // YYYY-MM-DD — base date for day offsets
) {
  const baseDate = new Date(payrollWeekStartISO + 'T00:00:00Z')

  const matchedRecords = records.filter(
    (r) =>
      (r.matchStatus === 'MATCHED' ||
        r.matchStatus === 'MANUALLY_MATCHED' ||
        ((r.matchStatus === 'INACTIVE' || r.matchStatus === 'RESIGNED_BEFORE_WEEK') &&
          r.verificationDecision !== 'REJECTED')) &&
      r.employeeDbId
  )

  if (matchedRecords.length === 0) return []

  return matchedRecords.flatMap((record) =>
    record.dailyHours.map((dh, dayIndex) => {
      const date = new Date(baseDate)
      date.setUTCDate(date.getUTCDate() + dayIndex)
      return {
        attendanceUploadId: uploadId,
        employeeId: record.employeeDbId!,
        attendanceDate: date,
        regularHours: dh.regularHours,
        overtimeHours: dh.overtimeHours,
        beforeNoonIn: dh.beforeNoonIn,
        beforeNoonOut: dh.beforeNoonOut,
        afternoonIn: dh.afternoonIn,
        afternoonOut: dh.afternoonOut,
        overtimeIn: dh.overtimeIn,
        overtimeOut: dh.overtimeOut,
        sourceSheetName: record.sourceSheetName,
        sourceEmployeeBlockIndex: record.sourceEmployeeBlockIndex,
        verificationDecision: record.verificationDecision ?? null,
      }
    })
  )
}
