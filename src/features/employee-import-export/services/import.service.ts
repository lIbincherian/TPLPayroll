import * as XLSX from 'xlsx'
import prisma from '@/lib/prisma'
import { normalizeEmployeeId } from '../utils/normalize'
import { resolveInitialWageEffectiveFrom } from '@/features/employee-management/lib/wage-effective-from'
import {
  IMPORT_SHEET_NAME,
  IMPORT_COLUMNS,
  type ImportRowErrorCode,
  type ValidImportRow,
  type InvalidImportRow,
  type DuplicateImportRow,
  type ParseImportResult,
  type ExecuteImportResult,
  type ImportRowData,
} from '@/features/employee-import-export/types/import-export.types'

// ─── mapActiveValue ───────────────────────────────────────────────────────────

export function mapActiveValue(value: string): boolean | 'INVALID_ACTIVE_VALUE' {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'active') return true
  if (normalized === 'inactive') return false
  return 'INVALID_ACTIVE_VALUE'
}

// ─── validateImportFile ───────────────────────────────────────────────────────

export function validateImportFile(
  buffer: Buffer,
  fileName: string
): { ok: true } | { ok: false; error: 'UNSUPPORTED_FILE_TYPE' | 'SHEET_NOT_FOUND' } {
  if (!fileName.toLowerCase().endsWith('.xlsx')) {
    return { ok: false, error: 'UNSUPPORTED_FILE_TYPE' }
  }

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    return { ok: false, error: 'UNSUPPORTED_FILE_TYPE' }
  }

  if (!workbook.SheetNames.includes(IMPORT_SHEET_NAME)) {
    return { ok: false, error: 'SHEET_NOT_FOUND' }
  }

  return { ok: true }
}

// ─── parseRow ─────────────────────────────────────────────────────────────────

function parseExcelDate(value: unknown): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return value
  if (typeof value === 'number') {
    return XLSX.SSF.parse_date_code(value)
      ? new Date(Date.UTC(1900, 0, value - (value >= 60 ? 2 : 1)))
      : null
  }
  const d = new Date(String(value))
  return isNaN(d.getTime()) ? null : d
}

function parseNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return isNaN(n) ? null : n
}

function str(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value).trim()
}

interface RawRow {
  rowNumber: number
  data: Record<string, unknown>
}

function validateAndParseRow(raw: RawRow):
  | { valid: ImportRowData }
  | { invalid: { errors: ImportRowErrorCode[]; partialData: Partial<ImportRowData> } } {
  const errors: ImportRowErrorCode[] = []
  const d = raw.data

  const rawEmployeeId = str(d[IMPORT_COLUMNS.employeeId])
  const employeeId = rawEmployeeId ? normalizeEmployeeId(rawEmployeeId) : null
  const employeeName = str(d[IMPORT_COLUMNS.employeeName])
  const designation = str(d[IMPORT_COLUMNS.designation])
  const salaryRaw = d[IMPORT_COLUMNS.salary]
  const hourlyRateRaw = d[IMPORT_COLUMNS.hourlyRate]
  const activeRaw = str(d[IMPORT_COLUMNS.active])

  if (!employeeId) errors.push('MISSING_EMPLOYEE_ID')
  if (!employeeName) errors.push('MISSING_EMPLOYEE_NAME')
  if (!designation) errors.push('MISSING_DESIGNATION')

  let salary: number | null = null
  if (salaryRaw == null || salaryRaw === '') {
    errors.push('MISSING_SALARY')
  } else {
    salary = parseNumber(salaryRaw)
    if (salary === null) errors.push('INVALID_SALARY')
  }

  let hourlyRate: number | null = null
  if (hourlyRateRaw == null || hourlyRateRaw === '') {
    errors.push('MISSING_HOURLY_RATE')
  } else {
    hourlyRate = parseNumber(hourlyRateRaw)
    if (hourlyRate === null) errors.push('INVALID_HOURLY_RATE')
  }

  let isActive: boolean | null = null
  if (!activeRaw) {
    errors.push('MISSING_ACTIVE')
  } else {
    const mapped = mapActiveValue(activeRaw)
    if (mapped === 'INVALID_ACTIVE_VALUE') {
      errors.push('INVALID_ACTIVE_VALUE')
    } else {
      isActive = mapped
    }
  }

  if (errors.length > 0) {
    const partialData: Partial<ImportRowData> = {
      serialNumber: str(d[IMPORT_COLUMNS.serialNumber]),
      ...(employeeId ? { employeeId } : {}),
      ...(employeeName ? { employeeName } : {}),
      nationalId: str(d[IMPORT_COLUMNS.nationalId]),
      ...(designation ? { designation } : {}),
      dateOfJoining: parseExcelDate(d[IMPORT_COLUMNS.dateOfJoining]),
      aadhaarId: str(d[IMPORT_COLUMNS.aadhaarId]),
      policeVerificationId: str(d[IMPORT_COLUMNS.policeVerificationId]),
      ...(salary !== null ? { salary } : {}),
      ...(hourlyRate !== null ? { hourlyRate } : {}),
      phone: str(d[IMPORT_COLUMNS.phone]),
      dateOfBirth: parseExcelDate(d[IMPORT_COLUMNS.dateOfBirth]),
      healthCardId: str(d[IMPORT_COLUMNS.healthCardId]),
      gPay: str(d[IMPORT_COLUMNS.gPay]),
      bankAccount: str(d[IMPORT_COLUMNS.bankAccount]),
      dateOfResignation: parseExcelDate(d[IMPORT_COLUMNS.dateOfResignation]),
      site: str(d[IMPORT_COLUMNS.site]),
      ...(isActive !== null ? { isActive } : {}),
      designationShort: str(d[IMPORT_COLUMNS.designationShort]),
    }
    return { invalid: { errors, partialData } }
  }

  return {
    valid: {
      serialNumber: str(d[IMPORT_COLUMNS.serialNumber]),
      employeeId: employeeId!,
      employeeName: employeeName!,
      nationalId: str(d[IMPORT_COLUMNS.nationalId]),
      designation: designation!,
      dateOfJoining: parseExcelDate(d[IMPORT_COLUMNS.dateOfJoining]),
      aadhaarId: str(d[IMPORT_COLUMNS.aadhaarId]),
      policeVerificationId: str(d[IMPORT_COLUMNS.policeVerificationId]),
      salary: salary!,
      hourlyRate: hourlyRate!,
      phone: str(d[IMPORT_COLUMNS.phone]),
      dateOfBirth: parseExcelDate(d[IMPORT_COLUMNS.dateOfBirth]),
      healthCardId: str(d[IMPORT_COLUMNS.healthCardId]),
      gPay: str(d[IMPORT_COLUMNS.gPay]),
      bankAccount: str(d[IMPORT_COLUMNS.bankAccount]),
      dateOfResignation: parseExcelDate(d[IMPORT_COLUMNS.dateOfResignation]),
      site: str(d[IMPORT_COLUMNS.site]),
      isActive: isActive!,
      designationShort: str(d[IMPORT_COLUMNS.designationShort]),
    },
  }
}

// ─── parseImportFile ──────────────────────────────────────────────────────────

export async function parseImportFile(buffer: Buffer): Promise<ParseImportResult> {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = workbook.Sheets[IMPORT_SHEET_NAME]
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

  const totalRows = rawRows.length
  const validRows: ValidImportRow[] = []
  const invalidRows: InvalidImportRow[] = []
  const seenIds = new Map<string, number>() // employeeId -> first rowNumber
  const duplicateIdRows: DuplicateImportRow[] = []

  // Fetch existing employee IDs to determine CREATE vs UPDATE
  const existingEmployees = await prisma.employee.findMany({
    select: { employeeId: true },
  })
  const existingIdSet = new Set(existingEmployees.map((e) => e.employeeId))

  rawRows.forEach((row, index) => {
    const rowNumber = index + 2 // row 1 is header
    const result = validateAndParseRow({ rowNumber, data: row })

    if ('invalid' in result) {
      invalidRows.push({
        rowNumber,
        employeeId: str(row[IMPORT_COLUMNS.employeeId]),
        employeeName: str(row[IMPORT_COLUMNS.employeeName]),
        errors: result.invalid.errors,
        partialData: result.invalid.partialData,
      })
      return
    }

    const { employeeId } = result.valid

    const action = existingIdSet.has(employeeId) ? 'UPDATE' : 'CREATE'

    if (seenIds.has(employeeId)) {
      // Subsequent occurrence — flagged as duplicate but still carries data for processing
      duplicateIdRows.push({ rowNumber, employeeId, action, data: result.valid })
    } else {
      seenIds.set(employeeId, rowNumber)
      validRows.push({ rowNumber, action, data: result.valid })
    }
  })

  return { totalRows, validRows, invalidRows, duplicateIdRows }
}

// ─── executeImport ────────────────────────────────────────────────────────────

export async function executeImport(
  buffer: Buffer,
  fileName: string,
  _filePath: string,
  fixedRows: ValidImportRow[] = []
): Promise<ExecuteImportResult> {
  const { validRows: parsedValidRows, invalidRows, duplicateIdRows } = await parseImportFile(buffer)

  const rejectedRowCount = Math.max(0, invalidRows.length - fixedRows.length)

  // ── Deduplicate rows in memory (last-write-wins for duplicates) ───────────────
  // This collapses all per-row decisions BEFORE touching the DB so we can use bulk writes.
  const rowMap = new Map<string, { data: ImportRowData; action: 'CREATE' | 'UPDATE' }>()
  for (const row of [...parsedValidRows, ...fixedRows]) {
    rowMap.set(row.data.employeeId, { data: row.data, action: row.action })
  }
  for (const dup of duplicateIdRows) {
    // Duplicates override first occurrences (last write wins)
    rowMap.set(dup.data.employeeId, { data: dup.data, action: dup.action })
  }

  const toCreate = Array.from(rowMap.values()).filter((r) => r.action === 'CREATE')
  const toUpdate = Array.from(rowMap.values()).filter((r) => r.action === 'UPDATE')

  // ── 1. Create the batch record ────────────────────────────────────────────────
  const batch = await prisma.employeeImportBatch.create({
    data: {
      fileName,
      fileType: 'xlsx',
      status: 'PROCESSING',
      importedRowCount: 0,
      createdEmployeeCount: 0,
      updatedEmployeeCount: 0,
      rejectedRowCount,
      duplicateEmployeeIdRowCount: duplicateIdRows.length,
    },
  })

  const today = new Date()

  try {
    // ── 2. Bulk-create new employees ─────────────────────────────────────────────
    // Use the array form of $transaction (no callback) — all pure inserts, no reads
    // mid-flight, so it resolves in milliseconds even for large files.
    let createdCount = 0
    const createdEmployees: { id: string; employeeId: string; salary: number; hourlyRate: number; effectiveFrom: Date }[] = []

    if (toCreate.length > 0) {
      const results = await prisma.$transaction(
        toCreate.map((r) =>
          prisma.employee.create({
            data: {
              employeeImportBatchId: batch.id,
              employeeId: r.data.employeeId,
              serialNumber: r.data.serialNumber,
              employeeName: r.data.employeeName,
              nationalId: r.data.nationalId,
              designation: r.data.designation,
              designationShort: r.data.designationShort,
              dateOfJoining: r.data.dateOfJoining,
              aadhaarId: r.data.aadhaarId,
              policeVerificationId: r.data.policeVerificationId,
              phone: r.data.phone,
              dateOfBirth: r.data.dateOfBirth,
              healthCardId: r.data.healthCardId,
              gPay: r.data.gPay,
              bankAccount: r.data.bankAccount,
              dateOfResignation: r.data.dateOfResignation,
              site: r.data.site,
              isActive: r.data.isActive,
            },
            select: { id: true, employeeId: true },
          })
        ),
        { timeout: 30000 } // 30 seconds to handle large bulk imports
      )

      results.forEach((created, i) => {
        createdEmployees.push({
          id: created.id,
          employeeId: created.employeeId,
          salary: toCreate[i].data.salary,
          hourlyRate: toCreate[i].data.hourlyRate,
          effectiveFrom: resolveInitialWageEffectiveFrom(null, toCreate[i].data.dateOfJoining, today),
        })
      })
      createdCount = results.length
    }

    // ── 3. Bulk-create wage history + audit logs for new employees ─────────────
    if (createdEmployees.length > 0) {
      await prisma.employeeWageHistory.createMany({
        data: createdEmployees.map((e) => ({
          employeeId: e.id,
          weeklySalary: e.salary,
          hourlyRate: e.hourlyRate,
          effectiveFrom: e.effectiveFrom,
          effectiveTo: null,
          changeSource: 'IMPORT',
          employeeImportBatchId: batch.id,
        })),
      })

      await prisma.auditLog.createMany({
        data: createdEmployees.map((e) => ({
          actionType: 'CREATE' as const,
          entityType: 'EMPLOYEE',
          entityId: e.id,
          detailsJson: { employeeId: e.employeeId, source: 'IMPORT', batchId: batch.id },
        })),
      })
    }

    // ── 4. Process updates ────────────────────────────────────────────────────────
    let updatedCount = 0

    if (toUpdate.length > 0) {
      // One query to fetch all DB ids for employees being updated
      const existingEmployees = await prisma.employee.findMany({
        where: { employeeId: { in: toUpdate.map((r) => r.data.employeeId) } },
        select: { id: true, employeeId: true },
      })
      const existingIdMap = new Map(existingEmployees.map((e) => [e.employeeId, e.id]))

      // Bulk-update employee fields — array form of $transaction, all indexed PK writes
      await prisma.$transaction(
        toUpdate
          .filter((r) => existingIdMap.has(r.data.employeeId))
          .map((r) => {
            const dbId = existingIdMap.get(r.data.employeeId)!
            return prisma.employee.update({
              where: { id: dbId },
              data: {
                serialNumber: r.data.serialNumber,
                employeeName: r.data.employeeName,
                nationalId: r.data.nationalId,
                designation: r.data.designation,
                designationShort: r.data.designationShort,
                dateOfJoining: r.data.dateOfJoining,
                aadhaarId: r.data.aadhaarId,
                policeVerificationId: r.data.policeVerificationId,
                phone: r.data.phone,
                dateOfBirth: r.data.dateOfBirth,
                healthCardId: r.data.healthCardId,
                gPay: r.data.gPay,
                bankAccount: r.data.bankAccount,
                dateOfResignation: r.data.dateOfResignation,
                site: r.data.site,
                isActive: r.data.isActive,
                employeeImportBatchId: batch.id,
              },
            })
          }),
        { timeout: 30000 } // 30 seconds to handle large bulk imports
      )
      updatedCount = existingEmployees.length

      // One query to fetch all current open wage records
      const currentWages = await prisma.employeeWageHistory.findMany({
        where: { employeeId: { in: existingEmployees.map((e) => e.id) }, effectiveTo: null },
      })
      const currentWageMap = new Map(currentWages.map((w) => [w.employeeId, w]))

      const wageChangedIds: string[] = []
      const newWageRows: { employeeId: string; weeklySalary: number; hourlyRate: number }[] = []

      for (const r of toUpdate) {
        const dbId = existingIdMap.get(r.data.employeeId)
        if (!dbId) continue
        const cw = currentWageMap.get(dbId)
        const wageChanged = cw
          ? Number(cw.weeklySalary) !== r.data.salary || Number(cw.hourlyRate) !== r.data.hourlyRate
          : true
        if (wageChanged) {
          wageChangedIds.push(dbId)
          newWageRows.push({ employeeId: dbId, weeklySalary: r.data.salary, hourlyRate: r.data.hourlyRate })
        }
      }

      if (wageChangedIds.length > 0) {
        // Close all open wage records for changed employees in one updateMany
        await prisma.employeeWageHistory.updateMany({
          where: { employeeId: { in: wageChangedIds }, effectiveTo: null },
          data: { effectiveTo: today },
        })
        // Bulk-insert new wage history rows
        await prisma.employeeWageHistory.createMany({
          data: newWageRows.map((w) => ({
            employeeId: w.employeeId,
            weeklySalary: w.weeklySalary,
            hourlyRate: w.hourlyRate,
            effectiveFrom: today,
            effectiveTo: null,
            changeSource: 'IMPORT',
            employeeImportBatchId: batch.id,
          })),
        })
      }

      // Bulk audit logs for updates
      await prisma.auditLog.createMany({
        data: existingEmployees.map((e) => ({
          actionType: 'UPDATE' as const,
          entityType: 'EMPLOYEE',
          entityId: e.id,
          detailsJson: { source: 'IMPORT', batchId: batch.id },
        })),
      })
    }

    // ── 5. Mark batch COMPLETED ───────────────────────────────────────────────────
    await prisma.employeeImportBatch.update({
      where: { id: batch.id },
      data: {
        status: 'COMPLETED',
        importedRowCount: createdCount + updatedCount,
        createdEmployeeCount: createdCount,
        updatedEmployeeCount: updatedCount,
        sourceFileDeletedAt: today,
      },
    })
    return {
      batchId: batch.id,
      importedRowCount: createdCount + updatedCount,
      createdEmployeeCount: createdCount,
      updatedEmployeeCount: updatedCount,
      rejectedRowCount,
      duplicateEmployeeIdRowCount: duplicateIdRows.length,
    }
  } catch (err) {
    // Best-effort: mark batch as FAILED so the UI can surface it
    try {
      await prisma.employeeImportBatch.update({ where: { id: batch.id }, data: { status: 'FAILED' } })
    } catch {
      // Ignore
    }
    throw err
  }
}
