/* eslint-disable @typescript-eslint/no-require-imports */
// Seeds a LOCAL database from the production snapshot in e2e/prod-snapshot/ (made by
// scripts/export-prod-snapshot.js). Refuses any database that is not on localhost, so it can never touch
// Supabase. It replaces everything in the local database's public tables.
//
// The snapshot may come from an older schema (production has not had the F12 migration yet):
//   - tables that no longer exist locally (e.g. AttendanceUploadSession) are skipped;
//   - snapshot columns that no longer exist locally are dropped;
//   - local columns missing from the snapshot take their default (e.g. AttendanceUpload.source = 'EXCEL').
// The local database must already be migrated (`prisma migrate deploy`). With --backfill it then runs the F12
// backfill scripts, which do what the F12 migration's data steps do on a real deploy, so the e2e base looks like
// production after the release. To rehearse the migration itself on this data, load the snapshot into a database
// that has only 0_init applied and run `prisma migrate deploy` (docs/ci-and-migrations.md, "Releasing F12").
//
// How it loads (fast): one `INSERT ... SELECT FROM jsonb_populate_recordset(null::"Table", $1)` per table
// (chunked for the big ones) instead of thousands of VALUES tuples with one bind parameter each. The same
// rows are then copied once into a sibling schema, `e2e_base` (--base). Restoring the base is a server-side
// INSERT ... SELECT, so a full reset to the real data takes seconds and nothing crosses the wire. `prisma dev`
// (PGlite) cannot clone a database (CREATE DATABASE ... TEMPLATE is accepted but every database name maps to
// the same one), so an in-database copy is the template mechanism that works on both PGlite and real Postgres.
//
// Usage: node scripts/seed-local-from-snapshot.js [--db <url>] [--backfill] [--base]
//   default database: DIRECT_DATABASE_URL, else DATABASE_URL, from the environment or .env
//   --base: load through the base copy (build it when it is missing or stale, then restore from it)
//
// Also exported for the e2e global setup (e2e/utils/global-setup.ts).

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const dotenv = require('dotenv')
const { Client } = require('pg')

const ROOT = path.resolve(__dirname, '..')
const SNAPSHOT_DIR = path.join(ROOT, 'e2e', 'prod-snapshot')
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const BASE_SCHEMA = 'e2e_base'
const BACKFILL_SCRIPTS = ['backfill-approved-week-start.js', 'backfill-active-week-start.js']
// Rows per INSERT. Bounded so one statement never carries more than a few MB of JSON.
const CHUNK_ROWS = 5000
// Bump when the way the base is built changes, so an old base is rebuilt.
const BASE_FORMAT = 1

function parseArgs(argv) {
  const args = { db: null, backfill: false, base: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i]
    else if (argv[i] === '--backfill') args.backfill = true
    else if (argv[i] === '--base') args.base = true
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

function snapshotAvailable() {
  return fs.existsSync(path.join(SNAPSHOT_DIR, 'manifest.json'))
}

function readManifest() {
  const manifestPath = path.join(SNAPSHOT_DIR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('No snapshot: run scripts/export-prod-snapshot.js first.')
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

/**
 * What the base was built from: the snapshot (manifest and the size of every table file), the Prisma schema
 * and the backfill scripts. The base is rebuilt when any of them changes.
 */
function baseFingerprint({ backfill }) {
  const hash = crypto.createHash('sha256')
  hash.update(`format:${BASE_FORMAT};backfill:${backfill}\n`)
  hash.update(fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma')))
  const manifestPath = path.join(SNAPSHOT_DIR, 'manifest.json')
  hash.update(fs.readFileSync(manifestPath))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const table of Object.keys(manifest.tables).sort()) {
    const file = path.join(SNAPSHOT_DIR, `${table}.json`)
    hash.update(`${table}:${fs.existsSync(file) ? fs.statSync(file).size : -1}\n`)
  }
  if (backfill) for (const script of BACKFILL_SCRIPTS) hash.update(fs.readFileSync(path.join(__dirname, script)))
  return hash.digest('hex')
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`
}

/** A snapshot value as it must appear inside the JSON the server parses (bytea is a \x hex string there). */
function toJsonValue(value) {
  if (value && typeof value === 'object' && '$bytes' in value) {
    return `\\x${Buffer.from(value.$bytes, 'base64').toString('hex')}`
  }
  return value
}

async function readLocalColumns(client, schema = 'public') {
  const { rows } = await client.query(
    `SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = $1`,
    [schema],
  )
  const columns = new Map()
  for (const r of rows) {
    if (!columns.has(r.table_name)) columns.set(r.table_name, new Map())
    columns.get(r.table_name).set(r.column_name, r)
  }
  return columns
}

async function connect(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 })
  await client.connect()
  return client
}

/**
 * Replace every public table with the snapshot. Load order does not matter: foreign keys are not checked
 * during the load (session_replication_role = replica); the data's own consistency is what the snapshot holds.
 */
async function loadSnapshotIntoPublic(client, log = console.log) {
  const manifest = readManifest()
  const localColumns = await readLocalColumns(client)

  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL session_replication_role = replica')
    const localTables = [...localColumns.keys()].filter((t) => t !== '_prisma_migrations')
    if (localTables.length) {
      await client.query(`TRUNCATE ${localTables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`)
    }

    for (const table of Object.keys(manifest.tables)) {
      const local = localColumns.get(table)
      if (!local) {
        log(`  ${table}: skipped (no longer in the local schema)`)
        continue
      }
      const snapshot = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${table}.json`), 'utf8'))
      const snapshotCols = snapshot.columns.map((c) => c.column_name)
      const cols = snapshotCols.filter((c) => local.has(c))
      const dropped = snapshotCols.filter((c) => !local.has(c))
      const defaulted = [...local.keys()].filter((c) => !snapshotCols.includes(c))
      const colList = cols.map(quoteIdent).join(', ')
      const sql = `INSERT INTO ${quoteIdent(table)} (${colList}) SELECT ${colList} FROM jsonb_populate_recordset(null::${quoteIdent(table)}, $1::jsonb)`

      for (let i = 0; i < snapshot.rows.length; i += CHUNK_ROWS) {
        const chunk = snapshot.rows.slice(i, i + CHUNK_ROWS).map((row) => {
          const out = {}
          for (const c of cols) out[c] = toJsonValue(row[c])
          return out
        })
        await client.query(sql, [JSON.stringify(chunk)])
      }
      const notes = [
        dropped.length ? `dropped ${dropped.join(', ')}` : null,
        defaulted.length ? `defaulted ${defaulted.join(', ')}` : null,
      ].filter(Boolean)
      log(`  ${table}: ${snapshot.rows.length}${notes.length ? ` (${notes.join('; ')})` : ''}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

function runBackfills(url, log = console.log) {
  const env = { ...process.env, DIRECT_DATABASE_URL: url, DATABASE_URL: url }
  for (const script of BACKFILL_SCRIPTS) {
    log(`Running ${script} on the local database`)
    execFileSync(process.execPath, [path.join(__dirname, script)], { env, stdio: 'inherit' })
  }
}

/** Copy every public table, as it is now, into the base schema and record what it was built from. */
async function saveBase(client, fingerprint) {
  const tables = [...(await readLocalColumns(client)).keys()].filter((t) => t !== '_prisma_migrations')
  await client.query('BEGIN')
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${BASE_SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${BASE_SCHEMA}`)
    for (const table of tables) {
      await client.query(`CREATE TABLE ${BASE_SCHEMA}.${quoteIdent(table)} AS TABLE public.${quoteIdent(table)}`)
    }
    await client.query(`CREATE TABLE ${BASE_SCHEMA}.meta (key text PRIMARY KEY, value text NOT NULL)`)
    await client.query(`INSERT INTO ${BASE_SCHEMA}.meta (key, value) VALUES ('fingerprint', $1), ('builtAt', $2)`, [
      fingerprint,
      new Date().toISOString(),
    ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function readBaseFingerprint(client) {
  try {
    const { rows } = await client.query(`SELECT value FROM ${BASE_SCHEMA}.meta WHERE key = 'fingerprint'`)
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}

/** Replace every public table with the base copy. The base is untouched. */
async function restoreBase(client) {
  const publicColumns = await readLocalColumns(client, 'public')
  const baseColumns = await readLocalColumns(client, BASE_SCHEMA)
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL session_replication_role = replica')
    const publicTables = [...publicColumns.keys()].filter((t) => t !== '_prisma_migrations')
    if (publicTables.length) {
      await client.query(`TRUNCATE ${publicTables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`)
    }
    for (const [table, baseCols] of baseColumns) {
      if (table === 'meta' || !publicColumns.has(table)) continue
      const cols = [...baseCols.keys()].filter((c) => publicColumns.get(table).has(c)).map(quoteIdent).join(', ')
      await client.query(
        `INSERT INTO public.${quoteIdent(table)} (${cols}) SELECT ${cols} FROM ${BASE_SCHEMA}.${quoteIdent(table)}`,
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/**
 * Put the real data in the public tables, quickly. Builds the base copy the first time (and when the snapshot,
 * schema or backfill scripts changed), then restores from it. Returns which path it took.
 */
async function loadViaBase(url, { backfill = true, log = console.log } = {}) {
  assertLocal(url)
  const client = await connect(url)
  try {
    const fingerprint = baseFingerprint({ backfill })
    if ((await readBaseFingerprint(client)) === fingerprint) {
      await restoreBase(client)
      return { path: 'restored-from-base' }
    }
    log('Building the real-data base (first run, or the snapshot or schema changed)...')
    await loadSnapshotIntoPublic(client, log)
    if (backfill) {
      // The backfill scripts open their own connection, so do not hold a transaction here.
      runBackfills(url, log)
    }
    await saveBase(client, fingerprint)
    return { path: 'built-base' }
  } finally {
    await client.end()
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const url = resolveUrl(args.db)
  const host = assertLocal(url)
  const manifest = readManifest()
  console.log(`Snapshot from ${manifest.source} at ${manifest.exportedAt}`)
  console.log(`Target: ${host}${new URL(url).port ? ':' + new URL(url).port : ''} (local)`)

  if (args.base) {
    const started = Date.now()
    const result = await loadViaBase(url, { backfill: args.backfill })
    console.log(`Done (${result.path}) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    return
  }

  const client = await connect(url)
  try {
    await loadSnapshotIntoPublic(client)
  } finally {
    await client.end()
  }
  if (args.backfill) runBackfills(url)
}

module.exports = {
  SNAPSHOT_DIR,
  BASE_SCHEMA,
  assertLocal,
  snapshotAvailable,
  readManifest,
  loadSnapshotIntoPublic,
  runBackfills,
  saveBase,
  restoreBase,
  loadViaBase,
  baseFingerprint,
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Seed failed: ${error.message}`)
    process.exitCode = 1
  })
}
