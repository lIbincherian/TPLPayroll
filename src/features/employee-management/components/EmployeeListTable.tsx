'use client'

import { useState, useCallback, useTransition, useEffect, useRef, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlass, UsersThree, WarningCircle, Plus, CaretLeft, CaretRight, UploadSimple, DownloadSimple, CaretDown, CaretUp, SpinnerGap } from '@phosphor-icons/react'
import { computePageRange } from '../utils/computePageRange'
import { StatusBadge } from './StatusBadge'
import { SkeletonRows } from './SkeletonRows'
import { BulkActionToolbar } from './BulkActionToolbar'
import { BulkStatusDialog } from './BulkStatusDialog'
import { BulkInactiveDialog } from './BulkInactiveDialog'
import { BulkRateDialog } from './BulkRateDialog'
import { ImportDialog } from '@/features/employee-import-export/components/ImportDialog'
import { getEmployeeListAction, getDistinctDesignationsAction, getDistinctSitesAction } from '@/features/employee-management/actions/employee.actions'
import type { EmployeeListItem, EmployeeStatus, SortableField } from '@/features/employee-management/types/employee.types'

type StatusFilter = 'ALL' | EmployeeStatus
type BulkDialog = 'resigned' | 'inactive' | 'rate' | null

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'All employees' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'RESIGNED', label: 'Resigned' },
]

const PAGE_SIZE = 10
const COL_COUNT = 6 // checkbox + 5 data columns

export function EmployeeListTable() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [employees, setEmployees] = useState<EmployeeListItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [designation, setDesignation] = useState('ALL')
  const [site, setSite] = useState('ALL')
  
  const [designations, setDesignations] = useState<string[]>([])
  const [sites, setSites] = useState<string[]>([])
  
  const [sortBy, setSortBy] = useState<SortableField>('employeeName')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // ── Bulk action state ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openDialog, setOpenDialog] = useState<BulkDialog>(null)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  // Sync indeterminate state on the header checkbox
  // Fetch distinct filters
  useEffect(() => {
    async function fetchFilters() {
      const [desigRes, siteRes] = await Promise.all([
        getDistinctDesignationsAction(),
        getDistinctSitesAction(),
      ])
      if (desigRes.ok) setDesignations(desigRes.data)
      if (siteRes.ok) setSites(siteRes.data)
    }
    fetchFilters()
  }, [])

  useEffect(() => {
    if (!headerCheckboxRef.current) return
    const someSelected = selectedIds.size > 0
    const allSelected = employees.length > 0 && selectedIds.size === employees.length
    headerCheckboxRef.current.indeterminate = someSelected && !allSelected
  }, [selectedIds, employees])

  // Clear selections when search, status filter, or page changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the row selection whenever the list query (search, filters, sort, page) changes
    setSelectedIds(new Set())
  }, [search, status, designation, site, sortBy, sortOrder, page])

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchEmployees = useCallback(
    async (opts: { page: number; search: string; status: StatusFilter; designation: string; site: string; sortBy: SortableField; sortOrder: 'asc'|'desc' }) => {
      setLoadState('loading')
      const result = await getEmployeeListAction({
        page: opts.page,
        limit: PAGE_SIZE,
        search: opts.search || undefined,
        status: opts.status === 'ALL' ? undefined : opts.status,
        designation: opts.designation === 'ALL' ? undefined : opts.designation,
        site: opts.site === 'ALL' ? undefined : opts.site,
        sortBy: opts.sortBy,
        sortOrder: opts.sortOrder,
      })
      if (result.ok) {
        setEmployees(result.data.employees)
        setTotalCount(result.data.totalCount)
        setLoadState('loaded')
      } else {
        setLoadState('error')
      }
    },
    []
  )

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      startTransition(() => {
        fetchEmployees({ page: 1, search, status, designation, site, sortBy, sortOrder })
        setPage(1)
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [search, status, designation, site, sortBy, sortOrder, fetchEmployees])

  // Page change (immediate)
  useEffect(() => {
    startTransition(() => {
      fetchEmployees({ page, search, status, designation, site, sortBy, sortOrder })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ── Selection handlers ────────────────────────────────────────────────────
  const toggleEmployee = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === employees.length) {
        return new Set()
      }
      return new Set(employees.map((e) => e.id))
    })
  }, [employees])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  // ── Bulk action callbacks ─────────────────────────────────────────────────
  const handleBulkComplete = useCallback(() => {
    setOpenDialog(null)
    setSelectedIds(new Set())
    startTransition(() => {
      fetchEmployees({ page, search, status, designation, site, sortBy, sortOrder })
    })
  }, [page, search, status, designation, site, sortBy, sortOrder, fetchEmployees])

  const handleBulkClose = useCallback(() => {
    setOpenDialog(null)
  }, [])

  const selectedEmployees = employees.filter((e) => selectedIds.has(e.id))

  // ── Sort handlers ─────────────────────────────────────────────────────────
  const handleSort = (column: SortableField) => {
    setPage(1)
    if (sortBy === column) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(column)
      setSortOrder('asc')
    }
  }

  const renderSortHeader = (label: string, field: SortableField) => {
    const isActive = sortBy === field
    return (
      <th className="px-4 py-3 text-left">
        <button
          onClick={() => handleSort(field)}
          className={`inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider cursor-pointer transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] ${
            isActive ? 'text-zinc-700' : 'text-zinc-400 hover:text-zinc-500'
          }`}
        >
          {label}
          {isActive && (
            sortOrder === 'asc' ? <CaretUp size={12} className="text-emerald-600" /> : <CaretDown size={12} className="text-emerald-600" />
          )}
        </button>
      </th>
    )
  }

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      const res = await fetch('/api/employees/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('content-disposition') ?? ''
      const match = cd.match(/filename="(.+)"/)
      a.download = match?.[1] ?? 'employee-master.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setIsExporting(false)
    }
  }, [])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const showing = employees.length > 0
    ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount}`
    : ''

  const allSelected = employees.length > 0 && selectedIds.size === employees.length

  return (
    <>
    <div className="space-y-6">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
          Team Directory
        </h1>
        <div className="flex items-center gap-2 shrink-0">
          {/* Export button */}
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 px-3.5 py-2 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors duration-200 disabled:opacity-60"
          >
            {isExporting ? (
              <SpinnerGap size={15} className="animate-spin" />
            ) : (
              <DownloadSimple size={15} />
            )}
            Export
          </button>

          {/* Import dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowImportMenu((v) => !v)}
              onBlur={() => setTimeout(() => setShowImportMenu(false), 150)}
              className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 px-3.5 py-2 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors duration-200"
            >
              <UploadSimple size={15} />
              Import
              <CaretDown size={13} className="text-zinc-400" />
            </button>
            {showImportMenu && (
              <div className="popover-enter origin-top-right absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-white border border-zinc-200/60 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.08)] py-1 z-20">
                <button
                  onClick={() => { setShowImportMenu(false); setShowImportDialog(true) }}
                  className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
                >
                  <UploadSimple size={15} className="text-zinc-400" />
                  Import from Excel
                </button>
              </div>
            )}
          </div>

          <button
            onClick={() => router.push('/employees/new')}
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-xl transition-[background-color,transform] duration-150 ease-out active:scale-[0.98]"
          >
            <Plus size={16} weight="bold" />
            Add Employee
          </button>
        </div>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
          />
          <input
            id="employee-search"
            type="text"
            placeholder="Search by name or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-zinc-50 border border-zinc-200/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 placeholder:text-zinc-400 transition-colors duration-200"
          />
        </div>

        {/* Designation filter */}
        <select
          id="employee-designation-filter"
          value={designation}
          onChange={(e) => { setDesignation(e.target.value); setPage(1) }}
          className="w-full md:w-[180px] px-3 py-2 text-sm rounded-xl border border-zinc-200/60 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 transition-colors duration-200"
        >
          <option value="ALL">All Designations</option>
          {designations.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>

        {/* Site filter */}
        <select
          id="employee-site-filter"
          value={site}
          onChange={(e) => { setSite(e.target.value); setPage(1) }}
          className="w-full md:w-[180px] px-3 py-2 text-sm rounded-xl border border-zinc-200/60 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 transition-colors duration-200"
        >
          <option value="ALL">All Sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* Status filter */}
        <select
          id="employee-status-filter"
          value={status}
          onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1) }}
          className="w-full md:w-[180px] px-3 py-2 text-sm rounded-xl border border-zinc-200/60 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-zinc-900 transition-colors duration-200"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-zinc-50/50">
              {/* Checkbox header */}
              <th className="w-12 px-4 py-3 text-center">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={employees.length === 0}
                  className="w-4 h-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Select all employees on this page"
                  id="bulk-select-all"
                />
              </th>
              {renderSortHeader('ID', 'employeeId')}
              {renderSortHeader('Name', 'employeeName')}
              {renderSortHeader('Designation', 'designation')}
              {renderSortHeader('Site', 'site')}
              {renderSortHeader('Status', 'status')}
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100">
            {loadState === 'loading' || isPending ? (
              <SkeletonRows count={PAGE_SIZE} />
            ) : loadState === 'error' ? (
              <tr>
                <td colSpan={COL_COUNT} className="px-4 py-16 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <WarningCircle size={40} className="text-zinc-300" />
                    <p className="text-sm font-medium text-zinc-600">Failed to load employees</p>
                    <button
                      onClick={() => fetchEmployees({ page, search, status, designation, site, sortBy, sortOrder })}
                      className="text-sm text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
                    >
                      Try again
                    </button>
                  </div>
                </td>
              </tr>
            ) : employees.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="px-4 py-20 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <UsersThree size={48} className="text-zinc-200" />
                    <p className="text-lg font-medium text-zinc-600">No team members yet</p>
                    <p className="text-sm text-zinc-400">Add your first employee to get started</p>
                    <button
                      onClick={() => router.push('/employees/new')}
                      className="mt-2 inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors duration-200"
                    >
                      <Plus size={15} weight="bold" />
                      Add Employee
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              employees.map((emp, index) => {
                const isSelected = selectedIds.has(emp.id)
                return (
                  <tr
                    key={emp.id}
                    onClick={() => router.push(`/employees/${emp.id}`)}
                    style={{ '--index': Math.min(index, 5) } as CSSProperties}
                    className={`card-reveal cursor-pointer transition-colors duration-150 ${
                      isSelected
                        ? 'bg-emerald-50/40 hover:bg-emerald-50/60'
                        : 'hover:bg-zinc-50/80'
                    }`}
                  >
                    {/* Row checkbox */}
                    <td className="w-12 px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleEmployee(emp.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500/20 cursor-pointer"
                        aria-label={`Select ${emp.employeeName}`}
                        data-employee-id={emp.employeeId}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-zinc-500">{emp.employeeId}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-zinc-900">{emp.employeeName}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-zinc-600">{emp.designation}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-zinc-600">{emp.site ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={emp.status} />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ──────────────────────────────────────────────────── */}
      {loadState === 'loaded' && totalCount > 0 && (
        <div className={`flex items-center justify-between pt-2 ${selectedIds.size > 0 ? 'pb-20' : ''}`}>
          <p className="text-sm text-zinc-500">{showing}</p>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <CaretLeft size={16} />
            </button>

            {computePageRange(page, totalPages).map((p, i) => {
              if (p === 'ellipsis') {
                return (
                  <span
                    key={`ellipsis-${i}`}
                    className="w-8 h-8 inline-flex items-center justify-center text-sm text-zinc-300 cursor-default select-none"
                    aria-hidden="true"
                  >
                    ...
                  </span>
                )
              }
              return (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  className={`w-8 h-8 text-sm rounded-lg font-medium transition-colors ${
                    p === page
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                  }`}
                >
                  {p}
                </button>
              )
            })}

            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              <CaretRight size={16} />
            </button>
          </div>
        </div>
      )}

    </div>

    {/* ── Floating bulk-action toolbar ──────────────────────────────────── */}
    <BulkActionToolbar
      selectedCount={selectedIds.size}
      onMarkResigned={() => setOpenDialog('resigned')}
      onMarkInactive={() => setOpenDialog('inactive')}
      onChangeHourlyRate={() => setOpenDialog('rate')}
      onClear={clearSelection}
    />

    {/* ── Bulk action dialogs ──────────────────────────────────────────── */}
    {openDialog === 'resigned' && (
      <BulkStatusDialog
        employees={selectedEmployees}
        onClose={handleBulkClose}
        onComplete={handleBulkComplete}
      />
    )}

    {openDialog === 'inactive' && (
      <BulkInactiveDialog
        employees={selectedEmployees}
        onClose={handleBulkClose}
        onComplete={handleBulkComplete}
      />
    )}

    {openDialog === 'rate' && (
      <BulkRateDialog
        employees={selectedEmployees}
        onClose={handleBulkClose}
        onComplete={handleBulkComplete}
      />
    )}

    {/* ── Import dialog ─────────────────────────────────────────────────── */}
    {showImportDialog && (
      <ImportDialog onClose={() => setShowImportDialog(false)} />
    )}
    </>
  )
}
