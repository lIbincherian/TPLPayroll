import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CorrectionFlow } from '../CorrectionFlow'
import type { InitiateCorrectionResult } from '@/features/payroll-correction/types/correction.types'
import { finalizeAttendanceUploadAction, getEmployeesForMatchingAction, getPresignedUploadUrlAction, parseFromStorageAction } from '@/features/attendance-upload/actions/attendance.actions'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/features/attendance-upload/actions/attendance.actions', () => ({
  getPresignedUploadUrlAction: vi.fn(),
  parseFromStorageAction: vi.fn(),
  parseFromStorageWithDatesAction: vi.fn(),
  finalizeAttendanceUploadAction: vi.fn(),
  getEmployeesForMatchingAction: vi.fn(),
}))

vi.mock('@/features/payroll-correction/actions/correction.actions', () => ({
  recalculateAndCreateRevisionAction: vi.fn(),
}))

// ─── Fixture ──────────────────────────────────────────────────────────────────

const MOCK_CORRECTION_DATA: InitiateCorrectionResult = {
  payrollRunId: 'run-uuid-1',
  revisionId: 'revision-uuid-1',
  revisionNumber: 1,
  weekStart: new Date('2025-03-06T00:00:00.000Z'),
  weekEnd: new Date('2025-03-12T00:00:00.000Z'),
  totals: {
    totalRegularHours: 40,
    totalOvertimeHours: 5,
    totalRegularPay: 1000,
    totalOvertimePay: 150,
    totalAdditions: 0,
    totalDeductions: 0,
    totalNetPayable: 1150,
  },
  employees: [],
  adjustmentApplications: [],
}

describe('CorrectionFlow — Attendance Re-upload Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Mock XMLHttpRequest so the XHR PUT to Supabase Storage resolves immediately in jsdom.
    // Must be a class (not a plain object) because AttendanceDropzone calls `new XMLHttpRequest()`.
    class MockXHR {
      status = 200
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      open = vi.fn()
      setRequestHeader = vi.fn()
      send = vi.fn().mockImplementation(() => {
        setTimeout(() => this.onload?.(), 0)
      })
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR)
  })

  // ── Test 1: Renders interactive dropzone when ATTENDANCE is selected ──────
  it('renders interactive AttendanceDropzone when Attendance correction option is checked', async () => {
    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" />)

    // Initially dropzone should not be in the document
    expect(screen.queryByText(/Drag and drop your attendance file here/i)).not.toBeInTheDocument()

    // Check the Attendance checkbox
    const attendanceCheckbox = screen.getByRole('checkbox', { name: /attendance/i })
    fireEvent.click(attendanceCheckbox)

    // Now the interactive dropzone should be present
    expect(screen.getByText(/Drag and drop your attendance file here/i)).toBeInTheDocument()
  })

  // ── Test 2: Shows error if uploaded attendance week mismatches ─────────────
  it('shows validation error if the uploaded attendance file does not match the payroll run week', async () => {
    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" />)

    // Select Attendance
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    // Mock 3-phase upload: presigned URL → (browser PUT is bypassed in tests) → server parse
    vi.mocked(getPresignedUploadUrlAction).mockResolvedValue({
      ok: true,
      data: { signedUrl: 'https://storage.test/signed-url', storageKey: 'attendance/uuid_attendance.xlsx', token: 'tok' },
    })
    vi.mocked(parseFromStorageAction).mockResolvedValue({
      ok: true,
      data: {
        storageKey: 'attendance/uuid_attendance.xlsx',
        fileName: 'attendance.xlsx',
        fileType: 'xlsx',
        payrollWeek: {
          source: 'FILE_NAME',
          start: '2025-03-13', // Wrong week start
          end: '2025-03-19',   // Wrong week end
        },
        records: [],
        summary: {
          total: 0, matched: 0, unmatched: 0, inactive: 0,
          resignedBeforeWeek: 0, rejectedUnmatched: 0,
          needsVerification: 0, errors: 0, isBlocked: false,
        },
      },
    })

    // Simulate file input change
    const file = new File([''], 'attendance.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const fileInput = document.getElementById('attendance-dropzone-trigger')!

    fireEvent.change(fileInput, { target: { files: [file] } })

    // Click Upload & Preview button in Dropzone
    const uploadBtn = screen.getByRole('button', { name: /upload & preview/i })
    fireEvent.click(uploadBtn)

    // Verify validation error is shown
    await waitFor(() => {
      expect(screen.getByText(/The uploaded attendance file is for a different week. Please upload the correct file for this payroll run./i)).toBeInTheDocument()
    })
  })

  // ── Test 3: Successful matching week enables Recalculate ───────────────────
  it('finalizes upload and enables recalculate when attendance week matches exactly', async () => {
    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" />)

    // Select Attendance
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    // Mismatched week starts out. Initially Recalculate should be disabled when selectedTypes size > 0 but files are missing
    const recalculateBtn = screen.getByRole('button', { name: /recalculate & preview/i })
    expect(recalculateBtn).toBeDisabled()

    // Mock 3-phase upload: presigned URL → (browser PUT is bypassed in tests) → server parse
    vi.mocked(getPresignedUploadUrlAction).mockResolvedValue({
      ok: true,
      data: { signedUrl: 'https://storage.test/signed-url', storageKey: 'attendance/uuid_attendance.xlsx', token: 'tok' },
    })
    vi.mocked(parseFromStorageAction).mockResolvedValue({
      ok: true,
      data: {
        storageKey: 'attendance/uuid_attendance.xlsx',
        fileName: 'attendance.xlsx',
        fileType: 'xlsx',
        payrollWeek: {
          source: 'FILE_NAME',
          start: '2025-03-06', // Matching week start
          end: '2025-03-12',   // Matching week end
        },
        records: [],
        summary: {
          total: 0, matched: 0, unmatched: 0, inactive: 0,
          resignedBeforeWeek: 0, rejectedUnmatched: 0,
          needsVerification: 0, errors: 0, isBlocked: false,
        },
      },
    })

    // Mock finalize action
    vi.mocked(finalizeAttendanceUploadAction).mockResolvedValue({
      ok: true,
      data: { uploadId: 'new-upload-uuid' },
    })

    // Upload
    const file = new File([''], 'attendance.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const fileInput = document.getElementById('attendance-dropzone-trigger')!
    fireEvent.change(fileInput, { target: { files: [file] } })

    const uploadBtn = screen.getByRole('button', { name: /upload & preview/i })
    fireEvent.click(uploadBtn)

    // Wait for finalize action to be called and recalculate button to be enabled
    await waitFor(() => {
      expect(finalizeAttendanceUploadAction).toHaveBeenCalled()
      expect(recalculateBtn).not.toBeDisabled()
    })
  })

  // ── Test 4: Verification Dialog Trigger for Unmatched Employees ───────────
  it('opens EmployeeVerificationDialog if uploaded attendance has unmatched or inactive employees', async () => {
    vi.mocked(getEmployeesForMatchingAction).mockResolvedValue({
      ok: true,
      data: [],
    })

    render(<CorrectionFlow data={MOCK_CORRECTION_DATA} weekLabel="Week 06 Mar - 12 Mar" />)

    // Select Attendance
    fireEvent.click(screen.getByRole('checkbox', { name: /attendance/i }))

    // Mock records requiring verification
    const unmatchedRecord = {
      employeeName: 'Unknown Guy',
      site: null,
      sourceSheetName: 'Sheet1',
      sourceEmployeeBlockIndex: 0,
      totalRegularHours: 40,
      totalOvertimeHours: 5,
      dailyHours: Array(7).fill({ regularHours: 0, overtimeHours: 0 }),
      parseErrors: [],
      matchStatus: 'UNMATCHED' as const,
      isBlocking: true,
      employeeDbId: null,
    }

    vi.mocked(getPresignedUploadUrlAction).mockResolvedValue({
      ok: true,
      data: { signedUrl: 'https://storage.test/signed-url', storageKey: 'attendance/uuid_attendance.xlsx', token: 'tok' },
    })
    vi.mocked(parseFromStorageAction).mockResolvedValue({
      ok: true,
      data: {
        storageKey: 'attendance/uuid_attendance.xlsx',
        fileName: 'attendance.xlsx',
        fileType: 'xlsx',
        payrollWeek: {
          source: 'FILE_NAME',
          start: '2025-03-06',
          end: '2025-03-12',
        },
        records: [unmatchedRecord],
        summary: {
          total: 1, matched: 0, unmatched: 1, inactive: 0,
          resignedBeforeWeek: 0, rejectedUnmatched: 0,
          needsVerification: 1, errors: 0, isBlocked: true,
        },
      },
    })

    // Upload
    const file = new File([''], 'attendance.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const fileInput = document.getElementById('attendance-dropzone-trigger')!
    fireEvent.change(fileInput, { target: { files: [file] } })

    const uploadBtn = screen.getByRole('button', { name: /upload & preview/i })
    fireEvent.click(uploadBtn)

    // Dialog should open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText(/Manual Verification Required/i)).toBeInTheDocument()
    })
  })
})
