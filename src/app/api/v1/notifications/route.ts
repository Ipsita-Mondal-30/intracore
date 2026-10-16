import { api, queryObject } from "@/lib/api/http";
import { listNotificationHistory } from "@/features/notifications/history";

/** ?unread=true|false&type=&from=&to=&q=&page=&pageSize= — the caller's own notifications. */
export const GET = api((ctx, { query }) => listNotificationHistory(ctx, queryObject(query)));
