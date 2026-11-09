// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { API_FETCH_TIMEOUT_MS, SYNC_LOCK_TTL_MS } from '@/features/attendance-sync/lib/constants'
import {
  getEtimeofficeConfig,
  isMockEtimeofficeEnabled,
} from '@/features/attendance-sync/services/etimeoffice.client'

// Fix round, items 8 and 9: house rules as tests.
//  8a. Only etimeoffice.client.ts reads ETIMEOFFICE_* (the mock route asks the client whether it may answer).
//  8b. The week calendar belongs to the attendance-sync feature, not to the shared UI folder.
//  9a. The routes that run a pull allow 120 s: longer than the API timeout plus the save transaction,
//      shorter than the sync lock TTL, so a running pull never loses its lock.
//  9b. attendance-sync never imports payroll-correction (lint).

const ROOT = path.resolve(__dirname, '../../../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full, accept)
    return accept(full) ? [full] : []
  })
}

const isSource = (file: string) => /\.(ts|tsx)$/.test(file)
const isTest = (file: string) => /(\.test\.|\.spec\.)/.test(file) || file.split(path.sep).includes('__tests__')
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

afterEach(() => vi.unstubAllEnvs())

// ─── 8a ───────────────────────────────────────────────────────────────────────

describe('item 8a: ETIMEOFFICE_* is read in one place', () => {
  it('only etimeoffice.client.ts mentions ETIMEOFFICE_ in the application source (tests excluded)', () => {
    const matches = walk(SRC, (file) => isSource(file) && !isTest(file))
      .filter((file) => readFileSync(file, 'utf8').includes('ETIMEOFFICE_'))
      .map(rel)

    expect(matches).toEqual(['src/features/attendance-sync/services/etimeoffice.client.ts'])
  })

  it('no other source file reads these variables through process.env, in any spelling', () => {
    const offenders = walk(SRC, (file) => isSource(file) && !isTest(file) && !file.endsWith('etimeoffice.client.ts'))
      .filter((file) => /process\.env\.ETIMEOFFICE|process\.env\[\s*['"`]ETIMEOFFICE/.test(readFileSync(file, 'utf8')))
      .map(rel)

    expect(offenders).toEqual([])
  })

  it('the mock route takes its on/off decision from the client, and has no process.env read of its own', () => {
    const route = readFileSync(
      path.join(SRC, 'app/api/mock-etimeoffice/DownloadPunchDataMCID/route.ts'),
      'utf8',
    )

    expect(route).toContain('isMockEtimeofficeEnabled')
    expect(route).not.toMatch(/process\.env\.VERCEL/)
    expect(route).not.toMatch(/process\.env\.ETIMEOFFICE/)
  })

  describe('isMockEtimeofficeEnabled()', () => {
    const unset = (name: string) => vi.stubEnv(name, undefined as unknown as string)

    it('is true only in MOCK mode: no corporate id and not on Vercel', () => {
      unset('ETIMEOFFICE_CORPORATE_ID')
      unset('VERCEL')
      expect(getEtimeofficeConfig().mode).toBe('MOCK')
      expect(isMockEtimeofficeEnabled()).toBe(true)
    })

    it('is false on Vercel even without a corporate id (production never falls back to the mock)', () => {
      unset('ETIMEOFFICE_CORPORATE_ID')
      vi.stubEnv('VERCEL', '1')
      expect(isMockEtimeofficeEnabled()).toBe(false)
    })

    it('is false with a full login (LIVE)', () => {
      vi.stubEnv('ETIMEOFFICE_CORPORATE_ID', 'corp')
      vi.stubEnv('ETIMEOFFICE_USERNAME', 'user')
      vi.stubEnv('ETIMEOFFICE_PASSWORD', 'secret')
      unset('VERCEL')
      expect(getEtimeofficeConfig().mode).toBe('LIVE')
      expect(isMockEtimeofficeEnabled()).toBe(false)
    })

    it('is false with only part of a login (MISSING)', () => {
      vi.stubEnv('ETIMEOFFICE_CORPORATE_ID', 'corp')
      unset('ETIMEOFFICE_USERNAME')
      unset('ETIMEOFFICE_PASSWORD')
      unset('VERCEL')
      expect(getEtimeofficeConfig().mode).toBe('MISSING')
      expect(isMockEtimeofficeEnabled()).toBe(false)
    })
  })
})

// ─── 8b ───────────────────────────────────────────────────────────────────────

describe('item 8b: the week calendar lives in the attendance-sync feature', () => {
  it('the component is in features/attendance-sync/components and no longer in components/ui', () => {
    expect(existsSync(path.join(SRC, 'features/attendance-sync/components/WeekCalendar.tsx'))).toBe(true)
    expect(existsSync(path.join(SRC, 'components/ui/week-calendar.tsx'))).toBe(false)
  })

  it('nothing imports the old location', () => {
    const offenders = walk(SRC, isSource)
      .filter((file) => file !== __filename) // this file quotes the old path
      .filter((file) => /components\/ui\/week-calendar/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('the past-week picker imports it from its own feature', () => {
    const picker = readFileSync(path.join(SRC, 'features/attendance-sync/components/LoadPastWeekPicker.tsx'), 'utf8')
    expect(picker).toMatch(/from ['"]\.\/WeekCalendar['"]/)
  })
})

// ─── 9a ───────────────────────────────────────────────────────────────────────

describe('item 9a: maxDuration of the routes that run a pull', () => {
  const TRANSACTION_TIMEOUT_MS = 30000
  const FLOOR_MS = API_FETCH_TIMEOUT_MS + TRANSACTION_TIMEOUT_MS

  /** Next reads this at build time, so it has to be a numeric literal in the file. */
  function declaredMaxDuration(file: string): number | null {
    const match = /^export const maxDuration = (\d+)\s*$/m.exec(readFileSync(file, 'utf8'))
    return match ? Number(match[1]) : null
  }

  const pullRoutes = [
    'src/app/api/cron/attendance-sync/route.ts',
    'src/app/attendance/page.tsx',
  ]

  it.each(pullRoutes)('%s declares maxDuration as a numeric literal', (file) => {
    expect(declaredMaxDuration(path.join(ROOT, file))).not.toBeNull()
  })

  it.each(pullRoutes)('%s: longer than the API timeout plus the save transaction', (file) => {
    const seconds = declaredMaxDuration(path.join(ROOT, file))!
    expect(seconds * 1000).toBeGreaterThan(FLOOR_MS)
  })

  it.each(pullRoutes)('%s: shorter than the sync lock TTL, so a running pull never loses its lock', (file) => {
    const seconds = declaredMaxDuration(path.join(ROOT, file))!
    expect(seconds * 1000).toBeLessThan(SYNC_LOCK_TTL_MS)
  })

  it.each(pullRoutes)('%s is exactly 120 seconds', (file) => {
    expect(declaredMaxDuration(path.join(ROOT, file))).toBe(120)
  })

  it('every page that renders the week list (the only caller of the pull action) declares it', () => {
    const hosts = walk(path.join(SRC, 'app'), isSource)
      .filter((file) => /AttendanceWeekList/.test(readFileSync(file, 'utf8')))
      .map(rel)
      .sort()
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) expect(declaredMaxDuration(path.join(ROOT, host)), host).not.toBeNull()
  })

  it('the constants behind the bounds: 45 s API timeout, 300 s lock TTL', () => {
    expect(API_FETCH_TIMEOUT_MS).toBe(45000)
    expect(SYNC_LOCK_TTL_MS).toBe(300000)
    expect(FLOOR_MS).toBeLessThan(120 * 1000)
  })

  it('vercel.json sets no function duration that could override the route segment config', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as {
      functions?: Record<string, { maxDuration?: number }>
    }
    for (const [pattern, fn] of Object.entries(config.functions ?? {})) {
      if (fn.maxDuration !== undefined) {
        expect(fn.maxDuration * 1000, pattern).toBeGreaterThan(FLOOR_MS)
        expect(fn.maxDuration * 1000, pattern).toBeLessThan(SYNC_LOCK_TTL_MS)
      }
    }
  })
})

// ─── 9b ───────────────────────────────────────────────────────────────────────

describe('item 9b: attendance-sync does not import payroll-correction', () => {
  it('no source file of the feature (tests included) imports it', () => {
    const offenders = walk(path.join(SRC, 'features/attendance-sync'), isSource)
      .filter((file) => file !== __filename) // this file quotes forbidden imports as lint fixtures
      .filter((file) => /from\s+['"][^'"]*payroll-correction[^'"]*['"]|import\(\s*['"][^'"]*payroll-correction/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  // ESLint loads the whole Next config on first use, which is slow when the suite runs in parallel.
  describe('the lint rule', { timeout: 60000 }, () => {
    // One ESLint instance for the repo's own flat config; the file paths are virtual (never written).
    const eslint = new ESLint({ cwd: ROOT })

    async function lint(code: string, filePath = 'src/features/attendance-sync/components/Zz.tsx') {
      const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) })
      return result.messages.filter((m) => m.ruleId === 'no-restricted-imports')
    }

    const COMPONENT = (importLine: string) => `${importLine}\nexport const Zz = () => null\n`

    it('flags an absolute import of a payroll-correction module', async () => {
      const found = await lint(
        COMPONENT("import { approveCorrectionPunchesAction } from '@/features/payroll-correction/actions/correction.actions'"),
      )
      expect(found).toHaveLength(1)
      expect(found[0].severity).toBe(2)
      expect(found[0].message).toContain('attendance-sync must not import payroll-correction')
    })

    it('flags a service import and a relative path to it', async () => {
      expect(
        await lint(COMPONENT("import { getActiveCorrection } from '@/features/payroll-correction/services/correction.service'")),
      ).toHaveLength(1)
      expect(
        await lint(COMPONENT("import { abandonCorrectionAction } from '../../payroll-correction/actions/correction.actions'")),
      ).toHaveLength(1)
    })

    it('flags a type import and a dynamic-looking re-export as well', async () => {
      expect(
        await lint(COMPONENT("import type { CorrectionSessionInfo } from '@/features/payroll-correction/types/correction.types'")),
      ).toHaveLength(1)
      expect(
        await lint("export { approveRevision } from '@/features/payroll-correction/services/correction.service'\n"),
      ).toHaveLength(1)
    })

    it('flags it in a service file and in a test file of the feature too', async () => {
      const line = "import { approveRevision } from '@/features/payroll-correction/services/correction.service'\nexport const x = approveRevision\n"
      expect(await lint(line, 'src/features/attendance-sync/services/zz.service.ts')).toHaveLength(1)
      expect(await lint(line, 'src/features/attendance-sync/__tests__/zz.test.ts')).toHaveLength(1)
    })

    it('does not flag imports of other features or of the feature\'s own modules', async () => {
      expect(await lint(COMPONENT("import { skipAdjustmentApplication } from '@/features/payroll-adjustments/services/adjustment.service'"))).toEqual([])
      expect(await lint(COMPONENT("import { plural } from '../lib/format'"))).toEqual([])
    })

    it('does not restrict payroll-correction importing attendance-sync (the allowed direction)', async () => {
      const line = "import { getPunchReview } from '@/features/attendance-sync/services/punch-review.service'\nexport const x = getPunchReview\n"
      expect(await lint(line, 'src/features/payroll-correction/services/zz.service.ts')).toEqual([])
    })

    it('does not restrict pages importing payroll-correction (they inject the actions)', async () => {
      const line = "import { approveCorrectionPunchesAction } from '@/features/payroll-correction/actions/correction.actions'\nexport const x = approveCorrectionPunchesAction\n"
      expect(await lint(line, 'src/app/payroll/run/[payrollRunId]/correct/punches/page.tsx')).toEqual([])
    })
  })
})
