import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AttendanceUploadSession } from '@prisma/client'
import {
  createUploadSession,
  loadUploadSession,
  expireUploadSession,
  pruneExpiredSessions,
  SESSION_TTL_MS,
  type SessionDecisions,
} from './upload-session.service'
import prisma from '@/lib/prisma'

describe('upload-session.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const makeDecisions = (): SessionDecisions => ({
    verificationDecisions: { 'emp-1': 'APPROVED' },
    manualMatchDecisions: { 'Sheet1||0': 'emp-2' },
    rejectedBlockKeys: ['Sheet1||3'],
  })

  const makeSession = (overrides: Partial<AttendanceUploadSession> = {}): AttendanceUploadSession => ({
    id: 'sess-1',
    storageKey: 'attendance/uuid_x.xlsx',
    fileName: 'x.xlsx',
    fileType: 'xlsx',
    weekStart: '2026-05-04',
    weekEnd: '2026-05-10',
    weekSource: 'MANUAL',
    decisionsJson: JSON.stringify(makeDecisions()),
    pendingBlockKey: 'Sheet1||5',
    expiresAt: new Date('2026-05-11T10:30:00.000Z'),
    createdAt: new Date('2026-05-11T10:00:00.000Z'),
    ...overrides,
  })

  describe('createUploadSession', () => {
    it('creates a session with expiresAt = now + 30 minutes', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      const expectedExpiry = new Date(now.getTime() + SESSION_TTL_MS)

      const createSpy = vi
        .spyOn(prisma.attendanceUploadSession, 'create')
        .mockResolvedValue(makeSession({ expiresAt: expectedExpiry, createdAt: now }))

      vi.spyOn(prisma.attendanceUploadSession, 'deleteMany').mockResolvedValue({
        count: 0,
      })

      const result = await createUploadSession({
        storageKey: 'attendance/uuid_x.xlsx',
        fileName: 'x.xlsx',
        fileType: 'xlsx',
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        weekSource: 'MANUAL',
        decisions: makeDecisions(),
        pendingBlockKey: 'Sheet1||5',
        now,
      })

      expect(result.id).toBe('sess-1')
      expect(createSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          storageKey: 'attendance/uuid_x.xlsx',
          weekStart: '2026-05-04',
          weekSource: 'MANUAL',
          pendingBlockKey: 'Sheet1||5',
          expiresAt: expectedExpiry,
        }),
      })

      const call = createSpy.mock.calls[0][0]
      const stored = JSON.parse((call.data as { decisionsJson: string }).decisionsJson)
      expect(stored.verificationDecisions).toEqual({ 'emp-1': 'APPROVED' })
      expect(stored.manualMatchDecisions).toEqual({ 'Sheet1||0': 'emp-2' })
      expect(stored.rejectedBlockKeys).toEqual(['Sheet1||3'])
    })

    it('inline-prunes expired sessions on create (fire-and-forget)', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')

      vi.spyOn(prisma.attendanceUploadSession, 'create').mockResolvedValue(
        makeSession({ id: 'sess-1' })
      )
      const deleteManySpy = vi
        .spyOn(prisma.attendanceUploadSession, 'deleteMany')
        .mockResolvedValue({ count: 3 })

      await createUploadSession({
        storageKey: 'attendance/uuid_x.xlsx',
        fileName: 'x.xlsx',
        fileType: 'xlsx',
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        weekSource: 'MANUAL',
        decisions: makeDecisions(),
        pendingBlockKey: 'Sheet1||5',
        now,
      })

      await new Promise((r) => setImmediate(r))

      expect(deleteManySpy).toHaveBeenCalledWith({
        where: { expiresAt: { lt: now } },
      })
    })
  })

  describe('loadUploadSession', () => {
    it('returns the session with parsed decisions when not expired', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      const future = new Date(now.getTime() + 60_000)

      vi.spyOn(prisma.attendanceUploadSession, 'findUnique').mockResolvedValue(
        makeSession({ expiresAt: future, createdAt: now })
      )

      const result = await loadUploadSession('sess-1', now)

      expect(result).not.toBeNull()
      expect(result!.id).toBe('sess-1')
      expect(result!.weekSource).toBe('MANUAL')
      expect(result!.decisions.verificationDecisions).toEqual({ 'emp-1': 'APPROVED' })
      expect(result!.decisions.rejectedBlockKeys).toEqual(['Sheet1||3'])
      expect(result!.pendingBlockKey).toBe('Sheet1||5')
    })

    it('returns null when the session has expired', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      const past = new Date(now.getTime() - 60_000)

      vi.spyOn(prisma.attendanceUploadSession, 'findUnique').mockResolvedValue(
        makeSession({ decisionsJson: '{}', expiresAt: past })
      )

      const result = await loadUploadSession('sess-1', now)
      expect(result).toBeNull()
    })

    it('returns null when the session does not exist', async () => {
      vi.spyOn(prisma.attendanceUploadSession, 'findUnique').mockResolvedValue(null)
      const result = await loadUploadSession('nope')
      expect(result).toBeNull()
    })

    it('returns null when expiresAt equals now (boundary)', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      vi.spyOn(prisma.attendanceUploadSession, 'findUnique').mockResolvedValue(
        makeSession({ decisionsJson: '{}', expiresAt: now })
      )
      const result = await loadUploadSession('sess-1', now)
      expect(result).toBeNull()
    })

    it('falls back to empty decisions when decisionsJson is malformed', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      const future = new Date(now.getTime() + 60_000)

      vi.spyOn(prisma.attendanceUploadSession, 'findUnique').mockResolvedValue(
        makeSession({ decisionsJson: 'not-json', expiresAt: future, createdAt: now })
      )

      const result = await loadUploadSession('sess-1', now)
      expect(result).not.toBeNull()
      expect(result!.decisions).toEqual({
        verificationDecisions: {},
        manualMatchDecisions: {},
        rejectedBlockKeys: [],
      })
    })
  })

  describe('expireUploadSession', () => {
    it('deletes the session by id', async () => {
      const deleteSpy = vi
        .spyOn(prisma.attendanceUploadSession, 'delete')
        .mockResolvedValue(makeSession({ id: 'sess-1' }))

      await expireUploadSession('sess-1')

      expect(deleteSpy).toHaveBeenCalledWith({ where: { id: 'sess-1' } })
    })

    it('swallows errors if the session is already gone', async () => {
      vi.spyOn(prisma.attendanceUploadSession, 'delete').mockRejectedValue(
        new Error('Record not found')
      )

      await expect(expireUploadSession('missing')).resolves.toBeUndefined()
    })
  })

  describe('pruneExpiredSessions', () => {
    it('deletes all sessions whose expiresAt is before now', async () => {
      const now = new Date('2026-05-11T10:00:00.000Z')
      const deleteManySpy = vi
        .spyOn(prisma.attendanceUploadSession, 'deleteMany')
        .mockResolvedValue({ count: 5 })

      const count = await pruneExpiredSessions(now)

      expect(count).toBe(5)
      expect(deleteManySpy).toHaveBeenCalledWith({
        where: { expiresAt: { lt: now } },
      })
    })
  })
})
