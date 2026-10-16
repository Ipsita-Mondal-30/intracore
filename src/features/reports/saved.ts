import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { REPORT_ENTITIES } from "@/features/reports/catalog";
import { executeReport, parseDefinition } from "@/features/reports/builder";

/**
 * Saved report definitions. Creating, editing and deleting need `report.build` (only the
 * creator edits or deletes). A report is visible to its creator and, when shared, to every
 * org member holding the entity's permission. Running re-validates the stored definition
 * against the current catalog and applies the runner's own scope and permissions.
 */

const createSchema = z.object({ name: z.string().trim().min(1).max(120), definition: z.unknown(), isShared: z.boolean().default(false) }).strict();
const updateSchema = createSchema.partial();

export const readableEntities = (ctx: AccessContext) => Object.entries(REPORT_ENTITIES).filter(([, e]) => can(ctx, e.permission)).map(([k]) => k);

const visibleWhere = (ctx: AccessContext): Prisma.SavedReportWhereInput => ({
  organizationId: ctx.organizationId,
  entity: { in: readableEntities(ctx) },
  OR: [{ createdById: ctx.userId }, { isShared: true }],
});

export async function getSavedReport(ctx: AccessContext, id: string) {
  const row = await prisma.savedReport.findFirst({ where: { id, ...visibleWhere(ctx) } });
  if (!row) throw new AppError("NOT_FOUND", "Saved report not found", 404);
  return row;
}

async function ownReport(ctx: AccessContext, id: string) {
  assertCan(ctx, "report.build");
  const row = await getSavedReport(ctx, id);
  if (row.createdById !== ctx.userId) throw new AppError("FORBIDDEN", "Only the creator can change this report", 403);
  return row;
}

export async function listSavedReports(ctx: AccessContext, query: unknown) {
  const q = listQuerySchema.extend({ entity: z.string().max(40).optional() }).parse(query);
  const where: Prisma.SavedReportWhereInput = { AND: [visibleWhere(ctx), q.entity ? { entity: q.entity } : {}, searchWhere(q.q, ["name"])] };
  return paginate(q, () =>
    Promise.all([
      prisma.savedReport.findMany({ where, ...listArgs(q, ["name", "createdAt", "updatedAt"], "name") }),
      prisma.savedReport.count({ where }),
    ]),
  );
}

export async function createSavedReport(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "report.build");
  const data = createSchema.parse(input);
  const definition = parseDefinition(data.definition);
  assertCan(ctx, REPORT_ENTITIES[definition.entity].permission);
  return prisma.$transaction(async (tx) => {
    const row = await tx.savedReport.create({
      data: { organizationId: ctx.organizationId, name: data.name, entity: definition.entity, definition: definition as Prisma.InputJsonValue, isShared: data.isShared, createdById: ctx.userId },
    });
    await audit(tx, ctx, { action: "saved_report.created", entity: "saved_report", entityId: row.id, next: { name: row.name, entity: row.entity, isShared: row.isShared } });
    return row;
  });
}

export async function updateSavedReport(ctx: AccessContext, id: string, input: unknown) {
  const before = await ownReport(ctx, id);
  const data = updateSchema.parse(input);
  const definition = data.definition === undefined ? undefined : parseDefinition(data.definition);
  if (definition) assertCan(ctx, REPORT_ENTITIES[definition.entity].permission);
  return prisma.$transaction(async (tx) => {
    const row = await tx.savedReport.update({
      where: { id },
      data: { name: data.name, isShared: data.isShared, ...(definition ? { definition: definition as Prisma.InputJsonValue, entity: definition.entity } : {}) },
    });
    await audit(tx, ctx, { action: "saved_report.updated", entity: "saved_report", entityId: id, previous: { name: before.name, entity: before.entity, isShared: before.isShared }, next: { name: row.name, entity: row.entity, isShared: row.isShared } });
    return row;
  });
}

export async function deleteSavedReport(ctx: AccessContext, id: string) {
  const before = await ownReport(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.savedReport.delete({ where: { id } });
    await audit(tx, ctx, { action: "saved_report.deleted", entity: "saved_report", entityId: id, previous: { name: before.name, entity: before.entity } });
  });
  return { id, deleted: true };
}

/** Runs a visible saved report with the caller's own permissions and scope. */
export async function runSavedReport(ctx: AccessContext, id: string) {
  const row = await getSavedReport(ctx, id);
  return { report: { id: row.id, name: row.name }, ...(await executeReport(ctx, parseDefinition(row.definition))) };
}
