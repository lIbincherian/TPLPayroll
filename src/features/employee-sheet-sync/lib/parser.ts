import {
  COLUMN_BY_HEADER,
  REQUIRED_HEADERS,
  normalizeHeader,
  type ColumnDef,
} from './columns'
import {
  cleanIdField,
  cleanIdText,
  cleanText,
  isBlankMarker,
  parseActive,
  parseDayFirstDate,
  parseSalary,
  parseWhatsapp,
} from './values'
import {
  SheetSyncError,
  type FieldValue,
  type FieldWarning,
  type ParsedRow,
  type ParseResult,
  type RequiredField,
  type SheetOwnedField,
  type SheetValues,
} from '../types/employee-sheet-sync.types'

type TargetColumn = { def: ColumnDef; index: number }

/** Maps each known header to its first column. A duplicate header is ignored: the first one wins. */
function mapHeaders(header: string[]): Map<string, TargetColumn> {
  const found = new Map<string, TargetColumn>()
  header.forEach((cell, index) => {
    const def = COLUMN_BY_HEADER.get(normalizeHeader(cell))
    if (!def || found.has(def.header)) return
    found.set(def.header, { def, index })
  })
  return found
}

function cell(row: string[], column: TargetColumn | undefined): string {
  if (!column) return ''
  return row[column.index] ?? ''
}

function isAllBlank(row: string[]): boolean {
  return row.every((value) => (value ?? '').trim() === '')
}

/**
 * Parses the header row and the value rows. Throws SheetSyncError for an empty sheet or a missing required
 * header. Every other problem is reported per row, so one bad cell never stops the run.
 */
export function parseSheet(values: SheetValues): ParseResult {
  if (values.header.every((h) => (h ?? '').trim() === '') && values.rows.every(isAllBlank)) {
    throw new SheetSyncError('EMPTY_SHEET', 'The Employee Master sheet is empty.')
  }

  const columns = mapHeaders(values.header)
  const missing = REQUIRED_HEADERS.filter((h) => !columns.has(h))
  if (missing.length > 0) {
    throw new SheetSyncError(
      'MISSING_REQUIRED_HEADERS',
      `The sheet is missing required column headers: ${missing.join(', ')}.`,
      { missing },
    )
  }

  const presentFields: SheetOwnedField[] = []
  for (const { def } of columns.values()) {
    if ('field' in def.target) presentFields.push(def.target.field)
  }

  const rows: ParsedRow[] = []
  values.rows.forEach((raw, i) => {
    if (isAllBlank(raw)) return
    rows.push(parseRow(raw, i + 2, columns))
  })

  return { rows, presentFields }
}

function parseRow(raw: string[], rowNumber: number, columns: Map<string, TargetColumn>): ParsedRow {
  const srRaw = cleanIdText(cell(raw, columns.get('Sr.')))
  const sr = /^\d+$/.test(srRaw) ? parseInt(srRaw, 10) : null

  const idCell = cell(raw, columns.get('Employee ID'))
  const employeeIdRaw = isBlankMarker(idCell) ? null : cleanIdText(idCell)

  const salaryRaw = cell(raw, columns.get('Salary')).trim()
  const salaryValue = isBlankMarker(salaryRaw) ? null : parseSalary(salaryRaw)

  const activeRaw = cell(raw, columns.get('Active')).trim()
  const activeParse = parseActive(activeRaw)

  const fields: Partial<Record<SheetOwnedField, FieldValue>> = {}
  const warnings: FieldWarning[] = []
  const requiredErrors: ParsedRow['requiredErrors'] = []

  for (const column of columns.values()) {
    const { def } = column
    if (!('field' in def.target)) continue
    const field = def.target.field
    const text = cell(raw, column)

    switch (def.target.kind) {
      case 'text':
        fields[field] = cleanText(text)
        break
      case 'idText':
        fields[field] = cleanIdField(text)
        break
      case 'whatsapp':
        fields[field] = parseWhatsapp(text)
        break
      case 'date': {
        if (isBlankMarker(text)) {
          fields[field] = null
          break
        }
        const parsed = parseDayFirstDate(text)
        if (parsed.ok) fields[field] = parsed.value
        else warnings.push({ field, header: def.header, raw: text.trim(), reason: 'INVALID_DATE' })
        break
      }
    }
  }

  const required = (field: RequiredField, rawValue: string) => requiredErrors.push({ field, raw: rawValue })
  if (fields.employeeName == null) required('employeeName', cell(raw, columns.get('Employee Name')).trim())
  if (fields.designation == null) required('designation', cell(raw, columns.get('Designation')).trim())
  if (salaryValue === null) required('salary', salaryRaw)
  if (fields.dateOfJoining == null) required('dateOfJoining', cell(raw, columns.get('Date of Joining')).trim())

  if (!activeParse.ok) {
    warnings.push({ field: 'isActive', header: 'Active', raw: activeRaw, reason: 'INVALID_ACTIVE' })
  }

  return {
    rowNumber,
    sr,
    srRaw,
    employeeIdRaw,
    fields,
    salary: { value: salaryValue, raw: salaryRaw },
    active: { value: activeParse.ok ? activeParse.value : null, raw: activeRaw },
    activeInvalid: !activeParse.ok,
    requiredErrors,
    warnings,
  }
}
