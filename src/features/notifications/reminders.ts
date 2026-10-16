import { z } from "zod";
import type { Prisma, Reminder } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { resolveEntity } from "@/lib/entities";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { createSystemNotification } from "@/lib/notifications/create";
import { assertActiveMember } from "@/lib/tenant/refs";
import { sanitizeError } from "@/lib/sanitize";

/**
 * Personal reminders: one-off or recurring (DAILY / WEEKLY / MONTHLY every `interval`),
 * optionally until `endsAt`. Times are absolute instants; recurrence steps in UTC.
 * Any member manages their own; creating one for someone else needs task.view_all.
 */
export const RECURRENCES = ["NONE", "DAILY", "WEEKLY", "MONTHLY"] as const;

const baseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).nullish(),
  userId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(40).nullish(),
  entityId: z.string().min(1).max(64).nullish(),
  nextRunAt: z.coerce.date(),
  recurrence: z.enum(RECURRENCES).default("NONE"),
  interval: z.coerce.number().int().min(1).max(365).default(1),
  endsAt: z.coerce.date().nullish(),
});
const createSchema = baseSchema.refine((d) => !d.endsAt || d.endsAt >= d.nextRunAt, {
  path: ["endsAt"],
  message: "endsAt must not be before the first reminder",
});
const updateSchema = baseSchema
  .omit({ userId: true, entityType: true, entityId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });
const listSchema = listQuerySchema.extend({
  active: z.enum(["true", "false"]).optional(),
  userId: z.string().uuid().optional(),
});

/** Own reminders (for me or created by me); task.view_all sees the whole organization's. */
function visibleWhere(ctx: AccessContext): Prisma.ReminderWhereInput {
  if (can(ctx, "task.view_all")) return { organizationId: ctx.organizationId };
  return { organizationId: ctx.organizationId, OR: [{ userId: ctx.userId }, { createdById: ctx.userId }] };
}

export async function createReminder(ctx: AccessContext, input: unknown) {
  const data = createSchema.parse(input);
  if (Boolean(data.entityType) !== Boolean(data.entityId)) {
    throw new AppError("VALIDATION_ERROR", "entityType and entityId go together", 422);
  }
  const entity = data.entityType ? await resolveEntity(ctx, data.entityType, data.entityId!) : { companyId: null };
  const userId = data.userId ?? ctx.userId;
  if (userId !== ctx.userId) {
    if (!can(ctx, "task.view_all")) {
      throw new AppError("FORBIDDEN", "Missing permission: task.view_all (reminders for other members)", 403);
    }
    await assertActiveMember(ctx.organizationId, userId);
  }
  return prisma.$transaction(async (tx) => {
    const reminder = await tx.reminder.create({
      data: { ...data, userId, organizationId: ctx.organizationId, createdById: ctx.userId },
    });
    await audit(tx, ctx, { action: "reminder.created", entity: "reminder", entityId: reminder.id, companyId: entity.companyId, next: reminder });
    return reminder;
  });
}

export async function listReminders(ctx: AccessContext, query: unknown) {
  const q = listSchema.parse(query);
  const where: Prisma.ReminderWhereInput = {
    AND: [
      visibleWhere(ctx),
      searchWhere(q.q, ["title", "body"]),
      { userId: q.userId, isActive: q.active === undefined ? undefined : q.active === "true" },
    ],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.reminder.findMany({ where, ...listArgs(q, ["nextRunAt", "createdAt", "title"], "nextRunAt") }),
      prisma.reminder.count({ where }),
    ]),
  );
}

async function requireReminder(ctx: AccessContext, id: string) {
  const reminder = await prisma.reminder.findFirst({ where: { id, ...visibleWhere(ctx) } });
  if (!reminder) throw new AppError("NOT_FOUND", "Reminder not found", 404);
  return reminder;
}

export async function getReminder(ctx: AccessContext, id: string) {
  return requireReminder(ctx, id);
}

export async function updateReminder(ctx: AccessContext, id: string, input: unknown) {
  const data = updateSchema.parse(input);
  const before = await requireReminder(ctx, id);
  const nextRunAt = data.nextRunAt ?? before.nextRunAt;
  const endsAt = data.endsAt === undefined ? before.endsAt : data.endsAt;
  if (endsAt && endsAt < nextRunAt) {
    throw new z.ZodError([{ code: "custom", path: ["endsAt"], message: "endsAt must not be before the next reminder" }]);
  }
  return prisma.$transaction(async (tx) => {
    const reminder = await tx.reminder.update({ where: { id }, data });
    const diff = changes(before as Record<string, unknown>, data);
    await audit(tx, ctx, { action: "reminder.updated", entity: "reminder", entityId: id, previous: diff.previous, next: diff.next });
    return reminder;
  });
}

export async function deleteReminder(ctx: AccessContext, id: string) {
  const before = await requireReminder(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.reminder.delete({ where: { id } });
    await audit(tx, ctx, { action: "reminder.deleted", entity: "reminder", entityId: id, previous: before });
  });
  return { id };
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Adds months keeping the time of day; the day clamps to the month's end (Jan 31 + 1 → Feb 28/29). */
export function addMonthsUtc(d: Date, months: number) {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const out = new Date(d);
  out.setUTCFullYear(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m)));
  return out;
}

/**
 * The first occurrence after `now`, or null for one-off reminders. Occurrences missed
 * while the job was not running are skipped, so a reminder fires once on catch-up,
 * never once per missed occurrence.
 * ponytail: monthly reminders anchored on day 29–31 settle on the clamped day after a
 * short month (Jan 31 → Feb 28 → Mar 28); add an anchor-day column if that matters.
 */
export function nextOccurrence(r: Pick<Reminder, "nextRunAt" | "recurrence" | "interval">, now: Date): Date | null {
  const interval = Math.max(1, r.interval);
  const from = r.nextRunAt;
  if (r.recurrence === "DAILY" || r.recurrence === "WEEKLY") {
    const step = interval * (r.recurrence === "DAILY" ? 1 : 7) * DAY_MS;
    const n = Math.max(1, Math.floor((now.getTime() - from.getTime()) / step) + 1);
    return new Date(from.getTime() + n * step);
  }
  if (r.recurrence === "MONTHLY") {
    let next = addMonthsUtc(from, interval);
    while (next <= now) next = addMonthsUtc(next, interval);
    return next;
  }
  return null;
}

/**
 * Job "reminders": notify each due reminder once, then advance or finish it.
 * The notification is sent with a dedupe key for the occurrence before the reminder is
 * claimed (conditional update on the unchanged nextRunAt). Overlapping runs therefore
 * notify once (the key is unique), and a crash between notifying and claiming only
 * repeats a deduplicated send on the next run instead of losing the reminder.
 */
export async function processReminders(now = new Date()) {
  const due = await prisma.reminder.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 500,
  });
  const result = { due: due.length, fired: 0, finished: 0, failed: 0 };
  for (const r of due) {
    try {
      const outcome = await fire(r, now);
      if (outcome) result.fired += 1;
      if (outcome === "finished") result.finished += 1;
    } catch (error) {
      // One bad row must not block the rest; it stays due and is retried next run.
      result.failed += 1;
      console.error(`[reminders] ${r.id}: ${sanitizeError(error)}`);
    }
  }
  return result;
}

async function fire(r: Reminder, now: Date) {
  await createSystemNotification({
    organizationId: r.organizationId,
    userId: r.userId,
    type: "reminder",
    title: r.title,
    body: r.body ?? undefined,
    data: { reminderId: r.id, entityType: r.entityType, entityId: r.entityId, occurrence: r.nextRunAt.toISOString(), href: "/automation/reminders" },
    preferenceKey: "reminders",
    dedupeKey: `reminder:${r.id}:${r.nextRunAt.toISOString()}`,
  });
  const next = nextOccurrence(r, now);
  const active = next !== null && (!r.endsAt || next <= r.endsAt);
  const claimed = await prisma.reminder.updateMany({
    where: { id: r.id, isActive: true, nextRunAt: r.nextRunAt },
    data: { isActive: active, nextRunAt: active ? next! : r.nextRunAt, lastFiredAt: now, fireCount: { increment: 1 } },
  });
  if (claimed.count === 0) return null; // another run (or an edit) got there first
  return active ? "advanced" : "finished";
}
