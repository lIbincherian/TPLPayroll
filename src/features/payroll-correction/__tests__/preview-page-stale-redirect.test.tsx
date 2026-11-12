import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix round, item 1: the revised-preview page shows the draft only while the correction session
// still points at it. After the punches were edited (Back, edit, open the preview URL again) the
// session's pointer is cleared, so the page redirects to the punches instead of showing a stale draft.

class Redirect extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`)
  }
}
class NotFound extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url)
  },
  notFound: () => {
    throw new NotFound('NOT_FOUND')
  },
}))
vi.mock('@/lib/prisma', () => ({ default: { payrollRun: { findUnique: vi.fn() } } }))
vi.mock('@/features/payroll-correction/services/correction.service', () => ({
  getActiveCorrection: vi.fn(),
  getRevisionEmployees: vi.fn(),
}))
vi.mock('@/features/payroll-correction/components/RevisedPreview', () => ({ RevisedPreview: () => null }))
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: unknown }) => children }))

import prisma from '@/lib/prisma'
import { getActiveCorrection, getRevisionEmployees } from '@/features/payroll-correction/services/correction.service'
import RevisedPreviewPage from '@/app/payroll/run/[payrollRunId]/correct/preview/page'

const RUN = 'run-1'

function revision(over: Record<string, unknown>) {
  return {
    id: 'rev',
    revisionNumber: 1,
    status: 'APPROVED',
    isCurrent: false,
    totalRegularPay: 100,
    totalOvertimePay: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    totalNetPayable: 100,
    ...over,
  }
}

function serveRun(opts: { draft?: boolean } = {}) {
  const revisions = [
    ...(opts.draft === false ? [] : [revision({ id: 'draft-2', revisionNumber: 2, status: 'DRAFT' })]),
    revision({ id: 'rev-1', revisionNumber: 1, isCurrent: true }),
  ]
  vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue({
    id: RUN,
    payrollWeekStartDate: new Date('2025-03-06T00:00:00Z'),
    payrollWeekEndDate: new Date('2025-03-12T00:00:00Z'),
    revisions,
  } as never)
}

function session(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    payrollRunId: RUN,
    hasPunchClone: true,
    draftRevisionId: 'draft-2',
    ...over,
  } as never
}

async function render() {
  return RevisedPreviewPage({ params: Promise.resolve({ payrollRunId: RUN }) })
}

async function redirectedTo(): Promise<string | null> {
  try {
    await render()
    return null
  } catch (e) {
    if (e instanceof Redirect) return e.url
    throw e
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getRevisionEmployees).mockResolvedValue([])
})

describe('the revised preview page after the punches changed', () => {
  it('shows the preview while the session still points at the draft', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(session({ draftRevisionId: 'draft-2' }))

    expect(await redirectedTo()).toBeNull()
  })

  it('redirects to the punches when the pointer was cleared by an edit and the correction has a punch copy', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(session({ draftRevisionId: null, hasPunchClone: true }))

    expect(await redirectedTo()).toBe(`/payroll/run/${RUN}/correct/punches`)
  })

  it('redirects to the reason step when there is no punch copy', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(session({ draftRevisionId: null, hasPunchClone: false }))

    expect(await redirectedTo()).toBe(`/payroll/run/${RUN}/correct`)
  })

  it('redirects when the session points at a different draft', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(session({ draftRevisionId: 'draft-9' }))

    expect(await redirectedTo()).toBe(`/payroll/run/${RUN}/correct/punches`)
  })

  it('does not load the stale draft\'s employees before redirecting', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(session({ draftRevisionId: null }))

    await redirectedTo()

    expect(getRevisionEmployees).not.toHaveBeenCalled()
  })

  it('shows a draft that no session claims (an older, session-less draft)', async () => {
    serveRun()
    vi.mocked(getActiveCorrection).mockResolvedValue(null)

    expect(await redirectedTo()).toBeNull()
    expect(getRevisionEmployees).toHaveBeenCalledWith('draft-2', 'rev-1')
  })

  it('redirects to the reason step when there is no draft at all', async () => {
    serveRun({ draft: false })
    vi.mocked(getActiveCorrection).mockResolvedValue(session())

    expect(await redirectedTo()).toBe(`/payroll/run/${RUN}/correct`)
  })

  it('is a 404 for an unknown run', async () => {
    vi.mocked(prisma.payrollRun.findUnique).mockResolvedValue(null)

    await expect(render()).rejects.toBeInstanceOf(NotFound)
  })
})
