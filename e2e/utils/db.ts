import 'dotenv/config'
import { PrismaClient, type PayrollRevision } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const connectionString = process.env.DIRECT_DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 5000,
})
pool.on('error', () => {}) // Suppress pool errors
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })
export default prisma;


export async function cleanupDatabase() {
  const tables = [
    '"AuditLog"',
    '"InvoiceSnapshot"',
    '"PayrollRunEmployee"',
    '"PayrollRevision"',
    '"PayrollAdjustmentApplication"',
    '"PayrollAdjustment"',
    '"PayrollRun"',
    '"AttendanceRecord"',
    '"AttendanceUpload"',
    '"EmployeeWageHistory"',
    '"EmployeeDocument"',
    '"Employee"',
    '"EmployeeImportBatch"',
  ];
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM ${tables.join('; DELETE FROM ')};`);
  } catch (err) {
    console.error(`Cleanup failed:`, (err as Error).message);
    throw err;
  }
}

export async function seedAdjustmentTestData() {
  try {
    await prisma.$connect();

    // Create a test employee for adjustment flows
    const employee = await prisma.employee.create({
      data: {
        employeeId: 'EMP-ADJ-001',
        employeeName: 'Adjustment Test Employee',
        designation: 'Worker',
        isActive: true,
        wageHistory: {
          create: {
            weeklySalary: 6000,
            hourlyRate: 120,
            effectiveFrom: new Date('2025-01-01'),
            changeSource: 'SEED',
          },
        },
      },
    });

    // Create 3 test adjustments (2 active, 1 completed)
    const week1Start = new Date('2025-03-06');
    const week1End = new Date('2025-03-12');
    const week2Start = new Date('2025-03-13');
    const week2End = new Date('2025-03-19');

    // Adjustment 1: ONE_TIME DEDUCTION (active, pending)
    const adj1 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'ONE_TIME',
        amount: 500,
        reason: 'Advance recovery seed',
        startPayrollWeekStartDate: week1Start,
        startPayrollWeekEndDate: week1End,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj1.id,
        employeeId: employee.id,
        payrollWeekStartDate: week1Start,
        payrollWeekEndDate: week1End,
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    });

    // Adjustment 2: RECURRING ADDITION (active)
    const adj2 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'ADDITION',
        recurrenceType: 'RECURRING',
        amount: 1000,
        reason: 'Transport allowance seed',
        startPayrollWeekStartDate: week1Start,
        startPayrollWeekEndDate: week1End,
        recurrenceEndType: 'FIXED_WEEKS',
        totalRecurrenceWeeks: 4,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj2.id,
        employeeId: employee.id,
        payrollWeekStartDate: week1Start,
        payrollWeekEndDate: week1End,
        appliedAmount: 1000,
        approvalStatus: 'APPROVED',
        appliedAt: new Date('2025-03-12'),
      },
    });

    // Adjustment 3: RECURRING DEDUCTION with total balance (completed)
    const adj3 = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employee.id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'RECURRING',
        amount: 2000,
        reason: 'Loan recovery seed',
        startPayrollWeekStartDate: week2Start,
        startPayrollWeekEndDate: week2End,
        recurrenceEndType: 'TOTAL_BALANCE',
        totalBalance: 2000,
        remainingBalance: 0,
        status: 'COMPLETED',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj3.id,
        employeeId: employee.id,
        payrollWeekStartDate: week2Start,
        payrollWeekEndDate: week2End,
        appliedAmount: 2000,
        approvalStatus: 'APPROVED',
        appliedAt: new Date('2025-03-19'),
      },
    });
  } catch (err) {
    console.error('Adjustment seed failed:', err);
    throw err;
  }
}

// ─── seedPayrollTestData ──────────────────────────────────────────────────────
// Seeds a minimal but complete scenario for F06 E2E tests:
//   - 3 employees with wage history
//   - 1 READY AttendanceUpload for March 6-12 with daily records
//   - 1 ERRORS AttendanceUpload for March 13-19 (blocked)
//   - 1 pending adjustment application for March 6-12

export async function seedPayrollTestData() {
  try {
    await prisma.$connect();

    const weekStart = new Date('2025-03-06T00:00:00.000Z');
    const weekEnd   = new Date('2025-03-12T00:00:00.000Z');
    const errWeekStart = new Date('2025-03-13T00:00:00.000Z');
    const errWeekEnd   = new Date('2025-03-19T00:00:00.000Z');

    // ── Employees ──────────────────────────────────────────────────────────
    const employees = await Promise.all([
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-001',
          employeeName: 'Kavitha Rajan',
          designation: 'Security Guard',
          designationShort: 'Guard',
          site: 'North Gate',
          gPay: '9876543210',
          bankAccount: '012345678901',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 2500,
              hourlyRate: 62.5,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-002',
          employeeName: 'Ramesh Nair',
          designation: 'Supervisor',
          designationShort: 'Supv.',
          site: 'South Gate',
          gPay: '9123456780',
          bankAccount: '098765432109',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 3000,
              hourlyRate: 75.0,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP-PRY-003',
          employeeName: 'Sunita Pillai',
          designation: 'Security Guard',
          designationShort: 'Guard',
          site: 'East Gate',
          gPay: null,
          bankAccount: null,
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 2500,
              hourlyRate: 62.5,
              effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
              changeSource: 'SEED',
            },
          },
        },
      }),
    ]);

    // ── READY upload for March 6-12 ────────────────────────────────────────
    const readyUpload = await prisma.attendanceUpload.create({
      data: {
        fileName: 'attendance-march-wk1.xlsx',
        fileType: 'xlsx',
        payrollWeekStartDate: weekStart,
        payrollWeekEndDate: weekEnd,
        payrollWeekSource: 'SHEET_CONTENT',
        status: 'READY',
        isActiveForPayrollWeek: true,

      },
    });

    // Daily records for each employee (Thu–Wed = 7 days)
    // Employee 1: reg=[8,8,6,0,8,8,8], OT=[2,0,0,0,3,1,0] → reg=46, OT=6
    // Employee 2: reg=[8,8,8,8,8,8,8], OT=[0,0,0,0,0,0,0] → reg=56, OT=0
    // Employee 3: reg=[8,8,8,0,8,8,8], OT=[0,0,0,0,0,0,0] → reg=48, OT=0
    const attendanceDays = [
      [{ reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 }],
      [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
      [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
    ];

    for (let empIdx = 0; empIdx < employees.length; empIdx++) {
      for (let day = 0; day < 7; day++) {
        const date = new Date(weekStart);
        date.setUTCDate(date.getUTCDate() + day);
        await prisma.attendanceRecord.create({
          data: {
            attendanceUploadId: readyUpload.id,
            employeeId: employees[empIdx].id,
            attendanceDate: date,
            regularHours: attendanceDays[empIdx][day].reg,
            overtimeHours: attendanceDays[empIdx][day].ot,
            sourceSheetName: 'Attendance',
            sourceEmployeeBlockIndex: empIdx,
          },
        });
      }
    }

    // ── Pending adjustment for Employee 1 in week 1 ───────────────────────
    const adj = await prisma.payrollAdjustment.create({
      data: {
        employeeId: employees[0].id,
        adjustmentType: 'DEDUCTION',
        recurrenceType: 'ONE_TIME',
        amount: 500,
        reason: 'Advance recovery',
        startPayrollWeekStartDate: weekStart,
        startPayrollWeekEndDate: weekEnd,
        status: 'ACTIVE',
        skippedCarryForwardCount: 0,
      },
    });
    await prisma.payrollAdjustmentApplication.create({
      data: {
        payrollAdjustmentId: adj.id,
        employeeId: employees[0].id,
        payrollWeekStartDate: weekStart,
        payrollWeekEndDate: weekEnd,
        appliedAmount: 500,
        approvalStatus: 'PENDING',
      },
    });

    // ── ERRORS upload for March 13-19 ─────────────────────────────────────
    await prisma.attendanceUpload.create({
      data: {
        fileName: 'attendance-march-wk2.xlsx',
        fileType: 'xlsx',
        payrollWeekStartDate: errWeekStart,
        payrollWeekEndDate: errWeekEnd,
        payrollWeekSource: 'SHEET_CONTENT',
        status: 'ERRORS',
        isActiveForPayrollWeek: true,

      },
    });

    return { employees, readyUpload };
  } catch (err) {
    console.error('Payroll seed failed:', err);
    throw err;
  }
}

// ─── seedApprovedPayrollData ──────────────────────────────────────────────────
// Seeds a complete approved payroll scenario for F07 E2E tests:
//   - 2 employees with wage history and attendance records
//   - 1 APPROVED PayrollRun + PayrollRevision + PayrollRunEmployee records
//   - Attendance records for 7 days (for daily slip breakdown)

export async function seedApprovedPayrollData(): Promise<{ payrollRunId: string }> {
  await prisma.$connect();

  const weekStart = new Date('2025-04-03T00:00:00.000Z');
  const weekEnd   = new Date('2025-04-09T00:00:00.000Z');
  const approvedAt = new Date('2025-04-10T08:00:00.000Z');

  const emp1 = await prisma.employee.create({
    data: {
      employeeId: 'EMP-RPT-001',
      employeeName: 'Meera Krishnan',
      designation: 'Security Guard',
      designationShort: 'Guard',
      site: 'Main Gate',
      gPay: '9988776655',
      bankAccount: '123456789012',
      isActive: true,
      wageHistory: {
        create: {
          weeklySalary: 2500,
          hourlyRate: 62.5,
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
          changeSource: 'SEED',
        },
      },
    },
  });

  const emp2 = await prisma.employee.create({
    data: {
      employeeId: 'EMP-RPT-002',
      employeeName: 'Vijay Kumar',
      designation: 'Supervisor',
      designationShort: 'Supv.',
      site: 'Back Gate',
      gPay: '9876543212',
      bankAccount: '987654321098',
      isActive: true,
      wageHistory: {
        create: {
          weeklySalary: 3000,
          hourlyRate: 75.0,
          effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
          changeSource: 'SEED',
        },
      },
    },
  });

  // Attendance upload (READY) so the slip builder can find daily breakdowns
  const upload = await prisma.attendanceUpload.create({
    data: {
      fileName: 'attendance-apr-wk1.xlsx',
      fileType: 'xlsx',
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate: weekEnd,
      payrollWeekSource: 'SHEET_CONTENT',
      status: 'READY',
      isActiveForPayrollWeek: true,

    },
  });

  // emp1: reg=[8,8,6,0,8,8,8] ot=[2,0,0,0,3,1,0] → reg=46, ot=6
  // emp2: reg=[8,8,8,8,8,8,8] ot=[0,0,0,0,0,0,0] → reg=56, ot=0
  const attendanceDays = [
    [{ reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 }, { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 }],
    [{ reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }],
  ];
  const employees = [emp1, emp2];

  const attendanceData = [];
  for (let ei = 0; ei < employees.length; ei++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + day);
      attendanceData.push({
        attendanceUploadId: upload.id,
        employeeId: employees[ei].id,
        attendanceDate: date,
        regularHours: attendanceDays[ei][day].reg,
        overtimeHours: attendanceDays[ei][day].ot,
        sourceSheetName: 'Attendance',
        sourceEmployeeBlockIndex: ei,
      });
    }
  }
  await prisma.attendanceRecord.createMany({ data: attendanceData });

  // emp1: reg=46h × Rs.62.5 = 2875, ot=6h × Rs.62.5 = 375, ded=500 → net=2750
  // emp2: reg=56h × Rs.75  = 4200, ot=0                    , ded=0   → net=4200
  const run = await prisma.payrollRun.create({
    data: {
      payrollWeekStartDate: weekStart,
      payrollWeekEndDate:   weekEnd,
      status: 'APPROVED',
      currentRevisionNumber: 1,
      totalRegularPay:  7075,
      totalOvertimePay: 375,
      totalAdditions:   0,
      totalDeductions:  500,
      totalNetPayable:  6950,
      approvedAt,
    },
  });

  const revision = await prisma.payrollRevision.create({
    data: {
      payrollRunId: run.id,
      revisionNumber: 1,
      status: 'APPROVED',
      isCurrent: true,
      totalRegularPay:  7075,
      totalOvertimePay: 375,
      totalAdditions:   0,
      totalDeductions:  500,
      totalNetPayable:  6950,
      approvedAt,
    },
  });

  const payrollEmployeeData = [
    { emp: emp1, weeklySalary: 2500, hourlyRate: 62.5, regularHours: 46, overtimeHours: 6, regularPay: 2875, overtimePay: 375, additions: 0, deductions: 500, netPayable: 2750 },
    { emp: emp2, weeklySalary: 3000, hourlyRate: 75,   regularHours: 56, overtimeHours: 0, regularPay: 4200, overtimePay: 0,   additions: 0, deductions: 0,   netPayable: 4200 },
  ];

  await prisma.payrollRunEmployee.createMany({
    data: payrollEmployeeData.map(pd => ({
      payrollRunId:      run.id,
      payrollRevisionId: revision.id,
      employeeId:        pd.emp.id,
      weeklySalaryUsed:  pd.weeklySalary,
      hourlyRateUsed:    pd.hourlyRate,
      regularHours:      pd.regularHours,
      overtimeHours:     pd.overtimeHours,
      regularPay:        pd.regularPay,
      overtimePay:       pd.overtimePay,
      additions:         pd.additions,
      deductions:        pd.deductions,
      netPayable:        pd.netPayable,
    }))
  });

  return { payrollRunId: run.id };
}

// ─── DB verification helpers ──────────────────────────────────────────────────

export async function getInvoiceSnapshotCount(payrollRunId: string): Promise<number> {
  await prisma.$connect();
  return prisma.invoiceSnapshot.count({ where: { payrollRunId } });
}

export async function getCleanedSnapshotCount(payrollRunId: string): Promise<number> {
  await prisma.$connect();
  return prisma.invoiceSnapshot.count({
    where: { payrollRunId, temporaryFileDeletedAt: { not: null } },
  });
}

export async function seedTestData() {
  try {
    // We use a transaction for seeding to ensure atomicity
    await prisma.$transaction([
      prisma.employee.create({
        data: {
          employeeId: 'EMP001',
          employeeName: 'Matched Employee',
          designation: 'Worker',
          isActive: true,
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP002',
          employeeName: 'Inactive Employee',
          designation: 'Worker',
          isActive: false,
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
      prisma.employee.create({
        data: {
          employeeId: 'EMP003',
          employeeName: 'Resigned Employee',
          designation: 'Worker',
          isActive: true,
          dateOfResignation: new Date('2025-03-01'),
          wageHistory: {
            create: {
              weeklySalary: 5000,
              hourlyRate: 100,
              effectiveFrom: new Date('2025-01-01'),
              changeSource: 'SEED',
            },
          },
        },
      }),
    ]);
  } catch (err) {
    console.error('Seed failed:', err);
    throw err;
  }
}

// ─── seedApprovedPayrollForCorrection ─────────────────────────────────────────
// Seeds a complete approved payroll scenario for F08 correction E2E tests using raw SQL:
//   - 2 employees with wage history + attendance records
//   - 1 APPROVED PayrollRun + PayrollRevision (revision 1) + PayrollRunEmployee records
//   - 1 approved deduction adjustment application

export async function seedApprovedPayrollForCorrection(): Promise<{
  payrollRunId: string;
  revisionId: string;
  employeeIds: string[];
  adjustmentApplicationId: string;
}> {
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      await prisma.$executeRawUnsafe(sql, ...params);
    }
  };

  const weekStart = '2025-04-17T00:00:00.000Z'
  const weekEnd   = '2025-04-23T00:00:00.000Z'
  const approvedAt = '2025-04-24T08:00:00.000Z'
  const wageEffective = '2025-01-01T00:00:00.000Z'

  // Use crypto.randomUUID for IDs
  const emp1Id = crypto.randomUUID()
  const emp2Id = crypto.randomUUID()
  const wage1Id = crypto.randomUUID()
  const wage2Id = crypto.randomUUID()
  const uploadId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const adjId = crypto.randomUUID()
  const adjAppId = crypto.randomUUID()

  // Create employees
  await client.query(
    `INSERT INTO "Employee" (id, "employeeId", "employeeName", designation, "designationShort", site, "gPay", "bankAccount", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW()),
            ($9, $10, $11, $12, $13, $14, $15, $16, true, NOW(), NOW())`,
    [
      emp1Id, 'EMP-COR-001', 'Anita Sharma', 'Security Guard', 'Guard', 'North Gate', '9876543210', '112233445566',
      emp2Id, 'EMP-COR-002', 'Rajesh Iyer', 'Supervisor', 'Supv.', 'South Gate', '9123456780', '665544332211',
    ]
  )

  // Create wage history
  await client.query(
    `INSERT INTO "EmployeeWageHistory" (id, "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "changeSource", "createdAt")
     VALUES ($1, $2, 2500.00, 62.50, $3, 'SEED', NOW()),
            ($4, $5, 3000.00, 75.00, $6, 'SEED', NOW())`,
    [wage1Id, emp1Id, wageEffective, wage2Id, emp2Id, wageEffective]
  )

  // Create attendance upload
  await client.query(
    `INSERT INTO "AttendanceUpload" (id, "fileName", "fileType", "payrollWeekStartDate", "payrollWeekEndDate", "payrollWeekSource", status, "isActiveForPayrollWeek", "uploadedAt")
     VALUES ($1, 'attendance-apr-wk3.xlsx', 'xlsx', $2, $3, 'SHEET_CONTENT', 'READY', true, NOW())`,
    [uploadId, weekStart, weekEnd]
  )

  // Create attendance records
  // emp1: reg=[8,8,6,0,8,8,8]=46h, ot=[2,0,0,0,3,1,0]=6h
  // emp2: reg=[8,8,8,8,8,8,8]=56h, ot=[0,0,0,0,0,0,0]=0h
  const emp1Days = [
    { reg: 8, ot: 2 }, { reg: 8, ot: 0 }, { reg: 6, ot: 0 },
    { reg: 0, ot: 0 }, { reg: 8, ot: 3 }, { reg: 8, ot: 1 }, { reg: 8, ot: 0 },
  ]
  const emp2Days = [
    { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 },
    { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 }, { reg: 8, ot: 0 },
  ]

  const values: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  for (const [empId, days] of [[emp1Id, emp1Days], [emp2Id, emp2Days]] as const) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart)
      date.setUTCDate(date.getUTCDate() + day)
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`)
      params.push(crypto.randomUUID(), uploadId, empId, date.toISOString(), days[day].reg, days[day].ot)
    }
  }

  await client.query(
    `INSERT INTO "AttendanceRecord" (id, "attendanceUploadId", "employeeId", "attendanceDate", "regularHours", "overtimeHours")
     VALUES ${values.join(', ')}`,
    params
  )

  // Create payroll run
  // emp1: reg=46×62.5=2875, ot=6×62.5=375, ded=500 → net=2750
  // emp2: reg=56×75=4200, ot=0 → net=4200
  await client.query(
    `INSERT INTO "PayrollRun" (id, "payrollWeekStartDate", "payrollWeekEndDate", status, "currentRevisionNumber",
     "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable", "approvedAt", "generatedAt")
     VALUES ($1, $2, $3, 'APPROVED', 1, 7075.00, 375.00, 0.00, 500.00, 6950.00, $4, NOW())`,
    [runId, weekStart, weekEnd, approvedAt]
  )

  // Create payroll revision
  await client.query(
    `INSERT INTO "PayrollRevision" (id, "payrollRunId", "revisionNumber", status, "isCurrent",
     "totalRegularPay", "totalOvertimePay", "totalAdditions", "totalDeductions", "totalNetPayable",
     "approvedAt", "generatedAt")
     VALUES ($1, $2, 1, 'APPROVED', true, 7075.00, 375.00, 0.00, 500.00, 6950.00, $3, $4)`,
    [revisionId, runId, approvedAt, approvedAt]
  )

  // Create payroll run employees
  await client.query(
    `INSERT INTO "PayrollRunEmployee" (id, "payrollRunId", "payrollRevisionId", "employeeId",
     "weeklySalaryUsed", "hourlyRateUsed", "regularHours", "overtimeHours",
     "regularPay", "overtimePay", additions, deductions, "netPayable")
     VALUES ($1, $2, $3, $4, 2500.00, 62.50, 46, 6, 2875.00, 375.00, 0.00, 500.00, 2750.00),
            ($5, $6, $7, $8, 3000.00, 75.00, 56, 0, 4200.00, 0.00, 0.00, 0.00, 4200.00)`,
    [
      crypto.randomUUID(), runId, revisionId, emp1Id,
      crypto.randomUUID(), runId, revisionId, emp2Id,
    ]
  )

  // Adjustment: ₹500 deduction for emp1 (approved)
  await client.query(
    `INSERT INTO "PayrollAdjustment" (id, "employeeId", "adjustmentType", "recurrenceType",
     amount, reason, "startPayrollWeekStartDate", "startPayrollWeekEndDate", status, "skippedCarryForwardCount", "createdAt")
     VALUES ($1, $2, 'DEDUCTION', 'ONE_TIME', 500.00, 'Advance recovery seed', $3, $4, 'ACTIVE', 0, NOW())`,
    [adjId, emp1Id, weekStart, weekEnd]
  )

  await client.query(
    `INSERT INTO "PayrollAdjustmentApplication" (id, "payrollAdjustmentId", "employeeId",
     "payrollRunId", "payrollWeekStartDate", "payrollWeekEndDate",
     "appliedAmount", "approvalStatus", "appliedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 500.00, 'APPROVED', $7)`,
    [adjAppId, adjId, emp1Id, runId, weekStart, weekEnd, approvedAt]
  )

  return {
    payrollRunId: runId,
    revisionId: revisionId,
    employeeIds: [emp1Id, emp2Id],
    adjustmentApplicationId: adjAppId,
  }
}

// ─── F08 verification helpers ─────────────────────────────────────────────────

export async function getRevisionCount(payrollRunId: string): Promise<number> {
  const result = await prisma.$queryRawUnsafe<{ cnt: bigint | number | string }[]>(
    'SELECT COUNT(*) as cnt FROM "PayrollRevision" WHERE "payrollRunId" = $1',
    payrollRunId
  )
  return parseInt(result[0]?.cnt?.toString() ?? '0', 10)
}

export async function getCurrentRevision(payrollRunId: string) {
  const result = await prisma.$queryRawUnsafe<PayrollRevision[]>(
    'SELECT * FROM "PayrollRevision" WHERE "payrollRunId" = $1 AND "isCurrent" = true LIMIT 1',
    payrollRunId
  )
  return result[0] ?? null
}

export async function getPayrollRunStatus(payrollRunId: string) {
  const result = await prisma.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM "PayrollRun" WHERE id = $1',
    payrollRunId
  )
  return result[0]?.status ?? null
}
