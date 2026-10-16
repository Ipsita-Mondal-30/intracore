import { z } from "zod";
import { FinanceDocStatus, PaymentMethod, SalesOrderStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";
import { computeLine, dec, Decimal, isIntraState, sumTotals, zDecimal } from "@/lib/money";
import { isStateCode, isValidGstin } from "@/lib/gst";
import { lineFieldsSchema, priceLines, type LineInputData } from "@/features/sales/pricing";
import { isStocked } from "@/features/inventory/stock";
import { isJournaled, postJournal, reverseJournal, today, type LedgerLine } from "@/features/finance/ledger";

/**
 * Receivables. Sales orders, invoices, receipts and journals stay distinct documents:
 * accepting a quotation or confirming an order never creates an invoice or a payment.
 *
 * Journals (once finance is set up and the document date is on/after the accounting
 * start date):
 *   invoice posted      Dr Accounts receivable (grand total)
 *                       Cr Sales revenue (taxable value), Cr Output CGST/SGST/IGST
 *   credit note posted  the mirror image of the invoice lines it credits
 *   receipt posted      Dr Bank/cash ledger, Cr Accounts receivable
 *   cancellations       reversal journals dated on the cancellation day
 */

type Db = Prisma.TransactionClient;
const S = FinanceDocStatus;
const ZERO = new Decimal(0);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const outstanding = (inv: { grandTotal: Prisma.Decimal; paidAmount: Prisma.Decimal; creditedAmount: Prisma.Decimal }) =>
  dec(inv.grandTotal).sub(inv.paidAmount).sub(inv.creditedAmount);

// ─── Invoices ────────────────────────────────────────────────────────────────

// Lines copied from a sales order may give only salesOrderLineId + quantity.
const invoiceLineSchema = lineFieldsSchema
  .extend({ salesOrderLineId: z.string().min(1).nullish() })
  .refine((l) => l.salesOrderLineId || l.productId || (l.description && l.unitPrice), {
    message: "Free-text lines need a description and unit price",
    path: ["description"],
  });

const invoiceSchema = z.object({
  companyId: z.string().min(1),
  branchId: z.string().min(1),
  customerId: z.string().min(1),
  salesOrderId: z.string().min(1).nullish(),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  placeOfSupplyState: z.string().regex(/^[0-9]{2}$/).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  lines: z.array(invoiceLineSchema).min(1, "Add at least one line").max(500),
});

const invoiceInclude = {
  lines: { orderBy: { sortOrder: "asc" }, include: { product: { select: { id: true, sku: true, name: true } } } },
  customer: true,
  company: true,
  branch: true,
  salesOrder: { select: { id: true, number: true } },
  creditNotes: { select: { id: true, number: true, status: true, grandTotal: true } },
  allocations: {
    where: { reversedAt: null },
    include: { receipt: { select: { id: true, number: true, receiptDate: true } }, creditNote: { select: { id: true, number: true } } },
  },
} satisfies Prisma.SalesInvoiceInclude;

async function lockInvoice(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "sales_invoices" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const invoice = await tx.salesInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found", 404);
  assertCompanyAccess(ctx, invoice.companyId, invoice.branchId);
  return invoice;
}

/** Quantity of a sales-order line that may still be invoiced (delivered goods, ordered services). */
function invoiceableQty(line: { quantity: Prisma.Decimal; deliveredQty: Prisma.Decimal; returnedQty: Prisma.Decimal; invoicedQty: Prisma.Decimal; product: { type: "GOODS" | "SERVICE"; trackInventory: boolean } | null }) {
  const cap = line.product && isStocked(line.product) ? dec(line.deliveredQty).sub(line.returnedQty) : dec(line.quantity);
  return Decimal.max(cap.sub(line.invoicedQty), ZERO);
}

async function buildInvoice(tx: Db, ctx: AccessContext, data: z.infer<typeof invoiceSchema>) {
  assertCompanyAccess(ctx, data.companyId, data.branchId);
  const [branch, customer] = await Promise.all([
    tx.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId, organizationId: ctx.organizationId }, include: { company: true } }),
    tx.customer.findFirst({ where: { id: data.customerId, organizationId: ctx.organizationId } }),
  ]);
  if (!branch) throw new AppError("NOT_FOUND", "Branch not found", 404);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);

  const lineInputs: LineInputData[] = [];
  const soLineIds: (string | null)[] = [];
  if (data.salesOrderId) {
    const so = await tx.salesOrder.findFirst({
      where: { id: data.salesOrderId, organizationId: ctx.organizationId },
      include: { lines: { include: { product: true } } },
    });
    if (!so) throw new AppError("NOT_FOUND", "Sales order not found", 404);
    if (so.customerId !== customer.id || so.companyId !== data.companyId) {
      throw new AppError("INVALID_REFERENCE", "The sales order belongs to another customer or company", 422);
    }
    const allowed: SalesOrderStatus[] = [SalesOrderStatus.CONFIRMED, SalesOrderStatus.PARTIALLY_DELIVERED, SalesOrderStatus.DELIVERED];
    if (!allowed.includes(so.status)) throw new AppError("INVALID_STATE", `A ${so.status} order cannot be invoiced`, 422);
    for (const line of data.lines) {
      const soLine = line.salesOrderLineId ? so.lines.find((l) => l.id === line.salesOrderLineId) : null;
      if (line.salesOrderLineId && !soLine) throw new AppError("INVALID_REFERENCE", "Line is not on the sales order", 422);
      if (soLine && line.quantity.gt(invoiceableQty(soLine))) {
        throw new AppError("QUANTITY_EXCEEDED", `${soLine.description}: only ${invoiceableQty(soLine).toString()} can be invoiced`, 422);
      }
      lineInputs.push(
        soLine
          ? {
              productId: soLine.productId,
              description: line.description ?? soLine.description,
              quantity: line.quantity,
              uomId: soLine.uomId,
              unitPrice: line.unitPrice ?? soLine.unitPrice,
              discountPercent: line.discountPercent ?? soLine.discountPercent,
              taxRateId: line.taxRateId === undefined ? soLine.taxRateId : line.taxRateId,
            }
          : line,
      );
      soLineIds.push(soLine?.id ?? null);
    }
  } else {
    for (const line of data.lines) {
      if (line.salesOrderLineId) throw new AppError("VALIDATION_ERROR", "salesOrderLineId needs salesOrderId", 422);
      lineInputs.push(line);
      soLineIds.push(null);
    }
  }

  const invoiceDate = data.invoiceDate ?? today();
  const placeOfSupplyState = data.placeOfSupplyState ?? customer.stateCode ?? branch.stateCode ?? branch.company.stateCode;
  const sellerState = branch.stateCode ?? branch.company.stateCode;
  const priced = await priceLines(tx, ctx.organizationId, lineInputs, {
    intraState: isIntraState(sellerState, placeOfSupplyState),
    customerId: customer.id,
    date: invoiceDate,
  });
  const products = await tx.product.findMany({
    where: { id: { in: priced.lines.map((l) => l.productId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, hsnCode: true },
  });
  const settings = companySettings(branch.company.settings);
  const terms = customer.paymentTermsDays ?? settings.receivables.defaultPaymentTermsDays;
  const lines = priced.lines.map((l, i) => ({
    ...l,
    salesOrderLineId: soLineIds[i],
    hsnCode: products.find((p) => p.id === l.productId)?.hsnCode ?? null,
    taxKind: priced.taxKinds[i],
  }));
  const totals = sumTotals(priced.lines);
  const taxSum = (key: "cgstAmount" | "sgstAmount" | "igstAmount") => priced.lines.reduce((s, l) => s.add(l[key]), ZERO);
  return {
    header: {
      organizationId: ctx.organizationId,
      companyId: data.companyId,
      branchId: data.branchId,
      customerId: customer.id,
      salesOrderId: data.salesOrderId ?? null,
      invoiceDate,
      dueDate: data.dueDate ?? new Date(invoiceDate.getTime() + terms * 86_400_000),
      placeOfSupplyState,
      sellerGstin: branch.gstin ?? branch.company.gstin,
      customerGstin: customer.gstin,
      billingAddress: customer.billingAddress,
      shippingAddress: customer.shippingAddress ?? customer.billingAddress,
      currency: branch.company.baseCurrency,
      notes: data.notes ?? null,
      terms: data.terms ?? null,
      ...totals,
      cgstTotal: taxSum("cgstAmount"),
      sgstTotal: taxSum("sgstAmount"),
      igstTotal: taxSum("igstAmount"),
    },
    lines,
  };
}

export async function createInvoice(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "invoice.create");
  const data = invoiceSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const built = await buildInvoice(tx, ctx, data);
    const invoice = await tx.salesInvoice.create({
      data: { ...built.header, createdById: ctx.userId, lines: { create: built.lines } },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "invoice.created", entity: "sales_invoice", entityId: invoice.id, companyId: invoice.companyId, next: invoice });
    return invoice;
  });
}

/** Draft invoice for everything on a sales order that can be invoiced right now. */
export async function createInvoiceFromSalesOrder(ctx: AccessContext, salesOrderId: string) {
  assertCan(ctx, "invoice.create");
  const so = await prisma.salesOrder.findFirst({
    where: { id: salesOrderId, organizationId: ctx.organizationId },
    include: { lines: { include: { product: true }, orderBy: { sortOrder: "asc" } } },
  });
  if (!so) throw new AppError("NOT_FOUND", "Sales order not found", 404);
  const lines = so.lines
    .map((l) => ({ salesOrderLineId: l.id, quantity: invoiceableQty(l) }))
    .filter((l) => l.quantity.gt(0));
  if (lines.length === 0) throw new AppError("INVALID_STATE", "Nothing on this order is ready to invoice (goods invoice once delivered)", 422);
  return createInvoice(ctx, {
    companyId: so.companyId,
    branchId: so.branchId,
    customerId: so.customerId,
    salesOrderId: so.id,
    placeOfSupplyState: so.placeOfSupplyState,
    lines: lines.map((l) => ({ ...l, quantity: l.quantity.toString() })),
  });
}

export async function updateInvoice(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "invoice.create");
  const patch = invoiceSchema.omit({ companyId: true, branchId: true, customerId: true, salesOrderId: true }).partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockInvoice(tx, ctx, id);
    if (before.status !== S.DRAFT) throw new AppError("INVALID_STATE", "Posted invoices cannot be edited; issue a credit note instead", 422);
    const built = await buildInvoice(tx, ctx, {
      companyId: before.companyId,
      branchId: before.branchId,
      customerId: before.customerId,
      salesOrderId: before.salesOrderId,
      invoiceDate: patch.invoiceDate ?? before.invoiceDate,
      dueDate: patch.dueDate ?? before.dueDate,
      placeOfSupplyState: patch.placeOfSupplyState === undefined ? before.placeOfSupplyState : patch.placeOfSupplyState,
      notes: patch.notes === undefined ? before.notes : patch.notes,
      terms: patch.terms === undefined ? before.terms : patch.terms,
      lines:
        patch.lines ??
        before.lines.map((l) => ({
          salesOrderLineId: l.salesOrderLineId,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          uomId: l.uomId,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent,
          taxRateId: l.taxRateId,
        })),
    });
    await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
    const invoice = await tx.salesInvoice.update({ where: { id }, data: { ...built.header, lines: { create: built.lines } }, include: { lines: true } });
    await audit(tx, ctx, { action: "invoice.updated", entity: "sales_invoice", entityId: id, companyId: before.companyId, previous: { grandTotal: before.grandTotal }, next: { grandTotal: invoice.grandTotal } });
    return invoice;
  });
}

/**
 * Post (issue) a draft invoice: validate GST data, take the next number, raise
 * invoiced quantities on the order and write the journal. Retry-safe.
 */
export async function postInvoice(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.post");
  return prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, ctx, id);
    if (invoice.status === S.POSTED) return invoice;
    if (invoice.status !== S.DRAFT) throw new AppError("INVALID_STATE", `A ${invoice.status} invoice cannot be posted`, 422);
    if (invoice.lines.length === 0 || !dec(invoice.grandTotal).gt(0)) throw new AppError("INVALID_STATE", "An invoice needs a positive total", 422);
    if (!isStateCode(invoice.placeOfSupplyState)) throw new AppError("VALIDATION_ERROR", "Set a valid place of supply (GST state code)", 422);
    if (invoice.customerGstin && !isValidGstin(invoice.customerGstin)) {
      throw new AppError("VALIDATION_ERROR", `Customer GSTIN ${invoice.customerGstin} fails the GSTIN check digit`, 422);
    }
    if (invoice.salesOrderId) {
      await tx.$queryRaw`SELECT 1 FROM "sales_orders" WHERE "id" = ${invoice.salesOrderId} FOR UPDATE`;
      for (const line of invoice.lines.filter((l) => l.salesOrderLineId)) {
        const soLine = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: line.salesOrderLineId! }, include: { product: true } });
        if (dec(line.quantity).gt(invoiceableQty(soLine))) {
          throw new AppError("QUANTITY_EXCEEDED", `${soLine.description}: only ${invoiceableQty(soLine).toString()} can be invoiced`, 422);
        }
        await tx.salesOrderLine.update({ where: { id: soLine.id }, data: { invoicedQty: { increment: line.quantity } } });
      }
    }

    const number = await nextDocumentNumber(tx, invoice.organizationId, invoice.companyId, "sales_invoice", invoice.invoiceDate);
    const journal = (await isJournaled(tx, invoice.companyId, invoice.invoiceDate))
      ? await postJournal(tx, { organizationId: ctx.organizationId, companyId: invoice.companyId, userId: ctx.userId }, {
          date: invoice.invoiceDate,
          sourceType: "SALES_INVOICE",
          sourceId: invoice.id,
          memo: `Invoice ${number}`,
          lines: salesLines(invoice, "invoice"),
        })
      : null;
    const posted = await tx.salesInvoice.update({
      where: { id },
      data: { status: S.POSTED, number, postedAt: new Date(), journalEntryId: journal?.id ?? null },
    });
    await audit(tx, ctx, { action: "invoice.posted", entity: "sales_invoice", entityId: id, companyId: invoice.companyId, previous: { status: invoice.status }, next: { status: S.POSTED, number, journalId: journal?.id } });
    return posted;
  });
}

/** Journal lines for an invoice, or (mirror image) for a credit note. */
function salesLines(
  doc: { customerId: string; grandTotal: Prisma.Decimal; taxableTotal: Prisma.Decimal; cgstTotal: Prisma.Decimal; sgstTotal: Prisma.Decimal; igstTotal: Prisma.Decimal },
  kind: "invoice" | "credit",
): LedgerLine[] {
  const dr = (v: Prisma.Decimal) => (kind === "invoice" ? { debit: v } : { credit: v });
  const cr = (v: Prisma.Decimal) => (kind === "invoice" ? { credit: v } : { debit: v });
  return [
    { account: "ACCOUNTS_RECEIVABLE", ...dr(doc.grandTotal), customerId: doc.customerId },
    { account: "SALES_REVENUE", ...cr(doc.taxableTotal) },
    { account: "OUTPUT_CGST", ...cr(doc.cgstTotal) },
    { account: "OUTPUT_SGST", ...cr(doc.sgstTotal) },
    { account: "OUTPUT_IGST", ...cr(doc.igstTotal) },
  ];
}

const reasonSchema = z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) });

/**
 * Controlled cancellation. Drafts are simply cancelled. A posted invoice can only be
 * cancelled while nothing is settled against it; its journal is reversed and the order
 * quantities released. Otherwise issue a credit note.
 */
export async function cancelInvoice(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "invoice.cancel");
  const { reason } = reasonSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, ctx, id);
    if (invoice.status === S.CANCELLED) return invoice;
    if (invoice.status === S.POSTED) {
      if (dec(invoice.paidAmount).gt(0) || dec(invoice.creditedAmount).gt(0)) {
        throw new AppError("INVALID_STATE", "Payments or credit notes are applied; reverse them or issue a credit note instead", 422);
      }
      if ((await tx.creditNote.count({ where: { invoiceId: id, status: S.POSTED } })) > 0) {
        throw new AppError("INVALID_STATE", "Cancel the posted credit notes first", 422);
      }
      if (invoice.journalEntryId) {
        await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: invoice.companyId, userId: ctx.userId }, invoice.journalEntryId, today(), `Cancellation of ${invoice.number}`);
      }
      for (const line of invoice.lines.filter((l) => l.salesOrderLineId)) {
        await tx.salesOrderLine.update({ where: { id: line.salesOrderLineId! }, data: { invoicedQty: { decrement: line.quantity } } });
      }
    }
    const cancelled = await tx.salesInvoice.update({ where: { id }, data: { status: S.CANCELLED, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "invoice.cancelled", entity: "sales_invoice", entityId: id, companyId: invoice.companyId, previous: { status: invoice.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}

const invoiceListSchema = listQuerySchema.extend({
  status: z.nativeEnum(FinanceDocStatus).optional(),
  customerId: z.string().optional(),
  companyId: z.string().optional(),
  /** "true": posted with a balance due; "overdue": also past due date */
  outstanding: z.enum(["true", "overdue"]).optional(),
});

export async function listInvoices(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "invoice.view");
  const q = invoiceListSchema.parse(query);
  const due = q.outstanding ? await outstandingInvoiceIds(ctx, q.outstanding === "overdue") : undefined;
  const where: Prisma.SalesInvoiceWhereInput = {
    AND: [
      companyScopeWhere(ctx),
      { status: q.status, customerId: q.customerId, companyId: q.companyId, id: due ? { in: due } : undefined },
      searchWhere(q.q, ["number", "notes", "customerGstin"]),
    ],
  };
  const page = await paginate(q, () =>
    prisma.$transaction([
      prisma.salesInvoice.findMany({
        where,
        include: { customer: { select: { id: true, name: true } } },
        ...listArgs(q, ["createdAt", "invoiceDate", "dueDate", "grandTotal", "number"], "createdAt"),
      }),
      prisma.salesInvoice.count({ where }),
    ]),
  );
  return { ...page, items: page.items.map((i) => ({ ...i, outstanding: outstanding(i).toFixed(2) })) };
}

async function outstandingInvoiceIds(ctx: AccessContext, overdueOnly: boolean) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "sales_invoices"
    WHERE "organizationId" = ${ctx.organizationId} AND "status" = 'POSTED'
      AND "grandTotal" - "paidAmount" - "creditedAmount" > 0
      AND (${overdueOnly}::boolean = false OR "dueDate" < CURRENT_DATE)`;
  return rows.map((r) => r.id);
}

export async function getInvoice(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.view");
  const invoice = await prisma.salesInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, include: invoiceInclude });
  if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found", 404);
  assertCompanyAccess(ctx, invoice.companyId, invoice.branchId);
  return { ...invoice, outstanding: outstanding(invoice).toFixed(2) };
}

// ─── Allocation (shared by receipts and credit notes) ────────────────────────

const allocationSchema = z.array(z.object({ invoiceId: z.string().min(1), amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive") })).max(200);

/**
 * Apply `amounts` of a receipt / credit note to invoices of the same customer and
 * company. Invoice rows are locked (in id order) so concurrent allocations cannot
 * overpay; each amount must fit the invoice's outstanding balance.
 */
async function allocate(
  tx: Db,
  source: { companyId: string; customerId: string; available: Decimal; receiptId?: string; creditNoteId?: string },
  allocations: { invoiceId: string; amount: Decimal }[],
) {
  const total = allocations.reduce((s, a) => s.add(a.amount), ZERO);
  if (total.gt(source.available)) {
    throw new AppError("OVERALLOCATED", `Only ${source.available.toFixed(2)} is available to allocate`, 422);
  }
  const ids = [...new Set(allocations.map((a) => a.invoiceId))].sort();
  for (const id of ids) await tx.$queryRaw`SELECT 1 FROM "sales_invoices" WHERE "id" = ${id} FOR UPDATE`;
  for (const a of allocations) {
    const invoice = await tx.salesInvoice.findUnique({ where: { id: a.invoiceId } });
    if (!invoice || invoice.companyId !== source.companyId || invoice.customerId !== source.customerId) {
      throw new AppError("INVALID_REFERENCE", "Invoice not found for this customer and company", 422);
    }
    if (invoice.status !== S.POSTED) throw new AppError("INVALID_STATE", `Invoice ${invoice.number ?? invoice.id} is not posted`, 422);
    const due = outstanding(invoice);
    if (a.amount.gt(due)) {
      throw new AppError("OVERPAYMENT", `Invoice ${invoice.number}: only ${due.toFixed(2)} is outstanding`, 422);
    }
    await tx.receivableAllocation.create({
      data: {
        organizationId: invoice.organizationId,
        companyId: invoice.companyId,
        invoiceId: invoice.id,
        receiptId: source.receiptId ?? null,
        creditNoteId: source.creditNoteId ?? null,
        amount: a.amount,
      },
    });
    await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: source.receiptId ? { paidAmount: { increment: a.amount } } : { creditedAmount: { increment: a.amount } },
    });
  }
  return total;
}

async function unallocate(tx: Db, where: { receiptId?: string; creditNoteId?: string }) {
  const active = await tx.receivableAllocation.findMany({ where: { ...where, reversedAt: null } });
  for (const a of active) {
    await tx.receivableAllocation.update({ where: { id: a.id }, data: { reversedAt: new Date() } });
    await tx.salesInvoice.update({
      where: { id: a.invoiceId },
      data: a.receiptId ? { paidAmount: { decrement: a.amount } } : { creditedAmount: { decrement: a.amount } },
    });
  }
}

// ─── Receipts ────────────────────────────────────────────────────────────────

const receiptSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  bankAccountId: z.string().min(1),
  receiptDate: z.coerce.date().optional(),
  amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive"),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  allocations: allocationSchema.default([]),
});

/**
 * Record money received and post it in one step. Allocations settle invoices; the
 * unallocated remainder is an on-account credit for the customer (never an
 * overpayment of an invoice).
 */
export async function createReceipt(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "receipt.create");
  const data = receiptSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    const [customer, bank] = await Promise.all([
      tx.customer.findFirst({ where: { id: data.customerId, organizationId: ctx.organizationId } }),
      tx.bankAccount.findFirst({ where: { id: data.bankAccountId, companyId: data.companyId, organizationId: ctx.organizationId } }),
    ]);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
    if (!bank || !bank.isActive) throw new AppError("NOT_FOUND", "Bank/cash account not found in this company", 404);
    const receiptDate = data.receiptDate ?? today();
    const number = await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "receipt", receiptDate);
    const receipt = await tx.paymentReceipt.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        number,
        customerId: customer.id,
        bankAccountId: bank.id,
        receiptDate,
        amount: data.amount,
        method: data.method,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        status: S.POSTED,
        postedAt: new Date(),
        createdById: ctx.userId,
      },
    });
    const allocated = await allocate(tx, { companyId: data.companyId, customerId: customer.id, available: data.amount, receiptId: receipt.id }, data.allocations);
    const journal = (await isJournaled(tx, data.companyId, receiptDate))
      ? await postJournal(tx, { organizationId: ctx.organizationId, companyId: data.companyId, userId: ctx.userId }, {
          date: receiptDate,
          sourceType: "RECEIPT",
          sourceId: receipt.id,
          memo: `Receipt ${number}`,
          lines: [
            { account: { id: bank.accountId }, debit: data.amount, bankAccountId: bank.id },
            { account: "ACCOUNTS_RECEIVABLE", credit: data.amount, customerId: customer.id },
          ],
        })
      : null;
    const posted = await tx.paymentReceipt.update({ where: { id: receipt.id }, data: { allocatedAmount: allocated, journalEntryId: journal?.id ?? null } });
    await audit(tx, ctx, { action: "receipt.posted", entity: "payment_receipt", entityId: receipt.id, companyId: data.companyId, next: { ...posted, allocations: data.allocations } });
    return posted;
  });
}

/** Apply the unallocated part of a receipt or credit note to invoices. */
export async function allocateCredit(ctx: AccessContext, input: unknown) {
  const data = z
    .object({ receiptId: z.string().optional(), creditNoteId: z.string().optional(), allocations: allocationSchema.min(1) })
    .refine((d) => Boolean(d.receiptId) !== Boolean(d.creditNoteId), "Give either receiptId or creditNoteId")
    .parse(input);
  assertCan(ctx, data.receiptId ? "receipt.create" : "invoice.post");
  return prisma.$transaction(async (tx) => {
    if (data.receiptId) {
      await tx.$queryRaw`SELECT 1 FROM "payment_receipts" WHERE "id" = ${data.receiptId} FOR UPDATE`;
      const r = await tx.paymentReceipt.findFirst({ where: { id: data.receiptId, organizationId: ctx.organizationId } });
      if (!r || !ctx.companies.has(r.companyId)) throw new AppError("NOT_FOUND", "Receipt not found", 404);
      if (r.status !== S.POSTED) throw new AppError("INVALID_STATE", "Receipt is not posted", 422);
      const added = await allocate(tx, { companyId: r.companyId, customerId: r.customerId, available: dec(r.amount).sub(r.allocatedAmount), receiptId: r.id }, data.allocations);
      await audit(tx, ctx, { action: "receipt.allocated", entity: "payment_receipt", entityId: r.id, companyId: r.companyId, next: data.allocations });
      return tx.paymentReceipt.update({ where: { id: r.id }, data: { allocatedAmount: { increment: added } } });
    }
    await tx.$queryRaw`SELECT 1 FROM "credit_notes" WHERE "id" = ${data.creditNoteId} FOR UPDATE`;
    const cn = await tx.creditNote.findFirst({ where: { id: data.creditNoteId, organizationId: ctx.organizationId } });
    if (!cn) throw new AppError("NOT_FOUND", "Credit note not found", 404);
    assertCompanyAccess(ctx, cn.companyId, cn.branchId);
    if (cn.status !== S.POSTED) throw new AppError("INVALID_STATE", "Credit note is not posted", 422);
    const added = await allocate(tx, { companyId: cn.companyId, customerId: cn.customerId, available: dec(cn.grandTotal).sub(cn.appliedAmount), creditNoteId: cn.id }, data.allocations);
    await audit(tx, ctx, { action: "credit_note.allocated", entity: "credit_note", entityId: cn.id, companyId: cn.companyId, next: data.allocations });
    return tx.creditNote.update({ where: { id: cn.id }, data: { appliedAmount: { increment: added } } });
  });
}

/** Cancel a receipt: allocations are reversed and its journal reversed (dated today). */
export async function cancelReceipt(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "receipt.cancel");
  const { reason } = reasonSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "payment_receipts" WHERE "id" = ${id} FOR UPDATE`;
    const r = await tx.paymentReceipt.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r || !ctx.companies.has(r.companyId)) throw new AppError("NOT_FOUND", "Receipt not found", 404);
    if (r.status === S.CANCELLED) return r;
    const allocs = await tx.receivableAllocation.findMany({ where: { receiptId: id, reversedAt: null }, select: { invoiceId: true } });
    for (const invoiceId of [...new Set(allocs.map((a) => a.invoiceId))].sort()) {
      await tx.$queryRaw`SELECT 1 FROM "sales_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    }
    await unallocate(tx, { receiptId: id });
    if (r.journalEntryId) {
      await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: r.companyId, userId: ctx.userId }, r.journalEntryId, today(), `Cancellation of ${r.number}`);
    }
    const cancelled = await tx.paymentReceipt.update({ where: { id }, data: { status: S.CANCELLED, allocatedAmount: 0, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "receipt.cancelled", entity: "payment_receipt", entityId: id, companyId: r.companyId, previous: { status: r.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}

export async function listReceipts(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "receipt.view");
  const q = listQuerySchema.extend({ customerId: z.string().optional(), status: z.nativeEnum(FinanceDocStatus).optional() }).parse(query);
  const where: Prisma.PaymentReceiptWhereInput = {
    organizationId: ctx.organizationId,
    companyId: { in: [...ctx.companies.keys()] },
    customerId: q.customerId,
    status: q.status,
    ...searchWhere(q.q, ["number", "reference", "notes"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.paymentReceipt.findMany({ where, include: { customer: { select: { id: true, name: true } }, bankAccount: { select: { name: true } } }, ...listArgs(q, ["createdAt", "receiptDate", "amount"], "createdAt") }),
      prisma.paymentReceipt.count({ where }),
    ]),
  );
}

export async function getReceipt(ctx: AccessContext, id: string) {
  assertCan(ctx, "receipt.view");
  const r = await prisma.paymentReceipt.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { customer: true, bankAccount: true, allocations: { include: { invoice: { select: { id: true, number: true, grandTotal: true } } } } },
  });
  if (!r || !ctx.companies.has(r.companyId)) throw new AppError("NOT_FOUND", "Receipt not found", 404);
  const matched = r.journalEntryId
    ? await prisma.bankTransaction.count({ where: { matchedLine: { entryId: r.journalEntryId } } })
    : 0;
  return { ...r, unallocated: dec(r.amount).sub(r.allocatedAmount).toFixed(2), reconciled: matched > 0 };
}

// ─── Credit notes ────────────────────────────────────────────────────────────

const creditNoteSchema = z.object({
  invoiceId: z.string().min(1),
  noteDate: z.coerce.date().optional(),
  reason: z.string().trim().min(1, "A reason is required").max(1000),
  lines: z
    .array(z.object({ invoiceLineId: z.string().min(1), quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be positive"), unitPrice: zDecimal().nullish() }))
    .min(1, "Credit at least one line"),
});

/**
 * Draft credit note against a posted invoice. Lines reuse the invoice line's tax rate
 * and supply type; cumulative credited quantity per invoice line cannot exceed what
 * was invoiced. (Goods coming back are a separate sales-return stock entry.)
 */
export async function createCreditNote(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "invoice.create");
  const data = creditNoteSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, ctx, data.invoiceId);
    if (invoice.status !== S.POSTED) throw new AppError("INVALID_STATE", "Credit notes need a posted invoice", 422);
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: invoice.branchId }, include: { company: true } });
    const intra = isIntraState(branch.stateCode ?? branch.company.stateCode, invoice.placeOfSupplyState);
    type NoteLine = ReturnType<typeof computeLine> &
      Omit<Prisma.CreditNoteLineUncheckedCreateWithoutCreditNoteInput, keyof ReturnType<typeof computeLine>>;
    const lines: NoteLine[] = [];
    for (const [i, l] of data.lines.entries()) {
      const invLine = invoice.lines.find((x) => x.id === l.invoiceLineId);
      if (!invLine) throw new AppError("INVALID_REFERENCE", "Line is not on this invoice", 422);
      const credited = await tx.creditNoteLine.aggregate({
        where: { invoiceLineId: invLine.id, creditNote: { status: S.POSTED } },
        _sum: { quantity: true },
      });
      const left = dec(invLine.quantity).sub(dec(credited._sum.quantity));
      if (l.quantity.gt(left)) throw new AppError("QUANTITY_EXCEEDED", `${invLine.description}: only ${left.toString()} can still be credited`, 422);
      const unitPrice = l.unitPrice ?? dec(invLine.unitPrice);
      const amounts = computeLine({ quantity: l.quantity, unitPrice, discountPercent: dec(invLine.discountPercent), taxRate: dec(invLine.taxRate) }, intra);
      lines.push({
        sortOrder: i,
        invoiceLineId: invLine.id,
        productId: invLine.productId,
        description: invLine.description,
        hsnCode: invLine.hsnCode,
        quantity: l.quantity,
        unitPrice,
        discountPercent: invLine.discountPercent,
        taxRateId: invLine.taxRateId,
        taxRate: invLine.taxRate,
        taxKind: invLine.taxKind,
        ...amounts,
      });
    }
    const totals = sumTotals(lines);
    const sum = (k: "cgstAmount" | "sgstAmount" | "igstAmount") => lines.reduce((s, l) => s.add(l[k]), ZERO);
    const note = await tx.creditNote.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: invoice.companyId,
        branchId: invoice.branchId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        noteDate: data.noteDate ?? today(),
        reason: data.reason,
        ...totals,
        cgstTotal: sum("cgstAmount"),
        sgstTotal: sum("sgstAmount"),
        igstTotal: sum("igstAmount"),
        createdById: ctx.userId,
        lines: { create: lines },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "credit_note.created", entity: "credit_note", entityId: note.id, companyId: note.companyId, next: note });
    return note;
  });
}

/** Post: number, journal, and apply to the original invoice up to its balance. */
export async function postCreditNote(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.post");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "credit_notes" WHERE "id" = ${id} FOR UPDATE`;
    const note = await tx.creditNote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
    if (!note) throw new AppError("NOT_FOUND", "Credit note not found", 404);
    assertCompanyAccess(ctx, note.companyId, note.branchId);
    if (note.status === S.POSTED) return note;
    if (note.status !== S.DRAFT) throw new AppError("INVALID_STATE", `A ${note.status} credit note cannot be posted`, 422);
    await tx.$queryRaw`SELECT 1 FROM "sales_invoices" WHERE "id" = ${note.invoiceId} FOR UPDATE`;
    // Re-check cumulative quantities under the invoice lock.
    for (const l of note.lines) {
      if (!l.invoiceLineId) continue;
      const invLine = await tx.salesInvoiceLine.findUniqueOrThrow({ where: { id: l.invoiceLineId } });
      const credited = await tx.creditNoteLine.aggregate({ where: { invoiceLineId: l.invoiceLineId, creditNote: { status: S.POSTED } }, _sum: { quantity: true } });
      if (dec(credited._sum.quantity).add(l.quantity).gt(invLine.quantity)) {
        throw new AppError("QUANTITY_EXCEEDED", `${l.description}: credited quantity would exceed the invoice`, 422);
      }
    }
    const number = await nextDocumentNumber(tx, note.organizationId, note.companyId, "credit_note", note.noteDate);
    const journal = (await isJournaled(tx, note.companyId, note.noteDate))
      ? await postJournal(tx, { organizationId: ctx.organizationId, companyId: note.companyId, userId: ctx.userId }, {
          date: note.noteDate,
          sourceType: "CREDIT_NOTE",
          sourceId: note.id,
          memo: `Credit note ${number}`,
          lines: salesLines(note, "credit"),
        })
      : null;
    const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: note.invoiceId } });
    const apply = Decimal.min(dec(note.grandTotal), Decimal.max(outstanding(invoice), ZERO));
    if (apply.gt(0)) {
      await allocate(tx, { companyId: note.companyId, customerId: note.customerId, available: apply, creditNoteId: note.id }, [{ invoiceId: invoice.id, amount: apply }]);
    }
    const posted = await tx.creditNote.update({
      where: { id },
      data: { status: S.POSTED, number, postedAt: new Date(), journalEntryId: journal?.id ?? null, appliedAmount: apply },
    });
    await audit(tx, ctx, { action: "credit_note.posted", entity: "credit_note", entityId: id, companyId: note.companyId, previous: { status: note.status }, next: { status: S.POSTED, number, applied: apply } });
    return posted;
  });
}

export async function cancelCreditNote(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "invoice.cancel");
  const { reason } = reasonSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "credit_notes" WHERE "id" = ${id} FOR UPDATE`;
    const note = await tx.creditNote.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!note) throw new AppError("NOT_FOUND", "Credit note not found", 404);
    assertCompanyAccess(ctx, note.companyId, note.branchId);
    if (note.status === S.CANCELLED) return note;
    if (note.status === S.POSTED) {
      const allocs = await tx.receivableAllocation.findMany({ where: { creditNoteId: id, reversedAt: null }, select: { invoiceId: true } });
      for (const invoiceId of [...new Set(allocs.map((a) => a.invoiceId))].sort()) await tx.$queryRaw`SELECT 1 FROM "sales_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
      await unallocate(tx, { creditNoteId: id });
      if (note.journalEntryId) {
        await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: note.companyId, userId: ctx.userId }, note.journalEntryId, today(), `Cancellation of ${note.number}`);
      }
    }
    const cancelled = await tx.creditNote.update({ where: { id }, data: { status: S.CANCELLED, appliedAmount: 0, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "credit_note.cancelled", entity: "credit_note", entityId: id, companyId: note.companyId, previous: { status: note.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}

export async function getCreditNote(ctx: AccessContext, id: string) {
  assertCan(ctx, "invoice.view");
  const note = await prisma.creditNote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, invoice: { select: { id: true, number: true } }, customer: true, company: true, branch: true },
  });
  if (!note) throw new AppError("NOT_FOUND", "Credit note not found", 404);
  assertCompanyAccess(ctx, note.companyId, note.branchId);
  return note;
}

export async function listCreditNotes(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "invoice.view");
  const q = listQuerySchema.extend({ status: z.nativeEnum(FinanceDocStatus).optional(), customerId: z.string().optional(), invoiceId: z.string().optional() }).parse(query);
  const where: Prisma.CreditNoteWhereInput = { AND: [companyScopeWhere(ctx), { status: q.status, customerId: q.customerId, invoiceId: q.invoiceId }, searchWhere(q.q, ["number", "reason"])] };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.creditNote.findMany({ where, include: { customer: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true } } }, ...listArgs(q, ["createdAt", "noteDate", "grandTotal"], "createdAt") }),
      prisma.creditNote.count({ where }),
    ]),
  );
}

// ─── Overdue reminders (job) ─────────────────────────────────────────────────

/**
 * Notify the customer owner (or invoice author) about overdue invoices, at most once
 * per `receivables.reminderIntervalDays`. Internal notification only; emailing the
 * customer goes through the communication centre.
 */
export async function remindOverdueInvoices(now = new Date()) {
  const { createSystemNotification } = await import("@/lib/notifications/create");
  const rows = await prisma.salesInvoice.findMany({
    where: { status: S.POSTED, dueDate: { lt: now } },
    include: { customer: { select: { name: true, ownerUserId: true } }, company: { select: { settings: true } } },
    take: 1000,
  });
  let sent = 0;
  for (const inv of rows) {
    if (!outstanding(inv).gt(0)) continue;
    const interval = companySettings(inv.company.settings).receivables.reminderIntervalDays;
    if (inv.lastReminderAt && now.getTime() - inv.lastReminderAt.getTime() < interval * 86_400_000) continue;
    const claimed = await prisma.salesInvoice.updateMany({
      where: { id: inv.id, lastReminderAt: inv.lastReminderAt },
      data: { lastReminderAt: now },
    });
    if (claimed.count === 0) continue;
    await createSystemNotification({
      organizationId: inv.organizationId,
      userId: inv.customer.ownerUserId ?? inv.createdById,
      type: "invoice.overdue",
      title: `Overdue: ${inv.number} (${inv.customer.name})`,
      body: `${outstanding(inv).toFixed(2)} ${inv.currency} was due ${ymd(inv.dueDate)}`,
      data: { invoiceId: inv.id, href: `/finance/invoices/${inv.id}` },
    });
    sent += 1;
  }
  return { sent };
}
