import { z } from "zod";
import { LeadPriority, TaskStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { resolveEntity } from "@/lib/entities";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { createSystemNotification } from "@/lib/notifications/create";
import { assertActiveMember } from "@/lib/tenant/refs";

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  entityType: z.string().min(1).max(40).nullish(),
  entityId: z.string().min(1).max(64).nullish(),
  assignedUserId: z.string().uuid().nullish(),
  dueAt: z.coerce.date().nullish(),
  remindAt: z.coerce.date().nullish(),
  priority: z.nativeEnum(LeadPriority).optional(),
});

const updateSchema = taskSchema
  .omit({ entityType: true, entityId: true })
  .partial()
  .extend({ status: z.nativeEnum(TaskStatus).optional() });

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(TaskStatus).optional(),
  assignedUserId: z.string().uuid().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  dueBefore: z.coerce.date().optional(),
});

/** Tasks the caller may see: their own (assigned or created) unless they hold task.view_all. */
function visibleWhere(ctx: AccessContext): Prisma.TaskWhereInput {
  if (can(ctx, "task.view_all")) return { organizationId: ctx.organizationId };
  return {
    organizationId: ctx.organizationId,
    OR: [{ assignedUserId: ctx.userId }, { createdById: ctx.userId }],
  };
}

export async function createTask(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "task.create");
  const data = taskSchema.parse(input);
  if (Boolean(data.entityType) !== Boolean(data.entityId)) {
    throw new AppError("VALIDATION_ERROR", "entityType and entityId go together", 422);
  }
  const entity = data.entityType
    ? await resolveEntity(ctx, data.entityType, data.entityId!)
    : { companyId: null };
  const assignedUserId = data.assignedUserId ?? ctx.userId;
  if (assignedUserId !== ctx.userId) await assertActiveMember(ctx.organizationId, assignedUserId);

  return prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        ...data,
        organizationId: ctx.organizationId,
        companyId: entity.companyId,
        assignedUserId,
        createdById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "task.created", entity: "task", entityId: task.id, companyId: task.companyId, next: task });
    return task;
  });
}

export async function listTasks(ctx: AccessContext, query: unknown) {
  const q = listSchema.parse(query);
  if (q.entityType && q.entityId) await resolveEntity(ctx, q.entityType, q.entityId);
  const where: Prisma.TaskWhereInput = {
    AND: [
      visibleWhere(ctx),
      searchWhere(q.q, ["title", "description"]),
      {
        status: q.status,
        assignedUserId: q.assignedUserId,
        entityType: q.entityType,
        entityId: q.entityId,
        dueAt: q.dueBefore ? { lte: q.dueBefore } : undefined,
      },
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.task.findMany({ where, ...listArgs(q, ["createdAt", "dueAt", "priority", "title"], "dueAt") }),
      prisma.task.count({ where }),
    ]),
  );
}

export async function updateTask(ctx: AccessContext, id: string, input: unknown) {
  const data = updateSchema.parse(input);
  const before = await prisma.task.findFirst({ where: { id, ...visibleWhere(ctx) } });
  if (!before) throw new AppError("NOT_FOUND", "Task not found", 404);
  if (data.assignedUserId && data.assignedUserId !== before.assignedUserId) {
    assertCan(ctx, "task.create");
    await assertActiveMember(ctx.organizationId, data.assignedUserId);
  }

  const patch: Prisma.TaskUncheckedUpdateInput = {
    ...data,
    ...(data.status ? { completedAt: data.status === TaskStatus.COMPLETED ? new Date() : null } : {}),
    // A new reminder time re-arms the reminder.
    ...(data.remindAt !== undefined ? { remindedAt: null } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const task = await tx.task.update({ where: { id }, data: patch });
    const diff = changes(before as Record<string, unknown>, data);
    await audit(tx, ctx, {
      action: "task.updated",
      entity: "task",
      entityId: id,
      companyId: task.companyId,
      previous: diff.previous,
      next: diff.next,
    });
    return task;
  });
}

/** Job: notify assignees of pending tasks whose reminder time has passed (once each). */
export async function processDueTaskReminders(now = new Date()) {
  const due = await prisma.task.findMany({
    where: { status: TaskStatus.PENDING, remindAt: { lte: now }, remindedAt: null, assignedUserId: { not: null } },
    take: 500,
    orderBy: { remindAt: "asc" },
  });
  let sent = 0;
  for (const task of due) {
    // Notify (deduplicated) before claiming: overlapping runs notify once, and a crash
    // between the two steps re-sends a deduplicated notification instead of losing it.
    await createSystemNotification({
      organizationId: task.organizationId,
      userId: task.assignedUserId!,
      type: "task.reminder",
      title: `Reminder: ${task.title}`,
      body: task.dueAt ? `Due ${task.dueAt.toISOString()}` : undefined,
      data: { taskId: task.id, entityType: task.entityType, entityId: task.entityId },
      preferenceKey: "taskNotifications",
      dedupeKey: `task-reminder:${task.id}:${task.remindAt!.toISOString()}`,
    });
    const claimed = await prisma.task.updateMany({
      where: { id: task.id, remindedAt: null },
      data: { remindedAt: now },
    });
    if (claimed.count === 0) continue;
    sent += 1;
  }
  return { due: due.length, sent };
}
