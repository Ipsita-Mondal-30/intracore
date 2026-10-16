import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { dec, Decimal } from "@/lib/money";
import { activeBom, componentRequirement, positive } from "@/features/manufacturing/boms";
import { assertFullCompany } from "@/features/manufacturing/scope";

type Db = Prisma.TransactionClient;
const ZERO = new Decimal(0);
const MAX_LEVELS = 25;

/**
 * Material requirements, base units throughout. available = on hand − reserved (all
 * reservations), in the warehouse when given, otherwise company-wide.
 *
 * With productId + quantity: multi-level BOM explosion through ACTIVE BOMs. Each
 * requirement is netted against what is still available (shared across the tree); a
 * shortage of a component that has its own active BOM is exploded further (MAKE), the
 * rest must be bought (BUY). Circular structures fail with 422 CYCLE.
 *
 * Without productId: open requirements of DRAFT / RELEASED / IN_PROGRESS work orders,
 * shortage = open − reserved for those orders − free stock.
 */
const querySchema = z
  .object({
    companyId: z.string().min(1),
    warehouseId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    quantity: positive(4).optional(),
  })
  .refine((q) => !q.productId || q.quantity, { path: ["quantity"], message: "Quantity is required with a product" });

export async function materialRequirements(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "manufacturing.view");
  const q = querySchema.parse(query);
  assertFullCompany(ctx, q.companyId);
  if (q.warehouseId) {
    const wh = await prisma.warehouse.findFirst({ where: { id: q.warehouseId, organizationId: ctx.organizationId, companyId: q.companyId }, select: { id: true } });
    if (!wh) throw new AppError("NOT_FOUND", "Warehouse not found in this company", 404);
  }
  const scope = { organizationId: ctx.organizationId, companyId: q.companyId, warehouseId: q.warehouseId };
  return q.productId ? explode(ctx, scope, q.productId, q.quantity!) : openWorkOrderShortages(scope);
}

async function freeStock(scope: { companyId: string; warehouseId?: string }, productIds: string[]) {
  const where = { companyId: scope.companyId, warehouseId: scope.warehouseId, productId: { in: productIds } };
  const [balances, reservations] = await Promise.all([
    prisma.stockBalance.groupBy({ by: ["productId"], where, _sum: { quantity: true } }),
    prisma.stockReservation.groupBy({ by: ["productId"], where, _sum: { quantity: true } }),
  ]);
  return new Map(
    productIds.map((id) => {
      const onHand = dec(balances.find((b) => b.productId === id)?._sum.quantity);
      const reserved = dec(reservations.find((r) => r.productId === id)?._sum.quantity);
      return [id, { onHand, reserved }];
    }),
  );
}

type Row = { productId: string; level: number; required: Decimal; covered: Decimal; shortage: Decimal; onHand: Decimal; reserved: Decimal; make: boolean };

async function explode(ctx: AccessContext, scope: { organizationId: string; companyId: string; warehouseId?: string }, productId: string, quantity: Decimal) {
  const db = prisma as unknown as Db;
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId: ctx.organizationId }, select: { id: true, sku: true, name: true } });
  if (!product) throw new AppError("INVALID_REFERENCE", "Product not found", 422);
  const top = await activeBom(db, ctx.organizationId, productId);
  if (!top) throw new AppError("NO_BOM", `${product.sku} has no active bill of materials`, 422);

  const boms = new Map<string, Awaited<ReturnType<typeof activeBom>>>([[productId, top]]);
  const bomOf = async (id: string) => {
    if (!boms.has(id)) boms.set(id, await activeBom(db, ctx.organizationId, id));
    return boms.get(id)!;
  };
  const rows = new Map<string, Row>();
  const free = new Map<string, Decimal>();

  // ponytail: one query per BOM node; batch per level if trees get large.
  const need = async (id: string, qty: Decimal, level: number, path: string[]) => {
    if (path.includes(id)) throw new AppError("CYCLE", "Circular bill of materials", 422, { path: [...path, id] });
    if (level > MAX_LEVELS) throw new AppError("CYCLE", `Bill of materials is deeper than ${MAX_LEVELS} levels`, 422);
    let row = rows.get(id);
    if (!row) {
      const { onHand, reserved } = (await freeStock(scope, [id])).get(id)!;
      free.set(id, Decimal.max(onHand.sub(reserved), ZERO));
      row = { productId: id, level, required: ZERO, covered: ZERO, shortage: ZERO, onHand, reserved, make: false };
      rows.set(id, row);
    }
    row.level = Math.min(row.level, level);
    const take = Decimal.min(free.get(id)!, qty);
    free.set(id, free.get(id)!.sub(take));
    row.required = row.required.add(qty);
    row.covered = row.covered.add(take);
    const short = qty.sub(take);
    row.shortage = row.shortage.add(short);
    const bom = await bomOf(id);
    row.make = Boolean(bom);
    if (bom && short.gt(0)) {
      for (const l of bom.lines) await need(l.componentId, componentRequirement(l, short, bom.outputQuantity), level + 1, [...path, id]);
    }
  };
  for (const l of top.lines) await need(l.componentId, componentRequirement(l, quantity, top.outputQuantity), 1, [productId]);

  const products = await prisma.product.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...rows.keys()] } },
    select: { id: true, sku: true, name: true, uom: { select: { code: true } } },
  });
  return {
    mode: "explosion" as const,
    product,
    quantity: quantity.toString(),
    bom: { id: top.id, version: top.version },
    lines: [...rows.values()]
      .map((r) => ({
        product: products.find((p) => p.id === r.productId)!,
        level: r.level,
        source: r.make ? "MAKE" : "BUY",
        required: r.required.toString(),
        onHand: r.onHand.toString(),
        reserved: r.reserved.toString(),
        available: Decimal.max(r.onHand.sub(r.reserved), ZERO).toString(),
        covered: r.covered.toString(),
        shortage: r.shortage.toString(),
      }))
      .sort((a, b) => a.level - b.level || a.product.sku.localeCompare(b.product.sku)),
  };
}

async function openWorkOrderShortages(scope: { organizationId: string; companyId: string; warehouseId?: string }) {
  const materials = await prisma.workOrderMaterial.findMany({
    where: { workOrder: { organizationId: scope.organizationId, companyId: scope.companyId, warehouseId: scope.warehouseId, status: { in: ["DRAFT", "RELEASED", "IN_PROGRESS"] } } },
    include: {
      reservation: { select: { quantity: true } },
      workOrder: { select: { id: true, number: true, warehouseId: true, warehouse: { select: { code: true } } } },
      product: { select: { id: true, sku: true, name: true, uom: { select: { code: true } } } },
    },
  });
  const groups = new Map<string, { warehouseId: string; warehouse: string; product: (typeof materials)[number]["product"]; open: Decimal; reservedForOrders: Decimal; workOrders: { id: string; number: string }[] }>();
  for (const m of materials) {
    const open = Decimal.max(dec(m.requiredQty).sub(m.consumedQty), ZERO);
    if (open.isZero()) continue;
    const key = `${m.workOrder.warehouseId}:${m.productId}`;
    const g = groups.get(key) ?? { warehouseId: m.workOrder.warehouseId, warehouse: m.workOrder.warehouse.code, product: m.product, open: ZERO, reservedForOrders: ZERO, workOrders: [] };
    g.open = g.open.add(open);
    g.reservedForOrders = g.reservedForOrders.add(dec(m.reservation?.quantity));
    g.workOrders.push({ id: m.workOrder.id, number: m.workOrder.number });
    groups.set(key, g);
  }
  const lines = await Promise.all(
    [...groups.values()].map(async (g) => {
      const { onHand, reserved } = (await freeStock({ companyId: scope.companyId, warehouseId: g.warehouseId }, [g.product.id])).get(g.product.id)!;
      const free = Decimal.max(onHand.sub(reserved), ZERO);
      return {
        warehouse: { id: g.warehouseId, code: g.warehouse },
        product: g.product,
        openRequirement: g.open.toString(),
        reservedForWorkOrders: g.reservedForOrders.toString(),
        onHand: onHand.toString(),
        available: free.toString(),
        shortage: Decimal.max(g.open.sub(g.reservedForOrders).sub(free), ZERO).toString(),
        workOrders: g.workOrders,
      };
    }),
  );
  return { mode: "open" as const, lines: lines.sort((a, b) => dec(b.shortage).cmp(a.shortage) || a.product.sku.localeCompare(b.product.sku)) };
}
