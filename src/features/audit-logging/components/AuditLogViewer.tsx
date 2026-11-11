'use client'

import { useState, useEffect, Fragment } from 'react'
import { ListChecks } from '@phosphor-icons/react'

type AuditLogRecord = {
  id: string
  actionType: 'CREATE' | 'UPDATE'
  entityType: 'EMPLOYEE' | 'WAGE_HISTORY'
  entityId: string
  detailsJson: Record<string, unknown>
  createdAt: string
}

type State = {
  logs: AuditLogRecord[]
  totalCount: number
  page: number
  limit: number
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function fullDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function entityLabel(entityType: 'EMPLOYEE' | 'WAGE_HISTORY'): string {
  return entityType === 'EMPLOYEE' ? 'Employee' : 'Wage History'
}

function summaryText(log: AuditLogRecord): string {
  if (log.actionType === 'CREATE') return 'New employee'
  if (log.entityType === 'WAGE_HISTORY') {
    const d = log.detailsJson as Record<string, unknown>
    const newVals = d.new as Record<string, unknown> | undefined
    if (newVals?.hourlyRate !== undefined) {
      const oldVals = d.old as Record<string, unknown> | undefined
      return `Hourly rate: ${oldVals?.hourlyRate ?? '—'} → ${newVals.hourlyRate}`
    }
    if (newVals?.salary !== undefined) {
      const oldVals = d.old as Record<string, unknown> | undefined
      return `Salary: ${oldVals?.salary ?? '—'} → ${newVals.salary}`
    }
    return 'Wage updated'
  }
  const d = log.detailsJson as Record<string, unknown>
  const changed = d.changedFields
  if (Array.isArray(changed)) {
    return changed.slice(0, 3).join(', ')
  }
  return 'Employee updated'
}

type JsonContext = 'default' | 'old' | 'new'

function renderJsonValue(
  value: unknown,
  context: JsonContext = 'default',
  depth = 0,
): React.ReactNode {
  if (value === null) {
    return <span className="text-purple-400">null</span>
  }
  if (typeof value === 'boolean') {
    return <span className="text-purple-400">{value ? 'true' : 'false'}</span>
  }
  if (typeof value === 'number') {
    return <span className="text-sky-300">{value}</span>
  }
  if (typeof value === 'string') {
    const color =
      context === 'old'
        ? 'text-rose-400'
        : context === 'new'
          ? 'text-emerald-400'
          : 'text-amber-300'
    return <span className={color}>&quot;{value}&quot;</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-zinc-400">[]</span>
    const indent = '  '.repeat(depth + 1)
    const closeIndent = '  '.repeat(depth)
    return (
      <>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {indent}
            {renderJsonValue(item, context, depth + 1)}
            {i < value.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {closeIndent}
        {']'}
      </>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-zinc-400">{'{}'}</span>
    const indent = '  '.repeat(depth + 1)
    const closeIndent = '  '.repeat(depth)
    return (
      <>
        {'{\n'}
        {entries.map(([k, v], i) => {
          const childCtx: JsonContext =
            k === 'old' ? 'old' : k === 'new' ? 'new' : context
          return (
            <span key={k}>
              {indent}
              <span className="text-zinc-400">&quot;{k}&quot;</span>
              {': '}
              {renderJsonValue(v, childCtx, depth + 1)}
              {i < entries.length - 1 ? ',' : ''}
              {'\n'}
            </span>
          )
        })}
        {closeIndent}
        {'}'}
      </>
    )
  }
  return <span className="text-zinc-400">{String(value)}</span>
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b border-zinc-100">
          <td className="px-6 py-4">
            <div className="animate-pulse bg-zinc-100 rounded h-4 w-24" />
          </td>
          <td className="px-6 py-4">
            <div className="animate-pulse bg-zinc-100 rounded h-4 w-16" />
          </td>
          <td className="px-6 py-4">
            <div className="animate-pulse bg-zinc-100 rounded h-4 w-24" />
          </td>
          <td className="px-6 py-4">
            <div className="animate-pulse bg-zinc-100 rounded h-4 w-20" />
          </td>
          <td className="px-6 py-4">
            <div className="animate-pulse bg-zinc-100 rounded h-4 w-40" />
          </td>
        </tr>
      ))}
    </>
  )
}

function EmptyState() {
  return (
    <tr>
      <td colSpan={5}>
        <div className="py-16 flex flex-col items-center justify-center text-center">
          <ListChecks size={48} className="text-zinc-200 mb-4" />
          <p className="text-lg font-medium text-zinc-600">No audit log entries found</p>
          <p className="text-sm text-zinc-400 mt-1">Actions performed in the system will appear here</p>
        </div>
      </td>
    </tr>
  )
}

export function AuditLogViewer() {
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [entityType, setEntityType] = useState('')
  const [actionType, setActionType] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the loading state synchronously when filters or page change, before the fetch starts
    setLoading(true)
    const params = new URLSearchParams()
    if (entityType) params.set('entityType', entityType)
    if (actionType) params.set('actionType', actionType)
    params.set('page', String(page))
    params.set('limit', '20')
    fetch(`/api/audit-logs?${params}`)
      .then(r => r.json())
      .then(data => {
        setState(data)
        setLoading(false)
      })
  }, [entityType, actionType, page])

  const totalPages = state ? Math.ceil(state.totalCount / state.limit) : 1

  const handleFilterChange = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setter(e.target.value)
    setPage(1)
  }

  const selectClass =
    'w-[180px] px-3 py-2 text-sm text-zinc-900 bg-white border border-zinc-200/60 rounded-xl focus:ring-emerald-500 focus:border-emerald-500 outline-none appearance-none transition-shadow'

  return (
    <div className="space-y-6 w-full">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-900">
        Audit Log
      </h1>

      {/* Filter bar */}
      <div className="flex gap-4 flex-wrap">
        <div className="relative">
          <select
            value={entityType}
            onChange={handleFilterChange(setEntityType)}
            className={selectClass}
          >
            <option value="">All Entities</option>
            <option value="EMPLOYEE">Employee</option>
            <option value="WAGE_HISTORY">Wage History</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <div className="relative">
          <select
            value={actionType}
            onChange={handleFilterChange(setActionType)}
            className={selectClass}
          >
            <option value="">All Actions</option>
            <option value="CREATE">Create</option>
            <option value="UPDATE">Update</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto w-full">
        <table className="w-full text-left divide-y divide-zinc-100">
          <thead>
            <tr className="bg-zinc-50/50">
              <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Timestamp</th>
              <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Action</th>
              <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Entity</th>
              <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">ID</th>
              <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Summary</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white">
            {loading ? (
              <SkeletonRows />
            ) : !state || state.logs.length === 0 ? (
              <EmptyState />
            ) : (
              state.logs.map((log, index) => {
                const isExpanded = expandedId === log.id
                return (
                  <Fragment key={log.id}>
                    <tr
                      className="hover:bg-zinc-50/80 transition-colors cursor-pointer"
                      style={{ '--index': index } as React.CSSProperties}
                      onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    >
                      {/* Timestamp */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="relative group inline-block">
                          <span className="font-mono text-xs text-zinc-400">
                            {relativeTime(log.createdAt)}
                          </span>
                          <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10">
                            <div className="bg-zinc-900 text-white rounded-lg text-xs px-2 py-1 whitespace-nowrap">
                              {fullDateTime(log.createdAt)}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Action badge */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        {log.actionType === 'CREATE' ? (
                          <span className="bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium px-2 py-0.5">
                            CREATE
                          </span>
                        ) : (
                          <span className="bg-sky-50 text-sky-700 rounded-full text-xs font-medium px-2 py-0.5">
                            UPDATE
                          </span>
                        )}
                      </td>

                      {/* Entity badge */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="border border-zinc-200 text-zinc-500 rounded-full text-xs px-2 py-0.5 font-mono">
                          {entityLabel(log.entityType)}
                        </span>
                      </td>

                      {/* ID */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-mono text-xs text-zinc-500" title={log.entityId}>
                          {log.entityId.slice(0, 8)}&hellip;
                        </span>
                      </td>

                      {/* Summary */}
                      <td className="px-6 py-4">
                        <span className="text-sm text-zinc-600">{summaryText(log)}</span>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    <tr className="bg-white">
                      <td colSpan={5} className="px-6 overflow-hidden">
                        <div
                          className="transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                          style={{
                            maxHeight: isExpanded ? '600px' : '0px',
                            opacity: isExpanded ? 1 : 0,
                          }}
                        >
                          <pre className="bg-zinc-950 rounded-xl p-4 mt-2 mb-4 font-mono text-xs overflow-x-auto leading-relaxed">
                            {renderJsonValue(log.detailsJson)}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {state && totalPages > 1 && (
        <div className="flex items-center gap-2 justify-end pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-sm text-zinc-500 px-3 py-1.5 rounded-lg hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Prev
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .reduce<(number | '...')[]>((acc, p, i, arr) => {
              if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('...')
              acc.push(p)
              return acc
            }, [])
            .map((p, i) =>
              p === '...' ? (
                <span key={`ellipsis-${i}`} className="text-sm text-zinc-400 px-1">
                  &hellip;
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  className={[
                    'text-sm px-3 py-1.5 rounded-lg transition-colors',
                    page === p
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-zinc-500 hover:bg-zinc-100',
                  ].join(' ')}
                >
                  {p}
                </button>
              )
            )}

          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="text-sm text-zinc-500 px-3 py-1.5 rounded-lg hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
