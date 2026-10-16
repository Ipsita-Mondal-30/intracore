import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { ACTIVE_TICKET } from "@/features/service/sla";
import { ticketScope } from "@/features/service/tickets";

/**
 * Service report over the caller's visible tickets (managers: company scope; technicians: own).
 * - open: current backlog by status and priority, and how many are past resolutionDueAt
 * - period (resolved between from..to): avg resolution hours, resolution SLA breach rate
 *   (resolvedAt > resolutionDueAt), avg feedback rating
 * - first response breach rate: tickets created in the period with a target, breached when
 *   responded late or still unanswered past the target
 * - technicians: open/resolved counts, avg resolution hours and rating per assignee
 */
const querySchema = z.object({
  companyId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export async function serviceReport(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "ticket.view");
  const q = querySchema.parse(query);
  if (q.companyId && !ctx.companies.has(q.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const now = new Date();
  const to = q.to ?? now;
  const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
  const scope: Prisma.TicketWhereInput = { AND: [ticketScope(ctx), { companyId: q.companyId }] };
  const open: Prisma.TicketWhereInput = { AND: [scope, { status: { in: ACTIVE_TICKET } }] };

  const [byStatus, byPriority, overdue, resolved, created, openByAssignee] = await Promise.all([
    prisma.ticket.groupBy({ by: ["status"], where: open, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["priority"], where: open, _count: { _all: true } }),
    prisma.ticket.count({ where: { AND: [open, { resolutionDueAt: { lt: now } }] } }),
    // ponytail: period rows aggregated in memory; move to SQL aggregates if periods get huge
    prisma.ticket.findMany({
      where: { AND: [scope, { resolvedAt: { gte: from, lte: to } }] },
      select: { assigneeId: true, createdAt: true, resolvedAt: true, resolutionDueAt: true, feedbackRating: true },
    }),
    prisma.ticket.findMany({
      where: { AND: [scope, { createdAt: { gte: from, lte: to }, firstResponseDueAt: { not: null } }] },
      select: { firstResponseDueAt: true, firstRespondedAt: true },
    }),
    prisma.ticket.groupBy({ by: ["assigneeId"], where: open, _count: { _all: true } }),
  ]);

  const withTarget = resolved.filter((t) => t.resolutionDueAt);
  const breached = withTarget.filter((t) => t.resolvedAt! > t.resolutionDueAt!).length;
  const responseBreached = created.filter((t) => (t.firstRespondedAt ?? now) > t.firstResponseDueAt!).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const avgHours = (rows: typeof resolved) => {
    const a = avg(rows.map((t) => t.resolvedAt!.getTime() - t.createdAt.getTime()));
    return a === null ? null : hours(a);
  };
  const avgRating = (rows: typeof resolved) => {
    const a = avg(rows.filter((t) => t.feedbackRating).map((t) => t.feedbackRating!));
    return a === null ? null : Math.round(a * 10) / 10;
  };

  const assigneeIds = [...new Set([...openByAssignee.map((r) => r.assigneeId), ...resolved.map((t) => t.assigneeId)].filter((x): x is string => !!x))];
  const users = assigneeIds.length ? await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true, email: true } }) : [];
  const technicians = assigneeIds.map((id) => {
    const mine = resolved.filter((t) => t.assigneeId === id);
    return {
      userId: id,
      user: users.find((u) => u.id === id) ?? null,
      open: openByAssignee.find((r) => r.assigneeId === id)?._count._all ?? 0,
      resolved: mine.length,
      avgResolutionHours: avgHours(mine),
      avgRating: avgRating(mine),
    };
  }).sort((a, b) => b.open - a.open);

  return {
    period: { from, to },
    open: {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r._count._all])),
      overdue,
      unassigned: openByAssignee.find((r) => r.assigneeId === null)?._count._all ?? 0,
    },
    resolved: {
      count: resolved.length,
      avgResolutionHours: avgHours(resolved),
      slaBreachRate: pct(breached, withTarget.length),
      slaBreached: breached,
      avgRating: avgRating(resolved),
    },
    firstResponse: { tickets: created.length, breached: responseBreached, breachRate: pct(responseBreached, created.length) },
    technicians,
  };
}
