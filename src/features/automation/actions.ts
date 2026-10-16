import { z } from "zod";
import { MemberStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { buildAccessContext } from "@/lib/access";
import { entityTypes } from "@/lib/entities";
import { createSystemNotification } from "@/lib/notifications/create";
import { assertActiveMember } from "@/lib/tenant/refs";
import { createTask } from "@/features/tasks/service";
import { OWNER_FIELDS } from "@/features/automation/catalog";
import { renderTemplate, unknownTemplateFields } from "@/features/automation/conditions";

/**
 * Workflow actions: a fixed allowlist, each with zod-validated params. Text params may use
 * {{field}} placeholders for the trigger entity's allowlisted snapshot fields — nothing else
 * is substituted or evaluated.
 *
 *   notify_user          { userId, title, body? }
 *   notify_role          { roleCode, title, body? }       every active member with the role
 *   notify_record_owner  { title, body? }                 first of ownerUserId/assigneeId/claimantId/createdById
 *   create_task          { title, description?, assigneeUserId?, dueInDays? }   created as the workflow's author
 *   request_approval     { title? }                       starts the workflow's approval steps (must be last)
 */

const title = z.string().trim().min(1).max(200);
const body = z.string().trim().max(1000).optional();
const roleCode = z.string().trim().min(1).max(60);
/** the only params that are templated */
const TEXT_PARAMS = ["title", "body", "description"];

export const ACTION_PARAMS = {
  notify_user: z.object({ userId: z.string().uuid(), title, body }).strict(),
  notify_role: z.object({ roleCode, title, body }).strict(),
  notify_record_owner: z.object({ title, body }).strict(),
  create_task: z.object({
    title,
    description: body,
    assigneeUserId: z.string().uuid().optional(),
    dueInDays: z.number().int().min(0).max(365).optional(),
  }).strict(),
  request_approval: z.object({ title: title.optional() }).strict(),
};
export type ActionType = keyof typeof ACTION_PARAMS;
export const ACTION_TYPES = Object.keys(ACTION_PARAMS) as ActionType[];
export type WorkflowAction = { type: ActionType; params: Record<string, unknown> };

export const approvalStepSchema = z
  .object({
    approverUserId: z.string().uuid().optional(),
    approverRoleCode: roleCode.optional(),
    timeoutHours: z.number().int().min(1).max(8760).optional(),
    escalateToUserId: z.string().uuid().optional(),
  })
  .strict()
  .refine((s) => !!s.approverUserId !== !!s.approverRoleCode, { message: "Give exactly one of approverUserId or approverRoleCode" })
  .refine((s) => !s.escalateToUserId || s.timeoutHours, { message: "escalateToUserId needs timeoutHours", path: ["timeoutHours"] });
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

const actionShape = z.object({ type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]), params: z.record(z.unknown()).default({}) });

/** Validates actions (params per type, template fields) and approval steps together. */
export function actionsSchema(entity: string) {
  return z
    .object({ actions: z.array(actionShape).min(1).max(10), approvalSteps: z.array(approvalStepSchema).max(10).default([]) })
    .transform(({ actions, approvalSteps }, zctx) => {
      const parsed = actions.map((a, i) => {
        const r = ACTION_PARAMS[a.type].safeParse(a.params);
        if (!r.success) {
          for (const issue of r.error.issues) zctx.addIssue({ ...issue, path: ["actions", i, "params", ...issue.path] });
          return a as WorkflowAction;
        }
        for (const [key, value] of Object.entries(r.data)) {
          if (!TEXT_PARAMS.includes(key)) continue;
          const unknown = unknownTemplateFields(entity, String(value));
          if (unknown.length) zctx.addIssue({ code: "custom", path: ["actions", i, "params", key], message: `Unknown template field(s): ${unknown.join(", ")}` });
        }
        return { type: a.type, params: r.data } as WorkflowAction;
      });
      const approvalAt = parsed.findIndex((a) => a.type === "request_approval");
      if (approvalAt >= 0 && approvalAt !== parsed.length - 1) {
        zctx.addIssue({ code: "custom", path: ["actions", approvalAt], message: "request_approval must be the last action" });
      }
      if ((approvalAt >= 0) !== approvalSteps.length > 0) {
        zctx.addIssue({ code: "custom", path: ["approvalSteps"], message: "request_approval needs approval steps, and approval steps need a request_approval action" });
      }
      return { actions: parsed, approvalSteps };
    });
}

/** Every user and role an action or step names must exist in the organization (422). */
export async function assertActionRefs(organizationId: string, actions: WorkflowAction[], steps: ApprovalStep[]) {
  const users = new Set<string>();
  const roles = new Set<string>();
  for (const a of actions) {
    for (const key of ["userId", "assigneeUserId"]) if (typeof a.params[key] === "string") users.add(a.params[key] as string);
    if (typeof a.params.roleCode === "string") roles.add(a.params.roleCode);
  }
  for (const s of steps) {
    if (s.approverUserId) users.add(s.approverUserId);
    if (s.escalateToUserId) users.add(s.escalateToUserId);
    if (s.approverRoleCode) roles.add(s.approverRoleCode);
  }
  for (const userId of users) await assertActiveMember(organizationId, userId);
  if (roles.size) {
    const found = await prisma.role.findMany({ where: { organizationId, code: { in: [...roles] } }, select: { code: true } });
    const missing = [...roles].filter((r) => !found.some((f) => f.code === r));
    if (missing.length) throw new AppError("INVALID_REFERENCE", `Unknown role: ${missing.join(", ")}`, 422);
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type ActionContext = {
  organizationId: string;
  workflow: { id: string; name: string; createdById: string | null };
  run: { id: string; entityType: string; entityId: string | null };
  /** template/condition values: the snapshot's `next` plus `id` */
  values: Record<string, unknown>;
  now: Date;
};
export type ActionOutcome = { status: "OK" | "SKIPPED"; message: string; data?: Record<string, unknown> };

/** Text params rendered against the snapshot — what the action would send (also the dry run). */
export function renderParams(entity: string, action: WorkflowAction, values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(action.params).map(([k, v]) => [k, TEXT_PARAMS.includes(k) ? renderTemplate(entity, String(v), values) : v]),
  );
}

export async function activeMemberIds(organizationId: string, where: { userId?: string; roleCode?: string }) {
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId, status: MemberStatus.ACTIVE, userId: where.userId, role: where.roleCode ? { code: where.roleCode } : undefined },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function notify(ac: ActionContext, index: number, userIds: string[], p: Record<string, unknown>) {
  for (const userId of userIds) {
    await createSystemNotification({
      organizationId: ac.organizationId,
      userId,
      type: "WORKFLOW",
      title: String(p.title).slice(0, 200),
      body: p.body ? String(p.body) : undefined,
      data: { workflowId: ac.workflow.id, runId: ac.run.id, entityType: ac.run.entityType, entityId: ac.run.entityId },
      dedupeKey: `wf:${ac.run.id}:${index}`,
    });
  }
  return { status: "OK" as const, message: `Notified ${userIds.length} user(s)`, data: { userIds } };
}

/**
 * Runs one action (request_approval is handled by the engine). Throws on failure; the engine
 * records the sanitized error. Notifications carry dedupeKey `wf:<runId>:<index>`.
 */
export async function executeAction(ac: ActionContext, index: number, action: WorkflowAction): Promise<ActionOutcome> {
  const p = renderParams(ac.run.entityType, action, ac.values);
  switch (action.type) {
    case "notify_user": {
      const ids = await activeMemberIds(ac.organizationId, { userId: p.userId as string });
      if (!ids.length) throw new Error("Recipient is no longer an active member");
      return notify(ac, index, ids, p);
    }
    case "notify_role": {
      const ids = await activeMemberIds(ac.organizationId, { roleCode: p.roleCode as string });
      if (!ids.length) return { status: "SKIPPED", message: `No active members with role ${String(p.roleCode)}` };
      return notify(ac, index, ids, p);
    }
    case "notify_record_owner": {
      const field = OWNER_FIELDS.find((f) => typeof ac.values[f] === "string");
      const ids = field ? await activeMemberIds(ac.organizationId, { userId: ac.values[field] as string }) : [];
      if (!ids.length) return { status: "SKIPPED", message: "The record has no owner who is an active member" };
      return notify(ac, index, ids, p);
    }
    case "create_task": {
      if (!ac.workflow.createdById) throw new Error("The workflow has no author to create tasks as");
      const ctx = await buildAccessContext(ac.workflow.createdById, ac.organizationId);
      const linkable = ac.run.entityId && entityTypes().includes(ac.run.entityType);
      const dueInDays = p.dueInDays as number | undefined;
      const task = await createTask(ctx, {
        title: p.title,
        description: p.description ?? `Created by workflow "${ac.workflow.name}"`,
        assignedUserId: p.assigneeUserId,
        dueAt: dueInDays === undefined ? undefined : new Date(ac.now.getTime() + dueInDays * 86_400_000),
        entityType: linkable ? ac.run.entityType : undefined,
        entityId: linkable ? ac.run.entityId : undefined,
      });
      return { status: "OK", message: `Created task "${task.title}"`, data: { taskId: task.id } };
    }
    case "request_approval":
      throw new Error("request_approval is run by the engine");
  }
}
