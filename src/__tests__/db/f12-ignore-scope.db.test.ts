// @vitest-environment node
//
// Real-database tests for "Ignore this week / Ignore every week" and "Stop ignoring". They run the real services
// against a local Postgres.
//
//   F12_TEST_DB_URL=postgres://postgres:postgres@localhost:51214/template1?sslmode=disable npx vitest run src/__tests__/db/f12-ignore-scope.db.test.ts
//
// Skipped (and reported as skipped) when F12_TEST_DB_URL is not set, so the normal unit run needs no database. The URL
// must point at localhost: these tests write rows, and refuse anything else. The schema must already be migrated
// (`prisma migrate deploy`). Rows use their own employees (TPLIGN*), eTimeOffice codes 9801-9820 and March/April 2025
// weeks, and are removed afterwards.
//
// Same limit as the other database suites: `prisma dev` serves every client through one session, so these tests
// prove the SQL, the data rules and the sequencing of each service, not that SELECT ... FOR UPDATE makes two
// concurrent writers wait for each other.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('@/features/attendance-sync/services/etimeoffice.client', () => ({ fetchPunchData: vi.fn() }))

const URL = process.env.F12_TEST_DB_URL ?? ''
const isLocal = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(URL)
const enabled = URL !== '' && isLocal

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(utc(iso).getTime() + n * 86400000).toISOString().slice(0, 10)

// Thursdays (long over, so a week can be approved on any run date).
const W = {
  a: '2025-03-06', // week-only ignores: survive a rematch, come back on a re-pull; the scheduled sync leaves it alone
  a2: '2025-04-17', // the same code in another week: untouched by an ignore in week a
  b: '2025-03-13', // an every-week ignore alone: nothing to lose, the scheduled sync replaces the week
  c1: '2025-03-20', // stop ignoring an every-week code
  c2: '2025-03-27', // ... and what a later pull of another week does
  d: '2025-04-03', // stop ignoring: where the punches go
  e: '2025-04-10', // refusals
}
const ALL_WEEKS = Object.values(W).map(utc)
// Codes these tests save exceptions for (AttendanceCodeException.empCode is unique and global).
const CODES = ['9801', '9802', '9803', '9804', '9805', '9806', '9807', '9808', '9809', '9811', '9812', '9813']

if (URL !== '' && !isLocal) {
  describe('F12 ignore scope (real database)', () => {
    it('refuses a database that is not on localhost', () => {
      throw new Error('F12_TEST_DB_URL must point at a local database (localhost or 127.0.0.1).')
    })
  })
}

describe.skipIf(!enabled)('F12 ignore scope (real database)', { timeout: 90000 }, () => {
  let prisma: PrismaClient
  let ec: typeof import('@/features/attendance-sync/services/employee-check.service')
  let syncWeek: typeof import('@/features/attendance-sync/services/sync.service').syncWeek
  let getPullWarning: typeof import('@/features/attendance-sync/services/sync.service').getPullWarning
  let fetchPunchData: ReturnType<typeof vi.fn>
  const emp: Record<string, { id: string; employeeId: string }> = {}

  function mkEmployee(employeeId: string, name: string) {
    return prisma.employee.create({
      data: {
        employeeId,
        employeeName: name,
        designation: 'Guard',
        designationShort: 'G',
        site: 'Gate',
        isActive: true,
        wageHistory: { create: { weeklySalary: 2500, hourlyRate: 62.5, effectiveFrom: utc('2025-01-01'), changeSource: 'SEED' } },
      },
    })
  }

  const scans = (code: string, date: string, times = ['08:00', '12:00']) =>
    times.map((time) => ({ empCode: code, empName: `Name${code}`, date, time, mcid: '1' }))

  /** eTimeOffice answers every pull with a pair of scans on the first day of the week for each of `codes`. */
  function serveCodes(codes: string[]) {
    fetchPunchData.mockReset()
    fetchPunchData.mockImplementation(async (week: { start: string }) => ({
      ok: true,
      punches: codes.flatMap((code) => scans(code, week.start)),
    }))
  }

  const weekRange = (start: string) => ({ start, end: addDays(start, 6) })
  const pull = (start: string) => syncWeek({ week: weekRange(start), trigger: 'MANUAL' })
  const scheduled = (start: string) => syncWeek({ week: weekRange(start), trigger: 'SCHEDULED', now: new Date() })

  const uploadOf = (start: string) =>
    prisma.attendanceUpload.findFirstOrThrow({ where: { payrollWeekStartDate: utc(start), isActiveForPayrollWeek: true } })

  const punchesOf = (start: string, code: string) =>
    prisma.attendancePunch.findMany({
      where: { empCode: code, correctionId: null, attendanceUpload: { payrollWeekStartDate: utc(start), isActiveForPayrollWeek: true } },
      orderBy: [{ punchDate: 'asc' }, { pairIndex: 'asc' }, { position: 'desc' }],
    })
  const statusesOf = async (start: string, code: string) => (await punchesOf(start, code)).map((p) => p.matchStatus)
  const exceptionOf = (code: string) => prisma.attendanceCodeException.findUnique({ where: { empCode: code } })
  const auditOf = (code: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'ATTENDANCE_CODE', detailsJson: { path: ['empCode'], equals: code } },
      orderBy: { createdAt: 'asc' },
    })

  /** Seed a week in review with two UNKNOWN punches (a pair on the first day) for each code, as a pull would leave them. */
  async function seedUnknown(start: string, codes: string[], extra: Array<Record<string, unknown>> = []) {
    const upload = await prisma.attendanceUpload.create({
      data: {
        source: 'ETIMEOFFICE',
        payrollWeekSource: 'ETIMEOFFICE',
        status: 'REVIEW',
        isActiveForPayrollWeek: true,
        activeWeekStart: utc(start),
        payrollWeekStartDate: utc(start),
        payrollWeekEndDate: utc(addDays(start, 6)),
      },
    })
    const row = (code: string, matchStatus: string, employeeId: string | null, position: string, time: string) => ({
      attendanceUploadId: upload.id,
      employeeId,
      empCode: code,
      matchStatus,
      punchDate: utc(start),
      pairIndex: 0,
      position,
      source: 'API',
      originalTime: time,
      currentTime: time,
    })
    await prisma.attendancePunch.createMany({
      data: [
        ...codes.flatMap((code) => [row(code, 'UNKNOWN', null, 'IN', '08:00'), row(code, 'UNKNOWN', null, 'OUT', '12:00')]),
        ...extra,
      ] as never,
    })
    return { upload, row }
  }

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { employeeId: { startsWith: 'TPLIGN' } }, select: { id: true } })
    const empIds = emps.map((e) => e.id)
    const uploads = await prisma.attendanceUpload.findMany({ where: { payrollWeekStartDate: { in: ALL_WEEKS } }, select: { id: true } })
    const ids = uploads.map((u) => u.id)
    await prisma.attendanceRecord.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.attendancePunch.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.attendanceEmployeeDecision.deleteMany({ where: { OR: [{ attendanceUploadId: { in: ids } }, { employeeId: { in: empIds } }] } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } })
    // Audit rows keyed by an exception id (not the upload) still name the week.
    await prisma.auditLog.deleteMany({
      where: { OR: Object.values(W).map((wk) => ({ detailsJson: { path: ['weekStart'], equals: wk } })) },
    })
    await prisma.attendanceCodeException.deleteMany({ where: { empCode: { in: CODES } } })
    await prisma.attendanceUpload.deleteMany({ where: { id: { in: ids } } })
    await prisma.employeeWageHistory.deleteMany({ where: { employeeId: { in: empIds } } })
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  }

  beforeAll(async () => {
    process.env.DIRECT_DATABASE_URL = URL
    process.env.DATABASE_URL = URL
    prisma = (await import('@/lib/prisma')).default
    ec = await import('@/features/attendance-sync/services/employee-check.service')
    ;({ syncWeek, getPullWarning } = await import('@/features/attendance-sync/services/sync.service'))
    fetchPunchData = (await import('@/features/attendance-sync/services/etimeoffice.client')).fetchPunchData as never

    await cleanup()
    emp.matched = await mkEmployee('TPLIGN9810', 'Ign Matched') // code 9810 always resolves to this employee
    emp.own = await mkEmployee('TPLIGN9805', 'Ign Own') // code 9805 resolves to this employee
    emp.dupA = await mkEmployee('TPLIGN9807', 'Ign Dup A') // code 9807 resolves to both
    emp.dupB = await mkEmployee('TPLIGNB9807', 'Ign Dup B')
    emp.always = await mkEmployee('TPLIGN9809', 'Ign Always') // code 9809 resolves to this employee
    emp.linked = await mkEmployee('TPLIGN9820', 'Ign Linked') // the target of a saved MATCH exception
  }, 60000)

  beforeEach(() => {
    fetchPunchData.mockReset()
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  }, 60000)

  // ─── 1. A week-only ignore survives a rematch ────────────────────────────────

  describe('a week-only ignore', () => {
    it('is stored on the punches only: no exception row, an audit row against the week with the scope', async () => {
      serveCodes(['9801', '9802', '9803', '9810'])
      await expect(pull(W.a)).resolves.toMatchObject({ outcome: 'LOADED', punchCount: 8 })
      expect(await statusesOf(W.a, '9801')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect(await statusesOf(W.a, '9810')).toEqual(['MATCHED', 'MATCHED'])

      await expect(ec.ignoreCode(W.a, '9801', 'WEEK')).resolves.toEqual({ ignoredPunches: 2 })
      await expect(ec.ignoreCode(W.a, '9802', 'WEEK')).resolves.toEqual({ ignoredPunches: 2 })

      expect(await statusesOf(W.a, '9801')).toEqual(['IGNORED', 'IGNORED'])
      expect((await punchesOf(W.a, '9801')).every((p) => p.employeeId === null)).toBe(true)
      expect(await exceptionOf('9801')).toBeNull()
      expect(await exceptionOf('9802')).toBeNull()
      const upload = await uploadOf(W.a)
      const [audit] = await auditOf('9801')
      expect(audit).toMatchObject({ actionType: 'UPDATE', entityType: 'ATTENDANCE_CODE', entityId: upload.id })
      expect(audit.detailsJson).toMatchObject({
        summary: 'Code 9801 ignored for this week only',
        weekStart: W.a,
        kind: 'IGNORE',
        scope: 'WEEK',
        ignoredPunches: 2,
      })
    })

    it('leaves the same code in another week to be asked about', async () => {
      serveCodes(['9802'])
      await pull(W.a2)

      expect(await statusesOf(W.a2, '9802')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect(await statusesOf(W.a, '9802')).toEqual(['IGNORED', 'IGNORED'])
    })

    it('survives rematchWeekCodes even when an employee with that number is added afterwards', async () => {
      emp.late = await mkEmployee('TPLIGN9801', 'Ign Late') // the code 9801 would now resolve to this employee

      const result = await ec.rematchWeekCodes(W.a)

      expect(result.matched).toEqual([])
      expect(result.stillUnresolved).toEqual(['9803'])
      expect(await statusesOf(W.a, '9801')).toEqual(['IGNORED', 'IGNORED'])
      expect((await punchesOf(W.a, '9801')).every((p) => p.employeeId === null)).toBe(true)
      // ... and the open code beside it was looked at: still unknown (no employee 9803).
      expect(await statusesOf(W.a, '9803')).toEqual(['UNKNOWN', 'UNKNOWN'])
    })

    it('appears in the employee check as "WEEK" and is no longer a code to fix', async () => {
      await ec.ignoreCode(W.a, '9803', 'ALWAYS')

      const check = await ec.getEmployeeCheck(W.a)

      expect(check.ignoredCodes.map((c) => [c.empCode, c.scope])).toEqual([
        ['9801', 'WEEK'],
        ['9802', 'WEEK'],
        ['9803', 'ALWAYS'],
      ])
      expect(check.codes).toEqual([])
      expect(check.complete).toBe(true)
    })

    it('counts as something a pull would discard: the pull warning lists the two week-only codes, not the every-week one', async () => {
      await expect(getPullWarning(W.a)).resolves.toEqual({ hasData: true, editedDays: 0, decisions: 0, ignoredCodes: 2 })
    })

    it('makes the scheduled sync leave the week alone: no API call, nothing replaced, stale notice set, audit says why', async () => {
      const before = await punchesOf(W.a, '9801')
      serveCodes(['9801', '9802', '9803', '9810'])

      await expect(scheduled(W.a)).resolves.toEqual({ outcome: 'SKIPPED_HAS_EDITS' })

      expect(fetchPunchData).not.toHaveBeenCalled()
      expect((await punchesOf(W.a, '9801')).map((p) => p.id)).toEqual(before.map((p) => p.id))
      expect(await statusesOf(W.a, '9801')).toEqual(['IGNORED', 'IGNORED'])
      const upload = await uploadOf(W.a)
      expect(upload.staleNoticeAt).not.toBeNull()
      expect(upload.syncLockedAt).toBeNull()
      const skips = await prisma.auditLog.findMany({ where: { entityId: upload.id, actionType: 'SYNC' } })
      expect(skips).toHaveLength(1)
      expect(skips[0].detailsJson).toMatchObject({ outcome: 'SKIPPED_HAS_EDITS', ignoredCodes: 2, editedDays: 0, decisions: 0 })
    })
  })

  // ─── 2. A re-pull brings a week-only code back and keeps an every-week one ignored ─

  describe('a manual re-pull of that week', () => {
    it('discards the week-only ignores (reported as 2), asks about those codes again, keeps the every-week code ignored', async () => {
      serveCodes(['9801', '9802', '9803', '9810'])

      const outcome = await pull(W.a)

      expect(outcome).toMatchObject({ outcome: 'LOADED', punchCount: 8 })
      if (outcome.outcome !== 'LOADED') throw new Error('expected LOADED')
      expect(outcome.discarded).toMatchObject({ editedDays: 0, decisions: 0, ignoredCodes: 2 })
      // 9802: nobody has that number, so it is back under Codes to fix. 9801: an employee has that number now, so
      // it matches (the week-only ignore was not remembered). 9803: its IGNORE exception applies again.
      expect(await statusesOf(W.a, '9802')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect(await statusesOf(W.a, '9801')).toEqual(['MATCHED', 'MATCHED'])
      expect((await punchesOf(W.a, '9801')).every((p) => p.employeeId === emp.late.id)).toBe(true)
      expect(await statusesOf(W.a, '9803')).toEqual(['IGNORED', 'IGNORED'])
      expect(await exceptionOf('9803')).toMatchObject({ kind: 'IGNORE', employeeId: null })
    })

    it('shows the code under Codes to fix and the every-week code still in the ignored list, with its scope', async () => {
      const check = await ec.getEmployeeCheck(W.a)

      expect(check.codes.map((c) => [c.empCode, c.status])).toEqual([['9802', 'UNKNOWN']])
      expect(check.ignoredCodes.map((c) => [c.empCode, c.scope])).toEqual([['9803', 'ALWAYS']])
      expect(check.complete).toBe(false)
    })

    it('the PULL audit row keeps the count of discarded ignored codes', async () => {
      const upload = await uploadOf(W.a)
      const pulls = await prisma.auditLog.findMany({ where: { entityId: upload.id, actionType: 'PULL' }, orderBy: { createdAt: 'asc' } })

      expect(pulls.at(-1)?.detailsJson).toMatchObject({ discarded: { ignoredCodes: 2 } })
    })
  })

  // ─── An every-week ignore alone loses nothing ────────────────────────────────

  describe('a week with only an every-week ignore', () => {
    it('has nothing to warn about, and the scheduled sync replaces it as usual with the code still ignored', async () => {
      serveCodes(['9813', '9810'])
      await pull(W.b)
      await ec.ignoreCode(W.b, '9813', 'ALWAYS')
      expect(await getPullWarning(W.b)).toEqual({ hasData: true, editedDays: 0, decisions: 0, ignoredCodes: 0 })
      const before = await punchesOf(W.b, '9810')

      const outcome = await scheduled(W.b)

      expect(outcome.outcome).toBe('LOADED')
      expect(fetchPunchData).toHaveBeenCalledTimes(2)
      expect((await punchesOf(W.b, '9810')).map((p) => p.id)).not.toEqual(before.map((p) => p.id)) // replaced
      expect(await statusesOf(W.b, '9813')).toEqual(['IGNORED', 'IGNORED'])
    })
  })

  // ─── 3. Stop ignoring ────────────────────────────────────────────────────────

  describe('stop ignoring a code ignored for every week', () => {
    it('deletes the exception, puts this week\'s punches back, and leaves the other week\'s as they were', async () => {
      serveCodes(['9804'])
      await pull(W.c1)
      await pull(W.c2)
      await ec.ignoreCode(W.c1, '9804', 'ALWAYS')
      // A pull of the other week while the exception exists skips the code.
      await pull(W.c2)
      expect(await statusesOf(W.c2, '9804')).toEqual(['IGNORED', 'IGNORED'])
      const exception = await exceptionOf('9804')
      expect(exception).toMatchObject({ kind: 'IGNORE' })

      const result = await ec.unignoreCode(W.c1, '9804')

      expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'UNKNOWN' } })
      expect(await exceptionOf('9804')).toBeNull()
      expect(await statusesOf(W.c1, '9804')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect(await statusesOf(W.c2, '9804')).toEqual(['IGNORED', 'IGNORED'])
      const audit = (await auditOf('9804')).at(-1)
      expect(audit).toMatchObject({ actionType: 'DELETE', entityType: 'ATTENDANCE_CODE', entityId: exception!.id })
      expect(audit?.detailsJson).toMatchObject({ undoneScope: 'ALWAYS', restoredPunches: 2, result: 'UNKNOWN', weekStart: W.c1 })
    })

    it('a later pull no longer skips the code: it is asked about again, in a scheduled and a manual pull', async () => {
      // The other week's IGNORED punches have no exception now, so they read as a week-only ignore.
      expect((await ec.getEmployeeCheck(W.c2)).ignoredCodes).toEqual([expect.objectContaining({ empCode: '9804', scope: 'WEEK' })])

      serveCodes(['9804'])
      const outcome = await pull(W.c2)

      expect(outcome).toMatchObject({ outcome: 'LOADED' })
      expect(await statusesOf(W.c2, '9804')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect(await exceptionOf('9804')).toBeNull()
      // The week that was restored is replaced by a scheduled pull too, and the code is still a code to fix.
      await expect(scheduled(W.c1)).resolves.toMatchObject({ outcome: 'LOADED' })
      expect(await statusesOf(W.c1, '9804')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect((await ec.getEmployeeCheck(W.c1)).codes.map((c) => c.empCode)).toEqual(['9804'])
    })
  })

  describe('stop ignoring: where the punches go', () => {
    let uploadId: string

    beforeAll(async () => {
      // An employee who already has a pair on the first day (under another code), so a restored pair is appended after it.
      const { upload, row } = await seedUnknown(W.d, ['9805', '9806', '9807', '9808', '9809'], [])
      uploadId = upload.id
      await prisma.attendancePunch.createMany({
        data: [row('9815', 'MATCHED', emp.own.id, 'IN', '07:00'), row('9815', 'MATCHED', emp.own.id, 'OUT', '07:30')] as never,
      })
      await ec.ignoreCode(W.d, '9805', 'WEEK')
      await ec.ignoreCode(W.d, '9806', 'WEEK')
      await ec.ignoreCode(W.d, '9807', 'WEEK')
      await ec.ignoreCode(W.d, '9808', 'WEEK')
      await ec.ignoreCode(W.d, '9809', 'ALWAYS')
    }, 60000)

    it('MATCHED by number, appended after the employee\'s own pair, with the exception state unchanged (week-only)', async () => {
      const result = await ec.unignoreCode(W.d, '9805')

      expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'MATCHED', employeeCode: 'TPLIGN9805' } })
      const rows = await punchesOf(W.d, '9805')
      expect(rows.map((p) => [p.matchStatus, p.employeeId, p.pairIndex])).toEqual([
        ['MATCHED', emp.own.id, 1],
        ['MATCHED', emp.own.id, 1],
      ])
      // The employee's own pair is not re-paired.
      expect((await punchesOf(W.d, '9815')).map((p) => p.pairIndex)).toEqual([0, 0])
      expect(await exceptionOf('9805')).toBeNull()
      expect((await auditOf('9805')).at(-1)).toMatchObject({ actionType: 'UPDATE', entityId: uploadId })
      expect((await auditOf('9805')).at(-1)?.detailsJson).toMatchObject({
        undoneScope: 'WEEK',
        result: 'MATCHED',
        employeeCode: 'TPLIGN9805',
      })
    })

    it('UNKNOWN when nobody has that number', async () => {
      await expect(ec.unignoreCode(W.d, '9806')).resolves.toEqual({ restoredPunches: 2, outcome: { status: 'UNKNOWN' } })

      expect(await statusesOf(W.d, '9806')).toEqual(['UNKNOWN', 'UNKNOWN'])
      expect((await punchesOf(W.d, '9806')).every((p) => p.employeeId === null)).toBe(true)
    })

    it('DUPLICATE when two employees have that number, and nobody is linked', async () => {
      await expect(ec.unignoreCode(W.d, '9807')).resolves.toEqual({ restoredPunches: 2, outcome: { status: 'DUPLICATE' } })

      expect(await statusesOf(W.d, '9807')).toEqual(['DUPLICATE', 'DUPLICATE'])
      expect((await punchesOf(W.d, '9807')).every((p) => p.employeeId === null)).toBe(true)
    })

    it('MATCHED through a MATCH exception the code has, which is kept (a week-only undo)', async () => {
      await prisma.attendanceCodeException.create({ data: { empCode: '9808', kind: 'MATCH', employeeId: emp.linked.id } })

      const result = await ec.unignoreCode(W.d, '9808')

      expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'MATCHED', employeeCode: 'TPLIGN9820' } })
      expect((await punchesOf(W.d, '9808')).every((p) => p.matchStatus === 'MATCHED' && p.employeeId === emp.linked.id)).toBe(true)
      expect(await exceptionOf('9808')).toMatchObject({ kind: 'MATCH', employeeId: emp.linked.id })
      expect((await auditOf('9808')).at(-1)?.detailsJson).toMatchObject({ undoneScope: 'WEEK', result: 'MATCHED' })
    })

    it('MATCHED by number after an every-week ignore, and the IGNORE exception is deleted', async () => {
      expect(await exceptionOf('9809')).toMatchObject({ kind: 'IGNORE' })

      const result = await ec.unignoreCode(W.d, '9809')

      expect(result).toEqual({ restoredPunches: 2, outcome: { status: 'MATCHED', employeeCode: 'TPLIGN9809' } })
      expect(await exceptionOf('9809')).toBeNull()
      expect((await punchesOf(W.d, '9809')).every((p) => p.matchStatus === 'MATCHED' && p.employeeId === emp.always.id)).toBe(true)
    })

    it('lists no ignored codes afterwards and the open ones as codes to fix', async () => {
      const check = await ec.getEmployeeCheck(W.d)

      expect(check.ignoredCodes).toEqual([])
      expect(check.codes.map((c) => [c.empCode, c.status])).toEqual([['9806', 'UNKNOWN'], ['9807', 'DUPLICATE']])
    })
  })

  // ─── Refusals ────────────────────────────────────────────────────────────────

  describe('refusals leave the week and the exceptions as they were', () => {
    let uploadId: string

    beforeAll(async () => {
      const { upload } = await seedUnknown(W.e, ['9811', '9812'])
      uploadId = upload.id
      await ec.ignoreCode(W.e, '9811', 'ALWAYS') // ignored for every week
    }, 60000)

    const state = async () => ({
      nine11: await statusesOf(W.e, '9811'),
      nine12: await statusesOf(W.e, '9812'),
      exceptions: (await prisma.attendanceCodeException.findMany({ where: { empCode: { in: ['9811', '9812'] } } })).map((e) => e.empCode),
      audit: (await auditOf('9811')).length + (await auditOf('9812')).length,
    })

    it('CODE_NOT_FOUND for an open code, an already-ignored code and a code that is not in the week', async () => {
      const before = await state()

      await expect(ec.unignoreCode(W.e, '9812')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
      await expect(ec.unignoreCode(W.e, '9899')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
      await expect(ec.ignoreCode(W.e, '9811', 'WEEK')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })
      await expect(ec.ignoreCode(W.e, '9899', 'ALWAYS')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' })

      expect(await state()).toEqual(before)
    })

    it('WEEK_LOCKED on an approved week, for both scopes and for stopping', async () => {
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { status: 'APPROVED', approvedAt: new Date() } })
      const before = await state()
      try {
        await expect(ec.ignoreCode(W.e, '9812', 'WEEK')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
        await expect(ec.ignoreCode(W.e, '9812', 'ALWAYS')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })
        await expect(ec.unignoreCode(W.e, '9811')).rejects.toMatchObject({ code: 'WEEK_LOCKED' })

        expect(await state()).toEqual(before)
        expect(before.exceptions).toEqual(['9811']) // the every-week exception survived the refused unignore
      } finally {
        await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { status: 'REVIEW', approvedAt: null } })
      }
    })

    it('SYNC_IN_PROGRESS while a pull holds the week; a stale lock is no obstacle', async () => {
      const before = await state()
      await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date() } })
      try {
        await expect(ec.ignoreCode(W.e, '9812', 'WEEK')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' })
        await expect(ec.unignoreCode(W.e, '9811')).rejects.toMatchObject({ code: 'SYNC_IN_PROGRESS' })
        expect(await state()).toEqual(before)
      } finally {
        await prisma.attendanceUpload.update({ where: { id: uploadId }, data: { syncLockedAt: new Date(Date.now() - 6 * 60 * 1000) } })
      }

      await expect(ec.ignoreCode(W.e, '9812', 'WEEK')).resolves.toEqual({ ignoredPunches: 2 })
      expect(await exceptionOf('9812')).toBeNull()
      await expect(ec.unignoreCode(W.e, '9812')).resolves.toMatchObject({ restoredPunches: 2, outcome: { status: 'UNKNOWN' } })
    })
  })
})
