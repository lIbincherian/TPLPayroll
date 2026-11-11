/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    console.log('Connecting...');
    await prisma.$connect();
    console.log('Connected.');
    
    console.log('Creating employee...');
    const emp = await prisma.employee.create({
      data: {
        employeeId: 'TEST-' + Date.now(),
        employeeName: 'Test User',
        designation: 'Tester',
        isActive: true,
      }
    });
    console.log('Created:', emp.id);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
