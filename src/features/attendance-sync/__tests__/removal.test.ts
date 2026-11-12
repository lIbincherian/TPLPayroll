// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// US-12.34 / US-12.35 / E2E-28: the Excel attendance upload is gone. These are structural checks
// on the source tree: nothing imports the removed modules, the routes and the slice no longer
// exist, and the Attendance page tree has no file input or dropzone.

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function isTestFile(file: string): boolean {
  const normalized = file.split(sep).join('/')
  return normalized.includes('/__tests__/') || /\.(test|spec)\.[tj]sx?$/.test(normalized)
}

/** Source files of the app, not its tests. Comments are removed so a note about a removed module is not a use of it. */
function appSourceFiles(): Array<{ file: string; code: string }> {
  return walk(SRC)
    .filter((file) => /\.(ts|tsx|js|jsx|mjs)$/.test(file) && !isTestFile(file))
    .map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }))
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join('/')
}

// ─── Removed modules and identifiers ──────────────────────────────────────────

const REMOVED_MODULES = [
  'workbook-parser',
  'week-detector',
  'attendance-upload-session',
  'upload-session',
  'upload.service',
  'employee-matcher',
  'file-validator',
  'import-summary',
  'features/attendance-upload',
  'attendance-upload/',
]

const REMOVED_IDENTIFIERS = [
  'AttendanceDropzone',
  'AttendancePreviewClient',
  'AttendanceUploadClient',
  'EmployeeVerificationDialog',
  'WeekSelectionDialog',
  'finalizeAttendanceUploadAction',
  'getAttendanceUploadSessionAction',
  'createAttendanceUploadSession',
  'parseWorkbook',
  'detectPayrollWeek',
]

describe('US-12.34: no code imports the removed upload modules', () => {
  const files = appSourceFiles()

  it('scans a real source tree', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(({ file }) => rel(file) === 'src/features/attendance-sync/services/sync.service.ts')).toBe(true)
  })

  it.each(REMOVED_MODULES)('no import, export or require of "%s"', (moduleName) => {
    const specifier = new RegExp(`(?:from\\s*|import\\s*\\(?\\s*|require\\s*\\(\\s*)['"][^'"]*${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^'"]*['"]`)
    const offenders = files.filter(({ code }) => specifier.test(code)).map(({ file }) => rel(file))

    expect(offenders).toEqual([])
  })

  it.each(REMOVED_IDENTIFIERS)('nothing refers to %s', (identifier) => {
    const word = new RegExp(`\\b${identifier}\\b`)
    const offenders = files.filter(({ code }) => word.test(code)).map(({ file }) => rel(file))

    expect(offenders).toEqual([])
  })

  it('no source file imports the xlsx workbook reader for attendance', () => {
    // The Excel-era week view reads rows from the database; nothing parses a workbook any more.
    const offenders = files
      .filter(({ file }) => rel(file).startsWith('src/features/attendance-sync/') || rel(file).startsWith('src/app/attendance/'))
      .filter(({ code }) => /from\s*['"]xlsx['"]/.test(code))
      .map(({ file }) => rel(file))

    expect(offenders).toEqual([])
  })
})

describe('US-12.34: the upload slice, routes and actions no longer exist', () => {
  it('removes the attendance-upload feature slice', () => {
    expect(existsSync(join(SRC, 'features', 'attendance-upload'))).toBe(false)
  })

  it('removes the upload preview route', () => {
    expect(existsSync(join(SRC, 'app', 'attendance', '[id]'))).toBe(false)
  })

  it('the attendance routes are only the week list, the employee check and the review', () => {
    const pages = walk(join(SRC, 'app', 'attendance'))
      .map((file) => relative(join(SRC, 'app', 'attendance'), file).split(sep).join('/'))
      .sort()

    expect(pages).toEqual(['[weekId]/employee-check/page.tsx', '[weekId]/review/page.tsx', 'page.tsx'])
  })

  it('no route or server action file is named for an upload', () => {
    const offenders = walk(SRC)
      .map(rel)
      .filter((file) => !isTestFile(join(ROOT, file)))
      .filter((file) => /(^|\/)(upload|uploads|upload-[^/]*|[^/]*-upload)(\/|\.|$)/i.test(file.replace('src/features/', '')))

    expect(offenders).toEqual([])
  })

  it('removes the old attendance upload tests with the code', () => {
    const leftovers = walk(SRC)
      .map(rel)
      .filter((file) => /(workbook-parser|week-detector|upload-session|upload\.service|employee-matcher|file-validator|import-summary)/.test(file))

    expect(leftovers).toEqual([])
  })
})

// ─── The Attendance page tree has no file input or dropzone ───────────────────

/** Every source file reachable from `entry` through relative and "@/" imports (not node_modules). */
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const code = stripComments(readFileSync(file, 'utf8'))
    const specifiers = [...code.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const spec of specifiers) {
      let base: string | null = null
      if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
      else if (spec.startsWith('.')) base = resolve(dirname(file), spec)
      if (!base) continue
      const found = candidates(base).find((c) => existsSync(c) && statSync(c).isFile())
      if (found) queue.push(found)
    }
  }
  return [...seen]
}

describe('US-12.34 AC1: the Attendance pages have no upload control', () => {
  const entries = [
    join(SRC, 'app', 'attendance', 'page.tsx'),
    join(SRC, 'app', 'attendance', '[weekId]', 'review', 'page.tsx'),
    join(SRC, 'app', 'attendance', '[weekId]', 'employee-check', 'page.tsx'),
  ]

  it.each(entries.map((entry) => [rel(entry), entry]))('%s reaches no file input, dropzone or drag-and-drop handler', (_name, entry) => {
    const closure = importClosure(entry)
    // The page really pulls in its feature components, so the scan is not vacuous.
    expect(closure.some((file) => rel(file).startsWith('src/features/attendance-sync/components/'))).toBe(true)

    const offenders: string[] = []
    for (const file of closure) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/type\s*=\s*\{?\s*['"]file['"]/.test(code)) offenders.push(`${rel(file)}: type="file"`)
      if (/dropzone/i.test(code)) offenders.push(`${rel(file)}: dropzone`)
      if (/\bonDrop\b|\bonDragOver\b|\bdataTransfer\b/.test(code)) offenders.push(`${rel(file)}: drag and drop`)
      if (/\bnew FileReader\b|\bsetInputFiles\b|formData\.get\(\s*['"]file['"]/.test(code)) offenders.push(`${rel(file)}: file reading`)
    }

    expect(offenders).toEqual([])
  })

  it('the Attendance page and its header offer no file or upload action', () => {
    const page = stripComments(readFileSync(entries[0], 'utf8'))
    const header = stripComments(readFileSync(join(SRC, 'features', 'attendance-sync', 'components', 'AttendancePageHeader.tsx'), 'utf8'))

    for (const code of [page, header]) {
      expect(code).not.toMatch(/upload/i)
      expect(code).not.toMatch(/type\s*=\s*['"]file['"]/)
    }
  })
})
