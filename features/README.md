# TPL Payroll App — Feature Index

This document serves as an index for all features broken down from the [Product Requirements Document](./TPL_Payroll_App.md).

Each feature has its own folder under `features/` containing:
- **`feature-spec.md`** — Overall goal, scope, and E2E behavior tests.
- **`user-stories.md`** — User stories with acceptance criteria and unit tests.
- **`wireframes.md`** — Screen layouts, behaviors, and ShadCN component specifications.

---

## Phase 1: Payroll Core

| # | Feature | Folder | Status | Description |
|---|---------|--------|--------|-------------|
| F01 | [Dashboard](./features/F01-dashboard/) | `F01-dashboard` | ✅ Done | Landing page with quick operational totals and alert cards |
| F02 | [Employee Management](./features/F02-employee-management/) | `F02-employee-management` | ✅ Done | CRUD, search, filter, deactivate, wage history for employees |
| F03 | [Employee Import / Export](./features/F03-employee-import-export/) | `F03-employee-import-export` | ✅ Done | Bulk import from Excel with validation/preview; export to Excel |
| F04 | [Attendance Upload](./features/F04-attendance-upload/) | `F04-attendance-upload` | ➡️ Replaced by F12 | Upload & parse multi-sheet attendance, match employees, surface errors (Excel upload removed) |
| F05 | [Payroll Adjustments](./features/F05-payroll-adjustments/) | `F05-payroll-adjustments` | ✅ Done | One-time & recurring deductions/additions with weekly review |
| F06 | [Payroll Generation](./features/F06-payroll-generation/) | `F06-payroll-generation` | ✅ Done | Calculate weekly payroll, preview summary, approve |
| F07 | [Payroll Reports & Slips](./features/F07-payroll-reports/) | `F07-payroll-reports` | ✅ Done | PDF summary, per-employee payroll slips, ZIP packaging |
| F08 | [Payroll Correction](./features/F08-payroll-correction/) | `F08-payroll-correction` | ✅ Done | Revision workflow for correcting approved payroll runs |
| F09 | [Payroll History](./features/F09-payroll-history/) | `F09-payroll-history` | ✅ Done | Search & view historical payroll data by employee/week |
| F10 | [Settings](./features/F10-settings/) | `F10-settings` | ✅ Done | Payroll week start day configuration |
| F11 | [Audit Logging](./features/F11-audit-logging/) | `F11-audit-logging` | ✅ Done | Automatic logging of employee create/update and wage changes |
| F12 | [eTimeOffice Attendance Sync & Punch Review](./F12-etimeoffice-attendance/) | `F12-etimeoffice-attendance` | 🚧 In progress | Weekly API sync, punch review and approval; replaces F04 Excel upload |

---

## Recommended Implementation Order

```
F10 Settings (foundation — needed by payroll week logic)
 ↓
F02 Employee Management (core data model)
 ↓
F11 Audit Logging (integrated into employee services)
 ↓
F03 Employee Import/Export (bulk data loading)
 ↓
F04 Attendance Upload (payroll input)
 ↓
F05 Payroll Adjustments (adjustments management)
 ↓
F06 Payroll Generation (core calculation engine)
 ↓
F07 Payroll Reports & Slips (output generation)
 ↓
F08 Payroll Correction (revision workflow)
 ↓
F09 Payroll History (historical data retrieval)
 ↓
F01 Dashboard (aggregation — needs all other features)
```

---

## Feature Statistics

| Metric | Count |
|--------|-------|
| Total Features | 12 |
| Total User Stories | 44 |
| Total E2E Tests | 96 |
| Total Screens | 18 |
