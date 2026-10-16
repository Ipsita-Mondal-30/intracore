# Payroll rules

> **Disclaimer.** Payroll in this app is a configurable calculation engine. It is **not**
> statutory-compliant payroll. No statutory component, rate, wage ceiling, slab, exemption or
> filing format ships with the app, and nothing here claims compliance with any jurisdiction.
> Before paying salaries, validate every component, percentage, cap and effective date
> against the law that applies to each employee (and its effective dates), and handle
> statutory filings, returns and challans outside the app or with a qualified advisor.

Service: `src/features/hr/payroll.ts`. Endpoints: [docs/api/hr-talent-payroll.md](api/hr-talent-payroll.md).

## Permissions and scope

| Action | Permission |
|---|---|
| View runs, payslips, components, structures | `payroll.view` |
| Define components and structures; create, calculate, cancel runs | `payroll.run` |
| Approve a run | `payroll.approve` |
| See your own payslips (approved runs only) | none (self-service) |

Payroll covers every employee of a company, so it needs **whole-company scope**: a member
limited to some branches gets 404 for that company's payroll.

## Configuration (user-defined)

**Salary components** (per company): `code`, `name`, `kind`, `calcType`, optional
`baseComponentCode`, `prorate`, optional `capAmount`, `sortOrder`, `isActive`.

| kind | Effect |
|---|---|
| `EARNING` | Adds to gross earnings |
| `DEDUCTION` | Subtracted from gross to give net pay |
| `EMPLOYER_CONTRIBUTION` | Employer cost; shown on the payslip, does not change net pay |

| calcType | Amount | Value on the structure line |
|---|---|---|
| `FIXED` | The monthly amount | Amount (2 dp) |
| `PERCENT_OF_COMPONENT` | value % of the base component's computed amount | Percent (0–100, 4 dp) |
| `PERCENT_OF_GROSS` | value % of gross earnings | Percent (0–100, 4 dp) |

Validation: an earning cannot be `PERCENT_OF_GROSS`; an earning may only be a percentage of
another earning; the base component must exist in the company and cannot be the component
itself. Circular chains are rejected at calculation time (`PAYROLL_RULE_ERROR`, 422).
Inactive components are ignored when calculating. Changing a component affects future
calculations only: each payslip stores a snapshot of the lines it was computed with.

**Salary structures** are effective-dated versions per employee (`effectiveFrom` + one line
per component). For a month, the version with the latest `effectiveFrom` on or before the
**last day of the month** is used for the whole month (a mid-month revision is not split;
record the difference as a later structure or adjust manually). A version's lines can be
replaced until an approved payslip of that employee for a month on/after its effective
month exists; after that, add a new version.

## Who is paid in a run

Employees of the run's company whose employment overlaps the month
(`joiningDate ≤ month end` and `exitDate` empty or `≥ month start`; `EXITED` without an exit
date is excluded). Reported as **skipped** (returned by `calculate` and `GET /payroll-runs/:id`):

- `ONBOARDING` employees ("Onboarding is not complete");
- employees without a structure effective in the month.

## Paid days

Calendar-day basis. `workingDays` on the payslip stores the **calendar days** of the month.

```
unpaid days = days outside employment in the month (before joining, after exit)
            + approved leave of a leave type with isPaid = false
                (the request's charged `days`; a request crossing the month or the
                 employment boundary contributes days × overlap calendar days / request calendar days)
            + ABSENT attendance (1 day) and HALF_DAY attendance (0.5 day)
                on dates inside employment that no approved leave request covers
unpaid days = min(round half-up 2 dp, calendar days)
paid days   = calendar days − unpaid days
```

Pending, rejected or cancelled leave is ignored. Paid leave never reduces pay. Weekly offs and
holidays are not deducted separately; they count as paid unless inside unpaid leave as charged
by the leave module.

## Calculation

For each employee, in `sortOrder` then `code` order:

1. **Earnings.** `FIXED` earnings with `prorate = true` become `value × paid days / calendar days`;
   with `prorate = false` they are paid in full. `PERCENT_OF_COMPONENT` earnings use the base's
   already-computed (prorated) amount and are not prorated again.
2. Each component amount is **rounded half-up to 2 dp**, then limited to `capAmount` if set.
3. **Gross earnings** = sum of earnings.
4. **Deductions and employer contributions** are computed the same way (`FIXED` deductions and
   contributions are never prorated; `PERCENT_OF_GROSS` uses gross from step 3).
5. **Net pay never goes negative.** Deductions are applied in `sortOrder`; a deduction larger than
   what remains of gross is reduced to the remainder. The payslip line then shows the applied
   `amount`, the original `computed` amount and a note. Recover the shortfall manually.
6. Net pay = gross − applied deductions. Employer contributions are totalled separately.

A rule error (missing base, cycle) fails the whole calculation with 422 naming the employee;
nothing is written (the previous calculation, if any, is kept).

## Run lifecycle

One run per company per month (`period` `YYYY-MM`).

| From | Action | To | Rules |
|---|---|---|---|
| — | create | `DRAFT` | `payroll.run`; a second run for the same month → 409 `DUPLICATE` |
| `CANCELLED` | create (same month) | `DRAFT` | The cancelled run is reopened |
| `DRAFT`, `CALCULATED` | calculate | `CALCULATED` | Replaces all payslips of the run |
| `CALCULATED` | approve | `APPROVED` | `payroll.approve`; approver must differ from the run's creator and from whoever last calculated it (403); needs ≥ 1 payslip |
| `DRAFT`, `CALCULATED` | cancel | `CANCELLED` | Payslips are deleted |
| `APPROVED` | anything | — | 422 `INVALID_STATE`: approved runs and their payslips are final |

Corrections after approval are not supported in-app yet (no adjustment inputs); handle them in
the next month's structure or outside the app.

## Accounting

On approval, when finance is set up and the month's last day is on/after the accounting start
date (`isJournaled`), one journal is posted dated the **last day of the month**:

```
Dr SALARY_EXPENSE    gross earnings + employer contributions (all payslips)
Cr SALARIES_PAYABLE  same amount
```

`sourceType = "PAYROLL_RUN"`, `sourceEvent = "approve"` (retries return the same journal). The
month must fall in an open accounting period, otherwise approval fails (422) and nothing changes.
Deductions and employer contributions are **not** split into their own liability accounts
because no mapping keys exist for them; reclassify with a manual journal if needed. Salary
payment journals are not created by payroll.

## Not built yet

- Payroll inputs (overtime, bonus, arrears, one-off adjustments): the schema has no input model.
- Splitting a month across two structure versions.
- Statutory components, tax computation, payslip PDFs, bank payment files, filings.
