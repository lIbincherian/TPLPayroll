import path from 'path'
import prisma from '@/lib/prisma'
import * as XLSX from 'xlsx'

import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces'
import JSZip from 'jszip'
import {
  ReportServiceError,
  type PayrollSlipData,
  type DailyAttendanceRow,
  type SlipAttendanceSource,
} from '@/features/payroll-reports/types/report.types'
import { formatPunchesCell, pairsFromStoredPunches } from '@/features/attendance-sync/lib/hours'
import { paymentReference, toISODate } from '@/features/attendance-sync/lib/week'
import { formatNetPay, isWholeRupees } from '@/features/payroll-generation/lib/format-net-pay'

let fontsConfigured = false

/** The font for every ₹ amount cell: pdfmake's standard fonts have no ₹ glyph. */
export const AMOUNT_FONT = 'DejaVuSansMono'

/** Shipped to the server output through outputFileTracingIncludes in next.config.ts. */
const AMOUNT_FONT_DIR = path.join(process.cwd(), 'src/features/payroll-reports/assets/fonts')

function configureFonts() {
  if (fontsConfigured) return
  
  const fonts = {
    Helvetica: {
      normal: 'Helvetica',
      bold: 'Helvetica-Bold',
      italics: 'Helvetica-Oblique',
      bolditalics: 'Helvetica-BoldOblique',
    },
    Courier: {
      normal: 'Courier',
      bold: 'Courier-Bold',
      italics: 'Courier-Oblique',
      bolditalics: 'Courier-BoldOblique',
    },
    [AMOUNT_FONT]: {
      normal: path.join(AMOUNT_FONT_DIR, 'DejaVuSansMono.ttf'),
      bold: path.join(AMOUNT_FONT_DIR, 'DejaVuSansMono-Bold.ttf'),
    },
  }
  
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfmake is a server-external CommonJS package (next.config serverExternalPackages); keep the runtime require
  const pdfmake = require('pdfmake')
  pdfmake.setFonts(fonts)
  fontsConfigured = true
}

async function toPdfBuffer(docDef: TDocumentDefinitions): Promise<Buffer> {
  configureFonts()
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- pdfmake is a server-external CommonJS package (next.config serverExternalPackages); keep the runtime require
  const pdfmake = require('pdfmake')
  const doc = pdfmake.createPdf(docDef)
  return doc.getBuffer()
}


// ── Pure helpers (exported for unit tests) ───────────────────────────────────

export function formatSlipDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  const month = date.toLocaleString('en-US', { month: 'short' })
  return `${day}${month}`
}

export function formatZipFileName(weekStart: Date, weekEnd: Date): string {
  return `payroll_slips_${formatSlipDate(weekStart)}_${formatSlipDate(weekEnd)}.zip`
}

export function formatSlipPdfName(employeeCode: string, employeeName: string): string {
  const safeName = employeeName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_')
  return `${employeeCode}_${safeName}.pdf`
}

export function formatCurrencyPdf(amount: number): string {
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `₹${formatted}`
}

/** Net pay in a PDF: whole rupees without decimals, an older stored amount with paise keeps them. */
export function formatNetPayPdf(amount: number): string {
  return `₹${formatNetPay(amount)}`
}

/** The Excel number format for a net-pay cell: no decimals when the amount is whole. */
export function netPayXlsxFormat(amount: number): string {
  return isWholeRupees(amount) ? '"₹"#,##0' : '"₹"#,##0.00'
}

export function formatHours(hours: number): string {
  return hours.toFixed(2)
}

export function buildSlipData(params: {
  runEmployee: {
    id: string
    payrollRunId: string
    payrollRevisionId: string
    employeeId: string
    hourlyRateUsed: number | { toNumber(): number }
    regularHours: number | { toNumber(): number }
    overtimeHours: number | { toNumber(): number }
    regularPay: number | { toNumber(): number }
    overtimePay: number | { toNumber(): number }
    additions: number | { toNumber(): number }
    deductions: number | { toNumber(): number }
    netPayable: number | { toNumber(): number }
    employee: {
      id: string
      employeeId: string
      employeeName: string
      designation: string
      site: string | null
      gPay: string | null
      bankAccount: string | null
    }
  }
  weekStart: Date
  weekEnd: Date
  payrollRunId: string
  payrollRevisionId: string
  attendanceRecords: Array<{
    employeeId: string
    attendanceDate: Date
    regularHours: number | { toNumber(): number }
    overtimeHours: number | { toNumber(): number }
    beforeNoonIn: string | null
    beforeNoonOut: string | null
    afternoonIn: string | null
    afternoonOut: string | null
    overtimeIn: string | null
    overtimeOut: string | null
  }>
  generatedAt: Date
  /** 'ETIMEOFFICE' weeks get the Punches layout; Excel-era weeks (or undefined) keep the six slot columns. */
  attendanceSource?: SlipAttendanceSource
  /** Complete punch pairs keyed by `${employee.id}|${YYYY-MM-DD}`. Only read for ETIMEOFFICE weeks. */
  punchPairsByEmployeeDate?: Map<string, Array<{ in: string; out: string }>>
}): PayrollSlipData {
  const {
    runEmployee,
    weekStart,
    weekEnd,
    payrollRunId,
    payrollRevisionId,
    attendanceRecords,
    generatedAt,
    attendanceSource,
    punchPairsByEmployeeDate,
  } = params
  const { employee } = runEmployee

  const toNum = (val: number | { toNumber(): number }): number =>
    typeof val === 'number' ? val : Number(val)

  const employeeRecords = attendanceRecords
    .filter((r) => r.employeeId === employee.id)
    .sort((a, b) => a.attendanceDate.getTime() - b.attendanceDate.getTime())

  const dailyAttendance: DailyAttendanceRow[] = employeeRecords.map((r) => {
    const d = r.attendanceDate
    const day = d.toLocaleString('en-US', { weekday: 'long' })
    const date = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`
    const pairs = punchPairsByEmployeeDate?.get(`${employee.id}|${toISODate(d)}`) ?? []
    return {
      day,
      date,
      ...(attendanceSource === 'ETIMEOFFICE'
        ? { punches: pairs.length > 0 ? formatPunchesCell(pairs) : '-' }
        : {}),
      beforeNoonIn: r.beforeNoonIn,
      beforeNoonOut: r.beforeNoonOut,
      afternoonIn: r.afternoonIn,
      afternoonOut: r.afternoonOut,
      overtimeIn: r.overtimeIn,
      overtimeOut: r.overtimeOut,
      regularHours: toNum(r.regularHours),
      overtimeHours: toNum(r.overtimeHours),
    }
  })

  const hourlyRateUsed = toNum(runEmployee.hourlyRateUsed)
  const regularHours = toNum(runEmployee.regularHours)
  const overtimeHours = toNum(runEmployee.overtimeHours)
  const regularPay = toNum(runEmployee.regularPay)
  const overtimePay = toNum(runEmployee.overtimePay)
  const additions = toNum(runEmployee.additions)
  const deductions = toNum(runEmployee.deductions)
  const netPayable = toNum(runEmployee.netPayable)
  const grossPay = regularPay + overtimePay

  return {
    employeeCode: employee.employeeId,
    employeeName: employee.employeeName,
    designation: employee.designation,
    site: employee.site,
    gPay: employee.gPay,
    bankAccount: employee.bankAccount,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    payrollRunId,
    payrollRevisionId,
    employeeDbId: employee.id,
    ...(attendanceSource ? { attendanceSource } : {}),
    dailyAttendance,
    regularHours,
    overtimeHours,
    hourlyRateUsed,
    regularPay,
    overtimePay,
    grossPay,
    additions,
    deductions,
    netPayable,
    generatedAt: generatedAt.toISOString(),
  }
}

export async function generatePayrollSummaryPdf(payrollRunId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: { where: { isCurrent: true }, take: 1 },
      runEmployees: {
        where: { payrollRevision: { isCurrent: true } },
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              employeeName: true,
              designation: true,
              site: true,
              gPay: true,
              bankAccount: true,
            },
          },
        },
        orderBy: { employee: { employeeId: 'asc' } },
      },
    },
  })

  if (!run) {
    throw new ReportServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run ${payrollRunId} not found`)
  }
  if (run.status !== 'APPROVED' && run.status !== 'REVISED') {
    throw new ReportServiceError('PAYROLL_NOT_APPROVED', `Payroll run ${payrollRunId} is not approved`)
  }

  const weekStartStr = run.payrollWeekStartDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const weekEndStr = run.payrollWeekEndDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const generatedAtStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

  const salaryDateFormat: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }
  const salaryFromStr = run.payrollWeekStartDate.toLocaleDateString('en-GB', salaryDateFormat)
  const salaryToStr = run.payrollWeekEndDate.toLocaleDateString('en-GB', salaryDateFormat)
  const weekStartISO = toISODate(run.payrollWeekStartDate)

  // Same 16 columns as the summary Excel
  const headerRow = [
    { text: 'Sl No.', style: 'tableHeader', alignment: 'right' },
    { text: 'Emp ID', style: 'tableHeader' },
    { text: 'Emp Name', style: 'tableHeader' },
    { text: 'GPay No.', style: 'tableHeader' },
    { text: 'WhatsApp No.', style: 'tableHeader' },
    { text: 'Bank Acct.', style: 'tableHeader' },
    { text: 'Paid Name (if diff.)', style: 'tableHeader' },
    { text: 'Salary from', style: 'tableHeader' },
    { text: 'Salary to', style: 'tableHeader' },
    { text: 'Reg. Hrs Pay', style: 'tableHeader', alignment: 'right' },
    { text: 'Overtime Hrs Pay', style: 'tableHeader', alignment: 'right' },
    { text: 'Additions', style: 'tableHeader', alignment: 'right' },
    { text: 'Deductions', style: 'tableHeader', alignment: 'right' },
    { text: 'Net Pay', style: 'tableHeader', alignment: 'right' },
    { text: 'Payment Date', style: 'tableHeader' },
    { text: 'Payment Reference', style: 'tableHeader' },
  ]

  // WhatsApp numbers aren't stored yet; WhatsApp No., Paid Name and Payment Date stay blank
  const dataRows = run.runEmployees.map((re, i) => [
    { text: String(i + 1), font: 'Courier', alignment: 'right' },
    { text: re.employee.employeeId, font: 'Courier' },
    { text: re.employee.employeeName, font: 'Helvetica' },
    { text: re.employee.gPay ?? '-', font: 'Courier' },
    { text: '' },
    { text: re.employee.bankAccount ?? '-', font: 'Courier' },
    { text: '' },
    { text: salaryFromStr, font: 'Helvetica' },
    { text: salaryToStr, font: 'Helvetica' },
    { text: formatCurrencyPdf(Number(re.regularPay)), font: AMOUNT_FONT, alignment: 'right' },
    { text: formatCurrencyPdf(Number(re.overtimePay)), font: AMOUNT_FONT, alignment: 'right' },
    { text: formatCurrencyPdf(Number(re.additions)), font: AMOUNT_FONT, alignment: 'right' },
    { text: formatCurrencyPdf(Number(re.deductions)), font: AMOUNT_FONT, alignment: 'right' },
    { text: formatNetPayPdf(Number(re.netPayable)), font: AMOUNT_FONT, alignment: 'right' },
    { text: '' },
    { text: paymentReference(weekStartISO, re.employee.employeeId), font: 'Courier' },
  ])

  const totalsRow = [
    { text: 'TOTALS', colSpan: 9, style: 'totalsLabel', font: 'Helvetica' },
    {}, {}, {}, {}, {}, {}, {}, {},
    { text: formatCurrencyPdf(Number(run.totalRegularPay)), font: AMOUNT_FONT, alignment: 'right', bold: true },
    { text: formatCurrencyPdf(Number(run.totalOvertimePay)), font: AMOUNT_FONT, alignment: 'right', bold: true },
    { text: formatCurrencyPdf(Number(run.totalAdditions)), font: AMOUNT_FONT, alignment: 'right', bold: true },
    { text: formatCurrencyPdf(Number(run.totalDeductions)), font: AMOUNT_FONT, alignment: 'right', bold: true },
    { text: formatNetPayPdf(Number(run.totalNetPayable)), font: AMOUNT_FONT, alignment: 'right', bold: true },
    { text: '', colSpan: 2 },
    {},
  ]

  const docDef: TDocumentDefinitions = {
    pageOrientation: 'landscape',
    pageSize: 'A3',
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    styles: {
      title: { fontSize: 14, bold: true, alignment: 'center', font: 'Helvetica' },
      subtitle: { fontSize: 9, alignment: 'center', font: 'Helvetica', color: '#555555' },
      tableHeader: { bold: true, font: 'Helvetica', fillColor: '#dddddd' },
      totalsLabel: { bold: true, font: 'Helvetica' },
    },
    content: [
      { text: 'PAYROLL SUMMARY', style: 'title', marginBottom: 4 },
      { text: `Week: ${weekStartStr} – ${weekEndStr}`, style: 'subtitle' },
      { text: `Generated: ${generatedAtStr}`, style: 'subtitle', marginBottom: 8 },
      {
        table: {
          headerRows: 1,
          widths: ['auto', 'auto', '*', ...Array(13).fill('auto')],
          body: [headerRow, ...dataRows, totalsRow],
        },
        layout: 'lightHorizontalLines',
      } as Content,
    ],
  }

  const buffer = await toPdfBuffer(docDef)
  const fileName = `payroll_summary_${formatSlipDate(run.payrollWeekStartDate)}-${formatSlipDate(run.payrollWeekEndDate)}.pdf`

  return { buffer, fileName }
}

export async function generatePayrollSummaryXlsx(payrollRunId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: { where: { isCurrent: true }, take: 1 },
      runEmployees: {
        where: { payrollRevision: { isCurrent: true } },
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              employeeName: true,
              designation: true,
              site: true,
              gPay: true,
              bankAccount: true,
            },
          },
        },
        orderBy: { employee: { employeeId: 'asc' } },
      },
    },
  })

  if (!run) {
    throw new ReportServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run ${payrollRunId} not found`)
  }
  if (run.status !== 'APPROVED' && run.status !== 'REVISED') {
    throw new ReportServiceError('PAYROLL_NOT_APPROVED', `Payroll run ${payrollRunId} is not approved`)
  }

  const weekStartStr = run.payrollWeekStartDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const weekEndStr = run.payrollWeekEndDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const generatedAtStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

  const salaryDateFormat: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }
  const salaryFromStr = run.payrollWeekStartDate.toLocaleDateString('en-GB', salaryDateFormat)
  const salaryToStr = run.payrollWeekEndDate.toLocaleDateString('en-GB', salaryDateFormat)
  const weekStartISO = toISODate(run.payrollWeekStartDate)

  const headers = [
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
  ]

  const aoa: (string | number | null)[][] = [
    ['PAYROLL SUMMARY'],
    [`Week: ${weekStartStr} – ${weekEndStr}`],
    [`Generated: ${generatedAtStr}`],
    [], // Blank row
    headers,
  ]

  // WhatsApp numbers aren't stored yet; null leaves WhatsApp No., Paid Name and Payment Date as empty cells (no value)
  run.runEmployees.forEach((re, i) => {
    aoa.push([
      i + 1,
      re.employee.employeeId,
      re.employee.employeeName,
      re.employee.gPay || '-',
      null, // WhatsApp No.
      re.employee.bankAccount || '-',
      null, // Paid Name (if diff.)
      salaryFromStr,
      salaryToStr,
      Number(re.regularPay),
      Number(re.overtimePay),
      Number(re.additions),
      Number(re.deductions),
      Number(re.netPayable),
      null, // Payment Date
      paymentReference(weekStartISO, re.employee.employeeId),
    ])
  })

  // Add totals row placeholder
  aoa.push([
    'TOTALS',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    0, // Reg. Hrs Pay
    0, // Overtime Hrs Pay
    0, // Additions
    0, // Deductions
    0, // Net Pay
  ])

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  const startRow = 6 // Excel row 6 (1-based index)
  const endRow = 5 + run.runEmployees.length // Last employee row (Excel row index)
  const totalRowIdx = 5 + run.runEmployees.length + 1 // Totals Excel row

  // Format numeric column helper
  const formatCol = (colLetter: string, isCurrency: boolean) => {
    // Format data cells
    for (let r = startRow; r <= endRow; r++) {
      const cellRef = `${colLetter}${r}`
      if (ws[cellRef]) {
        ws[cellRef].t = 'n'
        ws[cellRef].z = isCurrency ? '"₹"#,##0.00' : '0.00'
      }
    }
    // Format totals cell
    const totalCellRef = `${colLetter}${totalRowIdx}`
    ws[totalCellRef] = {
      t: 'n',
      f: `SUM(${colLetter}${startRow}:${colLetter}${endRow})`,
      z: isCurrency ? '"₹"#,##0.00' : '0.00',
    }
  }

  // Format the columns:
  formatCol('J', true) // Reg. Hrs Pay
  formatCol('K', true) // Overtime Hrs Pay
  formatCol('L', true) // Additions
  formatCol('M', true) // Deductions
  formatCol('N', true) // Net Pay
  // Net pay is whole rupees, so its cells drop the decimals unless an older stored amount has paise.
  for (let r = startRow; r <= endRow; r++) {
    const cell = ws[`N${r}`]
    if (cell) cell.z = netPayXlsxFormat(Number(cell.v))
  }
  ws[`N${totalRowIdx}`].z = netPayXlsxFormat(
    run.runEmployees.reduce((sum, re) => sum + Number(re.netPayable), 0),
  )

  // Setup merges
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } }, // Merge Title
    { s: { r: 1, c: 0 }, e: { r: 1, c: 15 } }, // Merge Week range
    { s: { r: 2, c: 0 }, e: { r: 2, c: 15 } }, // Merge Generated date
  ]

  // Auto-fit column widths
  const maxCols = 16
  const wcols = Array(maxCols).fill(0).map(() => ({ wch: 10 }))
  // Start at the header row: the merged title, week and generated lines would widen column A.
  for (let r = 4; r < aoa.length; r++) {
    for (let c = 0; c < maxCols; c++) {
      const val = aoa[r][c]
      if (val !== undefined && val !== null) {
        let strLen = String(val).length
        if (typeof val === 'number') {
          if (c >= 9 && c <= 13) {
            strLen += 5 // for "₹" and decimals/commas formatting
          }
        }
        if (strLen > wcols[c].wch) {
          wcols[c].wch = strLen
        }
      }
    }
  }
  wcols[1].wch = Math.max(wcols[1].wch, 12) // Emp ID
  wcols[2].wch = Math.max(wcols[2].wch, 22) // Emp Name
  wcols[3].wch = Math.max(wcols[3].wch, 12) // GPay No.
  wcols[4].wch = Math.max(wcols[4].wch, 12) // WhatsApp No.
  wcols[5].wch = Math.max(wcols[5].wch, 16) // Bank Acct.
  wcols[6].wch = Math.max(wcols[6].wch, 20) // Paid Name (if diff.)
  wcols[14].wch = Math.max(wcols[14].wch, 14) // Payment Date
  ws['!cols'] = wcols

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Summary')

  const buffer = freezeSummaryPanes(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer))
  const fileName = `payroll_summary_${formatSlipDate(run.payrollWeekStartDate)}-${formatSlipDate(run.payrollWeekEndDate)}.xlsx`

  return { buffer, fileName }
}

/**
 * Freezes rows 1-5 (title lines and headers) and columns A-C (through Emp Name) on the summary
 * sheet. SheetJS community edition can't write frozen panes, so this edits the sheet XML in the zip.
 */
function freezeSummaryPanes(xlsx: Buffer): Buffer {
  const zip = XLSX.CFB.read(xlsx, { type: 'buffer' })
  const sheet = XLSX.CFB.find(zip, '/xl/worksheets/sheet1.xml')
  if (!sheet) throw new Error('Summary sheet missing from workbook')
  const xml = Buffer.from(sheet.content as Uint8Array).toString('utf8')
  const frozen = xml.replace(
    '<sheetView workbookViewId="0"/>',
    '<sheetView workbookViewId="0"><pane xSplit="3" ySplit="5" topLeftCell="D6" activePane="bottomRight" state="frozen"/></sheetView>',
  )
  if (frozen === xml) throw new Error('Summary sheet view not found')
  sheet.content = Buffer.from(frozen, 'utf8')
  sheet.size = sheet.content.length
  return Buffer.from(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer)
}

/**
 * The Punches cell: one Courier node per pair. pdfmake breaks lines after an en dash as
 * well as after a space, so each pair is its own no-wrap node and a long day wraps only
 * after a comma, never inside a pair.
 */
function punchesCell(punches: string | null | undefined): Record<string, unknown> {
  const base = { font: 'Courier', alignment: 'left' }
  if (!punches || punches === '-') return { ...base, text: '-' }

  const pairs = punches.split(', ')
  return {
    ...base,
    text: pairs.flatMap((pair, index) => [
      { text: pair, noWrap: true },
      ...(index < pairs.length - 1 ? [{ text: ', ' }] : []),
    ]),
  }
}

export async function generatePayrollSlipPdf(slip: PayrollSlipData): Promise<Buffer> {
  const weekStartDate = new Date(slip.weekStart)
  const weekEndDate = new Date(slip.weekEnd)
  const generatedAtDate = new Date(slip.generatedAt)

  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

  // API weeks show one Punches column; Excel-era weeks (and snapshots from before F12,
  // which have no attendanceSource) keep the six In/Out columns unchanged.
  const usePunchesLayout = slip.attendanceSource === 'ETIMEOFFICE'

  const slotTableBody = [
    [
      { text: 'Day', style: 'tableHeader' },
      { text: 'Date', style: 'tableHeader' },
      { text: 'BN In', style: 'tableHeader' },
      { text: 'BN Out', style: 'tableHeader' },
      { text: 'AN In', style: 'tableHeader' },
      { text: 'AN Out', style: 'tableHeader' },
      { text: 'OT In', style: 'tableHeader' },
      { text: 'OT Out', style: 'tableHeader' },
      { text: 'Reg Hrs', style: 'tableHeader' },
      { text: 'OT Hrs', style: 'tableHeader' },
    ],
    ...slip.dailyAttendance.map((row) => [
      { text: row.day, font: 'Helvetica' },
      { text: row.date, font: 'Helvetica' },
      { text: row.beforeNoonIn ?? '-', font: 'Courier', alignment: 'center' },
      { text: row.beforeNoonOut ?? '-', font: 'Courier', alignment: 'center' },
      { text: row.afternoonIn ?? '-', font: 'Courier', alignment: 'center' },
      { text: row.afternoonOut ?? '-', font: 'Courier', alignment: 'center' },
      { text: row.overtimeIn ?? '-', font: 'Courier', alignment: 'center' },
      { text: row.overtimeOut ?? '-', font: 'Courier', alignment: 'center' },
      { text: formatHours(row.regularHours), font: 'Courier', alignment: 'right' },
      { text: formatHours(row.overtimeHours), font: 'Courier', alignment: 'right' },
    ]),
    [
      { text: 'TOTAL', colSpan: 8, bold: true, font: 'Helvetica', alignment: 'right' },
      {}, {}, {}, {}, {}, {}, {},
      { text: formatHours(slip.regularHours), font: 'Courier', alignment: 'right', bold: true },
      { text: formatHours(slip.overtimeHours), font: 'Courier', alignment: 'right', bold: true },
    ],
  ]

  const punchesTableBody = [
    [
      { text: 'Day', style: 'tableHeader' },
      { text: 'Date', style: 'tableHeader' },
      { text: 'Punches', style: 'tableHeader' },
      { text: 'Reg Hrs', style: 'tableHeader' },
      { text: 'OT Hrs', style: 'tableHeader' },
    ],
    ...slip.dailyAttendance.map((row) => [
      { text: row.day, font: 'Helvetica' },
      { text: row.date, font: 'Helvetica' },
      punchesCell(row.punches),
      { text: formatHours(row.regularHours), font: 'Courier', alignment: 'right' },
      { text: formatHours(row.overtimeHours), font: 'Courier', alignment: 'right' },
    ]),
    [
      { text: 'TOTAL', colSpan: 3, bold: true, font: 'Helvetica', alignment: 'right' },
      {}, {},
      { text: formatHours(slip.regularHours), font: 'Courier', alignment: 'right', bold: true },
      { text: formatHours(slip.overtimeHours), font: 'Courier', alignment: 'right', bold: true },
    ],
  ]

  const earningsTableBody = [
    [
      { text: 'Description', style: 'tableHeader' },
      { text: 'Amount', style: 'tableHeader' },
    ],
    [
      {
        text: [
          `Regular Pay (${formatHours(slip.regularHours)} hrs x `,
          { text: `₹${formatHours(slip.hourlyRateUsed)}`, font: AMOUNT_FONT },
          ')',
        ],
        font: 'Helvetica',
      },
      { text: formatCurrencyPdf(slip.regularPay), font: AMOUNT_FONT, alignment: 'right' },
    ],
    [
      {
        text: [
          `OT Pay (${formatHours(slip.overtimeHours)} hrs x `,
          { text: `₹${formatHours(slip.hourlyRateUsed)}`, font: AMOUNT_FONT },
          ')',
        ],
        font: 'Helvetica',
      },
      { text: formatCurrencyPdf(slip.overtimePay), font: AMOUNT_FONT, alignment: 'right' },
    ],
    [
      { text: 'Gross Wage', font: 'Helvetica', bold: true },
      { text: formatCurrencyPdf(slip.grossPay), font: AMOUNT_FONT, alignment: 'right', bold: true },
    ],
    [
      { text: 'Additions', font: 'Helvetica' },
      { text: formatCurrencyPdf(slip.additions), font: AMOUNT_FONT, alignment: 'right' },
    ],
    [
      { text: 'Deductions', font: 'Helvetica' },
      { text: `(${formatCurrencyPdf(slip.deductions)})`, font: AMOUNT_FONT, alignment: 'right' },
    ],
    [
      { text: 'NET PAYABLE', font: 'Helvetica', bold: true, fontSize: 10 },
      { text: formatNetPayPdf(slip.netPayable), font: AMOUNT_FONT, alignment: 'right', bold: true, fontSize: 10 },
    ],
  ]

  const docDef: TDocumentDefinitions = {
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    styles: {
      title: { fontSize: 14, bold: true, alignment: 'center', font: 'Helvetica' },
      sectionHeader: { fontSize: 10, bold: true, font: 'Helvetica', marginTop: 10, marginBottom: 4 },
      label: { font: 'Helvetica', color: '#555555' },
      tableHeader: { bold: true, font: 'Helvetica', fillColor: '#dddddd' },
    },
    content: [
      { text: 'WEEKLY PAYROLL SLIP', style: 'title', marginBottom: 10 },
      {
        columns: [
          { width: '*', text: [{ text: 'Employee ID: ', style: 'label' }, { text: slip.employeeCode, font: 'Courier' }] },
          { width: '*', text: [{ text: 'Name: ', style: 'label' }, { text: slip.employeeName, font: 'Helvetica', bold: true }] },
        ],
        marginBottom: 4,
      },
      {
        columns: [
          { width: '*', text: [{ text: 'Designation: ', style: 'label' }, { text: slip.designation }] },
          { width: '*', text: [{ text: 'Site: ', style: 'label' }, { text: slip.site ?? '-' }] },
        ],
        marginBottom: 4,
      },
      {
        columns: [
          { width: '*', text: [{ text: 'GPay: ', style: 'label' }, { text: slip.gPay ?? '-', font: 'Courier' }] },
          { width: '*', text: [{ text: 'Bank Account: ', style: 'label' }, { text: slip.bankAccount ?? '-', font: 'Courier' }] },
        ],
        marginBottom: 4,
      },
      {
        text: [
          { text: 'Payroll Week: ', style: 'label' },
          { text: `${fmt(weekStartDate)} – ${fmt(weekEndDate)}`, font: 'Courier' },
        ],
        marginBottom: 10,
      },
      { text: 'ATTENDANCE', style: 'sectionHeader' },
      {
        table: usePunchesLayout
          ? {
              headerRows: 1,
              widths: ['auto', 'auto', '*', 'auto', 'auto'],
              body: punchesTableBody,
            }
          : {
              headerRows: 1,
              widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
              body: slotTableBody,
            },
        layout: 'lightHorizontalLines',
        marginBottom: 10,
      } as Content,
      { text: 'EARNINGS', style: 'sectionHeader' },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto'],
          body: earningsTableBody,
        },
        layout: 'lightHorizontalLines',
        marginBottom: 16,
      } as Content,
      {
        text: [
          { text: 'Generated: ', style: 'label' },
          { text: generatedAtDate.toLocaleString('en-IN'), font: 'Courier', fontSize: 8 },
        ],
        fontSize: 8,
        color: '#777777',
      },
    ],
  }

  return toPdfBuffer(docDef)
}

/**
 * Complete punch pairs from the live punches, keyed by `${employeeId}|${YYYY-MM-DD}` and
 * ordered by time. Deleted punches (no current time) and incomplete pairs are left out.
 */
async function loadPunchPairs(
  uploadId: string,
  employeeIds: string[],
): Promise<Map<string, Array<{ in: string; out: string }>>> {
  const rows = await prisma.attendancePunch.findMany({
    where: {
      attendanceUploadId: uploadId,
      correctionId: null,
      employeeId: { in: employeeIds },
      currentTime: { not: null },
    },
    select: {
      id: true,
      employeeId: true,
      punchDate: true,
      pairIndex: true,
      position: true,
      source: true,
      originalTime: true,
      currentTime: true,
      note: true,
    },
  })

  const byDay = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = `${row.employeeId}|${toISODate(row.punchDate)}`
    byDay.set(key, [...(byDay.get(key) ?? []), row])
  }

  const result = new Map<string, Array<{ in: string; out: string }>>()
  for (const [key, dayRows] of byDay) {
    const pairs = pairsFromStoredPunches(dayRows)
      .flatMap((pair) => (pair.in?.time && pair.out?.time ? [{ in: pair.in.time, out: pair.out.time }] : []))
      .sort((a, b) => (a.in < b.in ? -1 : a.in > b.in ? 1 : 0))
    if (pairs.length > 0) result.set(key, pairs)
  }
  return result
}

export async function generatePayrollSlipsZip(
  payrollRunId: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: {
      revisions: { where: { isCurrent: true }, take: 1 },
      runEmployees: {
        where: { payrollRevision: { isCurrent: true } },
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              employeeName: true,
              designation: true,
              site: true,
              gPay: true,
              bankAccount: true,
            },
          },
        },
        orderBy: { employee: { employeeId: 'asc' } },
      },
    },
  })

  if (!run) {
    throw new ReportServiceError('PAYROLL_RUN_NOT_FOUND', `Payroll run ${payrollRunId} not found`)
  }
  if (run.status !== 'APPROVED' && run.status !== 'REVISED') {
    throw new ReportServiceError('PAYROLL_NOT_APPROVED', `Payroll run ${payrollRunId} is not approved`)
  }
  if (run.runEmployees.length === 0) {
    throw new ReportServiceError('NO_EMPLOYEES', `Payroll run ${payrollRunId} has no employees`)
  }

  const currentRevision = run.revisions[0]
  const payrollRevisionId = currentRevision?.id ?? ''

  const employeeIds = run.runEmployees.map((e) => e.employee.id)
  const attendanceRecords = await prisma.attendanceRecord.findMany({
    where: {
      employeeId: { in: employeeIds },
      attendanceDate: { gte: run.payrollWeekStartDate, lte: run.payrollWeekEndDate },
      attendanceUpload: { isActiveForPayrollWeek: true },
    },
    orderBy: [{ employeeId: 'asc' }, { attendanceDate: 'asc' }],
  })

  const generatedAt = new Date()
  const weekStart = run.payrollWeekStartDate
  const weekEnd = run.payrollWeekEndDate

  // The week's source picks the slip layout. A week with no row keeps the six-column layout.
  const upload = await prisma.attendanceUpload.findFirst({
    where: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      isActiveForPayrollWeek: true,
    },
    select: { id: true, source: true },
  })
  const attendanceSource: SlipAttendanceSource = upload?.source === 'ETIMEOFFICE' ? 'ETIMEOFFICE' : 'EXCEL'
  const punchPairsByEmployeeDate =
    upload && attendanceSource === 'ETIMEOFFICE'
      ? await loadPunchPairs(upload.id, employeeIds)
      : undefined

  const slips: PayrollSlipData[] = run.runEmployees.map((runEmployee) =>
    buildSlipData({
      runEmployee: {
        id: runEmployee.id,
        payrollRunId: runEmployee.payrollRunId,
        payrollRevisionId: runEmployee.payrollRevisionId,
        employeeId: runEmployee.employeeId,
        hourlyRateUsed: Number(runEmployee.hourlyRateUsed),
        regularHours: Number(runEmployee.regularHours),
        overtimeHours: Number(runEmployee.overtimeHours),
        regularPay: Number(runEmployee.regularPay),
        overtimePay: Number(runEmployee.overtimePay),
        additions: Number(runEmployee.additions),
        deductions: Number(runEmployee.deductions),
        netPayable: Number(runEmployee.netPayable),
        employee: runEmployee.employee,
      },
      weekStart,
      weekEnd,
      payrollRunId,
      payrollRevisionId,
      attendanceRecords: attendanceRecords.map((r) => ({
        employeeId: r.employeeId,
        attendanceDate: r.attendanceDate,
        regularHours: Number(r.regularHours),
        overtimeHours: Number(r.overtimeHours),
        beforeNoonIn: r.beforeNoonIn,
        beforeNoonOut: r.beforeNoonOut,
        afternoonIn: r.afternoonIn,
        afternoonOut: r.afternoonOut,
        overtimeIn: r.overtimeIn,
        overtimeOut: r.overtimeOut,
      })),
      generatedAt,
      attendanceSource,
      punchPairsByEmployeeDate,
    }),
  )

  // Generate PDFs and build ZIP
  const zip = new JSZip()
  for (const slip of slips) {
    const pdfBuffer = await generatePayrollSlipPdf(slip)
    const fileName = formatSlipPdfName(slip.employeeCode, slip.employeeName)
    zip.file(fileName, pdfBuffer)
  }

  // Save snapshots to DB
  await saveInvoiceSnapshots(slips)

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' }) as Buffer
  const fileName = formatZipFileName(weekStart, weekEnd)

  return { buffer: zipBuffer, fileName }
}

// ── Database operations ──────────────────────────────────────────────────────

export async function saveInvoiceSnapshots(slips: PayrollSlipData[]): Promise<void> {
  if (slips.length === 0) return

  const payrollRunId = slips[0].payrollRunId
  const payrollRevisionId = slips[0].payrollRevisionId

  await prisma.$transaction([
    prisma.invoiceSnapshot.deleteMany({
      where: { payrollRunId, payrollRevisionId },
    }),
    prisma.invoiceSnapshot.createMany({
      data: slips.map((slip) => ({
        payrollRunId: slip.payrollRunId,
        payrollRevisionId: slip.payrollRevisionId,
        employeeId: slip.employeeDbId,
        invoiceFormat: 'PDF',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoiceSnapshotJson: slip as any,
        generatedAt: new Date(slip.generatedAt),
      })),
    }),
  ], { timeout: 30000 })
}

export async function markInvoiceSnapshotsCleaned(payrollRunId: string): Promise<void> {
  await prisma.invoiceSnapshot.updateMany({
    where: { payrollRunId },
    data: { temporaryFileDeletedAt: new Date() },
  })
}
