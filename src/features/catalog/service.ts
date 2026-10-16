import { z } from "zod";
import { ProductType, RecordStatus, TrackingMode, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";

const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullish().or(z.literal("").transform(() => null));

// ─── Products ────────────────────────────────────────────────────────────────

const productSchema = z.object({
  sku: text(64).min(1),
  barcode: nullableText(64),
  name: text(200).min(1),
  description: nullableText(2000),
  type: z.nativeEnum(ProductType).default(ProductType.GOODS),
  categoryId: z.string().min(1).nullish(),
  uomId: z.string().min(1),
  hsnCode: nullableText(16),
  taxRateId: z.string().min(1).nullish(),
  salesPrice: zDecimal().default("0"),
  purchasePrice: zDecimal().default("0"),
  trackInventory: z.boolean().optional(),
  trackingMode: z.nativeEnum(TrackingMode).optional(),
  hasExpiry: z.boolean().optional(),
  reorderLevel: zDecimal({ places: 4 }).nullish(),
  reorderQty: zDecimal({ places: 4 }).nullish(),
});

const productUpdateSchema = productSchema
  .partial()
  .extend({ status: z.nativeEnum(RecordStatus).optional() });

const productListSchema = listQuerySchema.extend({
  status: z.nativeEnum(RecordStatus).optional(),
  type: z.nativeEnum(ProductType).optional(),
  categoryId: z.string().optional(),
});

const productInclude = {
  uom: { select: { id: true, code: true } },
  taxRate: { select: { id: true, name: true, rate: true } },
  category: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

export async function listProducts(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "product.view");
  const q = productListSchema.parse(query);
  const where: Prisma.ProductWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status ?? { not: RecordStatus.ARCHIVED },
    type: q.type,
    categoryId: q.categoryId,
    ...searchWhere(q.q, ["name", "sku", "barcode", "hsnCode"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.product.findMany({ where, include: productInclude, ...listArgs(q, ["createdAt", "name", "sku", "salesPrice"], "name") }),
      prisma.product.count({ where }),
    ]),
  );
}

export async function getProduct(ctx: AccessContext, id: string) {
  assertCan(ctx, "product.view");
  const product = await prisma.product.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: productInclude,
  });
  if (!product) throw new AppError("NOT_FOUND", "Product not found", 404);
  return product;
}

export async function createProduct(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "product.create");
  const data = productSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...data,
        // Services never hold stock; goods track it unless told otherwise.
        trackInventory: data.type === ProductType.GOODS && (data.trackInventory ?? true),
        organizationId: ctx.organizationId,
        createdById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "product.created", entity: "product", entityId: product.id, next: product });
    return product;
  });
}

export async function updateProduct(ctx: AccessContext, id: string, input: unknown) {
  const data = productUpdateSchema.parse(input);
  assertCan(ctx, data.status === RecordStatus.ARCHIVED ? "product.delete" : "product.update");
  return prisma.$transaction(async (tx) => {
    const before = await tx.product.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Product not found", 404);
    await assertStockSafeChange(tx, before, data);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const product = await tx.product.update({ where: { id }, data });
    await audit(tx, ctx, {
      action: data.status === RecordStatus.ARCHIVED ? "product.archived" : "product.updated",
      entity: "product",
      entityId: id,
      previous: diff.previous,
      next: diff.next,
    });
    return product;
  });
}

// ─── Units, categories, tax rates ────────────────────────────────────────────

export async function listCatalogLookups(ctx: AccessContext) {
  assertCan(ctx, "product.view");
  const where = { organizationId: ctx.organizationId };
  const [uoms, categories, taxRates] = await prisma.$transaction([
    prisma.uom.findMany({ where, orderBy: { code: "asc" } }),
    prisma.productCategory.findMany({ where, orderBy: { name: "asc" } }),
    prisma.taxRate.findMany({ where, orderBy: { rate: "asc" } }),
  ]);
  return { uoms, categories, taxRates };
}

const uomSchema = z.object({ code: text(16).min(1).toUpperCase(), name: text(80).min(1) });
const categorySchema = z.object({ name: text(120).min(1), parentId: z.string().min(1).nullish() });
const taxRateSchema = z.object({
  name: text(80).min(1),
  rate: zDecimal({ max: 100, places: 3 }),
  isActive: z.boolean().optional(),
});

async function createLookup<T extends { id: string }>(
  ctx: AccessContext,
  entity: string,
  create: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  assertCan(ctx, "catalog.administer");
  return prisma.$transaction(async (tx) => {
    const row = await create(tx);
    await audit(tx, ctx, { action: `${entity}.created`, entity, entityId: row.id, next: row });
    return row;
  });
}

export const createUom = (ctx: AccessContext, input: unknown) =>
  createLookup(ctx, "uom", (tx) => tx.uom.create({ data: { ...uomSchema.parse(input), organizationId: ctx.organizationId } }));

export const createCategory = (ctx: AccessContext, input: unknown) =>
  createLookup(ctx, "product_category", (tx) =>
    tx.productCategory.create({ data: { ...categorySchema.parse(input), organizationId: ctx.organizationId } }),
  );

export const createTaxRate = (ctx: AccessContext, input: unknown) =>
  createLookup(ctx, "tax_rate", (tx) =>
    tx.taxRate.create({ data: { ...taxRateSchema.parse(input), organizationId: ctx.organizationId } }),
  );

/** Only the active flag/name may change: lines snapshot the rate, so history stays correct. */
export async function updateTaxRate(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "catalog.administer");
  const data = taxRateSchema.pick({ name: true, isActive: true }).partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.taxRate.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Tax rate not found", 404);
    const row = await tx.taxRate.update({ where: { id }, data });
    const diff = changes(before as Record<string, unknown>, data);
    await audit(tx, ctx, { action: "tax_rate.updated", entity: "tax_rate", entityId: id, previous: diff.previous, next: diff.next });
    return row;
  });
}

// ─── Customer-specific prices ────────────────────────────────────────────────

const pricesSchema = z.object({
  prices: z.array(z.object({ productId: z.string().min(1), unitPrice: zDecimal().nullable() })).max(500),
});

export async function listCustomerPrices(ctx: AccessContext, customerId: string) {
  assertCan(ctx, "customer.view");
  return prisma.customerPrice.findMany({
    where: { organizationId: ctx.organizationId, customerId },
    include: { product: { select: { id: true, sku: true, name: true, salesPrice: true } } },
    orderBy: { product: { name: "asc" } },
  });
}

/** Upsert prices; `unitPrice: null` removes the override. */
export async function setCustomerPrices(ctx: AccessContext, customerId: string, input: unknown) {
  assertCan(ctx, "customer.update");
  const { prices } = pricesSchema.parse(input);
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organizationId: ctx.organizationId } });
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

  await prisma.$transaction(async (tx) => {
    for (const { productId, unitPrice } of prices) {
      if (unitPrice === null) {
        await tx.customerPrice.deleteMany({ where: { customerId, productId } });
      } else {
        await tx.customerPrice.upsert({
          where: { customerId_productId: { customerId, productId } },
          create: { organizationId: ctx.organizationId, customerId, productId, unitPrice },
          update: { unitPrice },
        });
      }
    }
    await audit(tx, ctx, { action: "customer.prices_updated", entity: "customer", entityId: customerId, next: prices });
  });
  return listCustomerPrices(ctx, customerId);
}

/**
 * Archiving needs zero stock and no open reservations; the base unit, tracking mode
 * and stock tracking cannot change while stock exists (lots and quantities would no
 * longer mean the same thing).
 */
async function assertStockSafeChange(
  tx: Prisma.TransactionClient,
  before: { id: string; uomId: string; trackingMode: TrackingMode; trackInventory: boolean; type: ProductType },
  data: { status?: RecordStatus; uomId?: string; trackingMode?: TrackingMode; trackInventory?: boolean; type?: ProductType },
) {
  const archiving = data.status === RecordStatus.ARCHIVED;
  const structural =
    (data.uomId !== undefined && data.uomId !== before.uomId) ||
    (data.trackingMode !== undefined && data.trackingMode !== before.trackingMode) ||
    (data.trackInventory !== undefined && data.trackInventory !== before.trackInventory) ||
    (data.type !== undefined && data.type !== before.type);
  if (!archiving && !structural) return;
  const [onHand, reserved] = await Promise.all([
    tx.stockBalance.count({ where: { productId: before.id, quantity: { not: 0 } } }),
    tx.stockReservation.count({ where: { productId: before.id, quantity: { gt: 0 } } }),
  ]);
  if (onHand > 0 || reserved > 0) {
    throw new AppError(
      "INVALID_STATE",
      archiving ? "Products with stock on hand or open reservations cannot be archived" : "Unit, tracking or stock settings cannot change while stock exists",
      422,
    );
  }
}

// ─── Unit conversions ────────────────────────────────────────────────────────

const conversionsSchema = z.object({
  conversions: z
    .array(z.object({ uomId: z.string().min(1), factor: zDecimal({ places: 6 }).refine((f) => f.gt(0), "Factor must be positive") }))
    .max(20),
});

/** Replace a product's alternate units: 1 `uomId` = `factor` base units. */
export async function setUomConversions(ctx: AccessContext, productId: string, input: unknown) {
  assertCan(ctx, "product.update");
  const { conversions } = conversionsSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, organizationId: ctx.organizationId } });
    if (!product) throw new AppError("NOT_FOUND", "Product not found", 404);
    if (conversions.some((c) => c.uomId === product.uomId)) {
      throw new AppError("VALIDATION_ERROR", "The base unit needs no conversion", 422);
    }
    const before = await tx.uomConversion.findMany({ where: { productId } });
    await tx.uomConversion.deleteMany({ where: { productId } });
    await tx.uomConversion.createMany({
      data: conversions.map((c) => ({ organizationId: ctx.organizationId, productId, uomId: c.uomId, factor: c.factor })),
    });
    await audit(tx, ctx, { action: "product.uom_conversions_updated", entity: "product", entityId: productId, previous: before, next: conversions });
    return tx.uomConversion.findMany({ where: { productId }, include: { uom: { select: { code: true, name: true } } } });
  });
}
