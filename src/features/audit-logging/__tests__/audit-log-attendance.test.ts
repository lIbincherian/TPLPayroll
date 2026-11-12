// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// US-12.21 AC2/AC3: getAuditLogs and the /api/audit-logs route accept the attendance entity
// and action types, and filter to them.

vi.mock('@/lib/prisma', () => ({
  default: {
    auditLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import prisma from '@/lib/prisma'
import { getAuditLogs } from '@/features/audit-logging/services/audit-log.service'
import { GET } from '@/app/api/audit-logs/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.auditLog.count).mockResolvedValue(0)
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never)
})

describe('getAuditLogs — attendance entries', () => {
  it.each(['ATTENDANCE_WEEK', 'ATTENDANCE_PUNCH', 'ATTENDANCE_DECISION', 'ATTENDANCE_CODE'] as const)(
    'filters by entityType %s, for both the rows and the count',
    async (entityType) => {
      await getAuditLogs({ entityType })

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { entityType } }))
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: { entityType } })
    },
  )

  it.each(['SYNC', 'PULL', 'APPROVE', 'REOPEN', 'DISCARD', 'DELETE'] as const)('filters by actionType %s', async (actionType) => {
    await getAuditLogs({ actionType })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { actionType } }))
  })

  it('combines an attendance entity with an action', async () => {
    await getAuditLogs({ entityType: 'ATTENDANCE_WEEK', actionType: 'DISCARD' })

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: 'ATTENDANCE_WEEK', actionType: 'DISCARD' } }),
    )
  })

  it('returns attendance rows as they are stored, with their summary and createdAt', async () => {
    const createdAt = new Date('2026-11-12T00:30:00Z')
    vi.mocked(prisma.auditLog.count).mockResolvedValue(1)
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
      {
        id: 'log-1',
        actionType: 'UPDATE',
        entityType: 'ATTENDANCE_PUNCH',
        entityId: 'punch-1',
        detailsJson: { summary: 'Edited 17:47 to 18:00', old: { time: '17:47' }, new: { time: '18:00' } },
        createdAt,
      },
    ] as never)

    const result = await getAuditLogs({ entityType: 'ATTENDANCE_PUNCH' })

    expect(result.totalCount).toBe(1)
    expect(result.logs[0]).toMatchObject({
      entityType: 'ATTENDANCE_PUNCH',
      createdAt,
      detailsJson: { summary: 'Edited 17:47 to 18:00', old: { time: '17:47' }, new: { time: '18:00' } },
    })
  })
})

describe('GET /api/audit-logs — attendance filters', () => {
  function get(query: string) {
    return GET(new NextRequest(`http://localhost/api/audit-logs${query}`))
  }

  it('passes an attendance entityType and an action through to the service', async () => {
    const response = await get('?entityType=ATTENDANCE_DECISION&actionType=CREATE&page=2&limit=10')

    expect(response.status).toBe(200)
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: 'ATTENDANCE_DECISION', actionType: 'CREATE' }, skip: 10, take: 10 }),
    )
  })

  it('applies no filter when none is given', async () => {
    await get('')

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, skip: 0, take: 20 }))
  })

  it('answers 500 with an error body when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(prisma.auditLog.count).mockRejectedValue(new Error('db down'))

    const response = await get('?entityType=ATTENDANCE_WEEK')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch audit logs' })
  })
})
