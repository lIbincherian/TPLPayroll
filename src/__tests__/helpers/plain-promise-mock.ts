import type { Mock } from 'vitest'

/**
 * Prisma delegate methods (`prisma.employee.update`, ...) return PrismaPromise /
 * Prisma__XClient wrappers, which a plain async mock implementation cannot satisfy
 * structurally. The code under test only awaits them, so these mocks hand back a plain
 * promise; this helper types the mock accordingly. It is a type-level view only: it returns
 * the very same mock function.
 */
export function plainPromiseMock(fn: unknown): Mock<(args: unknown) => Promise<unknown>> {
  return fn as Mock<(args: unknown) => Promise<unknown>>
}
