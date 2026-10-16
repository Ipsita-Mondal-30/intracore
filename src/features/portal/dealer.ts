import { z } from "zod";
import { RecordStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";
import { isIntraState, zDecimal } from "@/lib/money";
import { priceLines } from "@/features/sales/pricing";
import { notFound, type PortalContext } from "@/features/portal/context";
import { customerOf } from "@/features/portal/customer";

/**
 * Dealer portal extras (dealers also get every customer view for their own customer).
 * Authorized catalog = the dealer's CustomerPrice rows: product name/sku/uom/tax and the
 * dealer's own price. Never selected: cost (purchasePrice), list price, other customers'
 * prices. An order request becomes a DRAFT quotation for internal review.
 */

export async function listCatalog(p: PortalContext) {
  const { organizationId, customerId } = customerOf(p);
  return prisma.customerPrice.findMany({
    where: { organizationId, customerId, product: { status: RecordStatus.ACTIVE } },
    select: {
      unitPrice: true,
      updatedAt: true,
      product: {
        select: { id: true, sku: true, name: true, description: true, hsnCode: true, uom: { select: { code: true, name: true } }, taxRate: { select: { name: true, rate: true } } },
      },
    },
    orderBy: { product: { name: "asc" } },
  });
}

const requestSchema = z.object({
  companyId: z.string().min(1).nullish(),
  customerPoNumber: z.string().trim().max(64).nullish(),
  remarks: z.string().trim().max(2000).nullish(),
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be greater than zero") }))
    .min(1, "Add at least one line")
    .max(200),
});

export const PORTAL_REQUEST_NOTE = "Portal request";

/**
 * Order request → DRAFT quotation priced by the normal sales rules (priceLines: the dealer's
 * CustomerPrice, product tax rate, GST split from branch state vs the dealer's state).
 * Only authorized products are accepted and the dealer cannot set price, discount or tax.
 * Branch = the company's first active branch; staff review, adjust and submit it as usual.
 */
export async function createOrderRequest(p: PortalContext, input: unknown) {
  const { organizationId, customerId } = customerOf(p);
  const data = requestSchema.parse(input);
  const productIds = [...new Set(data.lines.map((l) => l.productId))];
  return prisma.$transaction(async (tx) => {
    const authorized = await tx.customerPrice.findMany({ where: { organizationId, customerId, productId: { in: productIds } }, select: { productId: true } });
    if (authorized.length !== productIds.length) throw new AppError("INVALID_REFERENCE", "Only products in your authorized catalog can be ordered", 422);

    const company = await tx.company.findFirst({
      where: { organizationId, status: RecordStatus.ACTIVE, ...(data.companyId ? { id: data.companyId } : {}) },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true, stateCode: true, baseCurrency: true, settings: true, branches: { where: { isActive: true }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true, stateCode: true } } },
    });
    if (!company) throw notFound("Company");
    const branch = company.branches[0];
    if (!branch) throw new AppError("INVALID_STATE", "The company has no active branch", 422);
    const customer = await tx.customer.findFirstOrThrow({ where: { id: customerId, organizationId }, select: { stateCode: true } });
    const placeOfSupplyState = customer.stateCode ?? null;
    const priced = await priceLines(tx, organizationId, data.lines, {
      intraState: isIntraState(branch.stateCode ?? company.stateCode, placeOfSupplyState),
      customerId,
    });
    const today = new Date(new Date().toISOString().slice(0, 10));
    const validity = companySettings(company.settings).quotation.defaultValidityDays;
    const notes = [PORTAL_REQUEST_NOTE, data.customerPoNumber ? `Dealer PO: ${data.customerPoNumber}` : null, data.remarks || null].filter(Boolean).join("\n");

    const quotation = await tx.quotation.create({
      data: {
        organizationId,
        companyId: company.id,
        branchId: branch.id,
        number: await nextDocumentNumber(tx, organizationId, company.id, "quotation"),
        customerId,
        validUntil: new Date(today.getTime() + validity * 86_400_000),
        currency: company.baseCurrency,
        placeOfSupplyState,
        notes,
        ...priced.totals,
        createdById: p.userId,
        lines: { create: priced.lines },
      },
      select: { id: true, number: true, status: true, grandTotal: true },
    });
    await audit(tx, p, { action: "quotation.portal_requested", entity: "quotation", entityId: quotation.id, companyId: company.id, next: { ...quotation, portalAccountId: p.accountId } });
    return quotation;
  });
}

/** The dealer's own requests, including drafts still under internal review. */
export function listOrderRequests(p: PortalContext) {
  return prisma.quotation.findMany({
    where: { ...customerOf(p), createdById: p.userId, notes: { startsWith: PORTAL_REQUEST_NOTE } },
    select: { id: true, number: true, status: true, issueDate: true, currency: true, grandTotal: true, salesOrder: { select: { id: true, number: true, status: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
