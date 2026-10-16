## Projects, time and service tickets (Phase 5)

All endpoints are under `/api/v1` with the shared `{ ok, data }` / `{ ok: false, error, code, details? }`
shape. "(idem)" endpoints honour `Idempotency-Key`. Lists take `page, pageSize, sort, dir, q`.
Dates are `YYYY-MM-DD`, timestamps ISO-8601, money and hours decimal strings.

### Projects

Services: `src/features/projects/{projects,tasks,time,reports}.ts`.

**Access.** `project.view` is required for everything. Holders of `project.update` (owner, admin,
Project Manager role) see every project in their company scope and act as project `OWNER`. Everyone
else sees only projects where they are a `ProjectMember`; any other project id answers **404**.
Member roles: `VIEWER` read + comment · `MEMBER` + create/edit tasks, log own time · `MANAGER` + edit
project, members, milestones, delete tasks/others' time · `OWNER` + grant/remove `OWNER`.
`project.create` creates (creator → `OWNER`, manager → `MANAGER`); `project.delete` deletes projects
without logged time.

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST (idem) | `/projects` | view / `project.create` | Filters `status, companyId, customerId, mine=true`; items carry `progress {total, done, percent}`. POST `{ companyId, code, name, managerId?, customerId?, startDate?, endDate?, budget?, billable?, hourlyRate?, description? }`; code unique per company (409) |
| GET / PATCH / DELETE | `/projects/:id` | member / MANAGER / OWNER + `project.delete` | GET adds `members`, `milestones`, `progress`, `myRole`. PATCH any create field except `companyId, code`; a new manager becomes a MANAGER member. DELETE → 422 when time is logged |
| POST (idem) | `/projects/:id/{activate\|hold\|complete\|cancel\|reopen}` | MANAGER | PLANNED/ON_HOLD→ACTIVE, ACTIVE→ON_HOLD, ACTIVE/ON_HOLD→COMPLETED, PLANNED/ACTIVE/ON_HOLD→CANCELLED, COMPLETED/CANCELLED→ACTIVE; else 422 `INVALID_STATE` |
| POST (idem) | `/projects/:id/members` | MANAGER | `{ userId, role }` upsert; user must be an active org member; the project manager keeps MANAGER+ |
| POST (idem) | `/projects/:id/remove-member` | MANAGER | `{ userId }`; unassigns their open tasks; the project manager can't be removed |
| POST (idem) | `/projects/:id/milestones` | MANAGER | `{ name, dueDate? }`; project must be open |
| PATCH | `/projects/:id/milestones/:milestoneId` | MANAGER | `{ name?, dueDate?, status: OPEN\|DONE }` |
| GET | `/projects/:id/report` | member | `progress`, tasks by status + overdue, hours (estimated, logged, billable, by user), budget (`actualCost = logged hours × hourlyRate`, `billableAmount`, `remaining`, `usedPercent`), milestone progress |
| GET / POST (idem) | `/project-tasks` | member / MEMBER | Filters `projectId, status, assigneeId, milestoneId, parentId, topLevel=true, mine=true`. POST `{ projectId, title, description?, parentId?, milestoneId?, assigneeId?, priority?, dueDate?, estimateHours? }` |
| GET / PATCH / DELETE | `/project-tasks/:id` | member / MEMBER / MANAGER | GET adds subtasks, comments, `loggedHours`, `activity` (audit log). PATCH same fields; DELETE → 422 with subtasks or logged time |
| POST (idem) | `/project-tasks/:id/status` | MEMBER | `{ status }`: TODO↔IN_PROGRESS↔BLOCKED, →DONE/CANCELLED, DONE→IN_PROGRESS, CANCELLED→TODO. DONE needs all subtasks DONE/CANCELLED |
| POST (idem) | `/project-tasks/:id/comments` | VIEWER | `{ body }` |
| GET / POST (idem) | `/time-entries` | member / member row MEMBER+ | Filters `projectId, taskId, userId, mine=true, from, to, billable`; response adds `totalHours`. POST `{ projectId, taskId?, date, hours, billable?, description? }` |
| PATCH / DELETE | `/time-entries/:id` | author / author or MANAGER | |

Rules
- Parents must be in the same project; moves that would create a cycle → 422 `INVALID_PARENT`.
- Assignees must be project members with role MEMBER+ and active in the org (422).
- Tasks, milestones and time can't change on COMPLETED/CANCELLED projects (422).
- Time: logged by the signed-in user for themselves, `0.01 ≤ hours ≤ 24`, no future dates, at most
  24 h per user per day across all projects (422 `DAILY_LIMIT`, serialized per user/day).
  `billable` defaults to the project's flag. No approval/lock workflow (not in the schema).
- Progress is count-based: DONE / all non-cancelled tasks, subtasks included.
- Attachments: `/documents` with `entityType` `project` or `project_task`. Activity history: the audit
  log (`entity` `project`, `project_task`, `time_entry`).
- Notifications: a task's new assignee gets `PROJECT_TASK_ASSIGNED`.

### Service tickets

Services: `src/features/service/{tickets,sla,ticket-reports}.ts`.

**Access.** `ticket.assign` holders (service managers, admins) see every ticket in their company
scope; others with `ticket.view` (technicians) see tickets assigned to or created by them; anything
else is 404. `ticket.create` opens, `ticket.update` works (status, messages, feedback),
`ticket.assign` assigns, `service.administer` manages categories and SLA policies.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/ticket-categories` | `ticket.view` / `service.administer` | `{ name, isActive? }`, unique per org |
| PATCH | `/ticket-categories/:id` | `service.administer` | |
| GET / POST (idem) | `/sla-policies` | `ticket.view` / `service.administer` | `{ name, priority, firstResponseMinutes, resolutionMinutes, escalateToUserId?, isActive? }`; first response ≤ resolution |
| PATCH | `/sla-policies/:id` | `service.administer` | Applies to new tickets and priority changes only |
| GET / POST (idem) | `/tickets` | `ticket.view` / `ticket.create` | Filters `status, open=true, priority, assigneeId, unassigned=true, mine=true, customerId, categoryId, companyId, breached=true`. POST `{ companyId, subject, description?, priority=MEDIUM, source=OTHER, customerId?, contactId?, assetId?, categoryId?, slaPolicyId?, assigneeId? }` (assignee needs `ticket.assign`) → number `TKT-00001` per company; NEW, or OPEN when assigned |
| GET / PATCH | `/tickets/:id` | `ticket.view` / `ticket.update` | GET includes all messages with `visibility`. PATCH `subject, description, priority, source, customerId, contactId, assetId, categoryId, slaPolicyId`; not on CLOSED/CANCELLED. Priority/policy change recomputes due dates from creation and resets the escalation level |
| POST (idem) | `/tickets/:id/assign` | `ticket.assign` | `{ assigneeId \| null }`; assignee must be an active member with `ticket.view` in the ticket's company; NEW→OPEN; notifies the assignee |
| POST (idem) | `/tickets/:id/{start\|hold\|close\|reopen\|cancel}` | `ticket.update` | NEW/OPEN/ON_HOLD→IN_PROGRESS; OPEN/IN_PROGRESS→ON_HOLD; RESOLVED→CLOSED; RESOLVED/CLOSED→OPEN (clears resolution); active→CANCELLED. Optional `{ reason }` on hold/reopen/cancel |
| POST (idem) | `/tickets/:id/resolve` | `ticket.update` | `{ resolutionCode, resolutionNotes? }`; codes `FIXED, PART_REPLACED, WORKAROUND, CONFIGURATION, CUSTOMER_EDUCATION, NO_FAULT_FOUND, DUPLICATE, WONT_FIX` (422 without one) |
| POST (idem) | `/tickets/:id/feedback` | `ticket.update` | `{ rating 1–5, comment? }`; only RESOLVED/CLOSED (422 otherwise) |
| GET / POST (idem) | `/tickets/:id/messages` | `ticket.view` / `ticket.update` | GET `?visibility=PUBLIC` returns only customer-visible messages. POST `{ body, visibility: INTERNAL\|PUBLIC = INTERNAL, authorType: STAFF\|CUSTOMER = STAFF }` (CUSTOMER must be PUBLIC). The first PUBLIC staff reply stamps `firstRespondedAt` |
| GET | `/service-reports` | `ticket.view` | `?companyId&from&to` (default last 30 days): open by status/priority, overdue, unassigned; resolved count, avg resolution hours, resolution SLA breach rate, avg rating; first-response breach rate; per-technician open/resolved/avg hours/rating |

SLA and escalation
- Clock: calendar time (24x7) from ticket creation; no business hours or holidays, and ON_HOLD does not
  pause it. Policy = the explicit `slaPolicyId`, else the active policy for the priority (first by name).
  Policies are per priority; the schema has no category link.
- Job `escalateOverdueTickets(now)` (`src/features/service/sla.ts`): active tickets (NEW, OPEN,
  IN_PROGRESS, ON_HOLD) escalate to level 1 when the first response is overdue and to level 2 when
  resolution is overdue. Each level is claimed with a conditional `updateMany`
  (`escalationLevel < level`) inside a transaction, so reruns and overlapping runs never repeat it.
  On escalation: `escalatedAt`, a SYSTEM internal note, an audit row, and `TICKET_ESCALATED`
  notifications to the assignee and the policy's `escalateToUserId`.
- Attachments: `/documents` with `entityType=ticket`. History: audit log `entity=ticket`.
