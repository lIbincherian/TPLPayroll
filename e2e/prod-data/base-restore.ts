import { Client } from 'pg'

// The real-data specs only read. A few of the app's read paths still write (the settings page upserts its row,
// the slips download rebuilds a run's invoice snapshots). The base copy that global setup keeps in the
// `e2e_base` schema is exact, so a spec that triggers such a write puts the rows back from it afterwards, and
// the global teardown can still prove the base is untouched.

function localUrl(): string {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('No database URL')
  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`Refusing to write to ${host}: not local`)
  return url
}

/** Replace the rows of `table` matching `where` with the base copy's rows. `where` uses $1, $2, ... */
export async function restoreRowsFromBase(table: string, where: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: localUrl(), connectionTimeoutMillis: 15000 })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(`DELETE FROM public."${table}" WHERE ${where}`, params)
    await client.query(`INSERT INTO public."${table}" SELECT * FROM e2e_base."${table}" WHERE ${where}`, params)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}
