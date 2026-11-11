'use client'

import { useState, useEffect, useTransition, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  SpinnerGap,
  CheckCircle,
  ArrowsClockwise,
  XCircle,
  WarningCircle,
  UsersThree,
  ArrowSquareOut,
} from '@phosphor-icons/react'
import { executeImportAction } from '@/features/employee-import-export/actions/import-export.actions'
import { FixInvalidRowDialog } from './FixInvalidRowDialog'
import type {
  ParseImportResult,
  ValidImportRow,
  InvalidImportRow,
  DuplicateImportRow,
  ExecuteImportResult,
} from '@/features/employee-import-export/types/import-export.types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredPreviewData {
  parseResult: ParseImportResult
  fileBase64: string
  fileName: string
}

type TabKey = 'valid' | 'invalid' | 'duplicates'

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBlock({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className="px-6 first:pl-0 last:pr-0">
      <p className="text-xs uppercase tracking-wider text-zinc-400 mb-1">{label}</p>
      <p
        className={[
          'text-lg font-mono tabular-nums font-semibold',
          highlight ? 'text-rose-600' : 'text-zinc-900',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  )
}

function ActionBadge({ action }: { action: 'CREATE' | 'UPDATE' }) {
  return (
    <span
      className={[
        'inline-block rounded-full text-xs px-2 py-0.5 font-medium',
        action === 'CREATE'
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-sky-50 text-sky-700',
      ].join(' ')}
    >
      {action === 'CREATE' ? 'Create' : 'Update'}
    </span>
  )
}

function ValidRowsTable({ rows }: { rows: ValidImportRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <UsersThree size={36} className="text-zinc-200" />
        <p className="text-sm text-zinc-500">No valid rows found.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Row
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Emp ID
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Designation
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Action
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row) => (
            <tr key={row.rowNumber}>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-400">{row.rowNumber}</span>
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-500">{row.data.employeeId}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-sm text-zinc-900">{row.data.employeeName}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-sm text-zinc-600">{row.data.designation}</span>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <ActionBadge action={row.action} />
                  {row.source === 'fixed' && (
                    <span className="inline-block bg-emerald-50 text-emerald-700 rounded-full text-xs px-2 py-0.5 font-medium">
                      Fixed ✓
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InvalidRowsTable({
  rows,
  onFixRow,
}: {
  rows: InvalidImportRow[]
  onFixRow: (row: InvalidImportRow) => void
}) {
  const errorLabels: Record<string, string> = {
    MISSING_EMPLOYEE_ID: 'Missing Employee ID',
    MISSING_EMPLOYEE_NAME: 'Missing Employee Name',
    MISSING_DESIGNATION: 'Missing Designation',
    MISSING_SALARY: 'Missing Salary',
    MISSING_HOURLY_RATE: 'Missing Hourly Rate',
    MISSING_ACTIVE: 'Missing Active value',
    INVALID_SALARY: 'Invalid Salary value',
    INVALID_HOURLY_RATE: 'Invalid Hourly Rate value',
    INVALID_ACTIVE_VALUE: 'Invalid Active value',
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <CheckCircle size={20} className="text-emerald-400 mx-auto" />
        <p className="text-sm text-zinc-400">All invalid rows have been corrected.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Row
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Emp ID
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Errors
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Fix
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row) => (
            <tr key={row.rowNumber}>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-400">{row.rowNumber}</span>
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-400">{row.employeeId ?? '—'}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-sm text-zinc-600">{row.employeeName ?? '—'}</span>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  {row.errors.map((e) => (
                    <span key={e} className="text-xs text-rose-600">{errorLabels[e] ?? e}</span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => onFixRow(row)}
                  className="inline-flex items-center gap-1 text-xs font-medium border border-zinc-200 rounded-lg px-2.5 py-1 text-zinc-600 hover:border-emerald-400 hover:text-emerald-700 transition-colors"
                >
                  Fix
                  <ArrowSquareOut size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DuplicatesTable({ rows }: { rows: DuplicateImportRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <CheckCircle size={36} className="text-emerald-300" />
        <p className="text-sm text-zinc-500">No duplicate Employee IDs found.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Row
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Emp ID
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Note
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row) => (
            <tr key={row.rowNumber}>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-400">{row.rowNumber}</span>
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-zinc-500">{row.employeeId}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-xs text-amber-600">
                  Duplicate ID — will be applied sequentially; last write wins
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Import Result Dialog ────────────────────────────────────────────────────

function ImportResultDialog({
  result,
  onClose,
}: {
  result: ExecuteImportResult
  onClose: () => void
}) {
  const router = useRouter()

  return (
    <>
      <div className="dialog-backdrop fixed inset-0 z-40 bg-zinc-950/40 backdrop-blur-sm" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="dialog-enter w-full max-w-sm rounded-2xl bg-white border border-zinc-200/60 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.08)] p-6">
          <div className="flex items-start justify-between mb-5">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900">Import Complete</h2>
          </div>

          <ul className="space-y-3">
            <li className="flex items-center gap-2">
              <CheckCircle size={16} className="text-emerald-500 shrink-0" />
              <span className="text-sm text-zinc-700">
                <span className="font-mono font-medium">{result.createdEmployeeCount}</span>{' '}
                {result.createdEmployeeCount === 1 ? 'employee' : 'employees'} created
              </span>
            </li>
            <li className="flex items-center gap-2">
              <ArrowsClockwise size={16} className="text-sky-500 shrink-0" />
              <span className="text-sm text-zinc-700">
                <span className="font-mono font-medium">{result.updatedEmployeeCount}</span>{' '}
                {result.updatedEmployeeCount === 1 ? 'employee' : 'employees'} updated
              </span>
            </li>
            {result.rejectedRowCount > 0 && (
              <li className="flex items-center gap-2">
                <XCircle size={16} className="text-rose-500 shrink-0" />
                <span className="text-sm text-zinc-700">
                  <span className="font-mono font-medium">{result.rejectedRowCount}</span>{' '}
                  {result.rejectedRowCount === 1 ? 'row' : 'rows'} rejected
                </span>
              </li>
            )}
            {result.duplicateEmployeeIdRowCount > 0 && (
              <li className="flex items-center gap-2">
                <WarningCircle size={16} className="text-amber-500 shrink-0" />
                <span className="text-sm text-zinc-700">
                  <span className="font-mono font-medium">{result.duplicateEmployeeIdRowCount}</span>{' '}
                  duplicate {result.duplicateEmployeeIdRowCount === 1 ? 'row' : 'rows'} processed
                </span>
              </li>
            )}
          </ul>

          <p className="text-xs text-zinc-400 mt-4">Source file has been deleted.</p>

          <div className="pt-5">
            <button
              onClick={() => {
                onClose()
                router.push('/employees')
              }}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2.5 rounded-xl transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
            >
              View Employees
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ImportPreviewClient() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [previewData, setPreviewData] = useState<StoredPreviewData | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('valid')
  const [importResult, setImportResult] = useState<ExecuteImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // Lifted row state
  const [validRows, setValidRows] = useState<ValidImportRow[]>([])
  const [invalidRows, setInvalidRows] = useState<InvalidImportRow[]>([])
  const [fixingRow, setFixingRow] = useState<InvalidImportRow | null>(null)
  const [existingEmployeeIds, setExistingEmployeeIds] = useState<Set<string>>(new Set())

  // Load data from sessionStorage on mount
  useEffect(() => {
    const raw = sessionStorage.getItem('importPreviewData')
    if (!raw) {
      router.replace('/employees')
      return
    }
    try {
      const data = JSON.parse(raw) as StoredPreviewData
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is browser-only, so the stored preview can only be hydrated after mount
      setPreviewData(data)
      setValidRows(data.parseResult.validRows)
      setInvalidRows(data.parseResult.invalidRows)
      // Build existingEmployeeIds from validRows that have action=UPDATE
      const updateIds = new Set(
        data.parseResult.validRows
          .filter((r) => r.action === 'UPDATE')
          .map((r) => r.data.employeeId)
      )
      setExistingEmployeeIds(updateIds)
    } catch {
      router.replace('/employees')
    }
  }, [router])

  const handleRowFixed = useCallback((fixedRow: ValidImportRow) => {
    setInvalidRows((prev) => prev.filter((r) => r.rowNumber !== fixedRow.rowNumber))
    setValidRows((prev) => [...prev, fixedRow])
    setFixingRow(null)
    // If the fixed row is an UPDATE, add to existingEmployeeIds for future fixes
    if (fixedRow.action === 'UPDATE') {
      setExistingEmployeeIds((prev) => new Set([...prev, fixedRow.data.employeeId]))
    }
  }, [])

  const handleConfirm = useCallback(() => {
    if (!previewData) return
    setImportError(null)

    const fixedRows = validRows.filter((r) => r.source === 'fixed')

    startTransition(async () => {
      const result = await executeImportAction(previewData.fileBase64, previewData.fileName, fixedRows)
      if (!result.ok) {
        setImportError(result.error)
        return
      }
      sessionStorage.removeItem('importPreviewData')
      setImportResult(result.data)
    })
  }, [previewData, validRows])

  const handleCancel = useCallback(() => {
    sessionStorage.removeItem('importPreviewData')
    router.push('/employees')
  }, [router])

  if (!previewData) {
    return (
      <div className="flex items-center justify-center py-32">
        <SpinnerGap size={28} className="text-zinc-300 animate-spin" />
      </div>
    )
  }

  const { parseResult, fileName } = previewData
  const newCount = validRows.filter((r) => r.action === 'CREATE').length
  const updateCount = validRows.filter((r) => r.action === 'UPDATE').length

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'valid', label: 'Valid Rows', count: validRows.length },
    { key: 'invalid', label: 'Invalid Rows', count: invalidRows.length },
    { key: 'duplicates', label: 'Duplicates', count: parseResult.duplicateIdRows.length },
  ]

  return (
    <>
      <div className="space-y-6">
        {/* ── Back + title ────────────────────────────────────────────── */}
        <div>
          <button
            onClick={handleCancel}
            className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 transition-colors mb-4"
          >
            <ArrowLeft size={16} />
            Back to directory
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Import Preview</h1>
          <p className="text-sm text-zinc-500 mt-1 font-mono">{fileName}</p>
        </div>

        {/* ── Summary strip ───────────────────────────────────────────── */}
        <div className="border-t border-b border-zinc-200/60 py-4 flex items-center divide-x divide-zinc-200 overflow-x-auto">
          <StatBlock label="Total Rows" value={parseResult.totalRows} />
          <StatBlock label="Valid" value={validRows.length} />
          <StatBlock label="Invalid" value={invalidRows.length} highlight={invalidRows.length > 0} />
          <StatBlock label="Duplicates" value={parseResult.duplicateIdRows.length} />
          <StatBlock label="New" value={newCount} />
          <StatBlock label="Updates" value={updateCount} />
        </div>

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div className="border-b border-zinc-200/60">
          <nav className="flex items-center gap-0" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={[
                  'px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px',
                  activeTab === tab.key
                    ? 'border-emerald-500 text-emerald-700'
                    : 'border-transparent text-zinc-400 hover:text-zinc-600',
                ].join(' ')}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span
                    className={[
                      'ml-2 text-xs font-mono rounded-full px-1.5 py-0.5',
                      activeTab === tab.key
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-zinc-100 text-zinc-500',
                    ].join(' ')}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* ── Tab content ─────────────────────────────────────────────── */}
        {/* key={activeTab} re-mounts on tab change → replays the step-enter fade-slide */}
        <div role="tabpanel" key={activeTab} className="step-enter">
          {activeTab === 'valid' && (
            <ValidRowsTable rows={validRows} />
          )}
          {activeTab === 'invalid' && (
            <InvalidRowsTable
              rows={invalidRows}
              onFixRow={setFixingRow}
            />
          )}
          {activeTab === 'duplicates' && <DuplicatesTable rows={parseResult.duplicateIdRows} />}
        </div>

        {/* ── Error ───────────────────────────────────────────────────── */}
        {importError && (
          <div className="flex items-start gap-2 text-rose-600">
            <WarningCircle size={16} className="shrink-0 mt-0.5" />
            <p className="text-sm">{importError}</p>
          </div>
        )}

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={handleCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-zinc-700 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50"
          >
            Cancel Import
          </button>
          <button
            onClick={handleConfirm}
            disabled={isPending || validRows.length === 0}
            className="relative inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-xl transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] overflow-hidden"
          >
            {isPending ? (
              <>
                <SpinnerGap size={16} className="animate-spin shrink-0" />
                Importing…
                <span className="absolute inset-0 -translate-x-full animate-[button-sweep_1.2s_linear_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              </>
            ) : (
              `Confirm Import (${validRows.length + parseResult.duplicateIdRows.length} rows)`
            )}
          </button>
        </div>
      </div>

      {/* ── Fix dialog ──────────────────────────────────────────────── */}
      {fixingRow && (
        <FixInvalidRowDialog
          open={fixingRow !== null}
          onOpenChange={(open) => { if (!open) setFixingRow(null) }}
          invalidRow={fixingRow}
          existingEmployeeIds={existingEmployeeIds}
          onRowFixed={handleRowFixed}
        />
      )}

      {/* ── Result dialog (post-confirm) ─────────────────────────────── */}
      {importResult && (
        <ImportResultDialog
          result={importResult}
          onClose={() => setImportResult(null)}
        />
      )}

      <style>{`
        @keyframes button-sweep {
          100% { transform: translateX(200%); }
        }
      `}</style>
    </>
  )
}
