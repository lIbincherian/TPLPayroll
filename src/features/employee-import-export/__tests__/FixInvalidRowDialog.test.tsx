import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type {
  InvalidImportRow,
  ValidImportRow,
  ImportRowData,
  ImportRowErrorCode,
} from '@/features/employee-import-export/types/import-export.types'

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock('@/features/employee-import-export/utils/row-fix.utils', () => ({
  applyRowFix: vi.fn(),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { applyRowFix } from '@/features/employee-import-export/utils/row-fix.utils'
import { FixInvalidRowDialog } from '@/features/employee-import-export/components/FixInvalidRowDialog'

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

interface RenderDialogArgs {
  open?: boolean
  invalidRow?: InvalidImportRow
  existingEmployeeIds?: Set<string>
  onOpenChange?: AnyFn
  onRowFixed?: AnyFn
}

function renderDialog({
  open = true,
  invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
    employeeName: 'Test Employee',
    designation: 'Guard',
    salary: 12000,
    isActive: true,
  }),
  existingEmployeeIds = new Set<string>(),
  onOpenChange = vi.fn(),
  onRowFixed = vi.fn(),
}: RenderDialogArgs = {}) {
  return render(
    <FixInvalidRowDialog
      open={open}
      onOpenChange={onOpenChange}
      invalidRow={invalidRow}
      existingEmployeeIds={existingEmployeeIds}
      onRowFixed={onRowFixed}
    />
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FixInvalidRowDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Renders only fields whose error codes are in invalidRow.errors ──────────
  describe('field rendering based on error codes', () => {
    it('renders an input for Employee ID when MISSING_EMPLOYEE_ID is in errors', () => {
      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID', 'INVALID_SALARY'], {
        employeeName: 'Juan dela Cruz',
        designation: 'Guard',
        isActive: true,
      })

      renderDialog({ invalidRow })

      // Employee ID field should be present (it has an error)
      expect(screen.getByLabelText(/employee id/i)).toBeInTheDocument()
      // Salary field should be present (INVALID_SALARY is in errors)
      expect(screen.getByLabelText(/daily wage/i)).toBeInTheDocument()
    })

    it('does NOT render an input for Employee Name when it is not in errors', () => {
      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID', 'INVALID_SALARY'], {
        employeeName: 'Juan dela Cruz',
        designation: 'Guard',
        isActive: true,
      })

      renderDialog({ invalidRow })

      // Employee Name is NOT in errors, so no editable input for it
      expect(screen.queryByLabelText(/employee name/i)).not.toBeInTheDocument()
    })

    it('renders Employee Name input when MISSING_EMPLOYEE_NAME is in errors', () => {
      const invalidRow = makeInvalidRow(6, ['MISSING_EMPLOYEE_NAME', 'MISSING_DESIGNATION'], {
        employeeId: 'EMP-010',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByLabelText(/employee name/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/designation/i)).toBeInTheDocument()
    })

    it('does NOT render Employee ID input when it is NOT in errors', () => {
      const invalidRow = makeInvalidRow(6, ['MISSING_EMPLOYEE_NAME', 'MISSING_DESIGNATION'], {
        employeeId: 'EMP-010',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.queryByLabelText(/employee id/i)).not.toBeInTheDocument()
    })
  })

  // ── Error badge display ─────────────────────────────────────────────────────
  describe('error badge display', () => {
    it('shows human-readable badges for each error code', () => {
      const invalidRow = makeInvalidRow(7, ['MISSING_EMPLOYEE_NAME', 'MISSING_DESIGNATION'], {
        employeeId: 'EMP-020',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByText(/missing.*name/i)).toBeInTheDocument()
      expect(screen.getByText(/missing.*designation/i)).toBeInTheDocument()
    })

    it('shows invalid salary badge for INVALID_SALARY error', () => {
      const invalidRow = makeInvalidRow(8, ['INVALID_SALARY'], {
        employeeId: 'EMP-030',
        employeeName: 'Alice',
        designation: 'Guard',
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByText(/invalid daily wage/i)).toBeInTheDocument()
    })
  })

  // ── Context chips for valid (non-errored) fields ────────────────────────────
  describe('context chips for valid fields', () => {
    it('shows partialData.employeeName as a read-only chip when name is NOT in errors', () => {
      const invalidRow = makeInvalidRow(9, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Juan dela Cruz',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByText('Juan dela Cruz')).toBeInTheDocument()
    })

    it('shows designation chip when designation is NOT in errors', () => {
      const invalidRow = makeInvalidRow(10, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Priya Nair',
        designation: 'Security Officer',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByText('Security Officer')).toBeInTheDocument()
    })

    it('labels the daily wage chip', () => {
      const invalidRow = makeInvalidRow(10, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Priya Nair',
        designation: 'Security Officer',
        salary: 800,
        isActive: true,
      })

      renderDialog({ invalidRow })

      expect(screen.getByText('Daily Wage ₱800')).toBeInTheDocument()
    })
  })

  // ── Successful fix: onRowFixed called and dialog closes ────────────────────
  describe('on successful fix', () => {
    it('calls onRowFixed with the returned ValidImportRow and closes the dialog', async () => {
      const fixedRow: ValidImportRow = {
        rowNumber: 5,
        action: 'CREATE',
        source: 'fixed',
        data: makeRowData('EMP-099', 'Test Employee'),
      }
      vi.mocked(applyRowFix).mockReturnValue(fixedRow)

      const onRowFixed = vi.fn()
      const onOpenChange = vi.fn()

      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Test Employee',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow, onRowFixed, onOpenChange })

      // Fill in the Employee ID field
      const empIdInput = screen.getByLabelText(/employee id/i)
      fireEvent.change(empIdInput, { target: { value: 'EMP-099' } })

      // Submit the form
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /apply fix/i }))
      })

      expect(vi.mocked(onRowFixed)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(onRowFixed)).toHaveBeenCalledWith(fixedRow)
      expect(vi.mocked(onOpenChange)).toHaveBeenCalledWith(false)
    })
  })

  // ── Failed fix: inline errors shown, dialog stays open ─────────────────────
  describe('on failed fix', () => {
    it('shows inline error message when applyRowFix returns error codes', async () => {
      vi.mocked(applyRowFix).mockReturnValue(['MISSING_EMPLOYEE_NAME'] as ImportRowErrorCode[])

      const onRowFixed = vi.fn()
      const onOpenChange = vi.fn()

      const invalidRow = makeInvalidRow(6, ['MISSING_EMPLOYEE_NAME'], {
        employeeId: 'EMP-010',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow, onRowFixed, onOpenChange })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /apply fix/i }))
      })

      // onRowFixed must NOT be called
      expect(onRowFixed).not.toHaveBeenCalled()
      // Dialog must remain open
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      // An error message should be visible
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    it('keeps the dialog open when applyRowFix returns INVALID_SALARY', async () => {
      vi.mocked(applyRowFix).mockReturnValue(['INVALID_SALARY'] as ImportRowErrorCode[])

      const onOpenChange = vi.fn()
      const invalidRow = makeInvalidRow(7, ['INVALID_SALARY'], {
        employeeId: 'EMP-020',
        employeeName: 'Alice',
        designation: 'Guard',
        isActive: true,
      })

      renderDialog({ invalidRow, onOpenChange })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /apply fix/i }))
      })

      // Dialog stays open (onOpenChange never called with false)
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      // Dialog is still in the document
      expect(screen.getByTestId('dialog')).toBeInTheDocument()
    })
  })

  // ── Cancel button ───────────────────────────────────────────────────────────
  describe('cancel button', () => {
    it('calls onOpenChange(false) when Cancel is clicked', () => {
      const onOpenChange = vi.fn()
      const onRowFixed = vi.fn()

      renderDialog({ onOpenChange, onRowFixed })

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onRowFixed).not.toHaveBeenCalled()
    })
  })

  // ── Dialog not rendered when open=false ────────────────────────────────────
  describe('when open is false', () => {
    it('does not render the dialog content', () => {
      renderDialog({ open: false })

      expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    })
  })

  // ── Dialog shows row number in title/description ────────────────────────────
  describe('dialog header', () => {
    it('shows the row number so the user knows which row is being fixed', () => {
      const invalidRow = makeInvalidRow(42, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Test Employee',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })

      renderDialog({ invalidRow })

      // Row number 42 should appear somewhere in the dialog
      expect(screen.getByText(/42/)).toBeInTheDocument()
    })
  })
})
