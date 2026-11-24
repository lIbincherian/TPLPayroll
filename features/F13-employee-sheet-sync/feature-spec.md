# F13 — Employee Master Sheet Sync

> **Status: 📝 PLANNED** · PRD: [lIbincherian/TPLPayroll#54](https://github.com/lIbincherian/TPLPayroll/issues/54)

## Goal

Make the "Employee Master List" tab of the Google Sheet the place where employees are onboarded and their profiles are kept, and sync it one way into the app every night and on demand. This is temporary: once the team uses the app's employee screens, the sync is switched off with one setting. It replaces the Excel employee import in [F03](../F03-employee-import-export/feature-spec.md), changes [F02](../F02-employee-management/feature-spec.md) (new profile fields, sheet-owned fields read-only), and must not interfere with how [F12](../F12-etimeoffice-attendance/feature-spec.md) sets employee status.

## User Flow

```
Onboard / edit a row in the sheet
        │
        ├── nightly cron (after the first manual Apply) ──► apply automatically, save report
        │
        └── [Sync from sheet] on Employees page
                 ▼
            Preview: new employees · field changes (old → new) · skipped rows · warnings
                 ▼
            [Apply] ──► one transaction: create, update, audit, save run + report
```

## Problem

New employees are onboarded in the "Employee Master List" tab of the company's Google Sheet, not in the app. People haven't learned to use the app's employee screens yet, so the sheet is where names, designations, bank details, documents and new joiners are actually kept. Today the only way to get that data into the app is the old Excel employee import. That import is manual, and it breaks the app's own records:

- It overwrites wages with `effectiveFrom: today`, so a raise lands on whatever day the import runs, possibly inside an approved payroll week.
- It overwrites Active/Inactive, fighting the status that eTimeOffice attendance approval (F12) sets.
- It only knows about a small set of columns. About twenty columns the team relies on (PAN, IFSC, bank name, emergency contact, room number, remarks…) never reach the app.

When onboarding is late or forgotten, new joiners are missing in the weekly attendance pull, and their eTimeOffice punches show up as `UNKNOWN` codes.

## Solution

A one-way sync from the Employee Master List tab into the app. It runs nightly and on demand, and is temporary: it stays on until the team moves to the app, then is switched off with one setting.

- **Onboarding happens in the sheet.** A new row with a valid Employee ID, name, designation, salary and joining date becomes a new employee in the app. The sheet's salary becomes the first wage, effective from the joining date.
- **After creation, the app owns:**
  - **Salary and wage history.** Wage changes happen only in the app, where someone picks the effective date.
  - **Active/Inactive.** Attendance approval and app actions decide it.
  - **The Employee ID**, which never changes after creation.

  If the sheet disagrees on salary or status, the sync shows a warning and changes nothing.
- **The sheet owns every other profile field.** Each sync overwrites it in the app, and an empty cell clears the app value. While the sync is on, these fields are read-only in the app, labelled "Managed in the Employee Master sheet".
- **Rows are matched on the employee's number:** the Sr. column in the sheet, which equals the trailing digits of the Employee ID, against the trailing digits of the app's Employee ID. This is the same rule eTimeOffice attendance matching uses.
- **Every run shows a report:**
  - employees created
  - fields changed (old → new)
  - rows skipped, with the reason
  - warnings: salary or status mismatches, and app employees missing from the sheet
- **The "Sync from sheet" button** shows this report as a preview before anything is written. Apply then writes it in one transaction.

## User Stories

1. As an HR/site admin, I want a new joiner I add to the Employee Master sheet to appear in the app without retyping them, so that onboarding happens in one place.
2. As an HR/site admin, I want a new joiner's sheet salary to become their first wage, effective from their date of joining, so that payroll for their first week finds a wage.
3. As a payroll manager, I want the sheet's salary ignored for existing employees, so that raises made in the app with a chosen effective date are never overwritten.
4. As a payroll manager, I want a warning when the sheet's salary differs from the app's current wage, so that I can see drift (e.g. sheet 800, app 880) and decide whether to update the app.
5. As a payroll manager, I want the sheet's Hourly Rate column ignored, so that hourly rate stays daily ÷ 8 everywhere in the app.
6. As a payroll manager, I want new employees created from the sheet with the sheet's Active/Inactive value, with a blank treated as Active, so that onboarding sets a sensible starting status.
7. As a payroll manager, I want the sync never to change an existing employee's Active/Inactive status, so that attendance approval (F12) stays the only automatic writer of status.
8. As a payroll manager, I want a warning when the sheet's Active column disagrees with the app, so that I can spot people whose status needs attention.
9. As a payroll manager, I want Date of Resignation to come from the sheet, so that a resignation recorded at onboarding desk level still stops the employee from being reactivated by attendance.
10. As a payroll manager, I want an employee's Employee ID to stay fixed after creation, even when their designation (and so the sheet's ID prefix) changes, so that IDs on payslips, invoices and attendance never move.
11. As a payroll manager, I want sheet rows matched to app employees by their number (Sr. / trailing digits), so that a promotion from helper to mason updates the same employee instead of creating a second one.
12. As an HR/site admin, I want designation and Designation Short changes in the sheet to reach the app, so that the app shows the employee's current role.
13. As an HR/site admin, I want name, phone, DOB, joining date, Aadhaar, National ID, police verification, health card, GPay, bank account and site to be overwritten from the sheet on every sync, so that corrections made in the sheet reach the app.
14. As an HR/site admin, I want an empty cell in the sheet to clear the app value, so that the app never keeps stale data the sheet has removed.
15. As an HR/site admin, I want the new sheet columns stored in the app (PAN, photo links, WhatsApp, GPay name and relation, bank name, bank holder name and relation, IFSC, passbook photo, height, blood group, emergency contact name, number and relation, home address, state, language, relatives on site, room number, distinctive features, other skills, remarks), so that the app holds the full employee record.
16. As an HR/site admin, I want Drive photo links (photo, Aadhaar, PAN, passbook) shown as "Open in Drive" links on the employee page, so that I can see documents without the app copying them.
17. As a payroll manager, I want PAN, bank, IFSC and Aadhaar shown only on the employee detail page and not in lists or exports, so that sensitive data isn't exposed more widely than today.
18. As an HR/site admin, I want profile fields owned by the sheet to be read-only in the app while the sync is on, with a note saying they're managed in the sheet, so that I don't make an edit that the next sync silently undoes.
19. As a payroll manager, I want salary and wage history to stay editable in the app while the sync is on, so that I can still give raises.
20. As an HR/site admin, I want `X`, `Y`, `#N/A` and empty cells treated as blank, so that the sheet's placeholder marks don't become data.
21. As an HR/site admin, I want dates read day first (`07/11/2025`, `03/11/26`, `19-03-2026`, `7 December 1989`), so that Indian-format dates are never read as month first.
22. As a payroll manager, I want phone, bank account, Aadhaar and health card numbers kept as exact text, with surrounding quotes and spaces stripped and leading zeros kept, so that `"0009201700065570"` stays `0009201700065570`.
23. As an HR/site admin, I want a new row skipped and reported when its name, designation, salary or joining date is missing or invalid, so that no one is created without the data payroll and attendance need.
24. As an HR/site admin, I want a non-numeric salary such as `4000/week` to skip the new hire with a clear reason, so that I know to fix the cell.
25. As an HR/site admin, I want a joining date more than 7 days in the future to skip the new hire, so that a typo like `29/03/2027` doesn't create a wage starting next year.
26. As an HR/site admin, I want a bad optional value (e.g. an unreadable DOB) to skip only that field with a warning while the rest of the row syncs, so that one bad cell doesn't block a whole employee.
27. As a payroll manager, I want an existing employee whose sheet row has a blank or invalid required field (name or designation) left unchanged and flagged, so that the app keeps its last good values.
28. As an HR/site admin, I want rows with Sr. `XXX` or blank skipped, so that people not yet numbered aren't onboarded.
29. As an HR/site admin, I want a new row whose Employee ID is `#N/A` skipped with a reason pointing at the sheet's designation lookup, so that I know the fix is in the sheet.
30. As a payroll manager, I want an existing employee matched by Sr. even when the sheet's Employee ID shows `#N/A`, so that a broken lookup formula doesn't freeze their profile (the ID is immutable and not read for existing employees).
31. As an HR/site admin, I want a row skipped and reported when its Sr. and its Employee ID's trailing digits disagree, so that the sync never guesses which number is right.
32. As an HR/site admin, I want two sheet rows sharing a Sr. both skipped and reported, so that the sync never picks one arbitrarily.
33. As a payroll manager, I want a sheet number that matches two app employees to be skipped and reported, so that I can fix the clash in the app rather than have the sync choose.
34. As a payroll manager, I want app employees missing from the sheet left untouched and listed as "In the app but not in the sheet", so that deleting a row in the sheet never deactivates or deletes anyone.
35. As an HR/site admin, I want a "Sync from sheet" button on the Employees page, so that I can sync right after onboarding someone.
36. As an HR/site admin, I want the button to show a preview (new employees, field changes, skipped rows, warnings) before anything is written, so that I can check what will change.
37. As an HR/site admin, I want Apply to write the whole preview in one transaction, so that a failure leaves the app unchanged.
38. As a payroll manager, I want a nightly scheduled sync that applies automatically, so that people onboarded during the day are in the app before Thursday's attendance pull, even if nobody pressed the button.
39. As a payroll manager, I want the nightly sync to stay off until the first manual Apply succeeds, so that the first real write happens with someone watching.
40. As a payroll manager, I want each run (manual or scheduled) saved with its report, and the last sync's time, result and skipped rows shown on the Employees page, so that I can see what the sync did and when.
41. As a payroll manager, I want every field the sync changes recorded in the audit log with `changeSource: 'SHEET_SYNC'` and old and new values, so that I can trace any change back to a sync.
42. As a payroll manager, I want a sync that can't read the sheet (missing credentials, sheet not shared, a required header missing) to fail with a clear message and change nothing, so that a broken configuration never half-applies.
43. As an HR/site admin, I want inserting or reordering columns in the sheet not to break the sync, so that the sheet can evolve; the sync reads columns by header name.
44. As a payroll manager, I want a single on/off setting for the sync, so that when the team moves to the app I can switch it off and make profile fields editable again.
45. As a payroll manager, I want the old Excel employee import removed, so that nothing bypasses the ownership rules; the Excel export stays.
46. As a payroll manager, I want only the Employee Master List tab read, so that the subcontractor roster, room numbers and weekly payroll tabs never leak into the employee table.
47. As a developer, I want local dev and e2e to sync from a fixture when Google credentials are unset, so that tests never touch the real sheet (same pattern as the eTimeOffice mock).
48. As a payroll manager, I want the 7 employees with two open wage rows (TPLGOAPTR165–171) fixed, and a database rule preventing it again, so that every employee has at most one current wage.

## Implementation Decisions

**Ownership rules**

| Field group | On create | On every later sync |
|---|---|---|
| Employee ID | from sheet | never changed (immutable) |
| Salary / wage history | first wage = sheet salary, effective from date of joining | never changed; mismatch → warning |
| Active | sheet value, blank = Active | never changed; mismatch → warning |
| Every other mapped field, incl. Date of Resignation, name, designation, Designation Short | from sheet | overwritten from sheet; empty cell → null |

**Match key**
- The employee number is the integer value of the trailing digits of the app's Employee ID, the same rule as `trailingNumber` in attendance matching. In the sheet, it is the Sr. column.
- For a **new** row, Sr. must equal the trailing digits of the sheet's Employee ID, otherwise the row is skipped.
- For an **existing** employee, only Sr. is used. The sheet's Employee ID is not read, so `#N/A` there does not block the update.
- The sync does not overwrite Serial Number. Sr. is the match key and already equals the ID's number.

**Row outcomes**
- **Create:** a new number with all required fields valid.
- **Update:** a matched number.
- **Skip, with a reason code:**
  - Sr. `XXX` or blank, or not a number
  - Sr. duplicated in the sheet
  - number matches more than one app employee
  - new row with Employee ID `#N/A`, missing or invalid
  - new row whose Sr. and ID digits differ
  - new row with a missing or invalid name, designation, salary or joining date (more than 7 days ahead counts as invalid)
  - existing row with a blank or invalid name or designation
- **Field warning:** an optional field could not be parsed. That field is left unchanged and the rest of the row applies.
- **Row warnings:** salary mismatch, status mismatch.
- **Report-level list:** app employees with no sheet row. They are never modified.

**Value parsing**
- `X`, `Y`, `#N/A` (and other `#…` formula errors), empty and whitespace-only values are treated as null.
- Dates are day first only: `DD/MM/YYYY`, `DD/MM/YY` (20YY), `DD-MM-YYYY`, `D Month YYYY`. Stored at UTC midnight.
- Salary must be a plain positive number; decimals are allowed.
- Identifier-like fields are text: surrounding quotes and whitespace are trimmed and leading zeros kept.
- WhatsApp has the `wa.me/` and `91` country prefix stripped down to the 10-digit number when it matches that pattern; otherwise it is stored as given.
- Active is `Active` or `Inactive` (case-insensitive); blank means Active, and anything else is a field warning.

**Column mapping (sheet header → Employee field)**
- **Existing fields:** Employee ID → employeeId (create only), Employee Name, Designation, Designation Short, Date of Joining, National ID, Aadhaar Card → aadhaarId, Police Verification ID, Phone, D.O.B, Health Card, GPay, Bank Account No., Date of Resignation, Site, Active (create only), Salary (create only).
- **New nullable text fields:** Photo → photoUrl, Aadhar Card Photo → aadhaarPhotoUrl, PAN Card → panNumber, PAN Card Photo → panPhotoUrl, WhatsApp → whatsappNumber, GPay Name, GPay Relation, Bank Name, Bank Holder Name, Bank Holder Relation, IFSC Code, Passbook Photo → passbookPhotoUrl, Height, Blood Group, Emergency Contact Name / No. / Relation, Home Address (Aadhar) → homeAddress, State → homeState, Language, Relatives on Site? → relativesOnSite, Room No. & Bldg No. → roomNumber, Distinctive Features, Other Skills, Remarks.
- **Not stored:** Sr. (match key only), Leave (1)/(2), Return (1)/(2), Days Since Last Return, Months Since Last Return, Days Worked at TPL, Age, Hourly Rate, No. of Leaves Taken.
- **Required headers:** Sr., Employee ID, Employee Name, Designation, Salary, Date of Joining. A missing required header fails the whole run. Other headers that are missing are treated as absent: their fields are not written.

**Schema changes (one additive migration)**
- The new nullable text columns on `Employee` listed above.
- `Settings`:
  - `employeeSheetSyncEnabled` (on/off)
  - a flag recording that the first manual Apply has succeeded, which unlocks the nightly sync
- The `EmployeeImportBatch` run record gains a source (`EXCEL` | `SHEET_SYNC`), a trigger (`MANUAL` | `SCHEDULED`) and a JSON report.
- Data repair in the same migration, following the repo's rule that existing rows a schema change depends on are fixed in that migration:
  - Delete the duplicate open `IMPORT` wage row for each employee that has two open rows, keeping the `MANUAL` one. Production has 7: TPLGOAPTR165–171, all 1100 from 1 Jan 2026.
  - If any duplicate pair differs in amount or effective date, the migration stops with `RAISE EXCEPTION` naming the employee.
  - Then add a partial unique index: one `EmployeeWageHistory` row per employee where `effectiveTo IS NULL`.

**Modules**
- **Sheet row parser (pure, deep module).** Input: the header row plus value rows. Output: typed rows with per-field parse results, nulls, warnings and row-level skip reasons. Holds all value-parsing rules and the column mapping. Has no DB or network access.
- **Sync planner (pure, deep module).** Input: parsed rows plus a snapshot of app employees (id, Employee ID, current open wage, isActive, sheet-owned fields). Output: a plan of creates, field-level updates (old → new), skips, warnings and "in app, not in sheet". This is where the ownership table and the match rules live. The preview is this plan, and Apply executes exactly this plan.
- **Plan applier (service).** Writes a plan in one transaction:
  - creates employees, each with its first wage
  - updates sheet-owned fields
  - writes an `EMPLOYEE` audit row per changed employee with `changeSource: 'SHEET_SYNC'` and the field diffs
  - saves the run record and report

  Before writing, it re-reads the app snapshot. If anything relevant changed since the preview, it rebuilds the plan and asks for re-confirmation rather than applying a stale one.
- **Sheet source client.** Reads one tab by name from one spreadsheet via the Google Sheets API using a service account. When credentials are unset and `VERCEL` is unset, it returns a fixture, mirroring the eTimeOffice mock. Server-only.
- **Server actions:** preview, and apply (from a preview).
- **Cron route** for the nightly sync, protected by `CRON_SECRET` like the attendance cron. It does nothing unless the sync is enabled and the first manual Apply has succeeded.
- **UI:**
  - On the Employees page: a "Sync from sheet" button, a preview dialog, the last sync status and the skipped rows.
  - On the employee edit form: sheet-owned fields read-only with a "Managed in the Employee Master sheet" note while the sync is enabled.
  - On the employee detail page: the new fields, with Drive links as "Open in Drive" and sensitive fields shown only here.
- **Removed:** the Excel employee import UI and action. The Excel export stays.

**Configuration**
- New server-only environment variables, set separately for Vercel Production and Preview, never `NEXT_PUBLIC_`, never logged or returned:
  - `GOOGLE_SHEETS_CLIENT_EMAIL`
  - `GOOGLE_SHEETS_PRIVATE_KEY`
  - `EMPLOYEE_SHEET_ID`
  - `EMPLOYEE_SHEET_TAB` (default `Employee Master List`)
- The sheet must be shared read-only with the service account's email.
- The nightly cron is added to `vercel.json` (proposed 23:30 UTC daily, ahead of the Thursday 00:30 UTC attendance pull).

## Testing Decisions

- Good tests exercise external behaviour only: given sheet values and an app snapshot, assert the plan, or the rows written to the database. They don't reach into helpers.
- **Sheet row parser:** unit tests (vitest) covering every parsing rule. Use real awkward values from the sheet as cases:
  - `03/11/26`, `19-03-2026`, `7 December 1989`
  - `"0009201700065570"`, `4000/week`, `833.34`
  - `X`, `Y`, `#N/A`, `wa.me/919567031213`
  - blank Active
  - a missing required header
- **Sync planner:** unit tests for every row outcome and ownership rule:
  - create with the wage effective from joining
  - update overwrites, and blank clears
  - salary and status untouched, with warnings
  - Employee ID immutable when the sheet prefix changes
  - existing employee matched despite `#N/A` ID
  - Sr./ID digit mismatch on a new row
  - duplicate Sr.
  - number matching two app employees
  - app-only employees listed
  - joining date more than 7 days ahead
- **Plan applier and migration:** DB tests in the same style as the F12 DB tests. Check:
  - Apply is atomic
  - audit rows are written
  - the first-apply flag is set
  - the duplicate-wage repair keeps `MANUAL`, raises on a differing pair, and the unique index rejects a second open wage
- **Cron route:** auth tests mirroring the attendance cron auth and route tests: rejects a missing or wrong secret, and skips when disabled or before the first Apply.
- **Prior art:** attendance-sync unit tests (matching, parser, employee-status), the F12 migration DB test, and the cron-auth and cron-route tests.

## Out of Scope

- Writing anything back to the sheet (the sync is one-way).
- The Subcontractor Employee Master List tab and any notion of a subcontractor.
- Copying Drive documents into app storage.
- Syncing leave and return history or calculated columns.
- Changing salary or status from the sheet after creation.
- Renaming Employee IDs.
- Deleting or deactivating app employees that are missing from the sheet.
- A name-change guard: rows sync as the sheet has them.

## Further Notes

- **Before the first sync, fix these in the sheet:**
  - Add DRIVER, CARPENTER, BARBENDER, ELECTRICIAN, ACCOUNTANT, MANAGER and GRAPHIC DESINGER to the sheet's designation lookup. New rows 274, 277, 281, 996 and 997 show Employee ID `#N/A` and will be skipped until then. Existing 155, 240, 261 and 263 still update, matched by Sr.
  - Add joining dates for 998 and 1000.
- **Production snapshot (read-only check, 23 Nov 2026):**
  - 265 employees, with no clashing trailing numbers.
  - A `TEST` / "Test User" employee with no number; it will be listed as "in app, not in sheet".
  - About 20 new hires are pending (Sr. 265–286 and 999).
  - Many app salaries are about 10% above the sheet. These are expected warnings, not errors.
- **Turning the sync off later** (`employeeSheetSyncEnabled = false`) stops the cron, hides the button and makes profile fields editable again. This is the planned exit once the team uses the app.
