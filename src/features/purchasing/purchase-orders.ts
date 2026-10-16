import { z } from "zod";
import { PurchaseOrderStatus, RecordStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";
import { dec, isIntraState } from "@/lib/money";
import { lineInputSchema, priceLines } from "@/features/sales/pricing";

const S = PurchaseOrderStatus;

const poLinesSchema = z
  .array(lineInputSchema.refine((l) => Boolean(l.productId), { message: "Purchase order lines need a product", path: ["productId"] }))
  .min(1, "Add at least one line")
  .max(200);

const headerSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1),
  warehouseId: z.string().min(1),
  vendorId: z.string().min(1),
  orderDate: z.coerce.date().optional(),
  expectedDate: z.coerce.date().nullish(),
  supplierState: z.string().regex(/^[0-9]{2}$/).nullish(),
  notes: z.string().trim().max(10000).nullish(),
});

const createSchema = headerSchema.extend({ lines: poLinesSchema });
const updateSchema = headerSchema
  .omit({ companyId: true, branchId: true })
  .partial()
  .extend({ lines: poLinesSchema.optional() });

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(PurchaseOrderStatus).optional(),
  vendorId: z.string().optional(),
  companyId: z.string().optional(),
});

export const purchaseOrderInclude = {
  lines: {
    orderBy: { sortOrder: "asc" },
    include: { product: { select: { id: true, sku: true, name: true, hsnCode: true, trackingMode: true, hasExpiry: true } }, uom: { select: { code: true } } },
  },
  vendor: true,
  company: true,
  branch: true,
  warehouse: true,
  approvedBy: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  stockEntries: { select: { id: true, number: true, type: true, status: true, postedAt: true }, orderBy: { createdAt: "asc" } },
  bills: { select: { id: true, number: true, vendorInvoiceNumber: true, status: true, grandTotal: true } },
} satisfies Prisma.PurchaseOrderInclude;

export async function listPurchaseOrders(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "purchase_order.view");
  const q = listSchema.parse(query);
  const where: Prisma.PurchaseOrderWhereInput = {
    AND: [companyScopeWhere(ctx), { status: q.status, vendorId: q.vendorId, companyId: q.companyId }, searchWhere(q.q, ["number", "notes"])],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: { vendor: { select: { id: true, name: true } }, warehouse: { select: { code: true } } },
        ...listArgs(q, ["createdAt", "number", "grandTotal", "orderDate", "expectedDate"], "createdAt"),
      }),
      prisma.purchaseOrder.count({ where }),
    ]),
  );
}

export async function getPurchaseOrder(ctx: AccessContext, id: string) {
  assertCan(ctx, "purchase_order.view");
  const po = await prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: purchaseOrderInclude });
  if (!po) throw new AppError("NOT_FOUND", "Purchase order not found", 404);
  assertCompanyAccess(ctx, po.companyId, po.branchId);
  return po;
}

/** BLOCKED vendors (supplier qualification, see docs/MANUFACTURING.md) get no new or approved orders. */
function assertVendorQualified(vendor: { name: string; qualificationStatus: string }) {
  if (vendor.qualificationStatus === "BLOCKED") {
    throw new AppError("VENDOR_NOT_QUALIFIED", `${vendor.name} is blocked by supplier qualification`, 422);
  }
}

async function resolveParty(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  h: { companyId: string; branchId: string; warehouseId: string; vendorId: string; supplierState?: string | null },
) {
  assertCompanyAccess(ctx, h.companyId, h.branchId);
  const [branch, warehouse, vendor] = await Promise.all([
    tx.branch.findFirst({ where: { id: h.branchId, companyId: h.companyId, organizationId: ctx.organizationId }, include: { company: true } }),
    tx.warehouse.findFirst({ where: { id: h.warehouseId, companyId: h.companyId, organizationId: ctx.organizationId } }),
    tx.vendor.findFirst({ where: { id: h.vendorId, organizationId: ctx.organizationId } }),
  ]);
  if (!branch) throw new AppError("NOT_FOUND", "Branch not found", 404);
  if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found in this company", 404);
  if (!warehouse.isActive) throw new AppError("INVALID_STATE", "Warehouse is inactive", 422);
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);
  if (vendor.status !== RecordStatus.ACTIVE) throw new AppError("INVALID_STATE", "Vendor is not active", 422);
  assertVendorQualified(vendor);
  const supplierState = h.supplierState ?? vendor.stateCode ?? null;
  return {
    company: branch.company,
    supplierState,
    intraState: isIntraState(branch.stateCode ?? branch.company.stateCode, supplierState),
  };
}

export async function createPurchaseOrder(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "purchase_order.create");
  const data = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const party = await resolveParty(tx, ctx, data);
    const { lines, ...header } = data;
    const priced = await priceLines(tx, ctx.organizationId, lines, { intraState: party.intraState, priceField: "purchasePrice" });
    const po = await tx.purchaseOrder.create({
      data: {
        ...header,
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "purchase_order"),
        supplierState: party.supplierState,
        currency: party.company.baseCurrency,
        ...priced.totals,
        createdById: ctx.userId,
        lines: { create: priced.lines.map((l) => ({ ...l, productId: l.productId! })) },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "purchase_order.created", entity: "purchase_order", entityId: po.id, companyId: po.companyId, next: po });
    return po;
  });
}

async function lockPurchaseOrder(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!po) throw new AppError("NOT_FOUND", "Purchase order not found", 404);
  assertCompanyAccess(ctx, po.companyId, po.branchId);
  return po;
}

/** Drafts only; approved orders are changed by cancelling and re-issuing. */
export async function updatePurchaseOrder(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "purchase_order.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockPurchaseOrder(tx, ctx, id);
    if (before.status !== S.DRAFT) throw new AppError("INVALID_STATE", "Only draft purchase orders can be edited", 422);
    const header = {
      companyId: before.companyId,
      branchId: before.branchId,
      warehouseId: data.warehouseId ?? before.warehouseId,
      vendorId: data.vendorId ?? before.vendorId,
      supplierState: data.supplierState === undefined ? before.supplierState : data.supplierState,
    };
    const party = await resolveParty(tx, ctx, header);
    const lineInputs =
      data.lines ??
      before.lines.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity, uomId: l.uomId, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRateId: l.taxRateId }));
    const priced = await priceLines(tx, ctx.organizationId, lineInputs, { intraState: party.intraState, priceField: "purchasePrice" });
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    const po = await tx.purchaseOrder.update({
      where: { id },
      data: {
        warehouseId: header.warehouseId,
        vendorId: header.vendorId,
        supplierState: party.supplierState,
        orderDate: data.orderDate ?? before.orderDate,
        expectedDate: data.expectedDate === undefined ? before.expectedDate : data.expectedDate,
        notes: data.notes === undefined ? before.notes : data.notes,
        ...priced.totals,
        lines: { create: priced.lines.map((l) => ({ ...l, productId: l.productId! })) },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, {
      action: "purchase_order.updated",
      entity: "purchase_order",
      entityId: id,
      companyId: before.companyId,
      previous: { grandTotal: before.grandTotal, lines: before.lines.length },
      next: { grandTotal: po.grandTotal, lines: po.lines.length },
    });
    return po;
  });
}

const requiredText = (message: string) => z.string({ required_error: message }).trim().min(1, message).max(1000);
const actionSchemas = {
  submit: z.object({}),
  approve: z.object({ note: z.string().trim().max(1000).optional() }),
  return: z.object({ note: requiredText("Explain what needs to change") }),
  cancel: z.object({ reason: requiredText("A cancellation reason is required") }),
  close: z.object({ reason: z.string().trim().max(1000).optional() }),
};
export type PurchaseOrderAction = keyof typeof actionSchemas;
export const PURCHASE_ORDER_ACTIONS = Object.keys(actionSchemas) as PurchaseOrderAction[];

/**
 * DRAFT --submit--> PENDING_APPROVAL (total above the company threshold) | APPROVED
 * PENDING_APPROVAL --approve--> APPROVED | --return--> DRAFT
 * DRAFT|PENDING_APPROVAL|APPROVED --cancel--> CANCELLED (nothing received yet)
 * PARTIALLY_RECEIVED --close--> CLOSED (short-close the remainder)
 * Receiving goods (PARTIALLY_RECEIVED / RECEIVED) happens through goods receipts.
 */
export async function transitionPurchaseOrder(ctx: AccessContext, id: string, action: PurchaseOrderAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as Record<string, string | undefined>;
  assertCan(
    ctx,
    action === "approve" || action === "return" ? "purchase_order.approve" : action === "cancel" ? "purchase_order.cancel" : "purchase_order.update",
  );

  return prisma.$transaction(async (tx) => {
    const po = await lockPurchaseOrder(tx, ctx, id);
    const now = new Date();
    const expect = (...allowed: PurchaseOrderStatus[]) => {
      if (!allowed.includes(po.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a purchase order that is ${po.status}`, 422);
    };
    if (action === "submit" || action === "approve") {
      assertVendorQualified(await tx.vendor.findUniqueOrThrow({ where: { id: po.vendorId }, select: { name: true, qualificationStatus: true } }));
    }
    let data: Prisma.PurchaseOrderUncheckedUpdateInput;
    switch (action) {
      case "submit": {
        expect(S.DRAFT);
        if (po.lines.length === 0) throw new AppError("INVALID_STATE", "Add at least one line before submitting", 422);
        const company = await tx.company.findUniqueOrThrow({ where: { id: po.companyId }, select: { settings: true } });
        const limit = companySettings(company.settings).purchase.approvalAmount;
        const needsApproval = limit !== null && po.grandTotal.gt(limit);
        data = needsApproval
          ? { status: S.PENDING_APPROVAL, approvalRequired: true, approvalReason: `Total ${po.grandTotal.toFixed(2)} exceeds ${limit}` }
          : { status: S.APPROVED, approvalRequired: false, approvalReason: null, approvedAt: now, approvedById: null };
        break;
      }
      case "approve":
        expect(S.PENDING_APPROVAL);
        if (po.createdById === ctx.userId && !ctx.isOwner) throw new AppError("FORBIDDEN", "You cannot approve a purchase order you created", 403);
        data = { status: S.APPROVED, approvedById: ctx.userId, approvedAt: now, approvalNote: body.note ?? null };
        break;
      case "return":
        expect(S.PENDING_APPROVAL);
        data = { status: S.DRAFT, approvalNote: body.note };
        break;
      case "cancel":
        // Listing PARTIALLY_RECEIVED here lets the receipt check below explain what to do.
        expect(S.DRAFT, S.PENDING_APPROVAL, S.APPROVED, S.PARTIALLY_RECEIVED);
        if (po.lines.some((l) => dec(l.receivedQty).gt(0))) throw new AppError("INVALID_STATE", "Goods were received; close the order instead", 422);
        data = { status: S.CANCELLED, cancelledAt: now, cancelReason: body.reason };
        break;
      case "close":
        expect(S.PARTIALLY_RECEIVED);
        data = { status: S.CLOSED, closedAt: now, cancelReason: body.reason ?? null };
        break;
    }
    const updated = await tx.purchaseOrder.update({ where: { id }, data: data! });
    await audit(tx, ctx, {
      action: `purchase_order.${action}`,
      entity: "purchase_order",
      entityId: id,
      companyId: po.companyId,
      previous: { status: po.status },
      next: { status: updated.status, ...body },
    });
    return updated;
  });
}
