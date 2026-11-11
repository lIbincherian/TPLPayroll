import type { ComponentProps } from 'react'
import { describe, it, expect, vi, type Mock } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { EmployeeVerificationDialog } from '@/features/attendance-upload/components/EmployeeVerificationDialog'
import type { MatchedAttendanceRecord } from '@/features/attendance-upload/types/attendance.types'
import type { EmployeeOption } from '@/features/attendance-upload/actions/attendance.actions'

// ─────────────────────────────────────────────────────────────────────────────
// TDD: Component tests for the 3-button (Match / Onboard / Reject) row layout
// in the Manual Verification dialog.
//
// PRD references:
//   §1 user stories 1, 6–11 — three explicit actions; Confirm-disable rules.
//   §3 — rename "Skip" to "Reject"; new MatchStatus REJECTED_UNMATCHED.
//
// Module under test:
//   src/features/attendance-upload/components/EmployeeVerificationDialog.tsx
//
// The implementing agent must:
//   - Add an `onOnboard(record)` callback prop
//   - Replace "Skip" with "Reject" (still backed by the unmatched-decision state)
//   - Accept `pendingOnboardBlockKeys: string[]` and render an "in progress"
//     indicator for any row whose blockKey appears in that list
//   - Disable Confirm while ANY row is "onboard in progress"
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeUnmatched(
  name: string,
  blockIndex = 0,
  sheet = 'Sheet1'
): MatchedAttendanceRecord {
  return {
    employeeName: name,
    site: null,
    sourceSheetName: sheet,
    sourceEmployeeBlockIndex: blockIndex,
    totalRegularHours: 40,
    totalOvertimeHours: 5,
    dailyHours: Array(7).fill({ regularHours: 0, overtimeHours: 0 }),
    parseErrors: [],
    matchStatus: 'UNMATCHED',
    isBlocking: true,
    employeeDbId: null,
  }
}

const EMPLOYEE_OPTIONS: EmployeeOption[] = [
  { id: 'emp-1', employeeId: 'EMP-001', employeeName: 'Ravi Kumar' },
  { id: 'emp-2', employeeId: 'EMP-002', employeeName: 'Priya Nair' },
]

type DialogProps = ComponentProps<typeof EmployeeVerificationDialog>

interface RenderArgs {
  unmatched?: MatchedAttendanceRecord[]
  verifiable?: MatchedAttendanceRecord[]
  pendingOnboardBlockKeys?: string[]
  onConfirm?: Mock<DialogProps['onConfirm']>
  onCancel?: Mock<DialogProps['onCancel']>
  onOnboard?: Mock<DialogProps['onOnboard']>
}

function renderDialog(args: RenderArgs = {}) {
  const {
    unmatched = [makeUnmatched('Unknown Person', 0)],
    verifiable = [],
    pendingOnboardBlockKeys,
    onConfirm = vi.fn<DialogProps['onConfirm']>(),
    onCancel = vi.fn<DialogProps['onCancel']>(),
    onOnboard = vi.fn<DialogProps['onOnboard']>(),
  } = args

  const utils = render(
    <EmployeeVerificationDialog
      isOpen
      employees={verifiable}
      unmatchedEmployees={unmatched}
      employeeOptions={EMPLOYEE_OPTIONS}
      onConfirm={onConfirm}
      onCancel={onCancel}
      // New props introduced by this feature — implementing agent must add.
      onOnboard={onOnboard}
      pendingOnboardBlockKeys={pendingOnboardBlockKeys}
    />
  )

  return { ...utils, onConfirm, onCancel, onOnboard }
}

// Locate the row container for a given unmatched employee name.
function rowFor(name: string): HTMLElement {
  const nameEl = screen.getByText(name)
  let el: HTMLElement | null = nameEl
  while (el && !el.className.includes('border')) {
    el = el.parentElement as HTMLElement | null
  }
  if (!el) throw new Error(`Row container for "${name}" not found`)
  return el
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmployeeVerificationDialog — Unmatched row (Match / Onboard / Reject)', () => {
  // ── Test 1 — Clicking "Reject" marks the row as decided ──────────────────
  it('clicking Reject on an unmatched row marks that row as decided', () => {
    renderDialog()

    const row = rowFor('Unknown Person')
    // Buttons use aria-label "Reject <Name>"; we match by accessible-name prefix.
    const rejectBtn = within(row).getByRole('button', {
      name: /reject/i,
    })

    expect(rejectBtn).toBeInTheDocument()
    fireEvent.click(rejectBtn)

    // Visual confirmation: button switches to a "destructive" / pressed variant.
    const decidedSignal =
      rejectBtn.getAttribute('aria-pressed') === 'true' ||
      rejectBtn.getAttribute('data-decision') === 'rejected' ||
      rejectBtn.getAttribute('data-state') === 'on' ||
      // shadcn "destructive" variant adds bg-destructive class
      rejectBtn.className.toLowerCase().includes('destructive')
    expect(decidedSignal).toBe(true)

    // Confirm button must now be enabled (this is the only row and it has a decision).
    const confirmBtn = screen.getByRole('button', { name: /confirm/i })
    expect(confirmBtn).not.toBeDisabled()
  })

  // ── Test 2 — Confirm enables only when ALL rows have a decision ──────────
  it('Confirm is disabled until every unmatched row has a decision (Match, Onboard, or Reject)', () => {
    renderDialog({
      unmatched: [
        makeUnmatched('Unknown A', 0),
        makeUnmatched('Unknown B', 1),
      ],
    })

    const confirmBtn = screen.getByRole('button', { name: /confirm/i })
    expect(confirmBtn).toBeDisabled()

    // Decide ONLY the first row — Confirm should still be disabled
    const rowA = rowFor('Unknown A')
    fireEvent.click(within(rowA).getByRole('button', { name: /reject/i }))
    expect(confirmBtn).toBeDisabled()

    // Decide the second row — Confirm should now enable
    const rowB = rowFor('Unknown B')
    fireEvent.click(within(rowB).getByRole('button', { name: /reject/i }))
    expect(confirmBtn).not.toBeDisabled()
  })

  // ── Test 3 — Clicking "Onboard" triggers the session-save callback ───────
  it('clicking Onboard fires onOnboard(record) so the parent can create a session and navigate', () => {
    const onOnboard = vi.fn()
    renderDialog({ onOnboard })

    const row = rowFor('Unknown Person')
    const onboardBtn = within(row).getByRole('button', { name: /onboard/i })

    expect(onboardBtn).toBeInTheDocument()
    fireEvent.click(onboardBtn)

    expect(onOnboard).toHaveBeenCalledTimes(1)
    // Callback receives the row's MatchedAttendanceRecord
    const arg = onOnboard.mock.calls[0][0]
    expect(arg.employeeName).toBe('Unknown Person')
    expect(arg.sourceSheetName).toBe('Sheet1')
    expect(arg.sourceEmployeeBlockIndex).toBe(0)
  })

  // ── Test 4 — "Onboard in progress" row shows an indicator ────────────────
  it('a row whose blockKey is in pendingOnboardBlockKeys shows an "in progress" indicator', () => {
    renderDialog({
      unmatched: [
        makeUnmatched('Unknown A', 0),
        makeUnmatched('Unknown B', 1),
      ],
      // Block key shape per getBlockKey(): `${sheet}||${index}`
      pendingOnboardBlockKeys: ['Sheet1||0'],
    })

    const rowA = rowFor('Unknown A')
    const rowB = rowFor('Unknown B')

    // Row A is marked as onboard-in-progress
    expect(within(rowA).getByText(/onboard.*progress/i)).toBeInTheDocument()
    // Row B is not
    expect(within(rowB).queryByText(/onboard.*progress/i)).not.toBeInTheDocument()
  })

  // ── Test 5 — Confirm disabled when ANY row is "onboard in progress" ──────
  it('Confirm stays disabled when at least one row is onboard-in-progress, even if every other row has a decision', () => {
    renderDialog({
      unmatched: [
        makeUnmatched('Unknown A', 0),
        makeUnmatched('Unknown B', 1),
      ],
      // Row B is mid-onboard
      pendingOnboardBlockKeys: ['Sheet1||1'],
    })

    // Decide row A explicitly
    const rowA = rowFor('Unknown A')
    fireEvent.click(within(rowA).getByRole('button', { name: /reject/i }))

    const confirmBtn = screen.getByRole('button', { name: /confirm/i })
    // Row B is still in-progress → Confirm must remain disabled
    expect(confirmBtn).toBeDisabled()
  })
})
