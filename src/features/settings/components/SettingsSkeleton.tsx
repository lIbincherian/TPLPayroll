export function SettingsSkeleton() {
  return (
    <div className="space-y-0 animate-pulse" aria-hidden="true">
      {/* Section 1 skeleton: Payroll Configuration */}
      <div className="border-t border-zinc-200/60 pt-8 pb-8">
        {/* Section header */}
        <div className="h-4 w-44 rounded bg-zinc-100 mb-6" />

        <div className="max-w-md space-y-3">
          {/* Label */}
          <div className="h-3 w-40 rounded bg-zinc-100" />
          {/* Read-only value with locked chip */}
          <div className="h-4 w-36 rounded bg-zinc-100" />
          {/* Helper text lines */}
          <div className="space-y-1.5 pt-1">
            <div className="h-3 w-full max-w-[55ch] rounded bg-zinc-100" />
            <div className="h-3 w-4/5 max-w-[45ch] rounded bg-zinc-100" />
          </div>
        </div>
      </div>

      {/* Section 2 skeleton: Display Defaults */}
      <div className="border-t border-zinc-200/60 pt-8 pb-8">
        {/* Section header */}
        <div className="h-4 w-36 rounded bg-zinc-100 mb-6" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
          {/* Currency */}
          <div className="space-y-1.5">
            <div className="h-3 w-16 rounded bg-zinc-100" />
            <div className="h-4 w-20 rounded bg-zinc-100" />
          </div>

          {/* Doc expiry */}
          <div className="space-y-1.5">
            <div className="h-3 w-44 rounded bg-zinc-100" />
            <div className="h-4 w-28 rounded bg-zinc-100" />
          </div>
        </div>
      </div>
    </div>
  )
}
