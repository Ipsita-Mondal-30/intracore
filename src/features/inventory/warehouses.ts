import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";

const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase());

/** Default warehouse + stock location for a new company (inside its transaction). */
export async function seedDefaultWarehouse(tx: Prisma.TransactionClient, company: { id: string; organizationId: string }) {
  const warehouse = await tx.warehouse.create({
    data: { organizationId: company.organizationId, companyId: company.id, code: "MAIN", name: "Main warehouse" },
  });
  await tx.storageLocation.create({
    data: { organizationId: company.organizationId, companyId: company.id, warehouseId: warehouse.id, code: "STOCK", name: "Stock", isDefault: true },
  });
  return warehouse;
}

/**
 * Warehouse a branch ships from by default: the branch's own active warehouse, else
 * the company's only active warehouse (null when it is ambiguous — the user chooses).
 */
export async function defaultWarehouseId(tx: Prisma.TransactionClient, organizationId: string, companyId: string, branchId: string) {
  const active = await tx.warehouse.findMany({
    where: { organizationId, companyId, isActive: true },
    select: { id: true, branchId: true },
    orderBy: { createdAt: "asc" },
  });
  return active.find((w) => w.branchId === branchId)?.id ?? (active.length === 1 ? active[0].id : null);
}

/** Warehouses are managed by members with access to the whole company. */
function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

export async function listWarehouses(ctx: AccessContext, companyId?: string) {
  assertCan(ctx, "inventory.view");
  const companyIds = companyId ? [companyId].filter((id) => ctx.companies.has(id)) : [...ctx.companies.keys()];
  return prisma.warehouse.findMany({
    where: { organizationId: ctx.organizationId, companyId: { in: companyIds } },
    include: {
      company: { select: { code: true, name: true } },
      branch: { select: { code: true, name: true } },
      locations: { orderBy: [{ isDefault: "desc" }, { code: "asc" }] },
    },
    orderBy: [{ companyId: "asc" }, { code: "asc" }],
  });
}

const warehouseSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1).nullish(),
  code,
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).nullish(),
});

export async function createWarehouse(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "inventory.administer");
  const data = warehouseSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.create({ data: { ...data, organizationId: ctx.organizationId } });
    await tx.storageLocation.create({
      data: { organizationId: ctx.organizationId, companyId: data.companyId, warehouseId: warehouse.id, code: "STOCK", name: "Stock", isDefault: true },
    });
    await audit(tx, ctx, { action: "warehouse.created", entity: "warehouse", entityId: warehouse.id, companyId: data.companyId, next: warehouse });
    return warehouse;
  });
}

export async function updateWarehouse(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "inventory.administer");
  const data = warehouseSchema
    .pick({ name: true, address: true, branchId: true })
    .partial()
    .extend({ isActive: z.boolean().optional() })
    .parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.warehouse.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Warehouse not found", 404);
    assertFullCompany(ctx, before.companyId);
    if (data.isActive === false) {
      const stock = await tx.stockBalance.aggregate({ where: { warehouseId: id, quantity: { not: 0 } }, _count: true });
      if (stock._count > 0) throw new AppError("INVALID_STATE", "Move or adjust the stock out of this warehouse before deactivating it", 422);
    }
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const warehouse = await tx.warehouse.update({ where: { id }, data });
    await audit(tx, ctx, { action: "warehouse.updated", entity: "warehouse", entityId: id, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return warehouse;
  });
}

const locationSchema = z.object({ code, name: z.string().trim().min(1).max(120), isDefault: z.boolean().optional() });

export async function createLocation(ctx: AccessContext, warehouseId: string, input: unknown) {
  assertCan(ctx, "inventory.administer");
  const data = locationSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, organizationId: ctx.organizationId } });
    if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found", 404);
    assertFullCompany(ctx, warehouse.companyId);
    if (data.isDefault) await tx.storageLocation.updateMany({ where: { warehouseId }, data: { isDefault: false } });
    const location = await tx.storageLocation.create({
      data: { ...data, organizationId: ctx.organizationId, companyId: warehouse.companyId, warehouseId },
    });
    await audit(tx, ctx, { action: "location.created", entity: "warehouse", entityId: warehouseId, companyId: warehouse.companyId, next: location });
    return location;
  });
}
