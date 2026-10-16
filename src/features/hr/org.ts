import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";

/**
 * HR organisation setup: departments, designations (org-wide), shifts and holidays
 * (per company). Reads need any HR-ish permission; writes need `hr.administer` and
 * access to the whole company.
 */

export const HR_READ = ["hr.view", "employee.view", "attendance.view", "leave.view", "leave.apply", "attendance.self"];

export function assertAny(ctx: AccessContext, codes: string[]) {
  if (!codes.some((c) => can(ctx, c))) throw new AppError("FORBIDDEN", `Missing permission: ${codes[0]}`, 403);
}

/** HR setup is managed by members scoped to the whole company. */
export function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

/** Company ids to read: the requested one if in scope, else every company in scope. */
export function scopedCompanies(ctx: AccessContext, companyId?: string | null) {
  return companyId ? [companyId].filter((id) => ctx.companies.has(id)) : [...ctx.companies.keys()];
}

/** yyyy-mm-dd → UTC midnight (the form `@db.Date` columns round-trip as). */
export const zDay = z.coerce.date().transform((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));

const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only").transform((s) => s.toUpperCase());
const name = z.string().trim().min(1).max(120);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const workDays = z
  .string()
  .regex(/^[1-7](,[1-7])*$/, "ISO weekdays 1-7, comma separated")
  .transform((s) => [...new Set(s.split(","))].sort().join(","));

// ─── Departments ──────────────────────────────────────────────────────────────

const departmentSchema = z.object({
  companyId: z.string().min(1),
  code,
  name,
  parentId: z.string().min(1).nullish(),
});

export async function listDepartments(ctx: AccessContext, companyId?: string | null) {
  assertAny(ctx, HR_READ);
  return prisma.department.findMany({
    where: { organizationId: ctx.organizationId, companyId: { in: scopedCompanies(ctx, companyId) } },
    include: { parent: { select: { id: true, name: true } }, _count: { select: { employees: true } } },
    orderBy: [{ companyId: "asc" }, { name: "asc" }],
  });
}

async function assertParent(tx: Prisma.TransactionClient, companyId: string, id: string | null | undefined, self?: string) {
  if (!id) return;
  // Walk up from the proposed parent; reaching `self` would close a loop.
  let cursor: string | null = id;
  for (let depth = 0; cursor && depth < 50; depth++) {
    if (cursor === self) throw new AppError("VALIDATION_ERROR", "A department cannot be nested under itself", 422);
    const row: { companyId: string; parentId: string | null } | null = await tx.department.findUnique({ where: { id: cursor }, select: { companyId: true, parentId: true } });
    if (!row || row.companyId !== companyId) throw new AppError("INVALID_REFERENCE", "Parent department not found in this company", 422);
    cursor = row.parentId;
  }
}

export async function createDepartment(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = departmentSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    await assertParent(tx, data.companyId, data.parentId);
    const row = await tx.department.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "department.created", entity: "department", entityId: row.id, companyId: row.companyId, next: row });
    return row;
  });
}

export async function updateDepartment(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = departmentSchema.omit({ companyId: true }).partial().extend({ isActive: z.boolean().optional() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.department.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Department not found", 404);
    assertFullCompany(ctx, before.companyId);
    await assertParent(tx, before.companyId, data.parentId, id);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const row = await tx.department.update({ where: { id }, data });
    await audit(tx, ctx, { action: "department.updated", entity: "department", entityId: id, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return row;
  });
}

// ─── Designations (organization-wide) ─────────────────────────────────────────

const designationSchema = z.object({ name, level: z.coerce.number().int().min(0).max(100).nullish() });

export async function listDesignations(ctx: AccessContext) {
  assertAny(ctx, HR_READ);
  return prisma.designation.findMany({
    where: { organizationId: ctx.organizationId },
    include: { _count: { select: { employees: true } } },
    orderBy: [{ level: "asc" }, { name: "asc" }],
  });
}

export async function createDesignation(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = designationSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const row = await tx.designation.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "designation.created", entity: "designation", entityId: row.id, next: row });
    return row;
  });
}

export async function updateDesignation(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = designationSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.designation.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Designation not found", 404);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const row = await tx.designation.update({ where: { id }, data });
    await audit(tx, ctx, { action: "designation.updated", entity: "designation", entityId: id, previous: diff.previous, next: diff.next });
    return row;
  });
}

// ─── Shifts ───────────────────────────────────────────────────────────────────

const shiftSchema = z.object({
  companyId: z.string().min(1),
  name,
  startTime: hhmm,
  endTime: hhmm,
  graceMinutes: z.coerce.number().int().min(0).max(240).default(10),
  workDays: workDays.default("1,2,3,4,5"),
});

export async function listShifts(ctx: AccessContext, companyId?: string | null) {
  assertAny(ctx, HR_READ);
  return prisma.shift.findMany({
    where: { organizationId: ctx.organizationId, companyId: { in: scopedCompanies(ctx, companyId) } },
    include: { _count: { select: { employees: true } } },
    orderBy: [{ companyId: "asc" }, { name: "asc" }],
  });
}

export async function createShift(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = shiftSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.shift.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "shift.created", entity: "shift", entityId: row.id, companyId: row.companyId, next: row });
    return row;
  });
}

export async function updateShift(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = shiftSchema
    .omit({ companyId: true })
    .extend({ graceMinutes: z.coerce.number().int().min(0).max(240), workDays, isActive: z.boolean() })
    .partial()
    .parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.shift.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Shift not found", 404);
    assertFullCompany(ctx, before.companyId);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const row = await tx.shift.update({ where: { id }, data });
    await audit(tx, ctx, { action: "shift.updated", entity: "shift", entityId: id, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return row;
  });
}

// ─── Holidays ─────────────────────────────────────────────────────────────────

export async function listHolidays(ctx: AccessContext, query: unknown) {
  assertAny(ctx, HR_READ);
  const q = z.object({ companyId: z.string().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }).parse(query);
  return prisma.holiday.findMany({
    where: {
      organizationId: ctx.organizationId,
      companyId: { in: scopedCompanies(ctx, q.companyId) },
      date: q.year ? { gte: new Date(Date.UTC(q.year, 0, 1)), lt: new Date(Date.UTC(q.year + 1, 0, 1)) } : undefined,
    },
    orderBy: { date: "asc" },
  });
}

export async function createHoliday(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = z.object({ companyId: z.string().min(1), date: zDay, name }).parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.holiday.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "holiday.created", entity: "holiday", entityId: row.id, companyId: row.companyId, next: row });
    return row;
  });
}

/** Deleting a holiday does not re-price leave already applied over it. */
export async function deleteHoliday(ctx: AccessContext, id: string) {
  assertCan(ctx, "hr.administer");
  return prisma.$transaction(async (tx) => {
    const row = await tx.holiday.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!row) throw new AppError("NOT_FOUND", "Holiday not found", 404);
    assertFullCompany(ctx, row.companyId);
    await tx.holiday.delete({ where: { id } });
    await audit(tx, ctx, { action: "holiday.deleted", entity: "holiday", entityId: id, companyId: row.companyId, previous: row });
    return { id };
  });
}

/** Select options for employee forms (pages only). */
export async function hrFormOptions(ctx: AccessContext) {
  const [departments, designations, shifts, people] = await Promise.all([
    listDepartments(ctx),
    listDesignations(ctx),
    listShifts(ctx),
    prisma.employee.findMany({
      where: { AND: [companyScopeWhere(ctx), { status: { not: "EXITED" } }] },
      select: { id: true, fullName: true, employeeNumber: true, companyId: true },
      orderBy: { fullName: "asc" },
      take: 1000,
    }),
  ]);
  return {
    departments: departments.filter((d) => d.isActive),
    designations,
    shifts: shifts.filter((s) => s.isActive),
    people,
  };
}
