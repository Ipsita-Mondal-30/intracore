import { z } from "zod";
import { MemberStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";

/**
 * Field service visits: SCHEDULED → IN_PROGRESS → COMPLETED (CANCELLED / NO_SHOW from
 * SCHEDULED). Technicians see and work only their own visits; field.schedule holders
 * see every visit in their companies. Evidence files attach through the documents API
 * (entityType "service_visit").
 */

/** Technician must be an active member with access to the company. */
export async function assertTechnician(tx: Prisma.TransactionClient, ctx: AccessContext, userId: string, companyId: string) {
  const member = await tx.organizationMember.findFirst({
    where: { organizationId: ctx.organizationId, userId, status: MemberStatus.ACTIVE, OR: [{ isOwner: true }, { scopes: { some: { companyId } } }] },
    select: { id: true },
  });
  if (!member) throw new AppError("INVALID_REFERENCE", "Technician must be an active member with access to this company", 422);
}

/**
 * Serialises scheduling per technician and refuses overlapping open visits or
 * installation jobs (half-open intervals: back-to-back slots are fine).
 */
export async function assertTechnicianFree(
  tx: Prisma.TransactionClient,
  technicianId: string,
  start: Date,
  end: Date,
  exclude: { visitId?: string; jobId?: string } = {},
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`technician:${technicianId}`}, 0))`;
  const overlap = { lt: end };
  const [visit, job] = await Promise.all([
    tx.serviceVisit.findFirst({
      where: { technicianId, id: exclude.visitId ? { not: exclude.visitId } : undefined, status: { in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledStart: overlap, scheduledEnd: { gt: start } },
      select: { id: true, scheduledStart: true },
    }),
    tx.installationJob.findFirst({
      where: { technicianId, id: exclude.jobId ? { not: exclude.jobId } : undefined, status: { in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledStart: overlap, scheduledEnd: { gt: start } },
      select: { id: true, number: true },
    }),
  ]);
  if (visit || job) {
    throw new AppError("DOUBLE_BOOKED", "The technician is already booked in this time window", 422, { visitId: visit?.id, installationJobId: job?.id });
  }
}

const slot = z
  .object({ scheduledStart: z.coerce.date(), scheduledEnd: z.coerce.date() })
  .refine((s) => s.scheduledEnd > s.scheduledStart, { message: "End must be after start", path: ["scheduledEnd"] });

const createSchema = z
  .object({
    companyId: z.string().min(1),
    technicianId: z.string().uuid(),
    scheduledStart: z.coerce.date(),
    scheduledEnd: z.coerce.date(),
    serviceType: z.string().trim().toUpperCase().max(60).nullish(),
    ticketId: z.string().min(1).nullish(),
    contractId: z.string().min(1).nullish(),
    assetId: z.string().min(1).nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .refine((s) => s.scheduledEnd > s.scheduledStart, { message: "End must be after start", path: ["scheduledEnd"] });

const updateSchema = z.object({
  technicianId: z.string().uuid().optional(),
  scheduledStart: z.coerce.date().optional(),
  scheduledEnd: z.coerce.date().optional(),
  serviceType: z.string().trim().toUpperCase().max(60).nullish(),
  notes: z.string().trim().max(5000).nullish(),
});

const include = {
  asset: { select: { id: true, tag: true, name: true } },
  ticket: { select: { id: true, number: true, subject: true } },
  contract: { select: { id: true, number: true } },
} satisfies Prisma.ServiceVisitInclude;

/** Schedulers see every visit in their companies; technicians only their own. */
export function visitScope(ctx: AccessContext): Prisma.ServiceVisitWhereInput {
  const base = { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } };
  return can(ctx, "field.schedule") ? base : { ...base, technicianId: ctx.userId };
}

async function lockVisit(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "service_visits" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const v = await tx.serviceVisit.findFirst({ where: { id, ...visitScope(ctx) } });
  if (!v) throw new AppError("NOT_FOUND", "Visit not found", 404);
  return v;
}

/** Optional ticket/contract/asset references must be in the same company. */
async function assertLinks(tx: Prisma.TransactionClient, ctx: AccessContext, companyId: string, d: { ticketId?: string | null; contractId?: string | null; assetId?: string | null }) {
  const where = { organizationId: ctx.organizationId, companyId };
  const [ticket, contract, asset] = await Promise.all([
    d.ticketId ? tx.ticket.findFirst({ where: { id: d.ticketId, ...where }, select: { id: true } }) : true,
    d.contractId ? tx.serviceContract.findFirst({ where: { id: d.contractId, ...where }, select: { id: true } }) : true,
    d.assetId ? tx.asset.findFirst({ where: { id: d.assetId, ...where }, select: { id: true } }) : true,
  ]);
  if (!ticket) throw new AppError("INVALID_REFERENCE", "Ticket not found in this company", 422);
  if (!contract) throw new AppError("INVALID_REFERENCE", "Contract not found in this company", 422);
  if (!asset) throw new AppError("INVALID_REFERENCE", "Asset not found in this company", 422);
}

export async function scheduleVisit(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "field.schedule");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    await assertTechnician(tx, ctx, data.technicianId, data.companyId);
    await assertLinks(tx, ctx, data.companyId, data);
    await assertTechnicianFree(tx, data.technicianId, data.scheduledStart, data.scheduledEnd);
    const visit = await tx.serviceVisit.create({ data: { ...data, organizationId: ctx.organizationId }, include });
    await audit(tx, ctx, { action: "service_visit.scheduled", entity: "service_visit", entityId: visit.id, companyId: visit.companyId, next: visit });
    return visit;
  });
}

/** Reschedule / reassign while still SCHEDULED. */
export async function updateVisit(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "field.schedule");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockVisit(tx, ctx, id);
    if (before.status !== "SCHEDULED") throw new AppError("INVALID_STATE", `A ${before.status} visit cannot be rescheduled`, 422);
    const s = slot.parse({ scheduledStart: data.scheduledStart ?? before.scheduledStart, scheduledEnd: data.scheduledEnd ?? before.scheduledEnd });
    const technicianId = data.technicianId ?? before.technicianId;
    if (data.technicianId) await assertTechnician(tx, ctx, technicianId, before.companyId);
    await assertTechnicianFree(tx, technicianId, s.scheduledStart, s.scheduledEnd, { visitId: id });
    const updated = await tx.serviceVisit.update({ where: { id }, data: { ...data, ...s, technicianId }, include });
    await audit(tx, ctx, {
      action: "service_visit.rescheduled",
      entity: "service_visit",
      entityId: id,
      companyId: before.companyId,
      previous: { technicianId: before.technicianId, scheduledStart: before.scheduledStart, scheduledEnd: before.scheduledEnd },
      next: { technicianId, ...s },
    });
    return updated;
  });
}

const actionSchemas = {
  start: z.object({}),
  complete: z.object({
    notes: z.string({ required_error: "Visit notes are required" }).trim().min(1, "Visit notes are required").max(5000),
    workDone: z.string().trim().max(5000).nullish(),
    customerSignedBy: z.string().trim().max(200).nullish(),
  }),
  cancel: z.object({ reason: z.string().trim().min(1, "A reason is required").max(1000) }),
  "no-show": z.object({ reason: z.string().trim().max(1000).optional() }),
};
export type VisitAction = keyof typeof actionSchemas;
export const VISIT_ACTIONS = Object.keys(actionSchemas) as VisitAction[];

export async function transitionVisit(ctx: AccessContext, id: string, action: VisitAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, action === "start" || action === "complete" ? "field.update" : "field.schedule");
  const body = schema.parse(input ?? {}) as { notes?: string; workDone?: string | null; customerSignedBy?: string | null; reason?: string };
  return prisma.$transaction(async (tx) => {
    const v = await lockVisit(tx, ctx, id);
    const expect = (status: string) => {
      if (v.status !== status) throw new AppError("INVALID_STATE", `Cannot ${action} a ${v.status} visit`, 422);
    };
    if ((action === "start" || action === "complete") && v.technicianId !== ctx.userId && !can(ctx, "field.schedule")) {
      throw new AppError("FORBIDDEN", "Only the assigned technician can work this visit", 403);
    }
    let data: Prisma.ServiceVisitUncheckedUpdateInput;
    switch (action) {
      case "start":
        expect("SCHEDULED");
        data = { status: "IN_PROGRESS", checkInAt: new Date() };
        break;
      case "complete":
        expect("IN_PROGRESS");
        data = { status: "COMPLETED", completedAt: new Date(), notes: body.notes, workDone: body.workDone ?? null, customerSignedBy: body.customerSignedBy ?? null };
        break;
      case "cancel":
        expect("SCHEDULED");
        data = { status: "CANCELLED" };
        break;
      case "no-show":
        expect("SCHEDULED");
        data = { status: "NO_SHOW" };
        break;
    }
    const updated = await tx.serviceVisit.update({ where: { id }, data: data!, include });
    await audit(tx, ctx, { action: `service_visit.${action}`, entity: "service_visit", entityId: id, companyId: v.companyId, previous: { status: v.status }, next: { status: updated.status, reason: body.reason, note: body.notes } });
    return updated;
  });
}

export async function listVisits(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "field.view");
  const q = listQuerySchema
    .extend({
      status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(),
      technicianId: z.string().optional(),
      assetId: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    })
    .parse(query);
  const where: Prisma.ServiceVisitWhereInput = {
    ...visitScope(ctx),
    ...(q.technicianId ? { AND: [{ technicianId: q.technicianId }] } : {}),
    status: q.status,
    assetId: q.assetId,
    scheduledStart: q.from || q.to ? { gte: q.from, lt: q.to } : undefined,
  };
  return paginate(q, () =>
    Promise.all([
      prisma.serviceVisit.findMany({ where, include, ...listArgs(q, ["scheduledStart", "createdAt"], "scheduledStart") }),
      prisma.serviceVisit.count({ where }),
    ]),
  );
}

export async function getVisit(ctx: AccessContext, id: string) {
  assertCan(ctx, "field.view");
  const v = await prisma.serviceVisit.findFirst({ where: { id, ...visitScope(ctx) }, include });
  if (!v) throw new AppError("NOT_FOUND", "Visit not found", 404);
  return v;
}
