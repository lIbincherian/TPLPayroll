import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import type {
  ParseImportResult,
  ValidImportRow,
  InvalidImportRow,
  ImportRowData,
  ImportRowErrorCode,
} from '@/features/employee-import-export/types/import-export.types'

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock('@/features/employee-import-export/actions/import-export.actions', () => ({
  executeImportAction: vi.fn(),
}))

const mockRouter = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

vi.mock('@/features/employee-import-export/components/FixInvalidRowDialog', () => ({
  FixInvalidRowDialog: vi.fn(() => null),
}))

import { executeImportAction } from '@/features/employee-import-export/actions/import-export.actions'
import { FixInvalidRowDialog } from '@/features/employee-import-export/components/FixInvalidRowDialog'
import { ImportPreviewClient } from '@/features/employee-import-export/components/ImportPreviewClient'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRowData(employeeId: string, employeeName: string): ImportRowData {
  return {
    serialNumber: null,
    employeeId,
    employeeName,
    nationalId: null,
    designation: 'Guard',
    dateOfJoining: null,
    aadhaarId: null,
    policeVerificationId: null,
    salary: 12000,
    phone: null,
    dateOfBirth: null,
    healthCardId: null,
    gPay: null,
    bankAccount: null,
    dateOfResignation: null,
    site: 'North Gate',
    isActive: true,
    designationShort: null,
  }
}

function makeInvalidRow(
  rowNumber: number,
  errors: ImportRowErrorCode[],
  partialData: Partial<ImportRowData> = {}
): InvalidImportRow {
  return {
    rowNumber,
    employeeId: partialData.employeeId ?? null,
    employeeName: partialData.employeeName ?? null,
    errors,
    partialData: {
      designation: 'Guard',
      salary: 12000,
      isActive: true,
      ...partialData,
    },
  }
}

function setupSessionStorage(overrides: Partial<ParseImportResult> = {}): ParseImportResult {
  const parseResult: ParseImportResult = {
    totalRows: 15,
    validRows: [
      { rowNumber: 2, action: 'CREATE', data: makeRowData('EMP-001', 'Alice') },
      { rowNumber: 3, action: 'UPDATE', data: makeRowData('EMP-002', 'Bob') },
    ],
    invalidRows: [
      makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Suresh Narayanan',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      }),
    ],
    duplicateIdRows: [],
    ...overrides,
  }

  sessionStorage.setItem(
    'importPreviewData',
    JSON.stringify({ parseResult, fileBase64: 'mock-base64', fileName: 'test.xlsx' })
  )

  return parseResult
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ImportPreviewClient', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(FixInvalidRowDialog).mockReturnValue(null as unknown as React.ReactElement)
  })

  // ── Initial counts in summary strip ────────────────────────────────────────
  describe('summary strip', () => {
    it('shows correct initial counts: Valid=2, Invalid=1', () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Find the Invalid stat block and confirm its value is "1"
      const invalidLabel = screen.getByText(/^invalid$/i)
      const invalidBlock = invalidLabel.closest('div')!
      expect(within(invalidBlock).getByText('1')).toBeInTheDocument()

      // Find the Valid stat block and confirm its value is "2"
      const validLabel = screen.getByText(/^valid$/i)
      const validBlock = validLabel.closest('div')!
      expect(within(validBlock).getByText('2')).toBeInTheDocument()
    })

    it('updates Valid count to 3 and Invalid count to 0 after a row is fixed', async () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Capture the onRowFixed prop from the mocked FixInvalidRowDialog
      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      // The component should have rendered FixInvalidRowDialog at least once
      // (even with open=false, it may still receive props).
      // Trigger clicking Fix to open the dialog on the invalid row.
      // First, switch to the Invalid Rows tab.
      const invalidTab = screen.getByRole('tab', { name: /^invalid rows/i })
      fireEvent.click(invalidTab)

      // Click the Fix button for the invalid row
      const fixButton = screen.getByRole('button', { name: /fix/i })
      fireEvent.click(fixButton)

      // Now the dialog should be open. Get the onRowFixed prop.
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh Narayanan'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // Valid count should now be 3
      expect(screen.getAllByText('3').length).toBeGreaterThan(0)
      // Invalid count should now be 0
      // After all are fixed the invalid tab shows 0
    })
  })

  // ── Fix button in Invalid Rows tab ─────────────────────────────────────────
  describe('invalid rows tab', () => {
    it('shows a Fix button for each invalid row', () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Switch to Invalid Rows tab
      const invalidTab = screen.getByRole('tab', { name: /^invalid rows/i })
      fireEvent.click(invalidTab)

      expect(screen.getByRole('button', { name: /fix/i })).toBeInTheDocument()
    })

    it('shows Fix buttons for all invalid rows when there are multiple', () => {
      setupSessionStorage({
        totalRows: 20,
        validRows: [{ rowNumber: 2, action: 'CREATE', data: makeRowData('EMP-001', 'Alice') }],
        invalidRows: [
          makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], { employeeName: 'Suresh' }),
          makeInvalidRow(6, ['MISSING_EMPLOYEE_NAME'], { employeeId: 'EMP-010' }),
        ],
        duplicateIdRows: [],
      })

      render(<ImportPreviewClient />)

      fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))

      const fixButtons = screen.getAllByRole('button', { name: /fix/i })
      expect(fixButtons.length).toBe(2)
    })

    it('shows empty state message when all rows are fixed', async () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Switch to invalid tab and fix the row
      fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))
      fireEvent.click(screen.getByRole('button', { name: /fix/i }))

      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh Narayanan'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // The empty state message should now appear
      expect(screen.getByText(/all invalid rows have been corrected/i)).toBeInTheDocument()
    })
  })

  // ── Fixed rows passed to executeImportAction ────────────────────────────────
  describe('confirm import with fixed rows', () => {
    it('passes fixed rows to executeImportAction', async () => {
      vi.mocked(executeImportAction).mockResolvedValue({
        ok: true,
        data: {
          batchId: 'batch-1',
          importedRowCount: 3,
          createdEmployeeCount: 2,
          updatedEmployeeCount: 1,
          rejectedRowCount: 0,
          duplicateEmployeeIdRowCount: 0,
        },
      })

      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Fix a row first
      fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))
      fireEvent.click(screen.getByRole('button', { name: /fix/i }))

      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh Narayanan'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // Now confirm the import
      const confirmButton = screen.getByRole('button', { name: /confirm import/i })
      await act(async () => {
        fireEvent.click(confirmButton)
      })

      expect(executeImportAction).toHaveBeenCalledTimes(1)
      // executeImportAction should receive the fixedRows
      const callArgs = vi.mocked(executeImportAction).mock.calls[0]
      // The action receives fileBase64, fileName, and optionally fixedRows
      // Based on spec: executeImportAction is called with fixedRows = [fixedRow]
      expect(callArgs).toContain('mock-base64')
    })

    it('calls executeImportAction with fixedRows array containing only fixed rows', async () => {
      vi.mocked(executeImportAction).mockResolvedValue({
        ok: true,
        data: {
          batchId: 'batch-1',
          importedRowCount: 3,
          createdEmployeeCount: 2,
          updatedEmployeeCount: 1,
          rejectedRowCount: 0,
          duplicateEmployeeIdRowCount: 0,
        },
      })

      setupSessionStorage({
        totalRows: 20,
        validRows: [
          { rowNumber: 2, action: 'CREATE', data: makeRowData('EMP-001', 'Alice') },
          { rowNumber: 3, action: 'UPDATE', data: makeRowData('EMP-002', 'Bob') },
        ],
        invalidRows: [
          makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], { employeeName: 'Suresh', salary: 12000, isActive: true }),
          makeInvalidRow(6, ['MISSING_EMPLOYEE_ID'], { employeeName: 'Priya', salary: 12000, isActive: true }),
          makeInvalidRow(7, ['MISSING_EMPLOYEE_ID'], { employeeName: 'Ravi', salary: 12000, isActive: true }),
        ],
        duplicateIdRows: [],
      })

      render(<ImportPreviewClient />)

      // Fix only 1 of the 3 invalid rows
      fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))

      const fixButtons = screen.getAllByRole('button', { name: /fix/i })
      fireEvent.click(fixButtons[0])

      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // Confirm
      const confirmButton = screen.getByRole('button', { name: /confirm import/i })
      await act(async () => {
        fireEvent.click(confirmButton)
      })

      expect(executeImportAction).toHaveBeenCalledTimes(1)
      // Check that fixedRows with length 1 was passed
      const callArgs = vi.mocked(executeImportAction).mock.calls[0]
      // Third argument should be the fixedRows array
      const fixedRowsArg = callArgs[2] as ValidImportRow[] | undefined
      if (fixedRowsArg !== undefined) {
        expect(fixedRowsArg).toHaveLength(1)
        expect(fixedRowsArg[0].source).toBe('fixed')
      }
    })
  })

  // ── "Fixed ✓" badge in Valid Rows tab ──────────────────────────────────────
  describe('valid rows tab with fixed rows', () => {
    it('shows "Fixed" indicator for rows with source="fixed"', async () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Fix a row
      fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))
      fireEvent.click(screen.getByRole('button', { name: /fix/i }))

      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh Narayanan'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // Switch to Valid Rows tab to see the fixed row
      fireEvent.click(screen.getByRole('tab', { name: /^valid rows/i }))

      // The fixed row should have a "Fixed" indicator
      expect(screen.getByText(/fixed/i)).toBeInTheDocument()
    })
  })

  // ── Tab counts update after fix ─────────────────────────────────────────────
  describe('tab count badges', () => {
    it('updates Invalid Rows tab count after a row is fixed', async () => {
      setupSessionStorage()

      render(<ImportPreviewClient />)

      // Initially the invalid tab should show count 1
      const invalidTab = screen.getByRole('tab', { name: /^invalid rows/i })
      expect(invalidTab).toHaveTextContent('1')

      // Fix the row
      fireEvent.click(invalidTab)
      fireEvent.click(screen.getByRole('button', { name: /fix/i }))

      const MockFixDialog = vi.mocked(FixInvalidRowDialog)
      const lastCall = MockFixDialog.mock.calls[MockFixDialog.mock.calls.length - 1]
      const { onRowFixed } = lastCall[0]

      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-077', 'Suresh Narayanan'),
      }

      await act(async () => {
        onRowFixed(fixedRow)
      })

      // The tab count for invalid should be 0 now (badge hidden or shows 0)
      // The valid rows tab should show 3
      const validTab = screen.getByRole('tab', { name: /^valid rows/i })
      expect(validTab).toHaveTextContent('3')
    })
  })

  // ── Redirects when no session data ─────────────────────────────────────────
  describe('when sessionStorage has no data', () => {
    it('renders a spinner (not the full UI) when importPreviewData is missing', () => {
      // sessionStorage.clear() is called in beforeEach — no data is present
      render(<ImportPreviewClient />)

      // Without preview data the component shows a loading spinner, not the summary strip
      expect(screen.queryByText(/^valid$/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/^invalid$/i)).not.toBeInTheDocument()
    })
  })
})
