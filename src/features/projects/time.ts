import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { Decimal, zDecimal } from "@/lib/money";
import { assertProjectOpen, projectAccess, projectScope, userNames } from "@/features/projects/projects";

/**
 * Time entries. A user logs their own time on projects they are a member of (MEMBER+),
 * optionally against one of the project's tasks. Rules: hours > 0, at most 24 hours per user
 * per calendar day across all projects, no future dates, no logging on completed/cancelled
 * projects. `billable` defaults to the project's flag; cost/billing uses the project's
 * `hourlyRate` (the schema has no per-entry rate and no approval/lock fields).
 * The author edits/deletes their entries; project MANAGER+ may also delete them.
 */

const MAX_DAY = new Decimal(24);

const fields = {
  taskId: z.string().min(1).nullish(),
  date: z.coerce.date(),
  hours: zDecimal({ min: 0.01, max: 24 }),
  billable: z.boolean().optional(),
  description: z.string().trim().max(2000).nullish(),
};
const createSchema = z.object({ projectId: z.string().min(1), ...fields });
const updateSchema = z.object(fields).partial();

const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function checkEntry(tx: Prisma.TransactionClient, ctx: AccessContext, projectId: string, e: { taskId?: string | null; date: Date; hours: Decimal }, excludeId?: string) {
  if (day(e.date) > day(new Date())) throw new AppError("VALIDATION_ERROR", "Time cannot be logged for a future date", 422);
  if (e.taskId && !(await tx.projectTask.findFirst({ where: { id: e.taskId, projectId }, select: { id: true } }))) {
    throw new AppError("INVALID_REFERENCE", "Task does not belong to this project", 422);
  }
  // Serialize a user's entries for the day so concurrent requests cannot exceed 24h together.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${ctx.userId}:${day(e.date).toISOString()}`}, 0))`;
  const logged = await tx.timeEntry.aggregate({
    where: { organizationId: ctx.organizationId, userId: ctx.userId, date: day(e.date), id: excludeId ? { not: excludeId } : undefined },
    _sum: { hours: true },
  });
  const total = new Decimal(logged._sum.hours ?? 0).add(e.hours);
  if (total.gt(MAX_DAY)) throw new AppError("DAILY_LIMIT", `That would make ${total.toString()} hours on this day (max 24)`, 422);
}

async function memberAccess(tx: Prisma.TransactionClient, ctx: AccessContext, projectId: string) {
  const access = await projectAccess(tx, ctx, projectId, "MEMBER");
  if (!access.isMember || access.project.members[0].role === "VIEWER") {
    throw new AppError("FORBIDDEN", "Only project members can log time on this project", 403);
  }
  assertProjectOpen(access.project);
  return access;
}

export async function createTimeEntry(ctx: AccessContext, input: unknown) {
  const data = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const { project } = await memberAccess(tx, ctx, data.projectId);
    await checkEntry(tx, ctx, project.id, data);
    const entry = await tx.timeEntry.create({
      data: { ...data, date: day(data.date), billable: data.billable ?? project.billable, organizationId: ctx.organizationId, userId: ctx.userId },
    });
    await audit(tx, ctx, { action: "time_entry.created", entity: "time_entry", entityId: entry.id, companyId: project.companyId, next: entry });
    return entry;
  });
}

async function lockEntry(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "time_entries" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const entry = await tx.timeEntry.findFirst({ where: { id, organizationId: ctx.organizationId, project: projectScope(ctx) } });
  if (!entry) throw new AppError("NOT_FOUND", "Time entry not found", 404);
  return entry;
}

export async function updateTimeEntry(ctx: AccessContext, id: string, input: unknown) {
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, ctx, id);
    if (entry.userId !== ctx.userId) throw new AppError("FORBIDDEN", "You can only edit your own time entries", 403);
    const { project } = await memberAccess(tx, ctx, entry.projectId);
    const next = { taskId: data.taskId === undefined ? entry.taskId : data.taskId, date: day(data.date ?? entry.date), hours: data.hours ?? entry.hours };
    await checkEntry(tx, ctx, entry.projectId, next, id);
    const patch = { ...data, date: data.date ? next.date : undefined };
    const updated = await tx.timeEntry.update({ where: { id }, data: patch });
    const diff = changes(entry as unknown as Record<string, unknown>, patch);
    if (diff.changed) await audit(tx, ctx, { action: "time_entry.updated", entity: "time_entry", entityId: id, companyId: project.companyId, previous: diff.previous, next: diff.next });
    return updated;
  });
}

export async function deleteTimeEntry(ctx: AccessContext, id: string) {
  return prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, ctx, id);
    const { project, role } = await projectAccess(tx, ctx, entry.projectId);
    if (entry.userId !== ctx.userId && role !== "MANAGER" && role !== "OWNER") {
      throw new AppError("FORBIDDEN", "You can only delete your own time entries", 403);
    }
    await tx.timeEntry.delete({ where: { id } });
    await audit(tx, ctx, { action: "time_entry.deleted", entity: "time_entry", entityId: id, companyId: project.companyId, previous: entry });
    return { id };
  });
}

const listSchema = listQuerySchema.extend({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  userId: z.string().optional(),
  mine: z.enum(["true", "false"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  billable: z.enum(["true", "false"]).optional(),
});

/** Entries on projects the caller can see. */
export async function listTimeEntries(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "project.view");
  const q = listSchema.parse(query);
  const where: Prisma.TimeEntryWhereInput = {
    organizationId: ctx.organizationId,
    project: projectScope(ctx),
    projectId: q.projectId,
    taskId: q.taskId,
    userId: q.mine === "true" ? ctx.userId : q.userId,
    billable: q.billable ? q.billable === "true" : undefined,
    date: q.from || q.to ? { gte: q.from ? day(q.from) : undefined, lte: q.to ? day(q.to) : undefined } : undefined,
  };
  const [page, sum] = await Promise.all([
    paginate(q, () =>
      Promise.all([
        prisma.timeEntry.findMany({
          where,
          include: { project: { select: { id: true, code: true, name: true } }, task: { select: { id: true, title: true } } },
          ...listArgs(q, ["date", "createdAt", "hours"], "date"),
        }),
        prisma.timeEntry.count({ where }),
      ]),
    ),
    prisma.timeEntry.aggregate({ where, _sum: { hours: true } }),
  ]);
  const users = await userNames(page.items.map((e) => e.userId));
  return { ...page, totalHours: (sum._sum.hours ?? new Decimal(0)).toString(), items: page.items.map((e) => ({ ...e, user: users.get(e.userId) ?? null })) };
}
