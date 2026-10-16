import { Prisma, type WorkflowDefinition, type WorkflowRun } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sanitizeError } from "@/lib/sanitize";
import { TRIGGER_CATALOG } from "@/features/automation/catalog";
import { evaluateConditions, renderTemplate, type Condition } from "@/features/automation/conditions";
import { executeAction, type ActionContext, type ApprovalStep, type WorkflowAction } from "@/features/automation/actions";
import { createApprovalStep, notifyApprovers, type RunSnapshot } from "@/features/automation/approvals";

/**
 * Workflow dispatcher (job "workflow-dispatch"). For each enabled workflow it reads the
 * org's audit rows for the trigger action from `cursorAt` on, oldest first (≤ 500 per run),
 * skipping rows that already have a run, and for each row:
 *
 * 1. evaluates the conditions and creates the run (SKIPPED when they fail) plus a CONDITIONS
 *    event in one transaction — unique (workflowId, sourceEventId) makes this exactly once;
 * 2. executes the actions in order. Each action is claimed by advancing `currentStep` with a
 *    conditional updateMany before it runs, so overlapping or repeated dispatches never run an
 *    action twice (at most once: a crash mid-action is recorded as FAILED "interrupted" when
 *    the stale run is resumed, never retried). Every action writes an ACTION event (OK,
 *    SKIPPED, or FAILED with a sanitized error); a failure marks the run FAILED but the
 *    remaining actions still run, except request_approval, which needs all earlier ones OK;
 * 3. request_approval (always last) opens step 1 and leaves the run WAITING_APPROVAL; the
 *    decisions finish it (approvals.ts).
 *
 * The cursor trails `now` by CURSOR_LAG so audit rows from transactions that commit late are
 * still seen; rows already run are excluded by the NOT EXISTS, so re-reading is free.
 * The engine's own audit actions ("workflow.*", "approval.*") are never in the trigger catalog,
 * so workflows cannot trigger each other in a loop.
 */

const BATCH = 500;
const CURSOR_LAG_MS = 2 * 60_000;
// ponytail: runs RUNNING longer than this are assumed dead and resumed; a single run taking
// longer than 15 minutes would race its resumer (each action is still claimed only once).
const STALE_MS = 15 * 60_000;

type AuditRow = { id: string; userId: string | null; companyId: string | null; entityId: string | null; previous: unknown; next: unknown; createdAt: Date };

const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const json = (v: unknown) => v as Prisma.InputJsonValue;

export async function dispatchWorkflows(now = new Date()) {
  const workflows = await prisma.workflowDefinition.findMany({ where: { isEnabled: true }, orderBy: { id: "asc" } });
  const totals = { workflows: workflows.length, runs: 0, skipped: 0, failed: 0, errors: 0 };
  for (const wf of workflows) {
    try {
      const r = await dispatchWorkflow(wf, now);
      totals.runs += r.runs;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
    } catch (error) {
      totals.errors++;
      console.error(`[workflows] ${wf.id} dispatch failed: ${sanitizeError(error)}`);
    }
  }
  return totals;
}

async function dispatchWorkflow(wf: WorkflowDefinition, now: Date) {
  const stats = { runs: 0, skipped: 0, failed: 0 };
  const stale = await prisma.workflowRun.findMany({ where: { workflowId: wf.id, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_MS) } }, take: 50 });
  for (const run of stale) await executeRun(wf, run, now);

  // timestamp(3) columns hold UTC wall-clock time: compare in UTC whatever the session zone.
  const rows = await prisma.$queryRaw<AuditRow[]>`
    SELECT a."id", a."userId", a."companyId", a."entityId", a."previous", a."next", a."createdAt"
    FROM "audit_logs" a
    WHERE a."organizationId" = ${wf.organizationId} AND a."action" = ${wf.triggerAction} AND a."entity" = ${wf.triggerEntity}
      AND a."createdAt" >= (${wf.cursorAt}::timestamptz AT TIME ZONE 'UTC')
      AND NOT EXISTS (SELECT 1 FROM "workflow_runs" r WHERE r."workflowId" = ${wf.id} AND r."sourceEventId" = a."id")
    ORDER BY a."createdAt", a."id"
    LIMIT ${BATCH}`;

  for (const row of rows) {
    const run = await startRun(wf, row, now);
    if (!run) continue; // another dispatcher created it
    stats.runs++;
    if (run.status === "SKIPPED") stats.skipped++;
    else if ((await executeRun(wf, run, now)) === "FAILED") stats.failed++;
  }

  if (rows.length) {
    const lagged = new Date(now.getTime() - CURSOR_LAG_MS);
    const last = rows[rows.length - 1].createdAt;
    const cursor = last < lagged ? last : lagged;
    await prisma.workflowDefinition.updateMany({ where: { id: wf.id, cursorAt: { lt: cursor } }, data: { cursorAt: cursor } });
  }
  return stats;
}

async function startRun(wf: WorkflowDefinition, row: AuditRow, now: Date) {
  const previous = record(row.previous);
  const next = { ...record(row.next), id: row.entityId };
  const conditions = wf.conditions as unknown as Condition[];
  const { matched, results } = evaluateConditions(wf.triggerEntity, conditions, { previous, next });
  const snapshot: RunSnapshot = {
    actorUserId: row.userId,
    companyId: row.companyId,
    previous,
    next,
    actions: wf.actions as unknown as WorkflowAction[],
    approvalSteps: wf.approvalSteps as unknown as ApprovalStep[],
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.create({
        data: {
          organizationId: wf.organizationId, workflowId: wf.id, sourceEventId: row.id, entityType: wf.triggerEntity, entityId: row.entityId,
          status: matched ? "RUNNING" : "SKIPPED", finishedAt: matched ? null : now, snapshot: json(snapshot),
        },
      });
      await tx.workflowRunEvent.create({
        data: {
          organizationId: wf.organizationId, runId: run.id, kind: "CONDITIONS", status: matched ? "OK" : "SKIPPED",
          message: matched ? (conditions.length ? "All conditions matched" : "No conditions") : "Conditions not met",
          data: json({ results }),
        },
      });
      return run;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

async function executeRun(wf: WorkflowDefinition, run: WorkflowRun, now: Date) {
  const snap = run.snapshot as unknown as RunSnapshot;
  const event = (index: number, type: string, status: "OK" | "FAILED" | "SKIPPED", message: string, data: Record<string, unknown> = {}) =>
    prisma.workflowRunEvent.create({ data: { organizationId: run.organizationId, runId: run.id, kind: "ACTION", status, message, data: json({ index, type, ...data }) } });

  const done = await prisma.workflowRunEvent.findMany({ where: { runId: run.id, kind: "ACTION" }, select: { status: true, message: true, data: true } });
  const recorded = new Set(done.map((e) => record(e.data)?.index));
  let error = done.find((e) => e.status === "FAILED")?.message ?? null;
  for (let i = 0; i < run.currentStep; i++) {
    if (recorded.has(i)) continue;
    error ??= "Interrupted before the result was recorded; not retried";
    await event(i, snap.actions[i]?.type ?? "unknown", "FAILED", "Interrupted before the result was recorded; not retried");
  }

  const ac: ActionContext = {
    organizationId: run.organizationId,
    workflow: { id: wf.id, name: wf.name, createdById: wf.createdById },
    run: { id: run.id, entityType: run.entityType, entityId: run.entityId },
    values: snap.next,
    now,
  };
  for (let i = run.currentStep; i < snap.actions.length; i++) {
    const action = snap.actions[i];
    const { count } = await prisma.workflowRun.updateMany({ where: { id: run.id, status: "RUNNING", currentStep: i }, data: { currentStep: i + 1 } });
    if (count === 0) return null; // another dispatcher owns this run

    if (action.type === "request_approval") {
      if (error) {
        await event(i, action.type, "SKIPPED", "Approval not requested: an earlier action failed");
        continue;
      }
      if (!snap.approvalSteps.length || !run.entityId) {
        error = "No approval steps or no record to approve";
        await event(i, action.type, "FAILED", error);
        continue;
      }
      const label = TRIGGER_CATALOG[run.entityType]?.label ?? run.entityType;
      const title = action.params.title
        ? renderTemplate(run.entityType, String(action.params.title), snap.next)
        : `${wf.name}: ${label} ${String(snap.next.number ?? run.entityId)}`;
      const request = await prisma.$transaction(async (tx) => {
        const req = await createApprovalStep(tx, { organizationId: run.organizationId, runId: run.id, entityType: run.entityType, entityId: run.entityId!, title, stepIndex: 0, step: snap.approvalSteps[0], now });
        await tx.workflowRunEvent.create({
          data: { organizationId: run.organizationId, runId: run.id, kind: "ACTION", status: "OK", message: "Approval requested (step 1)", data: json({ index: i, type: action.type, approvalRequestId: req.id }) },
        });
        await tx.workflowRun.update({ where: { id: run.id }, data: { status: "WAITING_APPROVAL" } });
        return req;
      });
      await notifyApprovers(request);
      return "WAITING_APPROVAL";
    }

    try {
      const out = await executeAction(ac, i, action);
      await event(i, action.type, out.status, out.message, out.data);
    } catch (e) {
      const message = sanitizeError(e);
      error ??= message;
      await event(i, action.type, "FAILED", message);
    }
  }

  const status = error ? "FAILED" : "COMPLETED";
  await prisma.workflowRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { status, error, finishedAt: now } });
  return status;
}
