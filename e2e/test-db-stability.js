/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
const { Client } = require('pg');
const connectionString = "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable&connection_limit=10&connect_timeout=0&max_idle_connection_lifetime=0&pool_timeout=0&socket_timeout=0";

async function test() {
  for (let i = 0; i < 100; i++) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      const res = await client.query('SELECT 1');
      process.stdout.write('.');
      await client.end();
    } catch (err) {
      console.error(`\nIteration ${i} failed:`, err.message);
      process.exit(1);
    }
  }
  console.log('\nSuccess!');
}

test();
