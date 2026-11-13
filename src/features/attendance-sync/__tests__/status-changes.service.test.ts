// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ default: { auditLog: { findFirst: vi.fn() } } }))

import prisma from '@/lib/prisma'
import { getLatestStatusChanges } from '@/features/attendance-sync/services/status-changes.service'

const findFirst = vi.mocked(prisma.auditLog.findFirst)
const person = { id: 'emp-7', employeeId: 'TPLGOAHLP007', employeeName: 'Ravi Kumar' }

beforeEach(() => {
  findFirst.mockReset()
})

describe('getLatestStatusChanges', () => {
  it("reads the week's latest LOADED sync or pull entry", async () => {
    findFirst.mockResolvedValue({ detailsJson: { statusChanges: { markedInactive: [person], reactivated: [] } } } as never)

    await expect(getLatestStatusChanges('upload-1')).resolves.toEqual({ markedInactive: [person], reactivated: [] })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        entityType: 'ATTENDANCE_WEEK',
        entityId: 'upload-1',
        actionType: { in: ['SYNC', 'PULL'] },
        detailsJson: { path: ['outcome'], equals: 'LOADED' },
      },
      orderBy: { createdAt: 'desc' },
      select: { detailsJson: true },
    })
  })

  it('returns empty lists when the week has no loaded entry', async () => {
    findFirst.mockResolvedValue(null)

    await expect(getLatestStatusChanges('upload-1')).resolves.toEqual({ markedInactive: [], reactivated: [] })
  })

  it('returns empty lists for an older entry written before statusChanges existed', async () => {
    findFirst.mockResolvedValue({ detailsJson: { outcome: 'LOADED', punchCount: 4 } } as never)

    await expect(getLatestStatusChanges('upload-1')).resolves.toEqual({ markedInactive: [], reactivated: [] })
  })
})
