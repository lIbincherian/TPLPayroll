/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
const { Client } = require('pg');
require('dotenv').config();

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';

if (!connectionString) {
  console.error('Error: Neither DIRECT_DATABASE_URL nor DATABASE_URL is defined in the environment.');
  process.exit(1);
}

async function runCleanup() {
  const sanitizedConnString = connectionString.split('@')[1] || connectionString;
  console.log(`Connecting to database: ${sanitizedConnString}`);
  
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    console.log('Successfully connected to the database.');

    // SQL query to remove duplicate PENDING applications
    // Query 1: Removes absolute duplicate PENDING applications for the same week (keeping the oldest)
    const query1 = `
      DELETE FROM "PayrollAdjustmentApplication"
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY "payrollAdjustmentId", "payrollWeekStartDate"
                   ORDER BY id
                 ) AS rn
          FROM "PayrollAdjustmentApplication"
          WHERE "approvalStatus" = 'PENDING'
        ) sub
        WHERE rn > 1
      );
    `;

    // Query 2: Removes PENDING duplicate applications for weeks that already have APPROVED or SKIPPED entries
    const query2 = `
      DELETE FROM "PayrollAdjustmentApplication"
      WHERE "approvalStatus" = 'PENDING'
        AND ("payrollAdjustmentId", "payrollWeekStartDate") IN (
          SELECT "payrollAdjustmentId", "payrollWeekStartDate"
          FROM "PayrollAdjustmentApplication"
          WHERE "approvalStatus" IN ('APPROVED', 'SKIPPED')
        );
    `;

    console.log('Running Query 1: Removing duplicate PENDING applications for the same week...');
    const res1 = await client.query(query1);
    console.log(`Successfully deleted ${res1.rowCount} duplicate pending applications.`);

    console.log('Running Query 2: Removing orphan PENDING applications for processed weeks...');
    const res2 = await client.query(query2);
    console.log(`Successfully deleted ${res2.rowCount} orphan pending applications.`);
  } catch (err) {
    console.error('Error executing database cleanup:', err);
    process.exit(1);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

runCleanup();
