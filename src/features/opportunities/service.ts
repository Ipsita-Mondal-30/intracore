import { z } from "zod";
import { OpportunityStage, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";
import { assertActiveMember } from "@/lib/tenant/refs";

export const STAGE_PROBABILITY: Record<OpportunityStage, number> = {
  PROSPECTING: 10,
  QUALIFICATION: 25,
  PROPOSAL: 50,
  NEGOTIATION: 75,
  WON: 100,
  LOST: 0,
};

export const OPEN_STAGES: OpportunityStage[] = ["PROSPECTING", "QUALIFICATION", "PROPOSAL", "NEGOTIATION"];
export const isClosed = (stage: OpportunityStage) => stage === "WON" || stage === "LOST";

const text = (max: number) => z.string().trim().max(max);

const opportunitySchema = z.object({
  name: text(200).min(1),
  customerId: z.string().min(1),
  contactId: z.string().min(1).nullish(),
  leadId: z.string().min(1).nullish(),
  amount: zDecimal().default("0"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  expectedCloseDate: z.coerce.date().nullish(),
  ownerUserId: z.string().uuid().nullish(),
  description: text(4000).nullish(),
  stage: z.enum(OPEN_STAGES as [OpportunityStage, ...OpportunityStage[]]).optional(),
  probability: z.coerce.number().int().min(0).max(100).optional(),
});

const listSchema = listQuerySchema.extend({
  stage: z.nativeEnum(OpportunityStage).optional(),
  customerId: z.string().optional(),
  ownerUserId: z.string().uuid().optional(),
  open: z.enum(["true", "false"]).optional(),
});

const include = {
  customer: { select: { id: true, name: true } },
  contact: { select: { id: true, fullName: true } },
  owner: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OpportunityInclude;

export async function listOpportunities(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "opportunity.view");
  const q = listSchema.parse(query);
  const where: Prisma.OpportunityWhereInput = {
    organizationId: ctx.organizationId,
    stage: q.stage ?? (q.open === "true" ? { in: OPEN_STAGES } : q.open === "false" ? { in: ["WON", "LOST"] } : undefined),
    customerId: q.customerId,
    ownerUserId: q.ownerUserId,
    ...searchWhere(q.q, ["name", "description"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.opportunity.findMany({
        where,
        include,
        ...listArgs(q, ["createdAt", "name", "amount", "expectedCloseDate", "stage"], "createdAt"),
      }),
      prisma.opportunity.count({ where }),
    ]),
  );
}

export async function getOpportunity(ctx: AccessContext, id: string) {
  assertCan(ctx, "opportunity.view");
  const opportunity = await prisma.opportunity.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { ...include, lead: { select: { id: true, fullName: true } } },
  });
  if (!opportunity) throw new AppError("NOT_FOUND", "Opportunity not found", 404);
  return opportunity;
}

async function assertContactOfCustomer(
  db: Prisma.TransactionClient,
  organizationId: string,
  customerId: string,
  contactId?: string | null,
) {
  const customer = await db.customer.findFirst({ where: { id: customerId, organizationId }, select: { id: true } });
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
  if (!contactId) return;
  const contact = await db.contact.findFirst({ where: { id: contactId, organizationId }, select: { customerId: true } });
  if (!contact) throw new AppError("NOT_FOUND", "Contact not found", 404);
  if (contact.customerId !== customerId) {
    throw new AppError("INVALID_REFERENCE", "Contact does not belong to this customer", 422);
  }
}

export async function createOpportunity(ctx: AccessContext, input: unknown, tx: Prisma.TransactionClient | null = null) {
  assertCan(ctx, "opportunity.create");
  const data = opportunitySchema.parse(input);
  if (data.ownerUserId) await assertActiveMember(ctx.organizationId, data.ownerUserId);
  const stage = data.stage ?? "PROSPECTING";

  const run = async (db: Prisma.TransactionClient) => {
    await assertContactOfCustomer(db, ctx.organizationId, data.customerId, data.contactId);
    const opportunity = await db.opportunity.create({
      data: {
        ...data,
        stage,
        probability: data.probability ?? STAGE_PROBABILITY[stage],
        organizationId: ctx.organizationId,
        ownerUserId: data.ownerUserId ?? ctx.userId,
        createdById: ctx.userId,
      },
    });
    await audit(db, ctx, { action: "opportunity.created", entity: "opportunity", entityId: opportunity.id, next: opportunity });
    return opportunity;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

/** Field edits; stage moves go through changeOpportunityStage. Closed deals are read-only. */
export async function updateOpportunity(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "opportunity.update");
  const data = opportunitySchema.omit({ stage: true, leadId: true }).partial().parse(input);
  if (data.ownerUserId) await assertActiveMember(ctx.organizationId, data.ownerUserId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.opportunity.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Opportunity not found", 404);
    if (isClosed(before.stage)) throw new AppError("INVALID_STATE", "Closed opportunities cannot be edited", 422);
    if (data.customerId !== undefined || data.contactId !== undefined) {
      await assertContactOfCustomer(tx, ctx.organizationId, data.customerId ?? before.customerId, data.contactId === undefined ? before.contactId : data.contactId);
    }
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const opportunity = await tx.opportunity.update({ where: { id }, data });
    await audit(tx, ctx, { action: "opportunity.updated", entity: "opportunity", entityId: id, previous: diff.previous, next: diff.next });
    return opportunity;
  });
}

const stageSchema = z
  .object({
    stage: z.nativeEnum(OpportunityStage),
    lossReason: z.string().trim().min(1).max(500).optional(),
    probability: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((s) => s.stage !== "LOST" || s.lossReason, { message: "A loss reason is required", path: ["lossReason"] });

/**
 * Pipeline transitions: open stages move freely among themselves and can close as
 * WON or LOST (LOST needs a reason). WON and LOST are terminal.
 */
export async function changeOpportunityStage(
  ctx: AccessContext,
  id: string,
  input: unknown,
  tx: Prisma.TransactionClient | null = null,
) {
  assertCan(ctx, "opportunity.update");
  const { stage, lossReason, probability } = stageSchema.parse(input);

  const run = async (db: Prisma.TransactionClient) => {
    const before = await db.opportunity.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Opportunity not found", 404);
    if (isClosed(before.stage)) {
      throw new AppError("INVALID_STATE", `Opportunity is already ${before.stage}`, 422);
    }
    if (before.stage === stage) return before;
    const opportunity = await db.opportunity.update({
      where: { id },
      data: {
        stage,
        probability: isClosed(stage) ? STAGE_PROBABILITY[stage] : probability ?? STAGE_PROBABILITY[stage],
        lossReason: stage === "LOST" ? lossReason : null,
        closedAt: isClosed(stage) ? new Date() : null,
      },
    });
    await audit(db, ctx, {
      action: "opportunity.stage_changed",
      entity: "opportunity",
      entityId: id,
      previous: { stage: before.stage },
      next: { stage, lossReason },
    });
    return opportunity;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
