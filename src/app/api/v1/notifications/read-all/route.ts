import { api } from "@/lib/api/http";
import { markAllNotificationsRead } from "@/features/notifications/history";

/** Body: { type? } — limits it to one notification type. */
export const POST = api((ctx, { body }) => markAllNotificationsRead(ctx, body));
