import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { dec, Decimal, zDecimal } from "@/lib/money";
import { isStocked } from "@/features/inventory/stock";

type Db = Prisma.TransactionClient;

/**
 * Bills of materials. A BOM is a numbered version per product: DRAFT (editable) → ACTIVE
 * (one per product; its lines are frozen) → ARCHIVED. Changing an active BOM means copying
 * it into a new DRAFT version and activating that, which archives the old one. Quantities
 * are in each product's base unit; `outputQuantity` units of the product need the lines.
 */

export const positive = (places: number) => zDecimal({ places }).refine((q) => q.gt(0), "Must be greater than zero");

const lineSchema = z.object({
  componentId: z.string().min(1),
  quantity: positive(4),
  scrapPercent: zDecimal({ max: 99.99, places: 2 }).optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

// Blank rows of a fixed-row form (no component chosen) are dropped.
const linesSchema = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((l) => l && typeof l === "object" && "componentId" in l && l.componentId) : v),
  z
    .array(lineSchema)
    .min(1, "Add at least one component")
    .max(500)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        if (seen.has(l.componentId)) ctx.addIssue({ code: "custom", path: [i, "componentId"], message: "Component is listed twice" });
        seen.add(l.componentId);
      });
    }),
);

const createSchema = z.object({
  productId: z.string().min(1),
  outputQuantity: positive(4).optional(),
  notes: z.string().trim().max(4000).nullish(),
  lines: linesSchema,
});
const updateSchema = createSchema.omit({ productId: true }).partial();

const listSchema = listQuerySchema.extend({
  productId: z.string().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});

const bomInclude = {
  product: { select: { id: true, sku: true, name: true, uom: { select: { code: true } } } },
  lines: {
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    include: { component: { select: { id: true, sku: true, name: true, uom: { select: { code: true } } } } },
  },
} satisfies Prisma.BomInclude;

/** Component quantity for `quantity` units of output, scrap included, rounded up to 4 dp. */
export function componentRequirement(
  line: { quantity: Prisma.Decimal.Value; scrapPercent: Prisma.Decimal.Value },
  quantity: Prisma.Decimal.Value,
  outputQuantity: Prisma.Decimal.Value,
) {
  return dec(line.quantity)
    .mul(quantity)
    .div(outputQuantity)
    .mul(dec(line.scrapPercent).div(100).add(1))
    .toDecimalPlaces(4, Decimal.ROUND_UP);
}

export async function activeBom(db: Db, organizationId: string, productId: string) {
  return db.bom.findFirst({ where: { organizationId, productId, status: "ACTIVE" }, include: { lines: true } });
}

async function lockProduct(tx: Db, ctx: AccessContext, productId: string) {
  await tx.$queryRaw`SELECT 1 FROM "products" WHERE "id" = ${productId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const product = await tx.product.findFirst({ where: { id: productId, organizationId: ctx.organizationId } });
  if (!product) throw new AppError("INVALID_REFERENCE", "Product not found", 422);
  if (!isStocked(product)) throw new AppError("VALIDATION_ERROR", `${product.sku} does not track stock, so it cannot be manufactured`, 422);
  return product;
}

async function checkComponents(tx: Db, ctx: AccessContext, productId: string, componentIds: string[]) {
  if (componentIds.includes(productId)) throw new AppError("VALIDATION_ERROR", "A product cannot be a component of itself", 422);
  const components = await tx.product.findMany({ where: { organizationId: ctx.organizationId, id: { in: componentIds } } });
  for (const id of componentIds) {
    const c = components.find((p) => p.id === id);
    if (!c) throw new AppError("INVALID_REFERENCE", "Component not found", 422);
    if (!isStocked(c)) throw new AppError("VALIDATION_ERROR", `${c.sku} does not track stock`, 422);
  }
}

/** Throws CYCLE when making any of `componentIds` (through active BOMs) would need `productId`. */
export async function assertNoCycle(db: Db, organizationId: string, productId: string, componentIds: string[]) {
  const visited = new Set<string>();
  const stack = [...componentIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === productId) throw new AppError("CYCLE", "These components already use this product (circular bill of materials)", 422);
    if (visited.has(id)) continue;
    visited.add(id);
    const bom = await activeBom(db, organizationId, id);
    for (const l of bom?.lines ?? []) stack.push(l.componentId);
  }
}

// Nested under the BOM: organizationId comes from the parent (it is part of the composite FK).
const lineRows = (lines: z.infer<typeof lineSchema>[]) =>
  lines.map((l, i) => ({ componentId: l.componentId, quantity: l.quantity, scrapPercent: l.scrapPercent ?? 0, sortOrder: l.sortOrder ?? i }));

async function nextVersion(tx: Db, productId: string) {
  const last = await tx.bom.aggregate({ where: { productId }, _max: { version: true } });
  return (last._max.version ?? 0) + 1;
}

export async function createBom(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "manufacturing.create");
  const data = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockProduct(tx, ctx, data.productId);
    await checkComponents(tx, ctx, data.productId, data.lines.map((l) => l.componentId));
    const bom = await tx.bom.create({
      data: {
        organizationId: ctx.organizationId,
        productId: data.productId,
        version: await nextVersion(tx, data.productId),
        outputQuantity: data.outputQuantity ?? 1,
        notes: data.notes ?? null,
        lines: { create: lineRows(data.lines) },
      },
      include: bomInclude,
    });
    await audit(tx, ctx, { action: "bom.created", entity: "bom", entityId: bom.id, next: bom });
    return bom;
  });
}

async function lockBom(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "boms" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const bom = await tx.bom.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!bom) throw new AppError("NOT_FOUND", "Bill of materials not found", 404);
  return bom;
}

/** Drafts only: an active BOM's lines are frozen (copy it into a new version instead). */
export async function updateBom(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "manufacturing.create");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockBom(tx, ctx, id);
    if (before.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft versions can be edited; copy this version instead", 422);
    if (data.lines) {
      await checkComponents(tx, ctx, before.productId, data.lines.map((l) => l.componentId));
      await tx.bomLine.deleteMany({ where: { bomId: id } });
    }
    const bom = await tx.bom.update({
      where: { id },
      data: {
        outputQuantity: data.outputQuantity,
        notes: data.notes,
        ...(data.lines ? { lines: { create: lineRows(data.lines) } } : {}),
      },
      include: bomInclude,
    });
    await audit(tx, ctx, {
      action: "bom.updated",
      entity: "bom",
      entityId: id,
      previous: { outputQuantity: before.outputQuantity, lines: before.lines.length },
      next: { outputQuantity: bom.outputQuantity, lines: bom.lines.length },
    });
    return bom;
  });
}

export const BOM_ACTIONS = ["activate", "archive", "copy"] as const;
export type BomAction = (typeof BOM_ACTIONS)[number];

/**
 * activate: DRAFT → ACTIVE (the product's previous ACTIVE version is archived; circular
 * structures are refused). archive: DRAFT|ACTIVE → ARCHIVED. copy: any → new DRAFT version.
 */
export async function transitionBom(ctx: AccessContext, id: string, action: BomAction) {
  if (!BOM_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "manufacturing.create");
  return prisma.$transaction(async (tx) => {
    const found = await tx.bom.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { productId: true } });
    if (!found) throw new AppError("NOT_FOUND", "Bill of materials not found", 404);
    // Product first, then BOM: every version change for a product queues on the product row.
    await lockProduct(tx, ctx, found.productId);
    const bom = await lockBom(tx, ctx, id);

    if (action === "copy") {
      const copy = await tx.bom.create({
        data: {
          organizationId: ctx.organizationId,
          productId: bom.productId,
          version: await nextVersion(tx, bom.productId),
          outputQuantity: bom.outputQuantity,
          notes: bom.notes,
          lines: { create: bom.lines.map((l) => ({ componentId: l.componentId, quantity: l.quantity, scrapPercent: l.scrapPercent, sortOrder: l.sortOrder })) },
        },
        include: bomInclude,
      });
      await audit(tx, ctx, { action: "bom.copied", entity: "bom", entityId: copy.id, next: { copiedFrom: id, version: copy.version } });
      return copy;
    }

    if (action === "activate") {
      if (bom.status !== "DRAFT") throw new AppError("INVALID_STATE", `Cannot activate a ${bom.status} version`, 422);
      await assertNoCycle(tx, ctx.organizationId, bom.productId, bom.lines.map((l) => l.componentId));
      await tx.bom.updateMany({ where: { productId: bom.productId, status: "ACTIVE" }, data: { status: "ARCHIVED" } });
    } else if (bom.status === "ARCHIVED") {
      throw new AppError("INVALID_STATE", "This version is already archived", 422);
    }
    const status = action === "activate" ? "ACTIVE" : "ARCHIVED";
    const updated = await tx.bom.update({ where: { id }, data: { status }, include: bomInclude });
    await audit(tx, ctx, { action: `bom.${action}`, entity: "bom", entityId: id, previous: { status: bom.status }, next: { status } });
    return updated;
  });
}

export async function listBoms(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "manufacturing.view");
  const q = listSchema.parse(query);
  const where: Prisma.BomWhereInput = {
    organizationId: ctx.organizationId,
    productId: q.productId,
    status: q.status,
    ...(q.q ? { product: searchWhere(q.q, ["name", "sku"]) } : {}),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.bom.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true } }, _count: { select: { lines: true, workOrders: true } } },
        ...listArgs(q, ["createdAt", "version"], "createdAt"),
      }),
      prisma.bom.count({ where }),
    ]),
  );
}

export async function getBom(ctx: AccessContext, id: string) {
  assertCan(ctx, "manufacturing.view");
  const bom = await prisma.bom.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { ...bomInclude, _count: { select: { workOrders: true } } } });
  if (!bom) throw new AppError("NOT_FOUND", "Bill of materials not found", 404);
  return bom;
}
