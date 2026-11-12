/* eslint-disable @typescript-eslint/no-require-imports */
// One-time, READ-ONLY export of the production database into e2e/prod-snapshot/ (git-ignored: it holds
// real names, bank details and pay). The local loader (scripts/seed-local-from-snapshot.js) then seeds a
// local database from it for end-to-end tests. Nothing here ever writes to production: the whole export
// runs inside a READ ONLY transaction.
//
// Usage: node scripts/export-prod-snapshot.js [envFile]   (default .env.vercel.prod)
// Reads DIRECT_DATABASE_URL from that file without loading it into process.env. Prints the target host and
// row counts, never the login.

const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { Client } = require('pg')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'e2e', 'prod-snapshot')
const SKIP_TABLES = new Set(['_prisma_migrations'])

function describeTarget(url) {
  const u = new URL(url)
  return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1)} as ${decodeURIComponent(u.username)}`
}

function serialise(value) {
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') }
  if (value instanceof Date) return value.toISOString()
  return value
}

async function run() {
  const envFile = path.resolve(ROOT, process.argv[2] || '.env.vercel.prod')
  const env = dotenv.parse(fs.readFileSync(envFile))
  const url = env.DIRECT_DATABASE_URL
  if (!url) throw new Error(`DIRECT_DATABASE_URL is not set in ${path.basename(envFile)}`)
  if (!fs.existsSync(path.join(OUT_DIR, '.gitignore'))) {
    throw new Error('e2e/prod-snapshot/.gitignore is missing; refusing to write real data where git could pick it up.')
  }
  console.log(`Source: ${describeTarget(url)} (read-only)`)

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    // Supabase's pooler certificate chains to Supabase's own CA, which Node does not trust by default (same
    // as src/lib/prisma.ts). The link is still encrypted.
    ssl: url.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  })
  await client.connect()
  // Timestamps without zone come back as the stored wall-clock text, never shifted by this machine's TZ.
  client.setTypeParser(1114, (v) => v)

  const manifest = { exportedAt: new Date().toISOString(), source: new URL(url).hostname, tables: {} }
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    )
    for (const { table_name: table } of tables) {
      if (SKIP_TABLES.has(table)) continue
      const { rows: columns } = await client.query(
        `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table],
      )
      const { rows } = await client.query(`SELECT * FROM "${table}"`)
      const data = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, serialise(v)])))
      fs.writeFileSync(path.join(OUT_DIR, `${table}.json`), JSON.stringify({ table, columns, rows: data }))
      manifest.tables[table] = rows.length
      console.log(`  ${table}: ${rows.length}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`Wrote ${Object.keys(manifest.tables).length} tables to e2e/prod-snapshot/`)
}

run().catch((error) => {
  console.error(`Export failed: ${error.message}`)
  process.exitCode = 1
})
