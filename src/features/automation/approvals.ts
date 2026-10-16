import { z } from "zod";
import type { ApprovalRequest, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { createSystemNotification } from "@/lib/notifications/create";
import { activeMemberIds, type ApprovalStep, type WorkflowAction } from "@/features/automation/actions";

/**
 * Approval requests raised by a workflow's request_approval action. Steps run in order: each
 * step targets one user or every member of a role; approving the last step completes the run
 * and writes an "approval.approved" audit row on the record, a rejection (comment required)
 * ends the run as REJECTED ("approval.rejected").
 *
 * Approvals are informational: they never change the business record's status. Module-level
 * approvals (quotations, POs, vendor bills, expenses, leave) stay in their modules.
 *
 * Who decides: the assigned user, or any active member holding the assigned role — never the
 * user whose action triggered the run (403). `approval.view_all` can see every request but
 * decides only those assigned to them.
 *
 * Escalation (`escalateApprovals`, a job): a PENDING step past its dueAt that has an
 * escalateToUserId is claimed (status → ESCALATED, escalatedAt set) with a conditional
 * updateMany, and a new PENDING request for the same step is created for the escalation user
 * (no further timeout). The original request stays as history. Steps without an escalation
 * user simply stay pending.
 */

/** Stored on WorkflowRun.snapshot when the run starts; decisions read steps from here. */
export type RunSnapshot = {
  actorUserId: string | null;
  companyId: string | null;
  previous: Record<string, unknown> | null;
  next: Record<string, unknown>;
  actions: WorkflowAction[];
  approvalSteps: ApprovalStep[];
};

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ESCALATED", "CANCELLED"] as const;
type Db = Prisma.TransactionClient;

export function createApprovalStep(
  tx: Db,
  input: { organizationId: string; runId: string; entityType: string; entityId: string; title: string; stepIndex: number; step: ApprovalStep; now: Date },
) {
  const { step } = input;
  return tx.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      runId: input.runId,
      stepIndex: input.stepIndex,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title.slice(0, 300),
      approverUserId: step.approverUserId ?? null,
      approverRoleCode: step.approverRoleCode ?? null,
      dueAt: step.timeoutHours ? new Date(input.now.getTime() + step.timeoutHours * 3_600_000) : null,
      escalateToUserId: step.escalateToUserId ?? null,
    },
  });
}

/** Notifies the step's approver(s); deduped per request, so retries never double-notify. */
export async function notifyApprovers(req: ApprovalRequest) {
  const userIds = req.approverUserId
    ? await activeMemberIds(req.organizationId, { userId: req.approverUserId })
    : await activeMemberIds(req.organizationId, { roleCode: req.approverRoleCode! });
  for (const userId of userIds) {
    await createSystemNotification({
      organizationId: req.organizationId,
      userId,
      type: "APPROVAL_REQUEST",
      title: `Approval needed: ${req.title}`.slice(0, 200),
      body: `Step ${req.stepIndex + 1}${req.dueAt ? ` · due ${req.dueAt.toISOString()}` : ""}`,
      data: { approvalRequestId: req.id, entityType: req.entityType, entityId: req.entityId, href: "/automation/approvals" },
      preferenceKey: "approvalRequests",
      dedupeKey: `approval:${req.id}`,
    }).catch((e) => console.error("[approvals] notification failed", e));
  }
}

async function roleCodeOf(ctx: AccessContext) {
  const role = await prisma.role.findUnique({ where: { id: ctx.roleId }, select: { code: true } });
  return role?.code ?? null;
}

const assignedWhere = (ctx: AccessContext, roleCode: string | null): Prisma.ApprovalRequestWhereInput => ({
  organizationId: ctx.organizationId,
  OR: [{ approverUserId: ctx.userId }, ...(roleCode ? [{ approverRoleCode: roleCode }] : [])],
});

const visibleWhere = (ctx: AccessContext, roleCode: string | null) =>
  can(ctx, "approval.view_all") ? { organizationId: ctx.organizationId } : assignedWhere(ctx, roleCode);

const isAssigned = (req: ApprovalRequest, ctx: AccessContext, roleCode: string | null) =>
  req.approverUserId === ctx.userId || (!!roleCode && req.approverRoleCode === roleCode);

const listSchema = listQuerySchema.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
  /** mine (default): assigned to me or my role; all: every request (approval.view_all) */
  scope: z.enum(["mine", "all"]).default("mine"),
  runId: z.string().optional(),
});

export async function listApprovals(ctx: AccessContext, query: unknown) {
  const q = listSchema.parse(query);
  const roleCode = await roleCodeOf(ctx);
  const where: Prisma.ApprovalRequestWhereInput = {
    AND: [q.scope === "all" ? visibleWhere(ctx, roleCode) : assignedWhere(ctx, roleCode), searchWhere(q.q, ["title"]), { status: q.status, runId: q.runId }],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.approvalRequest.findMany({ where, include: { run: { select: { id: true, workflow: { select: { id: true, name: true } } } } }, ...listArgs(q, ["createdAt", "dueAt"]) }),
      prisma.approvalRequest.count({ where }),
    ]),
  );
}

export async function getApproval(ctx: AccessContext, id: string) {
  const roleCode = await roleCodeOf(ctx);
  const req = await prisma.approvalRequest.findFirst({
    where: { id, ...visibleWhere(ctx, roleCode) },
    include: { run: { select: { id: true, status: true, workflow: { select: { id: true, name: true } } } } },
  });
  if (!req) throw new AppError("NOT_FOUND", "Approval request not found", 404);
  return { ...req, canDecide: req.status === "PENDING" && isAssigned(req, ctx, roleCode) };
}

const decideSchema = z.object({ comment: z.string().trim().max(2000).optional() });
export const APPROVAL_ACTIONS = ["approve", "reject"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export async function decideApproval(ctx: AccessContext, id: string, action: ApprovalAction, input: unknown) {
  if (!APPROVAL_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown approval action", 404);
  const { comment } = decideSchema.parse(input ?? {});
  if (action === "reject" && !comment) throw new AppError("VALIDATION_ERROR", "A comment is required to reject", 422);
  const roleCode = await roleCodeOf(ctx);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "approval_requests" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const req = await tx.approvalRequest.findFirst({ where: { id, ...visibleWhere(ctx, roleCode) }, include: { run: true } });
    if (!req) throw new AppError("NOT_FOUND", "Approval request not found", 404);
    if (!isAssigned(req, ctx, roleCode)) throw new AppError("FORBIDDEN", "This approval is not assigned to you", 403);
    if (req.status !== "PENDING") throw new AppError("INVALID_STATE", `This request is already ${req.status}`, 422);
    const snap = req.run?.snapshot as RunSnapshot | null;
    if (snap?.actorUserId && snap.actorUserId === ctx.userId) throw new AppError("FORBIDDEN", "You cannot decide an approval for your own action", 403);

    const now = new Date();
    const decided = await tx.approvalRequest.update({
      where: { id },
      data: { status: action === "approve" ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: now, comment: comment ?? null },
    });
    const steps = snap?.approvalSteps ?? [];
    const nextStep = action === "approve" ? steps[req.stepIndex + 1] : undefined;
    let next: ApprovalRequest | null = null;
    let final: "COMPLETED" | "REJECTED" | null = null;
    if (req.run) {
      await tx.workflowRunEvent.create({
        data: {
          organizationId: ctx.organizationId, runId: req.run.id, kind: "APPROVAL", status: "OK",
          message: `Step ${req.stepIndex + 1} ${action === "approve" ? "approved" : "rejected"}`,
          data: { approvalRequestId: id, stepIndex: req.stepIndex, decidedById: ctx.userId, comment: comment ?? null },
        },
      });
      if (nextStep) {
        next = await createApprovalStep(tx, { organizationId: ctx.organizationId, runId: req.run.id, entityType: req.entityType, entityId: req.entityId, title: req.title, stepIndex: req.stepIndex + 1, step: nextStep, now });
      } else {
        final = action === "approve" ? "COMPLETED" : "REJECTED";
        await tx.workflowRun.update({ where: { id: req.run.id }, data: { status: final, finishedAt: now } });
      }
    }
    await audit(tx, ctx, {
      action: next ? "approval.step_approved" : action === "approve" ? "approval.approved" : "approval.rejected",
      entity: req.entityType,
      entityId: req.entityId,
      companyId: snap?.companyId ?? null,
      previous: { approvalRequestId: id, status: "PENDING" },
      next: { approvalRequestId: id, status: decided.status, stepIndex: req.stepIndex, comment: comment ?? null },
    });
    return { decided, next, final, actor: snap?.actorUserId ?? null };
  });

  if (result.next) await notifyApprovers(result.next);
  if (result.final && result.actor) {
    await createSystemNotification({
      organizationId: ctx.organizationId,
      userId: result.actor,
      type: "APPROVAL_DECIDED",
      title: `${result.final === "COMPLETED" ? "Approved" : "Rejected"}: ${result.decided.title}`.slice(0, 200),
      body: comment,
      data: { approvalRequestId: id, entityType: result.decided.entityType, entityId: result.decided.entityId },
      preferenceKey: "approvalRequests",
      dedupeKey: `approval:${id}:decided`,
    }).catch((e) => console.error("[approvals] notification failed", e));
  }
  return result.decided;
}

/** Job: hands overdue steps to their escalation user. Each request is claimed exactly once. */
export async function escalateApprovals(now = new Date()) {
  const due = await prisma.approvalRequest.findMany({
    where: { status: "PENDING", dueAt: { lt: now }, escalateToUserId: { not: null } },
    orderBy: { dueAt: "asc" },
    take: 500, // ponytail: batch cap per run; the next run picks up the rest
  });
  let escalated = 0;
  for (const req of due) {
    const created = await prisma.$transaction(async (tx) => {
      const { count } = await tx.approvalRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "ESCALATED", escalatedAt: now } });
      if (count === 0) return null;
      const replacement = await tx.approvalRequest.create({
        data: {
          organizationId: req.organizationId, runId: req.runId, stepIndex: req.stepIndex, entityType: req.entityType, entityId: req.entityId,
          title: req.title, approverUserId: req.escalateToUserId,
        },
      });
      if (req.runId) {
        await tx.workflowRunEvent.create({
          data: {
            organizationId: req.organizationId, runId: req.runId, kind: "ESCALATION", status: "OK",
            message: `Step ${req.stepIndex + 1} timed out and was escalated`,
            data: { fromRequestId: req.id, toRequestId: replacement.id, escalateToUserId: req.escalateToUserId },
          },
        });
      }
      // System action: no user, so write the audit row directly.
      await tx.auditLog.create({
        data: {
          organizationId: req.organizationId, action: "approval.escalated", entity: req.entityType, entityId: req.entityId,
          previous: { approvalRequestId: req.id, approverUserId: req.approverUserId, approverRoleCode: req.approverRoleCode },
          next: { approvalRequestId: replacement.id, approverUserId: req.escalateToUserId },
        },
      });
      return replacement;
    });
    if (!created) continue;
    escalated++;
    await notifyApprovers(created);
  }
  return { checked: due.length, escalated };
}
