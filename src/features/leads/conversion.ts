import { z } from "zod";
import { CustomerType, LeadStatus, RecordStatus, type Lead, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { zDecimal } from "@/lib/money";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { createContact, createCustomer, duplicateError, findDuplicateCustomers } from "@/features/customers/service";
import { createOpportunity } from "@/features/opportunities/service";

const convertSchema = z.object({
  /** Link to an existing customer instead of creating one. */
  customerId: z.string().min(1).optional(),
  /** Link to an existing contact of that customer. */
  contactId: z.string().min(1).optional(),
  createContact: z.boolean().default(true),
  createOpportunity: z.boolean().default(true),
  opportunity: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      amount: zDecimal().optional(),
      expectedCloseDate: z.coerce.date().optional(),
    })
    .optional(),
  /** Create a new customer even though possible duplicates exist. */
  ignoreDuplicates: z.boolean().default(false),
});

export type ConversionResult = {
  leadId: string;
  customerId: string;
  contactId: string | null;
  opportunityId: string | null;
  alreadyConverted: boolean;
};

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function customerFromLead(lead: Lead) {
  const gstin = lead.gstNo?.trim().toUpperCase();
  const validGstin = gstin && GSTIN.test(gstin) ? gstin : null;
  return {
    name: lead.company?.trim() || lead.fullName,
    type: lead.company ? CustomerType.BUSINESS : CustomerType.INDIVIDUAL,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    gstin: validGstin,
    pan: validGstin ? validGstin.slice(2, 12) : null,
    stateCode: validGstin ? validGstin.slice(0, 2) : null,
    billingAddress: [lead.address, lead.city, lead.state, lead.postalCode, lead.country].filter(Boolean).join(", ") || null,
    ownerUserId: lead.assignedUserId,
  };
}

async function existingResult(db: Prisma.TransactionClient, lead: Pick<Lead, "id" | "organizationId" | "convertedCustomerId" | "convertedContactId">) {
  const opportunity = await db.opportunity.findFirst({
    where: { organizationId: lead.organizationId, leadId: lead.id },
    select: { id: true },
  });
  return {
    leadId: lead.id,
    customerId: lead.convertedCustomerId!,
    contactId: lead.convertedContactId,
    opportunityId: opportunity?.id ?? null,
    alreadyConverted: true,
  };
}

/**
 * Convert a lead into customer (+ contact, + opportunity) in one transaction.
 * Retry-safe: the lead row is locked and a lead that is already converted returns
 * the original result instead of creating anything again. New customers go through
 * duplicate detection unless `ignoreDuplicates` or an existing `customerId` is given.
 */
export async function convertLead(ctx: AccessContext, leadId: string, input: unknown): Promise<ConversionResult> {
  assertCan(ctx, "lead.convert");
  const data = convertSchema.parse(input);

  const lead = await prisma.lead.findFirst({ where: { id: leadId, ...leadVisibilityWhere(ctx), archivedAt: null } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead not found", 404);
  if (lead.convertedCustomerId) return prisma.$transaction((tx) => existingResult(tx, lead));

  const customerInput = customerFromLead(lead);
  if (!data.customerId) {
    assertCan(ctx, "customer.create");
    if (!data.ignoreDuplicates) {
      const matches = await findDuplicateCustomers(ctx.organizationId, customerInput);
      if (matches.length > 0) throw duplicateError(matches);
    }
  }
  if (data.createOpportunity) assertCan(ctx, "opportunity.create");
  if (data.createContact && !data.contactId) assertCan(ctx, "contact.create");

  return prisma.$transaction(async (tx) => {
    // Serialize concurrent conversions of the same lead.
    const [locked] = await tx.$queryRaw<{ convertedCustomerId: string | null; convertedContactId: string | null }[]>`
      SELECT "convertedCustomerId", "convertedContactId" FROM "leads" WHERE "id" = ${leadId} FOR UPDATE`;
    if (locked?.convertedCustomerId) return existingResult(tx, { ...lead, ...locked });

    let customerId = data.customerId;
    if (customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, organizationId: ctx.organizationId, status: { not: RecordStatus.ARCHIVED } },
        select: { id: true },
      });
      if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
    } else {
      customerId = (await createCustomer(ctx, { ...customerInput, ignoreDuplicates: true }, tx)).id;
    }

    let contactId: string | null = null;
    if (data.contactId) {
      const contact = await tx.contact.findFirst({
        where: { id: data.contactId, organizationId: ctx.organizationId, customerId },
        select: { id: true },
      });
      if (!contact) throw new AppError("INVALID_REFERENCE", "Contact does not belong to this customer", 422);
      contactId = contact.id;
    } else if (data.createContact) {
      // Reuse the customer's contact with the same email/phone rather than duplicating it.
      const match = await tx.contact.findFirst({
        where: {
          organizationId: ctx.organizationId,
          customerId,
          OR: [
            ...(lead.email ? [{ email: { equals: lead.email, mode: "insensitive" as const } }] : []),
            ...(lead.phone ? [{ phone: lead.phone }] : []),
          ],
        },
        select: { id: true },
      });
      contactId = match?.id ?? null; // an empty OR (no email/phone) matches nothing
      if (!contactId) {
        contactId = (
          await createContact(
            ctx,
            {
              customerId,
              firstName: lead.firstName || lead.fullName,
              lastName: lead.firstName ? lead.lastName : null,
              email: lead.email,
              phone: lead.phone,
              jobTitle: lead.jobTitle,
              isPrimary: true,
            },
            tx,
          )
        ).id;
      }
    }

    let opportunityId: string | null = null;
    if (data.createOpportunity) {
      const customerName = (await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true } })).name;
      opportunityId = (
        await createOpportunity(
          ctx,
          {
            name: data.opportunity?.name ?? `${customerName} – ${lead.productInterest ?? lead.requirement ?? "New deal"}`.slice(0, 200),
            customerId,
            contactId,
            leadId,
            amount: data.opportunity?.amount ?? lead.expectedValue ?? "0",
            expectedCloseDate: data.opportunity?.expectedCloseDate ?? null,
            ownerUserId: lead.assignedUserId,
          },
          tx,
        )
      ).id;
    }

    const now = new Date();
    await tx.lead.update({
      where: { id: leadId },
      data: {
        status: LeadStatus.CONVERTED,
        convertedAt: lead.convertedAt ?? now,
        convertedCustomerId: customerId,
        convertedContactId: contactId,
      },
    });
    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId,
        actorId: ctx.userId,
        type: "CONVERTED",
        message: "Lead converted to customer",
        next: { customerId, contactId, opportunityId },
      },
    });
    await audit(tx, ctx, {
      action: "lead.converted",
      entity: "lead",
      entityId: leadId,
      previous: { status: lead.status },
      next: { status: LeadStatus.CONVERTED, customerId, contactId, opportunityId },
    });
    return { leadId, customerId, contactId, opportunityId, alreadyConverted: false };
  });
}
