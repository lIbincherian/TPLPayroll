/* eslint-disable @typescript-eslint/no-require-imports -- a plain Node script, like the other files in scripts/ */
/**
 * Backfill AttendanceUpload.activeWeekStart. Run once per database, after `prisma db push` has
 * added the column and before relying on the unique constraint. Safe to run again (idempotent).
 *
 *   node scripts/backfill-active-week-start.js
 *
 * Uses DIRECT_DATABASE_URL (or DATABASE_URL) from the environment / .env, so check which
 * database that points at before running it. It prints the host and database name, never the
 * login.
 *
 * `activeWeekStart` equals `payrollWeekStartDate` while the row is the active one for its week
 * and is NULL otherwise. Because it is unique and Postgres treats NULLs as distinct, that gives
 * exactly one active row per week. Three steps, in one transaction:
 *   0. Inactive rows must not hold a key; clear any that do. (A stale key on an inactive row would
 *      make step 2 hit the unique index when another row of that week takes the key.)
 *   1. Weeks that already have several active rows keep only the one that holds data: APPROVED or
 *      READY (Excel) first, then REVIEW, then the rest; within a status a row with punches or
 *      attendance records beats an empty one; then the newest uploadedAt, the larger id on a tie.
 *      The others are set isActiveForPayrollWeek = false and their key to NULL, and each one is
 *      printed (week, id, status).
 *   2. Every active row without an activeWeekStart gets one.
 */
require('dotenv').config()
const { Client } = require('pg')

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || ''

function describeTarget(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(unparseable connection string)'
  }
}

async function run() {
  if (!connectionString) {
    console.error('Set DIRECT_DATABASE_URL or DATABASE_URL first.')
    process.exit(1)
  }
  console.log(`Target: ${describeTarget(connectionString)}`)

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10000,
    // Supabase's pooler certificate chains to Supabase's own CA, which Node does not trust by default, so
    // chain verification is off (same as src/lib/prisma.ts). The link is still encrypted. To verify, ship the
    // CA from the Supabase dashboard and use { ca, rejectUnauthorized: true } here and in prisma.ts together.
    ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  })
  await client.connect()

  try {
    await client.query('BEGIN')

    const staleKeys = await client.query(`
      UPDATE "AttendanceUpload"
      SET "activeWeekStart" = NULL
      WHERE "isActiveForPayrollWeek" = false AND "activeWeekStart" IS NOT NULL
    `)

    const deactivated = await client.query(`
      UPDATE "AttendanceUpload" u
      SET "isActiveForPayrollWeek" = false, "activeWeekStart" = NULL
      FROM (
        SELECT u2.id,
               ROW_NUMBER() OVER (
                 PARTITION BY u2."payrollWeekStartDate"
                 ORDER BY CASE u2."status" WHEN 'APPROVED' THEN 0 WHEN 'READY' THEN 0 WHEN 'REVIEW' THEN 1 ELSE 2 END,
                          (EXISTS (SELECT 1 FROM "AttendancePunch" p WHERE p."attendanceUploadId" = u2.id)
                           OR EXISTS (SELECT 1 FROM "AttendanceRecord" r WHERE r."attendanceUploadId" = u2.id)) DESC,
                          u2."uploadedAt" DESC, u2.id DESC
               ) AS position
        FROM "AttendanceUpload" u2
        WHERE u2."isActiveForPayrollWeek" = true
      ) ranked
      WHERE u.id = ranked.id AND ranked.position > 1
      RETURNING u.id, u."payrollWeekStartDate"::date::text AS "weekStart", u.status
    `)

    const filled = await client.query(`
      UPDATE "AttendanceUpload"
      SET "activeWeekStart" = "payrollWeekStartDate"
      WHERE "isActiveForPayrollWeek" = true AND "activeWeekStart" IS NULL
    `)

    await client.query('COMMIT')
    console.log(`Stale keys cleared on inactive rows: ${staleKeys.rowCount}`)
    for (const row of deactivated.rows) {
      console.log(`  deactivated: week ${row.weekStart}, ${row.id}, ${row.status}`)
    }
    console.log(`Duplicate active rows deactivated: ${deactivated.rowCount}`)
    console.log(`activeWeekStart filled: ${filled.rowCount}`)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

run().catch((error) => {
  console.error('Backfill failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
