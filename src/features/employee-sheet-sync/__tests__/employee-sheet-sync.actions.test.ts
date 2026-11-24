// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('../services/sync.service', () => ({
  previewSheetSync: vi.fn(),
  applySheetSync: vi.fn(),
  getLastSheetSync: vi.fn(),
}))

import { revalidatePath } from 'next/cache'
import {
  applySheetSyncAction,
  getLastSheetSyncAction,
  previewSheetSyncAction,
} from '../actions/employee-sheet-sync.actions'
import { applySheetSync, getLastSheetSync, previewSheetSync } from '../services/sync.service'
import { SheetSyncError } from '../types/employee-sheet-sync.types'

const HASH = 'a'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('previewSheetSyncAction', () => {
  it('wraps the preview', async () => {
    vi.mocked(previewSheetSync).mockResolvedValue({ plan: {} as never, planHash: HASH })
    expect(await previewSheetSyncAction()).toEqual({ ok: true, data: { plan: {}, planHash: HASH } })
  })

  it('passes SheetSyncError messages and codes through', async () => {
    vi.mocked(previewSheetSync).mockRejectedValue(new SheetSyncError('SHEET_NOT_SHARED', 'Share it.'))
    expect(await previewSheetSyncAction()).toEqual({ ok: false, error: 'Share it.', code: 'SHEET_NOT_SHARED' })
  })

  it('hides unexpected error text', async () => {
    vi.mocked(previewSheetSync).mockRejectedValue(new Error('secret db url'))
    const r = await previewSheetSyncAction()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('secret')
  })
})

describe('applySheetSyncAction', () => {
  it.each(['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects hash %j with VALIDATION_ERROR before the service',
    async (planHash) => {
      const r = await applySheetSyncAction({ planHash })
      expect(r).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
      expect(applySheetSync).not.toHaveBeenCalled()
    },
  )

  it('rejects a missing planHash', async () => {
    expect(await applySheetSyncAction({} as never)).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('revalidates /employees after APPLIED', async () => {
    vi.mocked(applySheetSync).mockResolvedValue({ status: 'APPLIED', runId: 'r', report: {} as never })
    const r = await applySheetSyncAction({ planHash: HASH })
    expect(r.ok).toBe(true)
    expect(applySheetSync).toHaveBeenCalledWith(HASH)
    expect(revalidatePath).toHaveBeenCalledWith('/employees')
  })

  it('does not revalidate on STALE and returns the new plan', async () => {
    vi.mocked(applySheetSync).mockResolvedValue({ status: 'STALE', plan: {} as never, planHash: 'b'.repeat(64) })
    const r = await applySheetSyncAction({ planHash: HASH })
    expect(r).toMatchObject({ ok: true, data: { status: 'STALE' } })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('maps SYNC_DISABLED', async () => {
    vi.mocked(applySheetSync).mockRejectedValue(new SheetSyncError('SYNC_DISABLED', 'off'))
    expect(await applySheetSyncAction({ planHash: HASH })).toEqual({ ok: false, error: 'off', code: 'SYNC_DISABLED' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('getLastSheetSyncAction', () => {
  it('returns the last run, or null', async () => {
    vi.mocked(getLastSheetSync).mockResolvedValue(null)
    expect(await getLastSheetSyncAction()).toEqual({ ok: true, data: null })
  })
  it('maps failures', async () => {
    vi.mocked(getLastSheetSync).mockRejectedValue(new Error('x'))
    expect((await getLastSheetSyncAction()).ok).toBe(false)
  })
})
