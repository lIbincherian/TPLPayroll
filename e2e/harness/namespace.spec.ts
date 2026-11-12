import { test, expect } from '@playwright/test'
import prisma, { cleanupTestData, createEmployee, isTestWeek, seedApiWeek, seedEmployeesForSync } from '../utils/db'
import { mockDay } from '../utils/etimeoffice-mock'
import { PRE_HISTORY_END, testCode, testEmployeeId } from '../utils/test-namespace'

// The layered e2e setup itself: the test namespace keeps spec data and real data apart. These run on any base
// (empty or real) because they plant their own stand-in for a real row.

const SENTINEL = 'REAL-STAND-IN-1' // outside the namespace: what a real employee's row looks like to cleanup

test.afterEach(async () => {
  // Never leave the stand-in behind, even if an assertion failed
  await prisma.employeeWageHistory.deleteMany({ where: { employee: { employeeId: SENTINEL } } })
  await prisma.employee.deleteMany({ where: { employeeId: SENTINEL } })
})

test('cleanup deletes the test namespace and leaves every row outside it', async () => {
  await cleanupTestData()
  const stand = await prisma.employee.create({
    data: {
      employeeId: SENTINEL,
      employeeName: 'Stand In',
      designation: 'Worker',
      wageHistory: { create: { weeklySalary: 1, hourlyRate: 1, effectiveFrom: new Date('2026-01-01T00:00:00Z'), changeSource: 'SEED' } },
    },
  })
  await seedEmployeesForSync()
  expect(await prisma.employee.count({ where: { employeeId: { startsWith: 'E2E-' } } })).toBeGreaterThan(0)

  await cleanupTestData()

  expect(await prisma.employee.count({ where: { employeeId: { startsWith: 'E2E-' } } })).toBe(0)
  expect(await prisma.employee.findUnique({ where: { id: stand.id } })).not.toBeNull()
  expect(await prisma.employeeWageHistory.count({ where: { employeeId: stand.id } })).toBe(1)
})

test('a seed refuses a week inside the real data and an employee ID outside the namespace', async () => {
  await cleanupTestData()
  const worker = await createEmployee({ employeeId: testEmployeeId('HLP', 1), employeeName: 'Seed Worker' })
  const employees = [{ id: worker.id, employeeId: worker.employeeId, employeeName: worker.employeeName }]
  const days = [Array(7).fill({ reg: 8, ot: 0 })]

  // 2026-06-04 is a Thursday in the middle of the real data's range
  await expect(seedApiWeek({ weekStartISO: '2026-06-04', employees, days })).rejects.toThrow(/inside the real data/)
  // the same week in the pre-history zone, a reserved week and the far future are fine
  expect(isTestWeek('2025-06-05')).toBe(true)
  expect(isTestWeek(PRE_HISTORY_END)).toBe(false)
  expect(isTestWeek('2040-01-05')).toBe(true)

  await expect(createEmployee({ employeeId: 'TPLGOAHLP036', employeeName: 'Not Allowed' })).rejects.toThrow(/outside the test namespace/)
  await cleanupTestData()
})

test('the mock punch builders only emit codes in the test range', async () => {
  expect(testCode(1)).toBe('9001')
  expect(mockDay(testCode(36), '2026-01-01', ['08:00'])[0].Empcode).toBe('9036')
  expect(() => mockDay('0036', '2026-01-01', ['08:00'])).toThrow(/outside the test range/)
  expect(() => mockDay('1000', '2026-01-01', ['08:00'])).toThrow(/outside the test range/)
})
