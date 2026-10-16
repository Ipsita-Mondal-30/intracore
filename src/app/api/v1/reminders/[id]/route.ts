import { api } from "@/lib/api/http";
import { deleteReminder, getReminder, updateReminder } from "@/features/notifications/reminders";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getReminder(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateReminder(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteReminder(ctx, params.id));
