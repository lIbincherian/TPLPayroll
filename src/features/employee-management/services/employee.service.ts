import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import {
  CreateEmployeeSchema,
  UpdateEmployeeSchema,
  BulkStatusUpdateSchema,
  BulkHourlyRateUpdateSchema,
  EmployeeServiceError,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
  type BulkStatusUpdateInput,
  type BulkHourlyRateUpdateInput,
  type BulkOperationResult,
  type EmployeeListOptions,
  type PaginatedEmployeeList,
  type EmployeeListItem,
  type EmployeeRecord,
  type WageHistoryEntry,
  type EmployeeStatus,
} from '@/features/employee-management/types/employee.types'
import { computeHourlyRate } from '@/features/employee-management/utils/wage'

// ─── Helper: compute status ───────────────────────────────────────────────────

function computeStatus(employee: {
  isActive: boolean
  dateOfResignation: Date | null
}): EmployeeStatus {
  if (employee.dateOfResignation != null) return 'RESIGNED'
  if (!employee.isActive) return 'INACTIVE'
  return 'ACTIVE'
}

// ─── Helper: build Prisma where clause from list options ──────────────────────

function buildWhereClause(options: EmployeeListOptions) {
  const where: Record<string, unknown> = {}

  // Status filter
  if (options.status && options.status !== 'ALL') {
    if (options.status === 'ACTIVE') {
      where.isActive = true
      where.dateOfResignation = null
    } else if (options.status === 'INACTIVE') {
      where.isActive = false
      where.dateOfResignation = null
    } else if (options.status === 'RESIGNED') {
      where.dateOfResignation = { not: null }
    }
  }

  // Search filter (name OR employeeId, case-insensitive partial match)
  if (options.search && options.search.trim() !== '') {
    where.OR = [
      { employeeName: { contains: options.search, mode: 'insensitive' } },
      { employeeId: { contains: options.search, mode: 'insensitive' } },
    ]
  }

  if (options.designation && options.designation !== 'ALL') {
    where.designation = options.designation
  }

  if (options.site && options.site !== 'ALL') {
    where.site = options.site
  }

  return where
}

// ─── createEmployee ───────────────────────────────────────────────────────────

export async function createEmployee(input: CreateEmployeeInput): Promise<EmployeeRecord> {
  // Validate input
  const parsed = CreateEmployeeSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues?.[0]
    throw new EmployeeServiceError(
      'VALIDATION_ERROR',
      firstIssue?.message ?? 'Invalid employee data'
    )
  }

  // Check for duplicate employeeId
  const existing = await prisma.employee.findUnique({
    where: { employeeId: parsed.data.employeeId },
  })
  if (existing) {
    throw new EmployeeServiceError(
      'DUPLICATE_EMPLOYEE_ID',
      `Employee ID "${parsed.data.employeeId}" already exists`
    )
  }

  const today = new Date()
  const employeeDbId = randomUUID()
  const hourlyRate = computeHourlyRate(parsed.data.salary)

  await prisma.$transaction([
    // 1. Create the employee record
    prisma.employee.create({
      data: {
        id: employeeDbId,
        employeeId: parsed.data.employeeId,
        employeeName: parsed.data.employeeName,
        designation: parsed.data.designation,
        designationShort: parsed.data.designationShort ?? null,
        nationalId: parsed.data.nationalId ?? null,
        aadhaarId: parsed.data.aadhaarId ?? null,
        policeVerificationId: parsed.data.policeVerificationId ?? null,
        phone: parsed.data.phone ?? null,
        dateOfBirth: parsed.data.dateOfBirth ?? null,
        dateOfJoining: parsed.data.dateOfJoining ?? null,
        site: parsed.data.site ?? null,
        healthCardId: parsed.data.healthCardId ?? null,
        gPay: parsed.data.gPay ?? null,
        bankAccount: parsed.data.bankAccount ?? null,
        dateOfResignation: parsed.data.dateOfResignation ?? null,
        isActive: parsed.data.isActive,
      },
    }),

    // 2. Create initial wage history
    prisma.employeeWageHistory.create({
      data: {
        employeeId: employeeDbId,
        weeklySalary: parsed.data.salary,
        hourlyRate,
        effectiveFrom: today,
        effectiveTo: null,
        changeSource: 'MANUAL',
      },
    }),

    // 3. Create audit log
    prisma.auditLog.create({
      data: {
        actionType: 'CREATE',
        entityType: 'EMPLOYEE',
        entityId: employeeDbId,
        detailsJson: {
          employeeId: parsed.data.employeeId,
          employeeName: parsed.data.employeeName,
          designation: parsed.data.designation,
          designationShort: parsed.data.designationShort ?? null,
          nationalId: parsed.data.nationalId ?? null,
          aadhaarId: parsed.data.aadhaarId ?? null,
          policeVerificationId: parsed.data.policeVerificationId ?? null,
          phone: parsed.data.phone ?? null,
          dateOfBirth: parsed.data.dateOfBirth ?? null,
          dateOfJoining: parsed.data.dateOfJoining ?? null,
          site: parsed.data.site ?? null,
          healthCardId: parsed.data.healthCardId ?? null,
          gPay: parsed.data.gPay ?? null,
          bankAccount: parsed.data.bankAccount ?? null,
          dateOfResignation: parsed.data.dateOfResignation ?? null,
          isActive: parsed.data.isActive,
          salary: parsed.data.salary,
          hourlyRate,
          changeSource: 'MANUAL',
        },
      },
    }),
  ], { timeout: 30000 })

  return {
    id: employeeDbId,
    employeeImportBatchId: null,
    employeeId: parsed.data.employeeId,
    serialNumber: null,
    employeeName: parsed.data.employeeName,
    designation: parsed.data.designation,
    designationShort: parsed.data.designationShort ?? null,
    nationalId: parsed.data.nationalId ?? null,
    aadhaarId: parsed.data.aadhaarId ?? null,
    policeVerificationId: parsed.data.policeVerificationId ?? null,
    phone: parsed.data.phone ?? null,
    dateOfBirth: parsed.data.dateOfBirth ?? null,
    dateOfJoining: parsed.data.dateOfJoining ?? null,
    site: parsed.data.site ?? null,
    healthCardId: parsed.data.healthCardId ?? null,
    gPay: parsed.data.gPay ?? null,
    bankAccount: parsed.data.bankAccount ?? null,
    dateOfResignation: parsed.data.dateOfResignation ?? null,
    isActive: parsed.data.isActive,
    createdAt: today,
    updatedAt: today,
  } as EmployeeRecord
}

// ─── getEmployeeList ──────────────────────────────────────────────────────────

export async function getEmployeeList(options: EmployeeListOptions): Promise<PaginatedEmployeeList> {
  const page = options.page ?? 1
  const limit = options.limit ?? 10
  const skip = (page - 1) * limit

  const where = buildWhereClause(options)

  const orderDirection = options.sortOrder === 'desc' ? 'desc' : 'asc'
  let orderBy: Prisma.EmployeeOrderByWithRelationInput | Prisma.EmployeeOrderByWithRelationInput[] = { employeeName: 'asc' }

  if (options.sortBy) {
    if (options.sortBy === 'status') {
      orderBy = orderDirection === 'asc' 
        ? [{ dateOfResignation: 'asc' }, { isActive: 'desc' }]
        : [{ dateOfResignation: 'desc' }, { isActive: 'asc' }]
    } else {
      orderBy = { [options.sortBy]: orderDirection }
    }
  }

  const [totalCount, rows] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: {
        id: true,
        employeeId: true,
        employeeName: true,
        designation: true,
        designationShort: true,
        site: true,
        isActive: true,
        dateOfResignation: true,
      },
    }),
  ])

  const employees: EmployeeListItem[] = rows.map((row) => ({
    ...row,
    status: computeStatus(row),
  }))

  return { employees, totalCount, page, limit }
}

// ─── getEmployeeById ──────────────────────────────────────────────────────────

export async function getEmployeeById(id: string): Promise<EmployeeRecord> {
  const employee = await prisma.employee.findUnique({ where: { id } })
  if (!employee) {
    throw new EmployeeServiceError('EMPLOYEE_NOT_FOUND', `Employee with id "${id}" not found`)
  }
  return employee as EmployeeRecord
}

// ─── getEmployeeWageHistory ───────────────────────────────────────────────────

export async function getEmployeeWageHistory(employeeId: string): Promise<WageHistoryEntry[]> {
  const entries = await prisma.employeeWageHistory.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: 'desc' },
  })

  return entries.map((e) => ({
    id: e.id,
    employeeId: e.employeeId,
    weeklySalary: Number(e.weeklySalary),
    hourlyRate: Number(e.hourlyRate),
    effectiveFrom: e.effectiveFrom,
    effectiveTo: e.effectiveTo,
    changeSource: e.changeSource,
  }))
}

// ─── updateEmployee ───────────────────────────────────────────────────────────

export async function updateEmployee(
  id: string,
  input: UpdateEmployeeInput
): Promise<EmployeeRecord> {
  // Validate input
  const parsed = UpdateEmployeeSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues?.[0]
    throw new EmployeeServiceError(
      'VALIDATION_ERROR',
      firstIssue?.message ?? 'Invalid employee data'
    )
  }

  // Ensure employee exists
  const existing = await prisma.employee.findUnique({ where: { id } })
  if (!existing) {
    throw new EmployeeServiceError('EMPLOYEE_NOT_FOUND', `Employee with id "${id}" not found`)
  }

  // Fetch current wage history to detect wage changes
  const currentWageHistory = await prisma.employeeWageHistory.findMany({
    where: { employeeId: id },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
  })
  const currentWage = currentWageHistory[0]

  // A wage change is keyed only on the daily wage; the hourly rate is derived from it.
  const newSalary = parsed.data.salary
  const wageChanged =
    newSalary !== undefined && currentWage !== undefined && Number(currentWage.weeklySalary) !== newSalary

  const today = new Date()

  const nonWageFields = [
    'employeeName', 'designation', 'designationShort', 'nationalId', 'aadhaarId',
    'policeVerificationId', 'phone', 'dateOfBirth', 'dateOfJoining', 'site',
    'healthCardId', 'gPay', 'bankAccount', 'dateOfResignation', 'isActive',
  ] as const

  const changedFields: Record<string, { old: unknown; new: unknown }> = {}

  for (const field of nonWageFields) {
    const newValue = parsed.data[field]
    if (newValue === undefined) continue
    const oldVal = existing[field]
    // A blank stored value cleared to null is not a change
    if (newValue === null && (oldVal === null || oldVal === '')) continue
    if (String(oldVal) !== String(newValue)) {
      changedFields[field] = { old: oldVal, new: newValue }
    }
  }

  if (wageChanged) {
    changedFields.salary = { old: Number(currentWage.weeklySalary), new: newSalary }
    changedFields.hourlyRate = { old: Number(currentWage.hourlyRate), new: computeHourlyRate(newSalary) }
  }

  // Pre-generate a UUID for the new wage history entry (used only if wageChanged)
  const newWageHistoryId = randomUUID()

  const updateData = {
    ...(parsed.data.employeeName !== undefined && { employeeName: parsed.data.employeeName }),
    ...(parsed.data.designation !== undefined && { designation: parsed.data.designation }),
    ...(parsed.data.designationShort !== undefined && { designationShort: parsed.data.designationShort }),
    ...(parsed.data.nationalId !== undefined && { nationalId: parsed.data.nationalId }),
    ...(parsed.data.aadhaarId !== undefined && { aadhaarId: parsed.data.aadhaarId }),
    ...(parsed.data.policeVerificationId !== undefined && { policeVerificationId: parsed.data.policeVerificationId }),
    ...(parsed.data.phone !== undefined && { phone: parsed.data.phone }),
    ...(parsed.data.dateOfBirth !== undefined && { dateOfBirth: parsed.data.dateOfBirth }),
    ...(parsed.data.dateOfJoining !== undefined && { dateOfJoining: parsed.data.dateOfJoining }),
    ...(parsed.data.site !== undefined && { site: parsed.data.site }),
    ...(parsed.data.healthCardId !== undefined && { healthCardId: parsed.data.healthCardId }),
    ...(parsed.data.gPay !== undefined && { gPay: parsed.data.gPay }),
    ...(parsed.data.bankAccount !== undefined && { bankAccount: parsed.data.bankAccount }),
    ...(parsed.data.dateOfResignation !== undefined && { dateOfResignation: parsed.data.dateOfResignation }),
    ...(parsed.data.isActive !== undefined && { isActive: parsed.data.isActive }),
  }

  const promises: ReturnType<typeof prisma.employee.update | typeof prisma.auditLog.create | typeof prisma.employeeWageHistory.updateMany | typeof prisma.employeeWageHistory.create>[] = [
    // 1. Update the employee record
    prisma.employee.update({
      where: { id },
      data: updateData,
    }),
  ]

  if (wageChanged) {
    const newHourlyRate = computeHourlyRate(newSalary)

    // 2a. Close previous open wage history entry
    promises.push(
      prisma.employeeWageHistory.updateMany({
        where: { employeeId: id, effectiveTo: null },
        data: { effectiveTo: today },
      })
    )

    // 2b. Create new wage history entry
    promises.push(
      prisma.employeeWageHistory.create({
        data: {
          id: newWageHistoryId,
          employeeId: id,
          weeklySalary: newSalary,
          hourlyRate: newHourlyRate,
          effectiveFrom: today,
          effectiveTo: null,
          changeSource: 'MANUAL',
        },
      })
    )

    // 2c. Audit log for wage change
    promises.push(
      prisma.auditLog.create({
        data: {
          actionType: 'UPDATE',
          entityType: 'WAGE_HISTORY',
          entityId: newWageHistoryId,
          detailsJson: {
            employeeId: id,
            oldSalary: Number(currentWage.weeklySalary),
            newSalary,
            oldHourlyRate: Number(currentWage.hourlyRate),
            newHourlyRate,
            effectiveFrom: today,
            changeSource: 'MANUAL',
          },
        },
      })
    )
  }

  // 3. Audit log for employee update
  promises.push(
    prisma.auditLog.create({
      data: {
        actionType: 'UPDATE',
        entityType: 'EMPLOYEE',
        entityId: id,
        detailsJson: {
          changedFields,
          changeSource: 'MANUAL',
        } as Prisma.InputJsonValue,
      },
    })
  )

  await prisma.$transaction(promises, { timeout: 30000 })

  // Return the merged employee state
  return {
    ...existing,
    ...updateData,
    updatedAt: today,
  } as EmployeeRecord
}

// ─── bulkUpdateStatus ─────────────────────────────────────────────────────────

export async function bulkUpdateStatus(input: BulkStatusUpdateInput): Promise<BulkOperationResult> {
  const parsed = BulkStatusUpdateSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues?.[0]
    throw new EmployeeServiceError(
      'VALIDATION_ERROR',
      firstIssue?.message ?? 'Invalid bulk status update data'
    )
  }

  const result: BulkOperationResult = { succeeded: 0, skipped: 0, failed: 0, errors: [] }

  for (const id of parsed.data.ids) {
    try {
      // Fetch employee
      const employee = await prisma.employee.findUnique({ where: { id } })
      if (!employee) {
        result.failed++
        result.errors.push({ employeeId: id, error: `Employee with id "${id}" not found` })
        continue
      }

      if (parsed.data.status === 'INACTIVE') {
        // Skip already-inactive employees
        if (!employee.isActive) {
          result.skipped++
          continue
        }

        await prisma.$transaction([
          prisma.employee.update({
            where: { id },
            data: { isActive: false },
          }),
          prisma.auditLog.create({
            data: {
              actionType: 'UPDATE',
              entityType: 'EMPLOYEE',
              entityId: id,
              detailsJson: {
                bulkAction: 'MARK_INACTIVE',
                employeeId: employee.employeeId,
                employeeName: employee.employeeName,
                changeSource: 'BULK',
              },
            },
          }),
        ], { timeout: 30000 })
      } else {
        // RESIGNED
        await prisma.$transaction([
          prisma.employee.update({
            where: { id },
            data: { dateOfResignation: parsed.data.dateOfResignation! },
          }),
          prisma.auditLog.create({
            data: {
              actionType: 'UPDATE',
              entityType: 'EMPLOYEE',
              entityId: id,
              detailsJson: {
                bulkAction: 'MARK_RESIGNED',
                employeeId: employee.employeeId,
                employeeName: employee.employeeName,
                dateOfResignation: parsed.data.dateOfResignation,
                changeSource: 'BULK',
              },
            },
          }),
        ], { timeout: 30000 })
      }

      result.succeeded++
    } catch (error) {
      result.failed++
      result.errors.push({
        employeeId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return result
}

// ─── bulkUpdateHourlyRate ─────────────────────────────────────────────────────

export async function bulkUpdateHourlyRate(input: BulkHourlyRateUpdateInput): Promise<BulkOperationResult> {
  const parsed = BulkHourlyRateUpdateSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues?.[0]
    throw new EmployeeServiceError(
      'VALIDATION_ERROR',
      firstIssue?.message ?? 'Invalid bulk daily wage update data'
    )
  }

  const effectiveDate = parsed.data.effectiveFrom ?? new Date()
  const newDailyWage = parsed.data.newDailyWage
  const newHourlyRate = computeHourlyRate(newDailyWage)
  const result: BulkOperationResult = { succeeded: 0, skipped: 0, failed: 0, errors: [] }

  for (const id of parsed.data.ids) {
    try {
      // Fetch employee
      const employee = await prisma.employee.findUnique({ where: { id } })
      if (!employee) {
        result.failed++
        result.errors.push({ employeeId: id, error: `Employee with id "${id}" not found` })
        continue
      }

      // Fetch current wage history
      const currentWageEntries = await prisma.employeeWageHistory.findMany({
        where: { employeeId: id },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
      })
      const currentWage = currentWageEntries[0]

      // Skip if the daily wage already matches
      if (currentWage && Number(currentWage.weeklySalary) === newDailyWage) {
        result.skipped++
        continue
      }

      const newWageEntryId = randomUUID()

      await prisma.$transaction([
        // Close previous open wage history entry
        prisma.employeeWageHistory.updateMany({
          where: { employeeId: id, effectiveTo: null },
          data: { effectiveTo: effectiveDate },
        }),

        // Create new wage history entry
        prisma.employeeWageHistory.create({
          data: {
            id: newWageEntryId,
            employeeId: id,
            weeklySalary: newDailyWage,
            hourlyRate: newHourlyRate,
            effectiveFrom: effectiveDate,
            effectiveTo: null,
            changeSource: 'BULK',
          },
        }),

        // Create audit log
        prisma.auditLog.create({
          data: {
            actionType: 'UPDATE',
            entityType: 'WAGE_HISTORY',
            entityId: newWageEntryId,
            detailsJson: {
              bulkAction: 'CHANGE_HOURLY_RATE',
              employeeId: employee.employeeId,
              employeeName: employee.employeeName,
              oldDailyWage: currentWage ? Number(currentWage.weeklySalary) : null,
              newDailyWage,
              oldHourlyRate: currentWage ? Number(currentWage.hourlyRate) : null,
              newHourlyRate,
              effectiveFrom: effectiveDate,
              changeSource: 'BULK',
            },
          },
        }),
      ], { timeout: 30000 })

      result.succeeded++
    } catch (error) {
      result.failed++
      result.errors.push({
        employeeId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return result
}

// ─── Filters (Distinct Values) ────────────────────────────────────────────────

export async function getDistinctDesignations(): Promise<string[]> {
  const result = await prisma.employee.findMany({
    select: { designation: true },
    distinct: ['designation'],
    where: { designation: { not: '' } },
    orderBy: { designation: 'asc' },
  })
  return result.map(r => r.designation).filter(Boolean) as string[]
}

export async function getDistinctSites(): Promise<string[]> {
  const result = await prisma.employee.findMany({
    select: { site: true },
    distinct: ['site'],
    where: { site: { not: null } },
    orderBy: { site: 'asc' },
  })
  return result.map(r => r.site).filter(Boolean) as string[]
}
