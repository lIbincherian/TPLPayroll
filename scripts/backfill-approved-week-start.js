/* eslint-disable @typescript-eslint/no-require-imports -- a plain Node script, like the other files in scripts/ */
/**
 * Backfill PayrollRun.approvedWeekStart. NOT a release step: the F12 migration
 * (prisma/migrations/*_f12_etimeoffice_attendance) runs these same steps as SQL when it is
 * deployed, so no database needs this script after that. It stays as a standalone, re-runnable
 * (idempotent) tool to check or repair a database that already has the F12 schema, and to
 * rehearse the release on a local copy of the old production data
 * (scripts/seed-local-from-snapshot.js --backfill). The DB test src/__tests__/db/f12-migration.db.test.ts
 * checks that this script and the migration give the same result.
 *
 *   node scripts/backfill-approved-week-start.js
 *
 * Uses DIRECT_DATABASE_URL (or DATABASE_URL) from the environment / .env, so check which
 * database that points at before running it. It prints the host and database name, never the
 * login.
 *
 * `approvedWeekStart` equals `payrollWeekStartDate` while the run is APPROVED or REVISED and is
 * NULL otherwise. Because it is unique and Postgres treats NULLs as distinct, that gives exactly
 * one approved run per week. Three steps, in one transaction:
 *   0. Refuse to run if a week already has two or more APPROVED/REVISED runs. They are listed and
 *      nothing is changed: pick the real run by hand first (the one whose revision is current and
 *      that has invoice snapshots), so exactly one approved run per week remains.
 *   1. A run that is not APPROVED/REVISED must not hold a key; clear any it does (defensive).
 *   2. Every APPROVED/REVISED run without a key gets one.
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

    const duplicates = await client.query(`
      SELECT "payrollWeekStartDate"::date::text AS "weekStart", array_agg(id ORDER BY "approvedAt") AS runs
      FROM "PayrollRun"
      WHERE status IN ('APPROVED', 'REVISED')
      GROUP BY 1
      HAVING count(*) > 1
    `)
    if (duplicates.rowCount > 0) {
      await client.query('ROLLBACK')
      console.error('These weeks have more than one APPROVED/REVISED payroll run:')
      for (const row of duplicates.rows) {
        console.error(`  ${row.weekStart}: ${row.runs.join(', ')}`)
      }
      console.error('Resolve by hand: exactly one APPROVED/REVISED run per week must remain. Nothing was changed.')
      process.exitCode = 1
      return
    }

    const cleared = await client.query(`
      UPDATE "PayrollRun"
      SET "approvedWeekStart" = NULL
      WHERE status NOT IN ('APPROVED', 'REVISED') AND "approvedWeekStart" IS NOT NULL
    `)

    const filled = await client.query(`
      UPDATE "PayrollRun"
      SET "approvedWeekStart" = "payrollWeekStartDate"
      WHERE status IN ('APPROVED', 'REVISED') AND "approvedWeekStart" IS NULL
    `)

    await client.query('COMMIT')
    console.log(`Weeks with several approved runs: ${duplicates.rowCount}`)
    console.log(`Stale keys cleared on runs that are not approved: ${cleared.rowCount}`)
    console.log(`approvedWeekStart filled: ${filled.rowCount}`)
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
