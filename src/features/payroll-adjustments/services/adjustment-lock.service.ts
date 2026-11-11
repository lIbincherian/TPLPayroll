import { Prisma } from '@prisma/client'

/**
 * SELECT id FROM "PayrollAdjustment" WHERE id IN (...) ORDER BY id FOR UPDATE. A no-op for an empty list.
 *
 * An adjustment's balance and status are shared by every week its applications are in, so the week's row lock
 * (`lockWeekRow`) does not protect them: two corrections of different weeks, or a correction and another week's
 * approval, would write the same row under different locks. Whoever reads an adjustment to change its balance
 * takes this lock first and reads the row after it.
 *
 * Only call it inside `prisma.$transaction(async (tx) => ...)`, with that `tx`. Lock order everywhere: the
 * week's row first, then adjustment rows in id order (one statement, ORDER BY id, so two callers cannot lock
 * the same pair the opposite way round).
 */
export async function lockAdjustmentRows(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  adjustmentIds: string[],
): Promise<void> {
  const ids = [...new Set(adjustmentIds)]
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT id FROM "PayrollAdjustment" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
}
