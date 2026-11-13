import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

// Native require so the test sees the same pdfmake instance report.service loads at runtime.
const nodeRequire = createRequire(import.meta.url)

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

import * as XLSX from 'xlsx'
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
  phone: string | null
  bankAccount: string | null
}> = {}) {
  return {
    id: 'emp-uuid-1',
    employeeId: 'EMP-001',
    employeeName: 'Ravi Kumar',
    designation: 'Guard',
    site: 'Site A',
    gPay: '9876543210',
    phone: '9123456780',
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
      { employeeId: 'emp-uuid-2', attendanceDate: new Date('2025-03-06'), regularHours: 8, overtimeHours: 0, beforeNoonIn: null, beforeNoonOut: null, afternoonIn: null, afternoonOut: null, overtimeIn: null, overtimeOut: null },
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

// ── US-12.32 / US-12.33: buildSlipData picks the layout by the week's source ─────

describe('buildSlipData: attendance source and punches', () => {
  const baseParams = () => ({
    runEmployee: makeRunEmployee(),
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    payrollRunId: 'run-uuid-1',
    payrollRevisionId: 'rev-uuid-1',
    attendanceRecords: makeAttendanceRecords('emp-uuid-1'),
    generatedAt: new Date('2025-03-14T10:00:00.000Z'),
  })

  it('writes a Punches cell per day for an eTimeOffice week from the stored pairs', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'ETIMEOFFICE',
      punchPairsByEmployeeDate: new Map([
        ['emp-uuid-1|2025-03-06', [{ in: '07:40', out: '13:04' }, { in: '13:56', out: '17:47' }]],
        ['emp-uuid-1|2025-03-07', [{ in: '08:00', out: '16:00' }]],
      ]),
    })

    expect(slip.attendanceSource).toBe('ETIMEOFFICE')
    expect(slip.dailyAttendance[0].punches).toBe('07:40–13:04, 13:56–17:47')
    expect(slip.dailyAttendance[1].punches).toBe('08:00–16:00')
  })

  it('shows "-" for a day with no punches', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'ETIMEOFFICE',
      punchPairsByEmployeeDate: new Map([['emp-uuid-1|2025-03-06', [{ in: '08:00', out: '16:00' }]]]),
    })

    expect(slip.dailyAttendance[0].punches).toBe('08:00–16:00')
    expect(slip.dailyAttendance.slice(1).every((row) => row.punches === '-')).toBe(true)
  })

  it('shows "-" on every day when an eTimeOffice week has no punch map at all', () => {
    const slip = buildSlipData({ ...baseParams(), attendanceSource: 'ETIMEOFFICE' })

    expect(slip.dailyAttendance.every((row) => row.punches === '-')).toBe(true)
  })

  it('keeps Reg Hrs and OT Hrs from the attendance records (the approved grid hours)', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'ETIMEOFFICE',
      punchPairsByEmployeeDate: new Map(),
    })

    expect(slip.dailyAttendance.map((r) => r.regularHours)).toEqual([8, 8, 8, 8, 6, 8])
    expect(slip.dailyAttendance.map((r) => r.overtimeHours)).toEqual([2, 0, 0, 3, 0, 1])
  })

  it('does not use another employee\'s punches (the map key carries the employee id)', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'ETIMEOFFICE',
      punchPairsByEmployeeDate: new Map([['emp-uuid-2|2025-03-06', [{ in: '08:00', out: '16:00' }]]]),
    })

    expect(slip.dailyAttendance[0].punches).toBe('-')
  })

  it('formats a punch edited from 17:47 to 18:00 exactly like any other punch (no edit marker)', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'ETIMEOFFICE',
      punchPairsByEmployeeDate: new Map([['emp-uuid-1|2025-03-06', [{ in: '07:40', out: '18:00' }]]]),
    })

    expect(slip.dailyAttendance[0].punches).toBe('07:40–18:00')
  })

  it('keeps the slot columns and adds no punches field for an Excel-era week', () => {
    const slip = buildSlipData({
      ...baseParams(),
      attendanceSource: 'EXCEL',
      // Even when a map is passed, an Excel week never reads it.
      punchPairsByEmployeeDate: new Map([['emp-uuid-1|2025-03-06', [{ in: '08:00', out: '16:00' }]]]),
    })

    expect(slip.attendanceSource).toBe('EXCEL')
    expect(slip.dailyAttendance[0]).not.toHaveProperty('punches')
    expect(slip.dailyAttendance[0].beforeNoonIn).toBe('09:00')
  })

  it('sets no attendanceSource and no punches when the caller gives none (pre-F12 snapshots)', () => {
    const slip = buildSlipData(baseParams())

    expect(slip).not.toHaveProperty('attendanceSource')
    expect(slip.dailyAttendance[0]).not.toHaveProperty('punches')
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

  it('lays out the same 16 columns as the summary Excel', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)
    const pdfmake = nodeRequire('pdfmake')
    const original = pdfmake.createPdf
    let captured: { content: Array<{ table?: PdfTable }> } | null = null
    const spy = vi.spyOn(pdfmake, 'createPdf').mockImplementation(function (this: unknown, docDef: unknown, ...rest: unknown[]) {
      captured = structuredClone(docDef) as typeof captured
      return original.call(this, docDef, ...rest)
    })
    try {
      await generatePayrollSummaryPdf('run-uuid-1')
    } finally {
      spy.mockRestore()
    }
    const docDef = captured as unknown as { content: Array<{ table?: PdfTable }> }
    const body = docDef.content.find((c) => c.table)!.table!.body
    expect(body[0].map((c) => plainText(c))).toEqual([
      'Sl No.', 'Emp ID', 'Emp Name', 'GPay No.', 'WhatsApp No.', 'Bank Acct.', 'Paid Name (if diff.)',
      'Salary from', 'Salary to', 'Reg. Hrs Pay', 'Overtime Hrs Pay', 'Additions', 'Deductions', 'Net Pay',
      'Payment Date', 'Payment Reference',
    ])
    const row = body[1].map((c) => plainText(c))
    expect(row[0]).toBe('1')
    expect(row[4]).toBe('')
    expect(row[5]).toBe('ACC123456')
    expect(row[7]).toBe('06 Mar 2025')
    expect(row[15]).toBe('2025-10-EMP-001')
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

  it('writes the 16 payment columns, one row per employee and totals for the pay columns', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)

    const { buffer } = await generatePayrollSummaryXlsx('run-uuid-1')
    // sheetStubs keeps formula-only cells, which carry no cached value
    const ws = XLSX.read(buffer, { type: 'buffer', sheetStubs: true }).Sheets.Summary
    const cell = (ref: string) => ws[ref]?.v

    const headers = 'ABCDEFGHIJKLMNOP'.split('').map((col) => cell(`${col}5`))
    expect(headers).toEqual([
      'Sl No.',
      'Emp ID',
      'Emp Name',
      'GPay No.',
      'WhatsApp No.',
      'Bank Acct.',
      'Paid Name (if diff.)',
      'Salary from',
      'Salary to',
      'Reg. Hrs Pay',
      'Overtime Hrs Pay',
      'Additions',
      'Deductions',
      'Net Pay',
      'Payment Date',
      'Payment Reference',
    ])
    expect(cell('Q5')).toBeUndefined()

    expect(cell('A6')).toBe(1)
    expect(cell('B6')).toBe('EMP-001')
    expect(cell('D6')).toBe('9876543210')
    // WhatsApp numbers aren't stored yet, so the phone number never fills this column
    expect(ws.E6).toBeUndefined()
    expect(cell('F6')).toBe('ACC123456')
    expect(ws.G6).toBeUndefined()
    expect(cell('H6')).toBe('06 Mar 2025')
    expect(cell('I6')).toBe('12 Mar 2025')
    expect(cell('J6')).toBe(2875)
    expect(cell('K6')).toBe(375)
    expect(cell('L6')).toBe(200)
    expect(cell('M6')).toBe(500)
    expect(cell('N6')).toBe(2950)
    expect(ws.O6).toBeUndefined()
    expect(cell('P6')).toBe('2025-10-EMP-001')

    expect(cell('A7')).toBe('TOTALS')
    for (const col of 'JKLMN') {
      expect(ws[`${col}7`].f).toBe(`SUM(${col}6:${col}6)`)
    }
  })

  it('freezes the title, header rows and the columns through Emp Name', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(makePayrollRun() as never)

    const { buffer } = await generatePayrollSummaryXlsx('run-uuid-1')
    const sheetXml = XLSX.CFB.find(XLSX.CFB.read(buffer, { type: 'buffer' }), '/xl/worksheets/sheet1.xml')!
    expect(Buffer.from(sheetXml.content as Uint8Array).toString('utf8')).toContain(
      '<pane xSplit="3" ySplit="5" topLeftCell="D6" activePane="bottomRight" state="frozen"/>',
    )
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

// ── US-12.32 / US-12.33: slip layout by week source (inspects the pdfmake document) ──

type PdfCell = { text?: unknown; colSpan?: number; font?: string; alignment?: string; bold?: boolean }
type PdfTable = { headerRows: number; widths: string[]; body: PdfCell[][] }

/** Flatten a pdfmake `text` value (string, nodes, nested nodes) into the plain text it renders. */
function plainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(plainText).join('')
  if (value && typeof value === 'object' && 'text' in value) return plainText((value as { text: unknown }).text)
  return ''
}

/** Builds the slip PDF for real while capturing the document definition handed to pdfmake. */
async function buildSlipAndCaptureAttendanceTable(slip: PayrollSlipData) {
  const pdfmake = nodeRequire('pdfmake')
  const original = pdfmake.createPdf
  // pdfmake rewrites the definition while it lays the page out (widths become objects), so
  // take a copy at the moment it is handed over and still let the real PDF be built.
  let captured: { content: Array<{ table?: PdfTable }> } | null = null
  const spy = vi.spyOn(pdfmake, 'createPdf').mockImplementation(function (this: unknown, docDef: unknown, ...rest: unknown[]) {
    captured = structuredClone(docDef) as typeof captured
    return original.call(this, docDef, ...rest)
  })
  try {
    const buffer = await generatePayrollSlipPdf(slip)
    expect(spy).toHaveBeenCalledTimes(1)
    const docDef = captured as unknown as { content: Array<{ table?: PdfTable }> }
    const node = docDef.content.find((c) => c.table?.body?.[0]?.[0]?.text === 'Day')
    if (!node?.table) throw new Error('Attendance table not found in the slip document')
    return { buffer, table: node.table }
  } finally {
    spy.mockRestore()
  }
}

const NO_SLOTS = { beforeNoonIn: null, beforeNoonOut: null, afternoonIn: null, afternoonOut: null, overtimeIn: null, overtimeOut: null }

function makeApiSlipData(overrides: Partial<PayrollSlipData> = {}): PayrollSlipData {
  return makeSlipData({
    attendanceSource: 'ETIMEOFFICE',
    dailyAttendance: [
      { day: 'Thursday', date: '6 Mar', punches: '07:40–13:04, 13:56–17:47', regularHours: 8, overtimeHours: 1.25, ...NO_SLOTS },
      { day: 'Friday', date: '7 Mar', punches: '08:00–16:00', regularHours: 8, overtimeHours: 0, ...NO_SLOTS },
      { day: 'Saturday', date: '8 Mar', punches: '-', regularHours: 0, overtimeHours: 0, ...NO_SLOTS },
    ],
    regularHours: 16,
    overtimeHours: 1.25,
    ...overrides,
  })
}

describe('generatePayrollSlipPdf: API-week (eTimeOffice) layout', () => {
  it('has Day | Date | Punches | Reg Hrs | OT Hrs and no BN / AN / OT In-Out columns', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    const headers = table.body[0].map((cell) => plainText(cell.text))
    expect(headers).toEqual(['Day', 'Date', 'Punches', 'Reg Hrs', 'OT Hrs'])
    for (const old of ['BN In', 'BN Out', 'AN In', 'AN Out', 'OT In', 'OT Out']) {
      expect(headers).not.toContain(old)
    }
    expect(table.widths).toEqual(['auto', 'auto', '*', 'auto', 'auto'])
    expect(table.headerRows).toBe(1)
  })

  it('shows each day\'s Punches value, such as "07:40–13:04, 13:56–17:47"', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    const rows = table.body.slice(1, -1)
    expect(rows).toHaveLength(3)
    expect(plainText(rows[0][2].text)).toBe('07:40–13:04, 13:56–17:47')
    expect(plainText(rows[1][2].text)).toBe('08:00–16:00')
  })

  it('shows "-" for a day with no punches, and also when the punches value is missing', async () => {
    const slip = makeApiSlipData({
      dailyAttendance: [
        { day: 'Thursday', date: '6 Mar', punches: '-', regularHours: 0, overtimeHours: 0, ...NO_SLOTS },
        { day: 'Friday', date: '7 Mar', punches: null, regularHours: 0, overtimeHours: 0, ...NO_SLOTS },
        { day: 'Saturday', date: '8 Mar', regularHours: 0, overtimeHours: 0, ...NO_SLOTS },
      ],
    })

    const { table } = await buildSlipAndCaptureAttendanceTable(slip)

    expect(table.body.slice(1, -1).map((row) => plainText(row[2].text))).toEqual(['-', '-', '-'])
  })

  it('keeps each pair in one no-wrap piece so a long day wraps only after a comma', async () => {
    const slip = makeApiSlipData({
      dailyAttendance: [
        {
          day: 'Thursday',
          date: '6 Mar',
          punches: '07:00–08:00, 09:00–10:00, 11:00–12:00, 13:00–14:00, 15:00–16:00',
          regularHours: 5,
          overtimeHours: 0,
          ...NO_SLOTS,
        },
      ],
    })

    const { table } = await buildSlipAndCaptureAttendanceTable(slip)
    const cell = table.body[1][2]

    const nodes = cell.text as Array<{ text: string; noWrap?: boolean }>
    const pairNodes = nodes.filter((n) => n.noWrap)
    expect(pairNodes.map((n) => n.text)).toEqual([
      '07:00–08:00', '09:00–10:00', '11:00–12:00', '13:00–14:00', '15:00–16:00',
    ])
    // The only wrap points are the ", " separators between pairs.
    expect(nodes.filter((n) => !n.noWrap).every((n) => n.text === ', ')).toBe(true)
    expect(cell.font).toBe('Courier')
    expect(cell.alignment).toBe('left')
  })

  it('prints Reg Hrs and OT Hrs to two decimals, matching the approved grid hours', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    const rows = table.body.slice(1, -1)
    expect(rows.map((r) => plainText(r[3].text))).toEqual(['8.00', '8.00', '0.00'])
    expect(rows.map((r) => plainText(r[4].text))).toEqual(['1.25', '0.00', '0.00'])
  })

  it('ends with a TOTAL row spanning the first three columns, with the slip totals', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    const total = table.body[table.body.length - 1]
    expect(total).toHaveLength(5)
    expect(plainText(total[0].text)).toBe('TOTAL')
    expect(total[0].colSpan).toBe(3)
    expect(plainText(total[3].text)).toBe('16.00')
    expect(plainText(total[4].text)).toBe('1.25')
  })

  it('every body row has the same number of cells as the header', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    expect(table.body.every((row) => row.length === 5)).toBe(true)
  })

  it('builds a real PDF buffer for the Punches layout (en dash and Courier render without error)', async () => {
    const { buffer } = await buildSlipAndCaptureAttendanceTable(makeApiSlipData())

    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('generatePayrollSlipPdf: Excel-era layout is unchanged', () => {
  const EXCEL_HEADERS = ['Day', 'Date', 'BN In', 'BN Out', 'AN In', 'AN Out', 'OT In', 'OT Out', 'Reg Hrs', 'OT Hrs']

  it('keeps the six In/Out columns and no Punches column for an Excel slip', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeSlipData({ attendanceSource: 'EXCEL' }))

    const headers = table.body[0].map((cell) => plainText(cell.text))
    expect(headers).toEqual(EXCEL_HEADERS)
    expect(headers).not.toContain('Punches')
    expect(table.widths).toHaveLength(10)
  })

  it('keeps the six-column layout for a snapshot with no attendanceSource (pre-F12)', async () => {
    const slip = makeSlipData()
    expect(slip.attendanceSource).toBeUndefined()

    const { table } = await buildSlipAndCaptureAttendanceTable(slip)

    expect(table.body[0].map((cell) => plainText(cell.text))).toEqual(EXCEL_HEADERS)
  })

  it('still prints the slot times and hours, with TOTAL spanning eight columns', async () => {
    const { table } = await buildSlipAndCaptureAttendanceTable(makeSlipData({ attendanceSource: 'EXCEL' }))

    const first = table.body[1]
    expect(first.map((c) => plainText(c.text))).toEqual([
      'Thursday', '6 Mar', '09:00', '13:00', '14:00', '18:00', '18:00', '20:00', '8.00', '2.00',
    ])
    const total = table.body[table.body.length - 1]
    expect(total[0].colSpan).toBe(8)
    expect(total).toHaveLength(10)
  })

  it('ignores a punches value on an Excel slip', async () => {
    const slip = makeSlipData({
      attendanceSource: 'EXCEL',
      dailyAttendance: [
        { day: 'Thursday', date: '6 Mar', punches: '07:40–13:04', regularHours: 8, overtimeHours: 0, ...NO_SLOTS, beforeNoonIn: '09:00' },
      ],
    })

    const { table } = await buildSlipAndCaptureAttendanceTable(slip)

    expect(table.body[0].map((c) => plainText(c.text))).not.toContain('Punches')
    expect(table.body[1].map((c) => plainText(c.text))).not.toContain('07:40–13:04')
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

  // ── US-12.32 / US-12.33: the week's source picks the layout and where punches come from ──

  /** The slip snapshots the zip run saved, as the JSON that was stored. */
  function savedSlips(): PayrollSlipData[] {
    const call = vi.mocked(prisma.invoiceSnapshot.createMany).mock.calls[0][0] as unknown as {
      data: Array<{ invoiceSnapshotJson: PayrollSlipData }>
    }
    return call.data.map((d) => d.invoiceSnapshotJson)
  }

  function punchRow(over: {
    date: string
    pairIndex: number
    position: 'IN' | 'OUT'
    original: string | null
    current: string | null
    source?: 'API' | 'MANUAL'
    employeeId?: string
  }) {
    return {
      id: `p-${over.date}-${over.pairIndex}-${over.position}`,
      employeeId: over.employeeId ?? 'emp-uuid-1',
      punchDate: new Date(`${over.date}T00:00:00.000Z`),
      pairIndex: over.pairIndex,
      position: over.position,
      source: over.source ?? 'API',
      originalTime: over.original,
      currentTime: over.current,
      note: null,
    }
  }

  describe('for an eTimeOffice week', () => {
    beforeEach(() => {
      vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue({ id: 'upload-api', source: 'ETIMEOFFICE' } as never)
      vi.mocked(prisma.attendancePunch.findMany).mockResolvedValue([
        // 6 Mar: two complete pairs, rows deliberately out of order.
        punchRow({ date: '2025-03-06', pairIndex: 1, position: 'OUT', original: '17:47', current: '17:47' }),
        punchRow({ date: '2025-03-06', pairIndex: 0, position: 'IN', original: '07:40', current: '07:40' }),
        punchRow({ date: '2025-03-06', pairIndex: 1, position: 'IN', original: '13:56', current: '13:56' }),
        punchRow({ date: '2025-03-06', pairIndex: 0, position: 'OUT', original: '13:04', current: '13:04' }),
        // 7 Mar: an edited out punch (17:47 -> 18:00) looks like any other.
        punchRow({ date: '2025-03-07', pairIndex: 0, position: 'IN', original: '07:40', current: '07:40' }),
        punchRow({ date: '2025-03-07', pairIndex: 0, position: 'OUT', original: '17:47', current: '18:00' }),
        // 8 Mar: a hand-added pair.
        punchRow({ date: '2025-03-08', pairIndex: 0, position: 'IN', original: null, current: '08:00', source: 'MANUAL' }),
        punchRow({ date: '2025-03-08', pairIndex: 0, position: 'OUT', original: null, current: '16:00', source: 'MANUAL' }),
        // 9 Mar: an incomplete pair adds no punches to the slip.
        punchRow({ date: '2025-03-09', pairIndex: 0, position: 'IN', original: '18:26', current: '18:26' }),
      ] as never)
    })

    it('loads the week\'s source row and the live punches of the run\'s employees only', async () => {
      await generatePayrollSlipsZip('run-uuid-1')

      expect(prisma.attendanceUpload.findFirst).toHaveBeenCalledWith({
        where: {
          payrollWeekStartDate: WEEK_START,
          payrollWeekEndDate: WEEK_END,
          isActiveForPayrollWeek: true,
        },
        select: { id: true, source: true },
      })
      expect(prisma.attendancePunch.findMany).toHaveBeenCalledTimes(1)
      const where = vi.mocked(prisma.attendancePunch.findMany).mock.calls[0][0]?.where
      expect(where).toEqual({
        attendanceUploadId: 'upload-api',
        correctionId: null, // the live set, never a correction draft
        employeeId: { in: ['emp-uuid-1'] },
        currentTime: { not: null }, // deleted punches are left out
      })
    })

    it('writes the Punches values and the eTimeOffice source into the saved slip', async () => {
      await generatePayrollSlipsZip('run-uuid-1')

      const [slip] = savedSlips()
      expect(slip.attendanceSource).toBe('ETIMEOFFICE')
      expect(slip.dailyAttendance.map((r) => r.punches)).toEqual([
        '07:40–13:04, 13:56–17:47', // 6 Mar, paired and ordered
        '07:40–18:00', // 7 Mar, edited: no marker
        '08:00–16:00', // 8 Mar, hand-added: same look
        '-', // 9 Mar, incomplete pair only
        '-', // 10 Mar, no punches
        '-', // 11 Mar, no punches
      ])
    })

    it('keeps Reg Hrs and OT Hrs from the attendance records', async () => {
      await generatePayrollSlipsZip('run-uuid-1')

      const [slip] = savedSlips()
      expect(slip.dailyAttendance.map((r) => r.regularHours)).toEqual([8, 8, 8, 8, 6, 8])
      expect(slip.dailyAttendance.map((r) => r.overtimeHours)).toEqual([2, 0, 0, 3, 0, 1])
    })

    it('saves one slip per run employee, so a zero-hour employee (no run row) gets none', async () => {
      await generatePayrollSlipsZip('run-uuid-1')

      expect(savedSlips()).toHaveLength(1)
      expect(savedSlips()[0].employeeDbId).toBe('emp-uuid-1')
    })

    it('does not mix in another employee\'s punches', async () => {
      vi.mocked(prisma.attendancePunch.findMany).mockResolvedValue([
        punchRow({ date: '2025-03-06', pairIndex: 0, position: 'IN', original: '09:00', current: '09:00', employeeId: 'emp-other' }),
        punchRow({ date: '2025-03-06', pairIndex: 0, position: 'OUT', original: '10:00', current: '10:00', employeeId: 'emp-other' }),
      ] as never)

      await generatePayrollSlipsZip('run-uuid-1')

      expect(savedSlips()[0].dailyAttendance.every((r) => r.punches === '-')).toBe(true)
    })

    it('still returns the zip when the week has no punches at all', async () => {
      vi.mocked(prisma.attendancePunch.findMany).mockResolvedValue([])

      const result = await generatePayrollSlipsZip('run-uuid-1')

      expect(result.fileName).toBe('payroll_slips_06Mar_12Mar.zip')
      expect(savedSlips()[0].dailyAttendance.every((r) => r.punches === '-')).toBe(true)
    })

    it('fails the zip when the punches cannot be loaded, and saves no snapshots', async () => {
      vi.mocked(prisma.attendancePunch.findMany).mockRejectedValue(new Error('db down'))

      await expect(generatePayrollSlipsZip('run-uuid-1')).rejects.toThrow('db down')
      expect(prisma.invoiceSnapshot.createMany).not.toHaveBeenCalled()
    })
  })

  describe('for an Excel-era week', () => {
    it('loads no punches and keeps the six-column slip', async () => {
      // The outer beforeEach already returns an EXCEL upload.
      await generatePayrollSlipsZip('run-uuid-1')

      expect(prisma.attendancePunch.findMany).not.toHaveBeenCalled()
      const [slip] = savedSlips()
      expect(slip.attendanceSource).toBe('EXCEL')
      expect(slip.dailyAttendance[0]).not.toHaveProperty('punches')
      expect(slip.dailyAttendance[0].beforeNoonIn).toBe('09:00')
    })
  })

  describe('for a week with no attendance row', () => {
    it('falls back to the six-column slip and loads no punches', async () => {
      vi.mocked(prisma.attendanceUpload.findFirst).mockResolvedValue(null)

      await generatePayrollSlipsZip('run-uuid-1')

      expect(prisma.attendancePunch.findMany).not.toHaveBeenCalled()
      expect(savedSlips()[0].attendanceSource).toBe('EXCEL')
    })
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
