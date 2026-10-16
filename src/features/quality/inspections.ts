import { z } from "zod";
import { StockEntryStatus, StockEntryType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, Decimal, zDecimal } from "@/lib/money";
import { createAndPostEntry } from "@/features/inventory/entries";
import { assertFullCompany, fullCompanyIds } from "@/features/manufacturing/scope";
import { positive } from "@/features/manufacturing/boms";

type Db = Prisma.TransactionClient;
const ZERO = new Decimal(0);

// ─── Templates ───────────────────────────────────────────────────────────────

const optionalDecimal = zDecimal({ min: -1e12, places: 4 }).nullish();

const itemSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    /** BOOLEAN: pass/fail. NUMERIC: pass when within [minValue, maxValue]. TEXT: recorded only. */
    type: z.enum(["BOOLEAN", "NUMERIC", "TEXT"]).default("BOOLEAN"),
    minValue: optionalDecimal,
    maxValue: optionalDecimal,
    required: z.boolean().default(true),
  })
  .superRefine((item, ctx) => {
    const hasLimit = item.minValue != null || item.maxValue != null;
    if (item.type === "NUMERIC" && !hasLimit) ctx.addIssue({ code: "custom", path: ["minValue"], message: "A numeric check needs a minimum or maximum" });
    if (item.type !== "NUMERIC" && hasLimit) ctx.addIssue({ code: "custom", path: ["minValue"], message: "Only numeric checks take limits" });
    if (item.minValue != null && item.maxValue != null && item.minValue.gt(item.maxValue)) {
      ctx.addIssue({ code: "custom", path: ["maxValue"], message: "Maximum is below the minimum" });
    }
  });

// Form rows left blank (no label) are dropped so a fixed-row UI form can submit.
const itemsSchema = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((i) => i && typeof i === "object" && "label" in i && i.label !== "") : v),
  z.array(itemSchema).min(1, "Add at least one check").max(100),
);

const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  appliesTo: z.enum(["GOODS_RECEIPT", "PRODUCTION", "GENERAL"]).default("GENERAL"),
  items: itemsSchema,
});
const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  items: itemsSchema.optional(),
});

const templateInclude = { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } } satisfies Prisma.InspectionTemplateInclude;

const itemRows = (items: z.infer<typeof itemSchema>[]) =>
  items.map((i, n) => ({ label: i.label, type: i.type, minValue: i.minValue ?? null, maxValue: i.maxValue ?? null, required: i.required, sortOrder: n }));

export async function createInspectionTemplate(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "quality.manage");
  const data = templateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const template = await tx.inspectionTemplate.create({
      data: { organizationId: ctx.organizationId, name: data.name, appliesTo: data.appliesTo, items: { create: itemRows(data.items) } },
      include: templateInclude,
    });
    await audit(tx, ctx, { action: "inspection_template.created", entity: "inspection_template", entityId: template.id, next: template });
    return template;
  });
}

/** Checks can be replaced only until the template is used; afterwards create a new template. */
export async function updateInspectionTemplate(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "quality.manage");
  const data = templateUpdateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "inspection_templates" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const before = await tx.inspectionTemplate.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { _count: { select: { inspections: true } } } });
    if (!before) throw new AppError("NOT_FOUND", "Inspection template not found", 404);
    if (data.items) {
      if (before._count.inspections > 0) throw new AppError("INVALID_STATE", "This template has inspections; create a new template to change its checks", 422);
      await tx.inspectionTemplateItem.deleteMany({ where: { templateId: id } });
    }
    const template = await tx.inspectionTemplate.update({
      where: { id },
      data: { name: data.name, isActive: data.isActive, ...(data.items ? { items: { create: itemRows(data.items) } } : {}) },
      include: templateInclude,
    });
    await audit(tx, ctx, {
      action: "inspection_template.updated",
      entity: "inspection_template",
      entityId: id,
      previous: { name: before.name, isActive: before.isActive },
      next: { name: template.name, isActive: template.isActive, itemsReplaced: Boolean(data.items) },
    });
    return template;
  });
}

export async function listInspectionTemplates(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "quality.view");
  const q = listQuerySchema.extend({ appliesTo: z.string().optional(), active: z.enum(["true", "false"]).optional() }).parse(query);
  const where: Prisma.InspectionTemplateWhereInput = {
    organizationId: ctx.organizationId,
    appliesTo: q.appliesTo,
    isActive: q.active ? q.active === "true" : undefined,
    ...searchWhere(q.q, ["name"]),
  };
  return paginate(q, () =>
    Promise.all([
      prisma.inspectionTemplate.findMany({ where, include: { ...templateInclude, _count: { select: { inspections: true } } }, ...listArgs(q, ["createdAt", "name"], "name") }),
      prisma.inspectionTemplate.count({ where }),
    ]),
  );
}

export async function getInspectionTemplate(ctx: AccessContext, id: string) {
  assertCan(ctx, "quality.view");
  const template = await prisma.inspectionTemplate.findFirst({ where: { id, organizationId: ctx.organizationId }, include: templateInclude });
  if (!template) throw new AppError("NOT_FOUND", "Inspection template not found", 404);
  return template;
}

// ─── Inspections ─────────────────────────────────────────────────────────────

const inspectionSchema = z.object({
  templateId: z.string().min(1),
  /** GOODS_RECEIPT: sourceId is a posted goods receipt (stock entry). WORK_ORDER: a work order. */
  sourceType: z.enum(["GOODS_RECEIPT", "WORK_ORDER"]),
  sourceId: z.string().min(1),
  /** Required for goods receipts; defaults to the work order's product */
  productId: z.string().min(1).nullish(),
  /** Base units */
  inspectedQty: positive(4),
  /** Defaults to all of it when a check fails, none otherwise */
  rejectedQty: zDecimal({ places: 4 }).nullish(),
  results: z
    .array(z.object({ itemId: z.string().min(1), value: z.union([z.boolean(), z.number(), z.string().trim().max(1000)]).nullish() }))
    .max(100)
    .default([]),
  /** Raise an NCR for rejected quantity (default true) */
  raiseNcr: z.boolean().default(true),
  severity: z.enum(["MINOR", "MAJOR", "CRITICAL"]).default("MINOR"),
  ncrDescription: z.string().trim().max(4000).nullish(),
  /** Goods receipts only: return the rejected quantity to the vendor (posted PURCHASE_RETURN) */
  returnRejected: z.boolean().default(false),
});

type ItemResult = { itemId: string; label: string; value: string | boolean | null; pass: boolean };

/** Evaluate submitted values against the template's checks. */
export function evaluate(
  items: { id: string; label: string; type: string; minValue: Prisma.Decimal | null; maxValue: Prisma.Decimal | null; required: boolean }[],
  results: { itemId: string; value?: string | number | boolean | null }[],
): ItemResult[] {
  for (const r of results) {
    if (!items.some((i) => i.id === r.itemId)) throw new AppError("VALIDATION_ERROR", "A result refers to a check that is not on this template", 422);
  }
  return items.map((item) => {
    const raw = results.find((r) => r.itemId === item.id)?.value;
    if (raw === undefined || raw === null || raw === "") {
      if (item.required) throw new AppError("VALIDATION_ERROR", `${item.label}: a result is required`, 422, [{ path: `results.${item.id}`, message: "Required" }]);
      return { itemId: item.id, label: item.label, value: null, pass: true };
    }
    if (item.type === "BOOLEAN") {
      const v = typeof raw === "boolean" ? raw : ["true", "pass", "yes", "1"].includes(String(raw).toLowerCase()) ? true : ["false", "fail", "no", "0"].includes(String(raw).toLowerCase()) ? false : null;
      if (v === null) throw new AppError("VALIDATION_ERROR", `${item.label}: answer pass or fail`, 422);
      return { itemId: item.id, label: item.label, value: v, pass: v };
    }
    if (item.type === "NUMERIC") {
      let v: Decimal;
      try {
        v = new Decimal(typeof raw === "boolean" ? NaN : raw);
        if (!v.isFinite()) throw new Error();
      } catch {
        throw new AppError("VALIDATION_ERROR", `${item.label}: enter a number`, 422);
      }
      const pass = (item.minValue === null || v.gte(item.minValue)) && (item.maxValue === null || v.lte(item.maxValue));
      return { itemId: item.id, label: item.label, value: v.toString(), pass };
    }
    return { itemId: item.id, label: item.label, value: String(raw), pass: true };
  });
}

/**
 * Record an inspection. The result follows the checks: any failed check means some
 * quantity must be rejected (default: everything inspected). result = PASSED (nothing
 * rejected) | FAILED (everything rejected) | PARTIAL. Rejections raise an NCR unless
 * `raiseNcr: false`. Goods receipts: cumulative inspected quantity per product may not
 * exceed what the receipt brought in; with `returnRejected` the rejected quantity goes
 * back to the vendor as a posted purchase return in the same transaction. Work orders:
 * the rejected quantity is added to WorkOrder.rejectedQty (stock is not moved; scrap it
 * with a stock issue if the goods were already received).
 */
export async function createInspection(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "quality.inspect");
  const data = inspectionSchema.parse(input);
  if (data.returnRejected) {
    if (data.sourceType !== "GOODS_RECEIPT") throw new AppError("VALIDATION_ERROR", "Only goods receipts can be returned to the vendor", 422);
    assertCan(ctx, "inventory.create");
    assertCan(ctx, "inventory.post");
  }

  return prisma.$transaction(async (tx) => {
    const template = await tx.inspectionTemplate.findFirst({ where: { id: data.templateId, organizationId: ctx.organizationId }, include: templateInclude });
    if (!template) throw new AppError("INVALID_REFERENCE", "Inspection template not found", 422);
    if (!template.isActive) throw new AppError("INVALID_STATE", "This template is inactive", 422);
    const wanted = data.sourceType === "GOODS_RECEIPT" ? "GOODS_RECEIPT" : "PRODUCTION";
    if (template.appliesTo !== "GENERAL" && template.appliesTo !== wanted) {
      throw new AppError("VALIDATION_ERROR", `This template is for ${template.appliesTo.toLowerCase().replace("_", " ")} inspections`, 422);
    }

    const source = data.sourceType === "GOODS_RECEIPT" ? await goodsReceiptSource(tx, ctx, data) : await workOrderSource(tx, ctx, data);
    const results = evaluate(template.items, data.results);
    const failed = results.filter((r) => !r.pass);
    const rejected = data.rejectedQty ?? (failed.length ? data.inspectedQty : ZERO);
    if (rejected.gt(data.inspectedQty)) throw new AppError("VALIDATION_ERROR", "Rejected quantity exceeds the inspected quantity", 422);
    if (failed.length && rejected.isZero()) throw new AppError("VALIDATION_ERROR", `Checks failed (${failed.map((f) => f.label).join(", ")}): reject at least part of the quantity`, 422);
    const result = rejected.isZero() ? "PASSED" : rejected.eq(data.inspectedQty) ? "FAILED" : "PARTIAL";

    const inspection = await tx.inspection.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: source.companyId,
        templateId: template.id,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        productId: source.productId,
        inspectedQty: data.inspectedQty,
        acceptedQty: data.inspectedQty.sub(rejected),
        rejectedQty: rejected,
        result,
        results,
        inspectorId: ctx.userId,
      },
    });

    let nonConformance = null;
    if (rejected.gt(0) && data.raiseNcr) {
      nonConformance = await tx.nonConformance.create({
        data: {
          organizationId: ctx.organizationId,
          companyId: source.companyId,
          number: await nextDocumentNumber(tx, ctx.organizationId, source.companyId, "nonconformance"),
          inspectionId: inspection.id,
          productId: source.productId,
          vendorId: source.vendorId,
          quantity: rejected,
          severity: data.severity,
          description: data.ncrDescription || `${template.name}: ${failed.length ? `failed ${failed.map((f) => f.label).join(", ")}` : "quantity rejected"} (${source.label})`,
          createdById: ctx.userId,
        },
      });
      await audit(tx, ctx, { action: "nonconformance.created", entity: "nonconformance", entityId: nonConformance.id, companyId: source.companyId, next: nonConformance });
    }

    if (data.sourceType === "WORK_ORDER" && rejected.gt(0)) {
      await tx.workOrder.update({ where: { id: data.sourceId }, data: { rejectedQty: { increment: rejected } } });
    }
    const purchaseReturn = data.returnRejected && rejected.gt(0) ? await returnToVendor(tx, ctx, data.sourceId, source.productId, rejected, inspection.id) : null;

    await audit(tx, ctx, {
      action: "inspection.recorded",
      entity: "inspection",
      entityId: inspection.id,
      companyId: source.companyId,
      next: { result, inspected: data.inspectedQty, rejected, source: source.label, nonConformanceId: nonConformance?.id, purchaseReturnId: purchaseReturn?.id },
    });
    return { ...inspection, nonConformance, purchaseReturn };
  }, { timeout: 30_000 });
}

type InspectionInput = z.infer<typeof inspectionSchema>;

async function goodsReceiptSource(tx: Db, ctx: AccessContext, data: InspectionInput) {
  // Lock the receipt so concurrent inspections cannot both pass the quantity check.
  await tx.$queryRaw`SELECT 1 FROM "stock_entries" WHERE "id" = ${data.sourceId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const grn = await tx.stockEntry.findFirst({ where: { id: data.sourceId, organizationId: ctx.organizationId, type: StockEntryType.GOODS_RECEIPT }, include: { lines: true } });
  if (!grn) throw new AppError("NOT_FOUND", "Goods receipt not found", 404);
  assertFullCompany(ctx, grn.companyId);
  if (grn.status !== StockEntryStatus.POSTED) throw new AppError("INVALID_STATE", "Only posted goods receipts can be inspected", 422);
  if (!data.productId) throw new AppError("VALIDATION_ERROR", "Choose the product inspected", 422, [{ path: "productId", message: "Required" }]);
  const received = grn.lines.filter((l) => l.productId === data.productId).reduce((s, l) => s.add(l.baseQuantity), ZERO);
  if (received.isZero()) throw new AppError("INVALID_REFERENCE", "That product is not on this goods receipt", 422);
  const earlier = await tx.inspection.aggregate({ where: { organizationId: ctx.organizationId, sourceType: "GOODS_RECEIPT", sourceId: grn.id, productId: data.productId }, _sum: { inspectedQty: true } });
  const done = dec(earlier._sum.inspectedQty);
  if (done.add(data.inspectedQty).gt(received)) {
    throw new AppError("QUANTITY_EXCEEDED", `Only ${received.sub(done).toString()} more can be inspected (${done.toString()} of ${received.toString()} received)`, 422);
  }
  return { companyId: grn.companyId, productId: data.productId, vendorId: grn.vendorId, label: grn.number };
}

async function workOrderSource(tx: Db, ctx: AccessContext, data: InspectionInput) {
  await tx.$queryRaw`SELECT 1 FROM "work_orders" WHERE "id" = ${data.sourceId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const wo = await tx.workOrder.findFirst({ where: { id: data.sourceId, organizationId: ctx.organizationId } });
  if (!wo) throw new AppError("NOT_FOUND", "Work order not found", 404);
  assertFullCompany(ctx, wo.companyId);
  if (wo.status === "DRAFT" || wo.status === "CANCELLED") throw new AppError("INVALID_STATE", `A ${wo.status} work order cannot be inspected`, 422);
  if (data.productId && data.productId !== wo.productId) throw new AppError("VALIDATION_ERROR", "Work order inspections are for the product being made", 422);
  return { companyId: wo.companyId, productId: wo.productId, vendorId: null, label: wo.number };
}

/** Posted PURCHASE_RETURN of `quantity` base units of `productId` against the receipt's lines. */
async function returnToVendor(tx: Db, ctx: AccessContext, grnId: string, productId: string, quantity: Decimal, inspectionId: string) {
  const grn = await tx.stockEntry.findUniqueOrThrow({
    where: { id: grnId },
    include: { lines: { where: { productId }, include: { returnLines: { where: { entry: { status: StockEntryStatus.POSTED } } } } }, moves: { where: { isReversal: false } } },
  });
  let left = quantity;
  const lines = [];
  for (const line of grn.lines) {
    if (left.isZero()) break;
    const factor = dec(line.baseQuantity).div(line.quantity);
    const returnedBase = line.returnLines.reduce((s, r) => s.add(r.baseQuantity), ZERO);
    const base = Decimal.min(left, dec(line.baseQuantity).sub(returnedBase));
    if (base.lte(0)) continue;
    left = left.sub(base);
    lines.push({
      productId,
      quantity: base.div(factor).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
      uomId: line.uomId,
      baseQuantity: base,
      lotNumber: line.lotNumber,
      expiryDate: line.expiryDate,
      lotId: line.lotId,
      sourceLocationId: grn.moves.find((m) => m.entryLineId === line.id)?.locationId ?? null,
      returnOfLineId: line.id,
    });
  }
  if (left.gt(0)) throw new AppError("QUANTITY_EXCEEDED", "More is rejected than can still be returned against this receipt", 422);
  return createAndPostEntry(tx, ctx, {
    companyId: grn.companyId,
    branchId: grn.branchId,
    type: StockEntryType.PURCHASE_RETURN,
    sourceWarehouseId: grn.targetWarehouseId,
    purchaseOrderId: grn.purchaseOrderId,
    vendorId: grn.vendorId,
    returnOfId: grn.id,
    reference: `Inspection ${inspectionId}`,
    notes: "Rejected in quality inspection",
    lines,
  });
}

const inspectionListSchema = listQuerySchema.extend({
  sourceType: z.enum(["GOODS_RECEIPT", "WORK_ORDER"]).optional(),
  sourceId: z.string().optional(),
  productId: z.string().optional(),
  result: z.enum(["PASSED", "FAILED", "PARTIAL"]).optional(),
  companyId: z.string().optional(),
});

export async function listInspections(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "quality.view");
  const q = inspectionListSchema.parse(query);
  const where: Prisma.InspectionWhereInput = {
    AND: [
      { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds(ctx) } },
      { sourceType: q.sourceType, sourceId: q.sourceId, productId: q.productId, result: q.result, companyId: q.companyId },
    ],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.inspection.findMany({
        where,
        include: { template: { select: { id: true, name: true } }, nonConformances: { select: { id: true, number: true, status: true } } },
        ...listArgs(q, ["createdAt"], "createdAt"),
      }),
      prisma.inspection.count({ where }),
    ]),
  );
}

export async function getInspection(ctx: AccessContext, id: string) {
  assertCan(ctx, "quality.view");
  const inspection = await prisma.inspection.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { template: { select: { id: true, name: true, appliesTo: true } }, nonConformances: { select: { id: true, number: true, status: true } } },
  });
  if (!inspection) throw new AppError("NOT_FOUND", "Inspection not found", 404);
  assertFullCompany(ctx, inspection.companyId);
  return inspection;
}
