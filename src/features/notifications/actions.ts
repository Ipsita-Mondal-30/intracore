"use server";

import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/notifications/queries";

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
