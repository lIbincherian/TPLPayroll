# F12 — eTimeOffice Attendance Sync & Punch Review

> **Status: 📝 PLANNED**

## Goal

Replace the Excel attendance upload with a weekly sync from the eTimeOffice face recognition system, so the Payroll Owner can review, edit, and approve every employee's punch times before preparing the weekly payroll.

The old attendance machine is retired, so eTimeOffice becomes the only source of attendance data. This feature replaces [F04 — Attendance Upload](../F04-attendance-upload/feature-spec.md) and changes parts of [F07](../F07-payroll-reports/feature-spec.md) and [F08](../F08-payroll-correction/feature-spec.md).

## Scope

- Sync one Thursday–Wednesday payroll week from eTimeOffice every Thursday morning.
- Let the user pull any week manually, including to retry a failure or to test. A new pull replaces the previous one.
- Match eTimeOffice employee codes to the employee master, and let the user add, match, or ignore unknown codes.
- Show every active employee's punches as a flexible list of in/out pairs, and allow editing.
- Calculate daily regular and overtime hours from the pairs.
- Block approval until every incomplete pair is fixed.
- Approve one week at a time, then pass the hours to the existing payroll flow.
- Reopen a week before its payroll is approved, and correct it after.
- Show punches in one column on payslips for API weeks.
- Remove the Excel attendance upload in the same release.

### Out of Scope (MVP)

- **Emergency file import.** Planned for later. Until it exists, a long eTimeOffice outage delays payroll. It will need an export with every punch, because the periodic report only has the first IN and last OUT.
- **User logins.** Access stays as it is, and the audit log records what changed and when, but not who changed it.
- **Overnight shifts.** Nobody works past midnight, so each calendar day stands alone.
- **Automatic break deductions.** See [Hours](#hours).
- **Per-employee approval and partial payroll runs.**

## User Flow

```
Thursday ~06:00 IST     Scheduled sync loads Thu 00:00 – Wed 23:59
        │
        ├── failed ───► Week shows "Sync failed" + [Pull now]
        ▼               ([Pull now] is available any time before approval)
Employee check          Add, match, or ignore unknown codes
                        Decide on inactive / resigned employees
        ▼
Punch review            All active employees, in/out pairs per day
                        Filters: Needs fixing, No punches this week
                        Edits save as you go
        ▼
Approve week            Enabled once the week has ended and no
                        incomplete pairs remain
                        Summary, then the week locks
        ▼
Payroll                 Existing generation flow, adjustments, slips
```

## Business Rules

### Sync

- The schedule is `30 0 * * 4` UTC, which is Thursday 06:00 IST. Vercel Hobby plans may fire any time within that hour.
- The week covers Thursday 00:00 to Wednesday 23:59 for all employees (`Empcode=ALL`).
- Pulling does not lock a week. Only **Approve week** does.
- **Pull now** is available on any Thu–Wed week that isn't approved, including a week still in progress. It is not available on Excel-era weeks.
- The week list always includes the last completed Thu–Wed week, so a sync that never ran still shows **Pull now**.
- A new pull replaces the previous pull, including punch edits, notes, and employee decisions for that week.
  - If the week has edits or decisions, a warning shows first, for example "This will discard 12 edited days and your employee decisions."
  - Discarded edits stay in the audit log.
- An approved week must be reopened before it can be pulled. A week with approved payroll can't be pulled, and changes go through **Correct**.
- The scheduled sync replaces an earlier pull that has no edits or decisions. If the week has edits or decisions, the sync leaves it alone and shows a notice that newer data may be available.
- The payroll week start is locked to Thursday. The F10 Settings page shows it read-only and can't change it. If the stored value isn't Thursday, the release changes it to Thursday.
- A sync or pull fails, and changes nothing, on any of these:
  - a timeout or network error
  - a non-200 status
  - `Error: true`
  - a response or row that can't be parsed
  - no punches at all for the requested period
- After a failure, any previous data stays in place and the error is shown. A week with no data shows **Sync failed**.
- API timestamps are treated as local wall-clock times, with no timezone conversion. Seconds are dropped on load.

### Employee Matching

- An eTimeOffice code matches an employee when its number equals the digits at the end of the Employee ID, ignoring leading zeros. `0036` matches `TPLGOAHLP036`.
- All trailing digits are read, so `1000` needs an Employee ID ending in `1000`. The old matcher kept only three digits.
- Names are never used to match.
- A code that matches no employee, or more than one, must be resolved in the employee check before the punch review opens. The check shows the code and the name eTimeOffice has for it, with these options:
  - **Add as new employee** opens the new employee form and returns to the check.
  - **Match to existing employee** picks from a searchable list, and the link is saved for future pulls.
  - **Ignore this code** leaves the code out of the review and payroll, and the choice carries over to future pulls.
- Saved links and ignored codes are stored only for these exceptions, and they survive a new pull. Every other code still matches on its number.
- Inactive employees and employees who resigned before the week need an approve or reject decision, as they do today. They only need one if they have punches. All decisions must be made before the punch review opens, and they can be changed after **Reopen**.

### Pairing and Duplicate Scans

- Each day's punches are sorted by time and paired in order: first with second, third with fourth, and so on.
- Scans within 10 minutes of the punch being kept (inclusive) merge into that earlier punch. A later scan outside the window starts a new punch. The original scans are kept, and the day shows a **Merged** marker.
- The 10-minute window was tuned against the 29 Oct–4 Nov 2026 eTimeOffice week, where repeat scans came 5 to 10 minutes apart.
- An odd number of punches leaves an **incomplete pair**.
- No punch is treated as special. Exact 10:00 and 10:30 punches pair like any others.
- Pairing and merging happen only on load. Editing or deleting a punch doesn't re-pair the others, and times entered by hand aren't merged.

### Hours

```
dailyTotal    = sum(OUT − IN) for each complete pair
regularHours  = min(dailyTotal, 8)
overtimeHours = max(0, dailyTotal − 8)
```

- The 8-hour rule applies per day. There is no weekly threshold.
- The app calculates overtime itself, and ignores the vendor's `OverTime` and `WorkTime` values.
- Time inside a pair is paid, and gaps between pairs are not. No break is deducted automatically. If a specific case needs the 10:00–10:30 break, the user adds it by hand.
- Hours keep the existing two decimals, rounded on the daily total.

### Review Grid

- The grid lists every active employee: `isActive = true`, not resigned before the week. It also lists inactive or resigned employees approved in the employee check.
- **Needs fixing** shows days with an incomplete pair. These block approval.
- **No punches this week** shows employees with no punches. These don't block approval, and the user can add pairs by hand.
- Complete days that look unusual are highlighted without blocking approval: a day under 4 hours, or a single pair over 9 hours. A day with no punches isn't flagged. The 9-hour value was tuned against the 29 Oct–4 Nov 2026 eTimeOffice week, where early shifts such as 05:13–13:45 are normal; the 4-hour value is unchanged.
- The user can change any time in a day, add or delete a pair, or delete a stray punch. Deleting can leave a day at zero hours.
- Saved times must be valid `HH:mm`, each OUT must be after its IN, and pairs can't overlap.

### Edit History

- The original API time is never overwritten.
- An edited day shows an **Edited** marker with the original and current times. Typing the original time back clears the marker.
- A note is optional.
- The audit log records each change and when it happened, along with syncs, pulls, approvals, reopens, and employee decisions. `AuditLog` and its types must be extended to cover attendance.

### Approval

- There is one approval per week, with no per-employee sign-off.
- **Approve week** stays disabled until the week has ended, so payroll can't run on a partial week.
- Before approving, a summary shows the employee count, total regular and overtime hours, edited days, and the employees being left out.
- Approval locks the week and makes it available to payroll.
- Employees with zero total hours for the week are left out of the payroll run and get no payslip.
- Rejected inactive or resigned employees are also left out.
- Pending additions and deductions for a left-out employee carry forward to the next week they're paid.

### Reopening and Correcting

- **Before payroll is approved:** **Reopen** unlocks the week with no revision.
- **After payroll is approved:** **Correct** offers an optional reason. If **Attendance** is selected, it opens the same grid. It then shows the revised pay preview and creates a new `PayrollRevision`.
  - Adjustment-only corrections skip the grid.
  - The current revision stays in effect until the new one is approved. This changes today's behavior for all corrections, because `recalculateAndCreateRevision` replaces the current revision during recalculation.
  - Abandoning a correction discards its punch edits. Those edits stay in the audit log, marked as discarded.
  - Existing revision history, adjustment handling, and slip regeneration stay in place.
- Neither path pulls from the API.

### Payslips

- API weeks replace the six In/Out columns with one **Punches** column, for example `07:40–13:04, 13:56–17:47`. Long lines wrap.
- Edited and original punches look the same on the slip. A day with no punches shows `-`.
- Weeks from the Excel era keep the six-column layout.

### Excel Upload Removal

- The upload, its parser, week detection, upload sessions, replace flow, and related UI are removed.
- The upload dependencies in the correction flow and in `/employees/new` are replaced.
- Existing `AttendanceUpload` and `AttendanceRecord` rows stay, so past weeks, history, and slips still open.
- Excel-era weeks become read-only, with a read-only view replacing the upload preview page:
  - They can't be pulled, reopened, or edited.
  - Excel-era weeks without approved payroll can't start payroll after release.
  - Excel-era payroll runs can still have adjustment-only corrections, but not attendance corrections.

## API Integration

| Item | Value |
|---|---|
| Provider | eTimeOffice, `https://api.etimeoffice.com/api/` |
| Endpoint | `GET /DownloadPunchDataMCID`, chosen because it returns the `Error` status and machine ID |
| Parameters | `Empcode=ALL`, `FromDate`, `ToDate`, formatted `dd/MM/yyyy_HH:mm` |
| Auth | HTTP Basic, Base64 of `Corporateid:Username:Password:True` |
| Punch time format | `PunchDate`, formatted `dd/MM/yyyy HH:mm:ss` |

- The incremental `DownloadLastPunchData` endpoint isn't needed, because each pull fetches the full requested period.
- The login is stored in environment variables, kept separate for Vercel Production and Preview. It must never be committed or sent to the client.
- The sync route requires `CRON_SECRET`.
- New variables must be added to the environment section of `AGENTS.md`.

## Design Notes

To be finalized in the implementation plan.

- **Payroll stays source-agnostic.** Approved weeks still produce `AttendanceRecord` daily regular and overtime hours, so payroll calculations don't change.
- **Pairs need new storage.** The six slot columns can't hold a flexible list. Each punch needs its original API value, its current value, and any note.
- **`AttendanceUpload` needs changes.** `fileName` and `fileType` are required today, and `status` has no sync or review lifecycle. Existing rows must count as approved.
- **Payroll readiness must change.** `getAvailablePayrollWeeks`, `checkAttendanceReadiness`, and payroll generation must only accept approved API weeks for new payroll. Excel-era weeks with approved payroll stay readable.
- **Code exceptions need storage.** Saved matches and ignored codes persist across pulls, separately from the week's data.
- **Feature slice.** New code goes in `src/features/attendance-sync/`, following the project's feature slice rule.

## Open Items

These need answers before or during the build:

1. **Real API response.** Needs the eTimeOffice login in `.env.local` or a raw sample for 1–7 Oct. It should confirm:
   - the response format
   - whether 10:00 and 10:30 punches still appear
   - the auth format (the doc's Base64 example decodes to `support:support:support:true:`, but its plain-text example is `support:support:support@1:true`)
2. **First live week.** Assumed to be 5–11 Nov 2026, synced on Thursday 12 Nov. To be confirmed.
3. **Enrollment.** The 7–13 Oct report has 33 employees and the legacy file has 102. Anyone not enrolled needs hand entry, so the current count is needed.
4. **Employee `1000`.** Confirm this employee's ID in the app ends in `1000`.
5. **Production access.** Access stays as it is by decision. Confirm whether Vercel protects Production, because an open URL would let anyone with the link edit punches and approve a week.
6. **Unfinished Excel-era weeks.** Any Excel-era week that still needs payroll must be run before release, because it can't start payroll afterward.

## Known Effects

- Full days that previously had 10:00 and 10:30 punches count 30 minutes more if the API doesn't return them. For example, 07:40–13:04 and 13:56–17:47 is 9.25 hours, up from 8.75, so overtime goes from 0.75 to 1.25.
- Hours may not match eTimeOffice's own `Work+OT` report. The app's figure is the one used for pay.

---

## E2E Behavior Tests

### E2E-01: Scheduled sync loads the completed week

```
GIVEN it is Thursday 12 Nov 2026, 06:00 IST
AND the 5–11 Nov week has no attendance data
WHEN the scheduled sync runs with a valid CRON_SECRET
THEN punches from 05/11/2026 00:00 to 11/11/2026 23:59 are loaded for all employees
AND the week shows "Ready for review"
AND the week is not available to payroll
```

### E2E-02: Sync route rejects a missing secret

```
GIVEN a request to the sync route without a valid CRON_SECRET
WHEN the route is called
THEN the request is rejected
AND no API call or database change is made
```

### E2E-03: Failed sync offers Pull now

```
GIVEN the eTimeOffice API returns a 500, or a 200 with Error = true
WHEN the scheduled sync runs
THEN the week shows "Sync failed" with the error
AND no punches are stored
AND a [Pull now] button is available
WHEN the API recovers and the user clicks [Pull now]
THEN the week loads and shows "Ready for review"
```

### E2E-04: Empty response does not freeze the week

```
GIVEN the API returns success with no punches for the week
WHEN the sync runs
THEN the week shows "Sync failed"
AND [Pull now] remains available
```

### E2E-05: Scheduled sync leaves an edited week alone

```
GIVEN the 5–11 Nov week was pulled on Monday and the user has edited punches
WHEN the scheduled sync runs on Thursday
THEN all edits are unchanged
AND the week shows a notice that newer data may be available
AND [Pull now] is available
```

### E2E-06: Any unapproved week can be pulled manually

```
GIVEN a Thu–Wed week has not been approved, whether past or in progress
WHEN the user selects that week and clicks [Pull now]
THEN punches available so far are loaded and it shows "Ready for review"
AND the week is not locked
```

### E2E-07: Employee code matches on number

```
GIVEN employee "TPLGOAHLP036" exists
WHEN a punch arrives with Empcode "0036" and Name "Empname0036"
THEN the punch is linked to "TPLGOAHLP036"
AND the name is not used for matching
```

### E2E-08: Unknown or duplicate code stops at the employee check

```
GIVEN Empcode "0999" matches no employee
AND Empcode "0007" matches both "TPLGOAHLP007" and "TPLGOASUP007"
WHEN the week loads
THEN both codes appear in the employee check with the name eTimeOffice has for each
AND the punch review cannot be opened until both are resolved
AND no name match or guess is applied
```

### E2E-09: Four-digit codes match in full

```
GIVEN an employee's ID ends in "1000"
WHEN a punch arrives with Empcode "1000"
THEN the punch is linked to that employee
```

### E2E-10: Inactive and resigned employees need a decision

```
GIVEN an inactive employee has punches in the week
WHEN the week loads
THEN the employee appears in the employee check with [Approve] and [Reject]
WHEN the user rejects the employee
THEN the employee is left out of that week's payroll
```

### E2E-11: Punches pair in time order and hours calculate per day

```
GIVEN an employee's punches on 5 Nov are 07:40, 13:04, 13:56, 17:47
WHEN the punch review opens
THEN the day shows pairs 07:40–13:04 and 13:56–17:47
AND regularHours = 8.00
AND overtimeHours = 1.25
```

### E2E-12: Scans within 10 minutes merge

```
GIVEN an employee's scans are 07:40, 07:50, 13:00, 13:50, 17:45, 17:46
WHEN the week loads
THEN the punches used are 07:40, 13:00, 13:50, 17:45
AND the day shows a "Merged" marker
AND the original scans are still stored
```

### E2E-13: Scans outside the window stay separate

```
GIVEN an employee's scans are 07:40 and 07:51
WHEN the week loads
THEN both remain separate punches
AND the day has one complete pair, 07:40–07:51
```

### E2E-14: Incomplete pair blocks approval

```
GIVEN an employee's only punch on 6 Nov is 18:26
WHEN the punch review opens
THEN the day appears under "Needs fixing"
AND [Approve week] is disabled
WHEN the user adds an OUT time or deletes the punch
THEN the "Needs fixing" count decreases
AND [Approve week] is enabled once the count reaches zero
```

### E2E-15: Unusual complete days do not block approval

```
GIVEN an employee's day has one complete pair totalling 03:10
AND the week has no incomplete pairs
WHEN the punch review opens
THEN the day is highlighted
AND [Approve week] remains enabled
```

### E2E-16: No-punch employees are shown and can be entered by hand

```
GIVEN an active employee has no punches for the week
WHEN the punch review opens
THEN the employee appears under "No punches this week"
AND [Approve week] is not blocked by this
WHEN the user adds pair 08:00–16:00 on one day
THEN that day shows 8.00 regular hours
AND the employee is included in payroll after approval
```

### E2E-17: Zero-hour employees are left out

```
GIVEN an active employee still has zero hours at approval
WHEN the user opens the approval summary
THEN the employee is listed as being left out
WHEN the week is approved and payroll is generated
THEN the employee has no payroll row and no payslip
```

### E2E-18: Editing keeps the original time

```
GIVEN an API punch of 17:47
WHEN the user changes it to 18:00 with no note
THEN the edit saves without requiring a note
AND hours recalculate immediately
AND the day shows an "Edited" marker with 17:47 and 18:00
AND the audit log records the change and when it happened
```

### E2E-19: Invalid pairs cannot be saved

```
GIVEN the user is editing a day
WHEN an OUT time is before its IN time, or two pairs overlap
THEN the change is rejected with a clear error
AND the previously saved punches are unchanged
```

### E2E-20: Edits survive leaving the page

```
GIVEN the user has edited punches without approving the week
WHEN the user leaves and returns to the punch review
THEN all edits are still present
AND the week is still "Ready for review"
```

### E2E-21: Payroll requires an approved week

```
GIVEN the 5–11 Nov week has been loaded but not approved
WHEN the user opens the payroll flow
THEN payroll cannot be generated for that week
WHEN the week is approved
THEN it becomes available to payroll, with hours matching the review grid
AND the week's punches can no longer be edited
```

### E2E-22: Reopen before payroll is approved

```
GIVEN the week's attendance is approved and has no approved payroll
WHEN the user clicks [Reopen], edits a punch, and approves again
THEN no PayrollRevision is created
AND payroll uses the new hours
```

### E2E-23: Reopen is unavailable after payroll is approved

```
GIVEN the week's payroll is approved
WHEN the user views the week's attendance
THEN [Reopen] is not available
AND corrections go through [Correct] on the payroll run
```

### E2E-24: Correct an approved week

```
GIVEN payroll for 5–11 Nov is approved as revision 1
WHEN the user clicks [Correct], leaves the optional reason blank, selects Attendance, and edits a punch
THEN revision 1 remains current during the edit
WHEN the user approves the punches and then the revised payroll
THEN revision 2 is created and becomes current
AND revision 1 is preserved as superseded
AND the API is not called
```

### E2E-25: Abandoned correction changes nothing

```
GIVEN the user has started a correction and edited punches
WHEN the user abandons the correction
THEN the punch edits are discarded
AND the approved hours and current revision are unchanged
AND the audit log keeps those edits, marked as discarded
```

### E2E-26: Payslip shows a Punches column

```
GIVEN an approved API week
WHEN payroll slips are generated
THEN each day shows one Punches value such as "07:40–13:04, 13:56–17:47"
AND Reg Hrs and OT Hrs match the review grid
AND no BN, AN, or OT In/Out columns are present
```

### E2E-27: Past Excel weeks stay readable

```
GIVEN a week imported through the old Excel upload
WHEN the user opens its history, its read-only attendance view, or downloads its slips
THEN the data is unchanged
AND slips keep the six-column layout
AND [Pull now], [Reopen], and attendance correction are not offered
```

### E2E-28: Excel upload is gone

```
GIVEN F12 is released
WHEN the user opens the Attendance page or the correction flow
THEN no file upload is offered
AND the previous upload routes and actions no longer exist
```

### E2E-29: Payroll week start is locked to Thursday

```
GIVEN F12 is released
WHEN the user opens Settings
THEN the payroll week start shows Thursday and cannot be changed
AND a request to change it is rejected
```

### E2E-30: A new pull replaces the previous pull after a warning

```
GIVEN the 5–11 Nov week has 12 edited days and employee decisions
WHEN the user clicks [Pull now]
THEN a warning says the edits and decisions will be discarded
WHEN the user confirms and the pull succeeds
THEN the week contains only the new pull's punches
AND employee decisions must be made again
AND the audit log keeps the discarded edits
```

### E2E-31: A failed pull changes nothing

```
GIVEN the 5–11 Nov week has data and edits
WHEN the user confirms [Pull now] and the API fails or returns no punches
THEN the existing punches, edits, and decisions are unchanged
AND the error is shown
```

### E2E-32: Scheduled sync replaces an unedited earlier pull

```
GIVEN the 5–11 Nov week was pulled on Monday with no edits or decisions
WHEN the scheduled sync runs on Thursday
THEN the partial pull is replaced by the full week
```

### E2E-33: Approved weeks can't be pulled

```
GIVEN the week's attendance is approved
WHEN the user views the week
THEN [Pull now] is not available
WHEN the user clicks [Reopen], where payroll isn't approved
THEN [Pull now] is available again
```

### E2E-34: Approve week waits until the week has ended

```
GIVEN the current Thu–Wed week was pulled and has no incomplete pairs
WHEN the week has not ended
THEN [Approve week] is disabled
```

### E2E-35: Unknown code can be added as a new employee

```
GIVEN Empcode "0999" matches no employee
WHEN the user chooses [Add as new employee] and saves the form
THEN the user returns to the employee check
AND the code's punches belong to the new employee
```

### E2E-36: Unknown code can be matched and the link is saved

```
GIVEN Empcode "0999" matches no employee
WHEN the user chooses [Match to existing employee] and selects an employee
THEN the code's punches belong to that employee
WHEN the week or a later week is pulled
THEN the saved link applies without asking again
```

### E2E-37: Unknown code can be ignored and the choice is saved

```
GIVEN Empcode "0999" is a test enrollment
WHEN the user chooses [Ignore this code]
THEN its punches are left out of the review and payroll
WHEN a later week is pulled
THEN the code is ignored without asking again
```

### E2E-38: Left-out employee's adjustments carry forward

```
GIVEN an employee with a pending ₹500 deduction has zero hours for the week
WHEN payroll is approved for that week
THEN the deduction is not applied
AND it is pending in the next week the employee is paid
```

### E2E-39: Adjustment-only correction skips the grid

```
GIVEN payroll for a week is approved
WHEN the user clicks [Correct] and selects only Adjustments
THEN the punch grid does not open
AND the correction proceeds to the revised preview
```

### E2E-40: The current revision stays current until approval

```
GIVEN payroll revision 1 is current
WHEN the user recalculates a correction and is on the revised preview
THEN revision 1 is still current
WHEN the user approves the preview
THEN revision 2 becomes current and revision 1 is superseded
```
