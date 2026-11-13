import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import type { Employee } from '@prisma/client'

// ─── Mock Prisma ─────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    employee: {
      findMany: vi.fn(),
    },
    employeeWageHistory: {
      findMany: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import { generateExportWorkbook } from '@/features/employee-import-export/services/export.service'
import { parseImportFile } from '@/features/employee-import-export/services/import.service'
import { IMPORT_COLUMNS } from '@/features/employee-import-export/types/import-export.types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'uuid-1',
  employeeImportBatchId: null,
  employeeId: 'EMP-001',
  serialNumber: '1',
  employeeName: 'Ravi Kumar',
  nationalId: null,
  designation: 'Guard',
  dateOfJoining: new Date('2023-03-01'),
  aadhaarId: null,
  policeVerificationId: null,
  phone: null,
  dateOfBirth: null,
  healthCardId: null,
  gPay: null,
  bankAccount: null,
  dateOfResignation: null,
  site: 'North Gate',
  isActive: true,
  designationShort: 'GRD',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ═════════════════════════════════════════════════════════════════════════════
// US-03.5: generateExportWorkbook
// ═════════════════════════════════════════════════════════════════════════════

describe('generateExportWorkbook', () => {
  it('includes all employees — active, inactive, and resigned', async () => {
    const employees = [
      ...Array.from({ length: 20 }, (_, i) =>
        makeEmployee({ id: `uuid-${i}`, employeeId: `EMP-${String(i + 1).padStart(3, '0')}`, isActive: true, dateOfResignation: null })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeEmployee({ id: `uuid-i${i}`, employeeId: `EMP-I${i}`, isActive: false, dateOfResignation: null })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeEmployee({ id: `uuid-r${i}`, employeeId: `EMP-R${i}`, isActive: false, dateOfResignation: new Date('2024-01-01') })
      ),
    ]
    vi.mocked(prisma.employee.findMany).mockResolvedValue(employees)
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    const ws = workbook.Sheets['Employee Master List']
    const rows = XLSX.utils.sheet_to_json(ws)

    expect(rows.length).toBe(25)
  })

  it('names the sheet "Employee Master List"', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([makeEmployee()])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    expect(workbook.SheetNames).toContain('Employee Master List')
  })

  it('uses correct column headers in sample file order', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([makeEmployee()])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    const ws = workbook.Sheets['Employee Master List']
    const [headers] = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 })

    const expectedOrder = [
      IMPORT_COLUMNS.serialNumber,
      IMPORT_COLUMNS.employeeId,
      IMPORT_COLUMNS.employeeName,
      IMPORT_COLUMNS.nationalId,
      IMPORT_COLUMNS.designation,
      IMPORT_COLUMNS.dateOfJoining,
      IMPORT_COLUMNS.policeVerificationId,
      IMPORT_COLUMNS.salary,
      IMPORT_COLUMNS.hourlyRate,
      IMPORT_COLUMNS.phone,
      IMPORT_COLUMNS.dateOfBirth,
      IMPORT_COLUMNS.gPay,
      IMPORT_COLUMNS.site,
      IMPORT_COLUMNS.active,
      IMPORT_COLUMNS.designationShort,
    ]

    expect(headers).toEqual(expectedOrder)
  })

  it('writes "Daily Wage" and "Hourly Rate" headers and no "Salary" header', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([makeEmployee()])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    const ws = workbook.Sheets['Employee Master List']
    const [headers] = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })

    expect(headers).toContain('Daily Wage')
    expect(headers).toContain('Hourly Rate')
    expect(headers).not.toContain('Salary')
  })

  it('exports a file that re-imports without errors', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([makeEmployee()])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([
      { employeeId: 'uuid-1', weeklySalary: 800, hourlyRate: 62.5 },
    ] as never)

    const workbook = await generateExportWorkbook()
    const buf = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const result = await parseImportFile(buf)

    expect(result.invalidRows).toHaveLength(0)
    expect(result.validRows).toHaveLength(1)
    expect(result.validRows[0].data.salary).toBe(800)
  })

  it('formats dates as readable strings (e.g., "01 Mar 2023")', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([
      makeEmployee({ dateOfJoining: new Date('2023-03-01') }),
    ])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    const ws = workbook.Sheets['Employee Master List']
    const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

    const joiningValue = row[IMPORT_COLUMNS.dateOfJoining]
    expect(typeof joiningValue).toBe('string')
    expect(joiningValue).toMatch(/\d{2} \w{3} \d{4}/)
  })

  it('writes "Active" or "Inactive" for the Active column', async () => {
    vi.mocked(prisma.employee.findMany).mockResolvedValue([
      makeEmployee({ employeeId: 'EMP-001', isActive: true }),
      makeEmployee({ id: 'uuid-2', employeeId: 'EMP-002', isActive: false }),
    ])
    vi.mocked(prisma.employeeWageHistory.findMany).mockResolvedValue([])

    const workbook = await generateExportWorkbook()
    const ws = workbook.Sheets['Employee Master List']
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

    expect(rows[0][IMPORT_COLUMNS.active]).toBe('Active')
    expect(rows[1][IMPORT_COLUMNS.active]).toBe('Inactive')
  })
})
