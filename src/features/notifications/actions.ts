"use server";

import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import {
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreferences,
} from "@/lib/notifications/queries";

export async function markNotificationReadAction(
  notificationId: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("dashboard.view");
    await markNotificationRead(tenant, notificationId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to mark notification read" };
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("dashboard.view");
    await markAllNotificationsRead(tenant);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to mark all read" };
  }
}

export async function updateNotificationPreferencesAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("dashboard.view");
    const bool = (key: string) => formData.get(key) === "true";

    await updateNotificationPreferences(tenant, {
      chatMessages: bool("chatMessages"),
      leadAssignments: bool("leadAssignments"),
      followUpReminders: bool("followUpReminders"),
      taskNotifications: bool("taskNotifications"),
      systemNotifications: bool("systemNotifications"),
      browserNotifications: bool("browserNotifications"),
    });

    return { ok: true, message: "Preferences saved" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to save preferences" };
  }
}
