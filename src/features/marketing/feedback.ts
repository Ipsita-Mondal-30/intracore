import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";

/**
 * Customer feedback and reviews. Rating is an integer 1–5. Customer, campaign and ticket references
 * must belong to the tenant (tickets also to the caller's companies). A record is a public review
 * (`isPublic`) only when the input also carries `publicConsent: true` — the customer's explicit
 * agreement to publish; the consent is recorded in the audit trail.
 */

export const FEEDBACK_SOURCES = ["MANUAL", "CAMPAIGN", "TICKET", "PORTAL"] as const;

const createSchema = z
  .object({
    rating: z.coerce.number().int("Rating must be a whole number").min(1).max(5),
    comment: z.string().trim().max(5000).nullish(),
    customerId: z.string().min(1).nullish(),
    campaignId: z.string().min(1).nullish(),
    ticketId: z.string().min(1).nullish(),
    source: z.enum(FEEDBACK_SOURCES).optional(),
    isPublic: z.boolean().default(false),
    publicConsent: z.boolean().optional(),
  })
  .refine((d) => !d.isPublic || d.publicConsent === true, { path: ["publicConsent"], message: "Publishing as a review needs the customer's explicit consent" });

const invalid = (what: string) => new AppError("INVALID_REFERENCE", `${what} does not belong to this organization`, 422);

export async function createFeedback(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "feedback.create");
  const { publicConsent, ...data } = createSchema.parse(input);
  const org = ctx.organizationId;
  return prisma.$transaction(async (tx) => {
    if (data.customerId && !(await tx.customer.count({ where: { id: data.customerId, organizationId: org } }))) throw invalid("Customer");
    if (data.campaignId && !(await tx.campaign.count({ where: { id: data.campaignId, organizationId: org } }))) throw invalid("Campaign");
    if (data.ticketId && !(await tx.ticket.count({ where: { id: data.ticketId, organizationId: org, companyId: { in: [...ctx.companies.keys()] } } }))) throw invalid("Ticket");
    const source = data.source ?? (data.ticketId ? "TICKET" : data.campaignId ? "CAMPAIGN" : "MANUAL");
    const feedback = await tx.customerFeedback.create({ data: { ...data, source, organizationId: org, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "feedback.created", entity: "customer_feedback", entityId: feedback.id, next: { ...feedback, publicConsent } });
    return feedback;
  });
}

const filterSchema = listQuerySchema.extend({
  customerId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  ticketId: z.string().min(1).optional(),
  source: z.enum(FEEDBACK_SOURCES).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  isPublic: z.enum(["true", "false"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function feedbackWhere(ctx: AccessContext, q: z.infer<typeof filterSchema>): Prisma.CustomerFeedbackWhereInput {
  return {
    organizationId: ctx.organizationId,
    customerId: q.customerId,
    campaignId: q.campaignId,
    ticketId: q.ticketId,
    source: q.source,
    rating: q.rating,
    isPublic: q.isPublic ? q.isPublic === "true" : undefined,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    ...searchWhere(q.q, ["comment"]),
  };
}

export async function listFeedback(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "feedback.view");
  const q = filterSchema.parse(query);
  const where = feedbackWhere(ctx, q);
  return paginate(q, () =>
    prisma.$transaction([
      prisma.customerFeedback.findMany({
        where,
        include: { customer: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true } } },
        ...listArgs(q, ["createdAt", "rating"], "createdAt"),
      }),
      prisma.customerFeedback.count({ where }),
    ]),
  );
}

/** Count, average rating (2 dp, null when none) and the 1–5 distribution for the same filters as the list. */
export async function feedbackSummary(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "feedback.view");
  const where = feedbackWhere(ctx, filterSchema.parse(query));
  const [agg, groups] = await Promise.all([
    prisma.customerFeedback.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    prisma.customerFeedback.groupBy({ by: ["rating"], where, _count: { _all: true } }),
  ]);
  const distribution = Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, groups.find((g) => g.rating === r)?._count._all ?? 0]));
  return { count: agg._count._all, averageRating: agg._avg.rating === null ? null : Math.round(agg._avg.rating * 100) / 100, distribution };
}
