import { z } from "zod";
import {
  Prisma,
  PurchaseOrderStatus,
  SalesOrderStatus,
  StockEntryStatus,
  StockEntryType,
  type Product,
  type StockEntry,
  type StockEntryLine,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, Decimal, zDecimal } from "@/lib/money";
import {
  allowNegativeStock,
  applyMoves,
  baseFactor,
  isStocked,
  lockStock,
  resolveLocation,
  resolveLot,
  type MoveInput,
} from "@/features/inventory/stock";

type Db = Prisma.TransactionClient;
const T = StockEntryType;

const NUMBERING: Record<StockEntryType, string> = {
  OPENING: "stock_entry",
  RECEIPT: "stock_entry",
  ISSUE: "stock_entry",
  ADJUSTMENT: "stock_entry",
  TRANSFER: "stock_entry",
  GOODS_RECEIPT: "goods_receipt",
  DELIVERY: "delivery",
  SALES_RETURN: "sales_return",
  PURCHASE_RETURN: "purchase_return",
};

const INBOUND: StockEntryType[] = [T.OPENING, T.RECEIPT, T.GOODS_RECEIPT, T.SALES_RETURN];
const OUTBOUND: StockEntryType[] = [T.ISSUE, T.DELIVERY, T.PURCHASE_RETURN];

// ─── Manual entries: opening stock, receipts, issues, adjustments, transfers ──

const manualLineSchema = z.object({
  productId: z.string().min(1),
  /** Signed for ADJUSTMENT (+ found, − lost); positive otherwise */
  quantity: zDecimal({ min: -1e12, places: 4 }).refine((q) => !q.isZero(), "Quantity cannot be zero"),
  uomId: z.string().min(1).nullish(),
  unitCost: zDecimal({ places: 4 }).nullish(),
  lotNumber: z.string().trim().max(64).nullish(),
  expiryDate: z.coerce.date().nullish(),
  sourceLocationId: z.string().min(1).nullish(),
  targetLocationId: z.string().min(1).nullish(),
});

const manualEntrySchema = z
  .object({
    companyId: z.string().min(1),
    branchId: z.string().min(1).nullish(),
    type: z.enum([T.OPENING, T.RECEIPT, T.ISSUE, T.ADJUSTMENT, T.TRANSFER]),
    sourceWarehouseId: z.string().min(1).nullish(),
    targetWarehouseId: z.string().min(1).nullish(),
    reference: z.string().trim().max(120).nullish(),
    notes: z.string().trim().max(4000).nullish(),
    lines: z.array(manualLineSchema).min(1, "Add at least one line").max(500),
    /** Post immediately (needs inventory.post) instead of leaving a draft */
    post: z.boolean().default(false),
  })
  .superRefine((e, ctx) => {
    const needsSource = e.type === T.ISSUE || e.type === T.TRANSFER;
    const needsTarget = e.type !== T.ISSUE;
    if (needsSource && !e.sourceWarehouseId) ctx.addIssue({ code: "custom", path: ["sourceWarehouseId"], message: "Source warehouse is required" });
    if (needsTarget && !e.targetWarehouseId) ctx.addIssue({ code: "custom", path: ["targetWarehouseId"], message: e.type === T.ADJUSTMENT ? "Warehouse is required" : "Target warehouse is required" });
    if (e.type === T.TRANSFER && e.sourceWarehouseId && e.sourceWarehouseId === e.targetWarehouseId) {
      ctx.addIssue({ code: "custom", path: ["targetWarehouseId"], message: "Transfer between two different warehouses" });
    }
    e.lines.forEach((l, i) => {
      if (e.type !== T.ADJUSTMENT && l.quantity.lt(0)) ctx.addIssue({ code: "custom", path: ["lines", i, "quantity"], message: "Quantity must be positive" });
      if (e.type === T.OPENING && !l.unitCost) ctx.addIssue({ code: "custom", path: ["lines", i, "unitCost"], message: "Opening stock needs a unit cost" });
    });
  });

async function assertWarehouse(db: Db, organizationId: string, companyId: string, warehouseId?: string | null) {
  if (!warehouseId) return;
  const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, organizationId, companyId }, select: { isActive: true } });
  if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found in this company", 404);
  if (!warehouse.isActive) throw new AppError("INVALID_STATE", "Warehouse is inactive", 422);
}

async function loadProducts(db: Db, organizationId: string, ids: string[]) {
  const products = await db.product.findMany({ where: { organizationId, id: { in: [...new Set(ids)] } } });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of ids) {
    const product = byId.get(id);
    if (!product) throw new AppError("INVALID_REFERENCE", "Product not found", 422);
    if (!isStocked(product)) throw new AppError("VALIDATION_ERROR", `${product.sku} does not track stock`, 422);
  }
  return byId;
}

export async function createStockEntry(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "inventory.create");
  const data = manualEntrySchema.parse(input);
  if (data.post) assertCan(ctx, "inventory.post");
  assertCompanyAccess(ctx, data.companyId, data.branchId);

  return prisma.$transaction(async (tx) => {
    await assertWarehouse(tx, ctx.organizationId, data.companyId, data.sourceWarehouseId);
    await assertWarehouse(tx, ctx.organizationId, data.companyId, data.targetWarehouseId);
    const products = await loadProducts(tx, ctx.organizationId, data.lines.map((l) => l.productId));
    const lines = await Promise.all(
      data.lines.map(async (l) => ({
        productId: l.productId,
        quantity: l.quantity,
        uomId: l.uomId ?? null,
        baseQuantity: l.quantity.mul(await baseFactor(tx, products.get(l.productId)!, l.uomId)),
        unitCost: l.unitCost ?? null,
        lotNumber: l.lotNumber ?? null,
        expiryDate: l.expiryDate ?? null,
        sourceLocationId: l.sourceLocationId ?? null,
        targetLocationId: l.targetLocationId ?? null,
      })),
    );
    const entry = await createEntry(tx, ctx, {
      companyId: data.companyId,
      branchId: data.branchId ?? null,
      type: data.type,
      sourceWarehouseId: data.sourceWarehouseId ?? null,
      targetWarehouseId: data.targetWarehouseId ?? null,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      lines,
    });
    return data.post ? postEntryInTx(tx, ctx, entry.id) : entry;
  }, { timeout: 30_000 });
}

type NewEntry = {
  companyId: string;
  branchId?: string | null;
  type: StockEntryType;
  sourceWarehouseId?: string | null;
  targetWarehouseId?: string | null;
  purchaseOrderId?: string | null;
  salesOrderId?: string | null;
  vendorId?: string | null;
  customerId?: string | null;
  returnOfId?: string | null;
  reference?: string | null;
  notes?: string | null;
  lines: Omit<Prisma.StockEntryLineUncheckedCreateWithoutEntryInput, "organizationId">[];
};

async function createEntry(tx: Db, ctx: AccessContext, data: NewEntry) {
  const { lines, ...header } = data;
  const entry = await tx.stockEntry.create({
    data: {
      ...header,
      organizationId: ctx.organizationId,
      number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, NUMBERING[data.type]),
      createdById: ctx.userId,
      lines: { create: lines },
    },
    include: { lines: true },
  });
  await audit(tx, ctx, { action: "stock_entry.created", entity: "stock_entry", entityId: entry.id, companyId: entry.companyId, next: entry });
  return entry;
}

// ─── Posting ─────────────────────────────────────────────────────────────────

async function lockEntry(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "stock_entries" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const entry = await tx.stockEntry.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { lines: { include: { product: true } } },
  });
  if (!entry) throw new AppError("NOT_FOUND", "Stock entry not found", 404);
  assertCompanyAccess(ctx, entry.companyId, entry.branchId);
  return entry;
}

/** Post a DRAFT entry. Retry-safe: an entry that is already POSTED is returned as is. */
export async function postStockEntry(ctx: AccessContext, id: string) {
  assertCan(ctx, "inventory.post");
  return prisma.$transaction((tx) => postEntryInTx(tx, ctx, id), { timeout: 30_000 });
}

type LoadedLine = StockEntryLine & { product: Product };

async function postEntryInTx(tx: Db, ctx: AccessContext, id: string) {
  const entry = await lockEntry(tx, ctx, id);
  if (entry.status === StockEntryStatus.POSTED) return entry;
  if (entry.status !== StockEntryStatus.DRAFT) throw new AppError("INVALID_STATE", `A ${entry.status} entry cannot be posted`, 422);

  // Lock the source document first so its quantities cannot change underneath us.
  if (entry.purchaseOrderId) await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${entry.purchaseOrderId} FOR UPDATE`;
  if (entry.salesOrderId) await tx.$queryRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${entry.salesOrderId} FOR UPDATE`;
  const stocked = entry.lines.filter((l) => isStocked(l.product));
  await lockStock(tx, entry.companyId, stocked.map((l) => l.productId));

  await applyDocumentEffects(tx, entry, entry.lines, 1);
  const moves = await buildMoves(tx, entry, stocked);
  await applyMoves(tx, entry, moves, { allowNegative: await allowNegativeStock(tx, entry.companyId) });
  await syncSourceStatus(tx, entry);

  const posted = await tx.stockEntry.update({
    where: { id },
    data: { status: StockEntryStatus.POSTED, postedAt: new Date(), postedById: ctx.userId },
    include: { lines: true },
  });
  await audit(tx, ctx, {
    action: "stock_entry.posted",
    entity: "stock_entry",
    entityId: id,
    companyId: entry.companyId,
    previous: { status: entry.status },
    next: { status: posted.status, moves: moves.length },
  });
  return posted;
}

async function originalMoveCost(tx: Db, entryLineId: string | null) {
  if (!entryLineId) return null;
  const move = await tx.stockMove.findFirst({ where: { entryLineId, isReversal: false }, orderBy: { movedAt: "asc" } });
  return move ? new Decimal(move.unitCost) : null;
}

async function buildMoves(tx: Db, entry: StockEntry, lines: LoadedLine[]): Promise<MoveInput[]> {
  const moves: MoveInput[] = [];
  for (const line of lines) {
    const base = new Decimal(line.baseQuantity);
    const inbound = INBOUND.includes(entry.type) || (entry.type === T.ADJUSTMENT && base.gt(0));
    const isTransfer = entry.type === T.TRANSFER;
    const lot = await resolveLot(tx, {
      organizationId: entry.organizationId,
      companyId: entry.companyId,
      product: line.product,
      lotNumber: line.lotNumber,
      expiryDate: line.expiryDate,
      baseQuantity: base,
      inbound: inbound && !isTransfer,
      blockExpired: entry.type === T.DELIVERY,
    });
    if (lot && line.lotId !== lot.id) await tx.stockEntryLine.update({ where: { id: line.id }, data: { lotId: lot.id } });

    const common = { productId: line.productId, lotId: lot?.id ?? null, entryId: entry.id, entryLineId: line.id };
    if (isTransfer || OUTBOUND.includes(entry.type) || (entry.type === T.ADJUSTMENT && base.lt(0))) {
      const warehouseId = (entry.type === T.ADJUSTMENT ? entry.targetWarehouseId : entry.sourceWarehouseId)!;
      const location = await resolveLocation(tx, entry.organizationId, warehouseId, line.sourceLocationId ?? (entry.type === T.ADJUSTMENT ? line.targetLocationId : null));
      // Purchase returns leave at the cost they came in at; everything else at average cost.
      const unitCost = entry.type === T.PURCHASE_RETURN ? await originalMoveCost(tx, line.returnOfLineId) : null;
      moves.push({ ...common, warehouseId, locationId: location.id, quantity: base.abs().neg(), unitCost });
      if (!isTransfer) continue;
    }
    if (isTransfer || inbound) {
      const warehouseId = entry.targetWarehouseId!;
      const location = await resolveLocation(tx, entry.organizationId, warehouseId, line.targetLocationId);
      let unitCost: Decimal | null = line.unitCost ? new Decimal(line.unitCost) : null;
      if (entry.type === T.SALES_RETURN) unitCost = await originalMoveCost(tx, line.returnOfLineId);
      if (isTransfer) unitCost = null; // same company: leaves and arrives at average cost
      if (!unitCost && (entry.type === T.RECEIPT || entry.type === T.ADJUSTMENT)) {
        const valuation = await tx.stockValuation.findUnique({ where: { companyId_productId: { companyId: entry.companyId, productId: line.productId } } });
        unitCost = valuation && dec(valuation.quantity).gt(0) ? new Decimal(valuation.averageCost) : new Decimal(line.product.purchasePrice);
      }
      moves.push({ ...common, warehouseId, locationId: location.id, quantity: base.abs(), unitCost });
    }
  }
  return moves;
}

/**
 * Quantities on the source documents. `sign` is +1 when posting and −1 when a posted
 * entry is cancelled. Over-receipt, over-delivery and over-return are rejected here.
 */
async function applyDocumentEffects(tx: Db, entry: StockEntry, lines: LoadedLine[], sign: 1 | -1) {
  for (const line of lines) {
    const qty = new Decimal(line.quantity).mul(sign);
    if (entry.type === T.GOODS_RECEIPT && line.purchaseOrderLineId) {
      const po = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.purchaseOrderLineId } });
      const received = dec(po.receivedQty).add(qty);
      if (received.gt(po.quantity)) throw overQuantity(line.product.sku, "received", po.quantity, po.receivedQty);
      // Un-receiving may not leave more billed than received (three-way match).
      if (received.sub(po.returnedQty).lt(po.billedQty)) {
        throw new AppError("INVALID_STATE", `${line.product.sku}: cancel the posted vendor bills for this receipt first`, 422);
      }
      await tx.purchaseOrderLine.update({ where: { id: po.id }, data: { receivedQty: received } });
    }
    if (entry.type === T.DELIVERY && line.salesOrderLineId) {
      const so = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: line.salesOrderLineId }, include: { reservation: true } });
      const delivered = dec(so.deliveredQty).add(qty);
      if (delivered.gt(so.quantity)) throw overQuantity(line.product.sku, "delivered", so.quantity, so.deliveredQty);
      await tx.salesOrderLine.update({ where: { id: so.id }, data: { deliveredQty: delivered } });
      // Shipping consumes the line's reservation first (cancellation does not restore it).
      if (sign === 1 && so.reservation) {
        const consume = Decimal.min(dec(so.reservation.quantity), new Decimal(line.baseQuantity));
        await tx.stockReservation.update({ where: { id: so.reservation.id }, data: { quantity: dec(so.reservation.quantity).sub(consume) } });
      }
    }
    if ((entry.type === T.SALES_RETURN || entry.type === T.PURCHASE_RETURN) && line.returnOfLineId) {
      const original = await tx.stockEntryLine.findUniqueOrThrow({ where: { id: line.returnOfLineId } });
      if (sign === 1) {
        const returned = await tx.stockEntryLine.aggregate({
          where: { returnOfLineId: original.id, entry: { status: StockEntryStatus.POSTED } },
          _sum: { quantity: true },
        });
        const already = dec(returned._sum.quantity);
        if (already.add(line.quantity).gt(original.quantity)) {
          throw overQuantity(line.product.sku, "returned", original.quantity, already);
        }
      }
      if (entry.type === T.SALES_RETURN && original.salesOrderLineId) {
        await tx.salesOrderLine.update({ where: { id: original.salesOrderLineId }, data: { returnedQty: { increment: qty } } });
      }
      if (entry.type === T.PURCHASE_RETURN && original.purchaseOrderLineId) {
        await tx.purchaseOrderLine.update({ where: { id: original.purchaseOrderLineId }, data: { returnedQty: { increment: qty } } });
      }
    }
  }
}

function overQuantity(sku: string, verb: string, ordered: Prisma.Decimal.Value, done: Prisma.Decimal.Value) {
  return new AppError(
    "QUANTITY_EXCEEDED",
    `${sku}: only ${dec(ordered).sub(done).toString()} more can be ${verb} (${dec(done).toString()} of ${dec(ordered).toString()} done)`,
    422,
  );
}

/** Recompute PO / SO status from line quantities (lines without a product don't ship). */
async function syncSourceStatus(tx: Db, entry: Pick<StockEntry, "purchaseOrderId" | "salesOrderId">) {
  if (entry.purchaseOrderId) {
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: entry.purchaseOrderId }, include: { lines: true } });
    if (po.status === PurchaseOrderStatus.APPROVED || po.status === PurchaseOrderStatus.PARTIALLY_RECEIVED || po.status === PurchaseOrderStatus.RECEIVED) {
      const all = po.lines.every((l) => dec(l.receivedQty).gte(l.quantity));
      const any = po.lines.some((l) => dec(l.receivedQty).gt(0));
      const status = all ? PurchaseOrderStatus.RECEIVED : any ? PurchaseOrderStatus.PARTIALLY_RECEIVED : PurchaseOrderStatus.APPROVED;
      if (status !== po.status) await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } });
    }
  }
  if (entry.salesOrderId) {
    const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: entry.salesOrderId }, include: { lines: true } });
    const shippable = so.lines.filter((l) => l.productId);
    if (so.status !== SalesOrderStatus.CANCELLED && so.status !== SalesOrderStatus.DRAFT) {
      const all = shippable.every((l) => dec(l.deliveredQty).gte(l.quantity));
      const any = shippable.some((l) => dec(l.deliveredQty).gt(0));
      const status = all ? SalesOrderStatus.DELIVERED : any ? SalesOrderStatus.PARTIALLY_DELIVERED : SalesOrderStatus.CONFIRMED;
      if (status !== so.status) await tx.salesOrder.update({ where: { id: so.id }, data: { status } });
    }
  }
}

// ─── Cancellation / reversal ─────────────────────────────────────────────────

const cancelSchema = z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) });

/**
 * DRAFT → CANCELLED. POSTED → CANCELLED by writing reversing moves at the original
 * costs and undoing the document quantities. Blocked while later documents depend on
 * the entry (posted returns, posted vendor bills).
 */
export async function cancelStockEntry(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "inventory.post");
  const { reason } = cancelSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, ctx, id);
    if (entry.status === StockEntryStatus.CANCELLED) return entry;
    if (entry.status === StockEntryStatus.POSTED) {
      const dependentReturns = await tx.stockEntry.count({ where: { returnOfId: id, status: StockEntryStatus.POSTED } });
      if (dependentReturns > 0) throw new AppError("INVALID_STATE", "Cancel the posted returns against this entry first", 422);

      if (entry.purchaseOrderId) await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${entry.purchaseOrderId} FOR UPDATE`;
      if (entry.salesOrderId) await tx.$queryRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${entry.salesOrderId} FOR UPDATE`;
      const originals = await tx.stockMove.findMany({ where: { entryId: id, isReversal: false } });
      await lockStock(tx, entry.companyId, originals.map((m) => m.productId));
      await applyDocumentEffects(tx, entry, entry.lines, -1);
      await applyMoves(
        tx,
        entry,
        originals.map((m) => ({
          warehouseId: m.warehouseId,
          locationId: m.locationId,
          productId: m.productId,
          lotId: m.lotId,
          quantity: new Decimal(m.quantity).neg(),
          unitCost: new Decimal(m.unitCost),
          entryId: id,
          entryLineId: m.entryLineId,
          isReversal: true,
        })),
        { allowNegative: await allowNegativeStock(tx, entry.companyId) },
      );
      await syncSourceStatus(tx, entry);
    }
    const cancelled = await tx.stockEntry.update({
      where: { id },
      data: { status: StockEntryStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
    });
    await audit(tx, ctx, {
      action: "stock_entry.cancelled",
      entity: "stock_entry",
      entityId: id,
      companyId: entry.companyId,
      previous: { status: entry.status },
      next: { status: cancelled.status, reason },
    });
    return cancelled;
  }, { timeout: 30_000 });
}

// ─── Document-driven entries: goods receipts, deliveries, returns ────────────

const receiveSchema = z.object({
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().min(1),
        quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
        lotNumber: z.string().trim().max(64).nullish(),
        expiryDate: z.coerce.date().nullish(),
        targetLocationId: z.string().min(1).nullish(),
      }),
    )
    .min(1, "Receive at least one line"),
  reference: z.string().trim().max(120).nullish(),
  post: z.boolean().default(true),
});

/**
 * Goods receipt note for an approved purchase order. Approval alone never changes
 * stock; the posted receipt does. Cost per base unit = the PO line's taxable value.
 */
export async function receivePurchaseOrder(ctx: AccessContext, purchaseOrderId: string, input: unknown) {
  assertCan(ctx, "inventory.create");
  const data = receiveSchema.parse(input);
  if (data.post) assertCan(ctx, "inventory.post");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${purchaseOrderId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const po = await tx.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, organizationId: ctx.organizationId },
      include: { lines: { include: { product: true } } },
    });
    if (!po) throw new AppError("NOT_FOUND", "Purchase order not found", 404);
    assertCompanyAccess(ctx, po.companyId, po.branchId);
    if (po.status !== PurchaseOrderStatus.APPROVED && po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
      throw new AppError("INVALID_STATE", `A ${po.status} purchase order cannot be received`, 422);
    }
    const lines = await Promise.all(
      data.lines.map(async (l) => {
        const poLine = po.lines.find((x) => x.id === l.purchaseOrderLineId);
        if (!poLine) throw new AppError("INVALID_REFERENCE", "Line is not on this purchase order", 422);
        if (!isStocked(poLine.product)) throw new AppError("VALIDATION_ERROR", `${poLine.product.sku} does not track stock`, 422);
        const factor = await baseFactor(tx, poLine.product, poLine.uomId);
        return {
          productId: poLine.productId,
          quantity: l.quantity,
          uomId: poLine.uomId,
          baseQuantity: l.quantity.mul(factor),
          unitCost: dec(poLine.taxableAmount).div(poLine.quantity).div(factor).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
          lotNumber: l.lotNumber ?? null,
          expiryDate: l.expiryDate ?? null,
          targetLocationId: l.targetLocationId ?? null,
          purchaseOrderLineId: poLine.id,
        };
      }),
    );
    const entry = await createEntry(tx, ctx, {
      companyId: po.companyId,
      branchId: po.branchId,
      type: T.GOODS_RECEIPT,
      targetWarehouseId: po.warehouseId,
      purchaseOrderId: po.id,
      vendorId: po.vendorId,
      reference: data.reference ?? null,
      lines,
    });
    return data.post ? postEntryInTx(tx, ctx, entry.id) : entry;
  }, { timeout: 30_000 });
}

const deliverSchema = z.object({
  lines: z
    .array(
      z.object({
        salesOrderLineId: z.string().min(1),
        quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
        lotNumber: z.string().trim().max(64).nullish(),
        sourceLocationId: z.string().min(1).nullish(),
      }),
    )
    .min(1, "Deliver at least one line"),
  reference: z.string().trim().max(120).nullish(),
  post: z.boolean().default(true),
});

/**
 * Delivery for a confirmed sales order: stock is issued from the order's warehouse
 * when the delivery is posted, consuming the line's reservation first. Lines for
 * services/non-stock products are marked delivered without stock moves.
 */
export async function deliverSalesOrder(ctx: AccessContext, salesOrderId: string, input: unknown) {
  assertCan(ctx, "inventory.create");
  const data = deliverSchema.parse(input);
  if (data.post) assertCan(ctx, "inventory.post");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${salesOrderId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const so = await tx.salesOrder.findFirst({
      where: { id: salesOrderId, organizationId: ctx.organizationId },
      include: { lines: { include: { product: true } } },
    });
    if (!so) throw new AppError("NOT_FOUND", "Sales order not found", 404);
    assertCompanyAccess(ctx, so.companyId, so.branchId);
    if (so.status !== SalesOrderStatus.CONFIRMED && so.status !== SalesOrderStatus.PARTIALLY_DELIVERED) {
      throw new AppError("INVALID_STATE", `A ${so.status} order cannot be delivered`, 422);
    }
    if (!so.warehouseId) throw new AppError("VALIDATION_ERROR", "The order has no warehouse", 422);

    const lines = await Promise.all(
      data.lines.map(async (l) => {
        const soLine = so.lines.find((x) => x.id === l.salesOrderLineId);
        if (!soLine || !soLine.product) throw new AppError("INVALID_REFERENCE", "Line is not a product line of this order", 422);
        const factor = await baseFactor(tx, soLine.product, soLine.uomId);
        return {
          productId: soLine.product.id,
          quantity: l.quantity,
          uomId: soLine.uomId,
          baseQuantity: l.quantity.mul(factor),
          lotNumber: l.lotNumber ?? null,
          sourceLocationId: l.sourceLocationId ?? null,
          salesOrderLineId: soLine.id,
        };
      }),
    );
    const entry = await createEntry(tx, ctx, {
      companyId: so.companyId,
      branchId: so.branchId,
      type: T.DELIVERY,
      sourceWarehouseId: so.warehouseId,
      salesOrderId: so.id,
      customerId: so.customerId,
      reference: data.reference ?? so.customerPoNumber ?? null,
      lines,
    });
    return data.post ? postEntryInTx(tx, ctx, entry.id) : entry;
  }, { timeout: 30_000 });
}

const returnSchema = z.object({
  lines: z
    .array(
      z.object({
        entryLineId: z.string().min(1),
        quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
      }),
    )
    .min(1, "Return at least one line"),
  reason: z.string().trim().max(1000).nullish(),
  post: z.boolean().default(true),
});

/**
 * Return against a posted delivery (customer sends goods back → SALES_RETURN, back
 * into the location they left) or a posted goods receipt (we send goods back to the
 * vendor → PURCHASE_RETURN). Cumulative returns can never exceed the original lines.
 */
export async function createReturn(ctx: AccessContext, entryId: string, input: unknown) {
  assertCan(ctx, "inventory.create");
  const data = returnSchema.parse(input);
  if (data.post) assertCan(ctx, "inventory.post");

  return prisma.$transaction(async (tx) => {
    const original = await lockEntry(tx, ctx, entryId);
    if (original.status !== StockEntryStatus.POSTED) throw new AppError("INVALID_STATE", "Only posted entries can be returned", 422);
    const type =
      original.type === T.DELIVERY ? T.SALES_RETURN : original.type === T.GOODS_RECEIPT ? T.PURCHASE_RETURN : null;
    if (!type) throw new AppError("INVALID_STATE", "Only deliveries and goods receipts can be returned", 422);
    const moves = await tx.stockMove.findMany({ where: { entryId, isReversal: false } });

    const lines = data.lines.map((l) => {
      const line = original.lines.find((x) => x.id === l.entryLineId);
      if (!line) throw new AppError("INVALID_REFERENCE", "Line is not on the original entry", 422);
      const move = moves.find((m) => m.entryLineId === line.id);
      const factor = dec(line.baseQuantity).div(line.quantity);
      return {
        productId: line.productId,
        quantity: l.quantity,
        uomId: line.uomId,
        baseQuantity: l.quantity.mul(factor),
        lotNumber: line.lotNumber,
        expiryDate: line.expiryDate,
        lotId: line.lotId,
        // Goods go back to (sales return) or leave from (purchase return) the original location.
        targetLocationId: type === T.SALES_RETURN ? move?.locationId ?? null : null,
        sourceLocationId: type === T.PURCHASE_RETURN ? move?.locationId ?? null : null,
        returnOfLineId: line.id,
      };
    });
    const entry = await createEntry(tx, ctx, {
      companyId: original.companyId,
      branchId: original.branchId,
      type,
      sourceWarehouseId: type === T.PURCHASE_RETURN ? original.targetWarehouseId : null,
      targetWarehouseId: type === T.SALES_RETURN ? original.sourceWarehouseId : null,
      salesOrderId: original.salesOrderId,
      purchaseOrderId: original.purchaseOrderId,
      customerId: original.customerId,
      vendorId: original.vendorId,
      returnOfId: original.id,
      notes: data.reason ?? null,
      lines,
    });
    return data.post ? postEntryInTx(tx, ctx, entry.id) : entry;
  }, { timeout: 30_000 });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const listSchema = listQuerySchema.extend({
  type: z.nativeEnum(StockEntryType).optional(),
  status: z.nativeEnum(StockEntryStatus).optional(),
  salesOrderId: z.string().optional(),
  purchaseOrderId: z.string().optional(),
  companyId: z.string().optional(),
});

export async function listStockEntries(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "inventory.view");
  const q = listSchema.parse(query);
  const where: Prisma.StockEntryWhereInput = {
    AND: [
      // Branch-limited members only see their branches' entries; company-wide entries
      // (no branch) need access to the whole company.
      companyScopeWhere(ctx),
      { type: q.type, status: q.status, salesOrderId: q.salesOrderId, purchaseOrderId: q.purchaseOrderId, companyId: q.companyId },
      searchWhere(q.q, ["number", "reference", "notes"]),
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.stockEntry.findMany({
        where,
        include: {
          sourceWarehouse: { select: { code: true } },
          targetWarehouse: { select: { code: true } },
          _count: { select: { lines: true } },
        },
        ...listArgs(q, ["createdAt", "number", "postedAt"], "createdAt"),
      }),
      prisma.stockEntry.count({ where }),
    ]),
  );
}

export async function getStockEntry(ctx: AccessContext, id: string) {
  assertCan(ctx, "inventory.view");
  const entry = await prisma.stockEntry.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      lines: {
        include: {
          product: { select: { id: true, sku: true, name: true } },
          uom: { select: { code: true } },
          lot: { select: { lotNumber: true, expiryDate: true } },
          returnLines: { where: { entry: { status: StockEntryStatus.POSTED } }, select: { quantity: true } },
        },
      },
      moves: { include: { location: { select: { code: true } } }, orderBy: { movedAt: "asc" } },
      sourceWarehouse: true,
      targetWarehouse: true,
      purchaseOrder: { select: { id: true, number: true } },
      salesOrder: { select: { id: true, number: true } },
      vendor: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
      returnOf: { select: { id: true, number: true, type: true } },
      returns: { select: { id: true, number: true, status: true } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!entry) throw new AppError("NOT_FOUND", "Stock entry not found", 404);
  assertCompanyAccess(ctx, entry.companyId, entry.branchId);
  return entry;
}

