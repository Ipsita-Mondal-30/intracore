import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import type { AccessContext } from "@/lib/access";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { getOrCreateNotificationPreferences } from "@/lib/notifications/create";

/** The caller's own notification history and preferences (every member has these). */
const listSchema = listQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional(),
  type: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  /** inclusive; a bare YYYY-MM-DD covers that whole (UTC) day */
  to: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v) : undefined))
    .refine((d) => !d || !Number.isNaN(d.getTime()), "Invalid date"),
});

const mine = (ctx: AccessContext) => ({ organizationId: ctx.organizationId, userId: ctx.userId });

export async function listNotificationHistory(ctx: AccessContext, query: unknown) {
  const q = listSchema.parse(query);
  const where: Prisma.NotificationWhereInput = {
    AND: [
      mine(ctx),
      searchWhere(q.q, ["title", "body"]),
      {
        type: q.type || undefined,
        readAt: q.unread === undefined ? undefined : q.unread === "true" ? null : { not: null },
        createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
      },
    ],
  };
  const [page, unread] = await Promise.all([
    paginate(q, () =>
      prisma.$transaction([
        prisma.notification.findMany({ where, ...listArgs(q, ["createdAt"]) }),
        prisma.notification.count({ where }),
      ]),
    ),
    prisma.notification.count({ where: { ...mine(ctx), readAt: null } }),
  ]);
  return { ...page, unread };
}

export async function notificationTypes(ctx: AccessContext) {
  const rows = await prisma.notification.findMany({ where: mine(ctx), distinct: ["type"], select: { type: true }, take: 100 });
  return rows.map((r) => r.type).sort();
}

export async function markNotificationRead(ctx: AccessContext, id: string) {
  const notification = await prisma.notification.findFirst({ where: { id, ...mine(ctx) } });
  if (!notification) throw new AppError("NOT_FOUND", "Notification not found", 404);
  if (notification.readAt) return notification;
  return prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
}

export async function markAllNotificationsRead(ctx: AccessContext, input: unknown) {
  const { type } = z.object({ type: z.string().trim().max(80).optional() }).parse(input ?? {});
  const { count } = await prisma.notification.updateMany({
    where: { ...mine(ctx), readAt: null, type: type || undefined },
    data: { readAt: new Date() },
  });
  return { count };
}

export const PREFERENCE_KEYS = [
  "chatMessages",
  "leadAssignments",
  "followUpReminders",
  "taskNotifications",
  "systemNotifications",
  "approvalRequests",
  "reminders",
  "browserNotifications",
] as const;
export type NotificationPreferences = Record<(typeof PREFERENCE_KEYS)[number], boolean>;

const pick = (row: NotificationPreferences): NotificationPreferences =>
  Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, row[k]])) as NotificationPreferences;

const preferencesSchema = z
  .object(Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof PREFERENCE_KEYS)[number], z.ZodOptional<z.ZodBoolean>>)
  .strict();

export async function getPreferences(ctx: AccessContext) {
  return pick(await getOrCreateNotificationPreferences(ctx.organizationId, ctx.userId));
}

export async function updatePreferences(ctx: AccessContext, input: unknown) {
  const data = preferencesSchema.parse(input);
  const row = await prisma.userNotificationPreference.upsert({
    where: { organizationId_userId: mine(ctx) },
    create: { ...mine(ctx), ...data },
    update: data,
  });
  return pick(row);
}
