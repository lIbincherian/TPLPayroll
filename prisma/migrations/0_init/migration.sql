-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeImportBatchId" TEXT,
    "employeeId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "employeeName" TEXT NOT NULL,
    "nationalId" TEXT,
    "designation" TEXT NOT NULL,
    "dateOfJoining" TIMESTAMP(3),
    "aadhaarId" TEXT,
    "policeVerificationId" TEXT,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "healthCardId" TEXT,
    "gPay" TEXT,
    "bankAccount" TEXT,
    "dateOfResignation" TIMESTAMP(3),
    "site" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "designationShort" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedRowCount" INTEGER NOT NULL DEFAULT 0,
    "updatedEmployeeCount" INTEGER NOT NULL DEFAULT 0,
    "createdEmployeeCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedRowCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateEmployeeIdRowCount" INTEGER NOT NULL DEFAULT 0,
    "sourceFileDeletedAt" TIMESTAMP(3),

    CONSTRAINT "EmployeeImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeWageHistory" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "weeklySalary" DECIMAL(10,2) NOT NULL,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "changeSource" TEXT NOT NULL,
    "employeeImportBatchId" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeWageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceUpload" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "payrollWeekStartDate" TIMESTAMP(3) NOT NULL,
    "payrollWeekEndDate" TIMESTAMP(3) NOT NULL,
    "payrollWeekSource" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isActiveForPayrollWeek" BOOLEAN NOT NULL DEFAULT true,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceStorageKey" TEXT,

    CONSTRAINT "AttendanceUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "attendanceUploadId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceDate" TIMESTAMP(3) NOT NULL,
    "regularHours" DECIMAL(5,2) NOT NULL,
    "overtimeHours" DECIMAL(5,2) NOT NULL,
    "beforeNoonIn" TEXT,
    "beforeNoonOut" TEXT,
    "afternoonIn" TEXT,
    "afternoonOut" TEXT,
    "overtimeIn" TEXT,
    "overtimeOut" TEXT,
    "sourceSheetName" TEXT,
    "sourceEmployeeBlockIndex" INTEGER,
    "verificationDecision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "recurrenceType" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "startPayrollWeekStartDate" TIMESTAMP(3) NOT NULL,
    "startPayrollWeekEndDate" TIMESTAMP(3) NOT NULL,
    "endPayrollWeekStartDate" TIMESTAMP(3),
    "endPayrollWeekEndDate" TIMESTAMP(3),
    "totalRecurrenceWeeks" INTEGER,
    "totalBalance" DECIMAL(10,2),
    "remainingBalance" DECIMAL(10,2),
    "recurrenceEndType" TEXT,
    "status" TEXT NOT NULL,
    "skippedCarryForwardCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustmentApplication" (
    "id" TEXT NOT NULL,
    "payrollAdjustmentId" TEXT NOT NULL,
    "payrollRunId" TEXT,
    "payrollRevisionId" TEXT,
    "employeeId" TEXT NOT NULL,
    "payrollWeekStartDate" TIMESTAMP(3) NOT NULL,
    "payrollWeekEndDate" TIMESTAMP(3) NOT NULL,
    "appliedAmount" DECIMAL(10,2) NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "carriedForwardToPayrollWeekStartDate" TIMESTAMP(3),
    "isReversed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PayrollAdjustmentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "payrollWeekStartDate" TIMESTAMP(3) NOT NULL,
    "payrollWeekEndDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "currentRevisionNumber" INTEGER NOT NULL DEFAULT 1,
    "totalRegularPay" DECIMAL(12,2) NOT NULL,
    "totalOvertimePay" DECIMAL(12,2) NOT NULL,
    "totalAdditions" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "totalNetPayable" DECIMAL(12,2) NOT NULL,
    "generatedBy" TEXT,
    "approvedBy" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "invoicesGeneratedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRevision" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "correctionReason" TEXT,
    "totalRegularPay" DECIMAL(12,2) NOT NULL,
    "totalOvertimePay" DECIMAL(12,2) NOT NULL,
    "totalAdditions" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "totalNetPayable" DECIMAL(12,2) NOT NULL,
    "generatedBy" TEXT,
    "approvedBy" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "invoicesGeneratedAt" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PayrollRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunEmployee" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "payrollRevisionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "weeklySalaryUsed" DECIMAL(10,2) NOT NULL,
    "hourlyRateUsed" DECIMAL(10,2) NOT NULL,
    "regularHours" DECIMAL(5,2) NOT NULL,
    "overtimeHours" DECIMAL(5,2) NOT NULL,
    "regularPay" DECIMAL(10,2) NOT NULL,
    "overtimePay" DECIMAL(10,2) NOT NULL,
    "additions" DECIMAL(10,2) NOT NULL,
    "deductions" DECIMAL(10,2) NOT NULL,
    "netPayable" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "PayrollRunEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSnapshot" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "payrollRevisionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "invoiceFormat" TEXT NOT NULL,
    "invoiceSnapshotJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "temporaryFileDeletedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceUploadSession" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "weekEnd" TEXT NOT NULL,
    "weekSource" TEXT NOT NULL,
    "decisionsJson" TEXT NOT NULL,
    "pendingBlockKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detailsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "notes" TEXT,
    "filePath" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "payrollWeekStartDay" "DayOfWeek" NOT NULL DEFAULT 'THURSDAY',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE INDEX "AttendanceUploadSession_expiresAt_idx" ON "AttendanceUploadSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_employeeImportBatchId_fkey" FOREIGN KEY ("employeeImportBatchId") REFERENCES "EmployeeImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWageHistory" ADD CONSTRAINT "EmployeeWageHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWageHistory" ADD CONSTRAINT "EmployeeWageHistory_employeeImportBatchId_fkey" FOREIGN KEY ("employeeImportBatchId") REFERENCES "EmployeeImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_attendanceUploadId_fkey" FOREIGN KEY ("attendanceUploadId") REFERENCES "AttendanceUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentApplication" ADD CONSTRAINT "PayrollAdjustmentApplication_payrollAdjustmentId_fkey" FOREIGN KEY ("payrollAdjustmentId") REFERENCES "PayrollAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentApplication" ADD CONSTRAINT "PayrollAdjustmentApplication_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentApplication" ADD CONSTRAINT "PayrollAdjustmentApplication_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentApplication" ADD CONSTRAINT "PayrollAdjustmentApplication_payrollRevisionId_fkey" FOREIGN KEY ("payrollRevisionId") REFERENCES "PayrollRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRevision" ADD CONSTRAINT "PayrollRevision_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_payrollRevisionId_fkey" FOREIGN KEY ("payrollRevisionId") REFERENCES "PayrollRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSnapshot" ADD CONSTRAINT "InvoiceSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSnapshot" ADD CONSTRAINT "InvoiceSnapshot_payrollRevisionId_fkey" FOREIGN KEY ("payrollRevisionId") REFERENCES "PayrollRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSnapshot" ADD CONSTRAINT "InvoiceSnapshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
