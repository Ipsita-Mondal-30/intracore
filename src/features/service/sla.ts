import { z } from "zod";
import { LeadPriority, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { assertActiveMember } from "@/lib/tenant/refs";
import { createSystemNotification } from "@/lib/notifications/create";

/**
 * Ticket categories and SLA policies (org-level master data; `service.administer` to change,
 * `ticket.view` to read).
 *
 * SLA clock: plain calendar time (24x7 elapsed minutes from ticket creation), as the schema
 * documents — no business hours/holidays, and ON_HOLD does not pause the clock.
 * Policy choice: the ticket's explicit `slaPolicyId`, else the active policy for its priority
 * (first by name). Policies are per priority only; the schema has no category link.
 *
 * Escalation (`escalateOverdueTickets`, run as a job): level 1 = first response overdue,
 * level 2 = resolution overdue. Each level is claimed once with a conditional updateMany.
 */

type Db = Prisma.TransactionClient | typeof prisma;

// ─── Categories ──────────────────────────────────────────────────────────────

const categorySchema = z.object({ name: z.string().trim().min(1).max(80), isActive: z.boolean().optional() });

export async function listTicketCategories(ctx: AccessContext) {
  assertCan(ctx, "ticket.view");
  return prisma.ticketCategory.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" } });
}

export async function createTicketCategory(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "service.administer");
  const data = categorySchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const category = await tx.ticketCategory.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "ticket_category.created", entity: "ticket_category", entityId: category.id, next: category });
    return category;
  });
}

export async function updateTicketCategory(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "service.administer");
  const data = categorySchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const category = await tx.ticketCategory.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!category) throw new AppError("NOT_FOUND", "Category not found", 404);
    const updated = await tx.ticketCategory.update({ where: { id }, data });
    await audit(tx, ctx, { action: "ticket_category.updated", entity: "ticket_category", entityId: id, ...changes(category, data) });
    return updated;
  });
}

// ─── SLA policies ────────────────────────────────────────────────────────────

const minutes = z.coerce.number().int().min(1).max(525600);
const policySchema = z.object({
  name: z.string().trim().min(1).max(80),
  priority: z.nativeEnum(LeadPriority),
  firstResponseMinutes: minutes,
  resolutionMinutes: minutes,
  escalateToUserId: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
});
const firstBeforeResolution = (p: { firstResponseMinutes?: number; resolutionMinutes?: number }) =>
  !p.firstResponseMinutes || !p.resolutionMinutes || p.firstResponseMinutes <= p.resolutionMinutes;
const resolutionMsg = { message: "First response target cannot exceed the resolution target", path: ["firstResponseMinutes"] };

export async function listSlaPolicies(ctx: AccessContext) {
  assertCan(ctx, "ticket.view");
  return prisma.slaPolicy.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ priority: "desc" }, { name: "asc" }] });
}

export async function createSlaPolicy(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "service.administer");
  const data = policySchema.refine(firstBeforeResolution, resolutionMsg).parse(input);
  if (data.escalateToUserId) await assertActiveMember(ctx.organizationId, data.escalateToUserId);
  return prisma.$transaction(async (tx) => {
    const policy = await tx.slaPolicy.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "sla_policy.created", entity: "sla_policy", entityId: policy.id, next: policy });
    return policy;
  });
}

/** Changes apply to new tickets and to priority changes; existing due dates are not rewritten. */
export async function updateSlaPolicy(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "service.administer");
  const data = policySchema.partial().parse(input);
  if (data.escalateToUserId) await assertActiveMember(ctx.organizationId, data.escalateToUserId);
  return prisma.$transaction(async (tx) => {
    const policy = await tx.slaPolicy.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!policy) throw new AppError("NOT_FOUND", "SLA policy not found", 404);
    if (!firstBeforeResolution({ ...policy, ...data })) throw new AppError("VALIDATION_ERROR", resolutionMsg.message, 422);
    const updated = await tx.slaPolicy.update({ where: { id }, data });
    await audit(tx, ctx, { action: "sla_policy.updated", entity: "sla_policy", entityId: id, ...changes(policy, data) });
    return updated;
  });
}

// ─── Due dates ───────────────────────────────────────────────────────────────

/** The policy for a ticket: an explicit active one, else the active policy for the priority. */
export async function resolveSlaPolicy(db: Db, organizationId: string, priority: LeadPriority, policyId?: string | null) {
  if (policyId) {
    const policy = await db.slaPolicy.findFirst({ where: { id: policyId, organizationId, isActive: true } });
    if (!policy) throw new AppError("INVALID_REFERENCE", "Unknown or inactive SLA policy", 422);
    return policy;
  }
  return db.slaPolicy.findFirst({ where: { organizationId, priority, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
}

const addMinutes = (from: Date, m: number) => new Date(from.getTime() + m * 60_000);

/** Calendar-time due dates from `from` (the ticket's creation time). */
export function slaDueDates(policy: { firstResponseMinutes: number; resolutionMinutes: number } | null, from: Date) {
  return {
    firstResponseDueAt: policy ? addMinutes(from, policy.firstResponseMinutes) : null,
    resolutionDueAt: policy ? addMinutes(from, policy.resolutionMinutes) : null,
  };
}

// ─── Escalation job ──────────────────────────────────────────────────────────

export const ACTIVE_TICKET = ["NEW", "OPEN", "IN_PROGRESS", "ON_HOLD"];

/**
 * Escalates breached, unresolved tickets. Level 1: no first response by firstResponseDueAt;
 * level 2: not resolved by resolutionDueAt. The conditional updateMany (escalationLevel < level)
 * claims each level exactly once, so overlapping or repeated runs never double-notify.
 * Notifies the assignee and the policy's escalation user, and adds a SYSTEM internal note.
 */
export async function escalateOverdueTickets(now = new Date()) {
  const candidates = await prisma.ticket.findMany({
    where: {
      status: { in: ACTIVE_TICKET },
      OR: [
        { escalationLevel: { lt: 1 }, firstRespondedAt: null, firstResponseDueAt: { lt: now } },
        { escalationLevel: { lt: 2 }, resolutionDueAt: { lt: now } },
      ],
    },
    include: { slaPolicy: { select: { escalateToUserId: true } } },
    orderBy: { resolutionDueAt: "asc" },
    take: 500, // ponytail: batch cap per run; the next run picks up the rest
  });
  let escalated = 0;
  for (const t of candidates) {
    const level = t.resolutionDueAt && t.resolutionDueAt < now ? 2 : 1;
    const reason = level === 2 ? "resolution SLA breached" : "first response SLA breached";
    const claimed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { id: t.id, escalationLevel: { lt: level }, status: { in: ACTIVE_TICKET } },
        data: { escalationLevel: level, escalatedAt: now },
      });
      if (count === 0) return false;
      await tx.ticketMessage.create({
        data: { organizationId: t.organizationId, ticketId: t.id, authorType: "SYSTEM", visibility: "INTERNAL", body: `Escalated to level ${level}: ${reason}.` },
      });
      // System action: no user, so write the audit row directly.
      await tx.auditLog.create({
        data: {
          organizationId: t.organizationId, companyId: t.companyId, action: "ticket.escalated", entity: "ticket", entityId: t.id,
          previous: { escalationLevel: t.escalationLevel }, next: { escalationLevel: level, reason },
        },
      });
      return true;
    });
    if (!claimed) continue;
    escalated++;
    const recipients = new Set([t.assigneeId, t.slaPolicy?.escalateToUserId].filter((x): x is string => !!x));
    for (const userId of recipients) {
      await createSystemNotification({
        organizationId: t.organizationId,
        userId,
        type: "TICKET_ESCALATED",
        title: `Ticket ${t.number} escalated`,
        body: `${t.subject} — ${reason}`,
        data: { ticketId: t.id, level, href: `/service/tickets/${t.id}` },
      }).catch((e) => console.error("[sla] notification failed", e));
    }
  }
  return { checked: candidates.length, escalated };
}
