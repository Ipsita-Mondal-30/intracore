# Workflows

Configurable, deterministic automation. A workflow is **data** — a trigger, conditions, actions and
approval steps validated against allowlists — interpreted by `src/features/automation`. No
JavaScript, SQL, shell or user-supplied code is ever executed: there is no `eval`, `Function`,
dynamic import or raw SQL built from definitions. Values that look like code (`process.exit()`,
`'; DROP TABLE …`) are compared and rendered as plain strings. API: [docs/api/workflows.md](api/workflows.md).

## Model

| Part | Shape |
|---|---|
| Trigger | `triggerEntity` + `triggerAction`: an audit-log action written by a module service (e.g. `ticket` / `ticket.created`) |
| Conditions | `[{ field, op, value }]`, all must hold; fields come from the audit row's `next` snapshot plus `id` |
| Actions | `[{ type, params }]` from the allowlist, run in order |
| Approval steps | `[{ approverUserId \| approverRoleCode, timeoutHours?, escalateToUserId? }]`, sequential |
| State | `isEnabled`; `cursorAt` = audit high-water mark |
| History | `WorkflowRun` per (workflow, audit row) + `WorkflowRunEvent` per step, with sanitized errors |

## Trigger catalog (`catalog.ts`)

| Entity | Actions | Condition / template fields (plus `id`) |
|---|---|---|
| `lead` | `lead.converted` (the only lead action in the audit log) | status, customerId, contactId, opportunityId |
| `customer` | `customer.created/updated/archived` | name, type, email, phone, gstin, stateCode, paymentTermsDays, creditLimit, ownerUserId, status, createdById |
| `opportunity` | `opportunity.created/updated/stage_changed` | name, stage, probability, amount, currency, expectedCloseDate, ownerUserId, customerId, lossReason, createdById |
| `quotation` | `quotation.created/updated/submit/approve/return/send/accept/reject/cancel/revised/converted/expired` | number, status, customerId, subtotal, taxTotal, grandTotal, currency, validUntil, approvalRequired, revision, reason, createdById |
| `sales_order` | `sales_order.created/confirmed/cancelled/reserved` | number, status, customerId, grandTotal, currency, orderDate, expectedDeliveryDate, reason, createdById |
| `purchase_order` | `purchase_order.created/updated/submit/approve/return/cancel/close` | number, status, vendorId, grandTotal, currency, orderDate, expectedDate, approvalRequired, reason, createdById |
| `vendor_bill` | `vendor_bill.created/approved/posted/cancelled` | number, vendorInvoiceNumber, status, vendorId, purchaseOrderId, grandTotal, billDate, dueDate, reason, createdById |
| `sales_invoice` | `invoice.created/updated/posted/cancelled` | number, status, customerId, grandTotal, paidAmount, invoiceDate, dueDate, reason, createdById |
| `expense_claim` | `expense_claim.created/updated/submit/approve/reject/cancel/pay` | number, title, status, totalAmount, total, claimantId, reason |
| `ticket` | `ticket.created/updated/assign/start/hold/resolve/close/reopen/cancel/feedback/escalated` | number, subject, priority, status, source, customerId, categoryId, assigneeId, escalationLevel, resolutionCode, rating, reason, createdById |
| `leave_request` | `leave_request.applied/approve/reject/cancel` | status, days, startDate, endDate, leaveType, reason |
| `work_order` | `work_order.created/release/reserve/start/complete/cancel/materials_issued/goods_received` | number, status, productId, quantity, producedQty, plannedStart, plannedEnd, salesOrderId, reason, createdById |

Snapshots differ by action: `*.created` carries the whole record; transitions carry what changed
(usually `status` plus the action's inputs such as `reason`); `*.updated` carries changed fields
only. A condition on a field the snapshot does not carry is false. The engine's own audit actions
(`workflow.*`, `approval.*`) are never triggers, so workflows cannot loop.

## Operators (`conditions.ts`)

| Operator | Types | Value |
|---|---|---|
| `eq`, `neq` | all | one typed value |
| `in`, `not_in` | all | 1–50 typed values |
| `gt`, `gte`, `lt`, `lte` | number, decimal, date | one typed value |
| `contains` | string | substring, case-insensitive |
| `exists` | all | boolean (default true): field present and not null |
| `changed` | all | boolean (default true): field in `next` and different from `previous` |

Decimals are compared with `Prisma.Decimal` (`"100.10" eq "100.1"`); dates by timestamp; enum
fields accept only their options. Missing/null values compare false (except `exists:false`,
`changed:false`); a malformed stored value evaluates false rather than throwing.

## Actions (`actions.ts`)

| Type | Params | Effect |
|---|---|---|
| `notify_user` | `userId, title, body?` | In-app notification (fails if the user is no longer active) |
| `notify_role` | `roleCode, title, body?` | Notification to every active member with the role (SKIPPED if none) |
| `notify_record_owner` | `title, body?` | First of `ownerUserId`, `assigneeId`, `claimantId`, `createdById` in the snapshot (SKIPPED if none) |
| `create_task` | `title, description?, assigneeUserId?, dueInDays?` | Task via `features/tasks`, created as the workflow's author (their permissions apply), linked to the record when it is a task-attachable entity |
| `request_approval` | `title?` | Opens approval step 1; must be the last action |

`title`, `body` and `description` may contain `{{field}}` for allowlisted fields: a single plain
text substitution (substituted values are not re-scanned; objects render empty).

## Approvals (`approvals.ts`)

- Steps are sequential. A step targets one user or every active member of a role; any of them
  may decide. The user whose action produced the trigger event can never decide (403).
- Approve → next step, or run `COMPLETED` + audit `approval.approved` on the record. Reject
  (comment required) → run `REJECTED` + audit `approval.rejected`. The requester is notified.
- **Approvals are informational.** They never change the business record's status; module
  approvals (quotation/PO/vendor-bill/expense/leave) stay in their modules.
- **Escalation**: a PENDING step past `dueAt` with `escalateToUserId` is claimed (→ `ESCALATED`,
  `escalatedAt`) and a new PENDING request for the same step is created for the escalation user
  (no further timeout). The old row stays as history. Steps without an escalation user stay pending.

## Guarantees

- **Exactly one run per (workflow, audit row)**: unique `(workflowId, sourceEventId)`; the run and
  its CONDITIONS event are created in one transaction. Non-matching events are recorded as SKIPPED.
- **Actions at most once**: each action is claimed by advancing `currentStep` with a conditional
  `updateMany` before it runs, so overlapping or repeated dispatches never repeat it. A dispatcher
  crash mid-action leaves the run RUNNING; after 15 minutes the next dispatch resumes it, records
  the interrupted action as FAILED ("not retried") and continues. Notifications additionally carry
  `dedupeKey wf:<runId>:<index>` / `approval:<requestId>`.
- **Failures**: an action error is recorded as a FAILED event with a sanitized message
  (`src/lib/sanitize.ts`); later actions still run (except `request_approval`), and the run ends
  `FAILED` with the first error.
- **Cursor**: the dispatcher scans `createdAt >= cursorAt`, excluding rows that already have a run,
  500 per workflow per tick, and advances `cursorAt` to the newest row it saw but never past
  `now − 2 min`, so rows from transactions that commit late are still picked up.
- **Enabling** sets `cursorAt` to now: a workflow never replays history. Disabled workflows are
  ignored. Runs keep a copy of the actions/steps they started with.
- **Tenancy**: everything is filtered by organization; other tenants' ids answer 404.

## Jobs

Register in `src/lib/jobs.ts`:

```ts
"workflow-dispatch": () => dispatchWorkflows(),
"approval-escalation": () => escalateApprovals(),
```
