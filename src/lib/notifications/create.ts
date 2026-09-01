import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export async function getOrCreateNotificationPreferences(
  organizationId: string,
  userId: string,
) {
  return prisma.userNotificationPreference.upsert({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    create: { organizationId, userId },
    update: {},
  });
}

export async function createChatNotification(input: {
  organizationId: string;
  userId: string;
  leadId: string;
  leadName: string;
  conversationId: string;
  messageId: string;
  preview: string;
}) {
  const prefs = await getOrCreateNotificationPreferences(
    input.organizationId,
    input.userId,
  );
  if (!prefs.chatMessages) return null;

  return prisma.notification.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      type: "CHAT_MESSAGE",
      title: `New message from ${input.leadName}`,
      body: input.preview,
      data: {
        conversationId: input.conversationId,
        leadId: input.leadId,
        messageId: input.messageId,
        href: `/messages/${input.conversationId}`,
      },
    },
  });
}

export async function createSystemNotification(input: {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
  preferenceKey?: keyof Pick<
    Awaited<ReturnType<typeof getOrCreateNotificationPreferences>>,
    | "chatMessages"
    | "leadAssignments"
    | "followUpReminders"
    | "taskNotifications"
    | "systemNotifications"
  >;
}) {
  const prefs = await getOrCreateNotificationPreferences(
    input.organizationId,
    input.userId,
  );
  const key = input.preferenceKey ?? "systemNotifications";
  if (!prefs[key]) return null;

  return prisma.notification.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: (input.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}
