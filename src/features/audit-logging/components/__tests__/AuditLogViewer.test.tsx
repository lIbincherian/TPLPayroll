import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { AuditLogViewer } from '../AuditLogViewer'

// US-12.21 AC3: the audit log viewer shows and filters attendance entries. Attendance entries
// carry their own `summary`; action badges cover SYNC, PULL, APPROVE, REOPEN, DISCARD and DELETE.

type Log = {
  id: string
  actionType: string
  entityType: string
  entityId: string
  detailsJson: Record<string, unknown>
  createdAt: string
}

function log(overrides: Partial<Log> = {}): Log {
  return {
    id: 'log-1',
    actionType: 'CREATE',
    entityType: 'EMPLOYEE',
    entityId: 'aaaaaaaa-1111-2222-3333-444444444444',
    detailsJson: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function respondWith(logs: Log[], extra: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValue({
    json: async () => ({ logs, totalCount: logs.length, page: 1, limit: 20, ...extra }),
  })
}

function requestedParams(callIndex = -1): URLSearchParams {
  const calls = fetchMock.mock.calls
  const url = String(calls.at(callIndex)?.[0])
  return new URL(url, 'http://localhost').searchParams
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuditLogViewer — filters', () => {
  it('offers the four attendance entity types next to the existing ones', async () => {
    respondWith([])
    render(<AuditLogViewer />)

    const [entitySelect] = screen.getAllByRole('combobox')
    const options = within(entitySelect).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).value])

    expect(options).toEqual([
      ['All Entities', ''],
      ['Employee', 'EMPLOYEE'],
      ['Wage History', 'WAGE_HISTORY'],
      ['Attendance week', 'ATTENDANCE_WEEK'],
      ['Attendance punch', 'ATTENDANCE_PUNCH'],
      ['Attendance decision', 'ATTENDANCE_DECISION'],
      ['Attendance code', 'ATTENDANCE_CODE'],
    ])
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('offers every F12 action type', async () => {
    respondWith([])
    render(<AuditLogViewer />)

    const actionSelect = screen.getAllByRole('combobox')[1]
    const values = within(actionSelect).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

    expect(values).toEqual(['', 'CREATE', 'UPDATE', 'DELETE', 'SYNC', 'PULL', 'APPROVE', 'REOPEN', 'DISCARD'])
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('loads without filters first', async () => {
    respondWith([])
    render(<AuditLogViewer />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const params = requestedParams()
    expect(params.get('entityType')).toBeNull()
    expect(params.get('actionType')).toBeNull()
    expect(params.get('page')).toBe('1')
  })

  it('asks the API for only attendance punch entries when that entity is selected', async () => {
    respondWith([])
    render(<AuditLogViewer />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ATTENDANCE_PUNCH' } })

    await waitFor(() => expect(requestedParams().get('entityType')).toBe('ATTENDANCE_PUNCH'))
    expect(requestedParams().get('actionType')).toBeNull()
    expect(requestedParams().get('page')).toBe('1')
  })

  it('combines an attendance entity with an action filter', async () => {
    respondWith([])
    render(<AuditLogViewer />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ATTENDANCE_WEEK' } })
    await waitFor(() => expect(requestedParams().get('entityType')).toBe('ATTENDANCE_WEEK'))
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'DISCARD' } })

    await waitFor(() => expect(requestedParams().get('actionType')).toBe('DISCARD'))
    expect(requestedParams().get('entityType')).toBe('ATTENDANCE_WEEK')
  })

  it('goes back to page 1 when a filter changes', async () => {
    respondWith([log()], { totalCount: 60 })
    render(<AuditLogViewer />)
    await screen.findByText('New employee')

    fireEvent.click(screen.getByRole('button', { name: '2' }))
    await waitFor(() => expect(requestedParams().get('page')).toBe('2'))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ATTENDANCE_CODE' } })

    await waitFor(() => expect(requestedParams().get('entityType')).toBe('ATTENDANCE_CODE'))
    expect(requestedParams().get('page')).toBe('1')
  })
})

describe('AuditLogViewer — rows', () => {
  it.each([
    ['SYNC', 'ATTENDANCE_WEEK', 'Attendance week'],
    ['PULL', 'ATTENDANCE_WEEK', 'Attendance week'],
    ['APPROVE', 'ATTENDANCE_WEEK', 'Attendance week'],
    ['REOPEN', 'ATTENDANCE_WEEK', 'Attendance week'],
    ['DISCARD', 'ATTENDANCE_WEEK', 'Attendance week'],
    ['DELETE', 'ATTENDANCE_PUNCH', 'Attendance punch'],
  ])('shows a %s badge and the "%s" entity as "%s"', async (actionType, entityType, label) => {
    respondWith([log({ actionType, entityType, detailsJson: { summary: 'Something happened' } })])
    render(<AuditLogViewer />)

    const row = (await screen.findByText('Something happened')).closest('tr') as HTMLElement
    expect(within(row).getByText(actionType)).toBeInTheDocument()
    expect(within(row).getByText(label)).toBeInTheDocument()
  })

  it('shows the attendance decision and code entity labels', async () => {
    respondWith([
      log({ id: 'a', entityType: 'ATTENDANCE_DECISION', actionType: 'CREATE', detailsJson: { summary: 'Decision approved' } }),
      log({ id: 'b', entityType: 'ATTENDANCE_CODE', actionType: 'CREATE', detailsJson: { summary: 'Code 0999 ignored' } }),
    ])
    render(<AuditLogViewer />)

    const decisionRow = (await screen.findByText('Decision approved')).closest('tr') as HTMLElement
    expect(within(decisionRow).getByText('Attendance decision')).toBeInTheDocument()
    const codeRow = screen.getByText('Code 0999 ignored').closest('tr') as HTMLElement
    expect(within(codeRow).getByText('Attendance code')).toBeInTheDocument()
  })

  it('uses detailsJson.summary as the summary line when present', async () => {
    respondWith([
      log({
        entityType: 'ATTENDANCE_PUNCH',
        actionType: 'UPDATE',
        detailsJson: { summary: 'Edited 17:47 to 18:00 for Kavitha on 5 Nov', old: { time: '17:47' }, new: { time: '18:00' } },
      }),
    ])
    render(<AuditLogViewer />)

    expect(await screen.findByText('Edited 17:47 to 18:00 for Kavitha on 5 Nov')).toBeInTheDocument()
  })

  it('prefers a provided summary over the built-in text for non-attendance entries too', async () => {
    respondWith([log({ actionType: 'CREATE', entityType: 'EMPLOYEE', detailsJson: { summary: 'Created TPLGOAHLP099' } })])
    render(<AuditLogViewer />)

    expect(await screen.findByText('Created TPLGOAHLP099')).toBeInTheDocument()
    expect(screen.queryByText('New employee')).not.toBeInTheDocument()
  })

  it('falls back to "<entity> <action>" for an attendance entry with no summary or a blank one', async () => {
    respondWith([
      log({ id: 'a', entityType: 'ATTENDANCE_PUNCH', actionType: 'UPDATE', detailsJson: {} }),
      log({ id: 'b', entityType: 'ATTENDANCE_WEEK', actionType: 'REOPEN', detailsJson: { summary: '   ' } }),
    ])
    render(<AuditLogViewer />)

    expect(await screen.findByText('Attendance punch update')).toBeInTheDocument()
    expect(screen.getByText('Attendance week reopen')).toBeInTheDocument()
  })

  it('keeps the existing employee summaries', async () => {
    respondWith([
      log({ id: 'a', actionType: 'CREATE', entityType: 'EMPLOYEE' }),
      log({ id: 'b', actionType: 'UPDATE', entityType: 'EMPLOYEE', detailsJson: { changedFields: ['phone', 'site'] } }),
      log({ id: 'c', actionType: 'UPDATE', entityType: 'WAGE_HISTORY', detailsJson: { old: { hourlyRate: 60 }, new: { hourlyRate: 65 } } }),
    ])
    render(<AuditLogViewer />)

    expect(await screen.findByText('New employee')).toBeInTheDocument()
    expect(screen.getByText('phone, site')).toBeInTheDocument()
    expect(screen.getByText('Hourly rate: 60 → 65')).toBeInTheDocument()
  })

  it('labels a wage amount change as the daily wage', async () => {
    respondWith([
      log({ id: 'a', actionType: 'UPDATE', entityType: 'WAGE_HISTORY', detailsJson: { old: { salary: 800 }, new: { salary: 1000 } } }),
    ])
    render(<AuditLogViewer />)

    expect(await screen.findByText('Daily wage: 800 → 1000')).toBeInTheDocument()
  })

  it('shows the empty state when there are no entries', async () => {
    respondWith([])
    render(<AuditLogViewer />)

    expect(await screen.findByText('No audit log entries found')).toBeInTheDocument()
  })

  it('shows the full details, including discarded edits, when a row is expanded', async () => {
    respondWith([
      log({
        entityType: 'ATTENDANCE_WEEK',
        actionType: 'DISCARD',
        detailsJson: { summary: 'Discarded correction: 1 punch edit(s)', edits: [{ punchId: 'c-1', original: '17:47', current: '18:00' }] },
      }),
    ])
    render(<AuditLogViewer />)

    fireEvent.click((await screen.findByText('Discarded correction: 1 punch edit(s)')).closest('tr') as HTMLElement)

    expect(screen.getByText(/"punchId"/)).toBeInTheDocument()
    expect(screen.getByText('"17:47"')).toBeInTheDocument()
    expect(screen.getByText('"18:00"')).toBeInTheDocument()
  })
})
