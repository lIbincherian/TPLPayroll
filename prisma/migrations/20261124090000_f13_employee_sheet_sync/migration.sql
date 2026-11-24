-- F13: Employee Master sheet sync (replaces the Excel employee import).
--
-- One migration, one transaction: either all of it applies or none of it does. Statement order matters:
--   1. new columns (additive, nullable or defaulted);
--   2. the data steps (marked below): stop on two open wage rows that differ, delete the duplicate open
--      IMPORT wage row where an equal open MANUAL row exists, stop if any employee still has two open rows;
--   3. the partial unique index that needs the data from step 2: one open wage row per employee.
--
-- If a deploy fails at the guards in the data steps, nothing was changed. Fix the named employees'
-- wage history by hand (close or delete the wrong open row) and deploy again.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "aadhaarPhotoUrl" TEXT,
ADD COLUMN     "bankHolderName" TEXT,
ADD COLUMN     "bankHolderRelation" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "bloodGroup" TEXT,
ADD COLUMN     "distinctiveFeatures" TEXT,
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactNumber" TEXT,
ADD COLUMN     "emergencyContactRelation" TEXT,
ADD COLUMN     "gPayName" TEXT,
ADD COLUMN     "gPayRelation" TEXT,
ADD COLUMN     "height" TEXT,
ADD COLUMN     "homeAddress" TEXT,
ADD COLUMN     "homeState" TEXT,
ADD COLUMN     "ifscCode" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "otherSkills" TEXT,
ADD COLUMN     "panNumber" TEXT,
ADD COLUMN     "panPhotoUrl" TEXT,
ADD COLUMN     "passbookPhotoUrl" TEXT,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "relativesOnSite" TEXT,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "roomNumber" TEXT,
ADD COLUMN     "whatsappNumber" TEXT;

-- AlterTable
ALTER TABLE "EmployeeImportBatch" ADD COLUMN     "report" JSONB,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'EXCEL',
ADD COLUMN     "trigger" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "employeeSheetSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "employeeSheetSyncFirstAppliedAt" TIMESTAMP(3);

-- BEGIN F13 DATA STEPS
DO $$
DECLARE
  differing text;
  remaining text;
BEGIN
  -- (a) Two open wage rows that differ in amount or effective date: stop. Nothing is guessed.
  SELECT string_agg(e."employeeId", ', ' ORDER BY e."employeeId") INTO differing
  FROM "Employee" e
  WHERE e."id" IN (
    SELECT w."employeeId"
    FROM "EmployeeWageHistory" w
    WHERE w."effectiveTo" IS NULL
    GROUP BY w."employeeId"
    HAVING COUNT(*) > 1
       AND COUNT(DISTINCT (w."weeklySalary", w."effectiveFrom")) > 1
  );
  IF differing IS NOT NULL THEN
    RAISE EXCEPTION 'F13 migration stopped, nothing was changed. These employees have two open wage rows that differ: %. Close or delete the wrong open row in "EmployeeWageHistory", then deploy again.', differing;
  END IF;

  -- (b) Equal duplicates: keep the MANUAL open row, delete the open IMPORT row.
  DELETE FROM "EmployeeWageHistory" i
  WHERE i."effectiveTo" IS NULL
    AND i."changeSource" = 'IMPORT'
    AND EXISTS (
      SELECT 1
      FROM "EmployeeWageHistory" m
      WHERE m."employeeId" = i."employeeId"
        AND m."effectiveTo" IS NULL
        AND m."changeSource" = 'MANUAL'
    );

  -- (c) Anything still duplicated (for example two IMPORT rows and no MANUAL one): stop.
  SELECT string_agg(e."employeeId", ', ' ORDER BY e."employeeId") INTO remaining
  FROM "Employee" e
  WHERE e."id" IN (
    SELECT w."employeeId"
    FROM "EmployeeWageHistory" w
    WHERE w."effectiveTo" IS NULL
    GROUP BY w."employeeId"
    HAVING COUNT(*) > 1
  );
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'F13 migration stopped, nothing was changed. These employees still have more than one open wage row after removing duplicate IMPORT rows: %. Close or delete the wrong open row in "EmployeeWageHistory", then deploy again.', remaining;
  END IF;
END $$;
-- END F13 DATA STEPS

-- CreateIndex
-- One open (current) wage row per employee. Prisma cannot express a partial index, so it is only here.
CREATE UNIQUE INDEX "EmployeeWageHistory_one_open_per_employee" ON "EmployeeWageHistory"("employeeId") WHERE "effectiveTo" IS NULL;
