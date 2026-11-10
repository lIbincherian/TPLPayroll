/* eslint-disable @typescript-eslint/no-require-imports */
// Seeds a LOCAL database from the production snapshot in e2e/prod-snapshot/ (made by
// scripts/export-prod-snapshot.js). Refuses any database that is not on localhost, so it can never touch
// Supabase. It replaces everything in the local database's public tables.
//
// The snapshot may come from an older schema (production has not had the F12 `prisma db push` yet):
//   - tables that no longer exist locally (e.g. AttendanceUploadSession) are skipped;
//   - snapshot columns that no longer exist locally are dropped;
//   - local columns missing from the snapshot take their default (e.g. AttendanceUpload.source = 'EXCEL').
// With --backfill it then runs the F12 backfill scripts against the same local database, which rehearses the
// production release on real data.
//
// Usage: node scripts/seed-local-from-snapshot.js [--db <url>] [--backfill]
//   default database: DIRECT_DATABASE_URL, else DATABASE_URL, from the environment or .env

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const dotenv = require('dotenv')
const { Client } = require('pg')

const ROOT = path.resolve(__dirname, '..')
const SNAPSHOT_DIR = path.join(ROOT, 'e2e', 'prod-snapshot')
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const BATCH = 500

function parseArgs(argv) {
  const args = { db: null, backfill: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i]
    else if (argv[i] === '--backfill') args.backfill = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return args
}

function resolveUrl(explicit) {
  if (explicit) return explicit
  const fromFile = fs.existsSync(path.join(ROOT, '.env')) ? dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'))) : {}
  return process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || fromFile.DIRECT_DATABASE_URL || fromFile.DATABASE_URL
}

function assertLocal(url) {
  if (!url) throw new Error('No database URL. Pass --db or set DIRECT_DATABASE_URL / DATABASE_URL.')
  const host = new URL(url).hostname
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to seed ${host}: this script only writes to a local database.`)
  }
  return host
}

function toDbValue(value, column) {
  if (value === null || value === undefined) return null
  if (value && typeof value === 'object' && '$bytes' in value) return Buffer.from(value.$bytes, 'base64')
  if (column.udt_name === 'json' || column.udt_name === 'jsonb') return JSON.stringify(value)
  return value
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const url = resolveUrl(args.db)
  const host = assertLocal(url)
  const manifestPath = path.join(SNAPSHOT_DIR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('No snapshot: run scripts/export-prod-snapshot.js first.')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  console.log(`Snapshot from ${manifest.source} at ${manifest.exportedAt}`)
  console.log(`Target: ${host}${new URL(url).port ? ':' + new URL(url).port : ''} (local)`)

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 })
  await client.connect()
  try {
    const { rows: colRows } = await client.query(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public'`,
    )
    const localColumns = new Map()
    for (const r of colRows) {
      if (!localColumns.has(r.table_name)) localColumns.set(r.table_name, new Map())
      localColumns.get(r.table_name).set(r.column_name, r)
    }

    await client.query('BEGIN')
    // Load in any order: foreign keys are checked by the data's own consistency, not insert order.
    await client.query('SET LOCAL session_replication_role = replica')
    const localTables = [...localColumns.keys()].filter((t) => t !== '_prisma_migrations')
    if (localTables.length) {
      await client.query(`TRUNCATE ${localTables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
    }

    for (const table of Object.keys(manifest.tables)) {
      const local = localColumns.get(table)
      if (!local) {
        console.log(`  ${table}: skipped (no longer in the local schema)`)
        continue
      }
      const snapshot = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${table}.json`), 'utf8'))
      const snapshotCols = snapshot.columns.map((c) => c.column_name)
      const cols = snapshotCols.filter((c) => local.has(c))
      const dropped = snapshotCols.filter((c) => !local.has(c))
      const defaulted = [...local.keys()].filter((c) => !snapshotCols.includes(c))
      for (let i = 0; i < snapshot.rows.length; i += BATCH) {
        const chunk = snapshot.rows.slice(i, i + BATCH)
        const params = []
        const tuples = chunk.map((row) => {
          const placeholders = cols.map((c) => {
            params.push(toDbValue(row[c], local.get(c)))
            return `$${params.length}`
          })
          return `(${placeholders.join(', ')})`
        })
        await client.query(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(', ')}`,
          params,
        )
      }
      const notes = [
        dropped.length ? `dropped ${dropped.join(', ')}` : null,
        defaulted.length ? `defaulted ${defaulted.join(', ')}` : null,
      ].filter(Boolean)
      console.log(`  ${table}: ${snapshot.rows.length}${notes.length ? ` (${notes.join('; ')})` : ''}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }

  if (args.backfill) {
    const env = { ...process.env, DIRECT_DATABASE_URL: url, DATABASE_URL: url }
    for (const script of ['backfill-approved-week-start.js', 'backfill-active-week-start.js']) {
      console.log(`Running ${script} on the local database`)
      execFileSync(process.execPath, [path.join(__dirname, script)], { env, stdio: 'inherit' })
    }
  }
}

run().catch((error) => {
  console.error(`Seed failed: ${error.message}`)
  process.exitCode = 1
})
