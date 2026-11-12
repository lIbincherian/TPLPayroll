// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// Round 3, item 12: the three places that connect to Supabase skip certificate-chain verification
// (the pooler's certificate chains to Supabase's own CA, which Node does not trust by default). The
// choice is kept, but it must be written down where it is made, and it must stay limited to Supabase
// hosts. Source assertions: nothing here opens a connection.

const ROOT = path.resolve(__dirname, '../../../..')

const FILES = [
  { name: 'scripts/backfill-active-week-start.js', refersTo: /src\/lib\/prisma\.ts/ },
  { name: 'scripts/backfill-approved-week-start.js', refersTo: /src\/lib\/prisma\.ts/ },
  { name: 'src/lib/prisma.ts', refersTo: /scripts\/backfill-\*\.js/ },
]

const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

/** The comment lines directly above the `ssl:` line, without the leading `//`, joined into one string. */
function commentAboveSsl(source: string): { comment: string; sslLine: string; lineAbove: string } {
  const lines = source.split(/\r?\n/)
  const at = lines.findIndex((line) => /^\s*ssl:/.test(line))
  expect(at, 'an `ssl:` line').toBeGreaterThan(0)
  const block: string[] = []
  for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) block.unshift(lines[i].replace(/^\s*\/\/\s?/, '').trim())
  return { comment: block.join(' '), sslLine: lines[at].trim(), lineAbove: lines[at - 1] }
}

describe.each(FILES)('$name', ({ name, refersTo }) => {
  const source = read(name)

  it('has exactly one `ssl:` option', () => {
    expect(source.split(/\r?\n/).filter((line) => /^\s*ssl:/.test(line))).toHaveLength(1)
  })

  it('explains, directly above the `ssl:` line, why chain verification is off', () => {
    const { comment, lineAbove } = commentAboveSsl(source)

    expect(lineAbove.trim().startsWith('//'), 'the comment must touch the ssl line').toBe(true)
    expect(comment).toContain("Supabase's pooler certificate chains to Supabase's own CA")
    expect(comment).toContain('which Node does not trust by default')
    expect(comment).toContain('chain verification is off')
    expect(comment).toContain('The link is still encrypted')
  })

  it('says how to turn verification on: ship the CA from the dashboard, and change every connection site together', () => {
    const { comment } = commentAboveSsl(source)

    expect(comment).toContain('To verify, ship the CA from the Supabase dashboard')
    expect(comment).toContain('{ ca, rejectUnauthorized: true }')
    expect(comment).toMatch(/together\.?$/)
  })

  it('points at the other connection sites', () => {
    expect(commentAboveSsl(source).comment).toMatch(refersTo)
  })

  it('turns verification off only for Supabase hosts, and leaves the default (verified) otherwise', () => {
    const { sslLine } = commentAboveSsl(source)

    expect(sslLine).toMatch(/^ssl: connectionString\.includes\('supabase'\) \? \{ rejectUnauthorized: false \} : undefined,?$/)
  })

  it('has no other place that turns certificate verification off', () => {
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')

    expect(code.match(/rejectUnauthorized\s*:\s*false/g) ?? []).toHaveLength(1)
    expect(code).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
    expect(code).not.toMatch(/checkServerIdentity/)
  })
})

describe('the app and its backfill scripts', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) return entry === '__tests__' || entry === 'node_modules' ? [] : sourceFiles(full)
      return /\.(ts|tsx|js)$/.test(entry) && !/\.test\./.test(entry) ? [full] : []
    })
  }

  it('never switch certificate verification off process-wide (NODE_TLS_REJECT_UNAUTHORIZED) in application source', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src')).filter((file) => /NODE_TLS_REJECT_UNAUTHORIZED/.test(readFileSync(file, 'utf8')))

    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([])
  })

  it('never switch it off in the F12 backfill scripts either', () => {
    for (const name of ['scripts/backfill-active-week-start.js', 'scripts/backfill-approved-week-start.js']) {
      expect(read(name), name).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
    }
  })
})
