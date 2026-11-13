// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ default: { auditLog: { findMany: vi.fn() } } }))

import prisma from '@/lib/prisma'
import { getWeekStatusChanges } from '@/features/attendance-sync/services/status-changes.service'

const findMany = vi.mocked(prisma.auditLog.findMany)
const row = (entityId: string, employeeId: string, employeeName: string, to: boolean) => ({
  entityId,
  detailsJson: { changeSource: 'AUTO_ATTENDANCE', employeeId, employeeName, isActive: { from: !to, to } },
})

beforeEach(() => {
  findMany.mockReset()
})

describe('getWeekStatusChanges', () => {
  it("reads every AUTO_ATTENDANCE row for the week, so a re-approval that changed nobody keeps the list", async () => {
    findMany.mockResolvedValue([
      row('emp-7', 'TPLGOAHLP007', 'Ravi Kumar', false),
      row('emp-8', 'TPLGOAHLP008', 'Asha Rao', true),
    ] as never)

    await expect(getWeekStatusChanges('2026-11-05')).resolves.toEqual({
      markedInactive: [{ id: 'emp-7', employeeId: 'TPLGOAHLP007', employeeName: 'Ravi Kumar' }],
      reactivated: [{ id: 'emp-8', employeeId: 'TPLGOAHLP008', employeeName: 'Asha Rao' }],
    })
    expect(findMany).toHaveBeenCalledWith({
      where: {
        entityType: 'EMPLOYEE',
        AND: [
          { detailsJson: { path: ['changeSource'], equals: 'AUTO_ATTENDANCE' } },
          { detailsJson: { path: ['weekStart'], equals: '2026-11-05' } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { entityId: true, detailsJson: true },
    })
  })

  it("counts an employee changed twice once, by the latest change", async () => {
    findMany.mockResolvedValue([
      row('emp-7', 'TPLGOAHLP007', 'Ravi Kumar', false),
      row('emp-7', 'TPLGOAHLP007', 'Ravi Kumar', true),
    ] as never)

    await expect(getWeekStatusChanges('2026-11-05')).resolves.toEqual({
      markedInactive: [],
      reactivated: [{ id: 'emp-7', employeeId: 'TPLGOAHLP007', employeeName: 'Ravi Kumar' }],
    })
  })

  it('returns empty lists when nothing changed', async () => {
    findMany.mockResolvedValue([])

    await expect(getWeekStatusChanges('2026-11-05')).resolves.toEqual({ markedInactive: [], reactivated: [] })
  })
})
