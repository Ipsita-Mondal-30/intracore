import { z } from "zod";
import { LeadPriority, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError, isAppError } from "@/lib/errors";
import { assertCan, buildAccessContext, can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { createSystemNotification } from "@/lib/notifications/create";
import { ACTIVE_TICKET, resolveSlaPolicy, slaDueDates } from "@/features/service/sla";

/**
 * Service tickets: NEW → OPEN (assigned) → IN_PROGRESS ⇄ ON_HOLD → RESOLVED → CLOSED;
 * RESOLVED/CLOSED reopen to OPEN; NEW/OPEN/IN_PROGRESS/ON_HOLD can be cancelled.
 *
 * Access: `ticket.assign` holders (service managers, admins) see every ticket in their company
 * scope; others with `ticket.view` (e.g. technicians) see tickets assigned to or created by
 * them. Out-of-scope ids answer 404. `ticket.create` opens tickets, `ticket.update` works them
 * (status, messages, feedback), `ticket.assign` assigns technicians.
 *
 * SLA due dates are computed at create and recomputed on priority/policy change (see sla.ts).
 * Messages are INTERNAL notes (never customer-visible) or PUBLIC replies; the first PUBLIC
 * staff reply stamps firstRespondedAt. Resolving requires a resolution code; feedback
 * (rating 1–5) is accepted only once the ticket is RESOLVED or CLOSED.
 */

export const TICKET_STATUSES = ["NEW", "OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED", "CANCELLED"] as const;
export const TICKET_SOURCES = ["EMAIL", "PHONE", "PORTAL", "WALK_IN", "OTHER"] as const;
export const RESOLUTION_CODES = ["FIXED", "PART_REPLACED", "WORKAROUND", "CONFIGURATION", "CUSTOMER_EDUCATION", "NO_FAULT_FOUND", "DUPLICATE", "WONT_FIX"] as const;

const refs = {
  customerId: z.string().min(1).nullish(),
  contactId: z.string().min(1).nullish(),
  assetId: z.string().min(1).nullish(),
  categoryId: z.string().min(1).nullish(),
  slaPolicyId: z.string().min(1).nullish(),
};
const createSchema = z.object({
  companyId: z.string().min(1),
  subject: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20000).nullish(),
  priority: z.nativeEnum(LeadPriority).default("MEDIUM"),
  source: z.enum(TICKET_SOURCES).default("OTHER"),
  assigneeId: z.string().uuid().nullish(),
  ...refs,
});
const updateSchema = z
  .object({
    subject: z.string().trim().min(1).max(300),
    description: z.string().trim().max(20000).nullish(),
    priority: z.nativeEnum(LeadPriority),
    source: z.enum(TICKET_SOURCES),
    ...refs,
  })
  .partial();

type Db = Prisma.TransactionClient;

/** Tickets the caller may see. */
export function ticketScope(ctx: AccessContext): Prisma.TicketWhereInput {
  const base = { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } };
  return can(ctx, "ticket.assign") ? base : { ...base, OR: [{ assigneeId: ctx.userId }, { createdById: ctx.userId }] };
}

async function lockTicket(tx: Db, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "tickets" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const ticket = await tx.ticket.findFirst({ where: { id, ...ticketScope(ctx) } });
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found", 404);
  return ticket;
}

const invalid = (what: string) => new AppError("INVALID_REFERENCE", `${what} does not belong to this organization`, 422);

async function validateRefs(tx: Db, ctx: AccessContext, r: { customerId?: string | null; contactId?: string | null; assetId?: string | null; categoryId?: string | null }) {
  const organizationId = ctx.organizationId;
  const [customer, contact, asset, category] = await Promise.all([
    r.customerId ? tx.customer.findFirst({ where: { id: r.customerId, organizationId }, select: { id: true } }) : true,
    r.contactId ? tx.contact.findFirst({ where: { id: r.contactId, organizationId }, select: { customerId: true } }) : true,
    r.assetId ? tx.asset.findFirst({ where: { id: r.assetId, organizationId }, select: { id: true } }) : true,
    r.categoryId ? tx.ticketCategory.findFirst({ where: { id: r.categoryId, organizationId, isActive: true }, select: { id: true } }) : true,
  ]);
  if (!customer) throw invalid("Customer");
  if (!contact) throw invalid("Contact");
  if (!asset) throw invalid("Asset");
  if (!category) throw new AppError("INVALID_REFERENCE", "Unknown or inactive ticket category", 422);
  if (r.customerId && contact !== true && contact.customerId !== r.customerId) {
    throw new AppError("INVALID_REFERENCE", "Contact does not belong to the selected customer", 422);
  }
}

/** Assignees (technicians) must be active members who can see tickets in the ticket's company. */
async function assertAssignable(ctx: AccessContext, userId: string, companyId: string) {
  const target = await buildAccessContext(userId, ctx.organizationId).catch((e) => {
    if (isAppError(e)) throw new AppError("INVALID_REFERENCE", "Assignee is not an active member", 422);
    throw e;
  });
  if (!can(target, "ticket.view") || !target.companies.has(companyId)) {
    throw new AppError("INVALID_REFERENCE", "Assignee cannot work on tickets in this company", 422);
  }
}

function notifyAssigned(ctx: AccessContext, t: { id: string; number: string; subject: string; assigneeId: string | null }) {
  if (!t.assigneeId || t.assigneeId === ctx.userId) return;
  return createSystemNotification({
    organizationId: ctx.organizationId,
    userId: t.assigneeId,
    type: "TICKET_ASSIGNED",
    title: `Ticket ${t.number} assigned to you`,
    body: t.subject,
    data: { ticketId: t.id, href: `/service/tickets/${t.id}` },
  }).catch((e) => console.error("[tickets] notification failed", e));
}

export async function createTicket(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "ticket.create");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  if (data.assigneeId) {
    assertCan(ctx, "ticket.assign");
    await assertAssignable(ctx, data.assigneeId, data.companyId);
  }
  const ticket = await prisma.$transaction(async (tx) => {
    await validateRefs(tx, ctx, data);
    const policy = await resolveSlaPolicy(tx, ctx.organizationId, data.priority, data.slaPolicyId);
    const now = new Date();
    const ticket = await tx.ticket.create({
      data: {
        ...data,
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "ticket", now),
        status: data.assigneeId ? "OPEN" : "NEW",
        slaPolicyId: policy?.id ?? null,
        ...slaDueDates(policy, now),
        createdById: ctx.userId,
        createdAt: now,
      },
    });
    await audit(tx, ctx, { action: "ticket.created", entity: "ticket", entityId: ticket.id, companyId: ticket.companyId, next: ticket });
    return ticket;
  });
  await notifyAssigned(ctx, ticket);
  return ticket;
}

export async function updateTicket(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "ticket.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, ctx, id);
    if (ticket.status === "CLOSED" || ticket.status === "CANCELLED") throw new AppError("INVALID_STATE", `Cannot edit a ${ticket.status} ticket`, 422);
    const keep = <T,>(next: T | undefined, current: T) => (next === undefined ? current : next);
    await validateRefs(tx, ctx, { customerId: keep(data.customerId, ticket.customerId), contactId: keep(data.contactId, ticket.contactId), assetId: data.assetId, categoryId: data.categoryId });
    let sla: Prisma.TicketUncheckedUpdateInput = {};
    const priority = data.priority ?? ticket.priority;
    if (priority !== ticket.priority || (data.slaPolicyId !== undefined && data.slaPolicyId !== ticket.slaPolicyId)) {
      // A changed priority re-picks the policy unless one is named; due dates run from creation.
      const policyId = data.slaPolicyId !== undefined ? data.slaPolicyId : priority !== ticket.priority ? null : ticket.slaPolicyId;
      const policy = await resolveSlaPolicy(tx, ctx.organizationId, priority, policyId);
      sla = { slaPolicyId: policy?.id ?? null, ...slaDueDates(policy, ticket.createdAt), escalationLevel: 0, escalatedAt: null };
    }
    const updated = await tx.ticket.update({ where: { id }, data: { ...data, ...sla } });
    const diff = changes(ticket as unknown as Record<string, unknown>, { ...data, ...sla } as Record<string, unknown>);
    if (diff.changed) await audit(tx, ctx, { action: "ticket.updated", entity: "ticket", entityId: id, companyId: ticket.companyId, previous: diff.previous, next: diff.next });
    return updated;
  });
}

const actionSchemas = {
  assign: z.object({ assigneeId: z.string().uuid().nullable() }),
  start: z.object({}),
  hold: z.object({ reason: z.string().trim().max(1000).optional() }),
  resolve: z.object({
    resolutionCode: z.enum(RESOLUTION_CODES, { errorMap: () => ({ message: "A valid resolution code is required" }) }),
    resolutionNotes: z.string().trim().max(10000).optional(),
  }),
  close: z.object({}),
  reopen: z.object({ reason: z.string().trim().max(1000).optional() }),
  cancel: z.object({ reason: z.string().trim().max(1000).optional() }),
  feedback: z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() }),
};
export type TicketAction = keyof typeof actionSchemas;
export const TICKET_ACTIONS = Object.keys(actionSchemas) as TicketAction[];

const FROM: Record<Exclude<TicketAction, "feedback">, string[]> = {
  assign: ACTIVE_TICKET,
  start: ["NEW", "OPEN", "ON_HOLD"],
  hold: ["OPEN", "IN_PROGRESS"],
  resolve: ACTIVE_TICKET,
  close: ["RESOLVED"],
  reopen: ["RESOLVED", "CLOSED"],
  cancel: ACTIVE_TICKET,
};

export async function transitionTicket(ctx: AccessContext, id: string, action: TicketAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown ticket action", 404);
  assertCan(ctx, action === "assign" ? "ticket.assign" : "ticket.update");
  const body = schema.parse(input ?? {}) as Record<string, unknown>;

  const { previous, updated } = await prisma.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, ctx, id);
    const allowed = action === "feedback" ? ["RESOLVED", "CLOSED"] : FROM[action];
    if (!allowed.includes(ticket.status)) {
      throw new AppError("INVALID_STATE", action === "feedback" ? "Feedback can be recorded only after the ticket is resolved" : `Cannot ${action} a ticket that is ${ticket.status}`, 422);
    }
    const now = new Date();
    let data: Prisma.TicketUncheckedUpdateInput;
    switch (action) {
      case "assign": {
        const assigneeId = body.assigneeId as string | null;
        if (assigneeId) await assertAssignable(ctx, assigneeId, ticket.companyId);
        data = { assigneeId, status: ticket.status === "NEW" && assigneeId ? "OPEN" : undefined };
        break;
      }
      case "start": data = { status: "IN_PROGRESS" }; break;
      case "hold": data = { status: "ON_HOLD" }; break;
      case "resolve": data = { status: "RESOLVED", resolvedAt: now, resolutionCode: body.resolutionCode as string, resolutionNotes: (body.resolutionNotes as string) ?? null }; break;
      case "close": data = { status: "CLOSED", closedAt: now }; break;
      case "reopen": data = { status: "OPEN", resolvedAt: null, closedAt: null, resolutionCode: null, resolutionNotes: null }; break;
      case "cancel": data = { status: "CANCELLED", closedAt: now }; break;
      case "feedback": data = { feedbackRating: body.rating as number, feedbackComment: (body.comment as string) ?? null }; break;
    }
    const updated = await tx.ticket.update({ where: { id }, data: data! });
    await audit(tx, ctx, {
      action: `ticket.${action}`, entity: "ticket", entityId: id, companyId: ticket.companyId,
      previous: { status: ticket.status, assigneeId: ticket.assigneeId },
      next: { status: updated.status, ...body },
    });
    return { previous: ticket, updated };
  });
  if (action === "assign" && updated.assigneeId !== previous.assigneeId) await notifyAssigned(ctx, updated);
  return updated;
}

const messageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(20000),
  visibility: z.enum(["INTERNAL", "PUBLIC"]).default("INTERNAL"),
  /** CUSTOMER records a reply the customer sent (phone, email) and is always PUBLIC */
  authorType: z.enum(["STAFF", "CUSTOMER"]).default("STAFF"),
});

export async function addTicketMessage(ctx: AccessContext, ticketId: string, input: unknown) {
  assertCan(ctx, "ticket.update");
  const data = messageSchema.parse(input);
  if (data.authorType === "CUSTOMER" && data.visibility !== "PUBLIC") throw new AppError("VALIDATION_ERROR", "Customer replies are public", 422);
  return prisma.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, ctx, ticketId);
    if (ticket.status === "CANCELLED") throw new AppError("INVALID_STATE", "Cannot reply to a cancelled ticket", 422);
    const message = await tx.ticketMessage.create({ data: { ...data, organizationId: ctx.organizationId, ticketId, authorUserId: ctx.userId } });
    if (data.authorType === "STAFF" && data.visibility === "PUBLIC" && !ticket.firstRespondedAt) {
      await tx.ticket.update({ where: { id: ticketId }, data: { firstRespondedAt: message.createdAt } });
    }
    await audit(tx, ctx, { action: data.visibility === "PUBLIC" ? "ticket.replied" : "ticket.noted", entity: "ticket", entityId: ticketId, companyId: ticket.companyId, next: { messageId: message.id, visibility: data.visibility } });
    return message;
  });
}

/** Messages on a visible ticket; `visibility=PUBLIC` returns only what the customer may see. */
export async function listTicketMessages(ctx: AccessContext, ticketId: string, query: unknown) {
  assertCan(ctx, "ticket.view");
  const { visibility } = z.object({ visibility: z.enum(["INTERNAL", "PUBLIC"]).optional() }).parse(query);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, ...ticketScope(ctx) }, select: { id: true } });
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found", 404);
  return prisma.ticketMessage.findMany({ where: { ticketId, visibility }, orderBy: { createdAt: "asc" } });
}

const listSchema = listQuerySchema.extend({
  status: z.enum(TICKET_STATUSES).optional(),
  open: z.enum(["true", "false"]).optional(),
  priority: z.nativeEnum(LeadPriority).optional(),
  assigneeId: z.string().optional(),
  unassigned: z.enum(["true", "false"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  customerId: z.string().optional(),
  categoryId: z.string().optional(),
  companyId: z.string().optional(),
  breached: z.enum(["true", "false"]).optional(),
});

export async function listTickets(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "ticket.view");
  const q = listSchema.parse(query);
  const where: Prisma.TicketWhereInput = {
    AND: [
      ticketScope(ctx),
      {
        status: q.status ?? (q.open === "true" || q.breached === "true" ? { in: ACTIVE_TICKET } : undefined),
        priority: q.priority,
        customerId: q.customerId,
        categoryId: q.categoryId,
        companyId: q.companyId,
        assigneeId: q.mine === "true" ? ctx.userId : q.unassigned === "true" ? null : q.assigneeId,
        resolutionDueAt: q.breached === "true" ? { lt: new Date() } : undefined,
      },
      searchWhere(q.q, ["number", "subject"]),
    ],
  };
  const page = await paginate(q, () =>
    Promise.all([
      prisma.ticket.findMany({
        where,
        include: { customer: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } },
        ...listArgs(q, ["createdAt", "number", "priority", "status", "resolutionDueAt", "updatedAt"], "createdAt"),
      }),
      prisma.ticket.count({ where }),
    ]),
  );
  const users = await userMap(page.items.map((t) => t.assigneeId));
  return { ...page, items: page.items.map((t) => ({ ...t, assignee: t.assigneeId ? users.get(t.assigneeId) ?? null : null })) };
}

export async function getTicket(ctx: AccessContext, id: string) {
  assertCan(ctx, "ticket.view");
  const ticket = await prisma.ticket.findFirst({
    where: { id, ...ticketScope(ctx) },
    include: {
      customer: { select: { id: true, name: true } },
      asset: { select: { id: true, tag: true, name: true } },
      category: { select: { id: true, name: true } },
      slaPolicy: { select: { id: true, name: true, firstResponseMinutes: true, resolutionMinutes: true } },
      company: { select: { id: true, code: true, name: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found", 404);
  const [contact, users] = await Promise.all([
    ticket.contactId ? prisma.contact.findFirst({ where: { id: ticket.contactId, organizationId: ctx.organizationId }, select: { id: true, fullName: true, email: true, phone: true } }) : null,
    userMap([ticket.assigneeId, ticket.createdById, ...ticket.messages.map((m) => m.authorUserId)]),
  ]);
  return {
    ...ticket,
    contact,
    assignee: ticket.assigneeId ? users.get(ticket.assigneeId) ?? null : null,
    createdBy: ticket.createdById ? users.get(ticket.createdById) ?? null : null,
    messages: ticket.messages.map((m) => ({ ...m, author: m.authorUserId ? users.get(m.authorUserId) ?? null : null })),
  };
}

async function userMap(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const users = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } }) : [];
  return new Map(users.map((u) => [u.id, u]));
}
