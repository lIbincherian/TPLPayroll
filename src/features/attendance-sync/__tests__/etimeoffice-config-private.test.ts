// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import * as client from '../services/etimeoffice.client'

// getEtimeofficeConfig returns the eTimeOffice login. It is module-private: the `server-only` package that would
// stop a client bundle importing this module is not installed, so the only protection is that nothing outside
// the file can ask for the login. The module's whole public surface is two functions that return no login.

const ROOT = path.resolve(__dirname, '../../../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx)$/.test(full) ? [full] : []
  })
}

describe('etimeoffice.client public surface', () => {
  it('exports exactly fetchPunchData and isMockEtimeofficeEnabled', () => {
    expect(Object.keys(client).sort()).toEqual(['fetchPunchData', 'isMockEtimeofficeEnabled'])
  })

  it('does not export the configuration reader, under any spelling', () => {
    expect('getEtimeofficeConfig' in client).toBe(false)
    expect(Object.keys(client).filter((name) => /config|login|credential|password/i.test(name))).toEqual([])
  })

  it('isMockEtimeofficeEnabled answers a boolean and nothing else', () => {
    expect(typeof client.isMockEtimeofficeEnabled()).toBe('boolean')
  })

  it('the source declares the reader and its type without `export`', () => {
    const source = readFileSync(path.join(SRC, 'features/attendance-sync/services/etimeoffice.client.ts'), 'utf8')

    expect(source).toMatch(/^function getEtimeofficeConfig\(\)/m)
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+getEtimeofficeConfig/)
    expect(source).not.toMatch(/export\s+type\s+EtimeofficeConfig/)
    expect(source).not.toMatch(/export\s*\{[^}]*getEtimeofficeConfig/)
  })

  it('no other file in the application or its tests refers to the reader', () => {
    const offenders = walk(SRC)
      .filter((file) => file !== __filename)
      .filter((file) => !file.endsWith(path.join('services', 'etimeoffice.client.ts')))
      .filter((file) => /getEtimeofficeConfig/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))

    expect(offenders).toEqual([])
  })
})
