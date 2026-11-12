// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// e2e/prod-data/base-restore.ts puts rows back from the e2e_base copy after a real-data spec triggers a write.
// It writes to the database, so it takes the same guard as the loader and the global setup (assertLocal from
// scripts/seed-local-from-snapshot.js) BEFORE it opens a connection or runs a statement. The pg client is
// replaced here, so nothing is ever contacted.

const connections: Array<{ connectionString: string; queries: Array<{ sql: string; params?: unknown[] }>; ended: boolean }> = []
let failOn: RegExp | null = null

vi.mock('pg', () => {
  class Client {
    state: (typeof connections)[number]
    constructor(options: { connectionString: string }) {
      this.state = { connectionString: options.connectionString, queries: [], ended: false }
      connections.push(this.state)
    }
    async connect() {}
    async query(sql: string, params?: unknown[]) {
      this.state.queries.push({ sql, params })
      if (failOn && failOn.test(sql)) throw new Error('statement failed')
      return { rows: [], rowCount: 0 }
    }
    async end() {
      this.state.ended = true
    }
  }
  return { Client }
})

import { restoreRowsFromBase } from '../../../e2e/prod-data/base-restore'

const ENV_KEYS = ['DIRECT_DATABASE_URL', 'DATABASE_URL'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  connections.length = 0
  failOn = null
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const REFUSED = /Refusing to seed .*this script only writes to a local database/

describe('restoreRowsFromBase refuses any database that is not local, before it connects or runs a statement', () => {
  it.each([
    ['a Supabase pooler', 'postgresql://postgres.abc:secret@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true'],
    ['a Supabase direct host', 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres'],
    ['a private network address', 'postgres://postgres:postgres@10.0.0.5:5432/postgres'],
    ['a name that only starts with localhost', 'postgres://postgres:postgres@localhost.example.com:5432/postgres'],
    ['a name that embeds 127.0.0.1', 'postgres://postgres:postgres@127.0.0.1.nip.io:5432/postgres'],
    ['0.0.0.0', 'postgres://postgres:postgres@0.0.0.0:5432/postgres'],
  ])('%s', async (_label, url) => {
    process.env.DIRECT_DATABASE_URL = url

    await expect(restoreRowsFromBase('Settings', '"id" = $1', ['singleton'])).rejects.toThrow(REFUSED)

    expect(connections).toHaveLength(0)
  })

  it('the refusal names the host and does not repeat the password', async () => {
    process.env.DIRECT_DATABASE_URL = 'postgresql://postgres:hunter2-not-a-real-password@db.abcdefgh.supabase.co:5432/postgres'

    const error = (await restoreRowsFromBase('Settings', 'true').then(
      () => null,
      (e: unknown) => e,
    )) as Error | null

    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('db.abcdefgh.supabase.co')
    expect(error!.message).not.toContain('hunter2-not-a-real-password')
  })

  it('DIRECT_DATABASE_URL wins over DATABASE_URL: a non-local direct URL is refused even when the other one is local', async () => {
    process.env.DIRECT_DATABASE_URL = 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres'
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:51214/template1'

    await expect(restoreRowsFromBase('Settings', 'true')).rejects.toThrow(REFUSED)
    expect(connections).toHaveLength(0)
  })

  it('no URL at all is an error that says to set one, and connects to nothing', async () => {
    await expect(restoreRowsFromBase('Settings', 'true')).rejects.toThrow(/No database URL/)
    expect(connections).toHaveLength(0)
  })
})

describe('restoreRowsFromBase on a local database', () => {
  it.each([
    ['localhost', 'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable'],
    ['127.0.0.1', 'postgres://postgres:postgres@127.0.0.1:5432/postgres'],
    ['[::1]', 'postgres://postgres:postgres@[::1]:5432/postgres'],
  ])('%s: replaces the matching rows from the base copy in one transaction, with the where clause and its parameters', async (_label, url) => {
    process.env.DIRECT_DATABASE_URL = url

    await restoreRowsFromBase('Settings', '"id" = $1', ['singleton'])

    expect(connections).toHaveLength(1)
    expect(connections[0].connectionString).toBe(url)
    expect(connections[0].queries.map((q) => q.sql)).toEqual([
      'BEGIN',
      'SET LOCAL session_replication_role = replica',
      'DELETE FROM public."Settings" WHERE "id" = $1',
      'INSERT INTO public."Settings" SELECT * FROM e2e_base."Settings" WHERE "id" = $1',
      'COMMIT',
    ])
    expect(connections[0].queries[2].params).toEqual(['singleton'])
    expect(connections[0].queries[3].params).toEqual(['singleton'])
    expect(connections[0].ended).toBe(true)
  })

  it('falls back to DATABASE_URL when there is no direct URL, still only if it is local', async () => {
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:51214/template1'
    await restoreRowsFromBase('Settings', 'true')
    expect(connections).toHaveLength(1)

    process.env.DATABASE_URL = 'postgresql://postgres.abc:secret@aws-1-ap-south-1.pooler.supabase.com:6543/postgres'
    await expect(restoreRowsFromBase('Settings', 'true')).rejects.toThrow(REFUSED)
    expect(connections).toHaveLength(1)
  })

  it('a failing statement rolls the transaction back, closes the connection and rethrows', async () => {
    process.env.DIRECT_DATABASE_URL = 'postgres://postgres:postgres@localhost:51214/template1'
    failOn = /^INSERT INTO/

    await expect(restoreRowsFromBase('InvoiceSnapshot', '"payrollRunId" = $1', ['run-1'])).rejects.toThrow('statement failed')

    const sql = connections[0].queries.map((q) => q.sql)
    expect(sql).toContain('ROLLBACK')
    expect(sql).not.toContain('COMMIT')
    expect(connections[0].ended).toBe(true)
  })
})
