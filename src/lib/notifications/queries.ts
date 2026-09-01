import { prisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/tenant";

export async function listNotifications(tenant: TenantContext, limit = 30) {
  return prisma.notification.findMany({
    where: {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getUnreadNotificationCount(tenant: TenantContext) {
  return prisma.notification.count({
    where: {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      readAt: null,
    },
  });
}

export async function markNotificationRead(
  tenant: TenantContext,
  notificationId: string,
) {
  return prisma.notification.updateMany({
    where: {
      id: notificationId,
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(tenant: TenantContext) {
  return prisma.notification.updateMany({
    where: {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}

export async function getNotificationPreferences(tenant: TenantContext) {
  const existing = await prisma.userNotificationPreference.findUnique({
    where: {
      organizationId_userId: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
      },
    },
  });

  if (existing) return existing;

  return {
    id: "",
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    chatMessages: true,
    leadAssignments: true,
    followUpReminders: true,
    taskNotifications: true,
    systemNotifications: true,
    browserNotifications: false,
  };
}

export async function getLayoutNotificationData(tenant: TenantContext) {
  const [notifications, unreadNotificationCount, notificationPrefs] =
    await Promise.all([
      listNotifications(tenant, 20),
      getUnreadNotificationCount(tenant),
      getNotificationPreferences(tenant),
    ]);

  return {
    notifications: notifications.map((n) => ({
      ...n,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    unreadNotificationCount,
    browserNotificationsEnabled: notificationPrefs.browserNotifications,
  };
}

export async function updateNotificationPreferences(
  tenant: TenantContext,
  data: Partial<{
    chatMessages: boolean;
    leadAssignments: boolean;
    followUpReminders: boolean;
    taskNotifications: boolean;
    systemNotifications: boolean;
    browserNotifications: boolean;
  }>,
) {
  return prisma.userNotificationPreference.upsert({
    where: {
      organizationId_userId: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
      },
    },
    create: {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      ...data,
    },
    update: data,
  });
}
