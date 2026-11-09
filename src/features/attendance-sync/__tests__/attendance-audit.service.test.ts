// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', async () => ({ default: (await import('./service-fixtures')).buildDb() }))

import prisma from '@/lib/prisma'
import { auditEntry } from '@/features/attendance-sync/services/attendance-audit.service'
import { resetDb, type Db } from './service-fixtures'

const db = prisma as unknown as Db

beforeEach(() => resetDb(db))

describe('auditEntry', () => {
  const entry = {
    actionType: 'UPDATE' as const,
    entityType: 'ATTENDANCE_PUNCH' as const,
    entityId: 'punch-1',
    details: { summary: 'Changed OUT 17:47 to 18:00', old: { time: '17:47' }, new: { time: '18:00' } },
  }

  it('builds an auditLog.create operation on the default client', () => {
    const op = auditEntry(entry)

    expect(op).toBeDefined()
    expect(db.auditLog.create).toHaveBeenCalledTimes(1)
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        actionType: 'UPDATE',
        entityType: 'ATTENDANCE_PUNCH',
        entityId: 'punch-1',
        detailsJson: entry.details,
      },
    })
  })

  it('writes through the transaction client when one is passed, not the default client', () => {
    auditEntry(entry, db.tx as never)

    expect(db.tx.auditLog.create).toHaveBeenCalledTimes(1)
    expect(db.auditLog.create).not.toHaveBeenCalled()
  })

  it('records no user (logins are out of scope) and no timestamp of its own (createdAt is the column default)', () => {
    auditEntry(entry)

    const { data } = db.auditLog.create.mock.calls[0][0]
    expect(Object.keys(data).sort()).toEqual(['actionType', 'detailsJson', 'entityId', 'entityType'])
  })

  it.each([
    ['SYNC', 'ATTENDANCE_WEEK'],
    ['PULL', 'ATTENDANCE_WEEK'],
    ['APPROVE', 'ATTENDANCE_WEEK'],
    ['REOPEN', 'ATTENDANCE_WEEK'],
    ['DISCARD', 'ATTENDANCE_WEEK'],
    ['CREATE', 'ATTENDANCE_DECISION'],
    ['UPDATE', 'ATTENDANCE_CODE'],
    ['DELETE', 'ATTENDANCE_PUNCH'],
  ] as const)('passes the %s / %s pair through unchanged', (actionType, entityType) => {
    auditEntry({ actionType, entityType, entityId: 'x', details: { summary: 's' } })

    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ actionType, entityType })
  })

  it('returns whatever the client returns, so it can sit in a $transaction array', async () => {
    db.auditLog.create.mockReturnValue(Promise.resolve({ id: 'audit-77' }))

    await expect(auditEntry(entry)).resolves.toEqual({ id: 'audit-77' })
  })
})
