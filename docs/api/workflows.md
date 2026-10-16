## Workflows and approvals (Phase 6)

All endpoints are under `/api/v1` with the shared `{ ok, data }` / `{ ok: false, error, code, details? }`
shape. "(idem)" endpoints honour `Idempotency-Key`. Lists take `page, pageSize, sort, dir, q`.
Services: `src/features/automation/{catalog,conditions,actions,engine,approvals,workflows}.ts`.
Concepts, catalog and guarantees: [docs/WORKFLOWS.md](../WORKFLOWS.md).

### Workflows

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST (idem) | `/workflows` | `workflow.view` / `workflow.manage` | Filters `triggerEntity, enabled=true\|false`; sort `createdAt, name, updatedAt`; items carry `_count.runs`. POST body below; 201 |
| GET / PATCH | `/workflows/:id` | `workflow.view` / `workflow.manage` | PATCH any body field; the merged definition is re-validated. `isEnabled` false→true moves `cursorAt` to now |
| POST | `/workflows/:id/test` | `workflow.view` | Dry run. `{ next: { field: value… }, previous?: {…} }` → `{ matched, conditions: [{ field, op, value, actual, result }], actions: [{ index, type, params }], approvalSteps }` (actions rendered with the sample; empty when not matched). Executes nothing. Other actions → 404 |
| GET | `/workflow-runs` | `workflow.view` | Filters `workflowId, status, entityId`; sort `startedAt, finishedAt` |
| GET | `/workflow-runs/:id` | `workflow.view` | Adds `events` (CONDITIONS / ACTION / APPROVAL / ESCALATION, each OK / FAILED / SKIPPED with `message`, `data`) and `approvals` |

Workflow body:

```json
{
  "name": "Escalate urgent tickets",
  "description": "optional",
  "triggerType": "EVENT",
  "triggerEntity": "ticket",
  "triggerAction": "ticket.created",
  "conditions": [{ "field": "priority", "op": "in", "value": ["HIGH", "URGENT"] }],
  "actions": [
    { "type": "notify_role", "params": { "roleCode": "service_manager", "title": "Urgent ticket {{number}}", "body": "{{subject}}" } },
    { "type": "create_task", "params": { "title": "Call back on {{number}}", "dueInDays": 1 } },
    { "type": "request_approval", "params": { "title": "Approve handling of {{number}}" } }
  ],
  "approvalSteps": [
    { "approverUserId": "<uuid>", "timeoutHours": 4, "escalateToUserId": "<uuid>" },
    { "approverRoleCode": "admin" }
  ],
  "isEnabled": true
}
```

Validation (422 `VALIDATION_ERROR` with `details[].path`, or `INVALID_REFERENCE`): entity and action
must be in the catalog; condition fields must be allowlisted for the entity, the operator supported
for the field's type and the value typed (enum options, numbers, decimal strings, ISO dates); action
types and params come from the allowlist (unknown params rejected); `{{field}}` placeholders must be
allowlisted fields; `request_approval` must be the last action and goes together with 1–10 approval
steps; each step names exactly one of `approverUserId` / `approverRoleCode`, `escalateToUserId` needs
`timeoutHours`; users must be active members and roles must exist. Names are unique per org (409).

### Approvals

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/approvals` | assigned (user or role) | `scope=mine` (default) or `all` (needs `approval.view_all`); filters `status, runId`; sort `createdAt, dueAt`; items include `run.workflow` |
| GET | `/approvals/:id` | assigned or `approval.view_all` | Adds `canDecide`. Others → 404 |
| POST (idem) | `/approvals/:id/{approve\|reject}` | assigned | `{ comment? }`, comment required to reject (422). Not assigned but visible → 403; the user who triggered the run → 403; not PENDING → 422 `INVALID_STATE`; unknown action → 404 |

Approving a step opens the next one; approving the last completes the run and writes audit
`approval.approved` on the record (`entity`/`entityId` of the trigger); rejecting ends the run as
`REJECTED` (`approval.rejected`). The record's own status is never changed.

### Jobs

| Name | Function | What it does |
|---|---|---|
| `workflow-dispatch` | `dispatchWorkflows(now)` | Turns new audit rows into runs and executes their actions |
| `approval-escalation` | `escalateApprovals(now)` | Hands timed-out steps to their escalation user |
