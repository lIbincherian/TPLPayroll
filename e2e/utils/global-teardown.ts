import 'dotenv/config'
import { Client } from 'pg'
import { databaseUrl, fingerprintTables } from './global-setup'
import { deleteTestNamespace } from './test-data'

// Playwright global teardown: removes whatever the last spec left in the test namespace, then proves the base
// is exactly what global setup loaded, table by table (row count and a hash of every row). A spec that changed
// or deleted a real row, or wrote one outside the namespace, fails the run here instead of passing quietly.

export default async function globalTeardown(): Promise<void> {
  const baseline = process.env.E2E_BASE_FINGERPRINT
  if (!baseline) return // setup did not finish; there is nothing to compare with

  const client = new Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 15000 })
  await client.connect()
  try {
    await deleteTestNamespace((sql, params) => client.query(sql, params), {
      reservedFrom: process.env.E2E_RESERVED_FROM,
      auditSince: process.env.E2E_RUN_STARTED_AT,
    })
    const expected = JSON.parse(baseline) as Record<string, string>
    const actual = await fingerprintTables(client)

    const changed = Object.keys({ ...expected, ...actual })
      .filter((table) => expected[table] !== actual[table])
      .map((table) => `${table}: ${expected[table] ?? 'absent'} -> ${actual[table] ?? 'absent'}`)
    if (changed.length > 0) {
      throw new Error(`The e2e base data was changed by the run (table: count:hash before -> after):\n  - ${changed.join('\n  - ')}`)
    }
    console.log(`[e2e teardown] base intact: ${Object.keys(actual).length} tables match the state the run started from`)
  } finally {
    await client.end()
  }
}
