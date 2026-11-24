import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SheetSyncPreviewDialog } from '../components/SheetSyncPreviewDialog'
import { applySheetSyncAction, previewSheetSyncAction } from '../actions/employee-sheet-sync.actions'
import type { SyncReport } from '../types/employee-sheet-sync.types'

vi.mock('../actions/employee-sheet-sync.actions', () => ({
  previewSheetSyncAction: vi.fn(),
  applySheetSyncAction: vi.fn(),
}))

const HASH = 'a'.repeat(64)

function report(over: Partial<SyncReport> = {}): SyncReport {
  return {
    tab: 'Employee Master List',
    mode: 'FIXTURE',
    generatedAt: '2026-11-24T00:00:00.000Z',
    creates: [
      {
        rowNumber: 4,
        number: 902,
        employeeId: 'TPLGOADRV902',
        serialNumber: '902',
        fields: { employeeName: 'Joseph Mathew' },
        salary: 1000,
        isActive: true,
        wageEffectiveFrom: '2026-11-05',
        warnings: [],
      },
    ],
    updates: [
      {
        rowNumber: 6,
        employeeDbId: 'db-1',
        employeeId: 'TPLGOAMSN001',
        employeeName: 'Existing Worker',
        changes: [
          { field: 'site', old: 'Goa North', new: 'Goa South' },
          { field: 'bankAccount', old: '111122223333', new: '999988887777' },
        ],
        warnings: [],
      },
    ],
    unchangedCount: 7,
    skips: [
      { rowNumber: 3, srRaw: 'XXX', employeeIdRaw: null, name: 'Not Numbered Yet', reason: 'SR_INVALID', detail: 'Sr. must be a whole number.' },
    ],
    warnings: [{ kind: 'SALARY_MISMATCH', rowNumber: 6, employeeId: 'TPLGOAMSN001', sheet: 900, app: 800 }],
    appOnly: [{ employeeDbId: 'db-9', employeeId: 'TEST', employeeName: 'Test Person' }],
    ...over,
  }
}

const ok = (plan: SyncReport) => ({ ok: true as const, data: { plan, planHash: HASH } })

beforeEach(() => {
  vi.clearAllMocks()
})

function open(onClose = vi.fn(), onApplied = vi.fn()) {
  render(<SheetSyncPreviewDialog open onClose={onClose} onApplied={onApplied} />)
  return { onClose, onApplied }
}

describe('SheetSyncPreviewDialog', () => {
  it('does nothing while closed', () => {
    render(<SheetSyncPreviewDialog open={false} onClose={vi.fn()} onApplied={vi.fn()} />)
    expect(previewSheetSyncAction).not.toHaveBeenCalled()
  })

  it('shows loading, then the summary counts and every section', async () => {
    let resolve!: (v: ReturnType<typeof ok>) => void
    vi.mocked(previewSheetSyncAction).mockReturnValue(new Promise((r) => (resolve = r)) as never)
    open()
    expect(screen.getByTestId('sheet-sync-loading')).toBeInTheDocument()
    resolve(ok(report()))
    await screen.findByTestId('sheet-sync-summary')
    expect(screen.getByTestId('sheet-sync-created')).toHaveTextContent('1')
    expect(screen.getByTestId('sheet-sync-updated')).toHaveTextContent('1')
    expect(screen.getByTestId('sheet-sync-unchanged')).toHaveTextContent('7')
    expect(screen.getByTestId('sheet-sync-skipped')).toHaveTextContent('1')
    expect(screen.getByTestId('sheet-sync-warnings')).toHaveTextContent('1')
    for (const id of ['creates', 'updates', 'skips', 'warnings', 'app-only']) {
      expect(screen.getByTestId(`sheet-sync-section-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByText('Joseph Mathew')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-section-skips')).toHaveTextContent('Skipped rows (1)')
  })

  it('shows old and new for ordinary fields and masks sensitive ones', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report({ creates: [] })))
    open()
    await screen.findByTestId('sheet-sync-summary')
    // Field changes section is open by default when nothing is created.
    expect(await screen.findByText('Goa North')).toBeInTheDocument()
    expect(screen.getByText('Goa South')).toBeInTheDocument()
    expect(screen.queryByText('111122223333')).not.toBeInTheDocument()
    expect(screen.queryByText('999988887777')).not.toBeInTheDocument()
  })

  it('omits empty sections', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report({ skips: [], warnings: [], appOnly: [] })))
    open()
    await screen.findByTestId('sheet-sync-summary')
    expect(screen.queryByTestId('sheet-sync-section-skips')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sheet-sync-section-warnings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sheet-sync-section-app-only')).not.toBeInTheDocument()
  })

  it('shows the error and nothing-changed, with Apply unavailable, when the preview fails', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue({ ok: false, error: 'The sheet is not shared with the service account.' })
    open()
    const err = await screen.findByTestId('sheet-sync-error')
    expect(err).toHaveTextContent('not shared')
    expect(err).toHaveTextContent('Nothing was changed')
    expect(screen.getByTestId('sheet-sync-apply')).toBeDisabled()
  })

  it('shows an error when the action throws', async () => {
    vi.mocked(previewSheetSyncAction).mockRejectedValue(new Error('net'))
    open()
    expect(await screen.findByTestId('sheet-sync-error')).toHaveTextContent("Couldn't reach the server")
  })

  it('disables Apply when there is nothing to add or change', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report({ creates: [], updates: [] })))
    open()
    await screen.findByTestId('sheet-sync-nothing')
    expect(screen.getByTestId('sheet-sync-apply')).toBeDisabled()
  })

  it('apply sends the previewed hash and shows success, calling onApplied', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    vi.mocked(applySheetSyncAction).mockResolvedValue({ ok: true, data: { status: 'APPLIED', runId: 'r', report: report() } })
    const { onApplied } = open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    await screen.findByTestId('sheet-sync-success')
    expect(applySheetSyncAction).toHaveBeenCalledWith({ planHash: HASH })
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('sheet-sync-success')).toHaveTextContent('1 employee added, 1 employee updated, 1 row skipped')
    expect(screen.getByTestId('sheet-sync-done')).toBeInTheDocument()
  })

  it('disables both buttons and says Applying while the apply runs', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    let resolve!: (v: unknown) => void
    vi.mocked(applySheetSyncAction).mockReturnValue(new Promise((r) => (resolve = r)) as never)
    open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    await waitFor(() => expect(screen.getByTestId('sheet-sync-apply')).toHaveTextContent('Applying'))
    expect(screen.getByTestId('sheet-sync-apply')).toBeDisabled()
    expect(screen.getByTestId('sheet-sync-cancel')).toBeDisabled()
    resolve({ ok: true, data: { status: 'APPLIED', runId: 'r', report: report() } })
    await screen.findByTestId('sheet-sync-success')
  })

  it('STALE shows the notice with the new plan and re-applies with the new hash', async () => {
    const NEW_HASH = 'b'.repeat(64)
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    vi.mocked(applySheetSyncAction)
      .mockResolvedValueOnce({ ok: true, data: { status: 'STALE', plan: report({ unchangedCount: 99 }), planHash: NEW_HASH } })
      .mockResolvedValueOnce({ ok: true, data: { status: 'APPLIED', runId: 'r', report: report() } })
    const { onApplied } = open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    await screen.findByTestId('sheet-sync-stale')
    expect(screen.getByTestId('sheet-sync-unchanged')).toHaveTextContent('99')
    expect(onApplied).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    await screen.findByTestId('sheet-sync-success')
    expect(applySheetSyncAction).toHaveBeenLastCalledWith({ planHash: NEW_HASH })
  })

  it('an apply error is shown, keeps the preview, and allows retry', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    vi.mocked(applySheetSyncAction).mockResolvedValue({ ok: false, error: 'The sync is turned off.', code: 'SYNC_DISABLED' })
    const { onApplied } = open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    const err = await screen.findByTestId('sheet-sync-apply-error')
    expect(err).toHaveTextContent('turned off')
    expect(err).toHaveTextContent('Nothing was changed')
    expect(screen.getByTestId('sheet-sync-summary')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-apply')).not.toBeDisabled()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('apply that throws shows a network error', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    vi.mocked(applySheetSyncAction).mockRejectedValue(new Error('x'))
    open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-apply'))
    expect(await screen.findByTestId('sheet-sync-apply-error')).toHaveTextContent("Couldn't reach the server")
  })

  it('Cancel calls onClose without applying', async () => {
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report()))
    const { onClose } = open()
    await screen.findByTestId('sheet-sync-summary')
    fireEvent.click(screen.getByTestId('sheet-sync-cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(applySheetSyncAction).not.toHaveBeenCalled()
  })

  it('a large plan renders collapsible sections (not all expanded)', async () => {
    const skips = Array.from({ length: 300 }, (_, i) => ({
      rowNumber: i + 2,
      srRaw: 'X',
      employeeIdRaw: null,
      name: null,
      reason: 'SR_INVALID' as const,
    }))
    vi.mocked(previewSheetSyncAction).mockResolvedValue(ok(report({ skips })))
    open()
    await screen.findByTestId('sheet-sync-summary')
    const section = screen.getByTestId('sheet-sync-section-skips')
    expect(section).toHaveTextContent('(300)')
    // Skips are not open by default: the trigger is collapsed.
    const trigger = section.querySelector('[aria-expanded]')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })
})
