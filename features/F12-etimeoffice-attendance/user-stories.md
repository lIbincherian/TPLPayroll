# F12 — eTimeOffice Attendance Sync & Punch Review: User Stories

> **Status: 📝 PLANNED**

Source of truth: [feature-spec.md](./feature-spec.md). New code lives in `src/features/attendance-sync/`. Function names in the unit tests are proposals for the implementation plan, except where they name existing code.

---

## US-12.1: Scheduled sync loads the completed week

**As a** Payroll Owner
**I want to** have the completed Thursday–Wednesday week load from eTimeOffice every Thursday morning
**So that** attendance is ready for review without any manual step.

### Acceptance Criteria

- AC1: The sync is scheduled as `30 0 * * 4` UTC, which is Thursday 06:00 IST. A Vercel Hobby run anywhere within that hour targets the same week.
- AC2: The sync targets the week that ended the previous day, from Thursday 00:00 to Wednesday 23:59.
- AC3: The request covers all employees (`Empcode=ALL`).
- AC4: After a successful load, the week shows "Ready for review".
- AC5: A loaded week is not available to payroll until it is approved.

### Unit Tests

```
TEST: getCompletedPayrollWeek returns the week ending the previous day
  GIVEN now = Thursday 12 Nov 2026, 06:00 IST
  WHEN getCompletedPayrollWeek(now) is called
  THEN it returns { start: 2026-11-05, end: 2026-11-11 }

TEST: getCompletedPayrollWeek returns the same week across the Vercel firing window
  GIVEN now = Thursday 12 Nov 2026, 00:00 UTC, and then 00:59 UTC
  WHEN getCompletedPayrollWeek(now) is called for each
  THEN both return { start: 2026-11-05, end: 2026-11-11 }

TEST: runScheduledSync stores a loaded week as ready for review
  GIVEN the 5–11 Nov week has no data
  AND the API returns punches for the week
  WHEN runScheduledSync() is called
  THEN the punches are stored
  AND the week status is "Ready for review"
```

---

## US-12.2: Protect the sync route with CRON_SECRET

**As a** Payroll Owner
**I want to** have the sync route reject any caller without the secret
**So that** nobody can trigger an eTimeOffice load from outside the schedule.

### Acceptance Criteria

- AC1: The sync route requires a valid `CRON_SECRET`.
- AC2: A missing or wrong secret is rejected.
- AC3: A rejected request makes no API call and no database change.
- AC4: `CRON_SECRET` is added to the environment section of `AGENTS.md`.

### Unit Tests

```
TEST: isAuthorizedCronRequest rejects a missing secret
  GIVEN a request with no secret
  WHEN isAuthorizedCronRequest(request, secret) is called
  THEN it returns false

TEST: isAuthorizedCronRequest rejects a wrong secret
  GIVEN a request with a different secret
  WHEN isAuthorizedCronRequest(request, secret) is called
  THEN it returns false

TEST: isAuthorizedCronRequest accepts the correct secret
  GIVEN a request with the configured secret
  WHEN isAuthorizedCronRequest(request, secret) is called
  THEN it returns true

TEST: sync route does nothing on a rejected request
  GIVEN a request without a valid secret
  WHEN the sync route is called
  THEN the request is rejected
  AND the API client and the database are not called
```

---

## US-12.3: Fetch and read punches from eTimeOffice

**As a** Payroll Owner
**I want to** have the app fetch the week's punches from `DownloadPunchDataMCID` and read their times as written
**So that** the times I review are the times the face recognition system recorded.

### Acceptance Criteria

- AC1: The app calls `GET /DownloadPunchDataMCID` on `https://api.etimeoffice.com/api/` with `Empcode=ALL`, `FromDate`, and `ToDate`, formatted `dd/MM/yyyy_HH:mm`.
- AC2: Auth is HTTP Basic, Base64 of `Corporateid:Username:Password:True` (pending Open Item 1).
- AC3: `PunchDate` is read as `dd/MM/yyyy HH:mm:ss` and treated as a local wall-clock time, with no timezone conversion.
- AC4: The vendor's `OverTime` and `WorkTime` values are not used.
- AC5: The login is stored in environment variables, separate for Vercel Production and Preview, and is never committed or sent to the client.
- AC6: The new login variables are added to the environment section of `AGENTS.md`.

### Unit Tests

```
TEST: buildPunchRequestParams formats the week range
  GIVEN the week 5–11 Nov 2026
  WHEN buildPunchRequestParams(week) is called
  THEN Empcode = "ALL"
  AND FromDate = "05/11/2026_00:00"
  AND ToDate = "11/11/2026_23:59"

TEST: buildBasicAuthHeader encodes the login in the documented order
  GIVEN Corporateid "corp", Username "user", Password "pass"
  WHEN buildBasicAuthHeader(login) is called
  THEN it returns "Basic " + Base64("corp:user:pass:True")

TEST: parsePunchDate keeps the wall-clock time
  GIVEN PunchDate "05/11/2026 07:40:00"
  WHEN parsePunchDate(value) is called
  THEN it returns date 2026-11-05 and time 07:40
  AND the time does not change with the server timezone

TEST: parsePunchResponse ignores vendor hour values
  GIVEN a punch row with OverTime "05:00" and WorkTime "12:00"
  WHEN parsePunchResponse(body) is called
  THEN the parsed punch has no overtime or work time value
```

---

## US-12.4: Treat bad API results as a failed sync

**As a** Payroll Owner
**I want to** see "Sync failed" with the error when eTimeOffice gives a bad result
**So that** a bad or empty response never freezes a week with no data.

### Acceptance Criteria

- AC1: A non-200 status fails the sync.
- AC2: `Error: true` fails the sync.
- AC3: A response that can't be parsed fails the sync.
- AC4: A response with no punches at all for the week fails the sync.
- AC5: A failed sync stores no punches and leaves the week empty.
- AC6: The week shows "Sync failed" with the error, and [Pull now] is available.

### Unit Tests

```
TEST: classifySyncResponse fails on a non-200 status
  GIVEN status = 500
  WHEN classifySyncResponse(response) is called
  THEN it returns a failure with the status in the error

TEST: classifySyncResponse fails on Error = true
  GIVEN status = 200 and body { Error: true }
  WHEN classifySyncResponse(response) is called
  THEN it returns a failure

TEST: classifySyncResponse fails on an unparseable body
  GIVEN status = 200 and a body that is not valid JSON
  WHEN classifySyncResponse(response) is called
  THEN it returns a failure

TEST: classifySyncResponse fails on an empty punch list
  GIVEN status = 200, Error = false, and no punches
  WHEN classifySyncResponse(response) is called
  THEN it returns a failure

TEST: classifySyncResponse succeeds with punches
  GIVEN status = 200, Error = false, and at least one punch
  WHEN classifySyncResponse(response) is called
  THEN it returns success with the punches

TEST: runScheduledSync stores nothing on failure
  GIVEN the API returns a 500
  WHEN runScheduledSync() is called
  THEN no punches are stored
  AND the week status is "Sync failed" with the error
```

---

## US-12.5: Never overwrite a loaded week

**As a** Payroll Owner
**I want to** have the first successful load be final
**So that** a repeat sync can never erase my edits.

### Acceptance Criteria

- AC1: The scheduled job does nothing if the week already has data, and does not call the API for that week.
- AC2: All punch edits are unchanged after the job runs again.
- AC3: A punch that reaches eTimeOffice after the sync is not loaded. The user enters it by hand.
- AC4: A week with data shows no [Pull now].

### Unit Tests

```
TEST: canLoadWeek is false for a week with data
  GIVEN a week with stored punches
  WHEN canLoadWeek(week) is called
  THEN it returns false

TEST: canLoadWeek is true for a week with no data
  GIVEN a week with no stored punches, whether or not a sync has failed
  WHEN canLoadWeek(week) is called
  THEN it returns true

TEST: runScheduledSync skips a loaded week
  GIVEN the 5–11 Nov week is loaded and a punch has been edited
  WHEN runScheduledSync() is called again
  THEN the API client is not called
  AND the edited punch is unchanged
```

---

## US-12.6: Load a week with Pull now

**As a** Payroll Owner
**I want to** load a week by hand with [Pull now]
**So that** I can recover from a failed sync or fill a past week that has no data.

### Acceptance Criteria

- AC1: [Pull now] is only available on a week with no data.
- AC2: [Pull now] can load any past Thu–Wed week.
- AC3: After a failed sync, [Pull now] loads the week once the API recovers, and the week shows "Ready for review".
- AC4: The user can select a past week with no data and load it with [Pull now].
- AC5: [Pull now] uses the same failure rules as the scheduled sync. On failure, the week shows "Sync failed" and [Pull now] stays available.

### Unit Tests

```
TEST: canPullNow is true for a past week with no data
  GIVEN today = 12 Nov 2026
  AND the week 1–7 Oct 2026 has no data
  WHEN canPullNow(week, today) is called
  THEN it returns true

TEST: canPullNow is false for a week with data
  GIVEN the week 5–11 Nov 2026 has stored punches
  WHEN canPullNow(week, today) is called
  THEN it returns false

TEST: pullNow loads a week after a failed sync
  GIVEN the 5–11 Nov week shows "Sync failed"
  AND the API now returns punches
  WHEN pullNow(week) is called
  THEN the punches are stored
  AND the week status is "Ready for review"

TEST: pullNow leaves the week empty on an empty response
  GIVEN the API returns success with no punches
  WHEN pullNow(week) is called
  THEN no punches are stored
  AND the week status is "Sync failed"
```

---

## US-12.7: Match employee codes on their number

**As a** Payroll Owner
**I want to** have eTimeOffice codes match the number at the end of the Employee ID
**So that** each punch reaches the right employee without relying on names.

### Acceptance Criteria

- AC1: A code matches when its number equals the digits at the end of the Employee ID, ignoring leading zeros.
- AC2: All trailing digits are read. The old three-digit limit in `employee-matcher.service.ts` is not carried over.
- AC3: Names are never used to match.

### Unit Tests

```
TEST: matchEmployeeCode ignores leading zeros
  GIVEN employee "TPLGOAHLP036"
  WHEN matchEmployeeCode("0036", employees) is called
  THEN it returns MATCHED with "TPLGOAHLP036"

TEST: matchEmployeeCode reads four-digit codes in full
  GIVEN an employee whose ID ends in "1000"
  WHEN matchEmployeeCode("1000", employees) is called
  THEN it returns MATCHED with that employee

TEST: matchEmployeeCode reads all trailing digits of the Employee ID
  GIVEN only employee "TPLGOAHLP1036"
  WHEN matchEmployeeCode("0036", employees) is called
  THEN it returns UNKNOWN

TEST: matchEmployeeCode does not match an ID with no trailing digits
  GIVEN only employee "TPLGOAHLP"
  WHEN matchEmployeeCode("0036", employees) is called
  THEN it returns UNKNOWN

TEST: matchEmployeeCode ignores names
  GIVEN only employee "TPLGOAHLP001" named "Empname0036"
  WHEN matchEmployeeCode("0036", employees) is called
  THEN it returns UNKNOWN
```

---

## US-12.8: Fix unknown and duplicate codes in the employee check

**As a** Payroll Owner
**I want to** see every code that matches no employee or more than one
**So that** no punch is dropped or given to the wrong person by a guess.

### Acceptance Criteria

- AC1: A code that matches no employee appears in the employee check.
- AC2: A code that matches more than one employee appears in the employee check.
- AC3: No name match or guess is applied.
- AC4: These codes must be fixed before the punch review, and the review cannot be finished while any remain.
- AC5: The user fixes a code by correcting the Employee ID or creating the employee.
- AC6: After the fix, the app matches the code again and links its punches.

### Unit Tests

```
TEST: matchEmployeeCode returns UNKNOWN for no match
  GIVEN no Employee ID ends in 999
  WHEN matchEmployeeCode("0999", employees) is called
  THEN it returns UNKNOWN

TEST: matchEmployeeCode returns DUPLICATE for several matches
  GIVEN employees "TPLGOAHLP007" and "TPLGOASUP007"
  WHEN matchEmployeeCode("0007", employees) is called
  THEN it returns DUPLICATE with both employees

TEST: getEmployeeCheckIssues lists both kinds of code
  GIVEN "0999" is UNKNOWN and "0007" is DUPLICATE
  WHEN getEmployeeCheckIssues(week) is called
  THEN it returns both codes

TEST: rematchWeekCodes links punches after a fix
  GIVEN "0999" is UNKNOWN with stored punches
  AND an employee ending in 999 has been created
  WHEN rematchWeekCodes(week) is called
  THEN the punches are linked to that employee
  AND "0999" is no longer in the employee check
```

---

## US-12.9: Decide on inactive and resigned employees with punches

**As a** Payroll Owner
**I want to** approve or reject inactive and resigned employees who have punches
**So that** only the people I confirm are paid for that week.

### Acceptance Criteria

- AC1: An inactive employee with punches in the week appears in the employee check with [Approve] and [Reject].
- AC2: An employee who resigned before the week and has punches appears the same way.
- AC3: These employees need no decision if they have no punches.
- AC4: An approved employee appears in the review grid.
- AC5: A rejected employee is left out of that week's payroll.

### Unit Tests

```
TEST: needsEmployeeDecision is true for an inactive employee with punches
  GIVEN isActive = false and 4 punches in the week
  WHEN needsEmployeeDecision(employee, punches, week) is called
  THEN it returns true

TEST: needsEmployeeDecision is true for an employee resigned before the week
  GIVEN isActive = true, resigned 1 Nov, week starting 5 Nov, and 2 punches
  WHEN needsEmployeeDecision(employee, punches, week) is called
  THEN it returns true

TEST: needsEmployeeDecision is false with no punches
  GIVEN isActive = false and no punches in the week
  WHEN needsEmployeeDecision(employee, punches, week) is called
  THEN it returns false

TEST: needsEmployeeDecision is false for an employee resigning during the week
  GIVEN isActive = true, resigned 7 Nov, week starting 5 Nov, and 2 punches
  WHEN needsEmployeeDecision(employee, punches, week) is called
  THEN it returns false
```

---

## US-12.10: Pair each day's punches in time order

**As a** Payroll Owner
**I want to** have each day's punches paired in order
**So that** I can read a day as in/out pairs and spot a missing punch.

### Acceptance Criteria

- AC1: Each day's punches are sorted by time and paired first with second, third with fourth, and so on.
- AC2: Each calendar day stands alone.
- AC3: An odd number of punches leaves an incomplete pair.
- AC4: No punch is special. Exact 10:00 and 10:30 punches pair like any others.

### Unit Tests

```
TEST: pairPunches pairs four punches in order
  GIVEN punches 07:40, 13:04, 13:56, 17:47
  WHEN pairPunches(punches) is called
  THEN pairs = [07:40–13:04, 13:56–17:47]
  AND incomplete = null

TEST: pairPunches sorts before pairing
  GIVEN punches 13:04, 07:40
  WHEN pairPunches(punches) is called
  THEN pairs = [07:40–13:04]

TEST: pairPunches leaves an incomplete pair on an odd count
  GIVEN punches 07:40, 13:04, 18:26
  WHEN pairPunches(punches) is called
  THEN pairs = [07:40–13:04]
  AND incomplete = 18:26

TEST: pairPunches gives a single punch as incomplete
  GIVEN punches 18:26
  WHEN pairPunches(punches) is called
  THEN pairs = []
  AND incomplete = 18:26

TEST: pairPunches does not treat 10:00 and 10:30 as special
  GIVEN punches 07:40, 10:00, 10:30, 17:47
  WHEN pairPunches(punches) is called
  THEN pairs = [07:40–10:00, 10:30–17:47]
```

---

## US-12.11: Merge duplicate scans within 2 minutes

**As a** Payroll Owner
**I want to** have repeat scans within 2 minutes merged into the earlier punch
**So that** a double scan at the machine doesn't create a false pair.

### Acceptance Criteria

- AC1: A scan within 2 minutes of the punch being kept, inclusive, merges into that earlier punch.
- AC2: A later scan outside the window starts a new punch.
- AC3: The window is measured from the kept punch, not from the previous scan.
- AC4: The original scans are kept.
- AC5: A day with a merge shows a "Merged" marker.
- AC6: Merging happens before pairing.

### Unit Tests

```
TEST: mergeScans merges scans in the window
  GIVEN scans 07:40, 07:41, 13:00, 13:50, 17:45, 17:46
  WHEN mergeScans(scans) is called
  THEN punches = [07:40, 13:00, 13:50, 17:45]
  AND merged = true
  AND originals still holds all 6 scans

TEST: mergeScans includes a scan at exactly 2 minutes
  GIVEN scans 07:40, 07:42
  WHEN mergeScans(scans) is called
  THEN punches = [07:40]

TEST: mergeScans keeps scans outside the window separate
  GIVEN scans 07:40, 07:43
  WHEN mergeScans(scans) is called
  THEN punches = [07:40, 07:43]
  AND merged = false

TEST: mergeScans measures from the kept punch
  GIVEN scans 07:40, 07:41, 07:42, 07:43
  WHEN mergeScans(scans) is called
  THEN punches = [07:40, 07:43]

TEST: mergeScans merges identical scans
  GIVEN scans 07:40, 07:40
  WHEN mergeScans(scans) is called
  THEN punches = [07:40]
  AND merged = true

TEST: scans just outside the window form a short complete pair
  GIVEN scans 07:40, 07:43
  WHEN mergeScans() and then pairPunches() are called
  THEN pairs = [07:40–07:43]
  AND incomplete = null
```

---

## US-12.12: Calculate daily regular and overtime hours

**As a** Payroll Owner
**I want to** have each day's hours calculated from its pairs
**So that** pay follows the 8-hour daily rule and the punches I approved.

### Acceptance Criteria

- AC1: `dailyTotal` is the sum of (OUT − IN) for each complete pair.
- AC2: `regularHours = min(dailyTotal, 8)` and `overtimeHours = max(0, dailyTotal − 8)`.
- AC3: The 8-hour rule applies per day. There is no weekly threshold.
- AC4: Time inside a pair is paid and gaps between pairs are not. No break is deducted automatically.
- AC5: An incomplete pair adds no hours.
- AC6: Hours keep the existing two-decimal rounding.
- AC7: The app's figure is the one used for pay, even if it differs from eTimeOffice's own `Work+OT` report.

### Unit Tests

```
TEST: calculateDailyHours for a full day with overtime
  GIVEN pairs 07:40–13:04 and 13:56–17:47
  WHEN calculateDailyHours(pairs) is called
  THEN regularHours = 8.00
  AND overtimeHours = 1.25

TEST: calculateDailyHours under 8 hours has no overtime
  GIVEN pair 08:00–12:00
  WHEN calculateDailyHours(pairs) is called
  THEN regularHours = 4.00
  AND overtimeHours = 0.00

TEST: calculateDailyHours at exactly 8 hours has no overtime
  GIVEN pair 08:00–16:00
  WHEN calculateDailyHours(pairs) is called
  THEN regularHours = 8.00
  AND overtimeHours = 0.00

TEST: calculateDailyHours does not deduct a break
  GIVEN pair 08:00–16:30
  WHEN calculateDailyHours(pairs) is called
  THEN regularHours = 8.00
  AND overtimeHours = 0.50

TEST: calculateDailyHours rounds to two decimals
  GIVEN pair 08:00–08:03, and then pair 08:00–11:10
  WHEN calculateDailyHours(pairs) is called for each
  THEN regularHours = 0.05, and then 3.17

TEST: calculateDailyHours is zero with no pairs
  GIVEN no pairs
  WHEN calculateDailyHours(pairs) is called
  THEN regularHours = 0.00
  AND overtimeHours = 0.00

TEST: weekly totals do not change the daily split
  GIVEN 6 days of 8.00 hours each
  WHEN calculateDailyHours() is called for each day
  THEN each day has overtimeHours = 0.00
```

---

## US-12.13: See every expected employee in the review grid

**As a** Payroll Owner
**I want to** see all employees expected that week with their in/out pairs per day
**So that** I can review the whole week in one place.

### Acceptance Criteria

- AC1: The grid lists every employee with `isActive = true` who did not resign before the week.
- AC2: The grid also lists inactive or resigned employees approved in the employee check.
- AC3: Rejected employees are not listed.
- AC4: Each employee shows a flexible list of in/out pairs per day, with that day's regular and overtime hours.
- AC5: A day with merged scans shows the "Merged" marker.
- AC6: The API is not called when the grid opens.

### Unit Tests

```
TEST: getReviewGridEmployees includes an active employee with no punches
  GIVEN an active employee with no punches
  WHEN getReviewGridEmployees(employees, decisions, week) is called
  THEN the employee is listed

TEST: getReviewGridEmployees includes an employee resigning during the week
  GIVEN isActive = true, resigned 7 Nov, and week starting 5 Nov
  WHEN getReviewGridEmployees(employees, decisions, week) is called
  THEN the employee is listed

TEST: getReviewGridEmployees includes an approved inactive employee
  GIVEN an inactive employee with an APPROVED decision
  WHEN getReviewGridEmployees(employees, decisions, week) is called
  THEN the employee is listed

TEST: getReviewGridEmployees excludes a rejected employee
  GIVEN a resigned employee with a REJECTED decision
  WHEN getReviewGridEmployees(employees, decisions, week) is called
  THEN the employee is not listed

TEST: getReviewGridEmployees excludes an inactive employee with no punches
  GIVEN an inactive employee with no punches and no decision
  WHEN getReviewGridEmployees(employees, decisions, week) is called
  THEN the employee is not listed
```

---

## US-12.14: Filter to days that need fixing

**As a** Payroll Owner
**I want to** filter the grid to "Needs fixing"
**So that** I can find every incomplete pair that blocks approval.

### Acceptance Criteria

- AC1: "Needs fixing" shows days with an incomplete pair.
- AC2: The filter shows how many days need fixing.
- AC3: The count decreases when the user adds the missing time or deletes the punch.
- AC4: A complete day is not listed, however unusual it looks.

### Unit Tests

```
TEST: getNeedsFixingDays lists a day with an incomplete pair
  GIVEN a day whose only punch is 18:26
  WHEN getNeedsFixingDays(week) is called
  THEN that day is returned

TEST: getNeedsFixingDays skips complete and empty days
  GIVEN a day with pair 08:00–08:30 and a day with no punches
  WHEN getNeedsFixingDays(week) is called
  THEN it returns no days

TEST: getNeedsFixingDays count drops after a fix
  GIVEN 2 days with incomplete pairs
  WHEN one of them gets an OUT time
  THEN getNeedsFixingDays(week) returns 1 day
```

---

## US-12.15: Find employees with no punches and enter hours by hand

**As a** Payroll Owner
**I want to** filter to "No punches this week" and add pairs by hand
**So that** someone who couldn't be scanned can still be paid when I know they worked.

### Acceptance Criteria

- AC1: "No punches this week" shows employees with no punches.
- AC2: These employees do not block approval.
- AC3: The user can add pairs by hand for these employees.
- AC4: A hand-entered day calculates hours like any other.
- AC5: An employee with hand-entered hours is included in payroll after approval.

### Unit Tests

```
TEST: getNoPunchEmployees lists an employee with no punches
  GIVEN an employee in the grid with no punches
  WHEN getNoPunchEmployees(week) is called
  THEN the employee is returned

TEST: getNoPunchEmployees skips an employee with one punch
  GIVEN an employee in the grid with one punch
  WHEN getNoPunchEmployees(week) is called
  THEN the employee is not returned

TEST: adding a pair by hand calculates hours
  GIVEN an employee with no punches
  WHEN pair 08:00–16:00 is added on one day
  THEN that day has regularHours = 8.00
  AND the employee is no longer under "No punches this week"
```

---

## US-12.16: Highlight unusual complete days

**As a** Payroll Owner
**I want to** see complete days that look unusual highlighted
**So that** I can check them without being stopped from approving.

### Acceptance Criteria

- AC1: A complete day under 4 hours is highlighted.
- AC2: A complete day with a single pair over 6 hours is highlighted.
- AC3: A highlight does not block approval.
- AC4: The 4-hour and 6-hour values are proposed defaults, defined in one place so they can be tuned with real data.

### Unit Tests

```
TEST: isUnusualDay flags a day under 4 hours
  GIVEN pair 08:00–11:10
  WHEN isUnusualDay(pairs) is called
  THEN it returns true

TEST: isUnusualDay does not flag exactly 4 hours
  GIVEN pair 08:00–12:00
  WHEN isUnusualDay(pairs) is called
  THEN it returns false

TEST: isUnusualDay flags a single pair over 6 hours
  GIVEN pair 08:00–14:01
  WHEN isUnusualDay(pairs) is called
  THEN it returns true

TEST: isUnusualDay does not flag a pair of exactly 6 hours
  GIVEN pair 08:00–14:00
  WHEN isUnusualDay(pairs) is called
  THEN it returns false

TEST: isUnusualDay does not flag a normal two-pair day
  GIVEN pairs 07:40–13:04 and 13:56–17:47
  WHEN isUnusualDay(pairs) is called
  THEN it returns false
```

---

## US-12.17: Edit a day's punches

**As a** Payroll Owner
**I want to** change any time, add or delete a pair, or delete a stray punch
**So that** the hours match what actually happened that day.

### Acceptance Criteria

- AC1: The user can change any time in a day.
- AC2: The user can add a pair and delete a pair.
- AC3: The user can delete a stray punch.
- AC4: Deleting can leave a day at zero hours.
- AC5: Hours recalculate immediately after a saved edit.
- AC6: A week that is locked by approval cannot be edited.

### Unit Tests

```
TEST: changing a time recalculates hours
  GIVEN pairs 07:40–13:04 and 13:56–17:47
  WHEN the 17:47 punch is changed to 18:00
  THEN regularHours = 8.00
  AND overtimeHours = 1.47

TEST: adding a pair recalculates hours
  GIVEN pair 08:00–12:00
  WHEN pair 13:00–14:00 is added
  THEN regularHours = 5.00

TEST: deleting a pair recalculates hours
  GIVEN pairs 08:00–12:00 and 13:00–14:00
  WHEN pair 13:00–14:00 is deleted
  THEN regularHours = 4.00

TEST: deleting the only punch leaves a day at zero hours
  GIVEN a day whose only punch is 18:26
  WHEN the punch is deleted
  THEN regularHours = 0.00
  AND the day has no incomplete pair

TEST: savePunchEdit is rejected on an approved week
  GIVEN an approved week
  WHEN savePunchEdit() is called
  THEN it throws "WEEK_LOCKED"
```

---

## US-12.18: Reject invalid punch edits

**As a** Payroll Owner
**I want to** be told when an edit doesn't make sense
**So that** bad times never reach hours or pay.

### Acceptance Criteria

- AC1: Saved times must be valid `HH:mm`.
- AC2: Each OUT must be after its IN.
- AC3: Pairs can't overlap.
- AC4: A rejected change shows a clear error.
- AC5: After a rejected change, the previously saved punches are unchanged.

### Unit Tests

```
TEST: validateDayPairs rejects an invalid time
  GIVEN pair 25:00–26:00
  WHEN validateDayPairs(pairs) is called
  THEN it returns error "INVALID_TIME"

TEST: validateDayPairs rejects OUT before IN
  GIVEN pair 17:00–08:00
  WHEN validateDayPairs(pairs) is called
  THEN it returns error "OUT_NOT_AFTER_IN"

TEST: validateDayPairs rejects OUT equal to IN
  GIVEN pair 08:00–08:00
  WHEN validateDayPairs(pairs) is called
  THEN it returns error "OUT_NOT_AFTER_IN"

TEST: validateDayPairs rejects overlapping pairs
  GIVEN pairs 08:00–12:00 and 11:30–14:00
  WHEN validateDayPairs(pairs) is called
  THEN it returns error "PAIRS_OVERLAP"

TEST: validateDayPairs accepts valid pairs
  GIVEN pairs 08:00–12:00 and 13:00–17:00
  WHEN validateDayPairs(pairs) is called
  THEN it returns valid

TEST: savePunchEdit leaves saved punches unchanged on failure
  GIVEN a saved pair 08:00–12:00
  WHEN savePunchEdit() is called with OUT = 07:00
  THEN it returns an error
  AND the stored pair is still 08:00–12:00
```

---

## US-12.19: Keep edits when leaving the review

**As a** Payroll Owner
**I want to** have edits save as I go
**So that** I can leave the review and finish it later.

### Acceptance Criteria

- AC1: Each valid edit is saved as the user makes it, with no separate save step.
- AC2: All edits are still present when the user returns to the punch review.
- AC3: The week still shows "Ready for review".

### Unit Tests

```
TEST: saved edits are returned when the review reloads
  GIVEN a week showing "Ready for review"
  AND the 17:47 punch was edited to 18:00
  WHEN getPunchReview(week) is called again
  THEN the punch has current time 18:00

TEST: saving an edit does not change the week status
  GIVEN a week showing "Ready for review"
  WHEN savePunchEdit() is called
  THEN the week still shows "Ready for review"
```

---

## US-12.20: See original and current times on an edited day

**As a** Payroll Owner
**I want to** see what the API recorded next to what I changed
**So that** the original evidence is never lost.

### Acceptance Criteria

- AC1: The original API time is never overwritten.
- AC2: An edited day shows an "Edited" marker with the original and current times.
- AC3: A note is optional, and an edit saves without one.
- AC4: A note, when given, is stored with the punch.

### Unit Tests

```
TEST: applyPunchEdit keeps the original time
  GIVEN a punch with original = 17:47 and current = 17:47
  WHEN applyPunchEdit(punch, "18:00") is called
  THEN original = 17:47
  AND current = 18:00

TEST: applyPunchEdit does not need a note
  GIVEN a punch with no note
  WHEN applyPunchEdit(punch, "18:00") is called with no note
  THEN the edit succeeds

TEST: applyPunchEdit stores a note when given
  GIVEN a punch
  WHEN applyPunchEdit(punch, "18:00", "Forgot to scan out") is called
  THEN the note is stored

TEST: isEditedDay is true after an edit
  GIVEN a day with a punch where current differs from original
  WHEN isEditedDay(day) is called
  THEN it returns true

TEST: isEditedDay is false for an untouched day
  GIVEN a day with only API punches where current equals original
  WHEN isEditedDay(day) is called
  THEN it returns false
```

---

## US-12.21: Record attendance changes in the audit log

**As a** Payroll Owner
**I want to** have each punch change recorded in the audit log
**So that** I can see what changed and when.

### Acceptance Criteria

- AC1: The audit log records each punch change and when it happened.
- AC2: `AuditLog` and the types in `audit-log.types.ts` are extended to cover attendance.
- AC3: The audit log viewer can show and filter attendance entries.
- AC4: The log does not record who made the change, because user logins are out of scope.

### Unit Tests

```
TEST: savePunchEdit writes an audit entry
  GIVEN an API punch of 17:47
  WHEN savePunchEdit() changes it to 18:00
  THEN an AuditLog row is created for attendance with 17:47 and 18:00 in detailsJson
  AND createdAt is set

TEST: a rejected edit writes no audit entry
  GIVEN an edit that fails validation
  WHEN savePunchEdit() is called
  THEN no AuditLog row is created

TEST: getAuditLogs filters by the attendance entity type
  GIVEN audit rows for EMPLOYEE and for attendance
  WHEN getAuditLogs() is called with the attendance entityType
  THEN only attendance rows are returned
```

---

## US-12.22: Enable Approve week only when the week is ready

**As a** Payroll Owner
**I want to** have [Approve week] enabled only when no incomplete pairs remain
**So that** I can't approve a week with hours missing.

### Acceptance Criteria

- AC1: [Approve week] is disabled while any day has an incomplete pair.
- AC2: [Approve week] is enabled once the "Needs fixing" count reaches zero.
- AC3: [Approve week] is disabled while an unknown or duplicate code remains.
- AC4: Unusual complete days do not disable it.
- AC5: Employees under "No punches this week" do not disable it.

### Unit Tests

```
TEST: canApproveWeek is false with an incomplete pair
  GIVEN needsFixingCount = 1 and no code issues
  WHEN canApproveWeek(week) is called
  THEN it returns false

TEST: canApproveWeek is false with an unresolved code
  GIVEN needsFixingCount = 0 and an UNKNOWN code
  WHEN canApproveWeek(week) is called
  THEN it returns false

TEST: canApproveWeek is true when nothing blocks
  GIVEN needsFixingCount = 0 and no code issues
  WHEN canApproveWeek(week) is called
  THEN it returns true

TEST: canApproveWeek ignores unusual days and no-punch employees
  GIVEN needsFixingCount = 0, one day with pair 08:00–11:10, and one employee with no punches
  WHEN canApproveWeek(week) is called
  THEN it returns true
```

---

## US-12.23: Check the summary before approving

**As a** Payroll Owner
**I want to** see a summary before I approve the week
**So that** I can confirm the totals and who is being left out.

### Acceptance Criteria

- AC1: The summary shows the employee count.
- AC2: The summary shows total regular and overtime hours.
- AC3: The summary shows the edited days.
- AC4: The summary lists the employees being left out, both zero-hour and rejected.
- AC5: There is one approval per week, with no per-employee sign-off.

### Unit Tests

```
TEST: buildApprovalSummary totals the hours
  GIVEN day totals of 8.00 regular + 1.25 overtime and 4.00 regular + 0.00 overtime
  WHEN buildApprovalSummary(week) is called
  THEN totalRegularHours = 12.00
  AND totalOvertimeHours = 1.25

TEST: buildApprovalSummary counts edited days
  GIVEN 2 edited days and 3 untouched days
  WHEN buildApprovalSummary(week) is called
  THEN editedDays = 2

TEST: buildApprovalSummary lists employees being left out
  GIVEN one active employee with zero hours and one rejected employee
  WHEN buildApprovalSummary(week) is called
  THEN both are in leftOutEmployees
```

---

## US-12.24: Approve the week and lock it

**As a** Payroll Owner
**I want to** approve the week after the summary
**So that** the hours are locked and passed to payroll.

### Acceptance Criteria

- AC1: Approval locks the week, and its punches can no longer be edited.
- AC2: Approval makes the week available to payroll.
- AC3: Approval produces `AttendanceRecord` daily regular and overtime hours, so payroll calculations don't change.
- AC4: The hours payroll receives match the review grid.
- AC5: Approval is rejected on the server if the week still has anything that disables [Approve week].

### Unit Tests

```
TEST: buildAttendanceRecords carries the grid hours
  GIVEN a day with pairs 07:40–13:04 and 13:56–17:47
  WHEN buildAttendanceRecords(week) is called
  THEN that day's record has regularHours = 8.00 and overtimeHours = 1.25

TEST: approveWeek locks the week
  GIVEN a week with no incomplete pairs
  WHEN approveWeek(week) is called
  THEN the week is locked
  AND savePunchEdit() is rejected for that week

TEST: approveWeek is rejected with an incomplete pair
  GIVEN a week with one incomplete pair
  WHEN approveWeek(week) is called
  THEN it throws "WEEK_NOT_READY"
  AND no AttendanceRecord rows are created
```

---

## US-12.25: Leave zero-hour and rejected employees out of payroll

**As a** Payroll Owner
**I want to** have employees with no hours or a rejected decision left out of the run
**So that** nobody gets an empty or unwanted payslip.

### Acceptance Criteria

- AC1: An employee with zero total hours for the week is left out of the payroll run and gets no payslip.
- AC2: A rejected inactive or resigned employee is left out.
- AC3: An employee who works any hours in the week is included.
- AC4: There are no partial payroll runs: everyone not left out is in the run.

### Unit Tests

```
TEST: getPayrollEmployees excludes a zero-hour employee
  GIVEN an active employee with zero total hours
  WHEN getPayrollEmployees(week) is called
  THEN the employee is not returned

TEST: getPayrollEmployees excludes a rejected employee
  GIVEN a resigned employee with a REJECTED decision and hours in the week
  WHEN getPayrollEmployees(week) is called
  THEN the employee is not returned

TEST: getPayrollEmployees includes an employee with hand-entered hours
  GIVEN an employee with only one hand-entered pair of 08:00–16:00
  WHEN getPayrollEmployees(week) is called
  THEN the employee is returned

TEST: payroll generation creates no row for a zero-hour employee
  GIVEN an approved week with one zero-hour employee
  WHEN payroll is generated
  THEN that employee has no payroll row and no payslip
```

---

## US-12.26: Only offer approved weeks to payroll

**As a** Payroll Owner
**I want to** have payroll accept a week only once its attendance is approved
**So that** nobody can pay from punches that haven't been reviewed.

### Acceptance Criteria

- AC1: `getAvailablePayrollWeeks` does not offer a week as ready until its attendance is approved.
- AC2: `checkAttendanceReadiness` returns not ready for a week that is loaded but not approved.
- AC3: Payroll generation refuses a week that is not approved, even when called directly.
- AC4: A "Sync failed" or empty week is not ready.
- AC5: Once approved, the week is available and its totals match the review grid.

### Unit Tests

```
TEST: checkAttendanceReadiness is not ready for a week in review
  GIVEN a week showing "Ready for review"
  WHEN checkAttendanceReadiness(weekStart, weekEnd) is called
  THEN it returns { ready: false }

TEST: checkAttendanceReadiness is not ready for a failed week
  GIVEN a week showing "Sync failed"
  WHEN checkAttendanceReadiness(weekStart, weekEnd) is called
  THEN it returns { ready: false }

TEST: checkAttendanceReadiness is ready for an approved week
  GIVEN an approved week with 8.00 regular and 1.25 overtime hours
  WHEN checkAttendanceReadiness(weekStart, weekEnd) is called
  THEN it returns { ready: true, totalRegularHours: 8, totalOvertimeHours: 1.25 }

TEST: getAvailablePayrollWeeks does not offer a week in review as ready
  GIVEN a week showing "Ready for review"
  WHEN getAvailablePayrollWeeks() is called
  THEN that week is not returned as ready for payroll

TEST: calculatePayroll refuses an unapproved week
  GIVEN a week showing "Ready for review"
  WHEN calculatePayroll() is called for that week
  THEN it fails and creates nothing
```

---

## US-12.27: Reopen a week before payroll is approved

**As a** Payroll Owner
**I want to** [Reopen] an approved week whose payroll isn't approved yet
**So that** I can fix a mistake without creating a revision.

### Acceptance Criteria

- AC1: [Reopen] is available on an approved week with no approved payroll.
- AC2: [Reopen] unlocks the week so its punches can be edited.
- AC3: A reopened week is not available to payroll until it is approved again.
- AC4: No `PayrollRevision` is created.
- AC5: After approving again, payroll uses the new hours.
- AC6: Reopening does not call the API.

### Unit Tests

```
TEST: canReopenWeek is true before payroll exists
  GIVEN attendance is approved and payrollStatus = "NOT_GENERATED"
  WHEN canReopenWeek(week) is called
  THEN it returns true

TEST: canReopenWeek is false for an unapproved week
  GIVEN a week showing "Ready for review"
  WHEN canReopenWeek(week) is called
  THEN it returns false

TEST: reopenWeek then approveWeek replaces the hours
  GIVEN an approved week with 17:47 as the last punch of a day
  WHEN reopenWeek() is called, the punch is changed to 18:00, and approveWeek() is called
  THEN that day's AttendanceRecord has overtimeHours = 1.47
  AND no PayrollRevision is created
  AND the API client is not called

TEST: checkAttendanceReadiness is not ready for a reopened week
  GIVEN a reopened week
  WHEN checkAttendanceReadiness(weekStart, weekEnd) is called
  THEN it returns { ready: false }
```

---

## US-12.28: Block Reopen after payroll is approved

**As a** Payroll Owner
**I want to** have [Reopen] removed once payroll is approved
**So that** approved pay can only change through a tracked correction.

### Acceptance Criteria

- AC1: [Reopen] is not available when the week's payroll is approved.
- AC2: [Reopen] is not available when the week's payroll has been revised.
- AC3: The server refuses a reopen in these states.
- AC4: Corrections go through [Correct] on the payroll run.

### Unit Tests

```
TEST: canReopenWeek is false after payroll approval
  GIVEN attendance is approved and payrollStatus = "APPROVED"
  WHEN canReopenWeek(week) is called
  THEN it returns false

TEST: canReopenWeek is false after a revision
  GIVEN attendance is approved and payrollStatus = "REVISED"
  WHEN canReopenWeek(week) is called
  THEN it returns false

TEST: reopenWeek is refused after payroll approval
  GIVEN attendance is approved and payrollStatus = "APPROVED"
  WHEN reopenWeek(week) is called
  THEN it throws "PAYROLL_ALREADY_APPROVED"
```

---

## US-12.29: Start a correction in the same grid

**As a** Payroll Owner
**I want to** click [Correct] on an approved payroll run and edit punches in the grid I already know
**So that** I can fix an error found after approval while current pay stays in effect.

### Acceptance Criteria

- AC1: [Correct] is available on an approved payroll run and offers an optional reason.
- AC2: The correction can proceed with the reason left blank.
- AC3: A reason, when given, is stored as `correctionReason` on the new revision. A blank reason is stored as null.
- AC4: [Correct] opens the same review grid, with the same editing and validation rules.
- AC5: The current revision stays in effect while the correction is in progress.
- AC6: Starting a correction does not call the API.

### Unit Tests

```
TEST: initiateCorrection is blocked for a run that isn't approved
  GIVEN a payroll run that isn't approved
  WHEN initiateCorrection(payrollRunId) is called
  THEN it fails with the existing correction error

TEST: a correction proceeds with a blank reason
  GIVEN payroll for 5–11 Nov is approved as revision 1
  WHEN a correction is started with the reason left blank
  THEN the grid opens for editing
  AND the new revision's correctionReason = null

TEST: a correction stores a reason when given
  GIVEN correctionReason = "Wrong OUT time for TPLGOAHLP036"
  WHEN the correction is approved as a new revision
  THEN the new revision's correctionReason = "Wrong OUT time for TPLGOAHLP036"

TEST: starting a correction leaves the current revision alone
  GIVEN payroll for 5–11 Nov is approved as revision 1
  WHEN a correction is started and a punch is edited
  THEN revision 1 has isCurrent = true and status = "APPROVED"
  AND the week's AttendanceRecord hours are unchanged

TEST: correction edits use the same validation
  GIVEN a correction in progress
  WHEN a punch edit has OUT before IN
  THEN it returns error "OUT_NOT_AFTER_IN"

TEST: starting a correction makes no API call
  GIVEN a correction is started
  WHEN the grid loads
  THEN the API client is not called
```

---

## US-12.30: Approve a correction as a new revision

**As a** Payroll Owner
**I want to** approve the corrected punches, check the revised pay preview, and approve the revision
**So that** corrected pay takes effect and the previous revision is preserved.

### Acceptance Criteria

- AC1: After the punches are approved, the app shows the revised pay preview.
- AC2: Approving the revised payroll creates a new `PayrollRevision`, which becomes current.
- AC3: The current revision stays in effect until the new one is approved. `recalculateAndCreateRevision` supersedes the previous revision today, so that timing must change for this flow.
- AC4: The previous revision is preserved as superseded.
- AC5: Revision history, adjustment handling, and slip regeneration stay in place.
- AC6: The same left-out rules apply: an employee with zero total hours after the correction has no row in the new revision.
- AC7: The API is not called.

### Unit Tests

```
TEST: the preview does not change the current revision
  GIVEN revision 1 is current and corrected punches are approved
  WHEN the revised pay preview is shown
  THEN revision 1 is still current

TEST: approving the revised payroll creates revision 2
  GIVEN revision 1 is current and the revised preview is shown
  WHEN the revised payroll is approved
  THEN revision 2 has isCurrent = true
  AND revision 1 has isCurrent = false and status = "SUPERSEDED"

TEST: the new revision uses the corrected hours
  GIVEN a corrected punch changes a day to 8.00 regular and 1.47 overtime
  WHEN the revised payroll is approved
  THEN revision 2's employee row includes those hours

TEST: a correction leaves out an employee reduced to zero hours
  GIVEN a correction deletes all of an employee's punches
  WHEN the revised payroll is approved
  THEN revision 2 has no row for that employee
```

---

## US-12.31: Abandon a correction

**As a** Payroll Owner
**I want to** abandon a correction I no longer want
**So that** approved hours and pay stay exactly as they were.

### Acceptance Criteria

- AC1: Abandoning a correction discards its punch edits.
- AC2: The approved hours are unchanged.
- AC3: The current revision is unchanged, and no new revision is created.

### Unit Tests

```
TEST: abandonCorrection discards punch edits
  GIVEN a correction changed 17:47 to 18:00
  WHEN abandonCorrection() is called
  THEN the punch's current time is 17:47

TEST: abandonCorrection keeps approved hours and the current revision
  GIVEN payroll is approved as revision 1 and a correction has edits
  WHEN abandonCorrection() is called
  THEN the week's AttendanceRecord hours are unchanged
  AND revision 1 is still current
  AND no revision 2 exists
```

---

## US-12.32: Show a Punches column on API-week payslips

**As a** Payroll Owner
**I want to** have payslips for API weeks show one "Punches" column
**So that** any number of pairs fits on the slip.

### Acceptance Criteria

- AC1: API weeks replace the six In/Out columns with one "Punches" column, for example `07:40–13:04, 13:56–17:47`.
- AC2: Long lines wrap.
- AC3: Edited and original punches look the same on the slip.
- AC4: Reg Hrs and OT Hrs match the review grid.
- AC5: `buildSlipData` and `generatePayrollSlipPdf` choose the layout by the week's source.

### Unit Tests

```
TEST: formatPunchesCell joins pairs
  GIVEN pairs 07:40–13:04 and 13:56–17:47
  WHEN formatPunchesCell(pairs) is called
  THEN it returns "07:40–13:04, 13:56–17:47"

TEST: formatPunchesCell handles a single pair
  GIVEN pair 08:00–16:00
  WHEN formatPunchesCell(pairs) is called
  THEN it returns "08:00–16:00"

TEST: formatPunchesCell has no edit marker
  GIVEN pair 07:40–18:00 where 18:00 was edited from 17:47
  WHEN formatPunchesCell(pairs) is called
  THEN it returns "07:40–18:00"

TEST: API-week slip has no six-column headers
  GIVEN slip data for an approved API week
  WHEN generatePayrollSlipPdf(slip) builds the table
  THEN it has a "Punches" column
  AND it has no BN, AN, or OT In/Out columns
  AND Reg Hrs and OT Hrs match the review grid
```

---

## US-12.33: Keep past Excel weeks readable

**As a** Payroll Owner
**I want to** still open past Excel-era weeks and download their slips
**So that** my payroll history stays intact after the upload is removed.

### Acceptance Criteria

- AC1: Existing `AttendanceUpload` and `AttendanceRecord` rows stay, unchanged.
- AC2: Existing rows count as approved.
- AC3: Past weeks, history, and slips still open.
- AC4: Slips for Excel-era weeks keep the six-column layout.
- AC5: Schema changes keep existing rows valid, including their `fileName` and `fileType`.

### Unit Tests

```
TEST: Excel-era week slip keeps six columns
  GIVEN slip data for a week imported through the Excel upload
  WHEN generatePayrollSlipPdf(slip) builds the table
  THEN it has BN, AN, and OT In/Out columns
  AND it has no "Punches" column

TEST: an Excel-era row reads as approved
  GIVEN an existing AttendanceUpload row with no sync or review status
  WHEN getAttendanceWeekStatus(upload) is called
  THEN it returns approved

TEST: an Excel-era week offers no Pull now
  GIVEN a week with existing AttendanceRecord rows from the Excel upload
  WHEN canPullNow(week, today) is called
  THEN it returns false
```

---

## US-12.34: Remove the Excel attendance upload

**As a** Payroll Owner
**I want to** have the old upload gone in the same release
**So that** eTimeOffice is the only way attendance enters the app.

### Acceptance Criteria

- AC1: The Attendance page (`src/app/attendance/page.tsx`) offers no file upload.
- AC2: The upload, its parser, week detection, upload sessions, replace flow, and related UI are removed.
- AC3: The previous upload routes and actions no longer exist.
- AC4: The Attendance page shows each week's sync state and the actions for that state.

### Unit Tests

```
TEST: no code imports the removed upload modules
  GIVEN the F12 release
  WHEN the source is checked for imports of workbook-parser, week-detector, and upload-session services
  THEN none are found

TEST: the Attendance page has no upload control
  GIVEN the Attendance page is rendered
  WHEN its controls are read
  THEN no file input or dropzone is present
```

---

## US-12.35: Replace upload dependencies in other flows

**As a** Payroll Owner
**I want to** have the correction flow and `/employees/new` work without the upload
**So that** corrections and new employees keep working after it is removed.

### Acceptance Criteria

- AC1: `CorrectionFlow` no longer uses `AttendanceDropzone`, `WeekSelectionDialog`, or `finalizeAttendanceUploadAction`, and offers no file upload.
- AC2: `/employees/new` no longer depends on the `attendanceSession` upload session.
- AC3: A user who creates an employee from the employee check returns to it, and the code is matched again.

### Unit Tests

```
TEST: CorrectionFlow offers no file upload
  GIVEN CorrectionFlow is rendered for an approved run
  WHEN its controls are read
  THEN no file input or dropzone is present

TEST: /employees/new renders without an upload session
  GIVEN the page is opened with no attendanceSession parameter
  WHEN the page renders
  THEN the employee form is shown
  AND getAttendanceUploadSessionAction is not used

TEST: creating an employee from the employee check rematches the code
  GIVEN "0999" is UNKNOWN in the employee check
  WHEN an employee ending in 999 is created from that check
  THEN the user returns to the employee check
  AND "0999" is no longer listed
```

---

## US-12.36: Lock the payroll week start to Thursday

**As a** Payroll Owner
**I want to** see the payroll week start fixed at Thursday in Settings
**So that** the setting can't drift away from the Thursday–Wednesday week the sync loads.

### Acceptance Criteria

- AC1: The F10 Settings page shows the payroll week start as Thursday, read-only.
- AC2: The page offers no control that changes it.
- AC3: A request to change it is rejected, including a direct call to `updateSettingsAction`.
- AC4: A rejected request makes no database change.

### Unit Tests

```
TEST: updateSettings rejects a change to the week start
  GIVEN the payroll week start is Thursday
  WHEN updateSettings({ payrollWeekStartDay: "MONDAY" }) is called
  THEN it fails with a SettingsServiceError
  AND prisma.settings.update is not called

TEST: updateSettingsAction returns an error for a change
  GIVEN the payroll week start is Thursday
  WHEN updateSettingsAction({ payrollWeekStartDay: "MONDAY" }) is called
  THEN it returns { ok: false }

TEST: SettingsForm shows Thursday read-only
  GIVEN SettingsForm is rendered
  WHEN its controls are read
  THEN the payroll week start shows Thursday
  AND no control can change it
```

---

## Traceability

| Spec section | Stories |
|---|---|
| Sync | US-12.1, US-12.3, US-12.4, US-12.5, US-12.6, US-12.36 |
| Employee Matching | US-12.7, US-12.8, US-12.9 |
| Pairing and Duplicate Scans | US-12.10, US-12.11 |
| Hours | US-12.12 |
| Review Grid | US-12.13, US-12.14, US-12.15, US-12.16, US-12.17, US-12.18 |
| Edit History | US-12.20, US-12.21 |
| Approval | US-12.22, US-12.23, US-12.24, US-12.25 |
| Reopening and Correcting | US-12.27, US-12.28, US-12.29, US-12.30, US-12.31 |
| Payslips | US-12.32, US-12.33 |
| Excel Upload Removal | US-12.33, US-12.34, US-12.35 |
| API Integration | US-12.2, US-12.3 |
| Design Notes (payroll readiness) | US-12.24, US-12.26, US-12.33 |
| Known Effects | US-12.10, US-12.12 |

| E2E | Stories | E2E | Stories |
|---|---|---|---|
| E2E-01 | US-12.1, US-12.26 | E2E-15 | US-12.16, US-12.22 |
| E2E-02 | US-12.2 | E2E-16 | US-12.15, US-12.22, US-12.25 |
| E2E-03 | US-12.4, US-12.6 | E2E-17 | US-12.23, US-12.25 |
| E2E-04 | US-12.4, US-12.6 | E2E-18 | US-12.17, US-12.20, US-12.21 |
| E2E-05 | US-12.5 | E2E-19 | US-12.18 |
| E2E-06 | US-12.6 | E2E-20 | US-12.19 |
| E2E-07 | US-12.7 | E2E-21 | US-12.24, US-12.26 |
| E2E-08 | US-12.8, US-12.22 | E2E-22 | US-12.27 |
| E2E-09 | US-12.7 | E2E-23 | US-12.28 |
| E2E-10 | US-12.9, US-12.25 | E2E-24 | US-12.29, US-12.30 |
| E2E-11 | US-12.10, US-12.12 | E2E-25 | US-12.31 |
| E2E-12 | US-12.11 | E2E-26 | US-12.32 |
| E2E-13 | US-12.11 | E2E-27 | US-12.33 |
| E2E-14 | US-12.10, US-12.14, US-12.17, US-12.22 | E2E-28 | US-12.34, US-12.35 |
| | | E2E-29 | US-12.36 |
