import { z } from "zod";
import { FinanceDocStatus, LeadPriority, QuotationStatus, RecordStatus, SalesOrderStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { resolveSlaPolicy, slaDueDates } from "@/features/service/sla";
import { notFound, type PortalContext } from "@/features/portal/context";

/**
 * Customer portal (also used by dealers for their own sales records). Every query is
 * pinned to the account's customer and uses an explicit `select` whitelist: document
 * numbers, dates, statuses, lines, totals and outstanding amounts. Never selected:
 * internal notes, approval notes/reasons, createdBy/approvedBy, cost or margin, journal
 * ids, bank accounts, INTERNAL ticket messages, assignees, SLA internals.
 */

export function customerOf(p: PortalContext) {
  if (!p.customerId) throw new AppError("FORBIDDEN", "Portal account has no customer", 403);
  return { organizationId: p.organizationId, customerId: p.customerId };
}

const company = { select: { name: true } } as const;

const docLine = {
  id: true,
  sortOrder: true,
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
  product: { select: { sku: true, name: true, hsnCode: true } },
  uom: { select: { code: true } },
} as const;

const { uom: _uom, ...invoiceLine } = docLine;

const totals = { currency: true, subtotal: true, discountTotal: true, taxableTotal: true, taxTotal: true, grandTotal: true } as const;

// ─── Quotations ───────────────────────────────────────────────────────────────

/** Internal stages never reach the customer. */
const VISIBLE_QUOTATION = { notIn: [QuotationStatus.DRAFT, QuotationStatus.PENDING_APPROVAL] };

const quotationSelect = { id: true, number: true, revision: true, status: true, issueDate: true, validUntil: true, ...totals, company } as const;

export async function listQuotations(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.extend({ status: z.nativeEnum(QuotationStatus).optional() }).parse(query);
  const where: Prisma.QuotationWhereInput = { ...customerOf(p), status: q.status && q.status !== "DRAFT" && q.status !== "PENDING_APPROVAL" ? q.status : VISIBLE_QUOTATION };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.quotation.findMany({ where, select: quotationSelect, ...listArgs(q, ["createdAt", "issueDate", "number"], "createdAt") }),
      prisma.quotation.count({ where }),
    ]),
  );
}

export async function getQuotation(p: PortalContext, id: string) {
  const row = await prisma.quotation.findFirst({
    where: { id, ...customerOf(p), status: VISIBLE_QUOTATION },
    select: { ...quotationSelect, terms: true, placeOfSupplyState: true, lines: { select: docLine, orderBy: { sortOrder: "asc" } }, salesOrder: { select: { id: true, number: true, status: true } } },
  });
  if (!row) throw notFound("Quotation");
  return row;
}

// ─── Sales orders ─────────────────────────────────────────────────────────────

const orderSelect = { id: true, number: true, status: true, orderDate: true, expectedDeliveryDate: true, customerPoNumber: true, ...totals, company } as const;

export async function listOrders(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where: Prisma.SalesOrderWhereInput = { ...customerOf(p), status: { not: SalesOrderStatus.DRAFT } };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.salesOrder.findMany({ where, select: orderSelect, ...listArgs(q, ["createdAt", "orderDate", "number"], "createdAt") }),
      prisma.salesOrder.count({ where }),
    ]),
  );
}

export async function getOrder(p: PortalContext, id: string) {
  const row = await prisma.salesOrder.findFirst({
    where: { id, ...customerOf(p), status: { not: SalesOrderStatus.DRAFT } },
    select: {
      ...orderSelect,
      shippingAddress: true,
      deliveryInstructions: true,
      quotation: { select: { id: true, number: true } },
      lines: { select: { ...docLine, deliveredQty: true, returnedQty: true, invoicedQty: true }, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!row) throw notFound("Order");
  return row;
}

// ─── Invoices and payments ────────────────────────────────────────────────────

const invoiceSelect = {
  id: true,
  number: true,
  status: true,
  invoiceDate: true,
  dueDate: true,
  ...totals,
  paidAmount: true,
  creditedAmount: true,
  company,
  salesOrder: { select: { id: true, number: true } },
} as const;

const withOutstanding = <T extends { grandTotal: Prisma.Decimal; paidAmount: Prisma.Decimal; creditedAmount: Prisma.Decimal }>(i: T) => ({
  ...i,
  outstanding: i.grandTotal.sub(i.paidAmount).sub(i.creditedAmount).toFixed(2),
});

/** Posted invoices only: drafts are unnumbered internal work, cancelled ones are void. */
export async function listInvoices(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where: Prisma.SalesInvoiceWhereInput = { ...customerOf(p), status: FinanceDocStatus.POSTED };
  const page = await paginate(q, () =>
    prisma.$transaction([
      prisma.salesInvoice.findMany({ where, select: invoiceSelect, ...listArgs(q, ["createdAt", "invoiceDate", "dueDate"], "invoiceDate") }),
      prisma.salesInvoice.count({ where }),
    ]),
  );
  return { ...page, items: page.items.map(withOutstanding) };
}

export async function getInvoice(p: PortalContext, id: string) {
  const row = await prisma.salesInvoice.findFirst({
    where: { id, ...customerOf(p), status: FinanceDocStatus.POSTED },
    select: {
      ...invoiceSelect,
      placeOfSupplyState: true,
      sellerGstin: true,
      customerGstin: true,
      billingAddress: true,
      shippingAddress: true,
      cgstTotal: true,
      sgstTotal: true,
      igstTotal: true,
      terms: true,
      irn: true,
      // Invoice lines carry uomId without a relation, so no unit code here.
      lines: { select: invoiceLine, orderBy: { sortOrder: "asc" } },
      allocations: { where: { reversedAt: null }, select: { amount: true, createdAt: true, receipt: { select: { number: true, receiptDate: true } }, creditNote: { select: { number: true } } } },
    },
  });
  if (!row) throw notFound("Invoice");
  return withOutstanding(row);
}

export async function listPayments(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.parse(query);
  const where: Prisma.PaymentReceiptWhereInput = { ...customerOf(p), status: FinanceDocStatus.POSTED };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.paymentReceipt.findMany({
        where,
        select: {
          id: true,
          number: true,
          receiptDate: true,
          amount: true,
          method: true,
          reference: true,
          allocatedAmount: true,
          allocations: { where: { reversedAt: null }, select: { amount: true, invoice: { select: { id: true, number: true } } } },
        },
        ...listArgs(q, ["createdAt", "receiptDate"], "receiptDate"),
      }),
      prisma.paymentReceipt.count({ where }),
    ]),
  );
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

const ticketSelect = {
  id: true,
  number: true,
  subject: true,
  priority: true,
  status: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  closedAt: true,
  resolutionCode: true,
  feedbackRating: true,
  asset: { select: { id: true, tag: true, name: true } },
  category: { select: { name: true } },
} as const;

/** PUBLIC messages only: INTERNAL notes are never selected for a portal. */
const publicMessages = {
  where: { visibility: "PUBLIC" },
  select: { id: true, authorType: true, body: true, createdAt: true },
  orderBy: { createdAt: "asc" },
} satisfies Prisma.Ticket$messagesArgs;

export async function listTickets(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.extend({ status: z.string().max(20).optional() }).parse(query);
  const where: Prisma.TicketWhereInput = { ...customerOf(p), status: q.status };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.ticket.findMany({ where, select: ticketSelect, ...listArgs(q, ["createdAt", "updatedAt", "number"], "createdAt") }),
      prisma.ticket.count({ where }),
    ]),
  );
}

export async function getTicket(p: PortalContext, id: string) {
  const row = await prisma.ticket.findFirst({
    where: { id, ...customerOf(p) },
    select: { ...ticketSelect, description: true, feedbackComment: true, messages: publicMessages },
  });
  if (!row) throw notFound("Ticket");
  return row;
}

const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20000).nullish(),
  priority: z.enum([LeadPriority.LOW, LeadPriority.MEDIUM, LeadPriority.HIGH]).default(LeadPriority.MEDIUM),
  companyId: z.string().min(1).nullish(),
  assetId: z.string().min(1).nullish(),
  categoryId: z.string().min(1).nullish(),
});

/** Companies a customer can raise tickets with (default company first). */
export function ticketCompanies(p: PortalContext) {
  return prisma.company.findMany({
    where: { organizationId: p.organizationId, status: RecordStatus.ACTIVE },
    select: { id: true, name: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export function ticketCategories(p: PortalContext) {
  return prisma.ticketCategory.findMany({ where: { organizationId: p.organizationId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/**
 * Opens a ticket for the account's customer (source PORTAL, status NEW, SLA from the
 * priority's policy). The asset must belong to the customer. createdById stays null so a
 * portal identity never gains internal "created by me" visibility; the audit log records it.
 */
export async function createTicket(p: PortalContext, input: unknown) {
  const { customerId, organizationId } = customerOf(p);
  const data = createTicketSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const companies = await tx.company.findMany({ where: { organizationId, status: RecordStatus.ACTIVE }, select: { id: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
    const companyId = data.companyId ?? companies[0]?.id;
    if (!companyId || !companies.some((c) => c.id === companyId)) throw notFound("Company");
    if (data.assetId && !(await tx.asset.findFirst({ where: { id: data.assetId, organizationId, customerId }, select: { id: true } }))) throw notFound("Asset");
    if (data.categoryId && !(await tx.ticketCategory.findFirst({ where: { id: data.categoryId, organizationId, isActive: true }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Unknown or inactive ticket category", 422);
    }
    const policy = await resolveSlaPolicy(tx, organizationId, data.priority);
    const now = new Date();
    const ticket = await tx.ticket.create({
      data: {
        organizationId,
        companyId,
        customerId,
        assetId: data.assetId ?? null,
        categoryId: data.categoryId ?? null,
        subject: data.subject,
        description: data.description ?? null,
        priority: data.priority,
        source: "PORTAL",
        status: "NEW",
        number: await nextDocumentNumber(tx, organizationId, companyId, "ticket", now),
        slaPolicyId: policy?.id ?? null,
        ...slaDueDates(policy, now),
        createdById: null,
        createdAt: now,
      },
      select: { id: true, number: true, status: true },
    });
    await audit(tx, p, { action: "ticket.portal_created", entity: "ticket", entityId: ticket.id, companyId, next: { ...ticket, portalAccountId: p.accountId } });
    return ticket;
  });
}

async function lockOwnTicket(tx: Prisma.TransactionClient, p: PortalContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "tickets" WHERE "id" = ${id} AND "organizationId" = ${p.organizationId} FOR UPDATE`;
  const ticket = await tx.ticket.findFirst({ where: { id, ...customerOf(p) }, select: { id: true, status: true, companyId: true, feedbackRating: true } });
  if (!ticket) throw notFound("Ticket");
  return ticket;
}

/** Customer reply: always authorType CUSTOMER and visibility PUBLIC. */
export async function replyToTicket(p: PortalContext, id: string, input: unknown) {
  const { body } = z.object({ body: z.string().trim().min(1, "Message cannot be empty").max(20000) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const ticket = await lockOwnTicket(tx, p, id);
    if (ticket.status === "CANCELLED" || ticket.status === "CLOSED") throw new AppError("INVALID_STATE", `Cannot reply to a ${ticket.status.toLowerCase()} ticket`, 422);
    const message = await tx.ticketMessage.create({
      data: { organizationId: p.organizationId, ticketId: id, authorUserId: p.userId, authorType: "CUSTOMER", visibility: "PUBLIC", body },
      select: { id: true, authorType: true, body: true, createdAt: true },
    });
    await audit(tx, p, { action: "ticket.replied", entity: "ticket", entityId: id, companyId: ticket.companyId, next: { messageId: message.id, visibility: "PUBLIC", via: "portal" } });
    return message;
  });
}

/** Rating 1–5 once the ticket is RESOLVED or CLOSED; recorded once. */
export async function giveTicketFeedback(p: PortalContext, id: string, input: unknown) {
  const data = z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const ticket = await lockOwnTicket(tx, p, id);
    if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") throw new AppError("INVALID_STATE", "Feedback can be given once the ticket is resolved", 422);
    if (ticket.feedbackRating !== null) throw new AppError("INVALID_STATE", "Feedback was already given for this ticket", 422);
    const updated = await tx.ticket.update({ where: { id }, data: { feedbackRating: data.rating, feedbackComment: data.comment ?? null }, select: { id: true, feedbackRating: true } });
    await audit(tx, p, { action: "ticket.feedback", entity: "ticket", entityId: id, companyId: ticket.companyId, next: { ...data, via: "portal" } });
    return updated;
  });
}

// ─── Assets, warranty, contracts, service history ─────────────────────────────

export async function listAssets(p: PortalContext) {
  const today = new Date();
  const rows = await prisma.asset.findMany({
    where: customerOf(p),
    select: {
      id: true,
      tag: true,
      name: true,
      serialNumber: true,
      location: true,
      status: true,
      installDate: true,
      product: { select: { sku: true, name: true } },
      warranties: { select: { id: true, type: true, startDate: true, endDate: true, coversParts: true, coversLabor: true, terms: true }, orderBy: { endDate: "desc" } },
    },
    orderBy: { tag: "asc" },
  });
  return rows.map((a) => ({ ...a, underWarranty: a.warranties.some((w) => w.startDate <= today && w.endDate >= today) }));
}

export function listContracts(p: PortalContext) {
  return prisma.serviceContract.findMany({
    where: { ...customerOf(p), status: { not: "DRAFT" } },
    select: {
      id: true,
      number: true,
      status: true,
      startDate: true,
      endDate: true,
      value: true,
      terms: true,
      assets: { select: { asset: { select: { id: true, tag: true, name: true } } } },
      entitlements: { select: { serviceType: true, quantity: true, usedCount: true } },
    },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Completed visits for the customer's assets, tickets or contracts. Only customer-facing
 * fields: the technician's own `notes` and the technician identity stay internal.
 */
export function listServiceHistory(p: PortalContext) {
  const { organizationId, customerId } = customerOf(p);
  return prisma.serviceVisit.findMany({
    where: {
      organizationId,
      status: "COMPLETED",
      OR: [{ asset: { is: { customerId } } }, { ticket: { is: { customerId } } }, { contract: { is: { customerId } } }],
    },
    select: {
      id: true,
      serviceType: true,
      scheduledStart: true,
      completedAt: true,
      workDone: true,
      customerSignedBy: true,
      asset: { select: { tag: true, name: true } },
      ticket: { select: { id: true, number: true, subject: true } },
      contract: { select: { number: true } },
    },
    orderBy: { completedAt: "desc" },
    take: 200,
  });
}
