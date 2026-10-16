import { z } from "zod";
import { SalesOrderStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { linesSchema, partyHeaderSchema, priceLines, resolveSalesParty } from "@/features/sales/pricing";
import { releaseSalesOrder, reserveSalesOrder } from "@/features/inventory/stock";
import { defaultWarehouseId } from "@/features/inventory/warehouses";

const S = SalesOrderStatus;

const headerSchema = partyHeaderSchema.extend({
  /** Ships and reserves from this warehouse; required to confirm orders with stocked goods */
  warehouseId: z.string().min(1).nullish(),
  orderDate: z.coerce.date().optional(),
  expectedDeliveryDate: z.coerce.date().nullish(),
  customerPoNumber: z.string().trim().max(64).nullish(),
  shippingAddress: z.string().trim().max(1000).nullish(),
  deliveryInstructions: z.string().trim().max(2000).nullish(),
  notes: z.string().trim().max(10000).nullish(),
});

const createSchema = headerSchema.extend({ lines: linesSchema });
const updateSchema = headerSchema
  .omit({ companyId: true, branchId: true })
  .partial()
  .extend({ lines: linesSchema.optional() });

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(SalesOrderStatus).optional(),
  customerId: z.string().optional(),
  companyId: z.string().optional(),
});

export const salesOrderInclude = {
  lines: {
    orderBy: { sortOrder: "asc" },
    include: {
      product: { select: { id: true, sku: true, name: true, hsnCode: true, type: true, trackInventory: true, trackingMode: true } },
      uom: { select: { code: true } },
      reservation: { select: { quantity: true } },
    },
  },
  customer: true,
  contact: { select: { id: true, fullName: true, email: true, phone: true } },
  company: true,
  branch: true,
  quotation: { select: { id: true, number: true, revision: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  stockEntries: { select: { id: true, number: true, type: true, status: true, postedAt: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.SalesOrderInclude;

export async function listSalesOrders(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "sales_order.view");
  const q = listSchema.parse(query);
  const where: Prisma.SalesOrderWhereInput = {
    AND: [
      companyScopeWhere(ctx),
      { status: q.status, customerId: q.customerId, companyId: q.companyId },
      searchWhere(q.q, ["number", "customerPoNumber", "notes"]),
    ],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: { customer: { select: { id: true, name: true } }, company: { select: { code: true } } },
        ...listArgs(q, ["createdAt", "number", "grandTotal", "orderDate", "expectedDeliveryDate"], "createdAt"),
      }),
      prisma.salesOrder.count({ where }),
    ]),
  );
}

export async function getSalesOrder(ctx: AccessContext, id: string) {
  assertCan(ctx, "sales_order.view");
  const order = await prisma.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: salesOrderInclude });
  if (!order) throw new AppError("NOT_FOUND", "Sales order not found", 404);
  assertCompanyAccess(ctx, order.companyId, order.branchId);
  return order;
}

export async function lockSalesOrder(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const order = await tx.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!order) throw new AppError("NOT_FOUND", "Sales order not found", 404);
  assertCompanyAccess(ctx, order.companyId, order.branchId);
  return order;
}

export async function createSalesOrder(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "sales_order.create");
  const data = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const party = await resolveSalesParty(tx, ctx, data);
    await assertOrderWarehouse(tx, ctx, data.companyId, data.warehouseId);
    const { lines: lineInputs, ...header } = data;
    const priced = await priceLines(tx, ctx.organizationId, lineInputs, { intraState: party.intraState, customerId: data.customerId });
    const order = await tx.salesOrder.create({
      data: {
        ...header,
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "sales_order"),
        warehouseId: data.warehouseId ?? (await defaultWarehouseId(tx, ctx.organizationId, data.companyId, data.branchId)),
        currency: data.currency ?? party.currency,
        placeOfSupplyState: party.placeOfSupplyState,
        ...priced.totals,
        createdById: ctx.userId,
        lines: { create: priced.lines },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "sales_order.created", entity: "sales_order", entityId: order.id, companyId: order.companyId, next: order });
    return order;
  });
}

const hasDeliveries = (lines: { deliveredQty: Prisma.Decimal }[]) => lines.some((l) => l.deliveredQty.gt(0));

/**
 * DRAFT orders are freely editable. A CONFIRMED order with nothing delivered can be
 * amended (counted and audited with the previous lines). After the first delivery
 * the order is locked.
 */
export async function updateSalesOrder(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "sales_order.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockSalesOrder(tx, ctx, id);
    const existingLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: id }, orderBy: { sortOrder: "asc" } });
    const amendment = before.status === S.CONFIRMED;
    if (before.status !== S.DRAFT && !amendment) {
      throw new AppError("INVALID_STATE", `A ${before.status} order cannot be changed`, 422);
    }
    if (hasDeliveries(existingLines)) throw new AppError("INVALID_STATE", "Orders with deliveries cannot be amended", 422);

    const header = {
      companyId: before.companyId,
      branchId: before.branchId,
      customerId: data.customerId ?? before.customerId,
      contactId: data.contactId === undefined ? before.contactId : data.contactId,
      placeOfSupplyState: data.placeOfSupplyState === undefined ? before.placeOfSupplyState : data.placeOfSupplyState,
    };
    if (amendment && header.customerId !== before.customerId) {
      throw new AppError("INVALID_STATE", "The customer of a confirmed order cannot change", 422);
    }
    const party = await resolveSalesParty(tx, ctx, header);
    const { lines: lineInputs, ...headerPatch } = data;
    const priced = lineInputs
      ? await priceLines(tx, ctx.organizationId, lineInputs, { intraState: party.intraState, customerId: header.customerId })
      : null;

    if (data.warehouseId !== undefined) await assertOrderWarehouse(tx, ctx, before.companyId, data.warehouseId);
    // Replacing lines drops their reservations (cascade); a confirmed order re-reserves below.
    if (priced) await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
    else if (amendment && data.warehouseId !== undefined) await releaseSalesOrder(tx, id);
    const order = await tx.salesOrder.update({
      where: { id },
      data: {
        ...headerPatch,
        placeOfSupplyState: party.placeOfSupplyState,
        ...(priced
          ? { ...priced.totals, lines: { create: priced.lines } }
          : {}),
        ...(amendment ? { amendmentCount: { increment: 1 } } : {}),
      },
      include: { lines: true },
    });
    if (amendment) await reserveSalesOrder(tx, id);
    await audit(tx, ctx, {
      action: amendment ? "sales_order.amended" : "sales_order.updated",
      entity: "sales_order",
      entityId: id,
      companyId: before.companyId,
      previous: {
        grandTotal: before.grandTotal,
        lines: existingLines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })),
      },
      next: { grandTotal: order.grandTotal, lines: order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })) },
    });
    return order;
  });
}

export async function confirmSalesOrder(ctx: AccessContext, id: string) {
  assertCan(ctx, "sales_order.update");
  return prisma.$transaction(async (tx) => {
    const order = await lockSalesOrder(tx, ctx, id);
    if (order.status !== S.DRAFT) throw new AppError("INVALID_STATE", `A ${order.status} order cannot be confirmed`, 422);
    const updated = await tx.salesOrder.update({ where: { id }, data: { status: S.CONFIRMED, confirmedAt: new Date() } });
    const reservations = await reserveSalesOrder(tx, id);
    await audit(tx, ctx, { action: "sales_order.confirmed", entity: "sales_order", entityId: id, companyId: order.companyId, previous: { status: order.status }, next: { status: S.CONFIRMED, reservations } });
    return { ...updated, reservations };
  });
}

const cancelReason = "A cancellation reason is required";
const cancelSchema = z.object({ reason: z.string({ required_error: cancelReason }).trim().min(1, cancelReason).max(1000) });

/** Only orders with nothing delivered can be cancelled; reservations are released. */
export async function cancelSalesOrder(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "sales_order.cancel");
  const { reason } = cancelSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const order = await lockSalesOrder(tx, ctx, id);
    if (order.status !== S.DRAFT && order.status !== S.CONFIRMED) {
      throw new AppError("INVALID_STATE", `A ${order.status} order cannot be cancelled`, 422);
    }
    const lines = await tx.salesOrderLine.findMany({ where: { salesOrderId: id } });
    if (hasDeliveries(lines)) throw new AppError("INVALID_STATE", "Orders with deliveries cannot be cancelled", 422);
    await releaseSalesOrder(tx, id);
    const updated = await tx.salesOrder.update({ where: { id }, data: { status: S.CANCELLED, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "sales_order.cancelled", entity: "sales_order", entityId: id, companyId: order.companyId, previous: { status: order.status }, next: { status: S.CANCELLED, reason } });
    return updated;
  });
}

async function assertOrderWarehouse(tx: Prisma.TransactionClient, ctx: AccessContext, companyId: string, warehouseId?: string | null) {
  if (!warehouseId) return;
  const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, companyId, organizationId: ctx.organizationId }, select: { isActive: true } });
  if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found in this company", 404);
  if (!warehouse.isActive) throw new AppError("INVALID_STATE", "Warehouse is inactive", 422);
}

/**
 * Top up reservations of a confirmed order (e.g. after new stock arrived). Idempotent:
 * reservations never exceed the open (ordered − delivered) quantity.
 */
export async function reserveSalesOrderStock(ctx: AccessContext, id: string) {
  assertCan(ctx, "sales_order.update");
  return prisma.$transaction(async (tx) => {
    const order = await lockSalesOrder(tx, ctx, id);
    if (order.status !== S.CONFIRMED && order.status !== S.PARTIALLY_DELIVERED) {
      throw new AppError("INVALID_STATE", `A ${order.status} order holds no reservations`, 422);
    }
    const reservations = await reserveSalesOrder(tx, id);
    await audit(tx, ctx, { action: "sales_order.reserved", entity: "sales_order", entityId: id, companyId: order.companyId, next: { reservations } });
    return { salesOrderId: id, reservations };
  });
}
