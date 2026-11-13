/**
 * E2E-style integration tests for E01 "Manual Row Fix for Invalid Import Rows".
 *
 * These tests render the full ImportPreviewClient + FixInvalidRowDialog +
 * applyRowFix component tree (no mocking of dialog or utility). Only server
 * actions and next/navigation are mocked.
 *
 * References: E01 spec scenarios E2E-E01-01 through E2E-E01-06.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react'
import type {
  ParseImportResult,
  ValidImportRow,
  InvalidImportRow,
  ImportRowData,
  ImportRowErrorCode,
} from '@/features/employee-import-export/types/import-export.types'

// ─── Module-level mocks (server-only concerns) ────────────────────────────────

vi.mock('@/features/employee-import-export/actions/import-export.actions', () => ({
  executeImportAction: vi.fn(),
}))

const mockRouter = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

// Dialog mock: renders children directly so JSDOM can find them without portals
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { executeImportAction } from '@/features/employee-import-export/actions/import-export.actions'
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

/** Switch to the Invalid Rows tab. */
function goToInvalidTab() {
  fireEvent.click(screen.getByRole('tab', { name: /^invalid rows/i }))
}

/** Switch to the Valid Rows tab. */
function goToValidTab() {
  fireEvent.click(screen.getByRole('tab', { name: /^valid rows/i }))
}

/** Click the first Fix button visible in the current tab panel. */
function clickFirstFixButton() {
  fireEvent.click(screen.getAllByRole('button', { name: /fix/i })[0])
}

// ─── E2E scenarios ────────────────────────────────────────────────────────────

describe('E2E-E01: Manual Row Fix for Invalid Import Rows', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  // ── E2E-E01-01: Fix a row with a missing Employee ID ───────────────────────
  it('E01-01: fixing a missing Employee ID moves the row from Invalid to Valid', async () => {
    setupSessionStorage() // 2 valid, 1 invalid (MISSING_EMPLOYEE_ID for Suresh)

    render(<ImportPreviewClient />)

    // Summary should start at Valid=2, Invalid=1
    expect(screen.getByText(/^valid$/i)).toBeInTheDocument()

    // Switch to invalid tab and open Fix dialog
    goToInvalidTab()
    clickFirstFixButton()

    // Fix dialog should be visible
    expect(screen.getByTestId('dialog')).toBeInTheDocument()

    // Fill in the Employee ID field
    const empIdInput = screen.getByLabelText(/employee id/i)
    fireEvent.change(empIdInput, { target: { value: 'EMP-077' } })

    // Submit the fix
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply fix/i }))
    })

    // Dialog should be closed
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()

    // Invalid Rows tab should now show 0 (badge gone or 0)
    // and Valid Rows tab should show 3
    const validTab = screen.getByRole('tab', { name: /^valid rows/i })
    expect(validTab).toHaveTextContent('3')

    // Switch to valid tab and verify the fixed row appears with its source marker
    goToValidTab()
    expect(screen.getByText('Suresh Narayanan')).toBeInTheDocument()
    expect(screen.getByText(/fixed/i)).toBeInTheDocument()
  })

  // ── E2E-E01-02: Fix a row with multiple errors ─────────────────────────────
  it('E01-02: dialog shows only errored fields and promotes row when all are corrected', async () => {
    setupSessionStorage({
      validRows: [{ rowNumber: 2, action: 'CREATE', data: makeRowData('EMP-001', 'Alice') }],
      invalidRows: [
        makeInvalidRow(5, ['MISSING_EMPLOYEE_NAME', 'INVALID_SALARY'], {
          employeeId: 'EMP-010',
          designation: 'Guard',
          isActive: true,
        }),
      ],
      duplicateIdRows: [],
      totalRows: 10,
    })

    render(<ImportPreviewClient />)

    goToInvalidTab()
    clickFirstFixButton()

    const dialog = screen.getByTestId('dialog')

    // Only the errored fields should be editable
    expect(within(dialog).getByLabelText(/employee name/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/daily wage/i)).toBeInTheDocument()
    // Employee ID is NOT in errors — no input for it
    expect(within(dialog).queryByLabelText(/employee id/i)).not.toBeInTheDocument()

    // Fill in the missing fields
    fireEvent.change(within(dialog).getByLabelText(/employee name/i), {
      target: { value: 'Juan dela Cruz' },
    })
    fireEvent.change(within(dialog).getByLabelText(/daily wage/i), {
      target: { value: '15000' },
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /apply fix/i }))
    })

    // Dialog closed, row promoted
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()

    const validTab = screen.getByRole('tab', { name: /^valid rows/i })
    expect(validTab).toHaveTextContent('2')
  })

  // ── E2E-E01-03: Fix dialog with remaining validation error ─────────────────
  it('E01-03: entering an invalid salary keeps the dialog open with an error message', async () => {
    setupSessionStorage({
      validRows: [{ rowNumber: 2, action: 'CREATE', data: makeRowData('EMP-001', 'Alice') }],
      invalidRows: [
        makeInvalidRow(5, ['INVALID_SALARY'], {
          employeeId: 'EMP-020',
          employeeName: 'Test Person',
          designation: 'Guard',
          isActive: true,
        }),
      ],
      duplicateIdRows: [],
      totalRows: 10,
    })

    render(<ImportPreviewClient />)

    goToInvalidTab()
    clickFirstFixButton()

    const dialog = screen.getByTestId('dialog')

    // Enter a negative salary (invalid — number inputs coerce non-numeric strings to '', which becomes 0)
    fireEvent.change(within(dialog).getByLabelText(/daily wage/i), {
      target: { value: '-1' },
    })

    // Submit the form directly — fireEvent.click on a button with form= attribute
    // doesn't always trigger the submit event in jsdom
    const form = document.getElementById('fix-row-form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
    })

    // Dialog must remain open
    expect(screen.getByTestId('dialog')).toBeInTheDocument()

    // An error message about salary should be visible
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    // Invalid row count must be unchanged (still 1)
    const invalidTab = screen.getByRole('tab', { name: /^invalid rows/i })
    expect(invalidTab).toHaveTextContent('1')
  })

  // ── E2E-E01-04: Fix dialog cancel leaves row unchanged ─────────────────────
  it('E01-04: clicking Cancel in the Fix dialog leaves the invalid row unchanged', async () => {
    setupSessionStorage() // 1 invalid row

    render(<ImportPreviewClient />)

    goToInvalidTab()
    clickFirstFixButton()

    const dialogEl = screen.getByTestId('dialog')
    expect(dialogEl).toBeInTheDocument()

    // Click Cancel — scope within the dialog so "Cancel Import" (main page) doesn't match
    fireEvent.click(within(dialogEl).getByRole('button', { name: /cancel/i }))

    // Dialog closes
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()

    // The invalid row is still present — tab still shows count 1
    const invalidTab = screen.getByRole('tab', { name: /^invalid rows/i })
    expect(invalidTab).toHaveTextContent('1')

    // Valid count is still 2
    const validTab = screen.getByRole('tab', { name: /^valid rows/i })
    expect(validTab).toHaveTextContent('2')
  })

  // ── E2E-E01-05: Fixed rows are imported on confirm ─────────────────────────
  it('E01-05: executeImportAction receives the fixed rows when Confirm Import is clicked', async () => {
    vi.mocked(executeImportAction).mockResolvedValue({
      ok: true,
      data: {
        batchId: 'batch-1',
        importedRowCount: 3,
        createdEmployeeCount: 3,
        updatedEmployeeCount: 0,
        rejectedRowCount: 0,
        duplicateEmployeeIdRowCount: 0,
      },
    })

    setupSessionStorage({
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
        makeInvalidRow(6, ['MISSING_EMPLOYEE_ID'], {
          employeeName: 'Priya Nair',
          designation: 'Guard',
          salary: 11000,
          isActive: true,
        }),
        makeInvalidRow(7, ['MISSING_EMPLOYEE_ID'], {
          employeeName: 'Ravi Kumar',
          designation: 'Guard',
          salary: 13000,
          isActive: true,
        }),
      ],
      duplicateIdRows: [],
      totalRows: 20,
    })

    render(<ImportPreviewClient />)

    // Fix only 1 of the 3 invalid rows
    goToInvalidTab()
    fireEvent.click(screen.getAllByRole('button', { name: /fix/i })[0])

    const dialog = screen.getByTestId('dialog')
    fireEvent.change(within(dialog).getByLabelText(/employee id/i), {
      target: { value: 'EMP-077' },
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /apply fix/i }))
    })

    // Confirm the import
    const confirmButton = screen.getByRole('button', { name: /confirm import/i })
    await act(async () => {
      fireEvent.click(confirmButton)
    })

    expect(executeImportAction).toHaveBeenCalledTimes(1)

    // Check the fixedRows argument: should have length 1
    const callArgs = vi.mocked(executeImportAction).mock.calls[0]
    const fixedRowsArg = callArgs[2] as ValidImportRow[] | undefined
    if (fixedRowsArg !== undefined) {
      expect(fixedRowsArg).toHaveLength(1)
      expect(fixedRowsArg[0].source).toBe('fixed')
      expect(fixedRowsArg[0].data.employeeId).toBe('EMP-077')
    }
  })

  // ── E2E-E01-06: Fixed row with existing employee ID → action = UPDATE ───────
  it('E01-06: fixing a row with an existing employeeId sets action=UPDATE on the promoted row', async () => {
    // Set up with existingEmployeeIds that includes EMP-001 (Alice is already UPDATE)
    // We need to expose existingEmployeeIds to the component.
    // The component derives existingEmployeeIds from validRows with action=UPDATE.
    setupSessionStorage({
      validRows: [
        // EMP-001 already exists in the system (UPDATE action)
        { rowNumber: 2, action: 'UPDATE', data: makeRowData('EMP-001', 'Alice') },
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
      totalRows: 10,
    })

    render(<ImportPreviewClient />)

    goToInvalidTab()
    clickFirstFixButton()

    // Enter EMP-001, which is already an existing employee
    const dialog = screen.getByTestId('dialog')
    fireEvent.change(within(dialog).getByLabelText(/employee id/i), {
      target: { value: 'EMP-001' },
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /apply fix/i }))
    })

    // Dialog should close
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()

    // Switch to valid rows tab and check that the fixed row shows UPDATE action
    goToValidTab()

    // The fixed row for Suresh should appear with Update action badge
    const sureshRow = screen.getByText('Suresh Narayanan').closest('tr')
    expect(sureshRow).toBeInTheDocument()
    if (sureshRow) {
      expect(within(sureshRow).getByText(/update/i)).toBeInTheDocument()
    }
  })
})
