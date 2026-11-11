import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Supabase Storage — replaceAttendanceUpload now calls deleteFile
vi.mock('@/lib/supabase-storage', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
  ATTENDANCE_BUCKET: 'attendance-files',
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    attendanceUpload: {
      update: vi.fn(),
      create: vi.fn(),
    },
    attendanceRecord: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { replaceAttendanceUpload } from './upload.service'
import prisma from '@/lib/prisma'
import * as supabaseStorage from '@/lib/supabase-storage'
import type { AttendanceUpload } from '@prisma/client'
import type { MatchedAttendanceRecord } from '@/features/attendance-upload/types/attendance.types'

function makeUpload(overrides: Partial<AttendanceUpload> = {}): AttendanceUpload {
  return {
    id: 'upload-1',
    fileName: 'attendance.xlsx',
    fileType: 'xlsx',
    payrollWeekStartDate: new Date('2025-05-01T00:00:00Z'),
    payrollWeekEndDate: new Date('2025-05-07T00:00:00Z'),
    payrollWeekSource: 'SHEET_CONTENT',
    status: 'READY',
    isActiveForPayrollWeek: true,
    uploadedBy: null,
    uploadedAt: new Date('2025-05-08T00:00:00Z'),
    sourceStorageKey: null,
    ...overrides,
  }
}

function makeMatchedRecord(): MatchedAttendanceRecord {
  return {
    employeeName: 'Ravi Kumar',
    site: null,
    sourceSheetName: 'Sheet1',
    sourceEmployeeBlockIndex: 0,
    totalRegularHours: 8,
    totalOvertimeHours: 0,
    dailyHours: [
      {
        regularHours: 8,
        overtimeHours: 0,
        beforeNoonIn: null,
        beforeNoonOut: null,
        afternoonIn: null,
        afternoonOut: null,
        overtimeIn: null,
        overtimeOut: null,
      },
    ],
    parseErrors: [],
    matchStatus: 'MATCHED',
    isBlocking: false,
    employeeDbId: 'emp-1',
  }
}

describe('upload.service - replaceAttendanceUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(async (promises) => {
      if (Array.isArray(promises)) {
        return Promise.all(promises)
      }
      return promises
    })
  })

  it('should deactivate the old upload, delete old Storage file, and create a new one', async () => {
    const oldUploadId = 'old-id'
    const payrollWeekStart = new Date('2025-05-01T00:00:00Z')
    const payrollWeekEnd = new Date('2025-05-07T00:00:00Z')

    const previousUpload = makeUpload({
      id: oldUploadId,
      sourceStorageKey: 'attendance/old-uuid_attendance.xlsx',
      isActiveForPayrollWeek: true,
      payrollWeekStartDate: payrollWeekStart,
      payrollWeekEndDate: payrollWeekEnd,
    })

    const params = {
      previousUpload,
      storageKey: 'attendance/new-uuid_attendance.xlsx',
      newFileName: 'new.xlsx',
      fileType: 'xlsx',
      payrollWeekStartDate: payrollWeekStart,
      payrollWeekEndDate: payrollWeekEnd,
      payrollWeekSource: 'SHEET_CONTENT' as const,
      status: 'READY',
      records: [makeMatchedRecord()],
      payrollWeekStartISO: '2025-05-01',
    }

    vi.mocked(prisma.attendanceUpload.update).mockResolvedValue(
      makeUpload({ id: oldUploadId, isActiveForPayrollWeek: false })
    )
    vi.mocked(prisma.attendanceUpload.create).mockResolvedValue(
      makeUpload({ id: 'new-id-1', isActiveForPayrollWeek: true })
    )
    vi.mocked(prisma.attendanceRecord.createMany).mockResolvedValue({ count: 1 })

    const result = await replaceAttendanceUpload(params)

    // Storage file deleted for the previous upload
    expect(supabaseStorage.deleteFile).toHaveBeenCalledWith(
      'attendance-files',
      previousUpload.sourceStorageKey
    )

    expect(prisma.attendanceUpload.update).toHaveBeenCalledWith({
      where: { id: oldUploadId },
      data: { isActiveForPayrollWeek: false },
    })

    expect(prisma.attendanceUpload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fileName: 'new.xlsx',
        isActiveForPayrollWeek: true,
        sourceStorageKey: params.storageKey,
      }),
    })

    expect(prisma.attendanceRecord.createMany).toHaveBeenCalled()
    expect(result.uploadId).toBeDefined()
    expect(result.isActiveForPayrollWeek).toBe(true)
  })

  it('should still proceed if the previous upload has no Storage key (legacy row)', async () => {
    const previousUpload = makeUpload({
      id: 'old-id',
      sourceStorageKey: null, // legacy row — no storage key
    })

    const params = {
      previousUpload,
      storageKey: 'attendance/new-uuid_attendance.xlsx',
      newFileName: 'new.xlsx',
      fileType: 'xlsx',
      payrollWeekStartDate: new Date(),
      payrollWeekEndDate: new Date(),
      payrollWeekSource: 'SHEET_CONTENT' as const,
      status: 'READY',
      records: [] as MatchedAttendanceRecord[],
      payrollWeekStartISO: '2025-05-01',
    }

    vi.mocked(prisma.attendanceUpload.update).mockResolvedValue(makeUpload({ id: 'old-id' }))
    vi.mocked(prisma.attendanceUpload.create).mockResolvedValue(makeUpload({ id: 'new-id' }))

    await replaceAttendanceUpload(params)

    // No delete attempted for legacy rows with no storage key
    expect(supabaseStorage.deleteFile).not.toHaveBeenCalled()
    expect(prisma.attendanceUpload.update).toHaveBeenCalled()
  })
})
