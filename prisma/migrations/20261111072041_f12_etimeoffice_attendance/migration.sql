-- F12: eTimeOffice attendance sync (replaces the Excel upload).
--
-- One migration, one transaction: either all of it applies or none of it does. Statement order matters:
--   1. new columns and tables (the data steps read and write them);
--   2. the data steps (marked below): refuse a week with two approved payroll runs, key the approved
--      runs, deactivate duplicate active attendance weeks, key the active weeks;
--   3. the unique indexes on those keys, which need the data from step 2, then the other indexes and
--      the foreign keys;
--   4. DROP TABLE "AttendanceUploadSession".
--
-- Existing "AttendanceUpload" rows (the Excel era) take source = 'EXCEL' from the column default and keep
-- their status and file columns; only the NOT NULL on fileName and fileType is lifted so eTimeOffice weeks,
-- which have no file, fit the same table. Existing "AttendanceRecord" rows are not touched.
--
-- If a deploy fails at the guard in the data steps below, nothing was changed; see docs/ci-and-migrations.md
-- ("Releasing F12") for how to fix the data and deploy again.

-- AlterTable
ALTER TABLE "AttendanceUpload" ADD COLUMN     "activeWeekStart" TIMESTAMP(3),
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedLeftOutCount" INTEGER,
ADD COLUMN     "lastSyncAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "lastSyncTrigger" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'EXCEL',
ADD COLUMN     "staleNoticeAt" TIMESTAMP(3),
ADD COLUMN     "syncLockedAt" TIMESTAMP(3),
ALTER COLUMN "fileName" DROP NOT NULL,
ALTER COLUMN "fileType" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "approvedWeekStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AttendancePunch" (
    "id" TEXT NOT NULL,
    "attendanceUploadId" TEXT NOT NULL,
    "correctionId" TEXT,
    "clonedFromPunchId" TEXT,
    "employeeId" TEXT,
    "empCode" TEXT NOT NULL,
    "empName" TEXT,
    "matchStatus" TEXT NOT NULL,
    "punchDate" TIMESTAMP(3) NOT NULL,
    "pairIndex" INTEGER NOT NULL,
    "position" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "originalTime" TEXT,
    "currentTime" TEXT,
    "note" TEXT,
    "mergedScansJson" JSONB,
    "mcid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendancePunch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEmployeeDecision" (
    "id" TEXT NOT NULL,
    "attendanceUploadId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceEmployeeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCodeException" (
    "id" TEXT NOT NULL,
    "empCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceCodeException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCorrectionSession" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "attendanceUploadId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correctionReason" TEXT,
    "correctionTypesJson" JSONB NOT NULL,
    "adjustmentSnapshotJson" JSONB,
    "draftRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollCorrectionSession_pkey" PRIMARY KEY ("id")
);

-- BEGIN F12 DATA STEPS
-- Plain, idempotent SQL that needs only the columns and tables created above. It is the same logic as
-- scripts/backfill-approved-week-start.js and scripts/backfill-active-week-start.js, which stay as re-runnable
-- repair tools for a database that already has the F12 schema (and rehearse the release on old production data,
-- see scripts/seed-local-from-snapshot.js --backfill). src/__tests__/db/f12-migration.db.test.ts runs this block
-- and the scripts on the same rows and checks that they agree; it finds the block by the BEGIN and END markers.
--
-- PayrollRun."approvedWeekStart" equals "payrollWeekStartDate" while the run is APPROVED or REVISED and is NULL
-- otherwise. AttendanceUpload."activeWeekStart" equals "payrollWeekStartDate" while the row is the active one
-- for its week and is NULL otherwise. Both columns get a unique index below, and Postgres treats NULLs as
-- distinct, so each index means "at most one per week".

-- Step 1. Refuse to continue when a week already has two or more APPROVED/REVISED payroll runs. The exception
-- lists them and rolls the whole migration back, so nothing is changed and the deploy fails. Pick the real
-- run by hand first (the one whose revision is current and that has invoice snapshots), so that exactly one
-- approved run per week remains.
DO $$
DECLARE
  duplicate_weeks text;
BEGIN
  SELECT string_agg(d."weekStart" || ': ' || d."runIds", '; ' ORDER BY d."weekStart")
    INTO duplicate_weeks
  FROM (
    SELECT "payrollWeekStartDate"::date::text AS "weekStart",
           string_agg(id, ', ' ORDER BY "approvedAt", id) AS "runIds"
    FROM "PayrollRun"
    WHERE status IN ('APPROVED', 'REVISED')
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF duplicate_weeks IS NOT NULL THEN
    RAISE EXCEPTION 'F12 migration stopped, nothing was changed. These weeks have more than one APPROVED/REVISED payroll run (week: run ids): %. Leave exactly one APPROVED/REVISED run per week, then deploy again.', duplicate_weeks;
  END IF;
END $$;

-- Step 2. A run that is not APPROVED/REVISED must not hold a key (defensive: a no-op on the first run, when the
-- column was just added), then every APPROVED/REVISED run without a key gets one.
UPDATE "PayrollRun"
SET "approvedWeekStart" = NULL
WHERE status NOT IN ('APPROVED', 'REVISED') AND "approvedWeekStart" IS NOT NULL;

UPDATE "PayrollRun"
SET "approvedWeekStart" = "payrollWeekStartDate"
WHERE status IN ('APPROVED', 'REVISED') AND "approvedWeekStart" IS NULL;

-- Step 3. An inactive attendance row must not hold a key (defensive: a no-op on the first run).
UPDATE "AttendanceUpload"
SET "activeWeekStart" = NULL
WHERE "isActiveForPayrollWeek" = false AND "activeWeekStart" IS NOT NULL;

-- Step 4. A week that already has several active attendance rows keeps only the one that holds data: APPROVED or
-- READY (Excel) first, then REVIEW, then the rest; within a status a row with punches or attendance records beats
-- an empty one; then the newest "uploadedAt", the larger id on a tie. The others become inactive. Each one is
-- reported as a NOTICE (week, id, status); none is expected in production.
DO $$
DECLARE
  duplicate record;
BEGIN
  FOR duplicate IN
    SELECT ranked.id, ranked."weekStart", ranked.status
    FROM (
      SELECT u.id,
             u."payrollWeekStartDate"::date::text AS "weekStart",
             u.status,
             ROW_NUMBER() OVER (
               PARTITION BY u."payrollWeekStartDate"
               ORDER BY CASE u.status WHEN 'APPROVED' THEN 0 WHEN 'READY' THEN 0 WHEN 'REVIEW' THEN 1 ELSE 2 END,
                        (EXISTS (SELECT 1 FROM "AttendancePunch" p WHERE p."attendanceUploadId" = u.id)
                         OR EXISTS (SELECT 1 FROM "AttendanceRecord" r WHERE r."attendanceUploadId" = u.id)) DESC,
                        u."uploadedAt" DESC, u.id DESC
             ) AS "rankInWeek"
      FROM "AttendanceUpload" u
      WHERE u."isActiveForPayrollWeek" = true
    ) ranked
    WHERE ranked."rankInWeek" > 1
  LOOP
    UPDATE "AttendanceUpload"
    SET "isActiveForPayrollWeek" = false, "activeWeekStart" = NULL
    WHERE id = duplicate.id;
    RAISE NOTICE 'F12 migration deactivated a duplicate active attendance row: week %, id %, status %',
      duplicate."weekStart", duplicate.id, duplicate.status;
  END LOOP;
END $$;

-- Step 5. Every active attendance row without a key gets one.
UPDATE "AttendanceUpload"
SET "activeWeekStart" = "payrollWeekStartDate"
WHERE "isActiveForPayrollWeek" = true AND "activeWeekStart" IS NULL;
-- END F12 DATA STEPS

-- CreateIndex
CREATE INDEX "AttendancePunch_attendanceUploadId_correctionId_employeeId__idx" ON "AttendancePunch"("attendanceUploadId", "correctionId", "employeeId", "punchDate");

-- CreateIndex
CREATE INDEX "AttendancePunch_attendanceUploadId_empCode_idx" ON "AttendancePunch"("attendanceUploadId", "empCode");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEmployeeDecision_attendanceUploadId_employeeId_key" ON "AttendanceEmployeeDecision"("attendanceUploadId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceCodeException_empCode_key" ON "AttendanceCodeException"("empCode");

-- CreateIndex
CREATE INDEX "PayrollCorrectionSession_payrollRunId_status_idx" ON "PayrollCorrectionSession"("payrollRunId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceUpload_activeWeekStart_key" ON "AttendanceUpload"("activeWeekStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_approvedWeekStart_key" ON "PayrollRun"("approvedWeekStart");

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_attendanceUploadId_fkey" FOREIGN KEY ("attendanceUploadId") REFERENCES "AttendanceUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "PayrollCorrectionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEmployeeDecision" ADD CONSTRAINT "AttendanceEmployeeDecision_attendanceUploadId_fkey" FOREIGN KEY ("attendanceUploadId") REFERENCES "AttendanceUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEmployeeDecision" ADD CONSTRAINT "AttendanceEmployeeDecision_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCodeException" ADD CONSTRAINT "AttendanceCodeException_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCorrectionSession" ADD CONSTRAINT "PayrollCorrectionSession_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCorrectionSession" ADD CONSTRAINT "PayrollCorrectionSession_attendanceUploadId_fkey" FOREIGN KEY ("attendanceUploadId") REFERENCES "AttendanceUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable
-- The Excel upload and its resumable-session flow are removed in this release. The table holds only short-lived
-- upload sessions (each has an expiresAt); the production copy had one, already expired.
DROP TABLE "AttendanceUploadSession";
