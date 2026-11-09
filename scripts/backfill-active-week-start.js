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
 * exactly one active row per week. Two steps, in one transaction:
 *   1. Weeks that already have several active rows keep only the newest (latest uploadedAt,
 *      the larger id on a tie); the others are set isActiveForPayrollWeek = false.
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
    ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  })
  await client.connect()

  try {
    await client.query('BEGIN')

    const deactivated = await client.query(`
      UPDATE "AttendanceUpload" u
      SET "isActiveForPayrollWeek" = false
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "payrollWeekStartDate"
                 ORDER BY "uploadedAt" DESC, id DESC
               ) AS position
        FROM "AttendanceUpload"
        WHERE "isActiveForPayrollWeek" = true
      ) ranked
      WHERE u.id = ranked.id AND ranked.position > 1
    `)

    const filled = await client.query(`
      UPDATE "AttendanceUpload"
      SET "activeWeekStart" = "payrollWeekStartDate"
      WHERE "isActiveForPayrollWeek" = true AND "activeWeekStart" IS NULL
    `)

    await client.query('COMMIT')
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
