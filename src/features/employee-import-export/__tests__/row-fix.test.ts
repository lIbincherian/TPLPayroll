import { describe, it, expect } from 'vitest'
import type {
  InvalidImportRow,
  ValidImportRow,
  ImportRowData,
  ImportRowErrorCode,
  FixRowFormValues,
} from '@/features/employee-import-export/types/import-export.types'
import { applyRowFix } from '@/features/employee-import-export/utils/row-fix.utils'

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

// ─── applyRowFix — pure-function unit tests ───────────────────────────────────

describe('applyRowFix', () => {
  // ── Promotion: missing employee ID ──────────────────────────────────────────
  describe('when fixing a missing Employee ID', () => {
    it('promotes the row to ValidImportRow with action=CREATE and source=fixed', () => {
      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Suresh Narayanan',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })
      const formValues: FixRowFormValues = { employeeId: 'EMP-099' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      // Should be a ValidImportRow (not an array)
      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.action).toBe('CREATE')
      expect(row.source).toBe('fixed')
      expect(row.rowNumber).toBe(5)
      expect(row.data.employeeId).toBe('EMP-099')
    })
  })

  // ── action=UPDATE when employeeId is already in the system ─────────────────
  describe('when fixing an ID that already exists in the system', () => {
    it('sets action=UPDATE on the promoted row', () => {
      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Ravi Kumar',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })
      const formValues: FixRowFormValues = { employeeId: 'EMP-001' }
      const existingIds = new Set<string>(['EMP-001'])

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.action).toBe('UPDATE')
    })
  })

  // ── Still-invalid salary returns error codes ────────────────────────────────
  describe('when the user supplies an invalid salary value', () => {
    it('returns ImportRowErrorCode[] containing INVALID_SALARY', () => {
      const invalidRow = makeInvalidRow(7, ['INVALID_SALARY'], {
        employeeId: 'EMP-042',
        employeeName: 'Alice',
        designation: 'Guard',
        isActive: true,
      })
      const formValues: FixRowFormValues = { salary: 'not-a-number' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ImportRowErrorCode[]
      expect(errors).toContain('INVALID_SALARY')
    })
  })

  // ── Missing required field returns validation error ─────────────────────────
  describe('when the user submits an empty employee name', () => {
    it('returns ImportRowErrorCode[] containing MISSING_EMPLOYEE_NAME', () => {
      const invalidRow = makeInvalidRow(10, ['MISSING_EMPLOYEE_NAME'], {
        employeeId: 'EMP-010',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })
      const formValues: FixRowFormValues = { employeeName: '' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ImportRowErrorCode[]
      expect(errors).toContain('MISSING_EMPLOYEE_NAME')
    })
  })

  // ── partialData fields are preserved in the promoted row ───────────────────
  describe('when partial data has valid fields and only the ID is missing', () => {
    it('preserves site and designation from partialData in the promoted row', () => {
      const invalidRow = makeInvalidRow(3, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Juan dela Cruz',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
        site: 'North Gate',
      })
      const formValues: FixRowFormValues = { employeeId: 'EMP-077' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.site).toBe('North Gate')
      expect(row.data.designation).toBe('Guard')
    })
  })

  // ── Negative salary is invalid ──────────────────────────────────────────────
  describe('when the user supplies a negative salary', () => {
    it('returns INVALID_SALARY in the error array', () => {
      const invalidRow = makeInvalidRow(8, ['INVALID_SALARY'], {
        employeeId: 'EMP-020',
        employeeName: 'Priya',
        designation: 'Guard',
        isActive: true,
      })
      const formValues: FixRowFormValues = { salary: '-100' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ImportRowErrorCode[]
      expect(errors).toContain('INVALID_SALARY')
    })
  })

  // ── isActive "true" → boolean true ─────────────────────────────────────────
  describe('when the user selects isActive "true"', () => {
    it('sets isActive=true on the promoted row', () => {
      const invalidRow = makeInvalidRow(12, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Test Employee',
        designation: 'Guard',
        salary: 12000,
      })
      // partialData intentionally lacks isActive to force formValues to supply it
      const formValues: FixRowFormValues = { employeeId: 'EMP-088', isActive: 'true' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.isActive).toBe(true)
    })
  })

  // ── isActive "false" → boolean false ───────────────────────────────────────
  describe('when the user selects isActive "false"', () => {
    it('sets isActive=false on the promoted row', () => {
      const invalidRow = makeInvalidRow(13, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Test Employee',
        designation: 'Guard',
        salary: 12000,
      })
      const formValues: FixRowFormValues = { employeeId: 'EMP-089', isActive: 'false' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.isActive).toBe(false)
    })
  })

  // ── formValues take priority over partialData ───────────────────────────────
  describe('when both formValues and partialData supply the same field', () => {
    it('prefers the formValues over partialData', () => {
      const invalidRow = makeInvalidRow(15, ['MISSING_EMPLOYEE_NAME'], {
        employeeId: 'EMP-030',
        employeeName: 'OldName',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })
      const formValues: FixRowFormValues = { employeeName: 'NewName' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.employeeName).toBe('NewName')
    })
  })

  // ── Zero salary is valid ────────────────────────────────────────────────────
  describe('when salary is exactly "0"', () => {
    it('treats it as valid (non-negative) and promotes the row', () => {
      const invalidRow = makeInvalidRow(16, ['INVALID_SALARY'], {
        employeeId: 'EMP-031',
        employeeName: 'Zero Salary',
        designation: 'Guard',
        isActive: true,
      })
      const formValues: FixRowFormValues = { salary: '0' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.salary).toBe(0)
    })
  })

  // ── Multiple errors — fixing only one still fails ──────────────────────────
  describe('when the row has multiple errors and only one is fixed', () => {
    it('returns an array of remaining error codes', () => {
      // Build the row inline — the helper's default salary would accidentally satisfy INVALID_SALARY,
      // so we construct partialData without salary to mirror what the parser actually produces.
      const invalidRow: InvalidImportRow = {
        rowNumber: 20,
        employeeId: null,
        employeeName: 'Multi Error',
        errors: ['MISSING_EMPLOYEE_ID', 'INVALID_SALARY'],
        partialData: {
          employeeName: 'Multi Error',
          designation: 'Guard',
          isActive: true,
          // No salary — it was unparseable, so the parser left it out of partialData
        },
      }
      // Only supplying employeeId — salary is still unresolved
      const formValues: FixRowFormValues = { employeeId: 'EMP-055' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(true)
      const errors = result as ImportRowErrorCode[]
      expect(errors.length).toBeGreaterThan(0)
    })
  })

  // ── Valid salary string is parsed to number in promoted row ────────────────
  describe('when a valid salary string is supplied', () => {
    it('parses it to a number in the promoted row data', () => {
      const invalidRow = makeInvalidRow(22, ['INVALID_SALARY'], {
        employeeId: 'EMP-060',
        employeeName: 'Good Salary',
        designation: 'Guard',
        isActive: true,
      })
      const formValues: FixRowFormValues = { salary: '15000' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.salary).toBe(15000)
      expect(typeof row.data.salary).toBe('number')
    })
  })

  describe('when employeeId in formValues is in 15-character format', () => {
    it('normalizes it to 12-character format in the promoted row', () => {
      const invalidRow = makeInvalidRow(5, ['MISSING_EMPLOYEE_ID'], {
        employeeName: 'Suresh Narayanan',
        designation: 'Guard',
        salary: 12000,
        isActive: true,
      })
      const formValues: FixRowFormValues = { employeeId: 'TPLGOAHLP002007' }
      const existingIds = new Set<string>()

      const result = applyRowFix(invalidRow, formValues, existingIds)

      expect(Array.isArray(result)).toBe(false)
      const row = result as ValidImportRow
      expect(row.data.employeeId).toBe('TPLGOAHLP007')
    })
  })
})
