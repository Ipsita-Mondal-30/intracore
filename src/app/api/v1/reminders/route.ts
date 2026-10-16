import { api, queryObject } from "@/lib/api/http";
import { createReminder, listReminders } from "@/features/notifications/reminders";

export const GET = api((ctx, { query }) => listReminders(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createReminder(ctx, body), { status: 201, idempotent: true });
