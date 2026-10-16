import { z } from "zod";
import { TaskStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { zDecimal } from "@/lib/money";
import { createTask } from "@/features/tasks/service";
import { assertFullCompany, fullCompanyIds } from "@/features/manufacturing/scope";

type Db = Prisma.TransactionClient;

/**
 * Non-conformance reports: OPEN → IN_PROGRESS (first corrective action, or `start`) →
 * CLOSED. Corrective actions are tasks (entityType "nonconformance"). Closing needs a root
 * cause and every corrective task COMPLETED or CANCELLED; `reopen` takes a CLOSED NCR back
 * to IN_PROGRESS.
 */

const severity = z.enum(["MINOR", "MAJOR", "CRITICAL"]);
const createSchema = z.object({
  companyId: z.string().min(1),
  productId: z.string().min(1).nullish(),
  vendorId: z.string().min(1).nullish(),
  quantity: zDecimal({ places: 4 }).nullish(),
  description: z.string().trim().min(1).max(4000),
  severity: severity.default("MINOR"),
});
const updateSchema = z.object({
  description: z.string().trim().min(1).max(4000).optional(),
  severity: severity.optional(),
  rootCause: z.string().trim().max(4000).nullish(),
});
const actionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  assignedUserId: z.string().uuid().nullish(),
  dueAt: z.coerce.date().nullish(),
});
const listSchema = listQuerySchema.extend({
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional(),
  severity: severity.optional(),
  vendorId: z.string().optional(),
  productId: z.string().optional(),
  companyId: z.string().optional(),
});

const OPEN_TASK: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.RESCHEDULED];

export async function createNonConformance(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "quality.inspect");
  const data = createSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    if (data.productId && !(await tx.product.findFirst({ where: { id: data.productId, organizationId: ctx.organizationId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Product not found", 422);
    }
    if (data.vendorId && !(await tx.vendor.findFirst({ where: { id: data.vendorId, organizationId: ctx.organizationId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Vendor not found", 422);
    }
    const ncr = await tx.nonConformance.create({
      data: {
        ...data,
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "nonconformance"),
        createdById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "nonconformance.created", entity: "nonconformance", entityId: ncr.id, companyId: ncr.companyId, next: ncr });
    return ncr;
  });
}

async function lockNcr(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "non_conformances" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const ncr = await tx.nonConformance.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!ncr) throw new AppError("NOT_FOUND", "Non-conformance not found", 404);
  assertFullCompany(ctx, ncr.companyId);
  return ncr;
}

export async function updateNonConformance(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "quality.manage");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockNcr(tx, ctx, id);
    if (before.status === "CLOSED") throw new AppError("INVALID_STATE", "Reopen the NCR to change it", 422);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const ncr = await tx.nonConformance.update({ where: { id }, data });
    await audit(tx, ctx, { action: "nonconformance.updated", entity: "nonconformance", entityId: id, companyId: ncr.companyId, previous: diff.previous, next: diff.next });
    return ncr;
  });
}

/** Corrective action = a task on the NCR (tasks service); moves an OPEN NCR to IN_PROGRESS. */
export async function addCorrectiveAction(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "quality.manage");
  const data = actionSchema.parse(input);
  const ncr = await prisma.nonConformance.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!ncr) throw new AppError("NOT_FOUND", "Non-conformance not found", 404);
  assertFullCompany(ctx, ncr.companyId);
  if (ncr.status === "CLOSED") throw new AppError("INVALID_STATE", "Reopen the NCR before adding corrective actions", 422);
  const task = await createTask(ctx, { ...data, entityType: "nonconformance", entityId: id, priority: ncr.severity === "MINOR" ? "MEDIUM" : "HIGH" });
  await prisma.nonConformance.updateMany({ where: { id, status: "OPEN" }, data: { status: "IN_PROGRESS" } });
  return task;
}

export const NCR_ACTIONS = ["start", "close", "reopen"] as const;
export type NcrAction = (typeof NCR_ACTIONS)[number];

export async function transitionNonConformance(ctx: AccessContext, id: string, action: NcrAction, input: unknown) {
  if (!NCR_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "quality.manage");
  const body = z.object({ rootCause: z.string().trim().max(4000).optional(), reason: z.string().trim().max(1000).optional() }).parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const ncr = await lockNcr(tx, ctx, id);
    const from: Record<NcrAction, string[]> = { start: ["OPEN"], close: ["OPEN", "IN_PROGRESS"], reopen: ["CLOSED"] };
    if (!from[action].includes(ncr.status)) throw new AppError("INVALID_STATE", `Cannot ${action} an NCR that is ${ncr.status}`, 422);
    let data: Prisma.NonConformanceUpdateInput = { status: "IN_PROGRESS", closedAt: null };
    if (action === "close") {
      const rootCause = body.rootCause || ncr.rootCause;
      if (!rootCause) throw new AppError("VALIDATION_ERROR", "Record the root cause before closing", 422, [{ path: "rootCause", message: "Required" }]);
      const open = await tx.task.count({ where: { organizationId: ctx.organizationId, entityType: "nonconformance", entityId: id, status: { in: OPEN_TASK } } });
      if (open > 0) throw new AppError("OPEN_ACTIONS", `${open} corrective action${open === 1 ? " is" : "s are"} still open`, 422);
      data = { status: "CLOSED", closedAt: new Date(), rootCause };
    }
    const updated = await tx.nonConformance.update({ where: { id }, data });
    await audit(tx, ctx, {
      action: `nonconformance.${action}`,
      entity: "nonconformance",
      entityId: id,
      companyId: ncr.companyId,
      previous: { status: ncr.status },
      next: { status: updated.status, rootCause: updated.rootCause, reason: body.reason },
    });
    return updated;
  });
}

export async function listNonConformances(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "quality.view");
  const q = listSchema.parse(query);
  const where: Prisma.NonConformanceWhereInput = {
    AND: [
      { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds(ctx) } },
      { status: q.status, severity: q.severity, vendorId: q.vendorId, productId: q.productId, companyId: q.companyId },
      searchWhere(q.q, ["number", "description"]),
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.nonConformance.findMany({ where, ...listArgs(q, ["createdAt", "number"], "createdAt") }),
      prisma.nonConformance.count({ where }),
    ]),
  );
}

export async function getNonConformance(ctx: AccessContext, id: string) {
  assertCan(ctx, "quality.view");
  const ncr = await prisma.nonConformance.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { inspection: { select: { id: true, sourceType: true, sourceId: true, result: true, inspectedQty: true, rejectedQty: true } } },
  });
  if (!ncr) throw new AppError("NOT_FOUND", "Non-conformance not found", 404);
  assertFullCompany(ctx, ncr.companyId);
  const [correctiveActions, product, vendor] = await Promise.all([
    prisma.task.findMany({
      where: { organizationId: ctx.organizationId, entityType: "nonconformance", entityId: id },
      include: { assignedUser: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    ncr.productId ? prisma.product.findFirst({ where: { id: ncr.productId, organizationId: ctx.organizationId }, select: { id: true, sku: true, name: true } }) : null,
    ncr.vendorId ? prisma.vendor.findFirst({ where: { id: ncr.vendorId, organizationId: ctx.organizationId }, select: { id: true, name: true } }) : null,
  ]);
  return { ...ncr, product, vendor, correctiveActions };
}
