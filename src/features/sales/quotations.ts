import { z } from "zod";
import { Prisma, QuotationStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";
import { dec } from "@/lib/money";
import { copyLine, linesSchema, partyHeaderSchema, priceLines, resolveSalesParty } from "@/features/sales/pricing";
import { changeOpportunityStage, isClosed } from "@/features/opportunities/service";

const S = QuotationStatus;

const headerSchema = partyHeaderSchema.extend({
  opportunityId: z.string().min(1).nullish(),
  validUntil: z.coerce.date().optional(),
  terms: z.string().trim().max(10000).nullish(),
  notes: z.string().trim().max(10000).nullish(),
});

const createSchema = headerSchema.extend({ lines: linesSchema });
const updateSchema = headerSchema
  .omit({ companyId: true, branchId: true })
  .partial()
  .extend({ lines: linesSchema.optional() });

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(QuotationStatus).optional(),
  customerId: z.string().optional(),
  opportunityId: z.string().optional(),
  companyId: z.string().optional(),
  /** Hide superseded revisions unless asked for. */
  includeSuperseded: z.enum(["true", "false"]).optional(),
});

const detailInclude = {
  lines: {
    orderBy: { sortOrder: "asc" },
    include: { product: { select: { id: true, sku: true, name: true, hsnCode: true } }, uom: { select: { code: true } } },
  },
  customer: true,
  contact: { select: { id: true, fullName: true, email: true, phone: true } },
  company: true,
  branch: true,
  opportunity: { select: { id: true, name: true, stage: true } },
  approvedBy: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  salesOrder: { select: { id: true, number: true, status: true } },
  previousRevision: { select: { id: true, revision: true, status: true } },
  nextRevision: { select: { id: true, revision: true, status: true } },
} satisfies Prisma.QuotationInclude;

const today = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export async function listQuotations(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "quotation.view");
  const q = listSchema.parse(query);
  const where: Prisma.QuotationWhereInput = {
    AND: [
      companyScopeWhere(ctx),
      {
        status: q.status ?? (q.includeSuperseded === "true" ? undefined : { not: S.SUPERSEDED }),
        customerId: q.customerId,
        opportunityId: q.opportunityId,
        companyId: q.companyId,
      },
      searchWhere(q.q, ["number", "notes"]),
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.quotation.findMany({
        where,
        include: { customer: { select: { id: true, name: true } }, company: { select: { code: true } } },
        ...listArgs(q, ["createdAt", "number", "grandTotal", "validUntil", "issueDate"], "createdAt"),
      }),
      prisma.quotation.count({ where }),
    ]),
  );
}

export async function getQuotation(ctx: AccessContext, id: string) {
  assertCan(ctx, "quotation.view");
  const quotation = await prisma.quotation.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: detailInclude,
  });
  if (!quotation) throw new AppError("NOT_FOUND", "Quotation not found", 404);
  assertCompanyAccess(ctx, quotation.companyId, quotation.branchId);
  return quotation;
}

async function assertOpportunity(db: Prisma.TransactionClient, organizationId: string, customerId: string, opportunityId?: string | null) {
  if (!opportunityId) return;
  const opportunity = await db.opportunity.findFirst({ where: { id: opportunityId, organizationId }, select: { customerId: true } });
  if (!opportunity) throw new AppError("NOT_FOUND", "Opportunity not found", 404);
  if (opportunity.customerId !== customerId) {
    throw new AppError("INVALID_REFERENCE", "Opportunity belongs to a different customer", 422);
  }
}

export async function createQuotation(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "quotation.create");
  const data = createSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const party = await resolveSalesParty(tx, ctx, data);
    await assertOpportunity(tx, ctx.organizationId, data.customerId, data.opportunityId);
    const settings = companySettings(party.companySettings);
    const priced = await priceLines(tx, ctx.organizationId, data.lines, { intraState: party.intraState, customerId: data.customerId });
    const validUntil = data.validUntil ?? new Date(today().getTime() + settings.quotation.defaultValidityDays * 86_400_000);
    if (validUntil < today()) throw new AppError("VALIDATION_ERROR", "Valid-until date is in the past", 422);

    const quotation = await tx.quotation.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        branchId: data.branchId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "quotation"),
        customerId: data.customerId,
        contactId: data.contactId ?? null,
        opportunityId: data.opportunityId ?? null,
        validUntil,
        currency: data.currency ?? party.currency,
        placeOfSupplyState: party.placeOfSupplyState,
        terms: data.terms ?? null,
        notes: data.notes ?? null,
        ...priced.totals,
        createdById: ctx.userId,
        lines: { create: priced.lines },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "quotation.created", entity: "quotation", entityId: quotation.id, companyId: data.companyId, next: quotation });
    return quotation;
  });
}

/** Only drafts are editable; anything else must be revised. */
export async function updateQuotation(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "quotation.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockQuotation(tx, ctx, id);
    if (before.status !== S.DRAFT) throw new AppError("INVALID_STATE", "Only draft quotations can be edited; revise it instead", 422);

    const header = {
      companyId: before.companyId,
      branchId: before.branchId,
      customerId: data.customerId ?? before.customerId,
      contactId: data.contactId === undefined ? before.contactId : data.contactId,
      placeOfSupplyState: data.placeOfSupplyState === undefined ? before.placeOfSupplyState : data.placeOfSupplyState,
    };
    const party = await resolveSalesParty(tx, ctx, header);
    await assertOpportunity(tx, ctx.organizationId, header.customerId, data.opportunityId === undefined ? before.opportunityId : data.opportunityId);

    const existingLines = await tx.quotationLine.findMany({ where: { quotationId: id }, orderBy: { sortOrder: "asc" } });
    const lineInputs =
      data.lines ??
      existingLines.map((l) => ({
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        uomId: l.uomId,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent,
        taxRateId: l.taxRateId,
      }));
    const priced = await priceLines(tx, ctx.organizationId, lineInputs, { intraState: party.intraState, customerId: header.customerId });

    await tx.quotationLine.deleteMany({ where: { quotationId: id } });
    const quotation = await tx.quotation.update({
      where: { id },
      data: {
        customerId: header.customerId,
        contactId: header.contactId,
        opportunityId: data.opportunityId === undefined ? before.opportunityId : data.opportunityId,
        placeOfSupplyState: party.placeOfSupplyState,
        validUntil: data.validUntil ?? before.validUntil,
        currency: data.currency ?? before.currency,
        terms: data.terms === undefined ? before.terms : data.terms,
        notes: data.notes === undefined ? before.notes : data.notes,
        ...priced.totals,
        lines: { create: priced.lines },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, {
      action: "quotation.updated",
      entity: "quotation",
      entityId: id,
      companyId: before.companyId,
      previous: { grandTotal: before.grandTotal, lines: existingLines.length },
      next: { grandTotal: quotation.grandTotal, lines: quotation.lines.length },
    });
    return quotation;
  });
}

/** Locks the row for the rest of the transaction and checks scope. */
async function lockQuotation(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "quotations" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const quotation = await tx.quotation.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!quotation) throw new AppError("NOT_FOUND", "Quotation not found", 404);
  assertCompanyAccess(ctx, quotation.companyId, quotation.branchId);
  return quotation;
}

/** Why a quotation needs approval under the company's thresholds (null = auto-approve). */
export function approvalReason(
  quotation: { grandTotal: Prisma.Decimal },
  lines: { discountPercent: Prisma.Decimal }[],
  settings: ReturnType<typeof companySettings>,
) {
  const reasons: string[] = [];
  const maxDiscount = lines.reduce((max, l) => (l.discountPercent.gt(max) ? l.discountPercent : max), dec(0));
  if (maxDiscount.gt(settings.quotation.approvalDiscountPercent)) {
    reasons.push(`Discount ${maxDiscount.toString()}% exceeds ${settings.quotation.approvalDiscountPercent}%`);
  }
  if (settings.quotation.approvalAmount !== null && quotation.grandTotal.gt(settings.quotation.approvalAmount)) {
    reasons.push(`Total ${quotation.grandTotal.toFixed(2)} exceeds ${settings.quotation.approvalAmount}`);
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/** Same friendly message whether the field is missing or blank. */
const requiredText = (message: string) =>
  z.string({ required_error: message }).trim().min(1, message).max(1000);

const actionSchemas = {
  submit: z.object({}),
  approve: z.object({ note: z.string().trim().max(1000).optional() }),
  return: z.object({ note: requiredText("Explain what needs to change") }),
  send: z.object({}),
  accept: z.object({}),
  reject: z.object({ reason: requiredText("A rejection reason is required") }),
  cancel: z.object({ reason: z.string().trim().max(1000).optional() }),
};

export type QuotationAction = keyof typeof actionSchemas;
export const QUOTATION_ACTIONS = Object.keys(actionSchemas) as QuotationAction[];

/**
 * Quotation state machine:
 *   DRAFT --submit--> PENDING_APPROVAL (thresholds exceeded) | APPROVED
 *   PENDING_APPROVAL --approve--> APPROVED     --return--> DRAFT (approver's note)
 *   APPROVED --send--> SENT
 *   APPROVED|SENT --accept--> ACCEPTED (must still be valid) | --reject--> REJECTED
 *   APPROVED|SENT --(job, validUntil passed)--> EXPIRED
 *   DRAFT|PENDING_APPROVAL|APPROVED|SENT --cancel--> CANCELLED
 *   APPROVED|SENT|REJECTED|EXPIRED|PENDING_APPROVAL --revise--> new DRAFT revision; old SUPERSEDED
 */
export async function transitionQuotation(ctx: AccessContext, id: string, action: QuotationAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as Record<string, string | undefined>;
  assertCan(
    ctx,
    action === "approve" || action === "return" ? "quotation.approve" : action === "cancel" ? "quotation.delete" : "quotation.update",
  );

  return prisma.$transaction(async (tx) => {
    const q = await lockQuotation(tx, ctx, id);
    const now = new Date();
    const expect = (...allowed: QuotationStatus[]) => {
      if (!allowed.includes(q.status)) {
        throw new AppError("INVALID_STATE", `Cannot ${action} a quotation that is ${q.status}`, 422);
      }
    };
    let data: Prisma.QuotationUncheckedUpdateInput;

    switch (action) {
      case "submit": {
        expect(S.DRAFT);
        if (q.validUntil < today()) throw new AppError("INVALID_STATE", "Quotation has expired; update the valid-until date", 422);
        const lines = await tx.quotationLine.findMany({ where: { quotationId: id } });
        if (lines.length === 0) throw new AppError("INVALID_STATE", "Add at least one line before submitting", 422);
        const company = await tx.company.findUniqueOrThrow({ where: { id: q.companyId }, select: { settings: true } });
        const reason = approvalReason(q, lines, companySettings(company.settings));
        data = reason
          ? { status: S.PENDING_APPROVAL, approvalRequired: true, approvalReason: reason, submittedAt: now }
          : { status: S.APPROVED, approvalRequired: false, approvalReason: null, submittedAt: now, approvedAt: now, approvedById: null };
        break;
      }
      case "approve":
        expect(S.PENDING_APPROVAL);
        // Segregation of duties: the author cannot approve their own quotation.
        if (q.createdById === ctx.userId && !ctx.isOwner) {
          throw new AppError("FORBIDDEN", "You cannot approve a quotation you created", 403);
        }
        data = { status: S.APPROVED, approvedById: ctx.userId, approvedAt: now, approvalNote: body.note ?? null };
        break;
      case "return":
        expect(S.PENDING_APPROVAL);
        data = { status: S.DRAFT, approvalNote: body.note, submittedAt: null };
        break;
      case "send":
        expect(S.APPROVED);
        data = { status: S.SENT, sentAt: now };
        break;
      case "accept":
        expect(S.APPROVED, S.SENT);
        if (q.validUntil < today()) throw new AppError("INVALID_STATE", "Quotation has expired; revise it before accepting", 422);
        data = { status: S.ACCEPTED, decidedAt: now };
        break;
      case "reject":
        expect(S.APPROVED, S.SENT);
        data = { status: S.REJECTED, decidedAt: now, rejectionReason: body.reason };
        break;
      case "cancel":
        expect(S.DRAFT, S.PENDING_APPROVAL, S.APPROVED, S.SENT);
        data = { status: S.CANCELLED, rejectionReason: body.reason ?? null };
        break;
    }

    const updated = await tx.quotation.update({ where: { id }, data: data! });

    if (action === "accept" && q.opportunityId) {
      const opportunity = await tx.opportunity.findUnique({ where: { id: q.opportunityId }, select: { stage: true } });
      if (opportunity && !isClosed(opportunity.stage)) {
        await changeOpportunityStage(ctx, q.opportunityId, { stage: "WON" }, tx);
      }
    }
    await audit(tx, ctx, {
      action: `quotation.${action}`,
      entity: "quotation",
      entityId: id,
      companyId: q.companyId,
      previous: { status: q.status },
      next: { status: updated.status, ...body },
    });
    return updated;
  });
}

/** New DRAFT revision copying the lines; the current revision becomes SUPERSEDED. */
export async function reviseQuotation(ctx: AccessContext, id: string) {
  assertCan(ctx, "quotation.create");
  return prisma.$transaction(async (tx) => {
    const q = await lockQuotation(tx, ctx, id);
    const revisable: QuotationStatus[] = [S.PENDING_APPROVAL, S.APPROVED, S.SENT, S.REJECTED, S.EXPIRED];
    if (!revisable.includes(q.status)) {
      throw new AppError("INVALID_STATE", `A ${q.status} quotation cannot be revised`, 422);
    }
    const lines = await tx.quotationLine.findMany({ where: { quotationId: id }, orderBy: { sortOrder: "asc" } });
    await tx.quotation.update({ where: { id }, data: { status: S.SUPERSEDED } });
    const validUntil = q.validUntil < today() ? new Date(today().getTime() + 30 * 86_400_000) : q.validUntil;
    const revision = await tx.quotation.create({
      data: {
        organizationId: q.organizationId,
        companyId: q.companyId,
        branchId: q.branchId,
        number: q.number,
        revision: q.revision + 1,
        previousRevisionId: q.id,
        customerId: q.customerId,
        contactId: q.contactId,
        opportunityId: q.opportunityId,
        validUntil,
        currency: q.currency,
        placeOfSupplyState: q.placeOfSupplyState,
        terms: q.terms,
        notes: q.notes,
        subtotal: q.subtotal,
        discountTotal: q.discountTotal,
        taxableTotal: q.taxableTotal,
        taxTotal: q.taxTotal,
        grandTotal: q.grandTotal,
        createdById: ctx.userId,
        lines: {
          // organizationId comes from the parent through the composite relation
          create: lines.map(copyLine),
        },
      },
    });
    await audit(tx, ctx, {
      action: "quotation.revised",
      entity: "quotation",
      entityId: revision.id,
      companyId: q.companyId,
      previous: { id: q.id, revision: q.revision, status: q.status },
      next: { id: revision.id, revision: revision.revision },
    });
    return revision;
  });
}

/**
 * ACCEPTED quotation -> DRAFT sales order with the same lines. Retry-safe: a
 * quotation converts at most once (unique quotationId); repeats return that order.
 */
export async function convertQuotationToOrder(ctx: AccessContext, id: string) {
  assertCan(ctx, "sales_order.create");
  try {
    return await prisma.$transaction(async (tx) => {
      const q = await lockQuotation(tx, ctx, id);
      const existing = await tx.salesOrder.findFirst({ where: { organizationId: ctx.organizationId, quotationId: id } });
      if (existing) return { salesOrder: existing, alreadyConverted: true };
      if (q.status !== S.ACCEPTED) {
        throw new AppError("INVALID_STATE", "Only accepted quotations can be converted to an order", 422);
      }
      const lines = await tx.quotationLine.findMany({ where: { quotationId: id }, orderBy: { sortOrder: "asc" } });
      const salesOrder = await tx.salesOrder.create({
        data: {
          organizationId: q.organizationId,
          companyId: q.companyId,
          branchId: q.branchId,
          number: await nextDocumentNumber(tx, q.organizationId, q.companyId, "sales_order"),
          quotationId: q.id,
          customerId: q.customerId,
          contactId: q.contactId,
          currency: q.currency,
          placeOfSupplyState: q.placeOfSupplyState,
          notes: q.notes,
          subtotal: q.subtotal,
          discountTotal: q.discountTotal,
          taxableTotal: q.taxableTotal,
          taxTotal: q.taxTotal,
          grandTotal: q.grandTotal,
          createdById: ctx.userId,
          lines: {
            create: lines.map((line) => ({ ...copyLine(line), quotationLineId: line.id })),
          },
        },
      });
      await audit(tx, ctx, {
        action: "quotation.converted",
        entity: "quotation",
        entityId: id,
        companyId: q.companyId,
        next: { salesOrderId: salesOrder.id, number: salesOrder.number },
      });
      return { salesOrder, alreadyConverted: false };
    });
  } catch (error) {
    // Lost a race with a concurrent conversion: return the order it created.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const salesOrder = await prisma.salesOrder.findFirst({ where: { organizationId: ctx.organizationId, quotationId: id } });
      if (salesOrder) return { salesOrder, alreadyConverted: true };
    }
    throw error;
  }
}

/** Job: APPROVED/SENT quotations past their valid-until date become EXPIRED. */
export async function expireQuotations(now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const due = await prisma.quotation.findMany({
    where: { status: { in: [S.APPROVED, S.SENT] }, validUntil: { lt: cutoff } },
    select: { id: true, organizationId: true, companyId: true, status: true },
    take: 1000,
  });
  for (const q of due) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.quotation.updateMany({ where: { id: q.id, status: q.status }, data: { status: S.EXPIRED } });
      if (count === 0) return;
      await tx.auditLog.create({
        data: {
          organizationId: q.organizationId,
          companyId: q.companyId,
          action: "quotation.expired",
          entity: "quotation",
          entityId: q.id,
          previous: { status: q.status },
          next: { status: S.EXPIRED },
        },
      });
    });
  }
  return { expired: due.length };
}
