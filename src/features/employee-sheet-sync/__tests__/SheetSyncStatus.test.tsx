import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SheetSyncStatus } from '../components/SheetSyncStatus'
import type { LastSheetSync } from '../types/employee-sheet-sync.types'

const base: LastSheetSync = {
  runId: 'r',
  at: '2026-11-24T10:00:00.000Z',
  trigger: 'MANUAL',
  status: 'APPLIED',
  created: 2,
  updated: 3,
  skipped: 1,
  warnings: 0,
  skips: [],
}

describe('SheetSyncStatus', () => {
  it('before any run: says not synced and shows the first-apply note', () => {
    render(<SheetSyncStatus last={null} firstApplied={false} />)
    expect(screen.getByText('The sheet has not been synced yet.')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-first-note')).toHaveTextContent('The nightly sync starts after the first Apply.')
  })

  it('after first apply: no first-apply note', () => {
    render(<SheetSyncStatus last={base} firstApplied />)
    expect(screen.queryByTestId('sheet-sync-first-note')).not.toBeInTheDocument()
  })

  it('shows manual run counts', () => {
    render(<SheetSyncStatus last={base} firstApplied />)
    expect(screen.getByText('Last synced')).toBeInTheDocument()
    expect(screen.getByText(/manual/)).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-last-counts')).toHaveTextContent('2 added, 3 updated, 1 skipped')
  })

  it('shows nightly label and pluralised warnings', () => {
    render(<SheetSyncStatus last={{ ...base, trigger: 'SCHEDULED', warnings: 1 }} firstApplied />)
    expect(screen.getByText(/nightly/)).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-last-counts')).toHaveTextContent('1 warning')
    expect(screen.getByTestId('sheet-sync-last-counts')).not.toHaveTextContent('1 warnings')
  })

  it('shows a failed run with its error and no counts', () => {
    render(<SheetSyncStatus last={{ ...base, status: 'FAILED', error: 'Google Sheets access isn’t configured.' }} firstApplied />)
    expect(screen.getByText('Last sync failed')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-last-error')).toHaveTextContent('configured')
    expect(screen.queryByTestId('sheet-sync-last-counts')).not.toBeInTheDocument()
  })

  it('lists skipped rows in an expandable section only when there are some', () => {
    const { rerender } = render(<SheetSyncStatus last={base} firstApplied />)
    expect(screen.queryByTestId('sheet-sync-skips')).not.toBeInTheDocument()
    rerender(
      <SheetSyncStatus
        firstApplied
        last={{
          ...base,
          skips: [{ rowNumber: 9, srRaw: 'XXX', employeeIdRaw: null, name: 'Someone', reason: 'SR_INVALID' }],
        }}
      />,
    )
    const details = screen.getByTestId('sheet-sync-skips')
    expect(details.tagName).toBe('DETAILS')
    expect(details).toHaveTextContent('Skipped rows (1)')
    expect(details).toHaveTextContent('Row 9')
    expect(details).toHaveTextContent('Someone')
  })
})
