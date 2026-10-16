import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";

/**
 * Dispatch of a posted delivery (DELIVERY stock entry): DISPATCHED → IN_TRANSIT →
 * DELIVERED | FAILED. DELIVERED needs proof of delivery (receiver name + time); POD
 * scans/photos attach through the documents API (entityType "delivery_dispatch").
 */

const text = (max: number) => z.string().trim().min(1).max(max).nullish();
const createSchema = z.object({
  stockEntryId: z.string().min(1),
  carrier: text(120),
  trackingNumber: text(120),
  vehicleNumber: text(40),
  driverName: text(120),
});

const include = {
  stockEntry: { select: { id: true, number: true, companyId: true, branchId: true, customer: { select: { id: true, name: true } }, salesOrder: { select: { id: true, number: true } } } },
} satisfies Prisma.DeliveryDispatchInclude;

const scope = (ctx: AccessContext): Prisma.DeliveryDispatchWhereInput => ({ organizationId: ctx.organizationId, stockEntry: companyScopeWhere(ctx) });

/** Retry-safe: one dispatch per delivery; a repeat returns the existing record. */
export async function createDispatch(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "field.schedule");
  const data = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "stock_entries" WHERE "id" = ${data.stockEntryId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const entry = await tx.stockEntry.findFirst({ where: { id: data.stockEntryId, ...companyScopeWhere(ctx) } });
    if (!entry) throw new AppError("NOT_FOUND", "Delivery not found", 404);
    if (entry.type !== "DELIVERY" || entry.status !== "POSTED") throw new AppError("INVALID_STATE", "Only posted deliveries can be dispatched", 422);
    const existing = await tx.deliveryDispatch.findUnique({ where: { organizationId_stockEntryId: { organizationId: ctx.organizationId, stockEntryId: entry.id } }, include });
    if (existing) return existing;
    const dispatch = await tx.deliveryDispatch.create({ data: { ...data, organizationId: ctx.organizationId }, include });
    await audit(tx, ctx, { action: "delivery_dispatch.created", entity: "delivery_dispatch", entityId: dispatch.id, companyId: entry.companyId, next: dispatch });
    return dispatch;
  });
}

const actionSchemas = {
  "in-transit": z.object({ trackingNumber: text(120), vehicleNumber: text(40), driverName: text(120) }),
  deliver: z.object({
    receivedByName: z.string({ required_error: "Receiver name is required as proof of delivery" }).trim().min(1, "Receiver name is required as proof of delivery").max(200),
    deliveredAt: z.coerce.date().optional(),
  }),
  fail: z.object({ reason: z.string().trim().min(1, "A reason is required").max(1000) }),
};
export type DispatchAction = keyof typeof actionSchemas;
export const DISPATCH_ACTIONS = Object.keys(actionSchemas) as DispatchAction[];

const from: Record<DispatchAction, string[]> = { "in-transit": ["DISPATCHED"], deliver: ["DISPATCHED", "IN_TRANSIT"], fail: ["DISPATCHED", "IN_TRANSIT"] };

export async function transitionDispatch(ctx: AccessContext, id: string, action: DispatchAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "field.update");
  const body = schema.parse(input ?? {}) as { receivedByName?: string; deliveredAt?: Date; reason?: string; trackingNumber?: string | null; vehicleNumber?: string | null; driverName?: string | null };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "delivery_dispatches" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const d = await tx.deliveryDispatch.findFirst({ where: { id, ...scope(ctx) }, include });
    if (!d) throw new AppError("NOT_FOUND", "Dispatch not found", 404);
    if (!from[action].includes(d.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a ${d.status} dispatch`, 422);
    let data: Prisma.DeliveryDispatchUncheckedUpdateInput;
    if (action === "in-transit") {
      data = { status: "IN_TRANSIT", trackingNumber: body.trackingNumber ?? undefined, vehicleNumber: body.vehicleNumber ?? undefined, driverName: body.driverName ?? undefined };
    } else if (action === "deliver") {
      const at = body.deliveredAt ?? new Date();
      if (at.getTime() > Date.now() + 5 * 60_000) throw new AppError("VALIDATION_ERROR", "Delivery time cannot be in the future", 422);
      if (at < d.dispatchedAt) throw new AppError("VALIDATION_ERROR", "Delivery time cannot be before dispatch", 422);
      data = { status: "DELIVERED", receivedByName: body.receivedByName, deliveredAt: at };
    } else {
      data = { status: "FAILED", failureReason: body.reason };
    }
    const updated = await tx.deliveryDispatch.update({ where: { id }, data, include });
    await audit(tx, ctx, {
      action: `delivery_dispatch.${action}`,
      entity: "delivery_dispatch",
      entityId: id,
      companyId: d.stockEntry.companyId,
      previous: { status: d.status },
      next: { status: updated.status, reason: body.reason, receivedByName: body.receivedByName, deliveredAt: updated.deliveredAt },
    });
    return updated;
  });
}

export async function listDispatches(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "field.view");
  const q = listQuerySchema.extend({ status: z.enum(["DISPATCHED", "IN_TRANSIT", "DELIVERED", "FAILED"]).optional() }).parse(query);
  const where: Prisma.DeliveryDispatchWhereInput = { ...scope(ctx), status: q.status, ...searchWhere(q.q, ["carrier", "trackingNumber", "receivedByName"]) };
  return paginate(q, () =>
    Promise.all([
      prisma.deliveryDispatch.findMany({ where, include, ...listArgs(q, ["dispatchedAt", "deliveredAt"], "dispatchedAt") }),
      prisma.deliveryDispatch.count({ where }),
    ]),
  );
}

export async function getDispatch(ctx: AccessContext, id: string) {
  assertCan(ctx, "field.view");
  const d = await prisma.deliveryDispatch.findFirst({ where: { id, ...scope(ctx) }, include });
  if (!d) throw new AppError("NOT_FOUND", "Dispatch not found", 404);
  return d;
}

/** Posted deliveries in scope that have no dispatch yet (for the create form). */
export async function undispatchedDeliveries(ctx: AccessContext) {
  assertCan(ctx, "field.view");
  return prisma.stockEntry.findMany({
    where: { ...companyScopeWhere(ctx), type: "DELIVERY", status: "POSTED", dispatch: null },
    select: { id: true, number: true, postedAt: true, customer: { select: { name: true } } },
    orderBy: { postedAt: "desc" },
    take: 100,
  });
}
