import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock pdfmake ─────────────────────────────────────────────────────────────
vi.mock('pdfmake', () => {
  class MockPdfPrinter {
    createPdfKitDocument() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EventEmitter } = require('events')
      const emitter = new EventEmitter()
      emitter.end = () => {
        setTimeout(() => {
          emitter.emit('data', Buffer.from('%PDF-1.4'))
          emitter.emit('end')
        }, 0)
      }
      return emitter
    }
  }
  return { default: MockPdfPrinter }
})

// ─── Mock jszip ───────────────────────────────────────────────────────────────
vi.mock('jszip', () => {
  class MockJSZip {
    files: Record<string, Buffer> = {}
    file(name: string, content: Buffer) {
      this.files[name] = content
      return this
    }
    async generateAsync() {
      return Buffer.from('PK\x03\x04')
    }
  }
  return { default: MockJSZip }
})

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
vi.mock('@/lib/prisma', () => ({
  default: {
    payrollRun: {
      findUnique: vi.fn(),
    },
    attendanceRecord: {
      findMany: vi.fn(),
    },
    attendanceUpload: {
      findFirst: vi.fn(),
    },
    attendancePunch: {
      findMany: vi.fn(),
    },
    invoiceSnapshot: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import prisma from '@/lib/prisma'
import {
  formatSlipDate,
  formatZipFileName,
  formatSlipPdfName,
  formatCurrencyPdf,
  formatHours,
  buildSlipData,
  generatePayrollSummaryPdf,
  generatePayrollSummaryXlsx,
  generatePayrollSlipPdf,
  generatePayrollSlipsZip,
  markInvoiceSnapshotsCleaned,
} from '@/features/payroll-reports/services/report.service'
import { ReportServiceError, type PayrollSlipData } from '@/features/payroll-reports/types/report.types'

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEK_START = new Date('2025-03-06T00:00:00.000Z')
const WEEK_END = new Date('2025-03-12T00:00:00.000Z')

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeEmployee(overrides: Partial<{
  id: string
  employeeId: string
  employeeName: string
  designation: string
  site: string | null
  gPay: string | null
  bankAccount: string | null
}> = {}) {
  return {
    id: 'emp-uuid-1',
    employeeId: 'EMP-001',
    employeeName: 'Ravi Kumar',
    designation: 'Guard',
    site: 'Site A',
    gPay: '9876543210',
    bankAccount: 'ACC123456',
    ...overrides,
  }
}

function makeRunEmployee(overrides: Partial<{
  id: string
  payrollRunId: string
  payrollRevisionId: string
  employeeId: string
  hourlyRateUsed: number
  regularHours: number
  overtimeHours: number
  regularPay: number
  overtimePay: number
  additions: number
  deductions: number
  netPayable: number
  employee: ReturnType<typeof makeEmployee>
}> = {}) {
  return {
    id: 'prem-uuid-1',
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'rev-uuid-1',
    employeeId: 'emp-uuid-1',
    hourlyRateUsed: 62.5,
    regularHours: 46,
    overtimeHours: 6,
    regularPay: 2875,
    overtimePay: 375,
    additions: 200,
    deductions: 500,
    netPayable: 2950,
    employee: makeEmployee(),
    ...overrides,
  }
}

function makePayrollRun(overrides: Partial<{
  id: string
  status: string
  payrollWeekStartDate: Date
  payrollWeekEndDate: Date
  totalRegularPay: number
  totalOvertimePay: number
  totalAdditions: number
  totalDeductions: number
  totalNetPayable: number
  revisions: Array<{ id: string; isCurrent: boolean }>
  runEmployees: ReturnType<typeof makeRunEmployee>[]
}> = {}) {
  return {
    id: 'run-uuid-1',
    status: 'APPROVED',
    payrollWeekStartDate: WEEK_START,
    payrollWeekEndDate: WEEK_END,
    totalRegularPay: 2875,
    totalOvertimePay: 375,
    totalAdditions: 200,
    totalDeductions: 500,
    totalNetPayable: 2950,
    revisions: [{ id: 'rev-uuid-1', isCurrent: true }],
    runEmployees: [makeRunEmployee()],
    ...overrides,
  }
}

function makeAttendanceRecords(employeeId = 'emp-uuid-1') {
  const baseTimes = { beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: null, overtimeOut: null }
  return [
    { employeeId, attendanceDate: new Date('2025-03-06'), regularHours: 8, overtimeHours: 2, ...baseTimes, overtimeIn: '18:00', overtimeOut: '20:00' },
    { employeeId, attendanceDate: new Date('2025-03-07'), regularHours: 8, overtimeHours: 0, ...baseTimes },
    { employeeId, attendanceDate: new Date('2025-03-08'), regularHours: 8, overtimeHours: 0, ...baseTimes },
    { employeeId, attendanceDate: new Date('2025-03-09'), regularHours: 8, overtimeHours: 3, ...baseTimes, overtimeIn: '18:00', overtimeOut: '21:00' },
    { employeeId, attendanceDate: new Date('2025-03-10'), regularHours: 6, overtimeHours: 0, ...baseTimes, afternoonOut: '16:00' },
    { employeeId, attendanceDate: new Date('2025-03-11'), regularHours: 8, overtimeHours: 1, ...baseTimes, overtimeIn: '18:00', overtimeOut: '19:00' },
  ]
}

function makeSlipData(overrides: Partial<PayrollSlipData> = {}): PayrollSlipData {
  return {
    employeeCode: 'EMP-001',
    employeeName: 'Ravi Kumar',
    designation: 'Guard',
    site: 'Site A',
    gPay: '9876543210',
    bankAccount: 'ACC123456',
    weekStart: WEEK_START.toISOString(),
    weekEnd: WEEK_END.toISOString(),
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'rev-uuid-1',
    employeeDbId: 'emp-uuid-1',
    dailyAttendance: [
      { day: 'Thursday', date: '6 Mar', regularHours: 8, overtimeHours: 2, beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: '18:00', overtimeOut: '20:00' },
      { day: 'Friday', date: '7 Mar', regularHours: 8, overtimeHours: 0, beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: null, overtimeOut: null },
    ],
    regularHours: 46,
    overtimeHours: 6,
    hourlyRateUsed: 62.5,
    regularPay: 2875,
    overtimePay: 375,
    grossPay: 3250,
    additions: 200,
    deductions: 500,
    netPayable: 2950,
    generatedAt: new Date('2025-03-14T10:00:00.000Z').toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('formatSlipDate', () => {
  it('pads single-digit day and uses short month', () => {
    expect(formatSlipDate(new Date('2025-03-06T00:00:00.000Z'))).toBe('06Mar')
  })

  it('handles double-digit day', () => {
    expect(formatSlipDate(new Date('2025-03-12T00:00:00.000Z'))).toBe('12Mar')
  })
})

describe('formatZipFileName', () => {
  it('combines both dates with correct pattern', () => {
    expect(
      formatZipFileName(
        new Date('2025-03-06T00:00:00.000Z'),
        new Date('2025-03-12T00:00:00.000Z'),
      ),
    ).toBe('payroll_slips_06Mar_12Mar.zip')
  })
})

describe('formatSlipPdfName', () => {
  it('replaces spaces with underscores', () => {
    expect(formatSlipPdfName('EMP-001', 'Ravi Kumar')).toBe('EMP-001_Ravi_Kumar.pdf')
  })

  it('sanitizes special characters from name', () => {
    const result = formatSlipPdfName('EMP-002', 'Priya.Sharma!')
    // Name portion (before .pdf) should not contain . or !
    const namePart = result.replace(/\.pdf$/, '')
    expect(namePart).not.toMatch(/[.!]/)
    expect(result).toMatch(/^EMP-002_/)
    expect(result).toMatch(/\.pdf$/)
  })
})

describe('formatCurrencyPdf', () => {
  it('formats with ₹ prefix and 2 decimal places', () => {
    expect(formatCurrencyPdf(2950.5)).toBe('₹2,950.50')
  })

  it('formats zero correctly', () => {
    expect(formatCurrencyPdf(0)).toBe('₹0.00')
  })
})

describe('formatHours', () => {
  it('returns two decimal places', () => {
    expect(formatHours(46)).toBe('46.00')
    expect(formatHours(6.5)).toBe('6.50')
  })
})

describe('buildSlipData', () => {
  it('builds correct slip data with daily attendance', () => {
    const runEmployee = makeRunEmployee()
    const attendanceRecords = makeAttendanceRecords('emp-uuid-1')
    const generatedAt = new Date('2025-03-14T10:00:00.000Z')

    const slip = buildSlipData({
      runEmployee,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      payrollRunId: 'run-uuid-1',
      payrollRevisionId: 'rev-uuid-1',
      attendanceRecords,
      generatedAt,
    })

    expect(slip.employeeCode).toBe('EMP-001')
    expect(slip.employeeName).toBe('Ravi Kumar')
    expect(slip.dailyAttendance).toHaveLength(6)
    expect(slip.dailyAttendance[0].day).toBe('Thursday')
    expect(slip.dailyAttendance[0].date).toBe('6 Mar')
    expect(slip.dailyAttendance[0].beforeNoonIn).toBe('09:00')
    expect(slip.dailyAttendance[0].overtimeOut).toBe('20:00')
    expect(slip.employeeDbId).toBe('emp-uuid-1')
    expect(slip.weekStart).toBe(WEEK_START.toISOString())
  })

  it('calculates grossPay as regularPay + overtimePay', () => {
    const runEmployee = makeRunEmployee({ regularPay: 2875, overtimePay: 375 })
    const slip = buildSlipData({
      runEmployee,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      payrollRunId: 'run-uuid-1',
      payrollRevisionId: 'rev-uuid-1',
      attendanceRecords: [],
      generatedAt: new Date(),
    })

    expect(slip.grossPay).toBe(2875 + 375)
  })

  it('only includes attendance records for the specific employee', () => {
    const runEmployee = makeRunEmployee({ employee: makeEmployee({ id: 'emp-uuid-1' }) })
    const attendanceRecords = [
      ...makeAttendanceRecords('emp-uuid-1'),
      { employeeId: 'emp-uuid-2', attendanceDate: new Date('2025-03-06'), regularHours: 8, overtimeHours: 0, beforeNoonIn: null, beforeNoonOut: null, afternoonIn: null, afternoonOut: null, overtimeIn: null, overtimeOut: null } as any,
    ]

    const slip = buildSlipData({
      runEmployee,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      payrollRunId: 'run-uuid-1',
      payrollRevisionId: 'rev-uuid-1',
      attendanceRecords,
      generatedAt: new Date(),
    })

    expect(slip.dailyAttendance).toHaveLength(6) // only emp-uuid-1's records
  })
})

// ── US-07.1a: generatePayrollSummaryPdf ─────────────────────────────────────

describe('generatePayrollSummaryPdf', () => {
  it('creates valid PDF buffer', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)

    const result = await generatePayrollSummaryPdf('run-uuid-1')

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.buffer.length).toBeGreaterThan(0)
    expect(result.fileName).toMatch(/^payroll_summary_/)
    expect(result.fileName).toMatch(/\.pdf$/)
  })

  it('throws PAYROLL_RUN_NOT_FOUND when run does not exist', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(generatePayrollSummaryPdf('nonexistent-id')).rejects.toThrow(ReportServiceError)
    await expect(generatePayrollSummaryPdf('nonexistent-id')).rejects.toMatchObject({
      code: 'PAYROLL_RUN_NOT_FOUND',
    })
  })

  it('throws PAYROLL_NOT_APPROVED when status is not APPROVED', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'DRAFT' }) as never,
    )

    await expect(generatePayrollSummaryPdf('run-uuid-1')).rejects.toThrow(ReportServiceError)
    await expect(generatePayrollSummaryPdf('run-uuid-1')).rejects.toMatchObject({
      code: 'PAYROLL_NOT_APPROVED',
    })
  })

  it('queries runEmployees filtered by current revision to prevent duplicates on revised runs', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'REVISED' }) as never,
    )

    await generatePayrollSummaryPdf('run-uuid-1')

    expect(prisma.payrollRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          runEmployees: expect.objectContaining({
            where: { payrollRevision: { isCurrent: true } },
          }),
        }),
      }),
    )
  })
})

// ── US-07.1b: generatePayrollSummaryXlsx ────────────────────────────────────

describe('generatePayrollSummaryXlsx', () => {
  it('creates valid XLSX buffer', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)

    const result = await generatePayrollSummaryXlsx('run-uuid-1')

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.buffer.length).toBeGreaterThan(0)
    expect(result.fileName).toMatch(/^payroll_summary_/)
    expect(result.fileName).toMatch(/\.xlsx$/)
  })

  it('throws PAYROLL_RUN_NOT_FOUND when run does not exist', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(generatePayrollSummaryXlsx('nonexistent-id')).rejects.toThrow(ReportServiceError)
    await expect(generatePayrollSummaryXlsx('nonexistent-id')).rejects.toMatchObject({
      code: 'PAYROLL_RUN_NOT_FOUND',
    })
  })

  it('throws PAYROLL_NOT_APPROVED when status is not APPROVED', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'DRAFT' }) as never,
    )

    await expect(generatePayrollSummaryXlsx('run-uuid-1')).rejects.toThrow(ReportServiceError)
    await expect(generatePayrollSummaryXlsx('run-uuid-1')).rejects.toMatchObject({
      code: 'PAYROLL_NOT_APPROVED',
    })
  })

  it('queries runEmployees filtered by current revision to prevent duplicates on revised runs', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'REVISED' }) as never,
    )

    await generatePayrollSummaryXlsx('run-uuid-1')

    expect(prisma.payrollRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          runEmployees: expect.objectContaining({
            where: { payrollRevision: { isCurrent: true } },
          }),
        }),
      }),
    )
  })
})


// ── US-07.2: generatePayrollSlipPdf ─────────────────────────────────────────

describe('generatePayrollSlipPdf', () => {
  it('creates valid PDF buffer for one employee', async () => {
    const slip = makeSlipData()
    const result = await generatePayrollSlipPdf(slip)

    expect(result).toBeInstanceOf(Buffer)
    expect(result.length).toBeGreaterThan(0)
  })

  it('includes daily attendance rows from slip data', async () => {
    const slip = makeSlipData({
      dailyAttendance: [
        { day: 'Thursday', date: '6 Mar', regularHours: 8, overtimeHours: 2, beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: '18:00', overtimeOut: '20:00' },
        { day: 'Friday', date: '7 Mar', regularHours: 8, overtimeHours: 0, beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: null, overtimeOut: null },
        { day: 'Saturday', date: '8 Mar', regularHours: 8, overtimeHours: 0, beforeNoonIn: '09:00', beforeNoonOut: '13:00', afternoonIn: '14:00', afternoonOut: '18:00', overtimeIn: null, overtimeOut: null },
      ],
    })

    // Should not throw with 3 attendance rows
    const result = await generatePayrollSlipPdf(slip)
    expect(result).toBeInstanceOf(Buffer)
  })
})

// ── US-07.3: generatePayrollSlipsZip ──────────────────────────────────────

describe('generatePayrollSlipsZip', () => {
  beforeEach(() => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue(
      makeAttendanceRecords('emp-uuid-1') as never,
    )
    // An Excel-era week: the zip keeps the six-column slot layout and loads no punches.
    vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: 'upload-uuid-1', source: 'EXCEL' } as never)
    vi.mocked(prisma.attendancePunch.findMany).mockResolvedValue([])
    vi.mocked(prisma.$transaction).mockResolvedValue([{ count: 0 }, { count: 1 }])
  })

  it('returns ZIP with correct fileName', async () => {
    const result = await generatePayrollSlipsZip('run-uuid-1')

    expect(result.fileName).toBe('payroll_slips_06Mar_12Mar.zip')
  })

  it('returns a buffer and filters by active upload', async () => {
    const result = await generatePayrollSlipsZip('run-uuid-1')

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attendanceUpload: { isActiveForPayrollWeek: true },
        }),
      }),
    )
  })

  it('throws PAYROLL_RUN_NOT_FOUND when run does not exist', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(generatePayrollSlipsZip('nonexistent-id')).rejects.toMatchObject({
      code: 'PAYROLL_RUN_NOT_FOUND',
    })
  })

  it('throws PAYROLL_NOT_APPROVED when run is not approved', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'DRAFT' }) as never,
    )

    await expect(generatePayrollSlipsZip('run-uuid-1')).rejects.toMatchObject({
      code: 'PAYROLL_NOT_APPROVED',
    })
  })

  it('queries runEmployees filtered by current revision to prevent duplicates on revised runs', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(
      makePayrollRun({ status: 'REVISED' }) as never,
    )

    await generatePayrollSlipsZip('run-uuid-1')

    expect(prisma.payrollRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          runEmployees: expect.objectContaining({
            where: { payrollRevision: { isCurrent: true } },
          }),
        }),
      }),
    )
  })
})

// ── US-07.4: markInvoiceSnapshotsCleaned ──────────────────────────────────

describe('markInvoiceSnapshotsCleaned', () => {
  it('calls updateMany with temporaryFileDeletedAt set', async () => {
    vi.mocked(prisma.invoiceSnapshot.updateMany).mockResolvedValue({ count: 3 })

    await markInvoiceSnapshotsCleaned('run-uuid-1')

    expect(vi.mocked(prisma.invoiceSnapshot.updateMany)).toHaveBeenCalledWith({
      where: { payrollRunId: 'run-uuid-1' },
      data: expect.objectContaining({
        temporaryFileDeletedAt: expect.any(Date),
      }),
    })
  })
})
