import { Lock } from '@phosphor-icons/react/dist/ssr'
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
// Every setting on this page is read-only. The payroll week start is locked to
// Thursday (F12), so there is nothing to submit and no save action.

export function SettingsForm({ initialSettings }: SettingsFormProps) {
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
