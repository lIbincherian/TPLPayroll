# Product

> Drafted without an owner interview, from `TPL_Payroll_App.md`, `README.md` and the F12 feature docs. It needs owner review: confirm or correct every section before relying on it.

## Register

product

## Users

A single payroll owner at TPL who runs weekly payroll on a laptop (the F12 wireframes are sized for a 1366x768 screen). The same person covers the HR admin and accountant duties in the first version. The weekly job is to get attendance right, approve it, then generate payroll, reports and payslips from it. Payroll weeks run Thursday to Wednesday.

## Product Purpose

TPL Payroll calculates weekly payroll for about 100 employees from attendance and the employee master data, keeps the history, and produces PDF reports and payslips. It replaces manual payroll calculation, so the figures must be accurate, reviewable and retrievable. F12 changes how attendance enters the app: punches are synced from eTimeOffice, and the owner reviews them (unmatched codes, unpaired punches, edits) and approves the week before payroll can use it. Success is a week approved quickly, with every change to a punch traceable.

## Brand Personality

Plain, exact, quiet. The tool disappears into the task. No stated brand voice or brand assets exist beyond what the app already ships.

## Anti-references

Not stated by the owner. Inferred from the shipped app and the F12 wireframes: no decorative motion, no dashboard-style hero metrics, no card-heavy layouts (tables are shown without card wrappers), no second look or icon set beside the existing one.

## Design Principles

1. Exceptions first. Most cells are normal, so the screens make the whole week scannable and put what needs attention (needs fixing, unusual, unmatched) one click away.
2. Never a silent change. Edits, merges and replacements are marked where they happen and kept in the audit log; destructive actions say what they will discard before they run.
3. Say what blocks the next step. A disabled action names the blocker (week not ended, 3 days need fixing), so the owner never has to guess.
4. Same vocabulary everywhere. The grid, status badges, buttons and totals look and read the same on the review, approved and correction screens.
5. Numbers are the content. Hours are always two decimals, monospaced and aligned, so columns can be compared by eye.

## Accessibility & Inclusion

Not stated by the owner. Working defaults: WCAG AA contrast, keyboard operation of the review grid and editor, visible focus, state never conveyed by color alone (icons and text accompany color), and reduced-motion support for any animation.
