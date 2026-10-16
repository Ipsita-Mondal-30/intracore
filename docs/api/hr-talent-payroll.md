# HR talent and payroll API

Recruitment, performance and payroll endpoints under `/api/v1`. Conventions (envelope, errors,
list parameters `page`, `pageSize`, `sort`, `dir`, `q`, `Idempotency-Key`) are in
[docs/API.md](../API.md). Payroll rules and the compliance disclaimer are in
[docs/PAYROLL.md](../PAYROLL.md).

Out-of-scope or foreign ids answer 404. Invalid state transitions answer 422 `INVALID_STATE`.
Every `POST` below accepts `Idempotency-Key`.

## Recruitment

Services: `src/features/hr/recruitment.ts`. Openings and applications are company-scoped;
candidates are organization-wide.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/job-openings` | `recruitment.view` | Filters `status`, `companyId`, `q` (title, location). Sort `createdAt`, `title`, `status` |
| POST | `/job-openings` | `recruitment.manage` | `{ companyId, title, departmentId?, designationId?, location?, employmentType?, openings?, description? }` → `DRAFT`. The department must belong to the company |
| GET | `/job-openings/:id` | `recruitment.view` | Includes applications with candidates |
| PATCH | `/job-openings/:id` | `recruitment.manage` | Any create field except `companyId`; not when `CLOSED` |
| POST | `/job-openings/:id/{open\|hold\|close}` | `recruitment.manage` | open: `DRAFT`/`ON_HOLD` → `OPEN`; hold: `OPEN` → `ON_HOLD`; close: any but `CLOSED` → `CLOSED` |
| GET | `/candidates` | `recruitment.view` | `q` searches name, email, phone |
| POST | `/candidates` | `recruitment.manage` | `{ fullName, email?, phone?, source?, notes? }`. Email is lower-cased; an existing email → 409 `DUPLICATE` with `details.id` |
| GET | `/candidates/:id` | `recruitment.view` | With applications in your companies |
| PATCH | `/candidates/:id` | `recruitment.manage` | Same fields; email dedupe applies |
| GET | `/applications` | `recruitment.view` | Filters `jobOpeningId`, `candidateId`, `stage` |
| POST | `/applications` | `recruitment.manage` | `{ jobOpeningId, candidateId }`. Opening must be `OPEN`; one application per candidate per opening (409) |
| GET | `/applications/:id` | `recruitment.view` | With interviews and feedback |
| POST | `/applications/:id/stage` | `recruitment.manage` | `{ stage, reason?, hiredEmployeeId? }`, see the stage table. `reason` is required for `REJECTED`; `hiredEmployeeId` (employee of the opening's company) only with `HIRED` |
| GET | `/interviews` | `recruitment.view`, or interviewer | Filters `applicationId`, `mine=true`. Interviewers see their own interviews without `recruitment.view` |
| POST | `/interviews` | `recruitment.manage` | `{ applicationId, scheduledAt, durationMin? (15–480), mode? ONSITE\|VIDEO\|PHONE, interviewerIds: uuid[] (1–10) }`. Each interviewer must be an active member (422). Not for terminal applications |
| GET | `/interviews/:id` | `recruitment.view`, or interviewer | |
| POST | `/interviews/:id/{complete\|cancel}` | `recruitment.manage` | `SCHEDULED` → `COMPLETED` / `CANCELLED` |
| POST | `/interviews/:id/feedback` | listed interviewer | `{ rating 1–5, recommendation STRONG_YES\|YES\|NO\|STRONG_NO, comments? }`. Others → 403; once per interviewer (409); not on cancelled interviews |

Application stages:

| From | Allowed next |
|---|---|
| `APPLIED` | `SCREENING`, `INTERVIEW`, `REJECTED`, `WITHDRAWN` |
| `SCREENING` | `INTERVIEW`, `OFFER`, `REJECTED`, `WITHDRAWN` |
| `INTERVIEW` | `OFFER`, `REJECTED`, `WITHDRAWN` |
| `OFFER` | `HIRED`, `REJECTED`, `WITHDRAWN` |
| `HIRED`, `REJECTED`, `WITHDRAWN` | none (terminal) |

## Performance

Services: `src/features/hr/performance.ts`. `performance.view` holders see employees in their
company/branch scope; everyone sees their own goals and reviews, and reviews they are the
reviewer on.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/review-cycles` | `performance.view` | Filter `status` |
| POST | `/review-cycles` | `performance.manage` | `{ companyId, name, startDate, endDate }` → `DRAFT` |
| GET | `/review-cycles/:id` | `performance.view` | |
| POST | `/review-cycles/:id/activate` | `performance.manage` | `DRAFT` → `ACTIVE`; opens a `PENDING` review for every `ACTIVE`/`ON_NOTICE` employee of the company who joined by the end date, reviewer = their manager's login |
| POST | `/review-cycles/:id/close` | `performance.manage` | `ACTIVE` → `CLOSED`; all its reviews become `CLOSED`, its goals read-only |
| GET | `/goals` | visibility rules | Filters `employeeId`, `cycleId`, `mine=true` |
| POST | `/goals` | `performance.manage` | `{ employeeId, cycleId?, title, description?, targetValue?, currentValue?, weight? 1–100, dueDate?, status? }`. Cycle must be the employee's company and not closed |
| PATCH | `/goals/:id` | `performance.manage` or the employee | Managers: any field. The employee: only `currentValue`, `status` (other fields → 422). Status: `NOT_STARTED`, `ON_TRACK`, `AT_RISK`, `ACHIEVED`, `MISSED` |
| GET | `/performance-reviews` | visibility rules | Filters `cycleId`, `employeeId` (an employee's history across cycles), `status` |
| POST | `/performance-reviews` | `performance.manage` | `{ cycleId, employeeId, reviewerId? }` for an employee who joined after activation; cycle must be `ACTIVE` |
| GET | `/performance-reviews/:id` | visibility rules | |
| POST | `/performance-reviews/:id/self` | the employee | `{ rating 1–5, comments? }`; `PENDING` → `SELF_SUBMITTED` |
| POST | `/performance-reviews/:id/manager` | the reviewer, or `performance.manage` in scope | `{ rating 1–5, comments? }`; `PENDING`/`SELF_SUBMITTED` → `MANAGER_SUBMITTED`. Never on your own review (403) |

## Payroll

Services: `src/features/hr/payroll.ts`. Requires whole-company scope. See
[docs/PAYROLL.md](../PAYROLL.md) for every calculation rule.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/salary-components` | `payroll.view` | Filter `companyId` |
| POST | `/salary-components` | `payroll.run` | `{ companyId, code, name, kind, calcType?, baseComponentCode?, prorate?, capAmount?, sortOrder?, isActive? }` |
| PATCH | `/salary-components/:id` | `payroll.run` | Any field except `companyId`, `code` |
| GET | `/salary-structures` | `payroll.view` | Filter `employeeId`, `q` (employee name/number). Sort `effectiveFrom`, `createdAt` |
| POST | `/salary-structures` | `payroll.run` | `{ employeeId, effectiveFrom, lines: [{ componentId, value }] }`; one version per employee per date (409) |
| GET | `/salary-structures/:id` | `payroll.view` | |
| PATCH | `/salary-structures/:id` | `payroll.run` | `{ lines }`; 422 once approved payroll used the version |
| GET | `/payroll-runs` | `payroll.view` | Filters `companyId`, `status`. Sort `period`, `createdAt` |
| POST | `/payroll-runs` | `payroll.run` | `{ companyId, period: "YYYY-MM" }` → `DRAFT`. Existing non-cancelled run → 409 `DUPLICATE`; a cancelled one is reopened |
| GET | `/payroll-runs/:id` | `payroll.view` | With payslips, `totals`, `skipped` (while open) and the approval `journal` |
| POST | `/payroll-runs/:id/calculate` | `payroll.run` | `DRAFT`/`CALCULATED` → `CALCULATED`; response includes `skipped: [{ employeeId, fullName, employeeNumber, reason }]` |
| POST | `/payroll-runs/:id/approve` | `payroll.approve` | `CALCULATED` → `APPROVED`; 403 for the creator or last calculator; posts the journal when journaled |
| POST | `/payroll-runs/:id/cancel` | `payroll.run` | `DRAFT`/`CALCULATED` → `CANCELLED` |
| GET | `/payslips` | `payroll.view`, or own | Filters `runId`, `employeeId`. Without `payroll.view`, only your own payslips of approved runs |
| GET | `/payslips/:id` | `payroll.view`, or own | `lines: [{ code, name, kind, amount, computed?, note? }]` |

Payroll error codes: `PAYROLL_RULE_ERROR` (422, bad rule chain), `DUPLICATE` (409),
`MAPPING_MISSING` / `NO_PERIOD` / `PERIOD_CLOSED` (422, from the ledger on approval).
