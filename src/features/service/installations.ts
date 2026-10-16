import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { assertTechnician, assertTechnicianFree } from "@/features/service/field";

/**
 * Installation jobs: PLANNED → SCHEDULED → IN_PROGRESS → COMPLETED (CANCELLED before
 * completion). Completion needs every required checklist item done.
 */

const checklistSchema = z
  .array(z.object({ label: z.string().trim().min(1).max(300), required: z.boolean().default(true) }))
  .max(100)
  .default([]);

const createSchema = z
  .object({
    companyId: z.string().min(1),
    customerId: z.string().min(1),
    salesOrderId: z.string().min(1).nullish(),
    assetId: z.string().min(1).nullish(),
    address: z.string().trim().max(1000).nullish(),
    technicianId: z.string().uuid().nullish(),
    scheduledStart: z.coerce.date().nullish(),
    scheduledEnd: z.coerce.date().nullish(),
    notes: z.string().trim().max(5000).nullish(),
    checklist: checklistSchema,
  })
  .refine((j) => !j.scheduledStart === !j.scheduledEnd && (!j.scheduledStart || j.scheduledEnd! > j.scheduledStart), {
    message: "Give both start and end, with end after start",
    path: ["scheduledEnd"],
  });

const scheduleSchema = z
  .object({ technicianId: z.string().uuid(), scheduledStart: z.coerce.date(), scheduledEnd: z.coerce.date(), address: z.string().trim().max(1000).nullish(), notes: z.string().trim().max(5000).nullish() })
  .refine((s) => s.scheduledEnd > s.scheduledStart, { message: "End must be after start", path: ["scheduledEnd"] });

const include = {
  customer: { select: { id: true, name: true } },
  asset: { select: { id: true, tag: true, name: true } },
  checklist: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.InstallationJobInclude;

export function jobScope(ctx: AccessContext): Prisma.InstallationJobWhereInput {
  const base = { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } };
  return can(ctx, "field.schedule") ? base : { ...base, technicianId: ctx.userId };
}

async function lockJob(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "installation_jobs" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const job = await tx.installationJob.findFirst({ where: { id, ...jobScope(ctx) }, include: { checklist: true } });
  if (!job) throw new AppError("NOT_FOUND", "Installation job not found", 404);
  return job;
}

export async function createInstallationJob(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "field.schedule");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    const org = { organizationId: ctx.organizationId };
    if (!(await tx.customer.findFirst({ where: { id: data.customerId, ...org }, select: { id: true } }))) throw new AppError("INVALID_REFERENCE", "Customer not found", 422);
    if (data.salesOrderId && !(await tx.salesOrder.findFirst({ where: { id: data.salesOrderId, ...org, companyId: data.companyId, customerId: data.customerId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Sales order not found for this customer and company", 422);
    }
    if (data.assetId && !(await tx.asset.findFirst({ where: { id: data.assetId, ...org, companyId: data.companyId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Asset not found in this company", 422);
    }
    if (data.technicianId) await assertTechnician(tx, ctx, data.technicianId, data.companyId);
    const scheduled = Boolean(data.technicianId && data.scheduledStart);
    if (scheduled) await assertTechnicianFree(tx, data.technicianId!, data.scheduledStart!, data.scheduledEnd!);
    const { checklist, ...fields } = data;
    const job = await tx.installationJob.create({
      data: {
        ...fields,
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "installation"),
        status: scheduled ? "SCHEDULED" : "PLANNED",
        createdById: ctx.userId,
        checklist: { create: checklist.map((c, i) => ({ ...c, sortOrder: i })) },
      },
      include,
    });
    await audit(tx, ctx, { action: "installation_job.created", entity: "installation_job", entityId: job.id, companyId: job.companyId, next: job });
    return job;
  });
}

/** Assign a technician and a slot (PLANNED or SCHEDULED jobs). */
export async function scheduleInstallationJob(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "field.schedule");
  const data = scheduleSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const job = await lockJob(tx, ctx, id);
    if (job.status !== "PLANNED" && job.status !== "SCHEDULED") throw new AppError("INVALID_STATE", `A ${job.status} job cannot be rescheduled`, 422);
    await assertTechnician(tx, ctx, data.technicianId, job.companyId);
    await assertTechnicianFree(tx, data.technicianId, data.scheduledStart, data.scheduledEnd, { jobId: id });
    const updated = await tx.installationJob.update({ where: { id }, data: { ...data, status: "SCHEDULED" }, include });
    await audit(tx, ctx, {
      action: "installation_job.scheduled",
      entity: "installation_job",
      entityId: id,
      companyId: job.companyId,
      previous: { status: job.status, technicianId: job.technicianId, scheduledStart: job.scheduledStart },
      next: { status: "SCHEDULED", technicianId: data.technicianId, scheduledStart: data.scheduledStart, scheduledEnd: data.scheduledEnd },
    });
    return updated;
  });
}

function assertWorker(ctx: AccessContext, job: { technicianId: string | null }) {
  assertCan(ctx, "field.update");
  if (job.technicianId !== ctx.userId && !can(ctx, "field.schedule")) throw new AppError("FORBIDDEN", "Only the assigned technician can work this job", 403);
}

export async function updateChecklistItem(ctx: AccessContext, jobId: string, itemId: string, input: unknown) {
  assertCan(ctx, "field.update");
  const data = z.object({ done: z.boolean(), note: z.string().trim().max(1000).nullish() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const job = await lockJob(tx, ctx, jobId);
    assertWorker(ctx, job);
    if (job.status === "COMPLETED" || job.status === "CANCELLED") throw new AppError("INVALID_STATE", `The job is ${job.status}`, 422);
    const item = job.checklist.find((c) => c.id === itemId);
    if (!item) throw new AppError("NOT_FOUND", "Checklist item not found", 404);
    const updated = await tx.installationChecklistItem.update({
      where: { id: itemId },
      data: { done: data.done, note: data.note, doneAt: data.done ? new Date() : null, doneById: data.done ? ctx.userId : null },
    });
    await audit(tx, ctx, { action: "installation_job.checklist", entity: "installation_job", entityId: jobId, companyId: job.companyId, previous: { item: item.label, done: item.done }, next: { item: item.label, done: data.done, note: data.note } });
    return updated;
  });
}

const actionSchemas = {
  start: z.object({}),
  complete: z.object({ notes: z.string().trim().max(5000).nullish() }),
  cancel: z.object({ reason: z.string().trim().min(1, "A reason is required").max(1000) }),
};
export type InstallationAction = keyof typeof actionSchemas;
export const INSTALLATION_ACTIONS = Object.keys(actionSchemas) as InstallationAction[];

export async function transitionInstallationJob(ctx: AccessContext, id: string, action: InstallationAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, action === "cancel" ? "field.schedule" : "field.update");
  const body = schema.parse(input ?? {}) as { notes?: string | null; reason?: string };
  return prisma.$transaction(async (tx) => {
    const job = await lockJob(tx, ctx, id);
    const expect = (...allowed: string[]) => {
      if (!allowed.includes(job.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a ${job.status} job`, 422);
    };
    let data: Prisma.InstallationJobUncheckedUpdateInput;
    if (action === "start") {
      assertWorker(ctx, job);
      expect("SCHEDULED");
      data = { status: "IN_PROGRESS" };
    } else if (action === "complete") {
      assertWorker(ctx, job);
      expect("IN_PROGRESS");
      const open = job.checklist.filter((c) => c.required && !c.done);
      if (open.length) throw new AppError("CHECKLIST_INCOMPLETE", `Complete the required checklist items first: ${open.map((c) => c.label).join(", ")}`, 422, { items: open.map((c) => c.id) });
      data = { status: "COMPLETED", completedAt: new Date(), notes: body.notes ?? job.notes };
    } else {
      expect("PLANNED", "SCHEDULED", "IN_PROGRESS");
      data = { status: "CANCELLED" };
    }
    const updated = await tx.installationJob.update({ where: { id }, data, include });
    await audit(tx, ctx, { action: `installation_job.${action}`, entity: "installation_job", entityId: id, companyId: job.companyId, previous: { status: job.status }, next: { status: updated.status, reason: body.reason } });
    return updated;
  });
}

export async function listInstallationJobs(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "field.view");
  const q = listQuerySchema
    .extend({ status: z.enum(["PLANNED", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(), customerId: z.string().optional() })
    .parse(query);
  const where: Prisma.InstallationJobWhereInput = { ...jobScope(ctx), status: q.status, customerId: q.customerId, ...searchWhere(q.q, ["number", "address"]) };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.installationJob.findMany({ where, include: { customer: { select: { id: true, name: true } } }, ...listArgs(q, ["createdAt", "scheduledStart", "number"], "createdAt") }),
      prisma.installationJob.count({ where }),
    ]),
  );
}

export async function getInstallationJob(ctx: AccessContext, id: string) {
  assertCan(ctx, "field.view");
  const job = await prisma.installationJob.findFirst({ where: { id, ...jobScope(ctx) }, include });
  if (!job) throw new AppError("NOT_FOUND", "Installation job not found", 404);
  return job;
}
