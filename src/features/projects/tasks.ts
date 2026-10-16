import { z } from "zod";
import { LeadPriority, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";
import { assertActiveMember } from "@/lib/tenant/refs";
import { createSystemNotification } from "@/lib/notifications/create";
import { assertProjectOpen, projectAccess, projectScope, userNames, type ProjectRole } from "@/features/projects/projects";

/**
 * Project tasks: TODO ⇄ IN_PROGRESS ⇄ BLOCKED → DONE | CANCELLED (DONE/CANCELLED reopen to
 * IN_PROGRESS/TODO). Subtasks hang off `parentId` (same project, no cycles); a task can be DONE
 * only when its subtasks are DONE or CANCELLED. Assignees must be project members (MEMBER+).
 * Activity history is the audit log (entity "project_task"); attachments are documents with
 * entityType "project_task".
 */

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
const NEXT: Record<string, string[]> = {
  TODO: ["IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
  IN_PROGRESS: ["TODO", "BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["TODO", "IN_PROGRESS", "CANCELLED"],
  DONE: ["IN_PROGRESS"],
  CANCELLED: ["TODO"],
};

const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).nullish(),
  parentId: z.string().min(1).nullish(),
  milestoneId: z.string().min(1).nullish(),
  assigneeId: z.string().uuid().nullish(),
  priority: z.nativeEnum(LeadPriority).optional(),
  dueDate: z.coerce.date().nullish(),
  estimateHours: zDecimal({ max: 100000 }).nullish(),
};
const createSchema = z.object({ projectId: z.string().min(1), ...fields });
const updateSchema = z.object(fields).partial();

type Db = Prisma.TransactionClient;

async function lockTask(tx: Db, ctx: AccessContext, id: string, min: ProjectRole) {
  await tx.$queryRaw`SELECT 1 FROM "project_tasks" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const task = await tx.projectTask.findFirst({ where: { id, organizationId: ctx.organizationId, project: projectScope(ctx) } });
  if (!task) throw new AppError("NOT_FOUND", "Task not found", 404);
  const access = await projectAccess(tx, ctx, task.projectId, min);
  return { task, ...access };
}

async function validateRefs(tx: Db, ctx: AccessContext, projectId: string, data: { parentId?: string | null; milestoneId?: string | null; assigneeId?: string | null }, taskId?: string) {
  if (data.milestoneId && !(await tx.milestone.findFirst({ where: { id: data.milestoneId, projectId }, select: { id: true } }))) {
    throw new AppError("INVALID_REFERENCE", "Milestone does not belong to this project", 422);
  }
  if (data.assigneeId) {
    const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: data.assigneeId } } });
    if (!member || member.role === "VIEWER") throw new AppError("INVALID_REFERENCE", "Assignee must be a project member", 422);
    await assertActiveMember(ctx.organizationId, data.assigneeId);
  }
  if (data.parentId) {
    if (!(await tx.projectTask.findFirst({ where: { id: data.parentId, projectId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Parent task does not belong to this project", 422);
    }
    if (taskId) {
      // Walk up from the new parent; reaching this task means the move would create a cycle.
      const [hit] = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE up AS (
          SELECT "id", "parentId" FROM "project_tasks" WHERE "id" = ${data.parentId}
          UNION
          SELECT t."id", t."parentId" FROM "project_tasks" t JOIN up ON t."id" = up."parentId"
        ) SELECT "id" FROM up WHERE "id" = ${taskId} LIMIT 1`;
      if (hit) throw new AppError("INVALID_PARENT", "A task cannot be moved under itself or one of its subtasks", 422);
    }
  }
}

function notifyAssignee(ctx: AccessContext, task: { id: string; title: string; projectId: string; assigneeId: string | null }) {
  if (!task.assigneeId || task.assigneeId === ctx.userId) return;
  return createSystemNotification({
    organizationId: ctx.organizationId,
    userId: task.assigneeId,
    type: "PROJECT_TASK_ASSIGNED",
    title: `Task assigned: ${task.title}`,
    data: { taskId: task.id, href: `/projects/${task.projectId}/tasks/${task.id}` },
    preferenceKey: "taskNotifications",
  }).catch((e) => console.error("[projects] notification failed", e));
}

export async function createTask(ctx: AccessContext, input: unknown) {
  const data = createSchema.parse(input);
  const task = await prisma.$transaction(async (tx) => {
    const { project } = await projectAccess(tx, ctx, data.projectId, "MEMBER");
    assertProjectOpen(project);
    await validateRefs(tx, ctx, project.id, data);
    const task = await tx.projectTask.create({ data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "project_task.created", entity: "project_task", entityId: task.id, companyId: project.companyId, next: task });
    return task;
  });
  await notifyAssignee(ctx, task);
  return task;
}

export async function updateTask(ctx: AccessContext, id: string, input: unknown) {
  const data = updateSchema.parse(input);
  const { task, updated } = await prisma.$transaction(async (tx) => {
    const { task, project } = await lockTask(tx, ctx, id, "MEMBER");
    assertProjectOpen(project);
    // Serialize re-parenting within a project so two concurrent moves cannot form a cycle.
    if (data.parentId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project_tree:${task.projectId}`}))`;
    if (data.parentId === id) throw new AppError("INVALID_PARENT", "A task cannot be its own parent", 422);
    await validateRefs(tx, ctx, task.projectId, data, id);
    const updated = await tx.projectTask.update({ where: { id }, data });
    const diff = changes(task as unknown as Record<string, unknown>, data);
    if (diff.changed) await audit(tx, ctx, { action: "project_task.updated", entity: "project_task", entityId: id, companyId: project.companyId, previous: diff.previous, next: diff.next });
    return { task, updated };
  });
  if (updated.assigneeId !== task.assigneeId) await notifyAssignee(ctx, updated);
  return updated;
}

export async function setTaskStatus(ctx: AccessContext, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(TASK_STATUSES) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const { task, project } = await lockTask(tx, ctx, id, "MEMBER");
    assertProjectOpen(project);
    if (!NEXT[task.status]?.includes(status)) throw new AppError("INVALID_STATE", `Cannot move a ${task.status} task to ${status}`, 422);
    if (status === "DONE" && (await tx.projectTask.count({ where: { parentId: id, status: { notIn: ["DONE", "CANCELLED"] } } }))) {
      throw new AppError("INVALID_STATE", "Complete or cancel the subtasks first", 422);
    }
    const updated = await tx.projectTask.update({ where: { id }, data: { status, completedAt: status === "DONE" ? new Date() : null } });
    await audit(tx, ctx, { action: "project_task.status", entity: "project_task", entityId: id, companyId: project.companyId, previous: { status: task.status }, next: { status } });
    return updated;
  });
}

export async function deleteTask(ctx: AccessContext, id: string) {
  return prisma.$transaction(async (tx) => {
    const { task, project } = await lockTask(tx, ctx, id, "MANAGER");
    if (await tx.projectTask.count({ where: { parentId: id } })) throw new AppError("INVALID_STATE", "Delete or move the subtasks first", 422);
    if (await tx.timeEntry.count({ where: { taskId: id } })) throw new AppError("INVALID_STATE", "Tasks with logged time cannot be deleted; cancel it instead", 422);
    await tx.projectTask.delete({ where: { id } });
    await audit(tx, ctx, { action: "project_task.deleted", entity: "project_task", entityId: id, companyId: project.companyId, previous: task });
    return { id };
  });
}

export async function addTaskComment(ctx: AccessContext, taskId: string, input: unknown) {
  const { body } = z.object({ body: z.string().trim().min(1, "Comment cannot be empty").max(10000) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const { project } = await lockTask(tx, ctx, taskId, "VIEWER");
    const comment = await tx.taskComment.create({ data: { organizationId: ctx.organizationId, taskId, authorId: ctx.userId, body } });
    await audit(tx, ctx, { action: "project_task.commented", entity: "project_task", entityId: taskId, companyId: project.companyId, next: { commentId: comment.id } });
    return comment;
  });
}

const listSchema = listQuerySchema.extend({
  projectId: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.string().optional(),
  milestoneId: z.string().optional(),
  parentId: z.string().optional(),
  topLevel: z.enum(["true", "false"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
});

export async function listTasks(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "project.view");
  const q = listSchema.parse(query);
  const where: Prisma.ProjectTaskWhereInput = {
    AND: [
      { organizationId: ctx.organizationId, project: projectScope(ctx) },
      { projectId: q.projectId, status: q.status, milestoneId: q.milestoneId, parentId: q.topLevel === "true" ? null : q.parentId },
      { assigneeId: q.mine === "true" ? ctx.userId : q.assigneeId },
      searchWhere(q.q, ["title"]),
    ],
  };
  const page = await paginate(q, () =>
    Promise.all([
      prisma.projectTask.findMany({
        where,
        include: { project: { select: { id: true, code: true, name: true } }, milestone: { select: { id: true, name: true } }, _count: { select: { subtasks: true } } },
        ...listArgs(q, ["createdAt", "dueDate", "priority", "status", "title"], "createdAt"),
      }),
      prisma.projectTask.count({ where }),
    ]),
  );
  const users = await userNames(page.items.map((t) => t.assigneeId));
  return { ...page, items: page.items.map((t) => ({ ...t, assignee: t.assigneeId ? users.get(t.assigneeId) ?? null : null })) };
}

export async function getTask(ctx: AccessContext, id: string) {
  assertCan(ctx, "project.view");
  const task = await prisma.projectTask.findFirst({
    where: { id, organizationId: ctx.organizationId, project: projectScope(ctx) },
    include: {
      project: { select: { id: true, code: true, name: true, status: true, companyId: true } },
      milestone: { select: { id: true, name: true } },
      parent: { select: { id: true, title: true } },
      subtasks: { orderBy: { createdAt: "asc" } },
      comments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!task) throw new AppError("NOT_FOUND", "Task not found", 404);
  const { role } = await projectAccess(prisma, ctx, task.projectId);
  const [hours, activity] = await Promise.all([
    prisma.timeEntry.aggregate({ where: { taskId: id }, _sum: { hours: true } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.organizationId, entity: "project_task", entityId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const users = await userNames([task.assigneeId, task.createdById, ...task.comments.map((c) => c.authorId), ...task.subtasks.map((s) => s.assigneeId), ...activity.map((a) => a.userId)]);
  return {
    ...task,
    assignee: task.assigneeId ? users.get(task.assigneeId) ?? null : null,
    createdBy: users.get(task.createdById) ?? null,
    comments: task.comments.map((c) => ({ ...c, author: users.get(c.authorId) ?? null })),
    subtasks: task.subtasks.map((s) => ({ ...s, assignee: s.assigneeId ? users.get(s.assigneeId) ?? null : null })),
    loggedHours: hours._sum.hours?.toString() ?? "0",
    activity: activity.map((a) => ({ id: a.id, action: a.action, createdAt: a.createdAt, previous: a.previous, next: a.next, user: a.userId ? users.get(a.userId) ?? null : null })),
    myRole: role,
  };
}
