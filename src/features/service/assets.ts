import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";
import { assertActiveMember } from "@/lib/tenant/refs";

/**
 * Asset register (COMPANY-owned) and customer installed base (CUSTOMER-owned), with
 * warranties. Assignment and location changes are kept in the audit trail.
 * Lifecycle: IN_STOCK ⇄ IN_USE ⇄ UNDER_REPAIR → RETIRED → DISPOSED.
 */

export const ASSET_STATUSES = ["IN_STOCK", "IN_USE", "UNDER_REPAIR", "RETIRED", "DISPOSED"] as const;
type AssetStatus = (typeof ASSET_STATUSES)[number];

/** action → target status, and the statuses it may leave from. */
const TRANSITIONS: Record<string, { to: AssetStatus; from: AssetStatus[] }> = {
  "in-use": { to: "IN_USE", from: ["IN_STOCK", "UNDER_REPAIR"] },
  "in-stock": { to: "IN_STOCK", from: ["IN_USE", "UNDER_REPAIR"] },
  repair: { to: "UNDER_REPAIR", from: ["IN_STOCK", "IN_USE"] },
  retire: { to: "RETIRED", from: ["IN_STOCK", "IN_USE", "UNDER_REPAIR"] },
  dispose: { to: "DISPOSED", from: ["RETIRED"] },
};
export type AssetAction = keyof typeof TRANSITIONS;
export const ASSET_ACTIONS = Object.keys(TRANSITIONS);

const date = z.coerce.date();
const coord = (max: number) => zDecimal({ min: -max, max, places: 6 }).nullish();

const assetFields = z.object({
  name: z.string().trim().min(1).max(200),
  ownership: z.enum(["COMPANY", "CUSTOMER"]).default("COMPANY"),
  customerId: z.string().min(1).nullish(),
  productId: z.string().min(1).nullish(),
  serialNumber: z.string().trim().min(1).max(120).nullish(),
  location: z.string().trim().max(500).nullish(),
  latitude: coord(90),
  longitude: coord(180),
  assignedToId: z.string().uuid().nullish(),
  purchaseDate: date.nullish(),
  installDate: date.nullish(),
  value: zDecimal().nullish(),
});

const createSchema = assetFields.extend({
  companyId: z.string().min(1),
  tag: z.string().trim().min(1).max(60),
  status: z.enum(["IN_STOCK", "IN_USE"]).default("IN_USE"),
});
const updateSchema = assetFields.partial();

const include = {
  customer: { select: { id: true, name: true } },
  product: { select: { id: true, sku: true, name: true } },
  warranties: { orderBy: { endDate: "desc" } },
} satisfies Prisma.AssetInclude;

export const assetScope = (ctx: AccessContext) => ({
  organizationId: ctx.organizationId,
  companyId: { in: [...ctx.companies.keys()] },
});

/** Asset in the caller's companies, or 404. */
export async function findAsset(db: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  const asset = await db.asset.findFirst({ where: { id, ...assetScope(ctx) } });
  if (!asset) throw new AppError("NOT_FOUND", "Asset not found", 404);
  return asset;
}

async function lockAsset(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  return findAsset(tx, ctx, id);
}

/** Customer/product/assignee must be in the tenant; serial is unique per product. */
async function validateRefs(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  a: { id?: string; ownership: string; customerId: string | null; productId: string | null; serialNumber: string | null; assignedToId: string | null },
) {
  if (a.ownership === "CUSTOMER" && !a.customerId) throw new AppError("VALIDATION_ERROR", "Customer-owned assets need a customer", 422);
  if (a.customerId && !(await tx.customer.findFirst({ where: { id: a.customerId, organizationId: ctx.organizationId }, select: { id: true } }))) {
    throw new AppError("INVALID_REFERENCE", "Customer not found", 422);
  }
  if (a.productId && !(await tx.product.findFirst({ where: { id: a.productId, organizationId: ctx.organizationId }, select: { id: true } }))) {
    throw new AppError("INVALID_REFERENCE", "Product not found", 422);
  }
  if (a.assignedToId) await assertActiveMember(ctx.organizationId, a.assignedToId);
  if (a.productId && a.serialNumber) {
    // ponytail: app-level uniqueness under an advisory lock; a partial unique index on
    // (organizationId, productId, serialNumber) would let the database enforce it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`serial:${ctx.organizationId}:${a.productId}:${a.serialNumber}`}, 0))`;
    const dup = await tx.asset.findFirst({
      where: { organizationId: ctx.organizationId, productId: a.productId, serialNumber: a.serialNumber, id: a.id ? { not: a.id } : undefined },
      select: { tag: true },
    });
    if (dup) throw new AppError("CONFLICT", `Serial number ${a.serialNumber} is already registered (asset ${dup.tag})`, 409);
  }
}

export async function createAsset(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "asset.create");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    const refs = {
      ownership: data.ownership,
      customerId: data.customerId ?? null,
      productId: data.productId ?? null,
      serialNumber: data.serialNumber ?? null,
      assignedToId: data.assignedToId ?? null,
    };
    await validateRefs(tx, ctx, refs);
    const asset = await tx.asset.create({ data: { ...data, ...refs, organizationId: ctx.organizationId }, include });
    await audit(tx, ctx, { action: "asset.created", entity: "asset", entityId: asset.id, companyId: asset.companyId, next: asset });
    return asset;
  });
}

export async function updateAsset(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "asset.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockAsset(tx, ctx, id);
    if (before.status === "DISPOSED") throw new AppError("INVALID_STATE", "Disposed assets cannot be edited", 422);
    const m = { ...before, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) } as typeof before;
    await validateRefs(tx, ctx, { id, ownership: m.ownership, customerId: m.customerId, productId: m.productId, serialNumber: m.serialNumber, assignedToId: m.assignedToId });
    const updated = await tx.asset.update({ where: { id }, data, include });
    // Assignment and location history lives in these audit rows.
    const diff = changes(before as Record<string, unknown>, data as Record<string, unknown>);
    if (diff.changed) await audit(tx, ctx, { action: "asset.updated", entity: "asset", entityId: id, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return updated;
  });
}

export async function transitionAsset(ctx: AccessContext, id: string, action: string, input: unknown) {
  const t = TRANSITIONS[action];
  if (!t) throw new AppError("NOT_FOUND", "Unknown asset action", 404);
  assertCan(ctx, "asset.update");
  const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const asset = await lockAsset(tx, ctx, id);
    if (!t.from.includes(asset.status as AssetStatus)) throw new AppError("INVALID_STATE", `Cannot move a ${asset.status} asset to ${t.to}`, 422);
    const updated = await tx.asset.update({ where: { id }, data: { status: t.to }, include });
    await audit(tx, ctx, { action: `asset.${action}`, entity: "asset", entityId: id, companyId: asset.companyId, previous: { status: asset.status }, next: { status: t.to, note } });
    return updated;
  });
}

export async function listAssets(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "asset.view");
  const q = listQuerySchema
    .extend({ status: z.enum(ASSET_STATUSES).optional(), customerId: z.string().optional(), ownership: z.enum(["COMPANY", "CUSTOMER"]).optional(), assignedToId: z.string().optional() })
    .parse(query);
  const where: Prisma.AssetWhereInput = {
    ...assetScope(ctx),
    status: q.status,
    customerId: q.customerId,
    ownership: q.ownership,
    assignedToId: q.assignedToId,
    ...searchWhere(q.q, ["tag", "name", "serialNumber", "location"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.asset.findMany({ where, include: { customer: { select: { id: true, name: true } }, product: { select: { id: true, sku: true, name: true } } }, ...listArgs(q, ["createdAt", "tag", "name"], "createdAt") }),
      prisma.asset.count({ where }),
    ]),
  );
}

export async function getAsset(ctx: AccessContext, id: string) {
  assertCan(ctx, "asset.view");
  const asset = await prisma.asset.findFirst({
    where: { id, ...assetScope(ctx) },
    include: { ...include, contracts: { include: { contract: { select: { id: true, number: true, status: true, startDate: true, endDate: true } } } } },
  });
  if (!asset) throw new AppError("NOT_FOUND", "Asset not found", 404);
  return asset;
}

// ─── Warranties ──────────────────────────────────────────────────────────────

const warrantyFields = z.object({
  type: z.enum(["STANDARD", "EXTENDED"]).default("STANDARD"),
  startDate: date,
  endDate: date,
  coversParts: z.boolean().default(true),
  coversLabor: z.boolean().default(true),
  terms: z.string().trim().max(5000).nullish(),
});
const warrantyCreate = warrantyFields.extend({ assetId: z.string().min(1) }).refine((w) => w.endDate >= w.startDate, { message: "End date must be on or after the start date", path: ["endDate"] });

export async function createWarranty(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "asset.update");
  const data = warrantyCreate.parse(input);
  return prisma.$transaction(async (tx) => {
    const asset = await lockAsset(tx, ctx, data.assetId);
    const warranty = await tx.warranty.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "warranty.created", entity: "asset", entityId: asset.id, companyId: asset.companyId, next: warranty });
    return warranty;
  });
}

export async function updateWarranty(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "asset.update");
  const data = warrantyFields.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "warranties" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const before = await tx.warranty.findFirst({ where: { id, asset: assetScope(ctx) }, include: { asset: { select: { companyId: true } } } });
    if (!before) throw new AppError("NOT_FOUND", "Warranty not found", 404);
    if ((data.endDate ?? before.endDate) < (data.startDate ?? before.startDate)) throw new AppError("VALIDATION_ERROR", "End date must be on or after the start date", 422);
    // A moved end date gets a fresh expiry reminder.
    const updated = await tx.warranty.update({ where: { id }, data: { ...data, remindedAt: data.endDate ? null : undefined } });
    const { asset, ...prev } = before;
    const diff = changes(prev as Record<string, unknown>, data as Record<string, unknown>);
    await audit(tx, ctx, { action: "warranty.updated", entity: "asset", entityId: before.assetId, companyId: asset.companyId, previous: diff.previous, next: { warrantyId: id, ...diff.next } });
    return updated;
  });
}

export async function listWarranties(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "asset.view");
  const q = listQuerySchema.extend({ assetId: z.string().optional(), expiringBefore: date.optional() }).parse(query);
  const where: Prisma.WarrantyWhereInput = { organizationId: ctx.organizationId, asset: assetScope(ctx), assetId: q.assetId, endDate: q.expiringBefore ? { lte: q.expiringBefore } : undefined };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.warranty.findMany({ where, include: { asset: { select: { id: true, tag: true, name: true, serialNumber: true } } }, ...listArgs(q, ["createdAt", "endDate", "startDate"], "endDate") }),
      prisma.warranty.count({ where }),
    ]),
  );
}

export async function getWarranty(ctx: AccessContext, id: string) {
  assertCan(ctx, "asset.view");
  const w = await prisma.warranty.findFirst({ where: { id, organizationId: ctx.organizationId, asset: assetScope(ctx) }, include: { asset: { select: { id: true, tag: true, name: true } } } });
  if (!w) throw new AppError("NOT_FOUND", "Warranty not found", 404);
  return w;
}
