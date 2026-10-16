import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { createTask } from "@/features/tasks/service";
import { createTicket } from "@/features/service/tickets";
import { evaluateConditions, renderTemplate, type Condition } from "@/features/automation/conditions";
import { dispatchWorkflows } from "@/features/automation/engine";
import { decideApproval, escalateApprovals, getApproval, listApprovals } from "@/features/automation/approvals";
import { createWorkflow, getWorkflow, getWorkflowRun, listWorkflows, testWorkflow, updateWorkflow } from "@/features/automation/workflows";
import * as workflowsRoute from "@/app/api/v1/workflows/route";
import * as workflowActionRoute from "@/app/api/v1/workflows/[id]/[action]/route";
import * as approvalActionRoute from "@/app/api/v1/approvals/[id]/[action]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
// Real createTask, wrapped so one test can make it fail.
vi.mock("@/features/tasks/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/features/tasks/service")>();
  return { ...mod, createTask: vi.fn(mod.createTask) };
});

let a: OrgFixture;
let b: OrgFixture;
let admin: AccessContext; // workflow author (admin role: workflow.manage)
let mgr: AccessContext; // service_manager: raises tickets (the actor)
let mgr2Id: string; // second service_manager
let approverId: string;
let techId: string;
let bAdmin: AccessContext;

const MIN = 60_000;
const later = (ms = 5 * MIN) => new Date(Date.now() + ms);

beforeAll(async () => {
  a = await createOrg("Workflows A");
  b = await createOrg("Workflows B");
  admin = await a.ctx((await a.addMember("admin")).userId);
  mgr = await a.ctx((await a.addMember("service_manager")).userId);
  mgr2Id = (await a.addMember("service_manager")).userId;
  approverId = (await a.addMember("sales_manager")).userId;
  techId = (await a.addMember("technician")).userId;
  bAdmin = await b.ctx((await b.addMember("admin")).userId);
});
afterEach(() => prisma.workflowDefinition.updateMany({ where: { organizationId: a.org.id }, data: { isEnabled: false } }));
afterAll(cleanupFixtures);

let n = 0;
const def = (extra: Record<string, unknown> = {}) => ({
  name: `WF ${++n}`,
  triggerEntity: "ticket",
  triggerAction: "ticket.created",
  isEnabled: true,
  actions: [{ type: "notify_user", params: { userId: approverId, title: "Ticket {{number}}" } }],
  ...extra,
});
const ticket = (priority = "HIGH", subject = "Printer jam") => createTicket(mgr, { companyId: a.company.id, subject, priority });
const runsOf = (workflowId: string) => prisma.workflowRun.findMany({ where: { workflowId }, include: { events: { orderBy: { createdAt: "asc" } } }, orderBy: { startedAt: "asc" } });

describe("definitions", () => {
  it("validates trigger, conditions, actions and approval steps at save (422)", async () => {
    const bad = (extra: Record<string, unknown>) => expect(createWorkflow(admin, def(extra))).rejects.toMatchObject({ name: "ZodError" });
    await bad({ triggerEntity: "payroll_secret" });
    await bad({ triggerAction: "workflow.created" }); // engine actions are never triggers
    await bad({ conditions: [{ field: "password", op: "eq", value: "x" }] }); // field not allowlisted
    await bad({ conditions: [{ field: "subject", op: "gt", value: "a" }] }); // ordered op on a string
    await bad({ conditions: [{ field: "priority", op: "eq", value: "SUPER" }] }); // not an option
    await bad({ conditions: [{ field: "escalationLevel", op: "gte", value: "2" }] }); // number must be a number
    await bad({ conditions: [{ field: "subject", op: "regex", value: ".*" }] }); // unknown operator
    await bad({ actions: [] });
    await bad({ actions: [{ type: "run_script", params: { code: "process.exit()" } }] });
    await bad({ actions: [{ type: "notify_user", params: { userId: "not-a-uuid", title: "x" } }] });
    await bad({ actions: [{ type: "notify_user", params: { userId: approverId, title: "x", url: "http://evil" } }] }); // strict params
    await bad({ actions: [{ type: "create_task", params: { title: "{{constructor}}" } }] }); // unknown template field
    await bad({ actions: [{ type: "create_task", params: { title: "x", dueInDays: 1000 } }] });
    await bad({ actions: [{ type: "request_approval", params: {} }, { type: "notify_record_owner", params: { title: "x" } }], approvalSteps: [{ approverUserId: approverId }] });
    await bad({ actions: [{ type: "request_approval", params: {} }] }); // no steps
    await bad({ approvalSteps: [{ approverUserId: approverId }] }); // steps without request_approval
    await bad({ actions: [{ type: "request_approval", params: {} }], approvalSteps: [{ approverUserId: approverId, approverRoleCode: "admin" }] });

    await expect(createWorkflow(admin, def({ actions: [{ type: "notify_role", params: { roleCode: "no_such_role", title: "x" } }] }))).rejects.toMatchObject({ status: 422, code: "INVALID_REFERENCE" });
    const outsider = (await b.addMember("admin")).userId;
    await expect(createWorkflow(admin, def({ actions: [{ type: "notify_user", params: { userId: outsider, title: "x" } }] }))).rejects.toMatchObject({ status: 422 });
  });

  it("needs workflow.manage / workflow.view (403) and hides other tenants' workflows (404)", async () => {
    await expect(createWorkflow(mgr, def())).rejects.toMatchObject({ status: 403 });
    await expect(listWorkflows(mgr, {})).rejects.toMatchObject({ status: 403 });
    const wf = await createWorkflow(admin, def({ isEnabled: false }));
    await expect(getWorkflow(bAdmin, wf.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateWorkflow(bAdmin, wf.id, { isEnabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(testWorkflow(bAdmin, wf.id, { next: {} })).rejects.toMatchObject({ status: 404 });
  });

  it("route: 422 on invalid definitions; Idempotency-Key replays the create", async () => {
    await signInAs(admin.userId);
    const invalid = await call(workflowsRoute.POST, { method: "POST", body: def({ conditions: [{ field: "nope", op: "eq", value: 1 }] }) });
    expect(invalid.status).toBe(422);
    expect(invalid.json.code).toBe("VALIDATION_ERROR");
    const body = def({ isEnabled: false });
    const headers = { "idempotency-key": `wf-create-${a.org.id}` };
    const first = await call(workflowsRoute.POST, { method: "POST", body, headers });
    const second = await call(workflowsRoute.POST, { method: "POST", body, headers });
    expect(first.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(await prisma.workflowDefinition.count({ where: { organizationId: a.org.id, name: body.name } })).toBe(1);
  });
});

describe("conditions", () => {
  const snap = {
    previous: { status: "OPEN", amount: "50" },
    next: { status: "IN_PROGRESS", amount: "100.10", probability: 40, subject: "Big Printer jam", expectedCloseDate: "2026-10-01T00:00:00.000Z", stage: "PROPOSAL" },
  };
  const check = (entity: string, conditions: Condition[]) => evaluateConditions(entity, conditions, snap).matched;

  it("supports every operator, with decimals compared exactly", () => {
    const o = (field: string, op: Condition["op"], value?: unknown) => check("opportunity", [{ field, op, value }]);
    expect(o("amount", "eq", "100.1")).toBe(true); // 100.10 == 100.1 as decimals
    expect(o("amount", "gt", "100.09")).toBe(true);
    expect(o("amount", "gte", "100.10")).toBe(true);
    expect(o("amount", "lt", "100.1")).toBe(false);
    expect(o("amount", "lte", "100.1")).toBe(true);
    expect(o("probability", "gt", 39)).toBe(true);
    expect(o("probability", "neq", 40)).toBe(false);
    expect(o("stage", "in", ["PROPOSAL", "NEGOTIATION"])).toBe(true);
    expect(o("stage", "not_in", ["PROPOSAL"])).toBe(false);
    expect(o("name", "exists")).toBe(false);
    expect(o("name", "exists", false)).toBe(true);
    expect(o("amount", "changed")).toBe(true);
    expect(o("currency", "changed")).toBe(false);
    expect(o("expectedCloseDate", "lt", "2026-12-31")).toBe(true);
    expect(o("lossReason", "eq", "x")).toBe(false); // missing field compares false
    expect(o("lossReason", "neq", "x")).toBe(false);
    expect(check("ticket", [{ field: "subject", op: "contains", value: "printer" }])).toBe(true);
    expect(check("ticket", [{ field: "status", op: "eq", value: "IN_PROGRESS" }, { field: "subject", op: "contains", value: "fax" }])).toBe(false); // all must hold
    expect(check("ticket", [])).toBe(true);
  });

  it("treats code-looking values as data", () => {
    const injected = { next: { subject: "'; DROP TABLE workflow_runs; --", number: "{{subject}}" } };
    expect(evaluateConditions("ticket", [{ field: "subject", op: "eq", value: "process.exit()" }], injected).matched).toBe(false);
    expect(evaluateConditions("ticket", [{ field: "subject", op: "contains", value: "DROP TABLE" }], injected).matched).toBe(true);
    // a value is substituted once, never re-rendered; unknown fields render empty
    expect(renderTemplate("ticket", "{{number}} | {{subject}} | {{__proto__}}", injected.next)).toBe("{{subject}} | '; DROP TABLE workflow_runs; -- | ");
  });
});

describe("dispatcher", () => {
  it("creates runs from audit rows, skips non-matching events, executes actions, advances the cursor", async () => {
    const wf = await createWorkflow(admin, def({
      conditions: [{ field: "priority", op: "in", value: ["HIGH", "URGENT"] }],
      actions: [
        { type: "notify_user", params: { userId: approverId, title: "Hot ticket {{number}}", body: "{{subject}}" } },
        { type: "create_task", params: { title: "Call back on {{number}}", assigneeUserId: approverId, dueInDays: 1 } },
        { type: "notify_record_owner", params: { title: "Your ticket {{number}} is hot" } },
      ],
    }));
    const hot = await ticket("HIGH", "Server down");
    const cold = await ticket("LOW");

    await dispatchWorkflows(later());
    const runs = await runsOf(wf.id);
    expect(runs.map((r) => [r.entityId, r.status])).toEqual([[hot.id, "COMPLETED"], [cold.id, "SKIPPED"]]);
    const [run, skipped] = runs;
    expect(skipped.events.map((e) => [e.kind, e.status])).toEqual([["CONDITIONS", "SKIPPED"]]);
    expect(run.events.map((e) => [e.kind, e.status])).toEqual([["CONDITIONS", "OK"], ["ACTION", "OK"], ["ACTION", "OK"], ["ACTION", "OK"]]);

    const note = await prisma.notification.findFirstOrThrow({ where: { organizationId: a.org.id, userId: approverId, dedupeKey: `wf:${run.id}:0` } });
    expect(note).toMatchObject({ title: `Hot ticket ${hot.number}`, body: "Server down" });
    expect(await prisma.notification.count({ where: { organizationId: a.org.id, userId: mgr.userId, dedupeKey: `wf:${run.id}:2` } })).toBe(1); // ticket creator
    const task = await prisma.task.findFirstOrThrow({ where: { organizationId: a.org.id, entityType: "ticket", entityId: hot.id } });
    expect(task).toMatchObject({ title: `Call back on ${hot.number}`, assignedUserId: approverId, createdById: admin.userId });

    const lastAudit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "ticket.created" }, orderBy: { createdAt: "desc" } });
    expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: wf.id } })).cursorAt).toEqual(lastAudit.createdAt);

    // reruns (sequential and overlapping) create nothing new
    await dispatchWorkflows(later());
    await Promise.all([dispatchWorkflows(later()), dispatchWorkflows(later())]);
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(2);
    expect(await prisma.workflowRunEvent.count({ where: { runId: run.id } })).toBe(4);
    expect(await prisma.notification.count({ where: { organizationId: a.org.id, dedupeKey: { startsWith: `wf:${run.id}:` } } })).toBe(2);
    expect(await prisma.task.count({ where: { organizationId: a.org.id, entityId: hot.id } })).toBe(1);

    // the run history API
    const detail = await getWorkflowRun(admin, run.id);
    expect(detail.events).toHaveLength(4);
    await expect(getWorkflowRun(bAdmin, run.id)).rejects.toMatchObject({ status: 404 });
  });

  it("records a failed action with a sanitized error, keeps the other results, and marks the run FAILED", async () => {
    const wf = await createWorkflow(admin, def({
      actions: [
        { type: "create_task", params: { title: "Follow up {{number}}" } },
        { type: "notify_user", params: { userId: approverId, title: "Still notified" } },
      ],
    }));
    vi.mocked(createTask).mockRejectedValueOnce(new Error("upstream 500 Authorization: Bearer FAKE-TOKEN-0123456789abcdef"));
    await ticket();
    await dispatchWorkflows(later());
    const [run] = await runsOf(wf.id);
    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("[redacted]");
    expect(run.error).not.toContain("FAKE-TOKEN");
    expect(run.events.map((e) => [e.kind, e.status])).toEqual([["CONDITIONS", "OK"], ["ACTION", "FAILED"], ["ACTION", "OK"]]);
    expect(run.events[1].message).not.toContain("abcdefghij");
    await dispatchWorkflows(later()); // not retried
    expect(await prisma.workflowRunEvent.count({ where: { runId: run.id } })).toBe(3);
  });

  it("resumes a stale run: the interrupted action is recorded FAILED, never retried; the rest runs", async () => {
    const wf = await createWorkflow(admin, def({ isEnabled: false }));
    const actions = [
      { type: "notify_user", params: { userId: approverId, title: "first" } },
      { type: "notify_user", params: { userId: approverId, title: "second" } },
    ];
    const run = await prisma.workflowRun.create({
      data: {
        organizationId: a.org.id, workflowId: wf.id, sourceEventId: `crashed-${wf.id}`, entityType: "ticket", entityId: null,
        status: "RUNNING", currentStep: 1, startedAt: new Date(Date.now() - 60 * MIN),
        snapshot: { actorUserId: null, companyId: null, previous: null, next: {}, actions, approvalSteps: [] },
      },
    });
    await updateWorkflow(admin, wf.id, { isEnabled: true });
    await dispatchWorkflows(later());
    const [after] = await runsOf(wf.id);
    expect(after.status).toBe("FAILED");
    expect(after.events.map((e) => [e.status, (e.data as { index: number }).index])).toEqual([["FAILED", 0], ["OK", 1]]);
    expect(await prisma.notification.count({ where: { organizationId: a.org.id, dedupeKey: { startsWith: `wf:${run.id}:` } } })).toBe(1);
  });

  it("ignores disabled workflows; enabling starts from now, not history", async () => {
    const wf = await createWorkflow(admin, def({ isEnabled: false }));
    await ticket();
    await dispatchWorkflows(later());
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(0);

    await updateWorkflow(admin, wf.id, { isEnabled: true });
    await dispatchWorkflows(later());
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(0); // the old event stays ignored
    const fresh = await ticket();
    await dispatchWorkflows(later());
    expect((await runsOf(wf.id)).map((r) => r.entityId)).toEqual([fresh.id]);
  });

  it("dry-run test endpoint evaluates and plans without executing", async () => {
    const wf = await createWorkflow(admin, def({
      isEnabled: false,
      conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
      actions: [{ type: "create_task", params: { title: "Escalate {{number}}: {{subject}}" } }],
    }));
    await signInAs(admin.userId);
    const res = await call(workflowActionRoute.POST, { method: "POST", params: { id: wf.id, action: "test" }, body: { next: { priority: "URGENT", number: "TKT-1", subject: "process.exit()" } } });
    expect(res.status).toBe(200);
    expect(res.json.data.matched).toBe(true);
    expect(res.json.data.actions).toEqual([{ index: 0, type: "create_task", params: { title: "Escalate TKT-1: process.exit()" } }]);
    const miss = await call(workflowActionRoute.POST, { method: "POST", params: { id: wf.id, action: "test" }, body: { next: { priority: "LOW" } } });
    expect(miss.json.data).toMatchObject({ matched: false, actions: [] });
    expect((await call(workflowActionRoute.POST, { method: "POST", params: { id: wf.id, action: "run" }, body: {} })).status).toBe(404);
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(0);
  });
});

describe("approvals", () => {
  const approvalWorkflow = (steps: Record<string, unknown>[]) =>
    createWorkflow(admin, def({ actions: [{ type: "request_approval", params: { title: "Approve {{number}}" } }], approvalSteps: steps }));

  it("runs steps in order (user, then role), forbids self-approval, and completes the run", async () => {
    const wf = await approvalWorkflow([{ approverUserId: approverId }, { approverRoleCode: "service_manager" }]);
    const t = await ticket();
    await dispatchWorkflows(later());
    const [run] = await runsOf(wf.id);
    expect(run.status).toBe("WAITING_APPROVAL");
    const step1 = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    expect(step1).toMatchObject({ status: "PENDING", stepIndex: 0, approverUserId: approverId, title: `Approve ${t.number}`, entityType: "ticket", entityId: t.id });
    expect(await prisma.notification.count({ where: { userId: approverId, dedupeKey: `approval:${step1.id}` } })).toBe(1);

    const approver = await a.ctx(approverId);
    const tech = await a.ctx(techId);
    expect((await listApprovals(approver, { status: "PENDING" })).items.map((r) => r.id)).toContain(step1.id);
    await expect(getApproval(tech, step1.id)).rejects.toMatchObject({ status: 404 });
    await expect(decideApproval(tech, step1.id, "approve", {})).rejects.toMatchObject({ status: 404 });
    await expect(decideApproval(bAdmin, step1.id, "approve", {})).rejects.toMatchObject({ status: 404 });
    await expect(decideApproval(admin, step1.id, "approve", {})).rejects.toMatchObject({ status: 403 }); // sees all, not assigned

    await decideApproval(approver, step1.id, "approve", { comment: "ok" });
    await expect(decideApproval(approver, step1.id, "approve", {})).rejects.toMatchObject({ status: 422, code: "INVALID_STATE" });
    const step2 = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id, stepIndex: 1 } });
    expect(step2).toMatchObject({ status: "PENDING", approverRoleCode: "service_manager" });

    // mgr holds the role but raised the ticket
    await expect(decideApproval(mgr, step2.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    await decideApproval(await a.ctx(mgr2Id), step2.id, "approve", {});
    const done = await getWorkflowRun(admin, run.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.events.filter((e) => e.kind === "APPROVAL")).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "approval.approved", entity: "ticket", entityId: t.id } })).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(t.status); // informational only
  });

  it("rejection needs a comment and ends the run REJECTED (via the route)", async () => {
    const wf = await approvalWorkflow([{ approverUserId: approverId }, { approverUserId: mgr2Id }]);
    await ticket();
    await dispatchWorkflows(later());
    const [run] = await runsOf(wf.id);
    const step1 = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    await signInAs(approverId);
    const noComment = await call(approvalActionRoute.POST, { method: "POST", params: { id: step1.id, action: "reject" }, body: {} });
    expect(noComment.status).toBe(422);
    expect((await call(approvalActionRoute.POST, { method: "POST", params: { id: step1.id, action: "delete" }, body: {} })).status).toBe(404);
    const res = await call(approvalActionRoute.POST, { method: "POST", params: { id: step1.id, action: "reject" }, body: { comment: "Not needed" } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: "REJECTED", comment: "Not needed" });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("REJECTED");
    expect(await prisma.approvalRequest.count({ where: { runId: run.id } })).toBe(1); // later steps never opened
  });

  it("escalates timed-out steps once, idempotently", async () => {
    const wf = await approvalWorkflow([{ approverUserId: approverId, timeoutHours: 1, escalateToUserId: mgr2Id }]);
    await ticket();
    await dispatchWorkflows(later());
    const [run] = await runsOf(wf.id);
    const original = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    expect(original.dueAt!.getTime() - Date.now()).toBeGreaterThan(55 * MIN);

    await escalateApprovals(new Date(Date.now() + 30 * MIN)); // not due yet
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: original.id } })).status).toBe("PENDING");

    const at = later(2 * 60 * MIN);
    await escalateApprovals(at);
    await Promise.all([escalateApprovals(at), escalateApprovals(at)]);
    const rows = await prisma.approvalRequest.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.approverUserId])).toEqual([["ESCALATED", approverId], ["PENDING", mgr2Id]]);
    expect(rows[0].escalatedAt).toEqual(at);
    expect(await prisma.notification.count({ where: { userId: mgr2Id, dedupeKey: `approval:${rows[1].id}` } })).toBe(1);
    expect(await prisma.workflowRunEvent.count({ where: { runId: run.id, kind: "ESCALATION" } })).toBe(1);

    await expect(decideApproval(await a.ctx(approverId), original.id, "approve", {})).rejects.toMatchObject({ status: 422 });
    await decideApproval(await a.ctx(mgr2Id), rows[1].id, "approve", {});
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("COMPLETED");
  });
});
