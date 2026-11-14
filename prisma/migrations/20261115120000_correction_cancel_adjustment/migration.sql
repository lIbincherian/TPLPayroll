-- AlterTable
ALTER TABLE "PayrollAdjustmentApplication" ADD COLUMN     "cancelOnCorrectionApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reversedInRevisionNumber" INTEGER;
