import { z } from "zod";
import { Prisma, ProductType, RecordStatus, TrackingMode, type Product } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { dec, Decimal, money } from "@/lib/money";
import { companySettings } from "@/lib/settings";

/**
 * Stock lifecycle (see docs/INVENTORY.md):
 *   on hand    = Σ StockMove.quantity (cached per location/lot in StockBalance)
 *   reserved   = Σ open StockReservation.quantity (per warehouse, for confirmed sales orders)
 *   available  = on hand − reserved
 * Every change runs inside one transaction holding an advisory lock per
 * (company, product), taken in sorted order so concurrent postings cannot deadlock.
 * Valuation: moving weighted average cost per company and product.
 */

type Db = Prisma.TransactionClient;
const ZERO = new Decimal(0);

export const isStocked = (p: Pick<Product, "type" | "trackInventory">) =>
  p.type === ProductType.GOODS && p.trackInventory;

/** Serialize stock changes for these products within a company. */
export async function lockStock(tx: Db, companyId: string, productIds: string[]) {
  for (const productId of [...new Set(productIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${companyId}:${productId}`}, 0))`;
  }
}

/** Conversion of `uomId` into the product's base unit (1 when it is the base unit). */
export async function baseFactor(db: Db, product: Pick<Product, "id" | "uomId" | "sku">, uomId?: string | null) {
  if (!uomId || uomId === product.uomId) return new Decimal(1);
  const conversion = await db.uomConversion.findUnique({ where: { productId_uomId: { productId: product.id, uomId } } });
  if (!conversion) {
    throw new AppError("INVALID_REFERENCE", `No unit conversion defined for ${product.sku} in that unit`, 422);
  }
  return new Decimal(conversion.factor);
}

/** Default (or given) location of a warehouse, checked to belong to it. */
export async function resolveLocation(db: Db, organizationId: string, warehouseId: string, locationId?: string | null) {
  const location = await db.storageLocation.findFirst({
    where: locationId
      ? { id: locationId, organizationId, warehouseId, isActive: true }
      : { organizationId, warehouseId, isActive: true, isDefault: true },
  });
  if (!location) {
    throw new AppError("INVALID_REFERENCE", locationId ? "Location is not in that warehouse" : "Warehouse has no default location", 422);
  }
  return location;
}

const startOfToday = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Batch/serial rules. Untracked products take no lot. Tracked products need a lot
 * number; inbound creates it (expiry required when the product has expiry), outbound
 * must use an existing, unexpired lot. Serial numbers move one unit at a time and an
 * inbound serial must not already be in stock.
 */
export async function resolveLot(
  db: Db,
  input: {
    organizationId: string;
    companyId: string;
    product: Product;
    lotNumber?: string | null;
    expiryDate?: Date | null;
    baseQuantity: Decimal;
    inbound: boolean;
    blockExpired: boolean;
  },
) {
  const { product } = input;
  if (product.trackingMode === TrackingMode.NONE) {
    if (input.lotNumber) throw new AppError("VALIDATION_ERROR", `${product.sku} is not batch/serial tracked`, 422);
    return null;
  }
  const lotNumber = input.lotNumber?.trim();
  if (!lotNumber) {
    throw new AppError("VALIDATION_ERROR", `${product.sku} needs a ${product.trackingMode === "SERIAL" ? "serial" : "batch"} number`, 422);
  }
  if (product.trackingMode === TrackingMode.SERIAL && !input.baseQuantity.abs().eq(1)) {
    throw new AppError("VALIDATION_ERROR", `Serial-tracked ${product.sku} moves one unit per line`, 422);
  }

  let lot = await db.stockLot.findUnique({ where: { productId_lotNumber: { productId: product.id, lotNumber } } });
  if (input.inbound) {
    if (!lot) {
      if (product.hasExpiry && !input.expiryDate) {
        throw new AppError("VALIDATION_ERROR", `${product.sku} batch ${lotNumber} needs an expiry date`, 422);
      }
      lot = await db.stockLot.create({
        data: { organizationId: input.organizationId, productId: product.id, lotNumber, expiryDate: input.expiryDate ?? null },
      });
    } else if (product.trackingMode === TrackingMode.SERIAL) {
      const onHand = await db.stockBalance.aggregate({
        where: { companyId: input.companyId, productId: product.id, lotId: lot.id },
        _sum: { quantity: true },
      });
      if (dec(onHand._sum.quantity).gt(0)) {
        throw new AppError("CONFLICT", `Serial ${lotNumber} of ${product.sku} is already in stock`, 409);
      }
    }
    return lot;
  }
  if (!lot) throw new AppError("INVALID_REFERENCE", `${product.sku} has no batch/serial ${lotNumber}`, 422);
  if (input.blockExpired && lot.expiryDate && lot.expiryDate < startOfToday()) {
    throw new AppError("INVALID_STATE", `${product.sku} batch ${lotNumber} expired on ${lot.expiryDate.toISOString().slice(0, 10)}`, 422);
  }
  return lot;
}

export type MoveInput = {
  warehouseId: string;
  locationId: string;
  productId: string;
  lotId: string | null;
  /** Signed, base units: + into the location, − out of it */
  quantity: Decimal;
  /** Explicit cost per base unit (receipts, returns, reversals); otherwise average cost */
  unitCost?: Decimal | null;
  entryId: string;
  entryLineId: string;
  isReversal?: boolean;
};

/**
 * Write moves to the ledger and update cached balances and valuation. Callers must
 * hold lockStock for every product involved. Outbound moves may not take a location
 * below zero, nor the warehouse below what is reserved for other orders, unless the
 * company allows negative stock.
 */
export async function applyMoves(
  tx: Db,
  scope: { organizationId: string; companyId: string },
  moves: MoveInput[],
  options: { allowNegative: boolean },
) {
  const outbound = new Map<string, { warehouseId: string; productId: string }>();

  for (const move of moves) {
    if (move.quantity.isZero()) continue;
    const valuation = await tx.stockValuation.upsert({
      where: { companyId_productId: { companyId: scope.companyId, productId: move.productId } },
      create: { organizationId: scope.organizationId, companyId: scope.companyId, productId: move.productId },
      update: {},
    });
    const qty0 = dec(valuation.quantity);
    const value0 = dec(valuation.value);
    const avg0 = dec(valuation.averageCost);
    const unitCost = move.unitCost ?? avg0;
    const value = money(move.quantity.mul(unitCost));
    const qty1 = qty0.add(move.quantity);
    let value1 = value0.add(value);
    let avg1 = avg0;
    if (move.quantity.gt(0)) {
      avg1 = qty1.gt(0) ? value1.div(qty1).toDecimalPlaces(4, Decimal.ROUND_HALF_UP) : unitCost;
    }
    if (qty1.isZero()) value1 = ZERO; // write off rounding residue when the product runs out
    else if (qty1.lt(0)) value1 = money(qty1.mul(avg1)); // negative stock (policy) carries at average cost

    await tx.stockValuation.update({
      where: { id: valuation.id },
      data: { quantity: qty1, value: value1, averageCost: avg1 },
    });

    const lotKey = move.lotId ?? "";
    const balance = await tx.stockBalance.upsert({
      where: { locationId_productId_lotKey: { locationId: move.locationId, productId: move.productId, lotKey } },
      create: {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        warehouseId: move.warehouseId,
        locationId: move.locationId,
        productId: move.productId,
        lotId: move.lotId,
        lotKey,
        quantity: move.quantity,
      },
      update: { quantity: { increment: move.quantity } },
    });
    if (move.quantity.lt(0)) {
      if (!options.allowNegative && dec(balance.quantity).lt(0)) {
        throw new AppError("INSUFFICIENT_STOCK", "Not enough stock at the location", 422, {
          productId: move.productId,
          locationId: move.locationId,
          lotId: move.lotId,
          shortBy: dec(balance.quantity).neg().toString(),
        });
      }
      outbound.set(`${move.warehouseId}:${move.productId}`, { warehouseId: move.warehouseId, productId: move.productId });
    }

    await tx.stockMove.create({
      data: {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        warehouseId: move.warehouseId,
        locationId: move.locationId,
        productId: move.productId,
        lotId: move.lotId,
        entryId: move.entryId,
        entryLineId: move.entryLineId,
        quantity: move.quantity,
        unitCost: unitCost.toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
        value,
        isReversal: move.isReversal ?? false,
      },
    });
  }

  if (!options.allowNegative) {
    for (const { warehouseId, productId } of outbound.values()) {
      const { onHand, reserved } = await warehouseLevel(tx, warehouseId, productId);
      if (onHand.sub(reserved).lt(0)) {
        throw new AppError("INSUFFICIENT_STOCK", "That stock is reserved for other orders", 422, {
          productId,
          warehouseId,
          onHand: onHand.toString(),
          reserved: reserved.toString(),
        });
      }
    }
  }
}

export async function warehouseLevel(db: Db, warehouseId: string, productId: string) {
  const [balance, reservation] = await Promise.all([
    db.stockBalance.aggregate({ where: { warehouseId, productId }, _sum: { quantity: true } }),
    db.stockReservation.aggregate({ where: { warehouseId, productId }, _sum: { quantity: true } }),
  ]);
  return { onHand: dec(balance._sum.quantity), reserved: dec(reservation._sum.quantity) };
}

export async function allowNegativeStock(db: Db, companyId: string) {
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { settings: true } });
  return companySettings(company.settings).inventory.allowNegativeStock;
}

// ─── Reservations ────────────────────────────────────────────────────────────

/**
 * Reserve open quantities of a confirmed sales order from its warehouse, as far as
 * stock is available. Idempotent: each line has one reservation row that is topped up
 * to (ordered − delivered), never past it, so retries cannot double-reserve.
 */
export async function reserveSalesOrder(tx: Db, orderId: string) {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: { include: { product: true, reservation: true } } },
  });
  const lines = order.lines.filter((l) => l.product && isStocked(l.product));
  if (lines.length === 0) return [];
  if (!order.warehouseId) throw new AppError("VALIDATION_ERROR", "Choose a warehouse for this order", 422);
  const warehouseId = order.warehouseId;
  await lockStock(tx, order.companyId, lines.map((l) => l.productId!));

  const result: { salesOrderLineId: string; reserved: string; short: string }[] = [];
  for (const line of lines) {
    const factor = await baseFactor(tx, line.product!, line.uomId);
    const open = dec(line.quantity).sub(line.deliveredQty).mul(factor);
    const current = dec(line.reservation?.quantity);
    let target = current.gt(open) ? open : current;
    if (target.lt(open)) {
      const { onHand, reserved } = await warehouseLevel(tx, warehouseId, line.productId!);
      const free = Decimal.max(onHand.sub(reserved), ZERO);
      target = Decimal.min(open, current.add(free));
    }
    if (!line.reservation || !target.eq(current)) {
      await tx.stockReservation.upsert({
        where: { organizationId_salesOrderLineId: { organizationId: order.organizationId, salesOrderLineId: line.id } },
        create: {
          organizationId: order.organizationId,
          companyId: order.companyId,
          warehouseId,
          productId: line.productId!,
          salesOrderLineId: line.id,
          quantity: target,
        },
        update: { quantity: target, warehouseId },
      });
    }
    result.push({ salesOrderLineId: line.id, reserved: target.toString(), short: open.sub(target).toString() });
  }
  return result;
}

export async function releaseSalesOrder(tx: Db, orderId: string) {
  await tx.stockReservation.deleteMany({ where: { salesOrderLine: { salesOrderId: orderId } } });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const levelsSchema = z.object({
  companyId: z.string().optional(),
  warehouseId: z.string().optional(),
  productId: z.string().optional(),
  lowOnly: z.enum(["true", "false"]).optional(),
});

/** On hand / reserved / available per warehouse and product, in the caller's companies. */
export async function getStockLevels(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "inventory.view");
  const q = levelsSchema.parse(query);
  if (q.companyId) assertCompanyAccess(ctx, q.companyId);
  const companyIds = q.companyId ? [q.companyId] : [...ctx.companies.keys()];
  const where = { organizationId: ctx.organizationId, companyId: { in: companyIds }, warehouseId: q.warehouseId, productId: q.productId };

  const [balances, reservations] = await Promise.all([
    prisma.stockBalance.groupBy({ by: ["warehouseId", "productId"], where, _sum: { quantity: true } }),
    prisma.stockReservation.groupBy({ by: ["warehouseId", "productId"], where, _sum: { quantity: true } }),
  ]);
  const key = (w: string, p: string) => `${w}:${p}`;
  const rows = new Map<string, { warehouseId: string; productId: string; onHand: Decimal; reserved: Decimal }>();
  for (const b of balances) rows.set(key(b.warehouseId, b.productId), { warehouseId: b.warehouseId, productId: b.productId, onHand: dec(b._sum.quantity), reserved: ZERO });
  for (const r of reservations) {
    const row = rows.get(key(r.warehouseId, r.productId)) ?? { warehouseId: r.warehouseId, productId: r.productId, onHand: ZERO, reserved: ZERO };
    row.reserved = dec(r._sum.quantity);
    rows.set(key(r.warehouseId, r.productId), row);
  }

  const [products, warehouses] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: ctx.organizationId, id: { in: [...new Set([...rows.values()].map((r) => r.productId))] } },
      select: { id: true, sku: true, name: true, reorderLevel: true, uom: { select: { code: true } } },
    }),
    prisma.warehouse.findMany({
      where: { organizationId: ctx.organizationId, id: { in: [...new Set([...rows.values()].map((r) => r.warehouseId))] } },
      select: { id: true, code: true, name: true, companyId: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
  return [...rows.values()]
    .map((r) => {
      const product = productById.get(r.productId)!;
      const available = r.onHand.sub(r.reserved);
      return {
        warehouse: warehouseById.get(r.warehouseId)!,
        product,
        onHand: r.onHand.toString(),
        reserved: r.reserved.toString(),
        available: available.toString(),
        low: product.reorderLevel !== null && available.lte(product.reorderLevel),
      };
    })
    .filter((r) => q.lowOnly !== "true" || r.low)
    .sort((a, b) => a.product.name.localeCompare(b.product.name) || a.warehouse.code.localeCompare(b.warehouse.code));
}

/**
 * Products whose company-wide available + incoming (open PO) quantity is at or below
 * their reorder level. Suggested quantity = reorderQty, or enough to reach the level.
 */
export async function getReorderSuggestions(ctx: Pick<AccessContext, "organizationId">, companyId: string) {
  const products = await prisma.product.findMany({
    where: { organizationId: ctx.organizationId, status: RecordStatus.ACTIVE, type: ProductType.GOODS, trackInventory: true, reorderLevel: { not: null } },
    include: { uom: { select: { code: true } } },
  });
  if (products.length === 0) return [];
  const ids = products.map((p) => p.id);
  const [balances, reservations, openLines] = await Promise.all([
    prisma.stockBalance.groupBy({ by: ["productId"], where: { companyId, productId: { in: ids } }, _sum: { quantity: true } }),
    prisma.stockReservation.groupBy({ by: ["productId"], where: { companyId, productId: { in: ids } }, _sum: { quantity: true } }),
    prisma.purchaseOrderLine.findMany({
      where: { productId: { in: ids }, purchaseOrder: { companyId, status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } },
      select: { productId: true, quantity: true, receivedQty: true, uomId: true, product: { select: { id: true, uomId: true, sku: true } } },
    }),
  ]);
  const incoming = new Map<string, Decimal>();
  for (const line of openLines) {
    const factor = await baseFactor(prisma as unknown as Db, line.product, line.uomId);
    const open = Decimal.max(dec(line.quantity).sub(line.receivedQty), ZERO).mul(factor);
    incoming.set(line.productId, (incoming.get(line.productId) ?? ZERO).add(open));
  }
  const sum = (rows: { productId: string; _sum: { quantity: Prisma.Decimal | null } }[], id: string) =>
    dec(rows.find((r) => r.productId === id)?._sum.quantity);

  return products
    .map((p) => {
      const available = sum(balances, p.id).sub(sum(reservations, p.id));
      const projected = available.add(incoming.get(p.id) ?? ZERO);
      const level = dec(p.reorderLevel);
      const suggested = projected.gt(level) ? ZERO : p.reorderQty ? dec(p.reorderQty) : level.sub(projected);
      return {
        product: { id: p.id, sku: p.sku, name: p.name, uom: p.uom.code, purchasePrice: p.purchasePrice.toString() },
        reorderLevel: level.toString(),
        available: available.toString(),
        incoming: (incoming.get(p.id) ?? ZERO).toString(),
        suggestedQuantity: suggested.toString(),
      };
    })
    .filter((s) => dec(s.suggestedQuantity).gt(0));
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Compare the cached balances and valuation with the ledger. With `fix`, rebuild the
 * caches from the ledger (the ledger is never modified).
 */
export async function reconcileStock(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "inventory.administer");
  assertCompanyAccess(ctx, companyId);
  const { fix } = z.object({ fix: z.boolean().default(false) }).parse(input ?? {});

  return prisma.$transaction(
    async (tx) => {
      const products = await tx.stockMove.findMany({ where: { companyId }, distinct: ["productId"], select: { productId: true } });
      await lockStock(tx, companyId, products.map((p) => p.productId));

      const ledger = await tx.stockMove.groupBy({
        by: ["warehouseId", "locationId", "productId", "lotId"],
        where: { companyId },
        _sum: { quantity: true },
      });
      const cached = await tx.stockBalance.findMany({ where: { companyId } });
      const balanceDiffs: { locationId: string; productId: string; lotId: string | null; ledger: string; cached: string }[] = [];
      const seen = new Set<string>();
      for (const row of ledger) {
        const k = `${row.locationId}:${row.productId}:${row.lotId ?? ""}`;
        seen.add(k);
        const cache = cached.find((c) => `${c.locationId}:${c.productId}:${c.lotKey}` === k);
        const expected = dec(row._sum.quantity);
        if (!cache || !dec(cache.quantity).eq(expected)) {
          balanceDiffs.push({ locationId: row.locationId, productId: row.productId, lotId: row.lotId, ledger: expected.toString(), cached: cache ? cache.quantity.toString() : "missing" });
          if (fix) {
            await tx.stockBalance.upsert({
              where: { locationId_productId_lotKey: { locationId: row.locationId, productId: row.productId, lotKey: row.lotId ?? "" } },
              create: { organizationId: ctx.organizationId, companyId, warehouseId: row.warehouseId, locationId: row.locationId, productId: row.productId, lotId: row.lotId, lotKey: row.lotId ?? "", quantity: expected },
              update: { quantity: expected },
            });
          }
        }
      }
      for (const cache of cached) {
        if (!seen.has(`${cache.locationId}:${cache.productId}:${cache.lotKey}`) && !dec(cache.quantity).isZero()) {
          balanceDiffs.push({ locationId: cache.locationId, productId: cache.productId, lotId: cache.lotId, ledger: "0", cached: cache.quantity.toString() });
          if (fix) await tx.stockBalance.update({ where: { id: cache.id }, data: { quantity: 0 } });
        }
      }

      const ledgerValue = await tx.stockMove.groupBy({ by: ["productId"], where: { companyId }, _sum: { quantity: true, value: true } });
      const valuations = await tx.stockValuation.findMany({ where: { companyId } });
      const valuationDiffs: { productId: string; ledgerQuantity: string; cachedQuantity: string; ledgerValue: string; cachedValue: string }[] = [];
      for (const row of ledgerValue) {
        const v = valuations.find((x) => x.productId === row.productId);
        const quantity = dec(row._sum.quantity);
        // A product that ran out has its rounding residue written off (value 0).
        const value = quantity.isZero() ? ZERO : dec(row._sum.value);
        if (!v || !dec(v.quantity).eq(quantity) || money(v.value).sub(value).abs().gt("0.05")) {
          valuationDiffs.push({
            productId: row.productId,
            ledgerQuantity: quantity.toString(),
            cachedQuantity: v ? v.quantity.toString() : "missing",
            ledgerValue: value.toFixed(2),
            cachedValue: v ? v.value.toString() : "missing",
          });
          if (fix && v) {
            await tx.stockValuation.update({
              where: { id: v.id },
              data: { quantity, value, averageCost: quantity.gt(0) ? value.div(quantity).toDecimalPlaces(4) : v.averageCost },
            });
          }
        }
      }

      const result = { companyId, balanceDiffs, valuationDiffs, fixed: fix && (balanceDiffs.length > 0 || valuationDiffs.length > 0) };
      if (result.fixed) {
        await audit(tx, ctx, { action: "stock.reconciled", entity: "company", entityId: companyId, companyId, next: result });
      }
      return result;
    },
    { timeout: 60_000 },
  );
}
