# F12 — eTimeOffice Attendance Sync & Punch Review: Wireframes

> **Design Tokens:** Geist + Geist Mono | Zinc base, Emerald accent | VARIANCE 8, MOTION 6, DENSITY 4 (Screen 3 only: DENSITY 8, see its density notes)

Source of truth: [feature-spec.md](./feature-spec.md). Example data uses the spec's 5–11 Nov 2026 week. The hours are worked examples, not real data.

## Screen Map

| # | Screen | Route | Status |
|---|---|---|---|
| 1 | Attendance week list | `/attendance` | Replaces the upload page |
| 2 | Employee check | `/attendance/[weekId]/employee-check` | New page, proposed route. Replaces `EmployeeVerificationDialog` |
| 3 | Punch review grid | `/attendance/[weekId]/review` | New, proposed route |
| 4 | Day editor | Sheet on Screen 3 | New |
| 5 | Approve week summary | Dialog on Screen 3 | New |
| 6 | Approved week view | `/attendance/[weekId]/review`, locked | New |
| 7 | Correct flow | `/payroll/run/[payrollRunId]/correct`, `.../correct/punches` (proposed), `.../correct/preview` | Changes `CorrectionFlow` and `RevisedPreview` |
| 8 | Payslip table | PDF from `generatePayrollSlipPdf` | Changes the attendance table |
| 9 | Payroll flow changes | `/payroll`, `/payroll/generate/[weekId]` | Changes `PayrollWeekList`, `AttendanceVerificationStep` |
| 10 | Settings: week start locked | `/settings` | Changes `SettingsForm` |

## Shared Conventions

Every class below already ships in the app. Reuse it as written.

| Element | Classes |
|---|---|
| Page title | `text-2xl font-semibold tracking-tight text-zinc-900`, subtitle `text-sm text-zinc-400` |
| Table | No card wrapper. `w-full divide-y divide-zinc-100`, rows `hover:bg-zinc-50/80 transition-colors` |
| Table header | `text-xs font-medium uppercase tracking-wider text-zinc-400` |
| Status badge | `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium` |
| Banner | `flex items-start gap-3 rounded-xl border p-4`, in `rose`, `amber` or `emerald` (`bg-*-50 border-*-200/60`) |
| Primary button | `rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 active:scale-[0.98]` |
| Disabled primary | `cursor-not-allowed rounded-xl bg-emerald-600/40 text-white` (as on the disabled Generate button) |
| Outline button | `rounded-xl border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50` |
| Hours and times | `font-mono tabular-nums`. Hours always show two decimals |

### Week Status Badges

Used on Screens 1, 3, 6 and 9.

| Status | Treatment |
|---|---|
| No data | Plain `text-xs text-zinc-400`, no badge (same as today's "No upload") |
| Sync failed | `bg-rose-50 text-rose-700` + `<XCircle size={13} weight="fill" className="text-rose-500" />` |
| Ready for review | `bg-amber-50 text-amber-700` + `<ListChecks size={13} className="text-amber-500" />` |
| Approved | `bg-emerald-50 text-emerald-700` + `<CheckCircle size={13} weight="fill" className="text-emerald-500" />` |

---

## Screen 1: Attendance Week List (`/attendance`)

Replaces `AttendanceUploadClient`. The dropzone, Replace button, and File column are removed. The sidebar item stays as is.

### Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ h1: "Attendance"                                              [Load a past week]                            │
│ text-2xl font-semibold tracking-tight text-zinc-900           Button outline, <CalendarBlank size={14} />   │
│ p: "Synced from eTimeOffice every Thursday morning."                                                        │
│ text-sm text-zinc-400                                                                                       │
│                                                                                                             │
│ Table: NO card wrapper, divide-y divide-zinc-100                                                            │
│ Header: text-xs uppercase tracking-wider text-zinc-400                                                      │
│                                                                                                             │
│ Week                  Status             Details                                 Payroll        Action      │
│ ────────────────────  ─────────────────  ──────────────────────────────────────  ─────────────  ─────────── │
│ 5 Nov – 11 Nov 2026   Ready for review   2 codes to fix · 3 days Needs fixing    Not generated  [Review]    │
│ 29 Oct – 4 Nov 2026   Sync failed        eTimeOffice returned HTTP 500.          Not generated  [Pull now]  │
│                                          Last tried 5 Nov, 06:12                                            │
│ 22 Oct – 28 Oct 2026  No data            No sync has run for this week           Not generated  [Pull now]  │
│ 15 Oct – 21 Oct 2026  Approved           96 employees · 4,512.50 reg · 612.75 OT Not generated  [View]      │
│ 8 Oct – 14 Oct 2026   Approved           96 employees · 4,488.00 reg · 590.25 OT Approved       [View]      │
│ 1 Oct – 7 Oct 2026    Approved           Excel upload · attend.xlsx              Approved       [View]      │
│                                                                                                             │
│ Week: text-sm font-medium text-zinc-900                                                                     │
│ Details: text-sm text-zinc-500. Sync failed error: text-sm text-rose-600,                                   │
│          attempt time on its own line in text-xs text-zinc-400.                                             │
│          Excel file name: font-mono text-xs text-zinc-500 (the current File column style)                   │
│ Payroll: reuses PayrollBadge from PayrollWeekList                                                           │
│ [Review]/[View]: Button outline sm, <Eye size={14} />                                                       │
│ [Pull now]: Button emerald sm, <ArrowsClockwise size={14} />                                                │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Load a Past Week (Popover)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ PopoverContent: rounded-2xl w-80 p-4                                                    │
│                                                                                         │
│ "Load a past week"   text-sm font-medium text-zinc-900                                  │
│                                                                                         │
│ ┌ Calendar, week selection ──────────┐                                                  │
│ │  October 2026                      │                                                  │
│ │  Th Fr Sa Su Mo Tu We              │                                                  │
│ │   1  2  3  4  5  6  7   has data   │  Weeks start on Thursday, so columns start on Th │
│ │   8  9 10 11 12 13 14   has data   │  text-zinc-300, disabled                         │
│ │  15 16 17 18 19 20 21   has data   │                                                  │
│ │ [22 23 24 25 26 27 28]  selected   │  bg-emerald-50 text-emerald-700 across the row   │
│ │  29 30 31 ...                      │                                                  │
│ └────────────────────────────────────┘                                                  │
│                                                                                         │
│ Selected: 22 Oct – 28 Oct 2026    font-mono tabular-nums text-sm text-zinc-700          │
│                                                         [Cancel]  [Pull now]            │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **Choosing a week:** clicking any day selects its whole Thu–Wed row. Weeks that already have data and weeks that haven't ended are disabled, with a tooltip: "This week already has data" or "This week hasn't ended yet".
- **Pull now only appears on No data and Sync failed rows** (E2E-05). There is no re-pull anywhere once a week has data.
- **Pulling:** the button shows `<SpinnerGap className="animate-spin" />` + "Pulling…" and the row's other controls disable. On success the row changes to Ready for review, with a sonner toast "Loaded 5 Nov – 11 Nov 2026". On failure the row stays or becomes Sync failed with the new error and time.
- **Row target:** Review goes to Screen 2 while codes or decisions are outstanding, otherwise to Screen 3. View goes to Screen 6.
- **Details for Ready for review** shows what remains, using the same words as the review: "2 codes to fix", "3 days Needs fixing". When nothing remains: "Ready to approve".

### Sync Failed Errors

One line each, shown in the Details column.

| API result | Copy |
|---|---|
| Non-200 status | `eTimeOffice returned HTTP 500.` |
| `Error: true` | `eTimeOffice reported an error: {message}` (message field to be confirmed by Open Item 1) |
| Unparseable response | `eTimeOffice sent a response we couldn't read.` |
| No punches for the week | `eTimeOffice returned no punches for this week.` |

### Interactive States

- **Loading:** `Skeleton` rows matching the table columns.
- **Empty (no weeks at all):** `<CalendarBlank size={48} className="text-zinc-200" />`, "No attendance weeks yet. The next sync runs Thursday between 06:00 and 07:00 IST.", and a [Load a past week] button.
- **Page load error:** rose banner, "Couldn't load attendance weeks." + [Try again].
- **Loaded by someone else:** if the scheduled job loaded the week first, the row refreshes to Ready for review with a toast, "This week was already loaded." No data is overwritten.
- **Mobile:** each row stacks as week and status, then details, then a full-width action. The popover opens as a bottom `Sheet`.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Week table | `Table` | No card wrapper. Rows use the existing `card-reveal` with `--index` |
| Status | Badge pattern above | Tooltip on Sync failed shows the full error if truncated |
| Week picker | `Popover` + `Calendar` | `weekStartsOn={4}`, selects a full row |
| Pull now | `Button` | Server action, guards against double submit |

**Spec gap, Excel rows:** the spec says past weeks still open (Excel Upload Removal) but also that the previous upload routes no longer exist (E2E-28), and the grid can't show six-slot rows as pairs. The target of [View] on an Excel row is not decided. The row is drawn; its destination is not.

---

## Screen 2: Employee Check (`/attendance/[weekId]/employee-check`)

This is a page, not a dialog like today's `EmployeeVerificationDialog`. The user leaves to edit or create employees and comes back, and a page removes the need for the upload session and resume code that the dialog relies on.

### Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Back to attendance]   text-sm text-zinc-400 hover:text-zinc-700, <ArrowLeft size={14} />       │
│                                                                                                   │
│ h1: "Employee check"                                                                              │
│ p: "5 Nov – 11 Nov 2026"   text-sm text-zinc-500                                                  │
│                                                                                                   │
│ ┌── Summary strip: flex divide-x divide-zinc-200 border-t border-b border-zinc-200/60 py-4        │
│ │  CODES IN SYNC   MATCHED   UNKNOWN   DUPLICATE   DECISIONS LEFT                                 │
│ │  98              94        1         1           2                                              │
│ │  label: text-xs uppercase tracking-wider text-zinc-400                                          │
│ │  value: text-lg font-mono tabular-nums font-semibold                                            │
│ │  Unknown, Duplicate, Decisions left: text-rose-600 when above 0                                 │
│                                                                                                   │
│ ┌── Section: "Codes to fix"   text-sm font-medium text-zinc-900 mb-4                              │
│ │  Table: NO card wrapper                                                                         │
│ │                                                                                                 │
│ │  Code   Name in eTimeOffice   Punches           Problem and fix                                 │
│ │  ─────  ────────────────────  ────────────────  ───────────────────────────────────────         │
│ │  0999   Empname0999           12 punches,       <XCircle /> Matches no employee                 │
│ │                               6 days            Needs an Employee ID ending in 999              │
│ │                                                 [Find employee to correct ▾]  [Create employee] │
│ │                                                                                                 │
│ │  0007   Empname0007           10 punches,       <XCircle /> Matches 2 employees                 │
│ │                               5 days            TPLGOAHLP007  Priya Nair        [Edit ID]       │
│ │                                                 TPLGOASUP007  Mohan Das         [Edit ID]       │
│ │                                                                                                 │
│ │  Code: font-mono text-sm font-medium text-zinc-900                                              │
│ │  Name in eTimeOffice: text-sm text-zinc-500                                                     │
│ │  Problem: text-sm text-rose-600, fix hint: text-xs text-zinc-500                                │
│ │  Employee IDs: font-mono text-xs text-zinc-700                                                  │
│ │                                                                                                 │
│ │  <Info size={16} className="text-zinc-400" />                                                   │
│ │  "Names are shown for reference only. Codes match on the digits at the end of the Employee ID." │
│ │  text-sm text-zinc-500                                                                          │
│                                                                                                   │
│ ┌── Section: "Inactive and resigned employees"   border-t border-zinc-200/60 pt-8                 │
│ │  "Include or leave out of this week's payroll."   text-sm text-zinc-500                         │
│ │                                                                                                 │
│ │  Employee                   Reason                Punches this week         Decision            │
│ │  ─────────────────────────  ────────────────────  ────────────────────────  ──────────────────  │
│ │  Sunita Rao                 Inactive              2 days, 16.00 reg, 2.50 OT [Approve] [Reject] │
│ │  TPLGOASUP019                                                                                   │
│ │  Harish Pillai              Resigned 28 Oct 2026  1 day, 8.00 reg, 0.75 OT   [Approve] [Reject] │
│ │  TPLGOAHLP052                                                                                   │
│ │                                                                                                 │
│ │  Selected Approve: Button default. Selected Reject: Button destructive.                         │
│ │  Unselected: Button outline sm (same as the shipped dialog)                                     │
│                                                                                                   │
│ Actions: flex items-center justify-between border-t border-zinc-200/60 pt-6                       │
│ "2 codes and 2 decisions left"                        [Continue to punch review →]                │
│ text-sm text-zinc-500                                 disabled until 0 remain                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **No name matching.** Nothing is suggested or ranked from the eTimeOffice name (E2E-08). The "Find employee to correct" combobox is the shipped `EmployeeCombobox`, searching by name or ID. Selecting an employee opens their edit page, and does not link the code directly.
- **Differences from the shipped dialog:** unknown codes have no Reject button and no manual match, because the spec's only fixes are correcting the Employee ID or creating the employee.
- **Fixing a code:** [Edit ID] goes to `/employees/[id]/edit`, and [Create employee] goes to `/employees/new`, each with `returnTo` set to this page. The form's "Return to attendance upload" link becomes "Return to employee check", and its `/attendance` fallback stays. The edit page has no return context today, so it needs one.
- **Re-matching:** the app re-matches codes when the page loads on return. Fixed codes leave the list, with a toast "Code 0999 matched to TPLGOAHLP999". If the new ID still doesn't match, the row stays and its problem text updates.
- **Decisions save as you click.** Failures show the rose banner and revert the buttons.
- **Ignoring a code.** A code row also has a ghost **Ignore this code** button. It opens an inline confirm in the row (`role="alertdialog"`, `bg-amber-50 border-amber-200/60 rounded-xl`) with "Leave 12 punches out of payroll?", three buttons, and a line of helper text under them:
  - **Ignore this week** (primary, `bg-zinc-900`): the code's punches are left out of this week only. Nothing is saved, so the code is asked about again in later weeks and after a new pull of this week.
  - **Ignore every week** (outline): the choice is saved, so future pulls skip the code too.
  - **Cancel** (ghost).
  - Helper text, `text-xs text-amber-800/80`: "This week: the code's punches are left out of this week only. Every week: it is skipped in future pulls too."
- **Ignored codes section.** Shown when any code is ignored, under Codes to fix, with `border-t border-zinc-200/60 pt-8`. Each row has the code, the eTimeOffice name, the punch count and a pill, `rounded-full bg-zinc-100 px-2 py-0.5 text-xs`, reading "This week only" or "Every week". Each row also has a small outline **Stop ignoring** button, on the right from `sm` up and below the row on mobile. A week-only ignore stops at once. For an every-week ignore the row opens the same inline confirm (amber panel), "Stop ignoring 0999 in future weeks too?", with a ghost **Cancel** and a `bg-zinc-900` **Stop ignoring**. The page then refreshes, and a toast says where the code went: "Code 0999 matched to TPLGOAHLP999", or "Code 0999 is back under Codes to fix" when it still matches no employee (or more than one). Disabled when the week is approved.
- **Skipped when empty.** If no codes or decisions are outstanding, Review goes straight to Screen 3.
- **Hours shown** count complete pairs only, because pairs aren't fixed yet at this point.
- **Inactive and resigned rows** only appear for employees with punches this week.

### Interactive States

- **Loading:** skeleton strip and rows.
- **Everything resolved:** emerald banner, "All codes matched and all decisions made." The primary action enables.
- **Only one section has items:** the other section is not rendered.
- **Mobile:** tables stack into rows of label and value. Actions are full width.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Summary strip | `div` flex `divide-x` | Same pattern as `AttendancePreviewClient` |
| Find employee | Reused `EmployeeCombobox` | Moved into `attendance-sync` when the upload slice is removed |
| Edit ID / Create employee | `Button` outline `sm`, `<UserPlus size={14} weight="bold" />` on Create | Navigates with `returnTo` |
| Approve / Reject | `Button` `sm` | Same variants as the shipped dialog |
| Ignore this code | `Button` ghost `sm`, then the inline confirm with `Button` `sm` for Ignore this week (`bg-zinc-900`), Ignore every week (outline) and Cancel (ghost) | Server action with scope `WEEK` or `ALWAYS`; only the every-week choice is saved |
| Stop ignoring | `Button` outline `sm` on each ignored row, then the inline confirm for an every-week ignore | Server action; deletes the saved choice (every week), matches the code's punches in this week again |

**Spec gaps:** the rules say codes are fixed before the punch review, while E2E-08 says the review can't be finished until they are resolved. This wireframe follows the rules and the User Flow, so the grid is not reachable first. Changing a decision after continuing isn't specified, so the link back to this page from Screen 3 is drawn without saying whether decisions there stay editable.

---

## Screen 3: Punch Review Grid (`/attendance/[weekId]/review`)

The most important screen. About 100 employees over 7 days, on a laptop. Most cells are normal, so the design makes a whole week scannable and makes the exceptions quick to reach.

### Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Attendance]  h1: "Punch review"  5 Nov – 11 Nov 2026  [Ready for review]      Saved 10:42   [Approve week]                 │
│                 text-2xl             text-sm text-zinc-500                       text-xs        disabled, see Screen 5        │
│ Single row, h-12. This replaces the usual stacked page header, to save 40px.                                                  │
│                                                                                                                               │
│ ┌── Filter bar: flex items-center gap-2 h-11 ───────────────────────────────────────────────────────────────                  │
│ │ (All 101) (Needs fixing 3) (No punches this week 5) (Unusual days 12)  [Search name or ID]                                  │
│ │                                                 ▌ Unusual   ! Needs fixing   M Merged   E Edited                            │
│ │ Filters: ToggleGroup, single select, rounded-full text-xs px-3 py-1                                                         │
│ │ Selected: bg-zinc-900 text-white. Needs fixing above 0: text-rose-700 bg-rose-50 font-medium                                │
│ │ Count: font-mono tabular-nums, updates live on every save                                                                   │
│                                                                                                                               │
│ EMPLOYEE           THU 5         FRI 6         SAT 7         SUN 8         MON 9         TUE 10        WED 11           WEEK  │
│                                                                                                                     Reg / OT  │
│ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  │
│ Lakshmi Venkatesh  07:40–13:04   07:40–13:04   07:40–13:04   —             07:40–13:04   07:40–13:04   07:40–13:04     48.00  │
│ TPLGOAHLP036       13:56–17:47   13:56–17:47   13:56–17:47                 13:56–17:47   13:56–18:00   13:56–17:47     +7.72  │
│                    8.00 +1.25    8.00 +1.25    8.00 +1.25                  8.00 +1.25    8.00 +1.47 E  8.00 +1.25             │
│ ····························································································································  │
│ Arjun Mehrotra     07:40–13:00  !18:26–--:--   07:40–13:04   —             07:40–13:04   07:40–13:04   07:40–13:04     40.00  │
│ TPLGOAHLP041       13:50–17:45                 13:56–17:47                 13:56–17:47   13:56–17:47   13:56–17:47     +6.25  │
│                    8.00 +1.25 M  0.00          8.00 +1.25                  8.00 +1.25    8.00 +1.25    8.00 +1.25             │
│ ····························································································································  │
│ Devendra Yadav    ▌08:00–11:10   07:40–13:04   07:40–13:04   —             07:40–13:04   07:40–13:04   07:40–13:04     43.17  │
│ TPLGOASUP012                     13:56–17:47   13:56–17:47                 13:56–17:47   13:56–17:47   13:56–17:47     +6.25  │
│                    3.17          8.00 +1.25    8.00 +1.25                  8.00 +1.25    8.00 +1.25    8.00 +1.25             │
│ ····························································································································  │
│ Meena Iyer         07:40–13:04   07:30–11:00  ▌07:00–14:00   —             07:40–13:04   07:40–13:04   07:40–13:04     47.00  │
│ TPLGOAHLP058       13:56–17:47   11:30–14:00 +1                             13:56–17:47   13:56–17:47   13:56–17:47     +6.00 │
│                    8.00 +1.25    8.00 +1.00    7.00                        8.00 +1.25    8.00 +1.25    8.00 +1.25             │
│ ····························································································································  │
│ Sunita Rao         07:40–13:04   07:40–13:04   —             —             —             —             —               16.00  │
│ TPLGOASUP019       13:56–17:47   13:56–17:47                                                                           +2.50  │
│ Inactive           8.00 +1.25    8.00 +1.25                                                                                   │
│ ····························································································································  │
│ Ravi Kumar         —             —             —             —             —             —             —                0.00  │
│ TPLGOAHLP077                                                                                                           +0.00  │
│                                                                                                                               │
│ ... 95 more rows ...                                                                                                          │
│ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  │
│ All employees      712.50        705.25        688.00        301.25        704.00        698.50        703.00       4,512.50  │
│                    +98.25        +94.50        +88.00        +20.25        +105.75       +101.25       +104.75       +612.75  │
│                                                                                                                               │
│ Scroller: overflow-auto max-h-[calc(100dvh-136px)] border-t border-zinc-200/60. NO card wrapper.                              │
│ Table: table-fixed min-w-[1012px] border-separate border-spacing-0 text-[11px] leading-[14px] font-mono tabular-nums          │
│ thead: sticky top-0 z-20 bg-zinc-50, h-8, text-xs uppercase tracking-wider text-zinc-400 font-sans                            │
│ Employee column: sticky left-0 z-10 w-[168px] bg-zinc-50, name text-xs font-medium font-sans text-zinc-900 truncate,          │
│                  ID text-[10px] text-zinc-400. Approved inactive or resigned: bg-zinc-100 text-zinc-500 rounded-full chip     │
│ Week column: sticky right-0 z-10 w-[88px] bg-zinc-50 border-l border-zinc-200/60 text-right font-medium                       │
│ tfoot: sticky bottom-0 z-20 bg-zinc-50 border-t border-zinc-200 h-9 font-medium text-zinc-700. Label: "All employees"         │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Cell Anatomy

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Normal day               Unusual day               Needs fixing              3+ pairs                 No punches      │
│ h-12 px-2 py-[3px]       + bg-amber-50/70          + bg-rose-50              first pair, then         text-zinc-300   │
│                          + border-l-2              + ring-1 ring-inset       second pair + chip       hover: <Plus /> │
│                            border-amber-400          ring-rose-200           text-zinc-500 chip                       │
│ 07:40–13:04              08:00–11:10               18:26–--:--               07:30–11:00              —               │
│ 13:56–17:47                                        "--:--" text-rose-600     11:30–14:00 +1                           │
│ 8.00 +1.25  M E          3.17                      0.00                      8.00 +1.00                               │
│                                                                                                                       │
│ Line 1 and 2: text-zinc-800. Line 3: text-zinc-500, OT part (+1.25) text-zinc-900 font-medium.                        │
│ Markers: right-aligned on line 3, size 12.                                                                            │
│   M = <ArrowsMerge size={12} className="text-zinc-400" aria-label="Merged" />                                         │
│   E = <PencilSimple size={12} className="text-sky-600" aria-label="Edited" />                                         │
│ Focus and open state: ring-2 ring-inset ring-emerald-500.                                                             │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Density Decisions

Sized for the smallest common laptop, 1366×768. Above that, day columns widen and more rows show.

| Decision | Choice | Why |
|---|---|---|
| Width budget | 1366 − 240 sidebar − 80 page padding = 1046px. Employee 168 + Week 88 + 7 days at about 112 each | One pair at `text-[11px]` mono is about 73px, so it fits with `px-2`. Hours plus two markers is about 92px, which also fits |
| Pairs in a cell | **Two, then a `+N` chip.** Row height stays fixed | Two pairs is the normal day in the spec's data (`07:40–13:04, 13:56–17:47`). A variable row height would break scanning for the rare day with more. Hovering shows all pairs, and clicking opens the editor |
| Incomplete pair | Always visible, even past the second pair: the last line becomes the incomplete punch, and the chip counts the rest | It blocks approval, so it can never hide behind a chip. Pairing is in order, so the unpaired punch is always the last |
| Row height | Fixed 48px: three 14px lines + 6px padding | About 9 rows in view at 768px tall. Going lower isn't readable at this size, and hiding times would hide what's being reviewed |
| One scroller | The grid scrolls, the page doesn't | Day headers, names, weekly totals, and daily totals all stay pinned |
| Header | Title and Approve week share one row, and there is no bottom action bar | Saves about 90px, roughly 2 rows |
| No density toggle | One layout only | Exceptions are reached with filters. A compact hours-only mode would remove the times, which are the subject of the review |
| Row order | Employee name, stable | Rows never jump while the user is working |
| Rendering | Plain table with `content-visibility: auto` on rows, no row reveal animation | 100 × 7 cells doesn't need virtualization, and staggered motion across 100 rows would only slow work down |

### Behaviors

- **Opening a day:** click, or Enter on a focused cell, opens the Day Editor (Screen 4) with the grid still visible behind it. Empty cells open the same editor with an empty pair ready to type in.
- **Keyboard:** arrow keys move between cells (`role="grid"` with roving tabindex), Enter opens, Esc closes and returns focus to the cell.
- **Live updates:** every save updates the cell, the row's weekly totals, the daily totals in the footer, the filter counts, and the "Saved 10:42" time, without a page reload.
- **Edits save as you go** and survive leaving the page (E2E-20). The week stays Ready for review.
- **Needs fixing filter:** shows employees with at least one incomplete day, with their other days dimmed to `opacity-40`. The count is days. A fixed row stays visible until the editor closes, so the list doesn't shift mid-task.
- **No punches this week filter:** shows employees with no punches. These don't block approval. Under Open Item 3, this list could be long (33 enrolled of 102 in the October report).
- **Unusual days filter** is an addition to the spec's two filters, for reaching highlighted days without scrolling. It filters only and never blocks. Unusual means under 4 hours, or a single pair over 9 hours; the 9-hour value was tuned against the 29 Oct–4 Nov 2026 eTimeOffice week. A day with no pairs isn't highlighted.
- **Tooltips:** a highlighted cell states its reason, for example "Under 4 hours (3.17)" or "One pair over 9 hours (05:00–14:30)". Icon markers read "Merged" and "Edited".
- **Color is never the only signal:** unusual has a left border, Needs fixing has `--:--`, and the markers are distinct icons.
- **Employee check link:** a text link in the filter bar overflow, "Employee check (2 decisions)".
- **Example dates:** E2E-14's lone 18:26 punch is on 12 Nov, which is in the following week. It is drawn on Fri 6 Nov here so it stays inside the 5–11 Nov example.

### Interactive States

- **Loading:** skeleton header and 10 skeleton rows at the real 48px height, so the layout doesn't shift.
- **Needs fixing at zero:** `<CheckCircle size={48} className="text-zinc-200" />` "Nothing needs fixing." + [Show all employees]. Approve week is now enabled.
- **No punches this week at zero:** "Every employee has at least one punch this week." + [Show all employees].
- **Unusual days at zero:** "No unusual days this week." + [Show all employees].
- **Search with no match:** "No employee matches 'ramesh'." + [Clear search].
- **Save failure:** see Screen 4. The header's "Saved 10:42" becomes `text-rose-600` "Not saved".
- **Page load error:** rose banner, "Couldn't load this week's punches." + [Try again].
- **Week not reviewable:** a No data or Sync failed week redirects to `/attendance`. A week with outstanding codes redirects to Screen 2.
- **Under 1366px:** the table keeps `min-w-[1012px]` and scrolls sideways with the Employee and Week columns pinned.
- **Mobile (under `md`):** the grid is replaced by a list. Each row shows name, weekly Reg and OT, and "1 day Needs fixing" or "Unusual". Tapping shows that employee's 7 days as a vertical list with full pairs, and tapping a day opens the full-screen editor. Filters become a horizontal scroll row. Approve week stays pinned at the bottom. This is for quick fixes. A full review is expected on a laptop.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Grid | Plain `<table>`, not `DataTable` | Needs sticky on all four edges and fixed cell heights |
| Filters | `ToggleGroup` | Single select, with live counts |
| Search | `Input`, `<MagnifyingGlass size={14} />` | Filters by name or Employee ID, client side |
| Cell tooltip | `Tooltip` | `bg-zinc-900 text-white rounded-lg text-xs px-2 py-1`, as in F08 |
| Week status | Badge pattern | See Shared Conventions |

---

## Screen 4: Day Editor (Sheet on Screen 3)

### Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ SheetContent side="right": w-[440px] rounded-l-2xl p-6, no dark overlay, grid stays visible  │
│                                                                                              │
│ Lakshmi Venkatesh                                    [<CaretLeft />] [<CaretRight />]  [X]   │
│ text-lg font-semibold tracking-tight text-zinc-900   Button ghost: previous and next day     │
│ TPLGOAHLP036 · Tue 10 Nov 2026                                                               │
│ font-mono text-xs text-zinc-400                                                              │
│                                                                                              │
│ (Edited) (Merged)      badges: bg-sky-50 text-sky-700, bg-zinc-100 text-zinc-600             │
│                                                                                              │
│ ┌── Day totals: flex divide-x divide-zinc-200 border-t border-b border-zinc-200/60 py-3      │
│ │  REGULAR     OVERTIME     TOTAL                                                            │
│ │  8.00        1.47         9.47         font-mono tabular-nums text-lg font-semibold        │
│ │  Recalculates as soon as a changed time is valid                                           │
│                                                                                              │
│ ┌── Pairs: space-y-2                                                                         │
│ │        IN          OUT         HOURS                                                       │
│ │   1   [07:40]  –  [13:04]      5.40    [<Trash size={14} />]                               │
│ │   2   [13:56]  –  [18:00]      4.07    [<Trash size={14} />]                               │
│ │                                                                                            │
│ │   Input: w-20 h-9 rounded-xl border-zinc-200/60 font-mono tabular-nums text-sm text-center │
│ │          focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500                   │
│ │   Input hover or focus: small <X size={12} /> inside the field deletes that one punch      │
│ │   Edited input: border-sky-300 bg-sky-50/40                                                │
│ │                                                                                            │
│ │   [+ Add pair]   Button ghost sm, <Plus size={14} />, text-emerald-700                     │
│                                                                                              │
│ ┌── Original vs current: border-t border-zinc-200/60 pt-4 (only when something changed)      │
│ │  "Changes"   text-sm font-medium text-zinc-900                                             │
│ │                                                                                            │
│ │  ORIGINAL   CURRENT   NOTE (OPTIONAL)                                                      │
│ │  17:47      18:00     [Gate scanner was down                ]                              │
│ │  —          12:00     [                                     ]    a punch added by hand     │
│ │  13:04      Deleted   [                                     ]    a deleted API punch       │
│ │                                                                                            │
│ │  Original: font-mono text-zinc-400 line-through                                            │
│ │  Current: font-mono text-zinc-900. Deleted: font-sans text-rose-600                        │
│ │  Note: Input h-8 text-xs rounded-lg. Never required                                        │
│                                                                                              │
│ ┌── Merged scans: only when the day has the Merged marker                                    │
│ │  <ArrowsMerge size={14} /> "Merged scans"   text-xs font-medium text-zinc-500              │
│ │  07:40 07:41 → 07:40     17:45 17:46 → 17:45      font-mono text-xs text-zinc-500          │
│                                                                                              │
│ Footer: "Saved 10:42"   text-xs text-zinc-400 (bottom of sheet)                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Validation and Incomplete States

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ OUT before IN (E2E-19)                                                       │
│    1   [07:40]  –  [07:10]      5.40    border-rose-300 on the invalid field │
│    <WarningCircle size={14} /> OUT must be after IN. 07:10 is before 07:40.  │
│    Not saved. Hours are from the last saved times.                           │
│    text-xs text-rose-600, role="alert", directly under the row               │
│                                                                              │
│ Overlapping pairs (E2E-19)                                                   │
│    1   [07:40]  –  [13:04]      5.40                                         │
│    2   [12:50]  –  [17:47]      3.85    border-rose-300 on 12:50             │
│    <WarningCircle size={14} /> Overlaps 07:40–13:04.                         │
│    Not saved. Hours are from the last saved times.                           │
│                                                                              │
│ Invalid time                                                                 │
│    1   [25:10]  –  [13:04]              border-rose-300                      │
│    <WarningCircle size={14} /> Enter a time as HH:mm, for example 07:40.     │
│                                                                              │
│ Incomplete pair (E2E-14)                                                     │
│    Banner: bg-rose-50 border-rose-200/60 rounded-xl p-3                      │
│    <WarningCircle size={16} /> "Needs fixing: this punch has no pair."       │
│    1   [18:26]  –  [--:--]      —       [<Trash size={14} />]                │
│    "If 18:26 was the OUT, enter it as OUT and add the IN."                   │
│    text-xs text-zinc-500                                                     │
│                                                                              │
│ Empty day (no punches, or all deleted)                                       │
│    "No punches on this day."   text-sm text-zinc-400                         │
│    1   [     ]  –  [     ]              first row ready to type in           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **Time entry:** a text input, not native `type="time"`, which would show AM/PM by locale. It accepts `1747` or `17:47`, and displays 24-hour `HH:mm`.
- **Saving:** a field saves on blur or Enter once the whole day is valid. Hours recalculate as soon as the typed value makes a valid day (E2E-18), with no save button. A note is never required.
- **Rejected changes:** the field stays red with its error, and the saved punches are unchanged (E2E-19). Closing the sheet or pressing Esc discards the invalid value and shows the last saved time.
- **Adding a pair:** adds an empty row. A row with only one time saves as an incomplete pair and raises the Needs fixing count. A fully empty row is dropped on close.
- **Deleting:** the row's Trash deletes the pair, and the field's X deletes one punch. Neither needs a confirmation, because the original stays stored and shows under Changes. Deleting can leave a day at zero hours.
- **Next and previous:** the carets step through days for this employee. With the Needs fixing or Unusual days filter on, they step through matching days across employees, so a list can be cleared in one pass.
- **Read-only mode (Screen 6):** inputs become plain text, and Trash, X, Add pair, and note fields are hidden. Changes and Merged scans still show, including saved notes.

### Interactive States

- **Saving:** "Saving…" in the footer. There's no spinner on the field.
- **Save failure:** rose text in the footer, "Couldn't save. Your last saved times are unchanged." + [Try again]. The field stays as typed.
- **Mobile:** full-screen `Sheet`, `w-full`. Inputs `h-11`, `inputMode="numeric"`.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Panel | `Sheet` | Non-modal, so the grid stays visible and updates live. Moves focus into the panel and returns it to the cell on close |
| Time fields | `Input` | Text with `HH:mm` normalization |
| Notes | `Input` | One per changed punch, because Design Notes store a note per punch |
| Errors | Inline `<p role="alert">` | Directly below the row, with an icon |

**Spec gaps, drawn as stated assumptions:** pairing is only defined at load, so this wireframe keeps pairs as they are after an edit, which is the only reading in which an "OUT before IN" error can occur. Deleting one punch empties that field and doesn't re-pair the rest. Whether typing the original time back clears the Edited marker isn't specified.

---

## Screen 5: Approve Week Summary (Dialog on Screen 3)

### Disabled State

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Grid header, Needs fixing above 0:                                                                    │
│                                                                                                       │
│                                        Saved 10:42    [Approve week]                                  │
│                                                       cursor-not-allowed bg-emerald-600/40 text-white │
│                                                       <Tooltip>: "3 days need fixing first"           │
│                                                                                                       │
│ Next to the button: "3 days Needs fixing"   text-xs font-medium text-rose-600,                        │
│                                             click selects the Needs fixing filter                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Dialog: rounded-2xl max-w-lg                                                                       │
│                                                                                                    │
│ h2: "Approve week"                                                                [X]              │
│ text-lg font-semibold tracking-tight text-zinc-900                                                 │
│ p: "5 Nov – 11 Nov 2026"   text-sm text-zinc-500                                                   │
│                                                                                                    │
│ ┌── Summary strip: grid grid-cols-2 gap-4 border-t border-b border-zinc-200/60 py-4                │
│ │  EMPLOYEES        EDITED DAYS                                                                    │
│ │  96               7                                                                              │
│ │  REGULAR HOURS    OVERTIME HOURS                                                                 │
│ │  4,512.50         612.75                                                                         │
│ │  label: text-xs uppercase tracking-wider text-zinc-400                                           │
│ │  value: text-lg font-mono tabular-nums font-semibold text-zinc-900                               │
│                                                                                                    │
│ ┌── Left out of payroll: pt-4                                                                      │
│ │  "6 employees left out, no payslip"   text-sm font-medium text-zinc-900                          │
│ │  max-h-48 overflow-y-auto divide-y divide-zinc-100                                               │
│ │                                                                                                  │
│ │  Ravi Kumar       TPLGOAHLP077   Zero hours                                                      │
│ │  Asha Menon       TPLGOAHLP081   Zero hours                                                      │
│ │  Harish Pillai    TPLGOAHLP052   Rejected in employee check                                      │
│ │  ...                                                                                             │
│ │  Name: text-sm text-zinc-900. ID: font-mono text-xs text-zinc-400. Reason: text-xs text-zinc-500 │
│                                                                                                    │
│ ┌── Edited days: Collapsible, closed by default                                                    │
│ │  ▸ "7 edited days"                                                                               │
│ │  Lakshmi Venkatesh   Tue 10 Nov   13:56–17:47 → 13:56–18:00                                      │
│                                                                                                    │
│ p: "Approving locks the week and makes it available to payroll."                                   │
│ text-sm text-zinc-500                                                                              │
│                                                                                                    │
│ Actions: flex justify-end gap-3 pt-4                                                               │
│                                                    [Cancel]    [Approve week]                      │
│                                                    outline     emerald, active:scale-[0.98]        │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- Approve week is disabled while the Needs fixing count is above zero, and enabled once it reaches zero (E2E-14). No-punch employees and unusual days never disable it (E2E-15, E2E-16).
- The summary opens only when enabled. The server rechecks on confirm.
- After approving, the page changes to the Approved view (Screen 6), with a toast "Week approved" and [Go to payroll].
- Clicking a left-out employee closes the dialog and filters the grid to that employee, in case they need hand entry. A rejected employee has no grid row, so that row isn't clickable.

### Interactive States

- **Loading summary:** skeleton values in the strip.
- **Approving:** "Approving…" with `<CircleNotch className="animate-spin" />`. Cancel disabled.
- **Approve failure:** rose banner inside the dialog, "Couldn't approve the week. Nothing was changed." The dialog stays open.
- **Blocked at confirm:** if another tab left an incomplete pair, "1 day Needs fixing. Fix it before approving." + [Show days].
- **Nobody left out:** "No employees left out." in `text-sm text-zinc-400`.
- **Mobile:** full-height `Sheet` from the bottom, with sticky actions.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Summary | `Dialog` | Not `AlertDialog`, because it holds lists |
| Left-out list | `div` with `ScrollArea` | Stays short even with many no-punch employees |
| Edited days | `Collapsible` | Shows original and current pairs |
| Disabled tooltip | `Tooltip` around a `span` | A disabled button doesn't fire hover events |

---

## Screen 6: Approved Week View (`/attendance/[weekId]/review`, locked)

The same grid as Screen 3, read-only, so hours can be compared against payroll without learning a second layout.

### Layout: Payroll Not Yet Approved

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Attendance]  h1: "Punch review"  5 Nov – 11 Nov 2026  [Approved]             [Reopen]   [Go to payroll →]          │
│                                                                                 outline    emerald link to            │
│                                                                                            /payroll/generate/[weekId] │
│ "Approved 13 Nov, 10:42 · 96 employees · 4,512.50 regular · 612.75 overtime · 6 left out"                             │
│ text-xs text-zinc-500                                                                                                 │
│                                                                                                                       │
│ Filter bar: (All 101) (No punches this week 5) (Unusual days 12)  [Search name or ID]                                 │
│ Needs fixing is removed, because it's always 0 here                                                                   │
│                                                                                                                       │
│ Grid: same as Screen 3. Cells are not editable. hover:bg-zinc-100, cursor-pointer.                                    │
│ Click opens the Day Editor in read-only mode. Merged and Edited markers stay.                                         │
│                                                                                                                       │
│ Reopen confirmation: AlertDialog rounded-2xl                                                                          │
│   "Reopen this week?"                                                                                                 │
│   "Payroll can't use this week until you approve it again. No revision is created,                                    │
│    and eTimeOffice isn't pulled again."                                                                               │
│                                                     [Cancel]   [Reopen]                                               │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout: Payroll Approved, Reopen Unavailable

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Attendance]  h1: "Punch review"  5 Nov – 11 Nov 2026  [Approved]             [Open payroll run →]        │
│                                                                                 outline, link to            │
│                                                                                 /payroll/run/[payrollRunId] │
│ "Approved 13 Nov, 10:42 · 96 employees · 4,512.50 regular · 612.75 overtime · 6 left out"                   │
│                                                                                                             │
│ ┌── Info line: flex items-start gap-2.5 text-sm text-zinc-500                                               │
│ │  <Lock size={16} className="text-zinc-400" />                                                             │
│ │  "Payroll for this week is approved (Revision 1). To change punches, use Correct on the payroll run."     │
│                                                                                                             │
│ Grid: same, read-only. No [Reopen] button is rendered at all (E2E-23).                                      │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **Reopen** returns the week to Ready for review, and the same punches and edits come back in the editable grid. Payroll can't use the week until it's approved again, and then uses the new hours (E2E-22).
- **Correct is not on this page.** It stays on the payroll run (E2E-23), so this page links there.
- **While a correction is in progress:** this view keeps showing the approved hours (E2E-25). The info line adds "A correction is in progress." with a link to it.

### Interactive States

- **Reopening:** "Reopening…" with spinner, inside the dialog.
- **Reopen refused:** if payroll was approved in the meantime, "Payroll for this week was approved. Reopen is no longer available." The page then shows the second layout.
- **Mobile:** same mobile list as Screen 3, read-only. Actions stack under the title.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Reopen | `Button` outline + `AlertDialog` | `<ArrowCounterClockwise size={14} />` |
| Locked note | `<p>` with `Lock` icon | Same pattern as the shipped help text in `AttendancePreviewClient` |

**Note:** the shipped `PayrollRunStatus` has no draft status (`NOT_GENERATED`, `APPROVED`, `REVISED`), so these two layouts cover every case.

---

## Screen 7: Correct Flow (`/payroll/run/[payrollRunId]/correct`)

Three steps inside the existing correction: reason and types, the same grid, then the revised pay preview. The entry button on the payroll run keeps its place, and its label changes from "Correct Payroll" to "Correct". This uses the shipped routes, not the older `/payroll/[runId]/correct` in the F08 wireframes.

### Step 1: Reason and Correction Type

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Cancel Correction]   text-sm text-zinc-500, <ArrowLeft size={16} />                        │
│                                                                                               │
│ h1: "Payroll Correction"                                                                      │
│ p: "5 Nov – 11 Nov 2026 · Revision 1 stays current until the new one is approved"             │
│ text-sm text-zinc-500                                                                         │
│                                                                                               │
│ ┌── Section: Reason   border-t border-zinc-200/60 pt-8                                        │
│ │  CORRECTION REASON (OPTIONAL)                                                               │
│ │  text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5                          │
│ │  [Input: e.g. "Overtime hours were miscalculated for 2 employees"            ]              │
│ │  rounded-xl border-zinc-200/60 focus:ring-2 focus:ring-emerald-500/40                       │
│                                                                                               │
│ ┌── Section: Correction Type   border-t border-zinc-200/60 pt-8                               │
│ │  "What do you want to correct?"   text-sm font-medium text-zinc-900 mb-4                    │
│ │                                                                                             │
│ │  [ ] Adjustments                                                                            │
│ │      Modify deductions or additions                                                         │
│ │  [x] Attendance                                                                             │
│ │      Edit this week's punches                     was: "Upload a corrected attendance file" │
│ │  [ ] Employee data updated                                                                  │
│ │      Recalculate with current employee directory data                                       │
│                                                                                               │
│    The AttendanceDropzone section is removed. Nothing replaces it on this step.               │
│                                                                                               │
│ Actions: flex justify-end gap-3 border-t border-zinc-200/60 pt-8                              │
│                                           [Cancel]   [Continue to punches →]                  │
│ Attendance selected: "Continue to punches →".                                                 │
│ Attendance not selected: "Recalculate & Preview →", as shipped.                               │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Step 2: Same Grid, Correction Mode (`.../correct/punches`, proposed route)

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [← Reason]  h1: "Correct punches"  5 Nov – 11 Nov 2026  (Revision 1 current)     Saved 10:42   [Approve week] │
│                                                         bg-emerald-50 text-emerald-700                        │
│                                                                                                               │
│ ┌── Banner: flex items-center gap-3 rounded-xl border border-amber-200/60 bg-amber-50 px-4 py-2 text-sm       │
│ │  <PencilSimple size={16} className="text-amber-500" />                                                      │
│ │  "Correction in progress: 1 day changed. Revision 1 stays in effect until the new one is approved."         │
│ │                                                                            [Cancel correction]              │
│ │  One line, so the grid keeps its row count. Add "Reason: …" only when a reason was entered                  │
│                                                                                                               │
│ Filter bar and grid: identical to Screen 3, and starts from the approved punches.                             │
│ Day Editor: identical to Screen 4. Validation rules are the same.                                             │
│ Needs fixing and the Approve week disabled state work the same way.                                           │
│                                                                                                               │
│ Approve week opens the Screen 5 summary, with one added line:                                                 │
│   "1 day changed in this correction"                                                                          │
│ Confirming shows "Recalculating…" and moves to Step 3.                                                        │
│                                                                                                               │
│ Cancel confirmation: AlertDialog rounded-2xl                                                                  │
│   "Discard this correction?"                                                                                  │
│   "3 punch edits will be discarded. The approved hours and Revision 1 stay as they are."                      │
│                                               [Keep editing]   [Discard correction]                           │
│                                                                bg-rose-600 text-white rounded-xl              │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Step 3: Revised Pay Preview (`.../correct/preview`)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ h1: "Revised Payroll"                                                                                                      │
│ (Revision 2)   5 Nov – 11 Nov 2026 · Revision 1 stays current until you approve                                            │
│ bg-amber-50 text-amber-700                                                                                                 │
│                                                                                                                            │
│ ┌── Summary table: unchanged RevisedPreview table, text-xs font-mono tabular-nums                                          │
│ │  ID             Employee            GPay        Bank        Net Pay                                                      │
│ │  ─────────────  ──────────────────  ──────────  ──────────  ───────────                                                  │
│ │  TPLGOAHLP036   Lakshmi Venkatesh   98xxxxxx12  —           ₹3,120.40    text-emerald-600, tooltip "Previous: ₹3,105.80" │
│ │  TPLGOAHLP077   Ravi Kumar          98xxxxxx45  —           ₹2,300.00    (New) bg-zinc-100 text-zinc-600 chip            │
│ │  TPLGOAHLP081   Asha Menon          98xxxxxx77  —           Left out     text-rose-600, tooltip "Previous: ₹1,150.00"    │
│ │  TOTALS                                                     ₹2,84,412.50                                                 │
│                                                                                                                            │
│ Actions: flex justify-between border-t border-zinc-200/60 pt-6                                                             │
│ [← Back]    [Cancel correction]                          [Approve Revision]                                                │
│ Back returns to Step 2 with edits intact (or Step 1 if Attendance wasn't selected).                                        │
│                                                                                                                            │
│ AlertDialog as shipped: "Approve this revised payroll? The previous revision will be superseded."                          │
│                                                          [Cancel]  [Confirm Revision]                                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **The reason is optional.** A blank reason doesn't block Continue (E2E-24). The label matches today's "Correction Reason (optional)".
- **Revision stays current** throughout steps 1–3. The new revision only becomes current on Confirm Revision, and revision history then shows Revision 1 as Superseded.
- **Abandoning:** Cancel Correction or Discard correction deletes this correction's punch edits, and the approved hours and current revision stay unchanged (E2E-25). The dialog only appears when there are edits.
- **No API call and no upload** anywhere in this flow (E2E-24, E2E-28).
- **Row changes in preview:** employees going from zero hours to paid show a New chip, and those going to zero show Left out, using the existing diff colors and tooltip.

### Interactive States

- **Recalculating:** shimmer bar + "Recalculating…", as shipped.
- **Recalculation failure:** existing rose error banner. The user stays on the grid with edits intact.
- **Mobile:** Steps 1 and 3 work as shipped. Step 2 uses the Screen 3 mobile list, with the banner above it.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Correct | Existing form + `Button` outline | Label change only, `<PencilSimple size={14} />` stays |
| Step 1 | `CorrectionFlow` | Dropzone, week dialog, verification dialog, and upload session code removed |
| Step 2 | Reused grid and Day Editor | Takes a `mode` prop. Edits are stored apart from the approved punches until the revision is approved |
| Step 3 | `RevisedPreview` | Adds New and Left out, plus Cancel correction |

**Spec gaps, not resolved here:**

- **Shipped behavior conflicts with the preview step.** `recalculateAndCreateRevision` supersedes the current revision and creates the new one as approved in one go, and `CorrectionFlow` then skips straight to the payroll run. The spec needs Revision 1 to stay current until approval.
- **Correction types.** The spec says Correct "opens the same grid", while the existing flow has three types and the spec keeps adjustment handling. Drawn so the grid only opens when Attendance is selected.
- **Excel-era runs.** Selecting Attendance on a run from the Excel era has no defined behavior, because there's no upload and no pairs to edit. Not drawn.
- **What "abandoning" covers.** Only explicit cancel is drawn. Closing the tab and returning isn't specified, nor whether audit entries for discarded edits remain.
- **Approve label in correction mode.** E2E-24 says "approves the punches" without naming the control. Drawn as Approve week, since it's the same grid.

---

## Screen 8: Payslip Table (PDF, API weeks)

Changes the attendance table in `generatePayrollSlipPdf`. This is a pdfmake document, so there are no Tailwind classes or ShadCN components here.

### Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ WEEKLY PAYROLL SLIP                                                                                              │
│ Employee ID: TPLGOAHLP036              Name: Lakshmi Venkatesh                                                   │
│                                                                                                                  │
│ ┌──────┬───────────┬───────────────────────────────────────┬─────────┬────────┐                                  │
│ │ Day  │ Date      │ Punches                               │ Reg Hrs │ OT Hrs │  tableHeader, fillColor #dddddd  │
│ ├──────┼───────────┼───────────────────────────────────────┼─────────┼────────┤                                  │
│ │ Thu  │ 05-Nov-26 │ 07:40–13:04, 13:56–17:47              │    8.00 │   1.25 │                                  │
│ │ Fri  │ 06-Nov-26 │ 07:40–13:04, 13:56–17:47              │    8.00 │   1.25 │                                  │
│ │ Sat  │ 07-Nov-26 │ 07:30–11:00, 11:30–14:00,             │    8.00 │   1.00 │  long line wraps at a comma      │
│ │      │           │ 15:00–18:00                           │         │        │                                  │
│ │ Sun  │ 08-Nov-26 │ -                                     │       - │      - │  same "-" as today's empty cells │
│ │ Mon  │ 09-Nov-26 │ 07:40–13:04, 13:56–17:47              │    8.00 │   1.25 │                                  │
│ │ Tue  │ 10-Nov-26 │ 07:40–13:04, 13:56–18:00              │    8.00 │   1.47 │  edited, looks the same          │
│ │ Wed  │ 11-Nov-26 │ 07:40–13:04, 13:56–17:47              │    8.00 │   1.25 │                                  │
│ ├──────┴───────────┴───────────────────────────────────────┼─────────┼────────┤                                  │
│ │                                                     TOTAL│   48.00 │   7.47 │  colSpan 3, bold                 │
│ └──────────────────────────────────────────────────────────┴─────────┴────────┘                                  │
│                                                                                                                  │
│ Punches: font Courier, left aligned, width '*'                                                                   │
│ Reg Hrs, OT Hrs: font Courier, right aligned, as shipped                                                         │
│ Earnings table below: unchanged                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- **Layout follows the week's source, not its contents.** API weeks use this table. Excel-era weeks keep the shipped six In/Out columns unchanged (E2E-27).
- **No markers on the slip.** Edited and original punches look the same, and there's no Merged or note text.
- **Never split a pair.** Wrap only after a comma, so `07:40–13:04` stays on one line. Check the en dash renders in the Courier PDF font.
- **Hours match the grid** (E2E-26). No BN, AN, or OT In/Out columns.

---

## Screen 9: Payroll Flow Changes

### Layout: Week List (`/payroll`, `PayrollWeekList`)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Table: as shipped, NO card wrapper                                                               │
│                                                                                                  │
│ Week                     Attendance          Payroll         Action                              │
│ ───────────────────────  ──────────────────  ──────────────  ──────────────                      │
│ 5 Nov – 11 Nov 2026      Ready for review    Not generated   [Generate] disabled                 │
│ 29 Oct – 4 Nov 2026      Sync failed         Not generated   [Generate] disabled                 │
│ 22 Oct – 28 Oct 2026     No data             Not generated   [Generate] disabled                 │
│ 15 Oct – 21 Oct 2026     Approved            Not generated   [Generate]                          │
│ 8 Oct – 14 Oct 2026      Approved            Approved        [View]                              │
│                                                                                                  │
│ Attendance: the Week Status Badges from Shared Conventions, replacing Ready / Errors / No upload │
│ Each attendance status links to its week on /attendance                                          │
│ Disabled Generate: cursor-not-allowed bg-emerald-600/40, title attribute per the table below     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Attendance status | Disabled Generate title (today's copy → new copy) |
|---|---|
| Ready for review | "Resolve attendance errors first" → "Approve this week's attendance first" |
| Sync failed | "Upload attendance first" → "Load this week's attendance first" |
| No data | "Upload attendance first" → "Load this week's attendance first" |

### Layout: Week List Empty State

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ rounded-2xl border border-zinc-200/60 bg-zinc-50/50 px-6 py-14 text-center                                    │
│                                                                                                               │
│ "No attendance weeks found."                            was: "No attendance uploads found."                   │
│ text-sm font-medium text-zinc-500                                                                             │
│ "Go to Attendance to load a week and begin payroll."    was: "Upload attendance to begin generating payroll." │
│ text-xs text-zinc-400, "Attendance" links to /attendance                                                      │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout: Attendance Step (`AttendanceVerificationStep`)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ h2: "Verify Attendance"                                                                                        │
│ p: "5 Nov – 11 Nov 2026"                                                                                       │
│                                                                                                                │
│ Not approved variants: rounded-xl border border-amber-200/60 bg-amber-50 p-4                                   │
│ <WarningCircle size={20} weight="fill" className="text-amber-500" />                                           │
│                                                                                                                │
│   No data:                                                                                                     │
│     "No attendance loaded for this week"            text-sm font-medium text-amber-800                         │
│     Go to Attendance →                              text-xs font-medium text-amber-700 underline, /attendance  │
│                                                                                                                │
│   Sync failed:                                                                                                 │
│     "The eTimeOffice sync failed for this week"                                                                │
│     Go to Attendance →                              /attendance                                                │
│                                                                                                                │
│   Ready for review:                                                                                            │
│     "Attendance for this week isn't approved yet"                                                              │
│     Review punches →                                /attendance/[weekId]/review                                │
│                                                                                                                │
│ Approved variant: rounded-xl border border-emerald-200/60 bg-emerald-50 p-4                                    │
│ <CheckCircle size={20} weight="fill" className="text-emerald-500" />                                           │
│     "Attendance approved: 96 employees, 6 left out"                                                            │
│                                                     was: "Attendance verified — N employees matched, 0 errors" │
│                                                                                                                │
│ ┌── Quick stats: flex divide-x divide-zinc-200/60 border-b border-t border-zinc-200/60 py-4                    │
│ │  TOTAL EMPLOYEES   TOTAL REGULAR HRS   TOTAL OVERTIME HRS                                                    │
│ │  96                4,512.50            612.75                                                                │
│                                                                                                                │
│                                                                       [Continue →]                             │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- Generate and Continue are only available for Approved weeks (E2E-21).
- **Two decimals here.** The step's stats use `toFixed(1)` today. They become two decimals so hours match the review grid (E2E-21).
- `AttendanceReadinessResult.reason` replaces `NO_UPLOAD` and `UNRESOLVED_ERRORS` with values for the three cases above.
- **Reopened mid-flow:** if the week is reopened while this flow is open in another tab, generating fails with the Ready for review alert.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Attendance badge | `AttendanceBadge` | New statuses, wrapped in a link to the week |
| Alerts | Existing `div` pattern | Copy and links only. No layout change |
| Empty state | `EmptyState` | Copy only |

**Spec gaps:**

- **Excel weeks with no payroll.** Existing rows "must count as approved", but payroll "must only accept approved API weeks", and Pull now is only for weeks with no data. Whether Generate is offered for such a week is unsettled, as is how an upload with status Errors counts. Drawn only for weeks with approved payroll.
- **Dashboard.** The "Pending Attendance Flags" card links to `/attendance`, and the spec doesn't say what it counts now.

---

## Screen 10: Settings, Week Start Locked (`/settings`)

The payroll week start is locked to Thursday. It becomes a read-only value in `SettingsForm`.

### Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ┌── Section: Payroll Configuration   border-t border-zinc-200/60 pt-8 pb-8                          │
│ │  h2: "Payroll Configuration"   text-sm font-medium text-zinc-900 mb-6                             │
│ │                                                                                                   │
│ │  dl: same pattern as Display Defaults, max-w-md                                                   │
│ │  PAYROLL WEEK START DAY        dt: text-xs uppercase tracking-wider text-zinc-400 mb-1            │
│ │  Thursday  (Locked)            dd: text-sm text-zinc-600 flex items-center gap-2                  │
│ │                                Locked: bg-zinc-100 text-zinc-400 rounded-full text-xs px-2 py-0.5 │
│ │                                        with <Lock size={12} />                                    │
│ │                                                                                                   │
│ │  "The payroll week runs Thursday to Wednesday, matching the eTimeOffice sync."                    │
│ │  text-sm text-zinc-400 mt-2 max-w-[65ch] leading-relaxed                                          │
│                                                                                                     │
│ ┌── Section: Display Defaults   unchanged                                                           │
│ │  Currency: ₹ INR     Document Expiry Threshold: 7 days (Phase 2)                                  │
│                                                                                                     │
│    The select is removed. The "Save Settings" action row is removed,                                │
│    because this was the only editable field.                                                        │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Behaviors

- A plain value rather than a disabled `select`, because there's nothing to choose from and it matches the read-only fields already on this page.
- `updateSettingsAction` rejects any request to change the day (E2E-29). The form no longer calls it.
- With nothing left to submit, `SettingsForm` no longer needs `useForm`, and the toast and pending states go away.

### Component Breakdown

| Element | Component | Behavior |
|---|---|---|
| Week start | `dl` / `dt` / `dd` | Same classes as Display Defaults |
| Locked chip | `span` | Same classes as the "Phase 2" chip |
