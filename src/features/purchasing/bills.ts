import { z } from "zod";
import { StockEntryStatus, VendorBillStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, isIntraState, zDecimal } from "@/lib/money";
import { priceLines, type LineInputData } from "@/features/sales/pricing";

const S = VendorBillStatus;

const billLineSchema = z
  .object({
    purchaseOrderLineId: z.string().min(1).nullish(),
    goodsReceiptLineId: z.string().min(1).nullish(),
    productId: z.string().min(1).nullish(),
    description: z.string().trim().max(1000).nullish(),
    quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
    unitPrice: zDecimal().nullish(),
    discountPercent: zDecimal({ max: 100 }).nullish(),
    taxRateId: z.string().min(1).nullish(),
  })
  .refine((l) => l.purchaseOrderLineId || l.productId || (l.description && l.unitPrice), {
    message: "Link a purchase order line, pick a product, or give a description and price",
    path: ["description"],
  });

const createSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1),
  vendorId: z.string().min(1),
  vendorInvoiceNumber: z.string().trim().min(1).max(64),
  purchaseOrderId: z.string().min(1).nullish(),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date().nullish(),
  supplierState: z.string().regex(/^[0-9]{2}$/).nullish(),
  notes: z.string().trim().max(10000).nullish(),
  lines: z.array(billLineSchema).min(1, "Add at least one line").max(200),
});

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(VendorBillStatus).optional(),
  vendorId: z.string().optional(),
  purchaseOrderId: z.string().optional(),
});

export async function listVendorBills(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "vendor_bill.view");
  const q = listSchema.parse(query);
  const where: Prisma.VendorBillWhereInput = {
    AND: [companyScopeWhere(ctx), { status: q.status, vendorId: q.vendorId, purchaseOrderId: q.purchaseOrderId }, searchWhere(q.q, ["number", "vendorInvoiceNumber", "notes"])],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.vendorBill.findMany({
        where,
        include: { vendor: { select: { id: true, name: true } }, purchaseOrder: { select: { id: true, number: true } } },
        ...listArgs(q, ["createdAt", "billDate", "dueDate", "grandTotal", "number"], "createdAt"),
      }),
      prisma.vendorBill.count({ where }),
    ]),
  );
}

export async function getVendorBill(ctx: AccessContext, id: string) {
  assertCan(ctx, "vendor_bill.view");
  const bill = await prisma.vendorBill.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      lines: { orderBy: { sortOrder: "asc" }, include: { product: { select: { id: true, sku: true, name: true, hsnCode: true } } } },
      vendor: true,
      company: true,
      branch: true,
      purchaseOrder: { select: { id: true, number: true } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!bill) throw new AppError("NOT_FOUND", "Vendor bill not found", 404);
  assertCompanyAccess(ctx, bill.companyId, bill.branchId);
  return bill;
}

/** Draft bill. Lines linked to a PO line default to its product, price, discount and tax. */
export async function createVendorBill(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "vendor_bill.create");
  const data = createSchema.parse(input);
  assertCompanyAccess(ctx, data.companyId, data.branchId);

  return prisma.$transaction(async (tx) => {
    const [branch, vendor] = await Promise.all([
      tx.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId, organizationId: ctx.organizationId }, include: { company: true } }),
      tx.vendor.findFirst({ where: { id: data.vendorId, organizationId: ctx.organizationId } }),
    ]);
    if (!branch) throw new AppError("NOT_FOUND", "Branch not found", 404);
    if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);

    let poLines: Awaited<ReturnType<typeof tx.purchaseOrderLine.findMany>> = [];
    if (data.purchaseOrderId) {
      const po = await tx.purchaseOrder.findFirst({ where: { id: data.purchaseOrderId, organizationId: ctx.organizationId }, include: { lines: true } });
      if (!po) throw new AppError("NOT_FOUND", "Purchase order not found", 404);
      if (po.vendorId !== vendor.id || po.companyId !== data.companyId) {
        throw new AppError("INVALID_REFERENCE", "The purchase order belongs to another vendor or company", 422);
      }
      poLines = po.lines;
    }
    const lineInputs: LineInputData[] = [];
    for (const line of data.lines) {
      if (line.purchaseOrderLineId) {
        const poLine = poLines.find((l) => l.id === line.purchaseOrderLineId);
        if (!poLine) throw new AppError("INVALID_REFERENCE", "Line is not on the linked purchase order", 422);
        if (line.goodsReceiptLineId) {
          const grnLine = await tx.stockEntryLine.findFirst({
            where: { id: line.goodsReceiptLineId, purchaseOrderLineId: poLine.id, entry: { status: StockEntryStatus.POSTED } },
            select: { id: true },
          });
          if (!grnLine) throw new AppError("INVALID_REFERENCE", "Goods receipt line does not match the purchase order line", 422);
        }
        lineInputs.push({
          productId: poLine.productId,
          description: line.description ?? poLine.description,
          quantity: line.quantity,
          uomId: poLine.uomId,
          unitPrice: line.unitPrice ?? poLine.unitPrice,
          discountPercent: line.discountPercent ?? poLine.discountPercent,
          taxRateId: line.taxRateId === undefined ? poLine.taxRateId : line.taxRateId,
        });
      } else {
        if (line.goodsReceiptLineId) throw new AppError("VALIDATION_ERROR", "A goods receipt line needs its purchase order line", 422);
        lineInputs.push({ ...line, uomId: null });
      }
    }

    const supplierState = data.supplierState ?? vendor.stateCode ?? null;
    const priced = await priceLines(tx, ctx.organizationId, lineInputs, {
      intraState: isIntraState(branch.stateCode ?? branch.company.stateCode, supplierState),
      priceField: "purchasePrice",
    });
    const dueDate =
      data.dueDate ?? (vendor.paymentTermsDays !== null ? new Date(data.billDate.getTime() + vendor.paymentTermsDays * 86_400_000) : null);
    const bill = await tx.vendorBill.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        branchId: data.branchId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "vendor_bill"),
        vendorInvoiceNumber: data.vendorInvoiceNumber,
        vendorId: vendor.id,
        purchaseOrderId: data.purchaseOrderId ?? null,
        billDate: data.billDate,
        dueDate,
        currency: branch.company.baseCurrency,
        supplierState,
        notes: data.notes ?? null,
        ...priced.totals,
        createdById: ctx.userId,
        lines: {
          create: priced.lines.map(({ uomId: _uom, ...l }, i) => ({
            ...l,
            purchaseOrderLineId: data.lines[i].purchaseOrderLineId ?? null,
            goodsReceiptLineId: data.lines[i].goodsReceiptLineId ?? null,
          })),
        },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "vendor_bill.created", entity: "vendor_bill", entityId: bill.id, companyId: bill.companyId, next: bill });
    return bill;
  });
}

async function lockBill(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "vendor_bills" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const bill = await tx.vendorBill.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!bill) throw new AppError("NOT_FOUND", "Vendor bill not found", 404);
  assertCompanyAccess(ctx, bill.companyId, bill.branchId);
  return bill;
}

/**
 * Three-way match on posting: for every line tied to a PO line, the total billed may
 * not exceed what was received net of returns. Retry-safe (POSTED is returned as is).
 */
export async function postVendorBill(ctx: AccessContext, id: string) {
  assertCan(ctx, "vendor_bill.post");
  return prisma.$transaction(async (tx) => {
    const bill = await lockBill(tx, ctx, id);
    if (bill.status === S.POSTED) return bill;
    if (bill.status !== S.DRAFT) throw new AppError("INVALID_STATE", `A ${bill.status} bill cannot be posted`, 422);
    if (bill.purchaseOrderId) await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${bill.purchaseOrderId} FOR UPDATE`;

    for (const line of bill.lines) {
      if (!line.purchaseOrderLineId) continue;
      const po = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.purchaseOrderLineId } });
      const billable = dec(po.receivedQty).sub(po.returnedQty).sub(po.billedQty);
      if (dec(line.quantity).gt(billable)) {
        throw new AppError(
          "QUANTITY_EXCEEDED",
          `${line.description}: only ${billable.toString()} received and not yet billed`,
          422,
        );
      }
      await tx.purchaseOrderLine.update({ where: { id: po.id }, data: { billedQty: { increment: line.quantity } } });
    }
    const posted = await tx.vendorBill.update({ where: { id }, data: { status: S.POSTED, postedAt: new Date() } });
    await audit(tx, ctx, { action: "vendor_bill.posted", entity: "vendor_bill", entityId: id, companyId: bill.companyId, previous: { status: bill.status }, next: { status: S.POSTED } });
    return posted;
  });
}

const cancelSchema = z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) });

export async function cancelVendorBill(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "vendor_bill.cancel");
  const { reason } = cancelSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const bill = await lockBill(tx, ctx, id);
    if (bill.status === S.CANCELLED) return bill;
    if (bill.status === S.POSTED) {
      if (bill.purchaseOrderId) await tx.$queryRaw`SELECT 1 FROM "purchase_orders" WHERE "id" = ${bill.purchaseOrderId} FOR UPDATE`;
      for (const line of bill.lines) {
        if (line.purchaseOrderLineId) {
          await tx.purchaseOrderLine.update({ where: { id: line.purchaseOrderLineId }, data: { billedQty: { decrement: line.quantity } } });
        }
      }
    }
    const cancelled = await tx.vendorBill.update({ where: { id }, data: { status: S.CANCELLED, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "vendor_bill.cancelled", entity: "vendor_bill", entityId: id, companyId: bill.companyId, previous: { status: bill.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}
