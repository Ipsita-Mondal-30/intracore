import { z } from "zod";
import { StockEntryStatus, StockEntryType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, Decimal } from "@/lib/money";
import { isStocked, releaseWorkOrder, reserveWorkOrder, warehouseLevel } from "@/features/inventory/stock";
import { createAndPostEntry } from "@/features/inventory/entries";
import { activeBom, componentRequirement, positive } from "@/features/manufacturing/boms";
import { assertFullCompany, fullCompanyIds } from "@/features/manufacturing/scope";

type Db = Prisma.TransactionClient;
const ZERO = new Decimal(0);

/**
 * Work orders (see docs/MANUFACTURING.md):
 *   DRAFT --release--> RELEASED --start / first issue or receipt--> IN_PROGRESS --complete--> COMPLETED
 *   DRAFT | RELEASED | IN_PROGRESS --cancel--> CANCELLED (only while nothing is consumed or produced)
 * Materials are snapshotted from the BOM when the order is created. Release reserves them
 * as far as stock allows (shortages are reported, not blocking). Stock only moves through
 * PRODUCTION_ISSUE / PRODUCTION_RECEIPT stock entries; the engine updates consumedQty,
 * producedQty and the reservations, so this module never writes those columns itself.
 */

const createSchema = z
  .object({
    companyId: z.string().min(1),
    productId: z.string().min(1),
    /** Defaults to the product's ACTIVE version */
    bomId: z.string().min(1).nullish(),
    warehouseId: z.string().min(1),
    quantity: positive(4),
    plannedStart: z.coerce.date().nullish(),
    plannedEnd: z.coerce.date().nullish(),
    salesOrderId: z.string().min(1).nullish(),
  })
  .refine((d) => !d.plannedStart || !d.plannedEnd || d.plannedEnd >= d.plannedStart, { path: ["plannedEnd"], message: "Planned end is before the start" });

const issueSchema = z.object({
  /** Base units. Omit to issue everything still open. */
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: positive(4),
        lotNumber: z.string().trim().max(64).nullish(),
        sourceLocationId: z.string().min(1).nullish(),
      }),
    )
    .min(1)
    .max(500)
    .optional(),
  /** Issue more than the BOM requires (extra scrap). Audited. */
  allowOverIssue: z.boolean().default(false),
  reference: z.string().trim().max(120).nullish(),
});

const receiveSchema = z.object({
  quantity: positive(4),
  lotNumber: z.string().trim().max(64).nullish(),
  expiryDate: z.coerce.date().nullish(),
  targetLocationId: z.string().min(1).nullish(),
  /** Receive more than planned. Audited. */
  allowOverReceipt: z.boolean().default(false),
  reference: z.string().trim().max(120).nullish(),
});

const listSchema = listQuerySchema.extend({
  status: z.enum(["DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  productId: z.string().optional(),
  companyId: z.string().optional(),
});

export async function createWorkOrder(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "manufacturing.create");
  const data = createSchema.parse(input);
  assertFullCompany(ctx, data.companyId);

  return prisma.$transaction(async (tx) => {
    const [warehouse, product] = await Promise.all([
      tx.warehouse.findFirst({ where: { id: data.warehouseId, organizationId: ctx.organizationId, companyId: data.companyId } }),
      tx.product.findFirst({ where: { id: data.productId, organizationId: ctx.organizationId } }),
    ]);
    if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found in this company", 404);
    if (!warehouse.isActive) throw new AppError("INVALID_STATE", "Warehouse is inactive", 422);
    if (!product) throw new AppError("INVALID_REFERENCE", "Product not found", 422);
    if (!isStocked(product)) throw new AppError("VALIDATION_ERROR", `${product.sku} does not track stock`, 422);

    const bom = data.bomId
      ? await tx.bom.findFirst({ where: { id: data.bomId, organizationId: ctx.organizationId }, include: { lines: true } })
      : await activeBom(tx, ctx.organizationId, product.id);
    if (!bom) throw new AppError(data.bomId ? "INVALID_REFERENCE" : "NO_BOM", data.bomId ? "Bill of materials not found" : `${product.sku} has no active bill of materials`, 422);
    if (bom.productId !== product.id) throw new AppError("VALIDATION_ERROR", "That bill of materials is for another product", 422);
    if (bom.status === "DRAFT") throw new AppError("INVALID_STATE", "Activate the bill of materials before using it", 422);

    if (data.salesOrderId) {
      const so = await tx.salesOrder.findFirst({ where: { id: data.salesOrderId, organizationId: ctx.organizationId, companyId: data.companyId }, select: { id: true } });
      if (!so) throw new AppError("INVALID_REFERENCE", "Sales order not found in this company", 422);
    }

    const wo = await tx.workOrder.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "work_order"),
        productId: product.id,
        bomId: bom.id,
        warehouseId: warehouse.id,
        quantity: data.quantity,
        plannedStart: data.plannedStart ?? null,
        plannedEnd: data.plannedEnd ?? null,
        salesOrderId: data.salesOrderId ?? null,
        createdById: ctx.userId,
        materials: {
          create: bom.lines.map((l) => ({ productId: l.componentId, requiredQty: componentRequirement(l, data.quantity, bom.outputQuantity) })),
        },
      },
      include: { materials: true },
    });
    await audit(tx, ctx, { action: "work_order.created", entity: "work_order", entityId: wo.id, companyId: wo.companyId, next: wo });
    return wo;
  });
}

async function lockWorkOrder(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "work_orders" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const wo = await tx.workOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { materials: { include: { product: true } } } });
  if (!wo) throw new AppError("NOT_FOUND", "Work order not found", 404);
  assertFullCompany(ctx, wo.companyId);
  return wo;
}

export const WORK_ORDER_ACTIONS = ["release", "reserve", "start", "complete", "cancel"] as const;
export type WorkOrderAction = (typeof WORK_ORDER_ACTIONS)[number];

const ACTION_RULES: Record<WorkOrderAction, { permission: string; from: string[]; to?: string }> = {
  release: { permission: "manufacturing.release", from: ["DRAFT"], to: "RELEASED" },
  reserve: { permission: "manufacturing.release", from: ["RELEASED", "IN_PROGRESS"] },
  start: { permission: "manufacturing.produce", from: ["RELEASED"], to: "IN_PROGRESS" },
  complete: { permission: "manufacturing.produce", from: ["RELEASED", "IN_PROGRESS"], to: "COMPLETED" },
  cancel: { permission: "manufacturing.release", from: ["DRAFT", "RELEASED", "IN_PROGRESS"], to: "CANCELLED" },
};

/**
 * release / reserve return `reservations: [{ workOrderMaterialId, reserved, short }]`.
 * Release does not require full availability: short materials stay short until stock
 * arrives and `reserve` tops them up (issuing is still bounded by stock on hand).
 */
export async function transitionWorkOrder(ctx: AccessContext, id: string, action: WorkOrderAction, input: unknown) {
  const rule = Object.hasOwn(ACTION_RULES, action) ? ACTION_RULES[action] : undefined;
  if (!rule) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, rule.permission);
  const { reason } = z.object({ reason: z.string().trim().max(1000).optional() }).parse(input ?? {});

  return prisma.$transaction(async (tx) => {
    const wo = await lockWorkOrder(tx, ctx, id);
    if (!rule.from.includes(wo.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a ${wo.status} work order`, 422);
    let reservations: Awaited<ReturnType<typeof reserveWorkOrder>> | undefined;

    if (action === "release" || action === "reserve") reservations = await reserveWorkOrder(tx, id);
    if (action === "complete" && !dec(wo.producedQty).gt(0)) {
      throw new AppError("INVALID_STATE", "Receive finished goods before completing the work order", 422);
    }
    if (action === "cancel" && (dec(wo.producedQty).gt(0) || wo.materials.some((m) => dec(m.consumedQty).gt(0)))) {
      throw new AppError("INVALID_STATE", "Materials were issued or goods produced: cancel those stock entries first, or complete the order", 422);
    }
    if (action === "complete" || action === "cancel") await releaseWorkOrder(tx, id);

    const updated = rule.to
      ? await tx.workOrder.update({ where: { id }, data: { status: rule.to } })
      : await tx.workOrder.findUniqueOrThrow({ where: { id } });
    await audit(tx, ctx, {
      action: `work_order.${action}`,
      entity: "work_order",
      entityId: id,
      companyId: wo.companyId,
      previous: { status: wo.status },
      next: { status: updated.status, reason, reservations },
    });
    return { ...updated, reservations };
  }, { timeout: 30_000 });
}

/** Move a RELEASED order to IN_PROGRESS on its first production entry. */
async function markStarted(tx: Db, wo: { id: string; status: string }) {
  if (wo.status === "RELEASED") await tx.workOrder.update({ where: { id: wo.id }, data: { status: "IN_PROGRESS" } });
}

/**
 * Issue materials to production (PRODUCTION_ISSUE from the order's warehouse, at average
 * cost). Consumed may not exceed required unless `allowOverIssue`; negative stock and
 * stock reserved for other orders are refused by the engine (INSUFFICIENT_STOCK).
 */
export async function issueMaterials(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "manufacturing.produce");
  const data = issueSchema.parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const wo = await lockWorkOrder(tx, ctx, id);
    if (wo.status !== "RELEASED" && wo.status !== "IN_PROGRESS") throw new AppError("INVALID_STATE", `Cannot issue materials to a ${wo.status} work order`, 422);

    const open = (m: (typeof wo.materials)[number]) => Decimal.max(dec(m.requiredQty).sub(m.consumedQty), ZERO);
    const lines = data.lines ?? wo.materials.filter((m) => open(m).gt(0)).map((m) => ({ productId: m.productId, quantity: open(m), lotNumber: null, sourceLocationId: null }));
    if (lines.length === 0) throw new AppError("INVALID_STATE", "All materials are already issued", 422);

    const requested = new Map<string, Decimal>();
    for (const l of lines) requested.set(l.productId, (requested.get(l.productId) ?? ZERO).add(l.quantity));
    for (const [productId, qty] of requested) {
      const m = wo.materials.find((x) => x.productId === productId);
      if (!m) throw new AppError("INVALID_REFERENCE", "That product is not a material of this work order", 422);
      if (!data.allowOverIssue && qty.gt(open(m))) {
        throw new AppError("QUANTITY_EXCEEDED", `${m.product.sku}: only ${open(m).toString()} more can be issued (${dec(m.consumedQty).toString()} of ${dec(m.requiredQty).toString()} issued)`, 422);
      }
    }

    const entry = await createAndPostEntry(tx, ctx, {
      companyId: wo.companyId,
      type: StockEntryType.PRODUCTION_ISSUE,
      sourceWarehouseId: wo.warehouseId,
      workOrderId: wo.id,
      reference: data.reference ?? wo.number,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, baseQuantity: l.quantity, lotNumber: l.lotNumber ?? null, sourceLocationId: l.sourceLocationId ?? null })),
    });
    await markStarted(tx, wo);
    await audit(tx, ctx, {
      action: "work_order.materials_issued",
      entity: "work_order",
      entityId: wo.id,
      companyId: wo.companyId,
      next: { stockEntryId: entry.id, number: entry.number, allowOverIssue: data.allowOverIssue },
    });
    return entry;
  }, { timeout: 30_000 });
}

/**
 * Value of materials consumed (net of cancelled issues) and already absorbed into
 * finished goods (net of cancelled receipts); the difference is still in WIP.
 */
export async function workOrderCosts(db: Db, workOrderId: string) {
  const sum = async (type: StockEntryType) =>
    dec((await db.stockMove.aggregate({ where: { entry: { workOrderId, type } }, _sum: { value: true } }))._sum.value);
  const consumed = (await sum(StockEntryType.PRODUCTION_ISSUE)).neg();
  const absorbed = await sum(StockEntryType.PRODUCTION_RECEIPT);
  return { consumedValue: consumed, absorbedValue: absorbed, wipValue: consumed.sub(absorbed) };
}

/**
 * Receive finished goods (PRODUCTION_RECEIPT into the order's warehouse). Unit cost:
 * the WIP value not yet absorbed, spread over the quantity still to be produced; a receipt
 * that reaches (or passes) the planned quantity absorbs all of it. Materials issued after
 * the final receipt stay in WIP (see docs/MANUFACTURING.md).
 */
export async function receiveFinishedGoods(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "manufacturing.produce");
  const data = receiveSchema.parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const wo = await lockWorkOrder(tx, ctx, id);
    if (wo.status !== "RELEASED" && wo.status !== "IN_PROGRESS") throw new AppError("INVALID_STATE", `Cannot receive goods for a ${wo.status} work order`, 422);
    const remaining = dec(wo.quantity).sub(wo.producedQty);
    if (!data.allowOverReceipt && data.quantity.gt(remaining)) {
      throw new AppError("QUANTITY_EXCEEDED", `Only ${Decimal.max(remaining, ZERO).toString()} more can be received (${dec(wo.producedQty).toString()} of ${dec(wo.quantity).toString()} produced)`, 422);
    }
    const { wipValue } = await workOrderCosts(tx, wo.id);
    const spreadOver = data.quantity.gte(remaining) ? data.quantity : remaining;
    const unitCost = Decimal.max(wipValue, ZERO).div(spreadOver).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const entry = await createAndPostEntry(tx, ctx, {
      companyId: wo.companyId,
      type: StockEntryType.PRODUCTION_RECEIPT,
      targetWarehouseId: wo.warehouseId,
      workOrderId: wo.id,
      reference: data.reference ?? wo.number,
      lines: [{
        productId: wo.productId,
        quantity: data.quantity,
        baseQuantity: data.quantity,
        unitCost,
        lotNumber: data.lotNumber ?? null,
        expiryDate: data.expiryDate ?? null,
        targetLocationId: data.targetLocationId ?? null,
      }],
    });
    await markStarted(tx, wo);
    await audit(tx, ctx, {
      action: "work_order.goods_received",
      entity: "work_order",
      entityId: wo.id,
      companyId: wo.companyId,
      next: { stockEntryId: entry.id, number: entry.number, quantity: data.quantity, unitCost, allowOverReceipt: data.allowOverReceipt },
    });
    return entry;
  }, { timeout: 30_000 });
}

export async function listWorkOrders(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "manufacturing.view");
  const q = listSchema.parse(query);
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds(ctx) } },
      { status: q.status, productId: q.productId, companyId: q.companyId },
      searchWhere(q.q, ["number"]),
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.workOrder.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true } }, warehouse: { select: { code: true } }, bom: { select: { version: true } } },
        ...listArgs(q, ["createdAt", "number", "plannedStart", "plannedEnd"], "createdAt"),
      }),
      prisma.workOrder.count({ where }),
    ]),
  );
}

/** Work order with per-material availability in its warehouse and the WIP costing. */
export async function getWorkOrder(ctx: AccessContext, id: string) {
  assertCan(ctx, "manufacturing.view");
  const wo = await prisma.workOrder.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      product: { select: { id: true, sku: true, name: true, trackingMode: true, hasExpiry: true, uom: { select: { code: true } } } },
      bom: { select: { id: true, version: true, outputQuantity: true } },
      warehouse: { select: { id: true, code: true, name: true } },
      company: { select: { id: true, code: true, name: true } },
      materials: {
        orderBy: { id: "asc" },
        include: { product: { select: { id: true, sku: true, name: true, trackingMode: true, uom: { select: { code: true } } } }, reservation: { select: { quantity: true } } },
      },
      stockEntries: { select: { id: true, number: true, type: true, status: true, postedAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!wo) throw new AppError("NOT_FOUND", "Work order not found", 404);
  assertFullCompany(ctx, wo.companyId);
  const db = prisma as unknown as Db;
  const materials = await Promise.all(
    wo.materials.map(async (m) => {
      const { onHand, reserved } = await warehouseLevel(db, wo.warehouseId, m.productId);
      const reservedHere = dec(m.reservation?.quantity);
      const open = Decimal.max(dec(m.requiredQty).sub(m.consumedQty), ZERO);
      const free = Decimal.max(onHand.sub(reserved), ZERO);
      const active = wo.status === "RELEASED" || wo.status === "IN_PROGRESS" || wo.status === "DRAFT";
      return {
        ...m,
        open: open.toString(),
        onHand: onHand.toString(),
        available: free.toString(),
        reserved: reservedHere.toString(),
        shortage: active ? Decimal.max(open.sub(reservedHere).sub(free), ZERO).toString() : "0",
      };
    }),
  );
  const costs = await workOrderCosts(db, wo.id);
  return {
    ...wo,
    materials,
    costs: { consumedValue: costs.consumedValue.toFixed(2), absorbedValue: costs.absorbedValue.toFixed(2), wipValue: costs.wipValue.toFixed(2) },
    postedEntries: wo.stockEntries.filter((e) => e.status === StockEntryStatus.POSTED).length,
  };
}
