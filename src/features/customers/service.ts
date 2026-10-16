import { z } from "zod";
import {
  ActivityType,
  CommunicationDirection,
  CustomerType,
  RecordStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";
import { orgSettings, orgSettingsSchema } from "@/lib/settings";
import { assertActiveMember } from "@/lib/tenant/refs";

const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) => text(max).nullish().or(z.literal("").transform(() => null));
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
const email = z.string().trim().toLowerCase().email();

const customerSchema = z.object({
  code: nullableText(32),
  name: text(200).min(1),
  legalName: nullableText(200),
  type: z.nativeEnum(CustomerType).optional(),
  email: email.nullish().or(z.literal("").transform(() => null)),
  phone: nullableText(40),
  website: nullableText(200),
  gstin: gstin.nullish().or(z.literal("").transform(() => null)),
  pan: nullableText(10),
  stateCode: z.string().regex(/^[0-9]{2}$/).nullish().or(z.literal("").transform(() => null)),
  billingAddress: nullableText(500),
  shippingAddress: nullableText(500),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).nullish(),
  creditLimit: zDecimal().nullish(),
  ownerUserId: z.string().uuid().nullish(),
  notes: nullableText(4000),
});

const customerListSchema = listQuerySchema.extend({
  status: z.nativeEnum(RecordStatus).optional(),
  ownerUserId: z.string().uuid().optional(),
});

// ─── Duplicate detection ─────────────────────────────────────────────────────

export type CustomerMatch = { id: string; name: string; gstin: string | null; email: string | null; phone: string | null; matchedOn: string[] };

const lastDigits = (phone?: string | null) => (phone ?? "").replace(/\D/g, "").slice(-10);

/**
 * Existing customers matching any enabled rule (org setting `duplicates.customer`):
 * gstin (exact), email (case-insensitive), phone (last 10 digits), name (case-insensitive).
 */
export async function findDuplicateCustomers(
  organizationId: string,
  input: { gstin?: string | null; email?: string | null; phone?: string | null; name?: string | null },
  excludeId?: string,
): Promise<CustomerMatch[]> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const rules = orgSettings(org?.settings).duplicates.customer;
  const phone = lastDigits(input.phone);
  const or: Prisma.CustomerWhereInput[] = [];
  if (rules.includes("gstin") && input.gstin) or.push({ gstin: input.gstin.toUpperCase() });
  if (rules.includes("email") && input.email) or.push({ email: { equals: input.email, mode: "insensitive" } });
  if (rules.includes("phone") && phone.length >= 7) or.push({ phone: { endsWith: phone } });
  if (rules.includes("name") && input.name) or.push({ name: { equals: input.name.trim(), mode: "insensitive" } });
  if (or.length === 0) return [];

  const rows = await prisma.customer.findMany({
    where: { organizationId, status: { not: RecordStatus.ARCHIVED }, id: excludeId ? { not: excludeId } : undefined, OR: or },
    select: { id: true, name: true, gstin: true, email: true, phone: true },
    take: 10,
  });
  return rows.map((row) => ({
    ...row,
    matchedOn: [
      rules.includes("gstin") && input.gstin && row.gstin === input.gstin.toUpperCase() ? "gstin" : null,
      rules.includes("email") && input.email && row.email?.toLowerCase() === input.email.toLowerCase() ? "email" : null,
      rules.includes("phone") && phone.length >= 7 && lastDigits(row.phone) === phone ? "phone" : null,
      rules.includes("name") && input.name && row.name.toLowerCase() === input.name.trim().toLowerCase() ? "name" : null,
    ].filter((m): m is string => Boolean(m)),
  }));
}

export function duplicateError(matches: CustomerMatch[]) {
  return new AppError(
    "DUPLICATE",
    "Possible duplicate customers found. Link one of them or confirm to create anyway.",
    409,
    matches,
  );
}

// ─── Customers ───────────────────────────────────────────────────────────────

export async function listCustomers(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "customer.view");
  const q = customerListSchema.parse(query);
  const where: Prisma.CustomerWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status ?? { not: RecordStatus.ARCHIVED },
    ownerUserId: q.ownerUserId,
    ...searchWhere(q.q, ["name", "legalName", "email", "phone", "gstin", "code"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.customer.findMany({
        where,
        include: { owner: { select: { id: true, name: true, email: true } }, _count: { select: { contacts: true, opportunities: true } } },
        ...listArgs(q, ["createdAt", "name", "updatedAt"], "name"),
      }),
      prisma.customer.count({ where }),
    ]),
  );
}

export async function getCustomer(ctx: AccessContext, id: string) {
  assertCan(ctx, "customer.view");
  const customer = await prisma.customer.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      contacts: { where: { status: { not: RecordStatus.ARCHIVED } }, orderBy: [{ isPrimary: "desc" }, { fullName: "asc" }] },
      convertedLeads: { select: { id: true, fullName: true, convertedAt: true } },
    },
  });
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
  return customer;
}

export async function createCustomer(
  ctx: AccessContext,
  input: unknown,
  tx: Prisma.TransactionClient | null = null,
) {
  assertCan(ctx, "customer.create");
  const { ignoreDuplicates, ...raw } = z
    .object({ ignoreDuplicates: z.boolean().optional() })
    .passthrough()
    .parse(input);
  const data = customerSchema.parse(raw);
  if (data.ownerUserId) await assertActiveMember(ctx.organizationId, data.ownerUserId);
  if (!ignoreDuplicates) {
    const matches = await findDuplicateCustomers(ctx.organizationId, data);
    if (matches.length > 0) throw duplicateError(matches);
  }

  const run = async (db: Prisma.TransactionClient) => {
    const customer = await db.customer.create({
      data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId, ownerUserId: data.ownerUserId ?? ctx.userId },
    });
    await audit(db, ctx, { action: "customer.created", entity: "customer", entityId: customer.id, next: customer });
    return customer;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function updateCustomer(ctx: AccessContext, id: string, input: unknown) {
  const data = customerSchema.partial().extend({ status: z.nativeEnum(RecordStatus).optional() }).parse(input);
  assertCan(ctx, data.status === RecordStatus.ARCHIVED ? "customer.delete" : "customer.update");
  if (data.ownerUserId) await assertActiveMember(ctx.organizationId, data.ownerUserId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.customer.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Customer not found", 404);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const customer = await tx.customer.update({ where: { id }, data });
    await audit(tx, ctx, {
      action: data.status === RecordStatus.ARCHIVED ? "customer.archived" : "customer.updated",
      entity: "customer",
      entityId: id,
      previous: diff.previous,
      next: diff.next,
    });
    return customer;
  });
}

// ─── Contacts ────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  customerId: z.string().min(1).nullish(),
  firstName: text(80).min(1),
  lastName: nullableText(80),
  email: email.nullish().or(z.literal("").transform(() => null)),
  phone: nullableText(40),
  jobTitle: nullableText(120),
  isPrimary: z.boolean().optional(),
  notes: nullableText(4000),
});

const contactListSchema = listQuerySchema.extend({
  customerId: z.string().optional(),
  status: z.nativeEnum(RecordStatus).optional(),
});

const fullName = (c: { firstName?: string | null; lastName?: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ");

export async function listContacts(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "contact.view");
  const q = contactListSchema.parse(query);
  const where: Prisma.ContactWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status ?? { not: RecordStatus.ARCHIVED },
    customerId: q.customerId,
    ...searchWhere(q.q, ["fullName", "email", "phone", "jobTitle"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.contact.findMany({
        where,
        include: { customer: { select: { id: true, name: true } } },
        ...listArgs(q, ["createdAt", "fullName"], "fullName"),
      }),
      prisma.contact.count({ where }),
    ]),
  );
}

export async function getContact(ctx: AccessContext, id: string) {
  assertCan(ctx, "contact.view");
  const contact = await prisma.contact.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { customer: { select: { id: true, name: true } } },
  });
  if (!contact) throw new AppError("NOT_FOUND", "Contact not found", 404);
  return contact;
}

export async function createContact(ctx: AccessContext, input: unknown, tx: Prisma.TransactionClient | null = null) {
  assertCan(ctx, "contact.create");
  const data = contactSchema.parse(input);
  const run = async (db: Prisma.TransactionClient) => {
    if (data.isPrimary && data.customerId) {
      await db.contact.updateMany({ where: { organizationId: ctx.organizationId, customerId: data.customerId }, data: { isPrimary: false } });
    }
    const contact = await db.contact.create({
      data: { ...data, fullName: fullName(data), organizationId: ctx.organizationId, createdById: ctx.userId },
    });
    await audit(db, ctx, { action: "contact.created", entity: "contact", entityId: contact.id, next: contact });
    return contact;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function updateContact(ctx: AccessContext, id: string, input: unknown) {
  const data = contactSchema.partial().extend({ status: z.nativeEnum(RecordStatus).optional() }).parse(input);
  assertCan(ctx, data.status === RecordStatus.ARCHIVED ? "contact.delete" : "contact.update");
  return prisma.$transaction(async (tx) => {
    const before = await tx.contact.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Contact not found", 404);
    const patch = {
      ...data,
      ...(data.firstName !== undefined || data.lastName !== undefined
        ? { fullName: fullName({ firstName: data.firstName ?? before.firstName, lastName: data.lastName === undefined ? before.lastName : data.lastName }) }
        : {}),
    };
    const customerId = data.customerId === undefined ? before.customerId : data.customerId;
    if (data.isPrimary && customerId) {
      await tx.contact.updateMany({ where: { organizationId: ctx.organizationId, customerId, id: { not: id } }, data: { isPrimary: false } });
    }
    const diff = changes(before as Record<string, unknown>, patch);
    if (!diff.changed) return before;
    const contact = await tx.contact.update({ where: { id }, data: patch });
    await audit(tx, ctx, { action: "contact.updated", entity: "contact", entityId: id, previous: diff.previous, next: diff.next });
    return contact;
  });
}

// ─── Interactions and timeline ───────────────────────────────────────────────

const activitySchema = z
  .object({
    type: z.nativeEnum(ActivityType),
    subject: text(200).min(1),
    body: nullableText(10000),
    direction: z.nativeEnum(CommunicationDirection).nullish(),
    occurredAt: z.coerce.date().optional(),
    durationMin: z.coerce.number().int().min(0).max(24 * 60).nullish(),
    outcome: nullableText(200),
    customerId: z.string().min(1).nullish(),
    contactId: z.string().min(1).nullish(),
    opportunityId: z.string().min(1).nullish(),
  })
  .refine((a) => a.customerId || a.contactId || a.opportunityId, {
    message: "Link the interaction to a customer, contact or opportunity",
    path: ["customerId"],
  });

/** Fills in the customer from the contact/opportunity and checks they agree. */
async function resolveLinks(ctx: AccessContext, links: { customerId?: string | null; contactId?: string | null; opportunityId?: string | null }) {
  const org = ctx.organizationId;
  const [contact, opportunity] = await Promise.all([
    links.contactId ? prisma.contact.findFirst({ where: { id: links.contactId, organizationId: org }, select: { customerId: true } }) : null,
    links.opportunityId ? prisma.opportunity.findFirst({ where: { id: links.opportunityId, organizationId: org }, select: { customerId: true, contactId: true } }) : null,
  ]);
  if (links.contactId && !contact) throw new AppError("NOT_FOUND", "Contact not found", 404);
  if (links.opportunityId && !opportunity) throw new AppError("NOT_FOUND", "Opportunity not found", 404);
  const customerIds = new Set(
    [links.customerId, contact?.customerId, opportunity?.customerId].filter((v): v is string => Boolean(v)),
  );
  if (customerIds.size > 1) {
    throw new AppError("INVALID_REFERENCE", "Contact / opportunity belong to a different customer", 422);
  }
  const customerId = [...customerIds][0] ?? null;
  if (customerId && !(await prisma.customer.findFirst({ where: { id: customerId, organizationId: org }, select: { id: true } }))) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }
  return { customerId, contactId: links.contactId ?? null, opportunityId: links.opportunityId ?? null };
}

export async function logActivity(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "activity.create");
  const data = activitySchema.parse(input);
  const links = await resolveLinks(ctx, data);
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: { ...data, ...links, organizationId: ctx.organizationId, actorId: ctx.userId },
    });
    await audit(tx, ctx, { action: "activity.logged", entity: "activity", entityId: activity.id, next: activity });
    return activity;
  });
}

export type TimelineEntry = {
  id: string;
  source: "activity" | "lead";
  type: string;
  subject: string;
  body: string | null;
  occurredAt: Date;
  actor: { id: string; name: string | null } | null;
};

/**
 * Interactions for a customer / contact / opportunity, newest first. A customer's
 * timeline also includes the history of the leads it was converted from.
 */
export async function getTimeline(
  ctx: AccessContext,
  target: { customerId?: string; contactId?: string; opportunityId?: string },
  limit = 100,
): Promise<TimelineEntry[]> {
  if (target.customerId) assertCan(ctx, "customer.view");
  else if (target.contactId) assertCan(ctx, "contact.view");
  else if (target.opportunityId) assertCan(ctx, "opportunity.view");
  else throw new AppError("VALIDATION_ERROR", "A timeline target is required", 422);

  const activities = await prisma.activity.findMany({
    where: { organizationId: ctx.organizationId, ...target },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
  const entries: TimelineEntry[] = activities.map((a) => ({
    id: a.id,
    source: "activity",
    type: a.type,
    subject: a.subject,
    body: a.body,
    occurredAt: a.occurredAt,
    actor: a.actor,
  }));

  if (target.customerId && can(ctx, "lead.view")) {
    const leadEvents = await prisma.leadActivity.findMany({
      where: { organizationId: ctx.organizationId, lead: { convertedCustomerId: target.customerId } },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    entries.push(
      ...leadEvents.map((e) => ({
        id: e.id,
        source: "lead" as const,
        type: e.type,
        subject: e.message,
        body: null,
        occurredAt: e.createdAt,
        actor: e.actor,
      })),
    );
  }
  return entries.sort((x, y) => y.occurredAt.getTime() - x.occurredAt.getTime()).slice(0, limit);
}

// ─── CRM settings (duplicate matching rules) ─────────────────────────────────

export async function getCrmSettings(ctx: AccessContext) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } });
  return orgSettings(org.settings);
}

export async function updateCrmSettings(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "crm.administer");
  // Only the CRM section: parsing the whole schema would reset other sections (e.g. loyalty) to defaults.
  const next = orgSettingsSchema.pick({ duplicates: true }).parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } });
    const settings = { ...orgSettings(before.settings), ...next };
    await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings } });
    await audit(tx, ctx, {
      action: "crm.settings_updated",
      entity: "organization",
      entityId: ctx.organizationId,
      previous: before.settings,
      next: settings,
    });
    return settings;
  });
}
