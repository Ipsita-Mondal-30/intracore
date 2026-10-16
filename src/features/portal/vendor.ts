import { z } from "zod";
import { FinanceDocStatus, PurchaseOrderStatus, StockEntryStatus, StockEntryType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { isIntraState, zDecimal } from "@/lib/money";
import { priceLines, type LineInputData } from "@/features/sales/pricing";
import { notFound, type PortalContext } from "@/features/portal/context";

/**
 * Vendor portal: the vendor's purchase orders (once approved), goods receipts against them
 * (quantities and dates only, never unit cost / valuation), bills and payments, and invoice
 * submission as a DRAFT bill for internal review. Never selected: internal notes, approval
 * notes, createdBy/approvedBy, journal ids, bank accounts, warehouse stock or cost.
 */

function vendorOf(p: PortalContext) {
  if (!p.vendorId) throw new AppError("FORBIDDEN", "Portal account has no vendor", 403);
  return { organizationId: p.organizationId, vendorId: p.vendorId };
}

/** Approved POs and later; a PO cancelled before approval was never issued to the vendor. */
function visiblePo(p: PortalContext): Prisma.PurchaseOrderWhereInput {
  return {
    ...vendorOf(p),
    status: { notIn: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL] },
    NOT: { status: PurchaseOrderStatus.CANCELLED, approvedAt: null },
  };
}

const poSelect = {
  id: true,
  number: true,
  status: true,
  orderDate: true,
  expectedDate: true,
  currency: true,
  subtotal: true,
  discountTotal: true,
  taxableTotal: true,
  taxTotal: true,
  grandTotal: true,
  company: { select: { name: true } },
  warehouse: { select: { name: true } },
} as const;

export async function listPurchaseOrders(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where = visiblePo(p);
  return paginate(q, () =>
    Promise.all([
      prisma.purchaseOrder.findMany({ where, select: poSelect, ...listArgs(q, ["createdAt", "orderDate", "number"], "orderDate") }),
      prisma.purchaseOrder.count({ where }),
    ]),
  );
}

export async function getPurchaseOrder(p: PortalContext, id: string) {
  const row = await prisma.purchaseOrder.findFirst({
    where: { id, ...visiblePo(p) },
    select: {
      ...poSelect,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPrice: true,
          discountPercent: true,
          taxRate: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          taxAmount: true,
          lineTotal: true,
          receivedQty: true,
          returnedQty: true,
          billedQty: true,
          product: { select: { sku: true, name: true, hsnCode: true } },
          uom: { select: { code: true } },
        },
      },
    },
  });
  if (!row) throw notFound("Purchase order");
  return row;
}

/** Posted goods receipts / purchase returns for the vendor's POs: quantities, never unitCost. */
export async function listGoodsReceipts(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.extend({ purchaseOrderId: z.string().optional() }).parse(query);
  const where: Prisma.StockEntryWhereInput = {
    organizationId: p.organizationId,
    status: StockEntryStatus.POSTED,
    type: { in: [StockEntryType.GOODS_RECEIPT, StockEntryType.PURCHASE_RETURN] },
    purchaseOrder: { is: { vendorId: vendorOf(p).vendorId } },
    purchaseOrderId: q.purchaseOrderId,
  };
  return paginate(q, () =>
    Promise.all([
      prisma.stockEntry.findMany({
        where,
        select: {
          id: true,
          number: true,
          type: true,
          postedAt: true,
          reference: true,
          purchaseOrder: { select: { id: true, number: true } },
          lines: { select: { id: true, quantity: true, lotNumber: true, expiryDate: true, purchaseOrderLineId: true, product: { select: { sku: true, name: true } }, uom: { select: { code: true } } } },
        },
        ...listArgs(q, ["createdAt", "postedAt"], "postedAt"),
      }),
      prisma.stockEntry.count({ where }),
    ]),
  );
}

export async function listBills(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where: Prisma.VendorBillWhereInput = vendorOf(p);
  const page = await paginate(q, () =>
    Promise.all([
      prisma.vendorBill.findMany({
        where,
        select: {
          id: true,
          number: true,
          vendorInvoiceNumber: true,
          status: true,
          billDate: true,
          dueDate: true,
          currency: true,
          taxTotal: true,
          grandTotal: true,
          paidAmount: true,
          debitedAmount: true,
          postedAt: true,
          purchaseOrder: { select: { id: true, number: true } },
        },
        ...listArgs(q, ["createdAt", "billDate", "dueDate"], "createdAt"),
      }),
      prisma.vendorBill.count({ where }),
    ]),
  );
  return {
    ...page,
    items: page.items.map((b) => ({
      ...b,
      /** DRAFT = under review, POSTED = accepted for payment */
      outstanding: b.status === "POSTED" ? b.grandTotal.sub(b.paidAmount).sub(b.debitedAmount).toFixed(2) : null,
    })),
  };
}

export async function listPayments(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where: Prisma.VendorPaymentWhereInput = { ...vendorOf(p), status: FinanceDocStatus.POSTED };
  return paginate(q, () =>
    Promise.all([
      prisma.vendorPayment.findMany({
        where,
        select: {
          id: true,
          number: true,
          paymentDate: true,
          amount: true,
          method: true,
          reference: true,
          allocations: { where: { reversedAt: null }, select: { amount: true, bill: { select: { number: true, vendorInvoiceNumber: true } } } },
        },
        ...listArgs(q, ["createdAt", "paymentDate"], "paymentDate"),
      }),
      prisma.vendorPayment.count({ where }),
    ]),
  );
}

const submitSchema = z.object({
  purchaseOrderId: z.string().min(1),
  vendorInvoiceNumber: z.string().trim().min(1).max(64),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date().nullish(),
  remarks: z.string().trim().max(2000).nullish(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().min(1),
        quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero"),
        unitPrice: zDecimal().nullish(),
      }),
    )
    .min(1, "Add at least one line")
    .max(200),
});

/**
 * Invoice submission → DRAFT vendor bill against one of the vendor's issued POs. Lines
 * must be lines of that PO; product, discount and tax come from the PO line (price may
 * differ, the three-way match runs when staff post the bill). Same pricing as
 * createVendorBill (priceLines with purchasePrice, GST split from branch vs vendor state).
 * A repeated vendor invoice number answers 409 (unique per vendor).
 */
export async function submitInvoice(p: PortalContext, input: unknown) {
  const { organizationId, vendorId } = vendorOf(p);
  const data = submitSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({
      where: { id: data.purchaseOrderId, ...visiblePo(p), status: { notIn: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL, PurchaseOrderStatus.CANCELLED] } },
      include: { lines: true, branch: { select: { stateCode: true } }, company: { select: { stateCode: true, baseCurrency: true } }, vendor: { select: { stateCode: true, paymentTermsDays: true } } },
    });
    if (!po) throw notFound("Purchase order");
    const inputs: LineInputData[] = data.lines.map((line) => {
      const poLine = po.lines.find((l) => l.id === line.purchaseOrderLineId);
      if (!poLine) throw new AppError("INVALID_REFERENCE", "Line is not on this purchase order", 422);
      return {
        productId: poLine.productId,
        description: poLine.description,
        quantity: line.quantity,
        uomId: poLine.uomId,
        unitPrice: line.unitPrice ?? poLine.unitPrice,
        discountPercent: poLine.discountPercent,
        taxRateId: poLine.taxRateId,
      };
    });
    const supplierState = po.supplierState ?? po.vendor.stateCode ?? null;
    const priced = await priceLines(tx, organizationId, inputs, {
      intraState: isIntraState(po.branch.stateCode ?? po.company.stateCode, supplierState),
      priceField: "purchasePrice",
    });
    const dueDate = data.dueDate ?? (po.vendor.paymentTermsDays !== null ? new Date(data.billDate.getTime() + po.vendor.paymentTermsDays * 86_400_000) : null);
    const bill = await tx.vendorBill.create({
      data: {
        organizationId,
        companyId: po.companyId,
        branchId: po.branchId,
        number: await nextDocumentNumber(tx, organizationId, po.companyId, "vendor_bill"),
        vendorInvoiceNumber: data.vendorInvoiceNumber,
        vendorId,
        purchaseOrderId: po.id,
        billDate: data.billDate,
        dueDate,
        currency: po.company.baseCurrency,
        supplierState,
        notes: ["Submitted via vendor portal", data.remarks || null].filter(Boolean).join("\n"),
        ...priced.totals,
        createdById: p.userId,
        lines: { create: priced.lines.map(({ uomId: _uom, ...l }, i) => ({ ...l, purchaseOrderLineId: data.lines[i].purchaseOrderLineId })) },
      },
      select: { id: true, number: true, vendorInvoiceNumber: true, status: true, grandTotal: true },
    });
    await audit(tx, p, { action: "vendor_bill.portal_submitted", entity: "vendor_bill", entityId: bill.id, companyId: po.companyId, next: { ...bill, portalAccountId: p.accountId } });
    return bill;
  });
}
