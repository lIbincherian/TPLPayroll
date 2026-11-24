'use client'

import { useState } from 'react'
import { Lock, SpinnerGap } from '@phosphor-icons/react'
import { updateSettingsAction } from '@/features/settings/actions/settings.actions'
import type { AppSettings, DayOfWeek } from '@/features/settings/types/settings.types'

// ─── Day label helper ─────────────────────────────────────────────────────────

const DAY_LABELS: Record<DayOfWeek, string> = {
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
  FRIDAY: 'Friday',
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SettingsFormProps {
  initialSettings: AppSettings
}

// ─── SettingsForm ─────────────────────────────────────────────────────────────
// The payroll week start is locked to Thursday (F12). The one switch on this page is the temporary
// Employee Master sheet sync (F13), which saves as soon as it is toggled.

function formatApplied(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  })
}

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [syncEnabled, setSyncEnabled] = useState(initialSettings.employeeSheetSyncEnabled)
  const [saving, setSaving] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const firstApplied = initialSettings.employeeSheetSyncFirstAppliedAt

  async function toggleSync() {
    const next = !syncEnabled
    setSaving(true)
    setSyncError(null)
    try {
      const result = await updateSettingsAction({ employeeSheetSyncEnabled: next })
      if (result.ok) setSyncEnabled(result.data.employeeSheetSyncEnabled)
      else setSyncError(result.error)
    } catch {
      setSyncError("Couldn't reach the server. The setting was not changed.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-0">
      {/* ── Section 1: Payroll Configuration (read-only, locked) ─────────── */}
      <div className="border-t border-zinc-200/60 pt-8 pb-8">
        <h2 className="text-sm font-medium text-zinc-900 mb-6">Payroll Configuration</h2>

        <dl className="max-w-md">
          <div>
            <dt className="text-xs uppercase tracking-wider text-zinc-400 mb-1">
              Payroll Week Start Day
            </dt>
            <dd
              data-testid="payroll-week-start-day"
              className="text-sm text-zinc-600 flex items-center gap-2"
            >
              {DAY_LABELS[initialSettings.payrollWeekStartDay]}
              <span className="inline-flex items-center gap-1 bg-zinc-100 text-zinc-400 rounded-full text-xs px-2 py-0.5">
                <Lock size={12} aria-hidden="true" />
                Locked
              </span>
            </dd>
          </div>
        </dl>

        <p className="text-sm text-zinc-400 mt-2 max-w-[65ch] leading-relaxed">
          The payroll week runs Thursday to Wednesday, matching the eTimeOffice sync.
        </p>
      </div>

      {/* ── Section: Employee Master sheet sync (F13) ─────────────────────── */}
      <div className="border-t border-zinc-200/60 pt-8 pb-8" data-testid="sheet-sync-setting">
        <h2 className="text-sm font-medium text-zinc-900 mb-6">Employee Master sheet sync</h2>

        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={syncEnabled}
            aria-labelledby="sheet-sync-switch-label"
            disabled={saving}
            onClick={() => void toggleSync()}
            data-testid="sheet-sync-switch"
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 disabled:cursor-wait disabled:opacity-70 ${
              syncEnabled ? 'bg-emerald-600' : 'bg-zinc-200'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${
                syncEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
          <span id="sheet-sync-switch-label" className="text-sm text-zinc-700">
            {syncEnabled ? 'On' : 'Off'}
          </span>
          {saving && <SpinnerGap size={14} className="animate-spin text-zinc-400 motion-reduce:animate-none" aria-hidden="true" />}
        </div>

        {syncError && (
          <p role="alert" className="mt-3 text-sm text-rose-600" data-testid="sheet-sync-setting-error">
            {syncError}
          </p>
        )}

        <p className="text-sm text-zinc-500 mt-3 max-w-[65ch] leading-relaxed">
          Reads the Employee Master List tab of the company sheet into the app, one way, every night and when
          you press Sync from sheet. While it is on, the fields the sheet owns are read-only in the app. Turn it
          off when the team moves to the app: the button and the nightly run go away and those fields become
          editable again.
        </p>
        <p className="text-sm text-zinc-500 mt-2" data-testid="sheet-sync-first-applied">
          {firstApplied
            ? `First applied ${formatApplied(firstApplied)}. The nightly sync is running while this is on.`
            : 'Not applied yet. The nightly sync starts after the first Apply from the Employees page.'}
        </p>
      </div>

      {/* ── Section 2: Display Defaults (read-only) ───────────────────────── */}
      <div className="border-t border-zinc-200/60 pt-8 pb-8">
        <h2 className="text-sm font-medium text-zinc-900 mb-6">Display Defaults</h2>

        <dl className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
          <div>
            <dt className="text-xs uppercase tracking-wider text-zinc-400 mb-1">Currency</dt>
            <dd className="font-mono text-sm text-zinc-600">₹ INR</dd>
          </div>

          <div>
            <dt className="text-xs uppercase tracking-wider text-zinc-400 mb-1">
              Document Expiry Threshold
            </dt>
            <dd className="font-mono text-sm text-zinc-600 flex items-center gap-2">
              7 days
              <span className="bg-zinc-100 text-zinc-400 rounded-full text-xs px-2 py-0.5">
                Phase 2
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
