import { z } from "zod";
import { LeadPriority, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";
import { assertActiveMember } from "@/lib/tenant/refs";

/**
 * Projects: PLANNED → ACTIVE ⇄ ON_HOLD → COMPLETED | CANCELLED (reopen → ACTIVE).
 *
 * Role-based access
 * - `project.view` is required for everything.
 * - `project.update` holders (owners, admins, the Project Manager role) see and manage every
 *   project in their company scope; they act as project OWNER everywhere.
 * - Everyone else sees only projects where they have a ProjectMember row, with that row's role:
 *     VIEWER  read and comment
 *     MEMBER  + create/edit tasks, log own time
 *     MANAGER + edit the project, milestones, members, delete tasks
 *     OWNER   + grant OWNER
 *   Projects they are not a member of answer 404.
 * - `project.create` creates projects (creator becomes OWNER, the manager MANAGER);
 *   `project.delete` deletes projects that have no time logged.
 */

export const PROJECT_ROLES = ["VIEWER", "MEMBER", "MANAGER", "OWNER"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
const rank = (role: ProjectRole) => PROJECT_ROLES.indexOf(role);

export const PROJECT_STATUSES = ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
export const CLOSED_PROJECT = ["COMPLETED", "CANCELLED"];

type Db = Prisma.TransactionClient | typeof prisma;

/** Projects the caller may see (company scope + membership unless project.update). */
export function projectScope(ctx: AccessContext): Prisma.ProjectWhereInput {
  const base = { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } };
  return can(ctx, "project.update") ? base : { ...base, members: { some: { userId: ctx.userId } } };
}

/**
 * A visible project plus the caller's effective role; 404 when not visible, 403 below `min`.
 * `lock` takes a row lock (state changes, re-parenting tasks, member changes).
 */
export async function projectAccess(db: Db, ctx: AccessContext, projectId: string, min: ProjectRole = "VIEWER", lock = false) {
  assertCan(ctx, "project.view");
  if (lock) await db.$queryRaw`SELECT 1 FROM "projects" WHERE "id" = ${projectId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const project = await db.project.findFirst({
    where: { id: projectId, ...projectScope(ctx) },
    include: { members: { where: { userId: ctx.userId } } },
  });
  if (!project) throw new AppError("NOT_FOUND", "Project not found", 404);
  const memberRole = (project.members[0]?.role ?? null) as ProjectRole | null;
  const role: ProjectRole = can(ctx, "project.update") ? "OWNER" : memberRole!;
  if (rank(role) < rank(min)) throw new AppError("FORBIDDEN", `Requires project role ${min}`, 403);
  return { project, role, isMember: memberRole !== null };
}

export function assertProjectOpen(project: { status: string }) {
  if (CLOSED_PROJECT.includes(project.status)) throw new AppError("INVALID_STATE", `Project is ${project.status.toLowerCase()}`, 422);
}

const dateRange = <T extends { startDate?: Date | null; endDate?: Date | null }>(d: T) => !d.startDate || !d.endDate || d.endDate >= d.startDate;

const baseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  customerId: z.string().min(1).nullish(),
  managerId: z.string().uuid().optional(),
  startDate: z.coerce.date().nullish(),
  endDate: z.coerce.date().nullish(),
  budget: zDecimal().nullish(),
  billable: z.boolean().optional(),
  hourlyRate: zDecimal().nullish(),
  description: z.string().trim().max(10000).nullish(),
});
const createSchema = baseSchema
  .extend({ companyId: z.string().min(1), code: z.string().trim().min(1).max(32) })
  .refine(dateRange, { message: "End date must be on or after the start date", path: ["endDate"] });
const updateSchema = baseSchema.partial().refine(dateRange, { message: "End date must be on or after the start date", path: ["endDate"] });

async function assertCustomer(db: Db, ctx: AccessContext, customerId?: string | null) {
  if (!customerId) return;
  const found = await db.customer.findFirst({ where: { id: customerId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!found) throw new AppError("INVALID_REFERENCE", "Customer does not belong to this organization", 422);
}

export async function createProject(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "project.view");
  assertCan(ctx, "project.create");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const managerId = data.managerId ?? ctx.userId;
  await assertActiveMember(ctx.organizationId, managerId);
  return prisma.$transaction(async (tx) => {
    await assertCustomer(tx, ctx, data.customerId);
    const project = await tx.project.create({ data: { ...data, organizationId: ctx.organizationId, managerId } });
    const members = [{ organizationId: ctx.organizationId, projectId: project.id, userId: ctx.userId, role: "OWNER" }];
    if (managerId !== ctx.userId) members.push({ ...members[0], userId: managerId, role: "MANAGER" });
    await tx.projectMember.createMany({ data: members });
    await audit(tx, ctx, { action: "project.created", entity: "project", entityId: project.id, companyId: project.companyId, next: project });
    return project;
  });
}

export async function updateProject(ctx: AccessContext, id: string, input: unknown) {
  const data = updateSchema.parse(input);
  if (data.managerId) await assertActiveMember(ctx.organizationId, data.managerId);
  return prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, id, "MANAGER", true);
    const merged = { startDate: project.startDate, endDate: project.endDate, ...data };
    if (!dateRange(merged)) throw new AppError("VALIDATION_ERROR", "End date must be on or after the start date", 422);
    await assertCustomer(tx, ctx, data.customerId);
    if (data.managerId && data.managerId !== project.managerId) {
      // The manager is always at least a MANAGER member.
      const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId: data.managerId } } });
      if (!existing) await tx.projectMember.create({ data: { organizationId: ctx.organizationId, projectId: id, userId: data.managerId, role: "MANAGER" } });
      else if (rank(existing.role as ProjectRole) < rank("MANAGER")) await tx.projectMember.update({ where: { id: existing.id }, data: { role: "MANAGER" } });
    }
    const updated = await tx.project.update({ where: { id }, data });
    const diff = changes(project as unknown as Record<string, unknown>, data);
    if (diff.changed) await audit(tx, ctx, { action: "project.updated", entity: "project", entityId: id, companyId: project.companyId, previous: diff.previous, next: diff.next });
    return updated;
  });
}

export async function deleteProject(ctx: AccessContext, id: string) {
  assertCan(ctx, "project.delete");
  return prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, id, "OWNER", true);
    if (await tx.timeEntry.count({ where: { projectId: id } })) {
      throw new AppError("INVALID_STATE", "Projects with logged time cannot be deleted; cancel the project instead", 422);
    }
    await tx.project.delete({ where: { id } });
    await audit(tx, ctx, { action: "project.deleted", entity: "project", entityId: id, companyId: project.companyId, previous: project });
    return { id };
  });
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  activate: { from: ["PLANNED", "ON_HOLD"], to: "ACTIVE" },
  hold: { from: ["ACTIVE"], to: "ON_HOLD" },
  complete: { from: ["ACTIVE", "ON_HOLD"], to: "COMPLETED" },
  cancel: { from: ["PLANNED", "ACTIVE", "ON_HOLD"], to: "CANCELLED" },
  reopen: { from: ["COMPLETED", "CANCELLED"], to: "ACTIVE" },
};
export const PROJECT_TRANSITIONS = Object.keys(TRANSITIONS);

export async function transitionProject(ctx: AccessContext, id: string, action: string) {
  const t = TRANSITIONS[action];
  if (!t) throw new AppError("NOT_FOUND", "Unknown project action", 404);
  return prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, id, "MANAGER", true);
    if (!t.from.includes(project.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a project that is ${project.status}`, 422);
    const updated = await tx.project.update({ where: { id }, data: { status: t.to } });
    await audit(tx, ctx, { action: `project.${action}`, entity: "project", entityId: id, companyId: project.companyId, previous: { status: project.status }, next: { status: t.to } });
    return updated;
  });
}

const memberSchema = z.object({ userId: z.string().uuid(), role: z.enum(PROJECT_ROLES).default("MEMBER") });

/** Adds a member or changes their role. Only an OWNER may grant OWNER. */
export async function setProjectMember(ctx: AccessContext, projectId: string, input: unknown) {
  const data = memberSchema.parse(input);
  await assertActiveMember(ctx.organizationId, data.userId);
  return prisma.$transaction(async (tx) => {
    const { project, role } = await projectAccess(tx, ctx, projectId, "MANAGER", true);
    if (data.role === "OWNER" && role !== "OWNER") throw new AppError("FORBIDDEN", "Only an owner can grant the owner role", 403);
    if (data.userId === project.managerId && rank(data.role) < rank("MANAGER")) {
      throw new AppError("INVALID_STATE", "The project manager must keep the manager or owner role", 422);
    }
    const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: data.userId } } });
    if (existing?.role === "OWNER" && role !== "OWNER") throw new AppError("FORBIDDEN", "Only an owner can change an owner", 403);
    const member = await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: data.userId } },
      create: { organizationId: ctx.organizationId, projectId, ...data },
      update: { role: data.role },
    });
    await audit(tx, ctx, { action: "project.member_set", entity: "project", entityId: projectId, companyId: project.companyId, previous: existing ? { userId: data.userId, role: existing.role } : undefined, next: data });
    return member;
  });
}

/** Removes a member and unassigns their open tasks (assignees must be members). */
export async function removeProjectMember(ctx: AccessContext, projectId: string, input: unknown) {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const { project, role } = await projectAccess(tx, ctx, projectId, "MANAGER", true);
    if (userId === project.managerId) throw new AppError("INVALID_STATE", "Change the project manager before removing them", 422);
    const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!existing) throw new AppError("NOT_FOUND", "Member not found", 404);
    if (existing.role === "OWNER" && role !== "OWNER") throw new AppError("FORBIDDEN", "Only an owner can remove an owner", 403);
    await tx.projectTask.updateMany({ where: { projectId, assigneeId: userId, status: { notIn: ["DONE", "CANCELLED"] } }, data: { assigneeId: null } });
    await tx.projectMember.delete({ where: { id: existing.id } });
    await audit(tx, ctx, { action: "project.member_removed", entity: "project", entityId: projectId, companyId: project.companyId, previous: { userId, role: existing.role } });
    return { userId };
  });
}

const milestoneSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dueDate: z.coerce.date().nullish(),
  status: z.enum(["OPEN", "DONE"]).optional(),
});

export async function createMilestone(ctx: AccessContext, projectId: string, input: unknown) {
  const data = milestoneSchema.omit({ status: true }).parse(input);
  return prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, projectId, "MANAGER");
    assertProjectOpen(project);
    const milestone = await tx.milestone.create({ data: { ...data, organizationId: ctx.organizationId, projectId } });
    await audit(tx, ctx, { action: "milestone.created", entity: "project", entityId: projectId, companyId: project.companyId, next: milestone });
    return milestone;
  });
}

export async function updateMilestone(ctx: AccessContext, projectId: string, milestoneId: string, input: unknown) {
  const data = milestoneSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, projectId, "MANAGER");
    const milestone = await tx.milestone.findFirst({ where: { id: milestoneId, projectId } });
    if (!milestone) throw new AppError("NOT_FOUND", "Milestone not found", 404);
    const completedAt = data.status === undefined || data.status === milestone.status ? undefined : data.status === "DONE" ? new Date() : null;
    const updated = await tx.milestone.update({ where: { id: milestoneId }, data: { ...data, completedAt } });
    await audit(tx, ctx, { action: "milestone.updated", entity: "project", entityId: projectId, companyId: project.companyId, previous: { milestone: milestone.name, status: milestone.status }, next: { milestone: updated.name, status: updated.status } });
    return updated;
  });
}

const listSchema = listQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  companyId: z.string().optional(),
  customerId: z.string().optional(),
  mine: z.enum(["true", "false"]).optional(),
});

/** Count-based progress: DONE / (all tasks except CANCELLED), subtasks included. */
export function progressOf(counts: Record<string, number>) {
  const total = Object.entries(counts).reduce((s, [status, n]) => (status === "CANCELLED" ? s : s + n), 0);
  const done = counts.DONE ?? 0;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

export async function taskCountsByProject(db: Db, projectIds: string[]) {
  const rows = await db.projectTask.groupBy({ by: ["projectId", "status"], where: { projectId: { in: projectIds } }, _count: { _all: true } });
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) out.set(r.projectId, { ...out.get(r.projectId), [r.status]: r._count._all });
  return out;
}

export async function listProjects(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "project.view");
  const q = listSchema.parse(query);
  const where: Prisma.ProjectWhereInput = {
    AND: [
      projectScope(ctx),
      { status: q.status, companyId: q.companyId, customerId: q.customerId },
      q.mine === "true" ? { members: { some: { userId: ctx.userId } } } : {},
      searchWhere(q.q, ["code", "name"]),
    ],
  };
  const page = await paginate(q, () =>
    Promise.all([
      prisma.project.findMany({ where, include: { customer: { select: { id: true, name: true } }, company: { select: { code: true } } }, ...listArgs(q, ["createdAt", "code", "name", "endDate", "status"], "createdAt") }),
      prisma.project.count({ where }),
    ]),
  );
  const counts = await taskCountsByProject(prisma, page.items.map((p) => p.id));
  return { ...page, items: page.items.map((p) => ({ ...p, progress: progressOf(counts.get(p.id) ?? {}) })) };
}

export async function getProject(ctx: AccessContext, id: string) {
  const { project, role, isMember } = await projectAccess(prisma, ctx, id);
  const [members, milestones, counts, customer] = await Promise.all([
    prisma.projectMember.findMany({ where: { projectId: id }, orderBy: { role: "asc" } }),
    prisma.milestone.findMany({ where: { projectId: id }, orderBy: [{ dueDate: "asc" }, { name: "asc" }] }),
    taskCountsByProject(prisma, [id]),
    project.customerId ? prisma.customer.findUnique({ where: { id: project.customerId }, select: { id: true, name: true } }) : null,
  ]);
  const users = await userNames([...members.map((m) => m.userId), project.managerId]);
  return {
    ...project,
    members: members.map((m) => ({ ...m, user: users.get(m.userId) ?? null })),
    manager: users.get(project.managerId) ?? null,
    customer,
    milestones,
    progress: progressOf(counts.get(id) ?? {}),
    myRole: role,
    isMember,
  };
}

/** id → { id, name, email } for display (users are global; ids come from tenant rows). */
export async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const users = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } }) : [];
  return new Map(users.map((u) => [u.id, u]));
}

export const TASK_PRIORITIES = Object.values(LeadPriority);
