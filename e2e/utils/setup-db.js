/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
require('dotenv').config();
const { Client } = require('pg');

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';

async function runSetup() {
  console.log(`Using connection string: ${connectionString.split('@')[1] || connectionString}`);
  let retries = 3;
  
  while (retries > 0) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
    try {
      console.log('Connecting...');
      await client.connect();
      console.log('Connected to DB for setup');
      
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
      await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
      console.log('Database truncated');

      const emp1 = await client.query(`
        INSERT INTO "Employee" ("id", "employeeId", "employeeName", "designation", "isActive", "updatedAt")
        VALUES (gen_random_uuid(), 'EMP001', 'Matched Employee', 'Worker', true, NOW())
        RETURNING id
      `);
      const emp1Id = emp1.rows[0].id;

      const emp2 = await client.query(`
        INSERT INTO "Employee" ("id", "employeeId", "employeeName", "designation", "isActive", "updatedAt")
        VALUES (gen_random_uuid(), 'EMP002', 'Inactive Employee', 'Worker', false, NOW())
        RETURNING id
      `);
      const emp2Id = emp2.rows[0].id;

      const emp3 = await client.query(`
        INSERT INTO "Employee" ("id", "employeeId", "employeeName", "designation", "isActive", "dateOfResignation", "updatedAt")
        VALUES (gen_random_uuid(), 'EMP003', 'Resigned Employee', 'Worker', true, '2025-03-01T00:00:00Z', NOW())
        RETURNING id
      `);
      const emp3Id = emp3.rows[0].id;

      const wageHistoryInsert = `
        INSERT INTO "EmployeeWageHistory" ("id", "employeeId", "weeklySalary", "hourlyRate", "effectiveFrom", "changeSource", "createdAt")
        VALUES (gen_random_uuid(), $1, 5000, 100, '2025-01-01T00:00:00Z', 'SEED', NOW())
      `;
      await client.query(wageHistoryInsert, [emp1Id]);
      await client.query(wageHistoryInsert, [emp2Id]);
      await client.query(wageHistoryInsert, [emp3Id]);

      console.log('Database seeded');
      await client.end();
      break;
    } catch (err) {
      console.error(`Setup attempt failed (retries left: ${retries - 1}):`, err);
      try { await client.end(); } catch (e) {}
      retries--;
      if (retries === 0) process.exit(1);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

runSetup();
