## HR core (Phase 5)

Services: `src/features/hr/{org,employees,attendance,leave}.ts`. Employees and their
attendance/leave are company-scoped (`companyScopeWhere`); designations are org-wide.
Self-service acts on the employee linked to the caller (`Employee.userId`).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/departments` | any HR read¹ / `hr.administer` | `?companyId`; `{ companyId, code, name, parentId? }`, parent must be in the same company, no loops |
| PATCH | `/departments/:id` | `hr.administer` | `{ code?, name?, parentId?, isActive? }` |
| GET / POST (idem) | `/designations` | any HR read¹ / `hr.administer` | `{ name, level? }`, name unique per organization |
| PATCH | `/designations/:id` | `hr.administer` | |
| GET / POST (idem) | `/shifts` | any HR read¹ / `hr.administer` | `{ companyId, name, startTime "HH:MM", endTime, graceMinutes=10, workDays "1,2,3,4,5" }` (ISO weekdays; employees without a shift work Mon–Fri) |
| PATCH | `/shifts/:id` | `hr.administer` | also `isActive` |
| GET / POST (idem) | `/holidays` | any HR read¹ / `hr.administer` | `?companyId&year`; `{ companyId, date, name }`, one per company per date |
| DELETE | `/holidays/:id` | `hr.administer` | Existing leave is not re-priced |
| GET / POST (idem) | `/employees` | `employee.view` (or `hr.view`) / `employee.create` | Filters `status, companyId, departmentId, managerId, q`; POST `{ companyId, branchId?, firstName, lastName?, joiningDate, status: ONBOARDING\|ACTIVE, departmentId?, designationId?, managerId?, shiftId?, userId?, workEmail?, phone?, dateOfBirth?, employmentType? }` → number `EMP-00001` per company |
| GET | `/employees/me` | signed in | Own employee record or `null` |
| GET / PATCH | `/employees/:id` | `employee.view` (own record always) / `employee.update` | PATCH profile, `managerId` (loops → 422), `shiftId`, `userId`; not after exit. GET includes events and direct reports |
| POST (idem) | `/employees/:id/{activate\|confirm\|transfer\|promote\|notice\|withdraw_notice\|exit}` | `employee.update` | ONBOARDING→ACTIVE (`joiningDate?`); `confirm { confirmationDate }`; `transfer { departmentId?, branchId?, effectiveDate, note? }`; `promote { designationId, effectiveDate }`; ACTIVE→ON_NOTICE `{ exitDate, reason }`; ON_NOTICE→ACTIVE; →EXITED `{ exitDate?, reason? }` (blocked while the employee has active direct reports; cancels pending leave). Each writes an `EmploymentEvent` |
| GET / POST (idem) | `/attendance` | `attendance.view`² / `attendance.record` | Filters `employeeId, from, to, status, mine=true`; POST `{ date, entries: [{ employeeId, status, checkIn?, checkOut?, notes? }] }` (≤500, all-or-nothing; times are ISO or `"HH:MM"` in the org timezone). Overwrites are audited with previous values |
| GET | `/attendance/:id` | as above | Includes corrections |
| POST (idem) | `/attendance/check-in` · `/attendance/check-out` | `attendance.self` | Today in the org timezone; late minutes from the shift start + grace |
| GET / POST (idem) | `/attendance-corrections` | `attendance.self` or `.record` (own requests) / `attendance.approve` (all in scope) | `?status&mine=true`; POST `{ attendanceId \| date, reason, proposed: { status?, checkIn?, checkOut?, notes? } }`. `date` (own record) creates an ABSENT record when none exists. One pending correction per record |
| POST (idem) | `/attendance-corrections/:id/{approve\|reject\|cancel}` | `attendance.approve` / requester | Approver must not be the requester or the employee (403). Approval applies the change and recomputes worked/late minutes; history is in the audit trail of the attendance record. `reject { reason }` |
| GET / POST (idem) | `/leave-types` | any HR read¹ / `hr.administer` | `{ companyId, code, name, annualQuota, carryForwardMax=0, isPaid=true, allowNegative=false }` |
| PATCH | `/leave-types/:id` | `hr.administer` | also `isActive` |
| GET / POST (idem) | `/leave-balances` | `leave.view` / own / reports' ; `hr.administer` | GET `?employeeId&year` (default own, current year) returns `available = opening + accrued + adjusted − used − pending`. POST sets `{ employeeId, leaveTypeId, year, opening?, accrued?, adjusted?, note? }` |
| POST (idem) | `/leave-balances/allocate` | `hr.administer` | `{ companyId, year, leaveTypeId? }` — accrued = annual quota for every non-exited employee; new rows carry forward min(last year's available, carryForwardMax). Re-runnable |
| GET / POST (idem) | `/leave-requests` | `leave.apply` (own) · `leave.approve` (on behalf, `employeeId`) | Filters `status, employeeId, mine=true, toApprove=true`. POST `{ leaveTypeId, startDate, endDate, halfDayStart?, halfDayEnd?, reason?, employeeId? }`; days exclude weekly offs and holidays; `422 OVERLAP`, `422 INSUFFICIENT_BALANCE` unless the type allows negative; reserves the days as pending |
| GET | `/leave-requests/:id` | applicant / reporting manager / `leave.view` | |
| POST (idem) | `/leave-requests/:id/{approve\|reject\|cancel}` | reporting manager or `leave.approve`, never the applicant (403) / applicant or `leave.approve` | PENDING→APPROVED (pending→used) / REJECTED `{ reason }` / CANCELLED; APPROVED→CANCELLED restores used days (applicants only before the leave starts) |
| GET | `/leave-calendar` | `leave.view` / `leave.apply` (own + reports) | `?from&to` (≤92 days) `&companyId&departmentId&includePending=true` → `{ leaves, holidays }` |

¹ Any of `hr.view`, `employee.view`, `attendance.view`, `leave.view`, `leave.apply`, `attendance.self`.
² Without `attendance.view`/`.record`/`.approve`, callers see their own and their direct reports' records.

Notifications: leave applied → reporting manager; leave decided → applicant; correction decided → requester.
