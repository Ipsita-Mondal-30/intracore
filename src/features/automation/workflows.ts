import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { TRIGGER_CATALOG } from "@/features/automation/catalog";
import { conditionsSchema, evaluateConditions } from "@/features/automation/conditions";
import { actionsSchema, assertActionRefs, renderParams } from "@/features/automation/actions";

/**
 * Workflow definitions (workflow.view to read, workflow.manage to change). A definition is
 * data only: trigger (entity + audit action from the catalog), conditions, actions and
 * approval steps, each validated against allowlists at save (422) and interpreted by the
 * engine. Nothing in a definition is ever executed as code.
 *
 * Enabling a workflow (false → true) moves its cursor to now: it reacts to events from that
 * moment on, never to history. Runs copy the actions and steps they started with, so editing
 * a workflow does not change runs already in flight.
 */

export const RUN_STATUSES = ["RUNNING", "WAITING_APPROVAL", "COMPLETED", "SKIPPED", "REJECTED", "FAILED", "CANCELLED"] as const;

const baseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  triggerType: z.literal("EVENT").default("EVENT"),
  triggerEntity: z.string().min(1).max(60),
  triggerAction: z.string().min(1).max(80),
  conditions: z.array(z.unknown()).default([]),
  actions: z.array(z.unknown()),
  approvalSteps: z.array(z.unknown()).default([]),
  isEnabled: z.boolean().default(false),
});

const issue = (path: string, message: string) => new z.ZodError([{ code: "custom", path: [path], message }]);

async function validateDefinition(organizationId: string, input: unknown) {
  const def = baseSchema.parse(input);
  const entity = Object.hasOwn(TRIGGER_CATALOG, def.triggerEntity) ? TRIGGER_CATALOG[def.triggerEntity] : undefined;
  if (!entity) throw issue("triggerEntity", `Unknown trigger entity: ${def.triggerEntity}`);
  if (!entity.actions.includes(def.triggerAction)) throw issue("triggerAction", `${def.triggerAction} is not a trigger for ${def.triggerEntity}`);
  const { conditions } = z.object({ conditions: conditionsSchema(def.triggerEntity) }).parse({ conditions: def.conditions });
  const { actions, approvalSteps } = actionsSchema(def.triggerEntity).parse(def);
  await assertActionRefs(organizationId, actions, approvalSteps);
  return {
    ...def,
    conditions: conditions as unknown as Prisma.InputJsonValue,
    actions: actions as unknown as Prisma.InputJsonValue,
    approvalSteps: approvalSteps as unknown as Prisma.InputJsonValue,
  };
}

async function findWorkflow(ctx: AccessContext, id: string) {
  const wf = await prisma.workflowDefinition.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!wf) throw new AppError("NOT_FOUND", "Workflow not found", 404);
  return wf;
}

export async function createWorkflow(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "workflow.manage");
  const data = await validateDefinition(ctx.organizationId, input);
  return prisma.$transaction(async (tx) => {
    const wf = await tx.workflowDefinition.create({ data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId, cursorAt: new Date() } });
    await audit(tx, ctx, { action: "workflow.created", entity: "workflow", entityId: wf.id, next: wf });
    return wf;
  });
}

export async function updateWorkflow(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "workflow.manage");
  const patch = baseSchema.partial().parse(input);
  const before = await findWorkflow(ctx, id);
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const data = await validateDefinition(ctx.organizationId, { ...before, ...given });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "workflow_definitions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await tx.workflowDefinition.findUniqueOrThrow({ where: { id } });
    const enabling = data.isEnabled && !current.isEnabled;
    const updated = await tx.workflowDefinition.update({ where: { id }, data: { ...data, ...(enabling ? { cursorAt: new Date() } : {}) } });
    const diff = changes(current as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
    if (diff.changed) await audit(tx, ctx, { action: "workflow.updated", entity: "workflow", entityId: id, previous: diff.previous, next: diff.next });
    return updated;
  });
}

const listSchema = listQuerySchema.extend({
  triggerEntity: z.string().optional(),
  enabled: z.enum(["true", "false"]).optional(),
});

export async function listWorkflows(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "workflow.view");
  const q = listSchema.parse(query);
  const where: Prisma.WorkflowDefinitionWhereInput = {
    organizationId: ctx.organizationId,
    triggerEntity: q.triggerEntity,
    isEnabled: q.enabled ? q.enabled === "true" : undefined,
    ...searchWhere(q.q, ["name", "description"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.workflowDefinition.findMany({ where, include: { _count: { select: { runs: true } } }, ...listArgs(q, ["createdAt", "name", "updatedAt"]) }),
      prisma.workflowDefinition.count({ where }),
    ]),
  );
}

export async function getWorkflow(ctx: AccessContext, id: string) {
  assertCan(ctx, "workflow.view");
  return findWorkflow(ctx, id);
}

const runListSchema = listQuerySchema.extend({ workflowId: z.string().optional(), status: z.enum(RUN_STATUSES).optional(), entityId: z.string().optional() });

export async function listWorkflowRuns(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "workflow.view");
  const q = runListSchema.parse(query);
  const where: Prisma.WorkflowRunWhereInput = { organizationId: ctx.organizationId, workflowId: q.workflowId, status: q.status, entityId: q.entityId };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.workflowRun.findMany({ where, include: { workflow: { select: { id: true, name: true } } }, ...listArgs(q, ["startedAt", "finishedAt"], "startedAt") }),
      prisma.workflowRun.count({ where }),
    ]),
  );
}

export async function getWorkflowRun(ctx: AccessContext, id: string) {
  assertCan(ctx, "workflow.view");
  const run = await prisma.workflowRun.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      workflow: { select: { id: true, name: true } },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      approvals: { orderBy: [{ stepIndex: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!run) throw new AppError("NOT_FOUND", "Workflow run not found", 404);
  return run;
}

const testSchema = z.object({
  /** sample `next` snapshot (field → value), as the trigger's audit row would carry */
  next: z.record(z.unknown()),
  previous: z.record(z.unknown()).nullish(),
});

/** Dry run: evaluates the conditions against a sample snapshot and lists the planned actions. Executes nothing. */
export async function testWorkflow(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "workflow.view");
  const wf = await findWorkflow(ctx, id);
  const sample = testSchema.parse(input ?? {});
  const next = { id: "sample", ...sample.next };
  const { matched, results } = evaluateConditions(wf.triggerEntity, wf.conditions as never, { previous: sample.previous ?? null, next });
  const actions = (wf.actions as never as { type: string; params: Record<string, unknown> }[]).map((a, index) => ({
    index,
    type: a.type,
    params: renderParams(wf.triggerEntity, a as never, next),
  }));
  return { matched, conditions: results, actions: matched ? actions : [], approvalSteps: matched ? wf.approvalSteps : [] };
}
