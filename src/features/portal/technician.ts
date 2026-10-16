import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { notFound, type PortalContext } from "@/features/portal/context";

/**
 * Technician portal: service visits and installation jobs where technicianId is the
 * portal user. Start / complete / checklist follow the same state rules as
 * service/field.ts transitionVisit() and service/installations.ts (re-implemented here
 * because those take an internal AccessContext). Rescheduling and cancelling stay internal.
 * Customer data is limited to what the job needs: name, phone, site address.
 */

const customer = { select: { name: true, phone: true } } as const;

const visitSelect = {
  id: true,
  status: true,
  serviceType: true,
  scheduledStart: true,
  scheduledEnd: true,
  notes: true,
  workDone: true,
  customerSignedBy: true,
  checkInAt: true,
  completedAt: true,
  asset: { select: { tag: true, name: true, serialNumber: true, location: true, customer } },
  ticket: { select: { number: true, subject: true, description: true, customer } },
  contract: { select: { number: true } },
} as const;

const jobSelect = {
  id: true,
  number: true,
  status: true,
  address: true,
  scheduledStart: true,
  scheduledEnd: true,
  notes: true,
  completedAt: true,
  customer: { select: { name: true, phone: true, shippingAddress: true } },
  asset: { select: { tag: true, name: true, serialNumber: true } },
  checklist: { select: { id: true, label: true, required: true, done: true, doneAt: true, note: true }, orderBy: { sortOrder: "asc" } },
} satisfies Prisma.InstallationJobSelect;

const mine = (p: PortalContext) => ({ organizationId: p.organizationId, technicianId: p.userId });

export async function listJobs(p: PortalContext, query: unknown = {}) {
  const { open } = z.object({ open: z.enum(["true", "false"]).optional() }).parse(query);
  const openOnly = open !== "false";
  const [visits, installations] = await Promise.all([
    prisma.serviceVisit.findMany({
      where: { ...mine(p), status: openOnly ? { in: ["SCHEDULED", "IN_PROGRESS"] } : undefined },
      select: visitSelect,
      orderBy: { scheduledStart: openOnly ? "asc" : "desc" },
      take: 200,
    }),
    prisma.installationJob.findMany({
      where: { ...mine(p), status: openOnly ? { in: ["PLANNED", "SCHEDULED", "IN_PROGRESS"] } : undefined },
      select: jobSelect,
      orderBy: { scheduledStart: openOnly ? "asc" : "desc" },
      take: 200,
    }),
  ]);
  return { visits, installations };
}

export async function getVisit(p: PortalContext, id: string) {
  const v = await prisma.serviceVisit.findFirst({ where: { id, ...mine(p) }, select: visitSelect });
  if (!v) throw notFound("Visit");
  return v;
}

export async function getInstallation(p: PortalContext, id: string) {
  const j = await prisma.installationJob.findFirst({ where: { id, ...mine(p) }, select: jobSelect });
  if (!j) throw notFound("Installation job");
  return j;
}

const visitActions = {
  start: z.object({}),
  complete: z.object({
    notes: z.string({ required_error: "Visit notes are required" }).trim().min(1, "Visit notes are required").max(5000),
    workDone: z.string().trim().max(5000).nullish(),
    customerSignedBy: z.string().trim().max(200).nullish(),
  }),
};

export async function transitionVisit(p: PortalContext, id: string, action: string, input: unknown) {
  if (action !== "start" && action !== "complete") throw notFound("Action");
  const body = visitActions[action].parse(input ?? {}) as { notes?: string; workDone?: string | null; customerSignedBy?: string | null };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "service_visits" WHERE "id" = ${id} AND "organizationId" = ${p.organizationId} FOR UPDATE`;
    const v = await tx.serviceVisit.findFirst({ where: { id, ...mine(p) }, select: { status: true, companyId: true } });
    if (!v) throw notFound("Visit");
    const from = action === "start" ? "SCHEDULED" : "IN_PROGRESS";
    if (v.status !== from) throw new AppError("INVALID_STATE", `Cannot ${action} a ${v.status} visit`, 422);
    const data: Prisma.ServiceVisitUncheckedUpdateInput =
      action === "start"
        ? { status: "IN_PROGRESS", checkInAt: new Date() }
        : { status: "COMPLETED", completedAt: new Date(), notes: body.notes, workDone: body.workDone ?? null, customerSignedBy: body.customerSignedBy ?? null };
    const updated = await tx.serviceVisit.update({ where: { id }, data, select: visitSelect });
    await audit(tx, p, { action: `service_visit.${action}`, entity: "service_visit", entityId: id, companyId: v.companyId, previous: { status: v.status }, next: { status: updated.status, note: body.notes, via: "portal" } });
    return updated;
  });
}

async function lockJob(tx: Prisma.TransactionClient, p: PortalContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "installation_jobs" WHERE "id" = ${id} AND "organizationId" = ${p.organizationId} FOR UPDATE`;
  const job = await tx.installationJob.findFirst({ where: { id, ...mine(p) }, select: { status: true, companyId: true, notes: true, checklist: true } });
  if (!job) throw notFound("Installation job");
  return job;
}

export async function updateChecklistItem(p: PortalContext, jobId: string, itemId: string, input: unknown) {
  const data = z.object({ done: z.boolean(), note: z.string().trim().max(1000).nullish() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const job = await lockJob(tx, p, jobId);
    if (job.status === "COMPLETED" || job.status === "CANCELLED") throw new AppError("INVALID_STATE", `The job is ${job.status}`, 422);
    const item = job.checklist.find((c) => c.id === itemId);
    if (!item) throw notFound("Checklist item");
    const updated = await tx.installationChecklistItem.update({
      where: { id: itemId },
      data: { done: data.done, note: data.note, doneAt: data.done ? new Date() : null, doneById: data.done ? p.userId : null },
      select: { id: true, label: true, required: true, done: true, doneAt: true, note: true },
    });
    await audit(tx, p, { action: "installation_job.checklist", entity: "installation_job", entityId: jobId, companyId: job.companyId, previous: { item: item.label, done: item.done }, next: { item: item.label, done: data.done, note: data.note, via: "portal" } });
    return updated;
  });
}

export async function transitionInstallation(p: PortalContext, id: string, action: string, input: unknown) {
  if (action !== "start" && action !== "complete") throw notFound("Action");
  const body = z.object({ notes: z.string().trim().max(5000).nullish() }).parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const job = await lockJob(tx, p, id);
    const from = action === "start" ? "SCHEDULED" : "IN_PROGRESS";
    if (job.status !== from) throw new AppError("INVALID_STATE", `Cannot ${action} a ${job.status} job`, 422);
    let data: Prisma.InstallationJobUncheckedUpdateInput = { status: "IN_PROGRESS" };
    if (action === "complete") {
      const open = job.checklist.filter((c) => c.required && !c.done);
      if (open.length) throw new AppError("CHECKLIST_INCOMPLETE", `Complete the required checklist items first: ${open.map((c) => c.label).join(", ")}`, 422, { items: open.map((c) => c.id) });
      data = { status: "COMPLETED", completedAt: new Date(), notes: body.notes ?? job.notes };
    }
    const updated = await tx.installationJob.update({ where: { id }, data, select: jobSelect });
    await audit(tx, p, { action: `installation_job.${action}`, entity: "installation_job", entityId: id, companyId: job.companyId, previous: { status: job.status }, next: { status: updated.status, via: "portal" } });
    return updated;
  });
}
