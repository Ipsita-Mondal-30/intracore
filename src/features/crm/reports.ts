import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { assertCan, companyScopeWhere, type AccessContext } from "@/lib/access";
import { dec } from "@/lib/money";
import { OPEN_STAGES } from "@/features/opportunities/service";

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Funnel metrics for a period (default: last 90 days):
 * leads created -> converted, open pipeline by stage (count, value, probability-weighted
 * value), deals won/lost and win rate, quotations and orders.
 */
export async function getCrmFunnel(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "crm.report");
  const { from = new Date(Date.now() - 90 * 86_400_000), to = new Date() } = rangeSchema.parse(query);
  const org = ctx.organizationId;
  const period = { gte: from, lte: to };

  const [leadsByStatus, leadsConverted, pipeline, closed, quotations, orders] = await Promise.all([
    prisma.lead.groupBy({ by: ["status"], where: { organizationId: org, createdAt: period, archivedAt: null }, _count: true }),
    prisma.lead.count({ where: { organizationId: org, convertedAt: period, convertedCustomerId: { not: null } } }),
    prisma.opportunity.findMany({
      where: { organizationId: org, stage: { in: OPEN_STAGES } },
      select: { stage: true, amount: true, probability: true },
    }),
    prisma.opportunity.groupBy({
      by: ["stage"],
      where: { organizationId: org, stage: { in: ["WON", "LOST"] }, closedAt: period },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.quotation.groupBy({
      by: ["status"],
      where: { AND: [companyScopeWhere(ctx), { createdAt: period, status: { not: "SUPERSEDED" } }] },
      _count: true,
      _sum: { grandTotal: true },
    }),
    prisma.salesOrder.aggregate({
      where: { AND: [companyScopeWhere(ctx), { confirmedAt: period, status: { not: "CANCELLED" } }] },
      _count: true,
      _sum: { grandTotal: true },
    }),
  ]);

  const leadsCreated = leadsByStatus.reduce((n, row) => n + row._count, 0);
  const stages = OPEN_STAGES.map((stage) => {
    const rows = pipeline.filter((o) => o.stage === stage);
    return {
      stage,
      count: rows.length,
      amount: rows.reduce((sum, o) => sum.add(o.amount), dec(0)).toFixed(2),
      weighted: rows.reduce((sum, o) => sum.add(dec(o.amount).mul(o.probability).div(100)), dec(0)).toFixed(2),
    };
  });
  const won = closed.find((r) => r.stage === "WON");
  const lost = closed.find((r) => r.stage === "LOST");
  const wonCount = won?._count ?? 0;
  const lostCount = lost?._count ?? 0;

  return {
    period: { from, to },
    leads: {
      created: leadsCreated,
      byStatus: Object.fromEntries(leadsByStatus.map((r) => [r.status, r._count])),
      converted: leadsConverted,
      conversionRate: leadsCreated ? Number((leadsConverted / leadsCreated).toFixed(4)) : 0,
    },
    pipeline: {
      stages,
      openAmount: stages.reduce((sum, s) => sum.add(s.amount), dec(0)).toFixed(2),
      weightedAmount: stages.reduce((sum, s) => sum.add(s.weighted), dec(0)).toFixed(2),
    },
    deals: {
      won: wonCount,
      lost: lostCount,
      wonAmount: dec(won?._sum.amount).toFixed(2),
      winRate: wonCount + lostCount ? Number((wonCount / (wonCount + lostCount)).toFixed(4)) : 0,
      averageWonDeal: wonCount ? dec(won?._sum.amount).div(wonCount).toFixed(2) : "0.00",
    },
    quotations: Object.fromEntries(
      quotations.map((r) => [r.status, { count: r._count, amount: dec(r._sum.grandTotal).toFixed(2) }]),
    ),
    orders: { count: orders._count, amount: dec(orders._sum.grandTotal).toFixed(2) },
  };
}
