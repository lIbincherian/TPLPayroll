import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'

const getEmployeeSheetSyncState = vi.hoisted(() => vi.fn())
const getLastSheetSync = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/features/settings/services/settings.service', () => ({ getEmployeeSheetSyncState }))
vi.mock('@/features/employee-sheet-sync/services/sync.service', () => ({ getLastSheetSync }))
vi.mock('@/features/employee-sheet-sync/actions/employee-sheet-sync.actions', () => ({
  previewSheetSyncAction: vi.fn(),
  applySheetSyncAction: vi.fn(),
}))
vi.mock('@/features/employee-management/actions/employee.actions', () => ({
  getEmployeeListAction: vi.fn().mockResolvedValue({ ok: true, data: { employees: [], totalCount: 0 } }),
  getDistinctDesignationsAction: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getDistinctSitesAction: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}))

import EmployeesPage from '@/app/employees/page'

const ROOT = join(__dirname, '../../../..')

beforeEach(() => {
  vi.clearAllMocks()
  getLastSheetSync.mockResolvedValue(null)
})

describe('employees page (F13)', () => {
  it('has no Import control and no Import from Excel text, sync off', async () => {
    getEmployeeSheetSyncState.mockResolvedValue({ enabled: false, firstApplied: false })
    render(await EmployeesPage())
    expect(screen.queryByText(/import/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('sheet-sync-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sheet-sync-status')).not.toBeInTheDocument()
    expect(getLastSheetSync).not.toHaveBeenCalled()
  })

  it('sync on: shows Sync from sheet and the status, still no Import', async () => {
    getEmployeeSheetSyncState.mockResolvedValue({ enabled: true, firstApplied: false })
    render(await EmployeesPage())
    expect(screen.getByTestId('sheet-sync-button')).toHaveTextContent('Sync from sheet')
    expect(screen.getByTestId('sheet-sync-status')).toBeInTheDocument()
    expect(screen.getByTestId('sheet-sync-first-note')).toBeInTheDocument()
    expect(screen.queryByText(/import/i)).not.toBeInTheDocument()
  })

  it('a failed last-run read does not break the directory', async () => {
    getEmployeeSheetSyncState.mockResolvedValue({ enabled: true, firstApplied: true })
    getLastSheetSync.mockRejectedValue(new Error('db'))
    render(await EmployeesPage())
    expect(screen.getByTestId('sheet-sync-button')).toBeInTheDocument()
    expect(screen.queryByTestId('sheet-sync-first-note')).not.toBeInTheDocument()
  })
})

describe('Excel import is removed from the tree', () => {
  it.each([
    'src/app/employees/import/preview/page.tsx',
    'src/features/employee-import-export/services/import.service.ts',
    'src/features/employee-import-export/actions/import-export.actions.ts',
    'src/features/employee-import-export/components/ImportDialog.tsx',
    'src/features/employee-import-export/components/ImportPreviewClient.tsx',
    'src/features/employee-import-export/components/FixInvalidRowDialog.tsx',
  ])('%s is gone', (rel) => {
    expect(existsSync(join(ROOT, rel))).toBe(false)
  })

  it('the export service is still there', () => {
    expect(existsSync(join(ROOT, 'src/features/employee-import-export/services/export.service.ts'))).toBe(true)
    expect(readFileSync(join(ROOT, 'src/app/employees/page.tsx'), 'utf8')).not.toMatch(/ImportDialog/)
  })
})
