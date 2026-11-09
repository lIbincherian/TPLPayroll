// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// The Prisma pool is small (max 2), and these writers hold a row lock for the whole interactive
// transaction. A query on the global client inside a transaction callback needs a SECOND connection;
// under load that stalls until the pool frees up, and on a one-connection database it never does.
// So inside `prisma.$transaction(async (tx) => { ... })` only `tx` may be used.

const SRC = path.resolve(__dirname, '../../..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

/** Blank out comments and string/template literals so braces and `prisma.` inside them do not count. */
function stripNoise(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') out += (code[i++], ' ')
    } else if (c === '/' && next === '*') {
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) out += code[i++] === '\n' ? '\n' : ' '
      out += '  '
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        // Keep `${ ... }` of template literals: code inside it still runs.
        if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
          let depth = 0
          while (i < code.length) {
            out += code[i]
            if (code[i] === '{') depth++
            if (code[i] === '}' && --depth === 0) break
            i++
          }
          i++
          continue
        }
        out += code[i] === '\n' ? '\n' : ' '
        i++
      }
      out += ' '
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The bodies of every `$transaction(async (x) => { ... })` callback in a file. */
function transactionBodies(code: string): Array<{ client: string; body: string; line: number }> {
  const clean = stripNoise(code)
  const found: Array<{ client: string; body: string; line: number }> = []
  const opener = /\$transaction\(\s*async\s*\(\s*(\w+)\s*\)\s*=>\s*\{/g
  for (let m = opener.exec(clean); m; m = opener.exec(clean)) {
    let depth = 1
    let end = opener.lastIndex
    while (end < clean.length && depth > 0) {
      if (clean[end] === '{') depth++
      else if (clean[end] === '}') depth--
      end++
    }
    found.push({
      client: m[1],
      body: clean.slice(opener.lastIndex, end - 1),
      line: clean.slice(0, m.index).split('\n').length,
    })
  }
  return found
}

describe('interactive transactions use only their own client', () => {
  const files = walk(SRC)
  const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/')

  it('finds the transactions this test is about (the scan is not vacuous)', () => {
    const withTransactions = files
      .map((file) => ({ file: rel(file), count: transactionBodies(readFileSync(file, 'utf8')).length }))
      .filter((f) => f.count > 0)
      .map((f) => f.file)

    expect(withTransactions).toEqual(
      expect.arrayContaining([
        'features/attendance-sync/services/punch-review.service.ts',
        'features/attendance-sync/services/week-approval.service.ts',
        'features/attendance-sync/services/sync.service.ts',
        'features/payroll-correction/services/correction.service.ts',
        'features/payroll-generation/services/payroll.service.ts',
      ]),
    )
  })

  it('the scanner sees a global-client call inside a transaction (self check)', () => {
    const bad = `await prisma.$transaction(async (tx) => {\n  await tx.a.update({})\n  const x = await prisma.b.findMany()\n})`
    const [body] = transactionBodies(bad)
    expect(body.body).toMatch(/\bprisma\./)
    const fine = `await prisma.$transaction(async (tx) => {\n  // prisma.b is not used here\n  const s = 'prisma.c'\n  await tx.a.update({})\n})`
    expect(transactionBodies(fine)[0].body).not.toMatch(/\bprisma\./)
  })

  it('no transaction callback in the application reads or writes through the global client', () => {
    const offenders: string[] = []
    for (const file of files) {
      for (const tx of transactionBodies(readFileSync(file, 'utf8'))) {
        const uses = [...tx.body.matchAll(/\bprisma\.\w+/g)].map((m) => m[0])
        if (uses.length > 0) offenders.push(`${rel(file)}:${tx.line} uses ${[...new Set(uses)].join(', ')} inside $transaction(async (${tx.client}) => ...)`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every transaction callback in the fix-round services names its client tx', () => {
    for (const name of [
      'features/attendance-sync/services/punch-review.service.ts',
      'features/attendance-sync/services/week-approval.service.ts',
      'features/attendance-sync/services/sync.service.ts',
      'features/payroll-correction/services/correction.service.ts',
      'features/payroll-generation/services/payroll.service.ts',
    ]) {
      const clients = transactionBodies(readFileSync(path.join(SRC, name), 'utf8')).map((t) => t.client)
      expect(clients.length, name).toBeGreaterThan(0)
      expect(new Set(clients), name).toEqual(new Set(['tx']))
    }
  })
})
